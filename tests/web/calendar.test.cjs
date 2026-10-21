const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('../../vendor/folia/node_modules/playwright');
const { normalizeEventInput } = require('tsx/cjs/api').require('../../src/calendar/validation.ts', __filename);

// Real DOM and styling, isolated from the user's browser, Google account and running Harbour.
const root = path.resolve(__dirname, '../..');
const source = fs.readFileSync(path.join(root, 'web/calendar.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'web/calendar.css'), 'utf8');
const themes = fs.readFileSync(path.join(root, 'web/themes.css'), 'utf8').replace(/@import[^;]+;/g, '');
const hostSource = fs.readFileSync(path.join(root, 'web/app.js'), 'utf8');
const selectSource = hostSource.slice(hostSource.indexOf('const harbourSelectStates ='), hostSource.indexOf('function authToken()'));
const hostCss = fs.readFileSync(path.join(root, 'web/styles.css'), 'utf8');
const chrome = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || (process.platform === 'win32' ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' : undefined);
let browser;
before(async () => { browser = await chromium.launch({ headless: true, executablePath: chrome }); });
after(async () => { await browser?.close(); });
const event = { id: 'event1', calendarId: 'primary', summary: 'Portfolio review', start: { dateTime: '2026-09-17T15:00:00Z' }, end: { dateTime: '2026-09-17T16:00:00Z' }, etag: '"v1"', htmlLink: 'https://calendar.google.com/calendar/event?eid=fixture' };

async function fixture(t, data = {}, viewport = { width: 1400, height: 1100 }) {
  const context = await browser.newContext({ viewport });
  await context.route('**/*', route => route.abort());
  t.after(() => context.close());
  const page = await context.newPage();
  await page.setContent('<html><body data-theme-cat="premium" data-theme="premium-champagne" style="margin:0;background:var(--bg)"><main id="root"></main></body></html>');
  if (data.hostSelects) await page.addStyleTag({ content: `${hostCss}\nhtml,body{overflow:auto;height:auto}` });
  await page.addStyleTag({ content: `${themes}\n${css}` });
  await page.evaluate(data => {
    window.calls = []; window.opened = []; window.intervals = []; window.cleared = []; window.editorEntries = new Map();
    window.HarbourUnsavedChanges = { register(id, entry) { window.editorEntries.set(id, entry); return () => window.editorEntries.delete(id); } };
    window.fixture = { status: { configured: true, connected: true, redirectUri: 'http://localhost:7788/api/calendar/oauth/callback', missing: [] }, calendars: [{ id: 'primary', summary: 'Personal', timeZone: 'America/New_York', accessRole: 'owner', primary: true }], events: [], ...data };
    const realSet = window.setInterval.bind(window), realClear = window.clearInterval.bind(window);
    window.setInterval = (fn, delay) => { const id = realSet(fn, delay); window.intervals.push({ id, delay }); window.pollCalendar = fn; return id; };
    window.clearInterval = id => { window.cleared.push(id); realClear(id); };
    window.open = (...args) => { window.opened.push(args); return null; };
    window.api = async (url, options = {}) => {
      const method = options.method || 'GET', body = options.body ? JSON.parse(options.body) : null;
      window.calls.push({ url, method, body });
      if (url === '/api/calendar/status') {
        if (window.fixture.holdStatus) return new Promise(resolve => { window.finishStatus = () => resolve(window.fixture.status); });
        return window.fixture.status;
      }
      if (url === '/api/calendar/calendars') return { calendars: window.fixture.calendars };
      if (url.startsWith('/api/calendar/events?')) return { events: window.fixture.events, truncated: Boolean(window.fixture.truncated) };
      if (url.startsWith('/api/calendar/slots?')) return { slots: window.fixture.slots || [], timeZone: 'America/New_York' };
      if (url === '/api/calendar/connect') return { url: window.fixture.authUrl || 'https://accounts.google.com/o/oauth2/v2/auth?fixture=1' };
      if (url === '/api/calendar/disconnect') { window.fixture.status.connected = false; return { disconnected: true }; }
      if (method !== 'GET') {
        if (window.fixture.holdWrite) return new Promise(resolve => { window.finishWrite = () => resolve({ event: { id: 'saved', ...body?.event } }); });
        const failure = window.fixture.writeErrors?.shift();
        if (failure) throw Object.assign(new Error(failure.message), { status: failure.status, code: failure.code, data: { writeOutcome: failure.writeOutcome } });
        return { event: { id: 'saved', ...body?.event } };
      }
      return {};
    };
  }, data);
  if (data.hostSelects) { await page.addScriptTag({ content: selectSource }); await page.evaluate(() => window.initHarbourSelects()); }
  await page.addScriptTag({ content: source });
  await page.evaluate(() => { window.cleanup = window.HarbourCalendar.mount(document.getElementById('root'), { api: window.api, initialDate: window.fixture.initialDate || '2026-09-17', initialCalendarId: window.fixture.initialCalendarId, initialEventId: window.fixture.initialEventId, timeZone: 'America/New_York' }); });
  if (!data.holdStatus) await page.waitForFunction(() => document.querySelector('.cal-grid,.cal-connect-card h2'));
  return page;
}
const writes = page => page.evaluate(() => window.calls.filter(call => call.method !== 'GET'));
async function newEvent(page) { await page.locator('[data-cal-new]').click(); await page.locator('input[name=summary]').fill('New event'); }
async function repeatDays(page, days) {
  await page.locator('input[name=repeat][value=weekly]').check();
  for (const checkbox of await page.locator('input[name=repeatDays]').all()) await checkbox.uncheck();
  for (const day of days) await page.locator(`input[name=repeatDays][value=${day}]`).check();
}
async function repeatSpan(page, days) {
  const details = page.locator('details[data-repeat-span]');
  if (!await details.evaluate(element => element.open)) await details.locator(':scope > summary').click();
  await page.locator('input[name=repeatSpan]').fill(String(days));
}

test('unconfigured setup shows safe environment guidance without credentials inputs', async t => {
  const page = await fixture(t, { status: { configured: false, connected: false, missing: ['CLIENT_<script>'], redirectUri: '<img src=x onerror=alert(1)>' } });
  assert.match(await page.locator('.cal-setup').innerText(), /GOOGLE_CALENDAR_CLIENT_SECRET/);
  assert.match(await page.locator('.cal-setup').innerText(), /<img src=x/);
  assert.equal(await page.locator('img,script:not(:empty)').count(), 1); // Only the installed module script.
  assert.equal(await page.locator('input').count(), 0);
  assert.equal((await writes(page)).length, 0);
});

test('disconnected connection opens only a verified external Google URL and exposes fallback link', async t => {
  const page = await fixture(t, { status: { configured: true, connected: false } });
  await page.locator('[data-cal-connect]').click();
  await page.waitForSelector('[data-cal-auth-link] a');
  assert.deepEqual(await page.evaluate(() => window.opened[0]), ['https://accounts.google.com/o/oauth2/v2/auth?fixture=1', '_blank', 'noopener,noreferrer']);
  assert.equal(await page.locator('[data-cal-auth-link] a').getAttribute('rel'), 'noopener noreferrer');
  await page.evaluate(() => { window.fixture.authUrl = 'javascript:alert(1)'; });
  await page.locator('[data-cal-connect]').click();
  assert.match(await page.locator('[data-cal-message]').innerText(), /授权地址无效/);
  assert.equal(await page.evaluate(() => window.opened.length), 1);
});

test('month grid and agenda use calendar timezone and escape event text', async t => {
  const page = await fixture(t, { events: [{ ...event, summary: '<img src=x onerror=alert(1)>', location: '<script>bad</script>' }] });
  assert.equal(await page.locator('.cal-day').count(), 42);
  assert.match(await page.locator('.cal-agenda').innerText(), /11:00 – 12:00/);
  assert.equal(await page.locator('.cal-agenda img,.cal-agenda script').count(), 0);
  const readCall = await page.evaluate(() => window.calls.find(call => call.url.startsWith('/api/calendar/events?')));
  const url = new URL(readCall.url, 'http://fixture');
  assert.equal(url.searchParams.get('timeMin'), '2026-08-31T00:00:00-04:00');
  assert.equal(url.searchParams.get('timeMax'), '2026-10-12T00:00:00-04:00');
  assert.equal((await writes(page)).length, 0);
});

test('compact cards bound results, escape text and use safe internal deep links', async t => {
  const page = await fixture(t);
  await page.evaluate(event => { document.getElementById('root').insertAdjacentHTML('beforeend', window.HarbourCalendar.cardsHtml([{ action: 'created', timeZone: 'America/New_York', events: Array.from({ length: 7 }, () => ({ ...event, summary: '<script>alert(1)</script>', id: '" onclick="bad', htmlLink: 'javascript:bad()' })) }])); }, event);
  assert.equal(await page.locator('.cal-response-item').count(), 4);
  assert.equal(await page.locator('.cal-response script').count(), 0);
  assert.match(await page.locator('.cal-response-open').innerText(), /另有 3 项/);
  const href = await page.locator('.cal-response-item').first().getAttribute('href');
  assert.match(href, /^#calendar\?/); assert.match(href, /calendar=primary/);
  assert.equal(new URLSearchParams(href.split('?')[1]).get('event'), '" onclick="bad');
  assert.equal(await page.locator('.cal-response [onclick]').count(), 0);
});

test('cards follow event timezone or Harbour display timezone when no card timezone is given', async t => {
  const page = await fixture(t);
  await page.evaluate(event => {
    window.HarbourTime = { getTimeZone: () => 'Asia/Shanghai' };
    document.getElementById('root').innerHTML = window.HarbourCalendar.cardsHtml([{ action: 'listed', events: [{ ...event, start: { ...event.start, timeZone: 'Europe/Paris' } }] }, { action: 'listed', events: [event] }]);
  }, event);
  const cards = page.locator('.cal-response');
  assert.match(await cards.nth(0).innerText(), /Europe\/Paris/);
  assert.match(await cards.nth(0).innerText(), /17:00 – 18:00/);
  assert.match(await cards.nth(1).innerText(), /Asia\/Shanghai/);
  assert.match(await cards.nth(1).innerText(), /23:00 – 2026-09-18 00:00/);
});

test('periodic refresh preserves focused search text, expanded slots and unfinished slot inputs', async t => {
  const page = await fixture(t);
  await page.locator('.cal-slots summary').click();
  const values = { from: '2026-09-19', to: '2026-09-21', duration: '45', workStart: '10', workEnd: '16' };
  for (const [name, value] of Object.entries(values)) await page.locator(`[data-cal-slots-form] [name=${name}]`).fill(value);
  await page.locator('[name=weekends]').uncheck();
  await page.locator('[name=q]').fill('unsubmitted search');
  await page.evaluate(() => window.pollCalendar());
  await page.waitForFunction(() => window.calls.filter(call => call.url.startsWith('/api/calendar/events?')).length === 2);
  assert.equal(await page.locator('[name=q]').inputValue(), 'unsubmitted search');
  assert.equal(await page.locator('[name=q]').evaluate(element => element === document.activeElement), true);
  for (const [name, value] of Object.entries(values)) assert.equal(await page.locator(`[data-cal-slots-form] [name=${name}]`).inputValue(), value);
  assert.equal(await page.locator('[name=weekends]').isChecked(), false);
  assert.equal(await page.locator('.cal-slots').evaluate(element => element.open), true);
});

test('free-time finder starts collapsed and retains native keyboard disclosure and form semantics', async t => {
  const page = await fixture(t, { hostSelects: true });
  const disclosure = page.locator('details.cal-slots'), summary = disclosure.locator(':scope > summary');
  assert.equal(await disclosure.evaluate(element => element.open), false);
  assert.equal(await page.locator('[data-cal-slots-form]').isVisible(), false);
  assert.equal(await summary.locator('.cal-slots-heading').count(), 1);
  assert.equal(await summary.locator('.cal-slots-icon').count(), 1);
  assert.equal(await summary.locator('button,input,a').count(), 0, 'the summary is the single native disclosure target');
  await summary.focus();
  await summary.press('Enter');
  assert.equal(await disclosure.evaluate(element => element.open), true);
  assert.equal(await page.locator('[data-cal-slots-form]').isVisible(), true);
  assert.equal(await page.locator('[data-cal-slots-form] button').count(), 1);
  assert.equal(await page.locator('.cal-slots-actions button[type=submit]').count(), 1);
  assert.deepEqual(await page.locator('[data-cal-slots-form] input').evaluateAll(inputs => inputs.map(input => input.name)), ['from', 'to', 'duration', 'workStart', 'workEnd', 'weekends']);
  await page.keyboard.press('Tab');
  assert.equal(await page.locator('[name=from]').evaluate(element => element === document.activeElement), true);
  await summary.focus();
  await summary.press('Space');
  assert.equal(await disclosure.evaluate(element => element.open), false);
  assert.equal(await page.evaluate(() => window.calls.filter(call => call.url.startsWith('/api/calendar/slots?')).length), 0);
  assert.equal((await writes(page)).length, 0);
});

test('missing event deep links show an explicit notice instead of silently opening a blank calendar', async t => {
  const page = await fixture(t, { initialEventId: 'missing' });
  assert.match(await page.locator('[data-cal-message]').innerText(), /可能已移动、删除/);
});

test('create submits timezone-aware instants once and follows reminder selection', async t => {
  const page = await fixture(t);
  await newEvent(page);
  assert.equal(await page.locator('select[name=reminder]').inputValue(), '15');
  await page.locator('select[name=reminder]').selectOption('30');
  await page.locator('[data-save]').click();
  await page.waitForFunction(() => !document.querySelector('dialog'));
  const [write] = await writes(page);
  assert.equal(write.method, 'POST'); assert.equal(write.url, '/api/calendar/events');
  assert.match(write.body.requestId, /^[\w-]{36}$/);
  assert.deepEqual(write.body.event.start, { dateTime: '2026-09-17T09:00:00-04:00', timeZone: 'America/New_York' });
  assert.equal(Object.hasOwn(write.body.event, 'recurrence'), false, 'one-off creation does not send a recurrence field');
  assert.doesNotThrow(() => normalizeEventInput(write.body.event, { creating: true }));
  assert.deepEqual(write.body.event.reminders, { useDefault: false, overrides: [{ method: 'popup', minutes: 30 }] });
});

test('all-day end is exclusive and not converted through the computer timezone', async t => {
  const page = await fixture(t);
  await newEvent(page); await page.locator('input[name=allDay]').check();
  await page.locator('input[name=endDate]').fill('2026-09-19');
  await page.locator('[data-save]').click();
  const [write] = await writes(page);
  assert.deepEqual(write.body.event.start, { date: '2026-09-17' });
  assert.deepEqual(write.body.event.end, { date: '2026-09-20' });
  assert.doesNotThrow(() => normalizeEventInput(write.body.event, { creating: true }));
});

test('schedule type comes first and supports native radio keyboard navigation', async t => {
  const page = await fixture(t, { hostSelects: true });
  await newEvent(page);
  const single = page.locator('input[name=repeat][value=none]');
  const weekly = page.locator('input[name=repeat][value=weekly]');
  assert.equal(await single.isChecked(), true);
  assert.equal(await page.locator('select[name=repeat]').count(), 0, 'schedule type is not hidden in a second date-dependent dropdown');
  assert.equal(await page.locator('input[name=startDate]').isVisible(), true);
  assert.equal(await page.locator('input[name=repeatFrom]').isVisible(), false);
  assert.equal(await single.evaluate(input => Boolean(input.compareDocumentPosition(document.querySelector('[name=startDate]')) & Node.DOCUMENT_POSITION_FOLLOWING)), true);
  await single.focus();
  await single.press('ArrowRight');
  assert.equal(await weekly.isChecked(), true);
  assert.equal(await page.locator('input[name=startDate]').isVisible(), false);
  assert.equal(await page.locator('input[name=endDate]').isVisible(), false);
  assert.equal(await page.locator('input[name=repeatFrom]').isVisible(), true);
  for (const name of ['startDate', 'endDate']) assert.equal(await page.locator(`[name=${name}]`).isDisabled(), true, `${name} cannot constrain the weekly draft`);
  assert.equal(await page.locator('[name=repeatDays]').first().evaluate(input => Boolean(input.compareDocumentPosition(document.querySelector('[name=repeatFrom]')) & Node.DOCUMENT_POSITION_FOLLOWING)), true, 'weekly weekdays precede the effective-from date');
  assert.equal(await page.locator('[name=startTime]').evaluate(input => Boolean(input.compareDocumentPosition(document.querySelector('[name=repeatFrom]')) & Node.DOCUMENT_POSITION_FOLLOWING)), true, 'the weekly clock time precedes the series bounds');
  await weekly.press('ArrowLeft');
  assert.equal(await single.isChecked(), true);
  assert.equal(await page.locator('input[name=startDate]').isVisible(), true);
  assert.equal(await page.locator('input[name=repeatFrom]').isDisabled(), true);
  assert.equal((await writes(page)).length, 0);
});

test('switching schedule types restores independent date drafts and shared clock times', async t => {
  const page = await fixture(t);
  await newEvent(page);
  await page.locator('input[name=startDate]').fill('2026-09-25');
  await page.locator('input[name=endDate]').fill('2026-09-27');
  await repeatDays(page, ['MO', 'WE']);
  await page.locator('input[name=repeatFrom]').fill('2026-10-02');
  await page.locator('input[name=startTime]').fill('18:30');
  await page.locator('input[name=endTime]').fill('19:30');
  await repeatSpan(page, 1);
  await page.locator('input[name=repeatCount]').fill('6');
  await page.locator('input[name=repeat][value=none]').check();
  assert.equal(await page.locator('input[name=startDate]').inputValue(), '2026-09-25');
  assert.equal(await page.locator('input[name=endDate]').inputValue(), '2026-09-27');
  assert.equal(await page.locator('input[name=startTime]').inputValue(), '18:30');
  await page.locator('input[name=repeat][value=weekly]').check();
  assert.equal(await page.locator('input[name=repeatFrom]').inputValue(), '2026-10-02');
  assert.equal(await page.locator('input[name=repeatSpan]').inputValue(), '1');
  assert.equal(await page.locator('input[name=repeatCount]').inputValue(), '6');
  assert.deepEqual(await page.locator('input[name=repeatDays]:checked').evaluateAll(inputs => inputs.map(input => input.value)), ['MO', 'WE']);
  assert.match(await page.locator('[data-repeat-summary]').innerText(), /2026-10-05/);
  assert.equal((await writes(page)).length, 0);
});

test('weekly scheduling ignores an unfinished single-date draft and still validates a real Google event', async t => {
  const page = await fixture(t);
  await newEvent(page);
  await page.locator('input[name=startDate]').fill('');
  await page.locator('input[name=endDate]').fill('');
  await repeatDays(page, ['MO']);
  await page.locator('input[name=repeatFrom]').fill('2026-09-18');
  await page.locator('[data-save]').click();
  await page.waitForFunction(() => !document.querySelector('dialog'));
  const calls = await writes(page);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].body.event.start, { dateTime: '2026-09-21T09:00:00-04:00', timeZone: 'America/New_York' });
  assert.deepEqual(calls[0].body.event.end, { dateTime: '2026-09-21T10:00:00-04:00', timeZone: 'America/New_York' });
  assert.deepEqual(calls[0].body.event.recurrence, ['RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=12']);
  assert.doesNotThrow(() => normalizeEventInput(calls[0].body.event));
});

test('new weekly events default to the start weekday and submit one bounded multi-day rule', async t => {
  const page = await fixture(t);
  await newEvent(page);
  assert.equal(await page.locator('input[name=repeat]:checked').inputValue(), 'none');
  await page.locator('input[name=repeat][value=weekly]').check();
  assert.deepEqual(await page.locator('input[name=repeatDays]:checked').evaluateAll(inputs => inputs.map(input => input.value)), ['TH']);
  assert.deepEqual(await page.locator('input[name=repeatDays]').evaluateAll(inputs => inputs.map(input => input.value)), ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU']);
  assert.equal(await page.locator('select[name=repeatEnd]').inputValue(), 'count');
  assert.equal(await page.locator('input[name=repeatCount]').inputValue(), '12');
  assert.equal(await page.locator('input[name=repeatCount]').getAttribute('min'), '1');
  assert.equal(await page.locator('input[name=repeatCount]').getAttribute('max'), '1000');
  await repeatDays(page, ['WE', 'MO']);
  await page.locator('select[name=reminder]').selectOption('30');
  assert.match(await page.locator('[data-repeat-summary]').innerText(), /2026-09-21/);
  assert.equal((await writes(page)).length, 0, 'choosing recurrence only prepares a draft');
  await page.locator('[data-save]').click();
  await page.waitForFunction(() => !document.querySelector('dialog'));
  const calls = await writes(page);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, 'POST');
  const input = calls[0].body.event;
  assert.deepEqual(input.recurrence, ['RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=12']);
  assert.deepEqual(input.start, { dateTime: '2026-09-21T09:00:00-04:00', timeZone: 'America/New_York' });
  assert.deepEqual(input.end, { dateTime: '2026-09-21T10:00:00-04:00', timeZone: 'America/New_York' });
  assert.deepEqual(input.reminders, { useDefault: false, overrides: [{ method: 'popup', minutes: 30 }] });
  assert.deepEqual(normalizeEventInput(input).recurrence, input.recurrence);
});

test('weekly first-day alignment preserves the explicit per-occurrence day span', async t => {
  const page = await fixture(t);
  await newEvent(page);
  await repeatDays(page, ['MO']);
  await repeatSpan(page, 2);
  await page.locator('input[name=repeatCount]').fill('3');
  assert.match(await page.locator('[data-repeat-summary]').innerText(), /2026-09-21/);
  await page.locator('[data-save]').click();
  const [write] = await writes(page);
  assert.deepEqual(write.body.event.start, { dateTime: '2026-09-21T09:00:00-04:00', timeZone: 'America/New_York' });
  assert.deepEqual(write.body.event.end, { dateTime: '2026-09-23T10:00:00-04:00', timeZone: 'America/New_York' });
  assert.deepEqual(write.body.event.recurrence, ['RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=3']);
  assert.doesNotThrow(() => normalizeEventInput(write.body.event));
});

test('overnight weekly events require an explicit next-day ending and preview the end time', async t => {
  const page = await fixture(t);
  await newEvent(page);
  await repeatDays(page, ['MO']);
  await page.locator('input[name=startTime]').fill('23:00');
  await page.locator('input[name=endTime]').fill('01:00');
  await page.locator('[data-save]').click();
  assert.equal((await writes(page)).length, 0, 'an earlier clock time must not silently become an overnight event');
  assert.match(await page.locator('.cal-form-error').innerText(), /结束|时间|跨天/);
  await repeatSpan(page, 1);
  assert.match(await page.locator('[data-repeat-summary]').innerText(), /23:00/);
  assert.match(await page.locator('[data-repeat-summary]').innerText(), /01:00/);
  await page.locator('[data-save]').click();
  const [write] = await writes(page);
  assert.deepEqual(write.body.event.start, { dateTime: '2026-09-21T23:00:00-04:00', timeZone: 'America/New_York' });
  assert.deepEqual(write.body.event.end, { dateTime: '2026-09-22T01:00:00-04:00', timeZone: 'America/New_York' });
  assert.doesNotThrow(() => normalizeEventInput(write.body.event));
});

test('weekly effective dates and per-occurrence spans reject invalid values without writes', async t => {
  const page = await fixture(t);
  await newEvent(page);
  await repeatDays(page, ['MO']);
  await page.locator('input[name=repeatFrom]').fill('');
  await page.locator('[data-save]').click();
  assert.equal((await writes(page)).length, 0);
  await page.locator('input[name=repeatFrom]').fill('2026-09-17');
  for (const span of ['-1', '367', '1.5']) {
    await repeatSpan(page, span);
    await page.locator('[data-save]').click();
    assert.equal((await writes(page)).length, 0, `invalid weekly span ${span} cannot submit`);
  }
});

test('changing the weekly effective-from date does not silently change selected weekdays', async t => {
  const page = await fixture(t);
  await newEvent(page);
  await page.locator('input[name=repeat][value=weekly]').check();
  await page.locator('input[name=repeatFrom]').fill('2026-09-18');
  assert.deepEqual(await page.locator('input[name=repeatDays]:checked').evaluateAll(inputs => inputs.map(input => input.value)), ['TH']);
  assert.match(await page.locator('[data-repeat-summary]').innerText(), /2026-09-24/);
  await repeatDays(page, ['MO', 'WE']);
  await page.locator('input[name=repeatFrom]').fill('2026-09-19');
  assert.deepEqual(await page.locator('input[name=repeatDays]:checked').evaluateAll(inputs => inputs.map(input => input.value)), ['MO', 'WE']);
  assert.match(await page.locator('[data-repeat-summary]').innerText(), /2026-09-21/);
  assert.equal((await writes(page)).length, 0);
});

test('all-day weekly recurrence uses a date UNTIL and exclusive shifted end date', async t => {
  const page = await fixture(t);
  await newEvent(page);
  await page.locator('input[name=allDay]').check();
  await repeatDays(page, ['MO', 'WE']);
  await repeatSpan(page, 2);
  await page.locator('select[name=repeatEnd]').selectOption('until');
  await page.locator('input[name=repeatUntil]').fill('2026-10-02');
  await page.locator('[data-save]').click();
  const [write] = await writes(page);
  assert.deepEqual(write.body.event.start, { date: '2026-09-21' });
  assert.deepEqual(write.body.event.end, { date: '2026-09-24' });
  assert.deepEqual(write.body.event.recurrence, ['RRULE:FREQ=WEEKLY;BYDAY=MO,WE;UNTIL=20261002']);
  assert.doesNotThrow(() => normalizeEventInput(write.body.event));
});

test('timed weekly UNTIL includes the whole chosen calendar-local day across DST', async t => {
  const page = await fixture(t, { initialDate: '2026-10-30' });
  await newEvent(page);
  await repeatDays(page, ['SU']);
  await page.locator('select[name=repeatEnd]').selectOption('until');
  await page.locator('input[name=repeatUntil]').fill('2026-11-01');
  assert.match(await page.locator('[data-repeat-summary]').innerText(), /2026-11-01/);
  await page.locator('[data-save]').click();
  const [write] = await writes(page);
  assert.deepEqual(write.body.event.start, { dateTime: '2026-11-01T09:00:00-05:00', timeZone: 'America/New_York' });
  assert.deepEqual(write.body.event.end, { dateTime: '2026-11-01T10:00:00-05:00', timeZone: 'America/New_York' });
  assert.deepEqual(write.body.event.recurrence, ['RRULE:FREQ=WEEKLY;BYDAY=SU;UNTIL=20261102T045959Z']);
  assert.doesNotThrow(() => normalizeEventInput(write.body.event));
});

test('weekly first-day alignment rechecks missing and ambiguous DST wall times before writing', async t => {
  const page = await fixture(t);
  await newEvent(page);
  await repeatDays(page, ['SU']);
  for (const [date, time, message] of [['2026-03-06', '02:30', /不存在/], ['2026-10-30', '01:30', /出现两次/]]) {
    await page.locator('input[name=repeatFrom]').fill(date);
    await page.locator('input[name=startTime]').fill(time);
    await page.locator('input[name=endTime]').fill('04:00');
    await page.locator('[data-save]').click();
    assert.match(await page.locator('.cal-form-error').innerText(), message);
  }
  assert.equal((await writes(page)).length, 0);
});

test('weekly drafts reject empty weekdays, invalid counts and cutoff dates before the first occurrence', async t => {
  const page = await fixture(t);
  await newEvent(page);
  await repeatDays(page, []);
  await page.locator('[data-save]').click();
  assert.match(await page.locator('.cal-form-error').innerText(), /星期|重复|至少/);
  assert.equal((await writes(page)).length, 0);
  await repeatDays(page, ['MO']);
  for (const count of ['0', '1001', '1.5']) {
    await page.locator('input[name=repeatCount]').fill(count);
    await page.locator('[data-save]').click();
    assert.equal((await writes(page)).length, 0, `invalid repetition count ${count} cannot submit`);
  }
  await page.locator('input[name=repeatCount]').fill('12');
  await page.locator('select[name=repeatEnd]').selectOption('until');
  for (const cutoff of ['2026-09-16', '2026-09-20']) {
    await page.locator('input[name=repeatUntil]').fill(cutoff);
    await page.locator('[data-save]').click();
    assert.equal((await writes(page)).length, 0, `${cutoff} precedes the actual first Monday`);
  }
});

test('switching a weekly draft back to none removes recurrence and ignores hidden invalid repeat fields', async t => {
  const page = await fixture(t);
  await newEvent(page);
  await repeatDays(page, []);
  await page.locator('input[name=repeatCount]').fill('0');
  await page.locator('select[name=repeatEnd]').selectOption('until');
  await page.locator('input[name=repeatUntil]').fill('2026-09-01');
  await page.locator('input[name=repeat][value=none]').check();
  await page.locator('[data-save]').click();
  await page.waitForFunction(() => !document.querySelector('dialog'));
  const calls = await writes(page);
  assert.equal(calls.length, 1);
  assert.equal(Object.hasOwn(calls[0].body.event, 'recurrence'), false);
  assert.deepEqual(calls[0].body.event.start, { dateTime: '2026-09-17T09:00:00-04:00', timeZone: 'America/New_York' });
  assert.doesNotThrow(() => normalizeEventInput(calls[0].body.event));
});

test('unknown weekly creation locks every recurrence field and reconciles identical key and payload', async t => {
  const page = await fixture(t, { writeErrors: [{ message: 'Result unknown', status: 502, writeOutcome: 'unknown' }] });
  await newEvent(page);
  await repeatDays(page, ['MO', 'WE']);
  await page.locator('[data-save]').click();
  for (const name of ['repeat', 'repeatFrom', 'repeatSpan', 'repeatEnd', 'repeatCount', 'repeatUntil']) {
    assert.equal(await page.locator(`[name=${name}]`).evaluateAll(inputs => inputs.every(input => input.matches(':disabled'))), true, `${name} must be frozen after uncertain submission`);
  }
  assert.equal(await page.locator('input[name=repeatDays]').evaluateAll(inputs => inputs.every(input => input.matches(':disabled'))), true);
  assert.equal((await writes(page)).length, 1);
  await page.locator('[data-save]').click();
  const calls = await writes(page);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].body, calls[1].body);
  assert.deepEqual(calls[0].body.event.recurrence, ['RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=12']);
});

