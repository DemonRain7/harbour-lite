const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const app = fs.readFileSync(path.resolve(__dirname, '../../web/app.js'), 'utf8');
const source = name => app.match(new RegExp(`^(?:async )?function ${name}\\([^\\n]*\\) \\{[\\s\\S]*?^}`, 'm'))[0];
function fixture(hash = '#chat') {
  const calls = [], opened = [], notices = [];
  const chat = { agent: 'main-elaina', mode: 'main', agents: [{ name: 'main-elaina' }, { name: 'main-aemeath' }],
    sessionId: null, sessions: [{ id: 'session-A', agentName: 'main-elaina', key: 'web:default:main-elaina', channel: 'web' }],
    drafts: new Map(), attachments: [], messages: [] };
  const location = new URL('http://localhost:7788/?token=do-not-copy' + hash);
  const ctx = vm.createContext({ state: { chat }, location, URL, URLSearchParams, DEFAULT_PERSONA: 'main-elaina',
    history: { state: null, replaceState(_state, _title, url) { location.href = url; } },
    window: { open: (...args) => opened.push(args) }, toast: text => notices.push(text),
    saveChatDraft() {}, applyPersonaVisuals() {}, chatDraftBusy: () => false, coworkBindingForSession: () => ({ deviceId: 'server' }),
    api: async (url, options) => { calls.push({ url, options }); return { session: chat.sessions.find(item => url.endsWith(item.id)) }; },
  });
  vm.runInContext(['chatWindowTarget', 'chatWindowUrl', 'openChatWindow', 'pinChatWindow', 'prepareChatWindow', 'newChatSession'].map(source).join('\n'), ctx);
  return { ctx, chat, location, calls, opened, notices };
}

test('new window remains a blank composer; opening never creates a session or calls a model', async () => {
  const f = fixture('#chat?new=1&agent=main-aemeath&mode=cowork');
  await f.ctx.prepareChatWindow();
  assert.equal(f.chat.agent, 'main-aemeath'); assert.equal(f.chat.mode, 'cowork');
  assert.equal(f.chat.landing, true); assert.equal(f.chat.sessionId, null); assert.equal(f.calls.length, 0);
});

test('busy New and explicit window actions do not replace the original run or copy its draft', async () => {
  const f = fixture();
  Object.assign(f.chat, { running: true, activeRunId: 'run-A', sessionId: 'session-A', attachments: [{ name: 'private.png' }], messages: [{ content: 'unsent private text' }] });
  const before = JSON.stringify(f.chat);
  await f.ctx.newChatSession();
  f.ctx.openChatWindow('session-A');
  assert.equal(f.opened.length, 2);
  assert.match(f.opened[0][0], /#chat\?new=1/);
  assert.match(f.opened[1][0], /session=session-A/);
  assert.equal(f.opened[0][1], '_blank'); assert.equal(f.opened[0][2], 'noopener');
  assert.doesNotMatch(f.opened.flat().join(' '), /do-not-copy|private/);
  assert.equal(JSON.stringify(f.chat), before); assert.equal(f.calls.length, 0);
});

test('each reloaded window keeps its own exact session without switching server active state', async () => {
  for (const id of ['A', 'B']) {
    const f = fixture(`#chat?session=session-${id}&agent=main-elaina`);
    f.chat.sessions.push({ id: 'session-B', key: 'web:default:main-elaina', agentName: 'main-elaina', channel: 'web', active: true });
    await f.ctx.prepareChatWindow();
    assert.equal(f.chat.sessionId, `session-${id}`);
    assert.equal(f.calls.length, 1); assert.equal(f.calls[0].options, undefined);
    assert.equal(f.chat.selectedSessionKey, 'web:default:main-elaina');
    f.ctx.pinChatWindow(); assert.equal(f.location.search, '');
    assert.match(f.location.hash, new RegExp(`session=session-${id}`));
  }
});

test('persisted identity is restored, including Cowork and non-Web mirror, not guessed from URL mode', async () => {
  for (const key of ['web:cowork:main-elaina', 'qq:fixture']) {
    const f = fixture('#chat?session=session-A&agent=main-elaina&mode=main');
    f.chat.sessions[0].key = key;
    await f.ctx.prepareChatWindow();
    assert.equal(f.chat.selectedSessionKey, key);
    assert.equal(f.chat.mode, key.startsWith('web:cowork') ? 'cowork' : 'main');
  }
});

test('missing/mismatched/invalid deep links cannot silently load an unrelated active conversation', async () => {
  for (const hash of ['#chat?session=missing', '#chat?session=session-A&agent=main-aemeath', '#chat?new=1&session=session-A',
    '#chat?session=..%2Fsecret', '#chat?new=2', '#chat?session=session-A&session=second', '#chat?new=1&input=execute']) {
    const f = fixture(hash);
    await assert.rejects(f.ctx.prepareChatWindow()); assert.equal(f.chat.sessionId, null);
  }
});

test('route preparation never replaces an in-flight task or read-only inspection', async () => {
  for (const field of ['running', 'inspection']) {
    const f = fixture('#chat?session=session-A'); f.chat[field] = true; f.chat.sessionId = 'retained';
    await f.ctx.prepareChatWindow(); assert.equal(f.chat.sessionId, 'retained'); assert.equal(f.calls.length, 0);
  }
});

test('late or partial explorer snapshots never replace a pinned conversation with another window active session', async () => {
  const f = fixture('#chat?session=session-A');
  Object.assign(f.chat, { sessionId: 'session-A', sessionListRequestSeq: 0 });
  const loaded = [];
  Object.assign(f.ctx, { $: () => ({}), chatSessionsForMode: list => list, currentSessionKey: () => 'web:default:main-elaina',
    loadConversationMessages: async id => loaded.push(id), viewedChatSessionId: () => f.chat.sessionId,
    api: async () => ({ sessions: [{ id: 'session-B', key: 'web:default:main-elaina', active: true }] }),
    ...Object.fromEntries(['renderChatSourceTabs', 'renderSessionList', 'renderChatCheckpoint', 'renderChatGoal'].map(key => [key, () => {}])) });
  vm.runInContext(['loadChatSessions', 'refreshSessionList'].map(source).join('\n'), f.ctx);
  await f.ctx.loadChatSessions(); await f.ctx.refreshSessionList();
  assert.equal(f.chat.sessionId, 'session-A'); assert.deepEqual(loaded, ['session-A']);
});
