const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { JSDOM } = createRequire(path.resolve(__dirname, '../../vendor/folia/package.json'))('jsdom');

function fixture() {
  const dom = new JSDOM('<main id="content"><div id="music"><button id="trigger">Music</button><section id="panel"><button data-chat-tool-close>Close</button></section></div><details><summary>Appearance</summary><section id="appearance"><input></section></details><button id="outside">Chat</button></main>', {
    runScripts: 'outside-only', pretendToBeVisual: true,
  });
  const w = dom.window, d = w.document;
  w.eval(fs.readFileSync(path.resolve(__dirname, '../../web/chat-tools.js'), 'utf8'));
  const panel = d.querySelector('#panel'), trigger = d.querySelector('#trigger');
  const music = w.HarbourChatTools.popover({ trigger, panel });
  const appearance = w.HarbourChatTools.popover({ details: d.querySelector('details'), trigger: d.querySelector('summary'), panel: d.querySelector('#appearance') });
  return { w, d, panel, trigger, music, appearance, close() { music.destroy(); appearance.destroy(); dom.window.close(); } };
}

test('utility panels are mutually exclusive; outside pointer and focus dismiss without stealing focus', () => {
  const f = fixture();
  try {
    f.trigger.click(); assert.equal(f.panel.hidden, false);
    f.appearance.setOpen(true);
    assert.equal(f.panel.hidden, true);
    assert.equal(f.d.querySelector('details').open, true);
    assert.equal(f.d.querySelector('summary').getAttribute('aria-expanded'), 'true');
    f.d.querySelector('#appearance input').focus();
    assert.equal(f.d.querySelector('#appearance').hidden, false);
    f.d.querySelector('#outside').focus();
    assert.equal(f.d.querySelector('#appearance').hidden, true);
    assert.equal(f.d.activeElement.id, 'outside');
    f.trigger.click();
    f.d.querySelector('#outside').dispatchEvent(new f.w.Event('pointerdown', { bubbles: true }));
    assert.equal(f.panel.hidden, true);
  } finally { f.close(); }
});

test('close button and Escape return keyboard focus; remount cleanup prevents stale handlers', () => {
  const f = fixture();
  try {
    f.music.setOpen(true);
    f.panel.querySelector('button').click();
    assert.equal(f.panel.hidden, true); assert.equal(f.d.activeElement, f.trigger);
    f.trigger.click(); f.panel.querySelector('button').focus();
    const escape = new f.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    f.d.dispatchEvent(escape);
    assert.equal(escape.defaultPrevented, true); assert.equal(f.d.activeElement, f.trigger);
    f.music.destroy(); f.trigger.click();
    assert.equal(f.panel.hidden, true);
  } finally { f.close(); }
});

test('popup geometry stays in viewport and flips when the rail moves above the conversation', () => {
  const f = fixture();
  try {
    Object.defineProperties(f.w, { innerWidth: { value: 390 }, innerHeight: { value: 700 } });
    Object.defineProperties(f.panel, { offsetWidth: { value: 354 }, offsetHeight: { value: 300 }, scrollHeight: { value: 300 } });
    let anchor = { left: 320, top: 630, bottom: 664 };
    f.trigger.getBoundingClientRect = () => anchor;
    f.music.setOpen(true);
    assert.equal(f.panel.style.left, '24px'); assert.equal(f.panel.style.top, '322px');
    assert.equal(f.panel.dataset.side, 'above');
    anchor = { left: 20, top: 140, bottom: 174 };
    f.w.dispatchEvent(new f.w.Event('resize'));
    assert.equal(f.panel.style.left, '20px'); assert.equal(f.panel.style.top, '182px');
    assert.equal(f.panel.dataset.side, 'below');
  } finally { f.close(); }
});