test('nonexistent and ambiguous DST wall times reject before writing', async t => {
  const page = await fixture(t);
  await newEvent(page);
  for (const [date, time, message] of [['2026-03-08', '02:30', /不存在/], ['2026-11-01', '01:30', /出现两次/]]) {
    await page.locator('input[name=startDate]').fill(date); await page.locator('input[name=endDate]').fill(date);
    await page.locator('input[name=startTime]').fill(time); await page.locator('input[name=endTime]').fill('04:00');
    await page.locator('[data-save]').click();
    assert.match(await page.locator('.cal-form-error').innerText(), message);
  }
  assert.equal((await writes(page)).length, 0);
});

test('unknown create freezes content and checks identical request rather than creating a new ID', async t => {
  const page = await fixture(t, { writeErrors: [{ message: 'Result unknown', status: 502, writeOutcome: 'unknown' }] });
  await newEvent(page); await page.locator('[data-save]').click();
  assert.equal(await page.locator('input[name=summary]').isDisabled(), true);
  assert.equal((await writes(page)).length, 1);
  assert.match(await page.locator('[data-save]').innerText(), /核对原请求/);
  await page.locator('[data-save]').click();
  const calls = await writes(page);
  assert.equal(calls.length, 2); assert.deepEqual(calls[0].body, calls[1].body);
});

