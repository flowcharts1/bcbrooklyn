import fs from 'fs/promises';
import path from 'path';
import { chromium } from 'playwright';

const DEFAULT_CALENDAR_URL = 'https://www.clubs.brooklyn.cuny.edu/calendar';
const AUTH_STATE_PATH = path.resolve('.auth', 'webcentral-storage-state.json');

const username = process.env.BC_WEBCENTRAL_USERNAME || '';
const password = process.env.BC_WEBCENTRAL_PASSWORD || '';
const calendarUrl = process.env.BC_CALENDAR_URL || DEFAULT_CALENDAR_URL;
const limit = Number(getArgValue('--limit')) || 40;
const sampleSize = Number(getArgValue('--sample-size')) || 3;
const headed = process.argv.includes('--headed');

function getArgValue(name) {
  const arg = process.argv.find(value => value === name || value.startsWith(name + '='));
  if (!arg) return '';
  if (arg.includes('=')) return arg.slice(arg.indexOf('=') + 1);
  const idx = process.argv.indexOf(arg);
  return process.argv[idx + 1] || '';
}

function normalize(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function absoluteUrl(rawUrl, baseUrl) {
  if (!rawUrl) return '';
  try {
    return new URL(rawUrl, baseUrl).href;
  } catch (_) {
    return rawUrl;
  }
}

async function isOnEventOrCalendarPage(page) {
  return page.evaluate(() => {
    return Boolean(
      document.querySelector('.rsvp__event-name') ||
      document.querySelector('a[href*="/rsvp"][href*="id="]')
    );
  }).catch(() => false);
}

async function visibleLocator(page, selectors) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await locator.isVisible().catch(() => false)) return locator;
  }
  return null;
}

async function loginIfNeeded(page) {
  if (await isOnEventOrCalendarPage(page)) return;

  if (!username || !password) {
    throw new Error('Set BC_WEBCENTRAL_USERNAME and BC_WEBCENTRAL_PASSWORD before running.');
  }

  for (let attempt = 1; attempt <= 4; attempt++) {
    const passwordInput = await visibleLocator(page, [
      'input[type="password"]',
      'input[name*="pass" i]',
      'input[id*="pass" i]'
    ]);
    const usernameInput = await visibleLocator(page, [
      'input[type="email"]',
      'input[name*="user" i]',
      'input[id*="user" i]',
      'input[name*="login" i]',
      'input[id*="login" i]',
      'input[name*="empl" i]',
      'input[id*="empl" i]',
      'input[type="text"]'
    ]);

    if (usernameInput) await usernameInput.fill(username);
    if (passwordInput) await passwordInput.fill(password);

    if (!usernameInput && !passwordInput) {
      if (await isOnEventOrCalendarPage(page)) return;
      await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
      continue;
    }

    const submit = await visibleLocator(page, [
      'button[type="submit"]',
      'input[type="submit"]',
      'button:has-text("Log in")',
      'button:has-text("Login")',
      'button:has-text("Sign in")',
      'button:has-text("Continue")',
      'input[value*="Log" i]',
      'input[value*="Sign" i]',
      'input[value*="Continue" i]'
    ]);

    if (submit) {
      await Promise.all([
        page.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {}),
        submit.click()
      ]);
    } else if (passwordInput) {
      await passwordInput.press('Enter');
    } else if (usernameInput) {
      await usernameInput.press('Enter');
    }

    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    if (await isOnEventOrCalendarPage(page)) return;
  }

  const title = await page.title().catch(() => '');
  throw new Error(`Login did not reach the CampusGroups page. Current page: ${title || page.url()}`);
}

async function collectEventLinks(page) {
  return page.evaluate(() => {
    const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
    const seen = new Set();
    return Array.from(document.querySelectorAll('a[href*="/rsvp"][href*="id="]'))
      .map(anchor => {
        const href = anchor.href || anchor.getAttribute('href') || '';
        const id = anchor.getAttribute('rel') || (href.match(/[?&]id=(\d+)/) || [])[1] || href;
        const eventEl = anchor.closest('.calEvent');
        const dayEl = anchor.closest('.mon-mdDiv');
        return {
          id: String(id),
          url: href,
          title: clean(anchor.textContent),
          calendarDate: dayEl ? (dayEl.id || dayEl.getAttribute('aria-label') || '') : '',
          visible: eventEl ? getComputedStyle(eventEl).display !== 'none' : true
        };
      })
      .filter(link => {
        if (!link.url || seen.has(link.id)) return false;
        seen.add(link.id);
        return true;
      });
  });
}

async function parseEventPage(page, sourceUrl) {
  return page.evaluate(url => {
    const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
    const getText = selector => clean(document.querySelector(selector)?.textContent || '');
    const title = getText('.rsvp__event-name');
    const club = clean(document.querySelector('.rsvp__event-org .btn-link')?.textContent || '');
    const dateParts = document.querySelectorAll('.card-block .col-md-4_5 p');
    const rawDate = clean(dateParts[0]?.textContent || '');
    const time = clean((dateParts[1]?.textContent || '').replace(/EDT.*$/i, '').replace(/EST.*$/i, ''));
    const locationParts = document.querySelectorAll('.card-block .col-md-5 p');
    const room = clean(locationParts[0]?.textContent || '');
    const cgId = (url.match(/[?&]id=(\d+)/) || [])[1] || '';

    return { title, club, rawDate, time, room, cgId, sourceUrl: url };
  }, sourceUrl);
}

function shuffle(items) {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

async function main() {
  const browser = await chromium.launch({ headless: !headed });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    console.log(`Opening ${calendarUrl}`);
    await page.goto(calendarUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await loginIfNeeded(page);
    await fs.mkdir(path.dirname(AUTH_STATE_PATH), { recursive: true });
    await context.storageState({ path: AUTH_STATE_PATH });
    console.log(`Saved browser session state to ${AUTH_STATE_PATH}`);

    await page.goto(calendarUrl, { waitUntil: 'networkidle', timeout: 45000 });
    const links = (await collectEventLinks(page))
      .filter(link => link.visible !== false)
      .slice(0, limit)
      .map(link => ({ ...link, url: absoluteUrl(link.url, page.url()) }));

    console.log(`Found ${links.length} event links on the calendar.`);
    if (!links.length) throw new Error('No event links found on the CampusGroups calendar.');

    const events = [];
    for (const [index, link] of links.entries()) {
      await page.goto(link.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await loginIfNeeded(page);
      const event = await parseEventPage(page, link.url);
      if (event.title && event.room) events.push(event);
      console.log(`[${index + 1}/${links.length}] ${event.title || link.title || link.id}: ${event.room || 'no location parsed'}`);
    }

    if (!events.length) {
      throw new Error('Parsed event pages, but none had locations. The login may not have unlocked protected fields.');
    }

    const sample = shuffle(events).slice(0, sampleSize);
    console.log('');
    console.log(`SUCCESS: parsed ${events.length} events with locations.`);
    console.log(`Random ${sample.length} event location sample:`);
    for (const event of sample) {
      console.log(`- ${event.title}: ${event.room}`);
    }
  } finally {
    await browser.close();
  }
}

main().catch(err => {
  console.error(err.message);
  process.exitCode = 1;
});
