const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { chromium } = require('../../vendor/folia/node_modules/playwright');
const root = path.resolve(__dirname, '../..');
const source = fs.readFileSync(path.join(root, 'web/app.js'), 'utf8');
const cronSource = source.slice(source.indexOf('function openCronModal('), source.indexOf('PANELS.channels ='));
const base = { id: 'pricing', name: '刷新模型目录与计费表', builtin: 'pricing-refresh', agent: '-', input: '', schedule: '0 8 * * *', timeZone: 'America/New_York', enabled: true,
  lastRun: '2026-09-26T21:08:35Z', lastRunId: 'previous', lastStatus: 'completed', lastResult: '计费表已更新：更新 4 条；跳过锁定价 4 条。', lastDeliveryStatus: 'none', nextTick: '2026-09-27T12:00:00Z', authorizationStatus: 'system' };
let browser;
before(async () => { browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || (process.platform === 'win32' ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' : undefined) }); });
after(async () => { await browser?.close(); });

async function fixture(t, extra = {}, viewport = { width: 1440, height: 1000 }) {
  const context = await browser.newContext({ viewport });
  await context.route('**/*', route => route.abort());
  t.after(() => context.close());
  const page = await context.newPage();
  await page.setContent('<body data-theme-cat="anime" data-theme-persona="elaina" data-theme="anime-wisteria"><main id="root" style="padding:32px;max-width:1450px;margin:auto;height:100%;overflow-y:auto"></main></body>');
  for (const file of ['themes.css', 'styles.css', 'cron.css']) await page.addStyleTag({ path: path.join(root, 'web', file) });
  await page.addScriptTag({ path: path.join(root, 'web/time-zone.js') });
  await page.evaluate(({ base, extra }) => {
    window.fixture = { jobs: [base], ...extra }; window.calls = []; window.toasts = []; window.routes = 0;
    window.PANELS = {}; window.disposeCronPanel = null;
    window.$ = selector => document.querySelector(selector);
    window.esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    window.h = html => { const template = document.createElement('template'); template.innerHTML = html.trim(); return template.content.firstElementChild; };
    window.timeHtml = (value, style) => `<time>${window.esc(window.HarbourTime.format(value, style))}</time>`;
    window.scheduleTimeZone = job => job?.timeZone || 'America/New_York';
    window.scheduleTimeZoneOptions = zone => `<option>${zone}</option>`;
    window.humanizeCron = schedule => schedule === '0 8 * * *' ? '每天 08:00' : schedule;
    window.harbourConfirm = async () => true;
    window.toast = (...args) => window.toasts.push(args);
    window.route = () => { window.routes++; };
    window.showMarkdownModal = (title, body) => { window.resultModal = { title, body }; };
    window.api = async (url, options) => {
      const method = options?.method || 'GET';
      window.calls.push({ url, method });
      if (url === '/api/agents') return { agents: [{ name: 'main-elaina' }] };
      if (url === '/api/cron/delivery-targets') return { targets: [] };
      if (url === '/api/cron' && method === 'GET') {
        if (window.fixture.holdList) return new Promise(resolve => { window.resolveList = () => resolve({ jobs: window.fixture.jobs }); });
        return structuredClone({ jobs: window.fixture.jobs });
      }
      const match = /^\/api\/cron\/([^/]+)(?:\/([^/]+)(?:\/([^/]+))?)?$/.exec(url);
      if (!match) throw new Error('Unexpected API ' + url);
      const job = window.fixture.jobs.find(j => j.id === decodeURIComponent(match[1]));
      if (method === 'POST' && match[2] === 'run-once') {
        if (window.fixture.rejectPost) throw Object.assign(new Error('Needs authorization'), { status: 403 });
        const result = { ...job, lastStatus: 'queued', lastRunId: 'new-run', lastDeliveryStatus: 'none' };
        if (!window.fixture.unknownPost) Object.assign(job, result);
        if (window.fixture.holdPost) await new Promise(resolve => { window.releasePost = resolve; });
        if (window.fixture.unknownPost) throw new Error('Connection lost');
        return structuredClone({ job: result, jobs: window.fixture.jobs });
      }
      if (method === 'POST' && match[2] === 'toggle') { job.enabled = !job.enabled; return { job, jobs: structuredClone(window.fixture.jobs) }; }
      if (method === 'PATCH') return { job };
      if (match[2] === 'history') {
        if (window.fixture.historyError) throw new Error(window.fixture.historyError);
        if (match[3]) {
          const runId = decodeURIComponent(match[3]);
          if (window.fixture.holdRun) return new Promise(resolve => { window.resolveRun = () => resolve({ run: { id: runId, result: 'LATE PRIVATE RESULT' } }); });
          return { run: { id: runId, trigger: 'manual', status: job.lastStatus, result: job.lastResult, queuedAt: job.lastRun, deliveryStatus: job.lastDeliveryStatus, legacy: true } };
        }
        return { runs: [{ id: job.lastRunId, status: job.lastStatus, trigger: 'unknown', queuedAt: job.lastRun, summary: job.lastResult || job.lastError, hasResult: Boolean(job.lastResult), legacy: true }], retentionLimit: 50 };
      }
      throw new Error('Unexpected method ' + method);
    };
  }, { base, extra });
  await page.addScriptTag({ path: path.join(root, 'web/cron.js') });
  await page.addScriptTag({ content: cronSource });
  await page.evaluate(() => window.PANELS.cron.render(document.querySelector('#root')));
  return page;
}
const posts = page => page.evaluate(() => window.calls.filter(c => c.method === 'POST').length);

test('manual run remains visibly pending, prevents duplicate clicks and reports its eventual result without remounting', async t => {
  const page = await fixture(t, { holdPost: true });
  await page.locator('[data-cron-once]').click();
  assert.equal(await page.locator('[data-cron-once]').isDisabled(), true);
  assert.match(await page.locator('.cron-feedback').textContent(), /正在提交/);
  assert.equal(await posts(page), 1);
  await page.evaluate(() => window.releasePost());
  await page.waitForFunction(() => document.querySelector('.cron-feedback').textContent.includes('等待执行'));
  await page.evaluate(() => { Object.assign(window.fixture.jobs[0], { lastStatus: 'running' }); });
  await page.locator('[data-refresh]').click();
  await page.waitForFunction(() => document.querySelector('.cron-outcome').textContent.includes('执行中'));
  await page.evaluate(() => { Object.assign(window.fixture.jobs[0], { lastStatus: 'completed', lastResult: 'UPDATED 7 PRICES' }); });
  await page.waitForFunction(() => document.querySelector('.cron-feedback').textContent.includes('UPDATED 7 PRICES'), { timeout: 6000 });
  assert.equal(await page.locator('[data-cron-once]').isDisabled(), false);
  assert.equal(await posts(page), 1);
  assert.equal(await page.evaluate(() => window.routes), 0);
  assert.match(await page.evaluate(() => window.toasts.at(-1)[0]), /执行完成.*UPDATED 7 PRICES/);
});

test('an unknown submit never reports the old successful result and never retries', async t => {
  const page = await fixture(t, { unknownPost: true });
  await page.locator('[data-cron-once]').click();
  await page.waitForFunction(() => document.querySelector('.cron-feedback').textContent.includes('回执未确认'));
  await page.locator('[data-refresh]').click();
  assert.match(await page.locator('.cron-feedback').textContent(), /不会自动重发/);
  assert.equal(await page.locator('[data-cron-once]').isDisabled(), true);
  assert.equal(await page.evaluate(() => window.toasts.length), 0);
  assert.equal(await posts(page), 1);
  await page.evaluate(() => { Object.assign(window.fixture.jobs[0], { lastRunId: 'confirmed-new-run', lastStatus: 'completed', lastResult: 'CONFIRMED_NEW' }); });
  await page.locator('[data-refresh]').click();
  await page.waitForFunction(() => document.querySelector('.cron-feedback').textContent.includes('CONFIRMED_NEW'));
  assert.equal(await page.locator('[data-cron-once]').isDisabled(), false);
});

test('execution failure and successful execution with delivery failure have different feedback', async t => {
  const page = await fixture(t);
  await page.locator('[data-cron-once]').click();
  await page.waitForFunction(() => window.fixture.jobs[0].lastRunId === 'new-run');
  await page.evaluate(() => { Object.assign(window.fixture.jobs[0], { lastStatus: 'failed', lastError: 'MODEL_FAILED' }); });
  await page.locator('[data-refresh]').click();
  await page.waitForFunction(() => document.querySelector('.cron-feedback').textContent.includes('MODEL_FAILED'));
  assert.match(await page.locator('.cron-feedback').textContent(), /执行失败/);
  await page.evaluate(() => { Object.assign(window.fixture.jobs[0], { lastRunId: 'between', lastError: undefined }); });
  await page.locator('[data-refresh]').click();
  await page.locator('[data-cron-once]').click();
  await page.waitForFunction(() => window.fixture.jobs[0].lastRunId === 'new-run');
  await page.evaluate(() => { Object.assign(window.fixture.jobs[0], { lastStatus: 'completed', lastResult: 'NEW_RESULT', lastDeliveryStatus: 'unknown', lastDeliveryError: 'NETWORK_TIMEOUT' }); });
  await page.locator('[data-refresh]').click();
  await page.waitForFunction(() => document.querySelector('.cron-feedback').textContent.includes('NETWORK_TIMEOUT'));
  assert.match(await page.locator('.cron-feedback').textContent(), /执行完成，送达状态未知/);
  assert.equal(await page.locator('[data-cron-once]').isDisabled(), true);
  assert.equal(await posts(page), 2);
});

test('a definite rejection is shown and unlocks the manual action', async t => {
  const page = await fixture(t, { rejectPost: true });
  await page.locator('[data-cron-once]').click();
  await page.waitForFunction(() => document.querySelector('.cron-feedback').textContent.includes('Needs authorization'));
  assert.equal(await page.locator('[data-cron-once]').isDisabled(), false);
  assert.equal(await posts(page), 1);
});

test('clicking a task opens read-only history with full result, legacy limitations, config, keyboard close', async t => {
  const page = await fixture(t);
  await page.locator('.cron-task-title button').click();
  await page.waitForSelector('.cron-result');
  assert.match(await page.locator('.cron-run-content').textContent(), /计费表已更新/);
  assert.match(await page.locator('.cron-run-content').textContent(), /更早记录无法补回/);
  await page.locator('[data-tab=config]').click();
  assert.match(await page.locator('.cron-config-grid').first().textContent(), /pricing-refresh.*每天 08:00.*America\/New_York/);
  assert.equal(await posts(page), 0);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('.cron-detail-overlay').count(), 0);
  assert.equal(await page.locator('.cron-task-title button').evaluate(b => b === document.activeElement), true);
});

test('history errors are explicit, and closing ignores delayed results', async t => {
  const page = await fixture(t, { historyError: 'Backend needs restart' });
  await page.locator('.cron-task-title button').click();
  await page.waitForSelector('.cron-inline-error');
  assert.match(await page.locator('.cron-inline-error').textContent(), /Backend needs restart/);
  await page.keyboard.press('Escape');
  await page.evaluate(() => { delete window.fixture.historyError; window.fixture.holdRun = true; });
  await page.locator('.cron-task-title button').click();
  await page.waitForFunction(() => Boolean(window.resolveRun));
  await page.keyboard.press('Escape');
  await page.evaluate(() => window.resolveRun());
  assert.equal(await page.locator('.cron-detail-overlay').count(), 0);
  assert.doesNotMatch(await page.locator('body').textContent(), /LATE PRIVATE RESULT/);
  assert.equal(await posts(page), 0);
});

test('late poll after navigation cannot repaint another panel or leave a drawer behind', async t => {
  const page = await fixture(t);
  await page.locator('.cron-task-title button').click();
  await page.waitForSelector('.cron-result');
  await page.evaluate(() => { window.fixture.holdList = true; });
  await page.evaluate(() => document.querySelector('[data-refresh]').click());
  await page.waitForFunction(() => Boolean(window.resolveList));
  await page.evaluate(() => { window.disposeCronPanel(); document.querySelector('#root').textContent = 'OTHER PANEL'; window.resolveList(); });
  assert.equal(await page.locator('.cron-detail-overlay').count(), 0);
  assert.equal(await page.locator('#root').textContent(), 'OTHER PANEL');
});

test('filters, search and exact pause action do not execute work or reset the page', async t => {
  const page = await fixture(t, { jobs: [base, { ...base, id: 'summary', name: '晚间日程摘要', builtin: undefined, agent: 'main-elaina', enabled: false, lastStatus: 'failed', lastError: 'Needs authorization' }] });
  await page.locator('[data-filter=attention]').click();
  assert.equal(await page.locator('.cron-task').count(), 1);
  await page.locator('[data-filter=all]').click();
  await page.locator('.cron-search').fill('计费');
  assert.equal(await page.locator('.cron-task').count(), 1);
  await page.locator('[data-cron-toggle]').click();
  await page.waitForFunction(() => document.querySelector('[data-cron-toggle]').getAttribute('aria-pressed') === 'false');
  assert.equal(await page.locator('.cron-search').inputValue(), '计费');
  assert.equal(await page.evaluate(() => window.calls.some(c => c.url.includes('run-once'))), false);
  assert.equal(await page.evaluate(() => window.routes), 0);
});

test('configuration edits register unsaved changes; cancel can keep the draft, navigation cleanup unregisters', async t => {
  const page = await fixture(t);
  await page.evaluate(() => {
    window.guardRemoved = false;
    window.HarbourUnsavedChanges = { register(_id, entry) { window.guard = entry; return () => { window.guardRemoved = true; }; } };
    window.harbourConfirm = async () => false;
  });
  await page.locator('.cron-task-title button').click();
  await page.locator('[data-tab=config]').click();
  await page.locator('[data-edit]').click();
  assert.equal(await page.evaluate(() => window.guard.isDirty()), false);
  await page.locator('#cronName').fill('Unsaved');
  assert.equal(await page.evaluate(() => window.guard.isDirty()), true);
  await page.locator('#cronModalCancel').click();
  assert.equal(await page.locator('#cronName').inputValue(), 'Unsaved');
  await page.evaluate(() => window.disposeCronPanel());
  assert.equal(await page.locator('#cronModal').count(), 0);
  assert.equal(await page.evaluate(() => window.guardRemoved), true);
  assert.equal(await posts(page), 0);
});

test('delete confirmation appears above the drawer; cancelling keeps task and history intact', async t => {
  const page = await fixture(t);
  await page.evaluate(async () => {
    window.harbourConfirm = () => new Promise(resolve => {
      const overlay = document.createElement('div'); overlay.className = 'md-modal harbour-dialog-layer';
      overlay.innerHTML = '<div class="md-card"><button id="cancelDelete">取消删除</button></div>';
      document.body.appendChild(overlay);
      overlay.querySelector('button').onclick = () => { overlay.remove(); resolve(false); };
    });
    await window.PANELS.cron.render(document.querySelector('#root'));
  });
  await page.locator('.cron-task-title button').click();
  await page.locator('[data-tab=config]').click();
  await page.locator('[data-delete]').click();
  await page.locator('#cancelDelete').click({ timeout: 2000 });
  assert.equal(await page.locator('.cron-detail-overlay').count(), 1);
  assert.equal(await page.locator('.cron-task').count(), 1);
  assert.equal(await page.evaluate(() => window.calls.some(call => call.method === 'DELETE')), false);
});

test('unsafe result/name markup stays text; desktop and mobile layouts are bounded', async t => {
  const payload = '<img src=x onerror="window.injected=true">';
  const page = await fixture(t, { jobs: [{ ...base, name: payload, lastResult: payload }] });
  await page.locator('.cron-task-title button').click();
  await page.waitForSelector('.cron-result');
  assert.equal(await page.locator('.cron-result').textContent(), payload);
  assert.equal(await page.locator('img').count(), 0);
  assert.equal(await page.evaluate(() => window.injected), undefined);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.equal(await page.locator('.cron-detail').evaluate(el => el.getBoundingClientRect().right <= innerWidth), true);
});

test('visual QA: light, dark, anime and narrow variants', async t => {
  const page = await fixture(t, { jobs: [base,
    { ...base, id: 'morning', name: '早间日程与邮件摘要', builtin: undefined, agent: 'main-elaina', input: '整理今天的日程，列出需要留意的邮件。', executionIdentity: 'owner', delivery: { label: 'QQ · Elaina · 私聊', channel: 'qq' }, lastDeliveryStatus: 'sent', lastResult: '今天共有 3 项日程，2 封待处理邮件。' },
    { ...base, id: 'evening', name: '晚间回顾', enabled: false, builtin: undefined, agent: 'main-aemeath', lastStatus: undefined, lastResult: undefined, lastRun: undefined },
  ] });
  const dir = path.join(os.tmpdir(), 'harbour-cron-preview'); fs.mkdirSync(dir, { recursive: true });
  await page.screenshot({ path: path.join(dir, 'cron-light.png'), fullPage: true });
  await page.locator('.cron-task-title button').first().click(); await page.waitForSelector('.cron-result');
  await page.screenshot({ path: path.join(dir, 'cron-history.png'), fullPage: true });
  await page.locator('[data-tab=config]').click();
  await page.screenshot({ path: path.join(dir, 'cron-config.png'), fullPage: true });
  await page.keyboard.press('Escape');
  await page.evaluate(() => { document.body.dataset.themeCat = 'premium'; document.body.dataset.theme = 'premium-tungsten'; });
  await page.screenshot({ path: path.join(dir, 'cron-dark.png'), fullPage: true });
  await page.evaluate(() => { document.body.dataset.themeCat = 'anime'; document.body.dataset.themePersona = 'elaina'; document.body.dataset.theme = 'anime-wisteria'; });
  await page.screenshot({ path: path.join(dir, 'cron-anime.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(dir, 'cron-mobile.png'), fullPage: true });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  console.log('Cron preview screenshots:', dir);
});