test('ETag conflicts reload the latest event and never retry a mutation', async t => {
  const page = await fixture(t, { events: [event], writeErrors: [{ message: 'changed', status: 409, code: 'ETAG_MISMATCH', writeOutcome: 'rejected' }] });
  await page.locator('.cal-agenda-event').click();
  assert.equal(await page.locator('[name=repeat]').count(), 0, 'existing events cannot be converted into a series');
  await page.locator('input[name=summary]').fill('Changed title');
  await page.locator('[data-save]').click();
  await page.waitForFunction(() => !document.querySelector('dialog'));
  assert.match(await page.locator('[data-cal-message]').innerText(), /其它设备修改/);
  const calls = await writes(page);
  assert.equal(calls.length, 1); assert.equal(calls[0].body.etag, '"v1"');
  assert.equal(calls[0].method, 'PATCH');
  assert.equal(Object.hasOwn(calls[0].body.event, 'recurrence'), false, 'single-event updates must omit even an empty recurrence field');
  assert.equal(await page.evaluate(() => window.calls.filter(call => call.url.startsWith('/api/calendar/events?')).length), 2);
});

test('repeat events are read-only and untrusted external links are omitted', async t => {
  const page = await fixture(t, { events: [{ ...event, recurrence: ['RRULE:FREQ=DAILY'], htmlLink: 'https://calendar.google.com.evil.example/calendar/' }] });
  await page.locator('.cal-agenda-event').click();
  assert.equal(await page.locator('input[name=summary]').isDisabled(), true);
  assert.equal(await page.locator('[data-save],[data-delete],dialog a').count(), 0);
  assert.match(await page.locator('.cal-form-notice').first().innerText(), /修改此实例或整个系列/);
});

