const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { JSDOM } = createRequire(path.resolve(__dirname, '../../vendor/folia/package.json'))('jsdom');
const source = fs.readFileSync(path.resolve(__dirname, '../../web/chat-unread.js'), 'utf8');
const settle = () => new Promise(resolve => setImmediate(resolve));
const snapshot = (replyRevision = 1, readReplyRevision = 0) => ({ id: 'A', key: 'web:test', replyRevision, readReplyRevision });

function fixture() {
  const dom = new JSDOM('<div id="stream"><div class="chat-msg assistant">reply</div></div>', {
    url: 'https://harbour.test', runScripts: 'outside-only', pretendToBeVisual: true,
  });
  const w = dom.window, stream = w.document.getElementById('stream'), frames = new Map(), requests = [];
  let hidden = false, focused = true, bounds = { top: 100, bottom: 200, height: 100 }, value = snapshot(), serial = 0, changes = 0;
  Object.defineProperty(w.document, 'hidden', { get: () => hidden });
  w.document.hasFocus = () => focused;
  stream.getClientRects = () => [{ top: 0 }];
  stream.getBoundingClientRect = () => ({ top: 0, bottom: 500 });
  stream.querySelector('.assistant').getBoundingClientRect = () => bounds;
  w.requestAnimationFrame = fn => { frames.set(++serial, fn); return serial; };
  w.cancelAnimationFrame = id => frames.delete(id);
  w.eval(source);
  const options = { current: () => value, onChange: () => changes++, api: (url, args) => new Promise((resolve, reject) => {
    requests.push({ url, body: JSON.parse(args.body), resolve, reject });
  }) };
  let dispose = w.HarbourChatUnread.mount(stream, options);
  return { w, stream, requests, module: w.HarbourChatUnread, get changes() { return changes; },
    current: next => { value = next; }, hidden: next => { hidden = next; }, focused: next => { focused = next; }, bounds: next => { bounds = next; },
    async tick() { await settle(); const batch = [...frames.values()]; frames.clear(); batch.forEach(fn => fn()); await settle(); },
    scroll() { stream.dispatchEvent(new w.Event('scroll')); },
    remount() { dispose(); dispose = w.HarbourChatUnread.mount(stream, options); },
    unmount() { dispose(); }, close() { dispose(); w.close(); },
  };
}

test('revision, not activity/title/message count, drives unread; stale snapshots cannot undo receipts', () => {
  const f = fixture();
  try {
    assert.equal(f.module.hasUnread({ id: 'legacy', messageCount: 100, updatedAt: '2099' }), false);
    assert.equal(f.module.hasUnread(snapshot()), true);
    f.module.observe(snapshot(1, 1));
    assert.equal(f.module.hasUnread({ ...snapshot(), title: 'renamed', messageCount: 99 }), false);
    assert.equal(f.module.hasUnread(snapshot(2, 1)), true);
    f.module.observe(snapshot(1, 1));
    assert.equal(f.module.hasUnread({ id: 'A' }), true);
    assert.equal(f.module.hasUnread({ id: 'B', replyRevision: 0, readReplyRevision: 0 }), false);
  } finally { f.close(); }
});

test('viewing the latest real reply acknowledges exactly once, without a run or optimistic clear', async () => {
  const f = fixture();
  try {
    await f.tick();
    assert.equal(f.requests.length, 1);
    assert.equal(f.requests[0].url, '/api/conversations/A/read');
    assert.deepEqual(f.requests[0].body, { key: 'web:test', replyRevision: 1 });
    assert.equal(f.module.hasUnread(snapshot()), true);
    f.requests[0].resolve(snapshot(1, 1)); await f.tick();
    assert.equal(f.module.hasUnread(snapshot()), false);
    f.scroll(); await f.tick(); assert.equal(f.requests.length, 1);
    assert.equal(f.changes, 1);
  } finally { f.close(); }
});

for (const mode of ['hidden', 'unfocused', 'history', 'loading', 'pending', 'offpage']) {
  test(`${mode} must not silently consume a new reply`, async () => {
    const f = fixture();
    try {
      if (mode === 'hidden') f.hidden(true);
      if (mode === 'unfocused') f.focused(false);
      if (mode === 'history') f.bounds({ top: 900, bottom: 1000, height: 100 });
      if (mode === 'loading') f.current(null);
      if (mode === 'pending') f.stream.querySelector('.assistant').classList.add('pending');
      if (mode === 'offpage') f.stream.remove();
      await f.tick(); assert.equal(f.requests.length, 0);
      assert.equal(f.module.hasUnread(snapshot()), true);
      if (mode === 'hidden') { f.hidden(false); f.w.document.dispatchEvent(new f.w.Event('visibilitychange')); await f.tick(); assert.equal(f.requests.length, 1); }
      if (mode === 'unfocused') { f.focused(true); f.w.dispatchEvent(new f.w.Event('focus')); await f.tick(); assert.equal(f.requests.length, 1); }
    } finally { f.close(); }
  });
}

test('late acknowledgement of rendered revision cannot clear a newer, unseen reply', async () => {
  const f = fixture();
  try {
    await f.tick(); f.module.observe(snapshot(2));
    f.requests[0].resolve(snapshot(2, 1)); await f.tick();
    assert.equal(f.module.hasUnread(snapshot()), true);
    assert.equal(f.requests.length, 1, 'a refreshed sidebar alone is not a rendered new reply');
    f.current(snapshot(2, 1)); f.stream.querySelector('.assistant').textContent = 'new reply'; await f.tick();
    assert.equal(f.requests[1].body.replyRevision, 2);
    f.requests[1].resolve(snapshot(2, 2)); await f.tick();
    assert.equal(f.module.hasUnread(snapshot(2, 1)), false);
  } finally { f.close(); }
});

test('navigation during an acknowledgement wakes the replacement view and preserves the new reply', async () => {
  const f = fixture();
  try {
    await f.tick(); f.current(snapshot(2)); f.remount(); await f.tick();
    assert.equal(f.requests.length, 1);
    f.requests[0].resolve(snapshot(2, 1)); await f.tick();
    assert.equal(f.changes, 1);
    assert.equal(f.requests.length, 2);
    assert.equal(f.requests[1].body.replyRevision, 2);
    f.requests[1].resolve(snapshot(2, 2)); await f.tick();
    f.unmount(); f.scroll(); f.w.dispatchEvent(new f.w.Event('focus')); await f.tick();
    assert.equal(f.requests.length, 2);
  } finally { f.close(); }
});

for (const invalid of [false, true]) test(`${invalid ? 'malformed' : 'failed'} read receipt stays unread with no retry loop`, async () => {
  const f = fixture();
  try {
    await f.tick();
    if (invalid) f.requests[0].resolve({ id: 'A', readReplyRevision: 1 }); else f.requests[0].reject(new Error('offline'));
    await f.tick(); f.scroll(); await f.tick();
    assert.equal(f.module.hasUnread(snapshot()), true);
    assert.equal(f.requests.length, 1);
    assert.equal(f.changes, 0);
  } finally { f.close(); }
});
