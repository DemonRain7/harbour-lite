const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '../..');
const ctx = vm.createContext({ window: {} });
vm.runInContext(fs.readFileSync(path.join(root, 'web/run-picker.js'), 'utf8'), ctx);
const Picker = ctx.window.HarbourRunPicker;
const plain = value => JSON.parse(JSON.stringify(value));
const gate = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
function fixture() {
  const picker = Object.create(Picker.prototype);
  Object.assign(picker, { state: { identity: 'elaina:A', config: {}, defaults: { modelRef: 'native/exact', reasoningEffort: 'medium' },
    models: [{ value: 'native/exact', label: 'Native', defaultEffort: 'max', fallbackEffort: 'medium', efforts: ['low', 'medium', 'high', 'max'].map(effort => ({ effort })) }] },
    view: 'effort', render() {}, renderPopup() {}, focusInitial() {}, close() { this.view = ''; },
  }); return picker;
}
function modelListFixture(models, config = {}) {
  const document = { createElement(tag) { return { tag, children: [], dataset: {}, attributes: {},
    setAttribute(key, value) { this.attributes[key] = value; },
    append(...children) { this.children.push(...children); },
    replaceChildren(...children) { this.children = children; },
  }; } };
  const context = vm.createContext({ window: {}, document });
  vm.runInContext(fs.readFileSync(path.join(root, 'web/run-picker.js'), 'utf8'), context);
  const p = Object.create(context.window.HarbourRunPicker.prototype), choices = [];
  Object.assign(p, { state: { models, config, defaults: { modelRef: models[0]?.value } },
    popup: document.createElement('section'), query: '', blocked: false, position() {},
    choose(key, value) { choices.push([key, value]); },
  });
  p.renderModels();
  const list = p.popup.children.find(el => el.className === 'rp-options');
  return { p, choices, list, headings: () => list.children.filter(el => el.className === 'rp-group').map(el => el.textContent),
    options: () => list.children.filter(el => el.className === 'rp-option'),
    search(value) { const input = p.popup.children.find(el => el.className === 'rp-search'); input.value = value; input.oninput(); },
  };
}
const interleavedModels = [
  { value: 'claude-agent/deepseek-flash', label: 'DeepSeek V4.1 Flash · Claude SDK', detail: '主后端', group: 'DeepSeek' },
  { value: 'claude-agent/deepseek-pro', label: 'DeepSeek V4 Pro · Claude SDK', detail: '主后端', group: 'DeepSeek' },
  { value: 'claude-agent/kimi-code', label: 'Kimi Code · Claude SDK', group: 'Moonshot AI' },
  { value: 'claude-agent/kimi-2.6', label: 'Kimi K2.6 · Claude SDK', group: 'Moonshot AI' },
  { value: 'claude-agent/kimi-2.7', label: 'Kimi K2.7 · Claude SDK', group: 'Moonshot AI' },
  { value: 'claude-agent/kimi-highspeed', label: 'Kimi Highspeed · Claude SDK', group: 'Moonshot AI' },
  { value: 'claude-agent/kimi-3', label: 'Kimi K3 · Claude SDK', group: 'Moonshot AI' },
  { value: 'dsh-harness/deepseek-flash', label: 'DeepSeek V4.1 Flash · DSH', detail: 'DeepSeek · DSH', group: 'DeepSeek' },
  { value: 'dsh-harness/deepseek-pro', label: 'DeepSeek V4 Pro · DSH', detail: 'DeepSeek · DSH', group: 'DeepSeek', disabled: true },
];
test('model menu coalesces non-adjacent maker groups without merging runtime choices or mutating the catalog', () => {
  const before = JSON.stringify(interleavedModels), selected = 'dsh-harness/deepseek-flash';
  const f = modelListFixture(interleavedModels, { modelRef: selected });
  assert.deepEqual(f.headings(), ['DeepSeek', 'Moonshot AI']);
  assert.deepEqual(f.options().map(el => el.dataset.value), ['',
    ...interleavedModels.filter(m => m.group === 'DeepSeek').map(m => m.value),
    ...interleavedModels.filter(m => m.group === 'Moonshot AI').map(m => m.value),
  ]);
  const picked = f.options().find(el => el.attributes['aria-selected'] === 'true');
  assert.equal(picked.dataset.value, selected);
  assert.equal(picked.children[0].children[0].textContent, 'DeepSeek V4.1 Flash · DSH');
  picked.onclick();
  assert.deepEqual(f.choices, [['modelRef', selected]], 'grouping must preserve the exact runtime-qualified model ref');
  assert.equal(f.options().find(el => el.dataset.value === 'dsh-harness/deepseek-pro').disabled, true);
  assert.equal(JSON.stringify(interleavedModels), before);
});
test('model search keeps each maker together and preserves follow-agent, missing-choice and no-match states', () => {
  const f = modelListFixture(interleavedModels, { modelRef: 'missing/exact' });
  assert.equal(f.options()[0].dataset.value, '');
  assert.equal(f.options().at(-1).dataset.value, 'missing/exact');
  assert.equal(f.options().at(-1).disabled, true);
  f.search('DeepSeek');
  assert.deepEqual(f.headings(), ['DeepSeek']);
  assert.equal(f.options().length, 4);
  f.search('DSH');
  assert.deepEqual(f.headings(), ['DeepSeek']);
  assert.deepEqual(f.options().map(el => el.dataset.value), ['dsh-harness/deepseek-flash', 'dsh-harness/deepseek-pro']);
  f.search('does-not-exist');
  assert.equal(f.list.children[0].textContent, '没有匹配的模型');
  f.search('');
  assert.deepEqual(f.headings(), ['DeepSeek', 'Moonshot AI']);
  assert.equal(f.options()[0].dataset.value, '');
  assert.equal(f.options().at(-1).dataset.value, 'missing/exact');
});
test('effort follows the exact catalog, model override and real fallback, never invents provider levels', () => {
  const p = fixture(); assert.equal(p.effective().effort, 'max');
  assert.deepEqual(plain(p.effective().efforts).map(row => row.effort), ['low', 'medium', 'high', 'max']);
  p.state.models[0].defaultEffort = 'ultra'; assert.equal(p.effective().effort, 'medium');
  p.state.config.reasoningEffort = 'legacy'; assert.equal(p.effective().effort, 'legacy', 'unavailable saved setting is not silently changed');
  p.state.config = { modelRef: 'missing/exact' }; assert.equal(p.effective().efforts.length, 0);
  p.state.config = {}; p.state.models[0].efforts = []; assert.equal(p.effective().effort, '');
  assert.equal(p.effective().mode, '', 'unknown effective mode is not misrepresented as a permissive default');
});
test('picker serializes saves, preserves failures and only writes a selected field', async () => {
  const p = fixture(), saved = gate(), calls = [];
  p.onChange = (key, value) => { calls.push([key, value]); return saved.promise; };
  const task = p.choose('reasoningEffort', 'low');
  await p.choose('permissionMode', 'bypassPermissions'); assert.deepEqual(calls, [['reasoningEffort', 'low']]);
  saved.reject(new Error('offline')); await task;
  assert.equal(p.state.config.reasoningEffort, undefined); assert.equal(p.error, 'offline'); assert.equal(p.pending, false);
  p.onChange = async () => true;
  await p.choose('modelRef', 'native/exact'); assert.equal(p.view, 'effort');
});
test('locked, read-only and failed-catalog pickers reject programmatic selection', async () => {
  for (const condition of ['locked', 'readOnly', 'loadFailed', 'loading']) {
    const p = fixture(); let calls = 0; p.onChange = async () => { calls++; };
    if (condition === 'locked' || condition === 'readOnly') p.state[condition] = true; else p[condition] = true;
    await p.choose('permissionMode', 'bypassPermissions'); assert.equal(calls, 0, condition);
  }
});
test('a late failed save does not display the old session error on a new persona', async () => {
  const p = fixture(), saved = gate(); p.onChange = () => saved.promise;
  const task = p.choose('reasoningEffort', 'low');
  p.state.identity = 'aemeath:B'; p.error = ''; saved.reject(new Error('old failure')); await task;
  assert.equal(p.error, '');
});