test('expanded recurring instances stay read-only and offer a trusted Google edit link', async t => {
  const page = await fixture(t, { events: [{ ...event, recurringEventId: 'weekly-series' }] });
  await page.locator('.cal-agenda-event').click();
  assert.equal(await page.locator('input[name=summary]').isDisabled(), true);
  assert.equal(await page.locator('[data-save],[data-delete],[name=repeat]').count(), 0);
  const link = page.locator('dialog a');
  assert.equal(await link.getAttribute('href'), event.htmlLink);
  assert.equal(await link.getAttribute('rel'), 'noopener noreferrer');
  assert.equal((await writes(page)).length, 0);
});

test('delete requires explicit confirmation and uncertain deletion cannot become a PATCH retry', async t => {
  const page = await fixture(t, { events: [event], writeErrors: [{ message: 'delete outcome unknown', status: 502, writeOutcome: 'unknown' }] });
  await page.locator('.cal-agenda-event').click();
  await page.locator('[data-delete]').click(); assert.equal((await writes(page)).length, 0);
  await page.locator('[data-confirm-delete]').click();
  const calls = await writes(page);
  assert.equal(calls.length, 1); assert.equal(calls[0].method, 'DELETE');
  assert.deepEqual(calls[0].body, { calendarId: 'primary', etag: '"v1"' });
  assert.equal(await page.locator('[data-save]').isDisabled(), true);
  assert.equal(await page.locator('[data-confirm-delete]').isDisabled(), true);
});

