const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync(require('node:path').join(__dirname, '../../web/voice-picker.js'), 'utf8');
function fixture() {
  class Element {
    constructor(tag) { this.tag = tag; this.children = []; this.style = {}; this.dataset = {}; this.attrs = {}; }
    setAttribute(key, val) { this.attrs[key] = val; }
    append(...children) { this.children.push(...children); children.forEach(child => { child.parent = this; }); }
    replaceChildren(...children) { this.children = []; this.append(...children); }
    get firstChild() { return this.children[0]; }
    remove() { if (this.parent) this.parent.children = this.parent.children.filter(c => c !== this); }
    contains(child) { return this === child || this.children.some(c => c.contains(child)); }
    focus() { this.focused = true; }
    getBoundingClientRect() { return { left: 300, right: 334, top: 640, bottom: 674, width: 340, height: this.tag === 'section' ? 540 : 34 }; }
    querySelector(selector) { return this.flatten().find(c => selector === '[aria-pressed="true"]' && c.attrs['aria-pressed'] === 'true'); }
    flatten() { return this.children.flatMap(c => [c, ...c.flatten()]); }
  }
  const listeners = new Map();
  const add = (key, fn) => { listeners.set(key, fn); }, remove = (key, fn) => { if (listeners.get(key) === fn) listeners.delete(key); };
  const document = { createElement: tag => new Element(tag), body: new Element('body'), addEventListener: add, removeEventListener: remove };
  const window = { addEventListener: add, removeEventListener: remove };
  let audioCreated = 0;
  const ctx = vm.createContext({ window, document, innerWidth: 900, innerHeight: 700, AbortController, Blob, Uint8Array, atob,
    URL: { createObjectURL: () => { audioCreated++; return 'blob:test'; }, revokeObjectURL() {} }, Audio: class { pause() {} async play() {} } });
  vm.runInContext(source, ctx);
  const catalogue = { selections: {}, voices: [
    { id: 'auto', label: '默认', group: '默认', available: true },
    { id: 'tencent:101001', label: '智瑜', group: '腾讯 · 精品', available: true },
    { id: 'custom:aemeath', label: 'Aemeath', group: '自定义', available: false },
  ] };
  const calls = []; let persona = 'elaina';
  const picker = new window.HarbourVoicePicker({ host: new Element('div'), getCompanionId: () => persona,
    request: async (action, body) => { calls.push({ action, body }); if (action === 'select') catalogue.selections[body.companionId] = body.voiceId; return catalogue; } });
  return { picker, catalogue, calls, document, listeners, audioCreated: () => audioCreated, persona: value => { persona = value; } };
}
test('picker is lazy, never auto auditions, exposes disabled future voices and shares explicit selection', async () => {
  const f = fixture(); assert.equal(f.calls.length, 0);
  await f.picker.open(); assert.deepEqual(f.calls.map(c => c.action), ['list']);
  const future = f.picker.popup.flatten().find(n => n.dataset.voiceId === 'custom:aemeath'); assert.equal(future.disabled, true);
  await f.picker.select('tencent:101001');
  assert.equal(f.calls[1].body.companionId, 'elaina'); assert.equal(f.catalogue.selections.elaina, 'tencent:101001');
  assert.match(f.picker.button.title, /智瑜/);
  f.picker.close(); await f.picker.open(); assert.deepEqual(f.calls.map(c => c.action), ['list','select','list']);
  f.picker.destroy(); assert.equal(f.listeners.size, 0); assert.equal(f.document.body.children.length, 0);
  assert.doesNotMatch(source, /setInterval|localStorage|sessionStorage/);
});
test('switching persona discards an old catalogue and closing aborts pending preview without later audio', async () => {
  const f = fixture(); let release;
  f.picker.request = () => new Promise(resolve => { release = resolve; });
  const opening = f.picker.open(); f.persona('aemeath'); f.picker.sync(); release(f.catalogue); await opening;
  assert.equal(f.picker.popup, null); assert.equal(f.picker.companionId, 'aemeath');
  f.picker.request = async () => f.catalogue; await f.picker.open();
  let signal;
  f.picker.request = (_action, _body, passedSignal) => { signal = passedSignal; return new Promise(resolve => { release = resolve; }); };
  const preview = f.picker.preview('tencent:101001'); f.picker.close();
  assert.equal(signal.aborted, true); release(new Blob(['audio'])); await preview;
  assert.equal(f.audioCreated(), 0); f.picker.destroy();
});
test('failed save remains unsaved and preview failure is surfaced, not substituted', async () => {
  const f = fixture(); await f.picker.open();
  f.picker.request = async () => { throw new Error('fixture unavailable'); };
  await f.picker.select('tencent:101001'); assert.match(f.picker.status.textContent, /保存失败/); assert.deepEqual(f.catalogue.selections, {});
  await f.picker.preview('tencent:101001'); assert.match(f.picker.status.textContent, /试听失败/); assert.equal(f.audioCreated(), 0);
  f.picker.destroy();
});