test('switching popup views keeps one catalog request and its loading/failure lock', async () => {
  const p = fixture(), read = gate(); let reads = 0, writes = 0;
  Object.assign(p, { view: '', openSeq: 0, popup: { hidden: true }, mode: {}, model: {},
    onOpen: () => { reads++; return read.promise; }, onChange: () => { writes++; },
  });
  const opening = p.open('effort');
  await p.open('mode'); assert.equal(p.loading, true); assert.equal(reads, 1);
  await p.choose('permissionMode', 'plan'); assert.equal(writes, 0);
  read.reject(new Error('catalog unavailable')); await opening;
  assert.equal(p.view, 'mode'); assert.equal(p.loading, false); assert.equal(p.loadFailed, true);
  await p.open('effort'); assert.equal(p.error, 'catalog unavailable');
  await p.choose('reasoningEffort', 'low'); assert.equal(writes, 0);
});

const app = fs.readFileSync(path.join(root, 'web/app.js'), 'utf8');
test('wrapped bottom rail stays clear of model/effort popups, including tall model lists', () => {
  ctx.innerWidth = 390; ctx.innerHeight = 900;
  const picker = Object.create(Picker.prototype);
  const style = {};
  Object.assign(picker, { view: 'effort', host: { isConnected: true },
    anchor: { getBoundingClientRect: () => ({ top: 820, bottom: 854, right: 230 }) },
    anchorRegion: { getBoundingClientRect: () => ({ top: 778, bottom: 854 }) },
    popup: { style, getBoundingClientRect: () => ({ height: Math.min(picker.view === 'models' ? 1000 : 180, parseFloat(style.maxHeight)) }) },
  });
  for (const view of ['effort', 'models', 'mode']) {
    picker.view = view; picker.position();
    assert.ok(parseFloat(style.top) >= 8);
    assert.ok(parseFloat(style.top) + picker.popup.getBoundingClientRect().height <= 770,
      'popup is above the whole rail, not just the lower-row model button');
    assert.ok(parseFloat(style.left) >= 8);
    assert.ok(parseFloat(style.left) + parseFloat(style.width) <= 382);
  }
});
function source(name) { const match = app.match(new RegExp(`^(?:async )?function ${name}\\([^\\n]*\\) \\{[\\s\\S]*?^}`, 'm')); assert.ok(match); return match[0]; }
function sessionFixture() {
  const chat = { sessionId: 'A', agent: 'main-elaina', sessions: [{ id: 'A' }], reasoningEffort: 'high', permissionMode: 'plan', sessionListRequestSeq: 0 };
  const requests = [], controls = {};
  const context = vm.createContext({ state: { chat }, $: id => controls[id] ||= { isConnected: true },
    syncChatRunPicker() {}, syncChatControlLocks() {}, fillChatEfforts() {}, refreshSessionList: async () => {}, toast() {},
    api: (url, options) => { const request = { url, body: JSON.parse(options.body), ...gate() }; requests.push(request); return request.promise; },
  });
  vm.runInContext(['setChatRunOverride', 'setChatReasoningEffort', 'setChatPermissionMode'].map(source).join('\n'), context);
  return { context, chat, requests, controls };
}
test('Dashboard effort/mode share the save lock, exact-session PATCH and failure rollback', async () => {
  const f = sessionFixture();
  const task = f.context.setChatReasoningEffort('low');
  assert.ok(f.chat.modelSaving);
  assert.equal(await f.context.setChatPermissionMode('default'), false);
  assert.equal(f.requests.length, 1); assert.deepEqual(f.requests[0].body, { reasoningEffort: 'low' });
  f.requests[0].reject(new Error('save failed')); assert.equal(await task, false);
  assert.equal(f.chat.reasoningEffort, 'high'); assert.equal(f.chat.modelSaving, null);
  const mode = f.context.setChatPermissionMode('');
  assert.deepEqual(f.requests[1].body, { permissionMode: null });
  f.requests[1].resolve({ session: { id: 'A', permissionMode: null } }); assert.equal(await mode, true);
  assert.equal(f.chat.permissionMode, '');
});
test('Dashboard ignores late acknowledgements and rejects all non-editable run states', async () => {
  const f = sessionFixture(); const task = f.context.setChatPermissionMode('default');
  f.chat.sessionId = 'B'; f.chat.agent = 'main-aemeath'; f.chat.permissionMode = 'plan';
  f.requests[0].resolve({ session: { id: 'A', permissionMode: 'default' } }); await task;
  assert.equal(f.chat.permissionMode, 'plan');
  for (const flag of ['running', 'intakeRunning', 'switchingSession', 'switchingMode', 'coworkSaving', 'inspection', 'readOnlyMirror']) {
    f.chat[flag] = true; assert.equal(await f.context.setChatReasoningEffort('low'), false, flag); f.chat[flag] = false;
  }
  assert.equal(f.requests.length, 1);
});