test('disconnect confirmation removes only the connection, not remote events', async t => {
  const page = await fixture(t);
  await page.locator('[data-cal-disconnect]').click(); assert.equal((await writes(page)).length, 0);
  await page.locator('[data-confirm-disconnect]').click();
  await page.waitForSelector('[data-cal-connect]');
  assert.deepEqual((await writes(page)).map(call => [call.url, call.method]), [['/api/calendar/disconnect', 'POST']]);
  assert.match(await page.locator('[data-cal-message]').innerText(), /日程保持不变/);
});

test('slots search preserves default and edited query values without writing calendar events', async t => {
  const page = await fixture(t);
  await page.locator('.cal-slots summary').click(); await page.locator('[data-cal-slots-form] button').click();
  await page.waitForSelector('[data-cal-slots-results] .cal-muted');
  const call = await page.evaluate(() => window.calls.find(call => call.url.startsWith('/api/calendar/slots?')));
  assert.equal(call.method, 'GET');
  assert.deepEqual(Object.fromEntries(new URL(call.url, 'http://fixture').searchParams), {
    calendarIds: '["primary"]', timeMin: '2026-09-17T00:00:00-04:00', timeMax: '2026-09-24T00:00:00-04:00',
    durationMinutes: '60', timeZone: 'America/New_York', workStartHour: '9', workEndHour: '18', excludeWeekends: 'true',
  });
  const values = { from: '2026-09-19', to: '2026-09-21', duration: '45', workStart: '10', workEnd: '16' };
  for (const [name, value] of Object.entries(values)) await page.locator(`[data-cal-slots-form] [name=${name}]`).fill(value);
  await page.locator('[name=weekends]').uncheck();
  await page.locator('[data-cal-slots-form] button').click();
  const editedCalls = await page.evaluate(() => window.calls.filter(call => call.url.startsWith('/api/calendar/slots?')));
  assert.equal(editedCalls.length, 2);
  assert.deepEqual(Object.fromEntries(new URL(editedCalls[1].url, 'http://fixture').searchParams), {
    calendarIds: '["primary"]', timeMin: '2026-09-19T00:00:00-04:00', timeMax: '2026-09-22T00:00:00-04:00',
    durationMinutes: '45', timeZone: 'America/New_York', workStartHour: '10', workEndHour: '16', excludeWeekends: 'false',
  });
  for (const [name, value] of Object.entries(values)) assert.equal(await page.locator(`[data-cal-slots-form] [name=${name}]`).inputValue(), value);
  assert.equal(await page.locator('[name=weekends]').isChecked(), false);
  assert.equal((await writes(page)).length, 0);
});

