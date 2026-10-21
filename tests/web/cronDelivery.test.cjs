const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('../../vendor/folia/node_modules/playwright');

// Isolated real-DOM tests: no Harbour server, user profile, channel traffic or scheduled jobs.
const root = path.resolve(__dirname, '../..');
const source = fs.readFileSync(path.join(root, 'web/app.js'), 'utf8');
const cronSource = source.slice(source.indexOf('function openCronModal('), source.indexOf('PANELS.channels ='));
const css = fs.readFileSync(path.join(root, 'web/styles.css'), 'utf8');
const chrome = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || (process.platform === 'win32' ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' : undefined);
let browser;
before(async () => { browser = await chromium.launch({ headless: true, executablePath: chrome }); });
after(async () => { await browser?.close(); });

const target = { sessionId: 'known-qq', label: 'QQ · Elaina · 私聊', channel: 'qq', accountKey: 'elaina', scope: 'dm', targetId: 'trusted-openid', available: true };
const editing = { id: 'existing-job', name: 'Existing', agent: 'main-elaina', schedule: '0 9 * * *', input: 'Summarize', sessionMode: 'fresh', timeZone: 'America/New_York', delivery: { ...target } };

async function fixture(t, data = {}) {
  const context = await browser.newContext({ viewport: { width: 1400, height: 1000 } });
  await context.route('**/*', route => route.abort());
  t.after(() => context.close());
  const page = await context.newPage();
  await page.setContent('<main id="root"></main>');
  await page.addStyleTag({ content: css });
  await page.addStyleTag({ path: path.join(root, 'web/cron.css') });
  await page.evaluate(data => {
    window.fixture = { targets: [], jobs: [], ...data };
    window.calls = []; window.toasts = []; window.routes = 0;
    window.PANELS = {};
    window.disposeCronPanel = null;
    window.$ = selector => document.querySelector(selector);
    window.esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    window.h = text => { const template = document.createElement('template'); template.innerHTML = text.trim(); return template.content.firstElementChild; };
    window.scheduleTimeZone = job => job?.timeZone || 'America/New_York';
    window.scheduleTimeZoneOptions = zone => `<option value="${zone}">${zone}</option>`;
    window.humanizeCron = schedule => schedule;
    window.timeHtml = value => `<time>${window.esc(value)}</time>`;
    window.harbourConfirm = async () => true;
    window.toast = (...args) => window.toasts.push(args);
    window.route = () => { window.routes += 1; };
    window.showMarkdownModal = (title, body) => { window.resultModal = { title, body }; };
    window.api = async (url, options) => {
      window.calls.push({ url, method: options?.method || 'GET', body: options?.body ? JSON.parse(options.body) : undefined });
      if (url === '/api/cron/delivery-targets') {
        if (window.fixture.targetError) throw new Error(window.fixture.targetError);
        if (window.fixture.holdTargets) return new Promise(resolve => { window.resolveTargets = () => resolve({ targets: window.fixture.targets }); });
        return { targets: window.fixture.targets };
      }
      if (url === '/api/agents') return { agents: [{ name: 'main-elaina' }] };
      if (url === '/api/cron' && (!options?.method || options.method === 'GET')) return { jobs: window.fixture.jobs };
      return {};
    };
  }, data);
  await page.addScriptTag({ path: path.join(root, 'web/cron.js') });
  await page.addScriptTag({ content: cronSource });
  return page;
}

async function open(page, job = null) {
  await page.evaluate(job => window.openCronModal(job, [{ name: 'main-elaina' }]), job);
  if (!job?.builtin) await page.waitForFunction(() => !document.querySelector('#cronDelivery').disabled);
}
async function save(page) {
  await page.locator('#cronModalSave').click();
  await page.waitForFunction(() => window.calls.some(call => call.method === 'POST' || call.method === 'PATCH'));
  return page.evaluate(() => window.calls.find(call => call.method === 'POST' || call.method === 'PATCH'));
}

test('new jobs default to Harbour only, and opening never creates a job', async t => {
  const page = await fixture(t, { targets: [target] });
  await open(page);
  assert.equal(await page.locator('#cronDelivery').inputValue(), '');
  assert.equal(await page.evaluate(() => window.calls.some(call => call.method !== 'GET')), false);
  await page.locator('#cronSchedule').fill('0 9 * * *');
  const call = await save(page);
  assert.equal(call.body.deliverySessionId, null);
  assert.equal(call.body.timeZone, 'America/New_York');
  assert.equal(call.body.executionIdentity, 'system');
});

test('explicit owner execution is visible, saved separately from delivery, and can be revoked', async t => {
  const page = await fixture(t, { targets: [target], jobs: [{ ...editing, executionIdentity: 'owner', authorizationStatus: 'required' }] });
  await open(page, { ...editing, executionIdentity: 'owner', authorizationStatus: 'required' });
  assert.equal(await page.locator('#cronIdentity').inputValue(), 'owner');
  assert.match(await page.locator('#cronIdentityHint').textContent(), /重新授权/);
  assert.equal((await save(page)).body.executionIdentity, 'owner');
  await page.evaluate(() => { window.calls = []; });
  await open(page, { ...editing, executionIdentity: 'owner', authorizationStatus: 'authorized' });
  await page.locator('#cronIdentity').selectOption('system');
  assert.equal((await save(page)).body.executionIdentity, 'system');
  await page.evaluate(() => window.PANELS.cron.render(document.querySelector('#root')));
  assert.equal(await page.locator('.cron-identity').textContent(), '待主人重新授权');
});

test('selecting a known QQ conversation submits only its trusted session reference', async t => {
  const page = await fixture(t, { targets: [target] });
  await open(page);
  await page.locator('#cronSchedule').fill('0 9 * * *');
  await page.locator('#cronDelivery').selectOption(target.sessionId);
  const call = await save(page);
  assert.equal(call.body.deliverySessionId, target.sessionId);
  assert.equal(call.body.delivery, undefined);
  assert.equal(call.body.targetId, undefined);
});

test('editing preserves matched delivery unless selection actually changes', async t => {
  const page = await fixture(t, { targets: [target] });
  await open(page, editing);
  assert.equal(await page.locator('#cronDelivery').inputValue(), target.sessionId);
  const call = await save(page);
  assert.equal(call.method, 'PATCH');
  assert.equal(Object.hasOwn(call.body, 'deliverySessionId'), false);
});

test('an unmatched saved target is retained, and an explicit Harbour-only choice disables it', async t => {
  const page = await fixture(t);
  await open(page, editing);
  assert.match(await page.locator('#cronDeliveryHint').textContent(), /保留原投递目标/);
  assert.equal(Object.hasOwn((await save(page)).body, 'deliverySessionId'), false);
  await page.evaluate(() => { window.calls = []; });
  await open(page, editing);
  await page.locator('#cronDelivery').selectOption('');
  assert.equal((await save(page)).body.deliverySessionId, null);
});

test('unavailable targets are disabled and cannot be forced into a new request', async t => {
  const page = await fixture(t, { targets: [{ ...target, available: false }] });
  await open(page);
  assert.equal(await page.locator(`option[value="${target.sessionId}"]`).evaluate(option => option.disabled), true);
  await page.locator('#cronSchedule').fill('0 9 * * *');
  await page.locator('#cronDelivery').evaluate((select, id) => { select.value = id; select.dispatchEvent(new Event('change')); }, target.sessionId);
  await page.locator('#cronModalSave').click();
  assert.equal(await page.evaluate(() => window.calls.some(call => call.method !== 'GET')), false);
  assert.match(await page.evaluate(() => window.toasts.at(-1)?.[0]), /当前可用/);
});

test('target lookup failure is visible and does not erase an existing target', async t => {
  const page = await fixture(t, { targetError: 'offline' });
  await open(page, editing);
  assert.match(await page.locator('#cronDeliveryHint').textContent(), /无法加载渠道会话.*offline/);
  assert.equal(Object.hasOwn((await save(page)).body, 'deliverySessionId'), false);
});

test('an unavailable existing target can be preserved without retargeting', async t => {
  const page = await fixture(t, { targets: [{ ...target, available: false }] });
  await open(page, editing);
  assert.equal(await page.locator('#cronDelivery').inputValue(), target.sessionId);
  assert.match(await page.locator('#cronDeliveryHint').textContent(), /当前不可用.*不会改发/);
  assert.equal(Object.hasOwn((await save(page)).body, 'deliverySessionId'), false);
});

test('channel labels and error strings remain text, not executable markup', async t => {
  const label = '<img src=x onerror="window.injected=true">';
  const page = await fixture(t, { targets: [{ ...target, label }], jobs: [{ ...editing, lastError: label }] });
  await open(page);
  assert.match(await page.locator(`option[value="${target.sessionId}"]`).textContent(), /<img/);
  await page.locator('#cronModalCancel').click();
  await page.evaluate(() => window.PANELS.cron.render(document.querySelector('#root')));
  assert.match(await page.locator('.cron-outcome-error').textContent(), /<img/);
  assert.equal(await page.locator('img').count(), 0);
  assert.equal(await page.evaluate(() => window.injected), undefined);
});

test('latest execution and delivery errors remain visible alongside an older result', async t => {
  const page = await fixture(t, { jobs: [{ ...editing, lastStatus: 'failed', lastError: 'Model failed', lastResult: 'Older success', lastDeliveryStatus: 'unknown', lastDeliveryError: 'Timeout', lastDeliveryAt: '2026-09-18T10:00:00Z' }] });
  await page.evaluate(() => window.PANELS.cron.render(document.querySelector('#root')));
  const outcome = await page.locator('.cron-outcome').innerText();
  assert.match(outcome, /执行失败[\s\S]*Model failed/);
  assert.match(outcome, /送达状态未知[\s\S]*Timeout/);
  assert.match(outcome, /查看上次保留结果/);
  assert.equal(await page.locator('[data-cron-once]').isDisabled(), true);
  await page.locator('[data-cron-view]').click();
  assert.equal(await page.evaluate(() => window.resultModal.body), 'Older success');
});

test('completed execution and successful delivery are separate from Harbour-only jobs', async t => {
  const page = await fixture(t, { jobs: [
    { ...editing, lastStatus: 'completed', lastDeliveryStatus: 'sent' },
    { ...editing, id: 'local-job', delivery: undefined, lastStatus: 'running', lastDeliveryStatus: 'none' },
  ] });
  await page.evaluate(() => window.PANELS.cron.render(document.querySelector('#root')));
  assert.match(await page.locator('.cron-outcome').first().innerText(), /执行完成[\s\S]*已发送/);
  assert.match(await page.locator('.cron-delivery-target').nth(1).innerText(), /仅 Harbour/);
  assert.equal(await page.locator('[data-cron-once="local-job"]').isDisabled(), true);
});

test('builtin editing locks code-owned fields and only saves name, schedule and timezone', async t => {
  const page = await fixture(t, { targets: [target] });
  const builtin = { id: 'pricing', builtin: 'pricing-refresh', agent: '-', input: '', name: 'Pricing', schedule: '0 8 * * *', timeZone: 'America/New_York' };
  await open(page, builtin);
  for (const id of ['cronAgent', 'cronInput', 'cronMode', 'cronDelivery', 'cronIdentity']) {
    assert.equal(await page.locator(`#${id}`).isDisabled(), true);
  }
  assert.equal(await page.locator('#cronAgent').inputValue(), '-');
  assert.match(await page.locator('#cronDeliveryHint').textContent(), /系统代码执行/);
  assert.equal(await page.evaluate(() => window.calls.length), 0);
  await page.locator('#cronName').fill('Updated pricing');
  await page.locator('#cronSchedule').fill('0 7 * * *');
  const call = await save(page);
  assert.equal(call.method, 'PATCH');
  assert.deepEqual(call.body, { name: 'Updated pricing', schedule: '0 7 * * *', timeZone: 'America/New_York' });
});

test('saving during target loading preserves existing delivery and ignores late responses', async t => {
  const page = await fixture(t, { targets: [target], holdTargets: true });
  await page.evaluate(job => window.openCronModal(job, [{ name: 'main-elaina' }]), editing);
  assert.equal(await page.locator('#cronDelivery').isDisabled(), true);
  assert.equal(Object.hasOwn((await save(page)).body, 'deliverySessionId'), false);
  await page.evaluate(() => window.resolveTargets());
  assert.equal(await page.locator('#cronModal').count(), 0);
  assert.equal(await page.evaluate(() => window.calls.filter(call => call.method !== 'GET').length), 1);
});

test('a new job saved while target loading still defaults to Harbour only', async t => {
  const page = await fixture(t, { targets: [target], holdTargets: true });
  await page.evaluate(() => window.openCronModal(null, [{ name: 'main-elaina' }]));
  await page.locator('#cronSchedule').fill('0 7 * * *');
  assert.equal((await save(page)).body.deliverySessionId, null);
});
