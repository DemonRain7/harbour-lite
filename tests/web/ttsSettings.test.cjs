const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../../web/app.js'), 'utf8');
const render = source.match(/^function renderTtsSettings\(pane, payload\) \{[\s\S]*?^}/m)?.[0];
assert.ok(render);

function fixture() {
  const nodes = new Map(), saves = [], previews = [];
  let html = '';
  const pane = {
    set innerHTML(value) {
      html = value;
      for (const match of value.matchAll(/<[^>]+\bid="([^"]+)"[^>]*>/g)) {
        const tag = match[0]; const listeners = new Map();
        nodes.set('#' + match[1], { value: tag.match(/\bvalue="([^"]*)"/)?.[1] || '', checked: /\schecked(?:\s|>)/.test(tag),
          disabled: false, textContent: '', addEventListener: (type, cb) => listeners.set(type, cb), click: () => listeners.get('click')?.() });
      }
      nodes.set('#settingsPane', {});
    },
    get innerHTML() { return html; },
    querySelectorAll: () => [],
  };
  const context = vm.createContext({
    console, pane, esc: value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('"', '&quot;'),
    $: selector => { assert.ok(nodes.has(selector), `missing node ${selector}`); return nodes.get(selector); },
    api: async (url, options) => { saves.push({ url, body: JSON.parse(options.body) }); return {}; },
    fetch: async (url, options) => { previews.push({ url, body: JSON.parse(options.body), headers: options.headers });
      return { ok: true, blob: async () => ({}), headers: { get: key => key.includes('provider') ? 'tencent-cloud' : 'miss' } }; },
    toast() {}, renderSettingsVoice() {}, authToken: () => 'fixture-auth', promptLogin() {},
    URL: { createObjectURL: () => 'blob:fixture', revokeObjectURL() {} },
    Audio: class { pause() {} addEventListener() {} async play() {} },
  });
  vm.runInContext(`let ttsPreviewAudio = null, ttsPreviewUrl = ''; ${render}`, context);
  context.renderTtsSettings(pane, {
    config: { enabled: true, provider: 'custom-json', format: 'json', url: '', profiles: { default: { voice: 'original-default' }, hidden: { voice: 'keep-this' } },
      tencentFallback: { enabled: true, credentialsConfigured: true, secretId: 'MUST-NOT-ECHO-ID', secretKey: 'MUST-NOT-ECHO-KEY' } },
    status: { configured: true, provider: 'tencent-cloud' }, characters: [],
    providers: [{ id: 'custom-json', format: 'json', label: 'Custom', defaultExt: 'wav' }],
  });
  return { pane, nodes, saves, previews };
}

test('Tencent fallback renders password fields without echo or browser storage and keeps primary optional', () => {
  const f = fixture();
  assert.doesNotMatch(f.pane.innerHTML, /MUST-NOT-ECHO/);
  assert.match(f.pane.innerHTML, /主 Provider（可选/);
  assert.match(f.pane.innerHTML, /101001/);
  for (const id of ['ttsTencentId', 'ttsTencentKey']) assert.match(f.pane.innerHTML, new RegExp(`id="${id}" type="password" autocomplete="new-password"`));
  assert.doesNotMatch(render, /localStorage|sessionStorage/);
  assert.equal(f.nodes.get('#ttsTencentEnabled').checked, true);
  assert.equal(f.saves.length, 0); assert.equal(f.previews.length, 0);
});

test('save sends credentials once to backend, clears fields and preserves undisplayed profiles', async () => {
  const f = fixture();
  f.nodes.get('#ttsTencentId').value = 'NEW-ID'; f.nodes.get('#ttsTencentKey').value = 'NEW-KEY';
  await f.nodes.get('#ttsSave').click();
  assert.equal(f.saves.length, 1); assert.equal(f.saves[0].url, '/api/tts/config');
  assert.deepEqual(f.saves[0].body.tencentFallback, { enabled: true, secretId: 'NEW-ID', secretKey: 'NEW-KEY', clearCredentials: false });
  assert.deepEqual(f.saves[0].body.profiles, { default: { voice: 'original-default' }, hidden: { voice: 'keep-this' } });
  assert.equal(f.saves[0].body.provider, 'custom-json'); assert.equal(f.saves[0].body.url, '');
  assert.equal(f.nodes.get('#ttsTencentId').value, ''); assert.equal(f.nodes.get('#ttsTencentKey').value, '');
});

test('preview buttons use explicit targets and never transmit unsaved API keys', async () => {
  const f = fixture();
  f.nodes.get('#ttsTencentId').value = 'UNSAVED-ID'; f.nodes.get('#ttsTencentKey').value = 'UNSAVED-KEY';
  f.nodes.get('#ttsTestCompanion').value = 'aemeath';
  await f.nodes.get('#ttsTencentTest').click(); await f.nodes.get('#ttsTest').click();
  assert.deepEqual(f.previews.map(p => p.body.target), ['tencent-fallback', 'gateway']);
  assert.ok(f.previews.every(p => p.body.companionId === 'aemeath'));
  assert.doesNotMatch(JSON.stringify(f.previews), /UNSAVED/);
  assert.equal(f.nodes.get('#ttsTencentTest').disabled, false);
  assert.match(f.nodes.get('#ttsActionStatus').textContent, /tencent-cloud/);
});