test('choosing a free-time result only prepares an event until explicit save', async t => {
  const page = await fixture(t, { slots: [{ start: '2026-09-18T16:00:00Z', end: '2026-09-18T17:00:00Z', timeZone: 'America/New_York' }] });
  await page.locator('.cal-slots summary').click(); await page.locator('[data-cal-slots-form] button').click();
  await page.waitForSelector('[data-slot]');
  assert.equal((await writes(page)).length, 0);
  await page.locator('[data-slot]').click();
  assert.equal(await page.locator('input[name=startDate]').inputValue(), '2026-09-18');
  assert.equal(await page.locator('input[name=startTime]').inputValue(), '12:00');
  assert.equal(await page.locator('input[name=endDate]').inputValue(), '2026-09-18');
  assert.equal(await page.locator('input[name=endTime]').inputValue(), '13:00');
  assert.equal((await writes(page)).length, 0);
  await page.locator('input[name=summary]').fill('Chosen free time');
  await page.locator('[data-save]').click();
  await page.waitForFunction(() => !document.querySelector('dialog'));
  const [write] = await writes(page);
  assert.equal((await writes(page)).length, 1);
  assert.equal(write.url, '/api/calendar/events'); assert.equal(write.method, 'POST');
  assert.deepEqual(write.body.event.start, { dateTime: '2026-09-18T12:00:00-04:00', timeZone: 'America/New_York' });
  assert.deepEqual(write.body.event.end, { dateTime: '2026-09-18T13:00:00-04:00', timeZone: 'America/New_York' });
});