test('channel mirrors restore their own model, effort and mode without changing read-only authority', () => {
  const chat = { sessions: [], model: 'mock/web', reasoningEffort: 'medium', permissionMode: 'dontAsk' };
  const controls = {
    '#chatModel': { options: [{ value: 'mock/web' }], insertAdjacentHTML(_where, html) { this.extra = html; } },
    '#chatPermMode': {},
  };
  const context = vm.createContext({ state: { chat }, window: {}, $: id => controls[id], esc: value => value,
    pinChatWindow() {},
    sessionChatMessages: session => session.messages || [], coworkBindingForSession: () => null,
    fillChatEfforts(options) { assert.equal(options.preserveSelection, true); },
    syncChatSourceMode(session) { chat.readOnlyMirror = session.channel !== 'web'; },
  });
  for (const name of ['overlaySelectedChannelRuns', 'renderChatMessages', 'renderChatPlan', 'renderChatCheckpoint',
    'renderChatGoal', 'enrichNewsReports', 'updateChatContextRing', 'updateSessionUnreadIndicators']) context[name] = () => {};
  vm.runInContext(source('applySessionDetail'), context);
  for (const channel of ['qq', 'discord']) {
    context.applySessionDetail({ id: channel, channel, modelRef: 'mock/channel', reasoningEffort: 'high', permissionMode: 'plan' });
    assert.equal(chat.model, 'mock/channel'); assert.equal(chat.reasoningEffort, 'high'); assert.equal(chat.permissionMode, 'plan');
    assert.equal(controls['#chatModel'].value, 'mock/channel'); assert.equal(controls['#chatPermMode'].value, 'plan');
    assert.equal(chat.readOnlyMirror, true);
    assert.match(controls['#chatModel'].extra, /mock\/channel/, 'missing catalog does not erase a saved choice');
    context.applySessionDetail({ id: channel, channel });
    assert.equal(chat.model, ''); assert.equal(chat.reasoningEffort, ''); assert.equal(chat.permissionMode, '');
    context.applySessionDetail({ id: 'web', channel: 'web', modelRef: 'mock/web', reasoningEffort: 'medium', permissionMode: 'dontAsk' });
    assert.equal(chat.reasoningEffort, 'medium'); assert.equal(chat.readOnlyMirror, false);
  }
});
test('packaged Electron includes the exact shared picker assets used by the orb', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'desktop/package.json'), 'utf8'));
  const resources = pkg.build.extraResources.find(row => row.from === '../web').filter;
  for (const file of ['run-picker.js', 'run-picker.css']) assert.ok(resources.includes(file));
  const html = fs.readFileSync(path.join(root, 'desktop/renderer/orb.html'), 'utf8');
  assert.match(html, /\.\.\/\.\.\/web\/run-picker\.js/); assert.match(html, /\.\.\/\.\.\/web\/run-picker\.css/);
});