test('open free-time finder groups and controls fit desktop through 320px in both host themes', async t => {
  const page = await fixture(t, { hostSelects: true });
  const card = page.locator('.cal-slots');
  await card.locator(':scope > summary').click();
  assert.ok(await card.locator('.cal-slots-fields .cal-slots-group').count() >= 2);
  for (const [category, theme] of [['premium', 'premium-champagne'], ['anime', 'anime-wisteria']]) {
    await page.evaluate(({ category, theme }) => { document.body.dataset.themeCat = category; document.body.dataset.theme = theme; }, { category, theme });
    for (const width of [1440, 960, 600, 390, 320]) {
      await page.setViewportSize({ width, height: 1100 });
      const layout = await card.evaluate(element => {
        const box = element.getBoundingClientRect();
        const bounds = item => { const rect = item.getBoundingClientRect(); return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height }; };
        return {
          card: bounds(element), scroll: element.scrollWidth, client: element.clientWidth,
          fields: bounds(element.querySelector('.cal-slots-fields')), actions: bounds(element.querySelector('.cal-slots-actions')),
          overflowing: [...element.querySelectorAll('summary,.cal-slots-heading,.cal-slots-icon,.cal-slots-group,label,input,button')].filter(item => {
            const rect = item.getBoundingClientRect();
            return rect.left < box.left - 1 || rect.right > box.right + 1 || rect.width <= 0 || rect.height <= 0;
          }).map(item => ({ element: item.name || item.className || item.tagName, ...bounds(item) })),
          controls: [...element.querySelectorAll('input:not([type=checkbox]),button[type=submit]')].map(bounds),
        };
      });
      const label = `${theme} at ${width}px`;
      assert.ok(layout.card.left >= 0 && layout.card.right <= width + 1, `${label}: card must fit viewport`);
      assert.ok(layout.scroll <= layout.client + 1, `${label}: card must not clip horizontal content`);
      assert.deepEqual(layout.overflowing, [], `${label}: all finder fields and labels must remain inside the card`);
      assert.ok(layout.actions.top >= layout.fields.bottom - 1, `${label}: actions should have their own row below the fields`);
      assert.ok(layout.controls.every(control => control.height >= 36), `${label}: controls must retain usable heights`);
      for (let index = 0; index < layout.controls.length; index++) {
        const first = layout.controls[index];
        for (const second of layout.controls.slice(index + 1)) {
          const overlapWidth = Math.min(first.right, second.right) - Math.max(first.left, second.left);
          const overlapHeight = Math.min(first.bottom, second.bottom) - Math.max(first.top, second.top);
          assert.ok(overlapWidth <= 1 || overlapHeight <= 1, `${label}: form controls must not overlap`);
        }
      }
      if (process.env.CALENDAR_CAPTURE === '1') {
        const output = path.join(root, 'tmp/calendar-ui-review'); fs.mkdirSync(output, { recursive: true });
        await card.screenshot({ path: path.join(output, `${category}-slots-${width}.png`), animations: 'disabled' });
      }
    }
  }
  assert.equal((await writes(page)).length, 0);
});

test('cleanup stops owned polling, aborts late reads and removes active dialog', async t => {
  const page = await fixture(t, { holdStatus: true });
  await page.evaluate(() => { window.cleanup(); window.finishStatus(); });
  await page.waitForTimeout(30);
  assert.equal(await page.locator('#root').innerHTML(), '');
  assert.deepEqual(await page.evaluate(() => window.intervals.map(item => item.delay)), [60000]);
  assert.equal(await page.evaluate(() => window.cleared.length), 1);
  assert.equal(await page.evaluate(() => window.calls.length), 1);
  await page.evaluate(() => { window.fixture.holdStatus = false; window.cleanup = window.HarbourCalendar.mount(document.getElementById('root'), { api: window.api }); });
  await page.waitForSelector('[data-cal-new]'); await page.locator('[data-cal-new]').click();
  await page.evaluate(() => window.cleanup()); assert.equal(await page.locator('dialog').count(), 0);
});

test('calendar deep links select the correct non-primary calendar and event', async t => {
  const page = await fixture(t, { initialCalendarId: 'work', initialEventId: 'event1', calendars: [{ id: 'primary', summary: 'Personal', timeZone: 'America/New_York', accessRole: 'owner', primary: true }, { id: 'work', summary: 'Work', timeZone: 'Asia/Shanghai', accessRole: 'reader' }], events: [{ ...event, calendarId: 'work' }] });
  await page.waitForSelector('dialog');
  assert.equal(await page.locator('[data-cal-calendar]').inputValue(), 'work');
  assert.equal(await page.locator('input[name=summary]').isDisabled(), true);
  assert.match(await page.locator('dialog .cal-eyebrow').innerText(), /Asia\/Shanghai/);
});

test('event drafts register with the existing leave boundary and busy writes cannot be discarded', async t => {
  const page = await fixture(t, { holdWrite: true });
  await newEvent(page);
  assert.deepEqual(await page.evaluate(() => { const entry = window.editorEntries.get('calendar-event'); return [entry.isActive(), entry.isDirty(), entry.isBusy()]; }), [true, true, false]);
  await page.locator('[data-save]').click();
  assert.deepEqual(await page.evaluate(() => { const entry = window.editorEntries.get('calendar-event'); return [entry.isBusy(), entry.discard()]; }), [true, false]);
  await page.evaluate(() => window.finishWrite());
  await page.waitForFunction(() => window.editorEntries.size === 0);
  await newEvent(page);
  await page.evaluate(() => window.cleanup());
  assert.equal(await page.evaluate(() => window.editorEntries.size), 0);
});

test('desktop and narrow layouts fit both themes without clipping controls or event dialog', async t => {
  const page = await fixture(t, { events: [event], hostSelects: true });
  for (const [width, category, theme] of [[1280, 'premium', 'premium-champagne'], [1280, 'anime', 'anime-wisteria'], [390, 'anime', 'anime-wisteria']]) {
    await page.setViewportSize({ width, height: width > 400 ? 900 : 844 });
    await page.evaluate(({ category, theme }) => { document.body.dataset.themeCat = category; document.body.dataset.theme = theme; }, { category, theme });
    const sizes = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth, grid: document.querySelector('.cal-grid').getBoundingClientRect().width }));
    assert.ok(sizes.scroll <= sizes.client + 1, `${width}px layout must not scroll horizontally: ${JSON.stringify(sizes)}`);
    assert.ok(sizes.grid > 250);
    if (process.env.CALENDAR_CAPTURE === '1') {
      const output = path.join(root, 'tmp/calendar-ui-review'); fs.mkdirSync(output, { recursive: true });
      await page.screenshot({ path: path.join(output, `${category}-${width}.png`), fullPage: true });
    }
  }
  await page.locator('[data-cal-new]').click();
  const bounds = await page.locator('dialog').boundingBox();
  assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= 391);
  assert.ok(bounds.height <= 810);
  await page.locator('[data-cancel]').scrollIntoViewIfNeeded(); assert.equal(await page.locator('[data-cancel]').isVisible(), true);
  if (process.env.CALENDAR_CAPTURE === '1') await page.screenshot({ path: path.join(root, 'tmp/calendar-ui-review/event-mobile.png'), fullPage: true });
  await page.locator('[data-cancel]').click();
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.locator('.cal-agenda-event').click();
  if (process.env.CALENDAR_CAPTURE === '1') await page.screenshot({ path: path.join(root, 'tmp/calendar-ui-review/event-desktop.png'), fullPage: true });
  await page.locator('[data-cancel]').click();
  await page.evaluate(event => { window.cleanup(); document.getElementById('root').style.padding = '30px'; document.getElementById('root').innerHTML = window.HarbourCalendar.cardsHtml([{ action: 'created', timeZone: 'America/New_York', events: [event] }, { action: 'slots', timeZone: 'America/New_York', slots: [{ start: '2026-09-18T16:00:00Z', end: '2026-09-18T17:00:00Z' }] }]); }, event);
  if (process.env.CALENDAR_CAPTURE === '1') await page.screenshot({ path: path.join(root, 'tmp/calendar-ui-review/chat-cards.png'), fullPage: true });
});

test('actual Harbour dropdown wrappers keep calendar and reminder choices readable on narrow screens', async t => {
  const page = await fixture(t, { hostSelects: true }, { width: 390, height: 844 });
  await page.locator('.cal-calendar-picker .hs-trigger').click();
  const menu = page.locator('.cal-calendar-picker .hs-menu');
  await menu.waitFor({ state: 'visible' });
  const bounds = await menu.boundingBox(); assert.ok(bounds.width >= 230);
  assert.match(await menu.innerText(), /Personal/);
  await page.locator('.cal-calendar-picker .hs-trigger').press('Escape');
  await page.locator('[data-cal-new]').click();
  const reminder = page.locator('dialog .harbour-select').filter({ has: page.locator('select[name=reminder]') });
  await reminder.locator('.hs-trigger').click();
  const reminderMenu = reminder.locator('.hs-menu');
  await reminderMenu.waitFor({ state: 'visible' });
  const reminderBounds = await reminderMenu.boundingBox();
  assert.ok(reminderBounds.width >= 230);
  await reminderMenu.getByRole('option', { name: '提前 30 分钟', exact: true }).click();
  assert.equal(await page.locator('select[name=reminder]').inputValue(), '30');
});

test('weekly controls and host dropdowns fit both themes through a 320px event dialog', async t => {
  const page = await fixture(t, { hostSelects: true });
  await newEvent(page);
  await repeatDays(page, ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU']);
  await repeatSpan(page, 1);
  assert.equal(await page.locator('input[name=repeat]:checked').inputValue(), 'weekly');
  for (const [category, theme] of [['premium', 'premium-champagne'], ['anime', 'anime-wisteria']]) {
    await page.evaluate(({ category, theme }) => { document.body.dataset.themeCat = category; document.body.dataset.theme = theme; }, { category, theme });
    for (const width of [1280, 390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      for (const ending of ['count', 'until']) {
        await page.locator('select[name=repeatEnd]').selectOption(ending);
        const layout = await page.locator('dialog').evaluate(element => {
          const bounds = element.getBoundingClientRect();
          const fields = [...element.querySelectorAll('label,.harbour-select,[data-repeat-summary],footer')].filter(item => item.checkVisibility());
          return {
            left: bounds.left, right: bounds.right, height: bounds.height,
            scroll: element.scrollWidth, client: element.clientWidth,
            choices: [...element.querySelectorAll('.cal-schedule-choice')].map(item => {
              const rect = item.getBoundingClientRect();
              return { left: rect.left, right: rect.right, top: rect.top, width: rect.width, height: rect.height };
            }),
            outside: fields.filter(item => {
              const rect = item.getBoundingClientRect();
              return rect.left < bounds.left - 1 || rect.right > bounds.right + 1;
            }).map(item => item.getAttribute('name') || item.className || item.tagName),
          };
        });
        const label = `${theme}, ${width}px, ${ending}`;
        assert.ok(layout.left >= 0 && layout.right <= width + 1, `${label}: dialog must fit viewport`);
        assert.ok(layout.height <= 844, `${label}: the dialog stays within screen height`);
        assert.ok(layout.scroll <= layout.client + 1, `${label}: event fields must not scroll horizontally`);
        assert.deepEqual(layout.outside, [], `${label}: repeat choices and summaries must fit`);
        assert.equal(layout.choices.length, 2, `${label}: both schedule types remain visible`);
        const [singleChoice, weeklyChoice] = layout.choices;
        assert.ok(Math.abs(singleChoice.top - weeklyChoice.top) <= 1, `${label}: type cards share one row`);
        assert.ok(singleChoice.right < weeklyChoice.left, `${label}: type cards do not overlap`);
        assert.ok(Math.abs(singleChoice.width - weeklyChoice.width) <= 1 && singleChoice.width >= 100, `${label}: type cards have equal usable widths`);
        assert.ok(singleChoice.height >= 60 && weeklyChoice.height >= 60, `${label}: type cards retain usable touch targets`);
        if (ending === 'count' && process.env.CALENDAR_UX_SCREENSHOTS === '1') {
          const output = path.join(root, 'tmp'); fs.mkdirSync(output, { recursive: true });
          await page.locator('dialog').evaluate(element => { element.scrollTop = 0; });
          await page.locator('dialog').screenshot({ path: path.join(output, `calendar-ux-${theme}-${width}.png`), animations: 'disabled' });
        }
        await page.locator('[data-save]').scrollIntoViewIfNeeded();
        assert.equal(await page.locator('[data-save]').isVisible(), true);
      }
    }
  }
  assert.equal((await writes(page)).length, 0);
});
