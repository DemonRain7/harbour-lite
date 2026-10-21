const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const moduleText = fs.readFileSync(path.resolve('web/chat-intake.js'), 'utf8');
const app = fs.readFileSync(path.resolve('web/app.js'), 'utf8');
test('/goal is code-parsed and the composer retains independent send/stop controls', () => {
  const context = { window: {} }; vm.createContext(context); vm.runInContext(moduleText, context);
  const parse = context.window.HarbourChatIntake.goalCommand;
  assert.equal(parse('/goal').action, 'show'); assert.equal(parse('/goal 验证两个项目').objective, '验证两个项目');
  assert.equal(parse('/goal pause').action, 'pause'); assert.equal(parse('explain /goal'), null);
  const oneShot = context.window.HarbourChatIntake.oneShotText;
  assert.equal(oneShot('/queue two\nquestions'), 'two\nquestions');
  assert.equal(oneShot('/steer /stop'), '/stop');
  assert.equal(oneShot('/queue'), null); assert.equal(oneShot('/queue', true), '');
  assert.equal(oneShot('tell me about /queue'), null);
  assert.match(moduleText, /仅这条：输入 \/steer 正文 或 \/queue 正文/);
  assert.match(app, /mode: request.mode/, 'an uncertain-send retry keeps its original mode');
  assert.match(app, /id="chatStop"/); assert.match(app, /id="chatSend"/); assert.doesNotMatch(app, /id="chatGoal(?:Btn)?"/);
  assert.match(app, /clientMessageId/); assert.match(moduleText, /id !== session\(\)/);
  assert.match(moduleText, /if \(!id\)[\s\S]*?setTimeout\(sync, 1800\)/, 'poll starts after the first session is created');
});

test('message status distinguishes execution from reply delivery', () => {
  const statusSource = moduleText.match(/  function recordStatus\(record\) \{[\s\S]*?\n  }/)?.[0];
  assert.ok(statusSource);
  const context = { labels: { collecting: '收集中', waiting: '等待处理', sending: '正在投递', accepted: '已送达当前运行', running: '处理中' } };
  vm.createContext(context); vm.runInContext(statusSource, context);
  for (const state of ['collecting', 'waiting']) assert.equal(context.recordStatus({ state }).group, '等待');
  for (const state of ['sending', 'accepted', 'running']) assert.equal(context.recordStatus({ state }).group, '处理中');
  assert.equal(context.recordStatus({ state: 'paused' }).group, '已暂停');
  assert.equal(context.recordStatus({ state: 'unknown' }).group, '待核对');
  assert.equal(context.recordStatus({ state: 'completed', delivery: 'pending' }).group, '待发送');
  assert.equal(context.recordStatus({ state: 'completed', delivery: 'sending' }).group, '发送中');
  const unknownReply = context.recordStatus({ state: 'completed', delivery: 'unknown' });
  assert.equal(unknownReply.group, '待核对');
  assert.match(unknownReply.label, /答复送达/);
});

test('withdrawn drafts preserve mode, multiline text, literal commands and all attachments', () => {
  const context = { window: {} }; vm.createContext(context); vm.runInContext(moduleText, context);
  const draft = context.window.HarbourChatIntake.queuedDraft({ mode: 'queue', messages: [
    { input: '/stop\nDo not lose this text', attachments: [{ kind: 'image', url: '/uploads/a.png', name: 'a.png' }] },
    { input: 'Second message', attachments: [{ kind: 'file', url: '/uploads/b.pdf', name: 'b.pdf' }] },
  ] });
  assert.equal(draft.text, '/queue /stop\nDo not lose this text\n\nSecond message');
  assert.equal(draft.attachments.length, 2);
  assert.equal(context.window.HarbourChatIntake.queuedDraft({ mode: 'steer', messages: [{ input: '', attachments: [{ kind: 'image' }] }] }).text, '/steer');
});

test('actual Main Chat draft handoff preserves occupied drafts and pins a late response to its original session', () => {
  const source = ['canEditQueuedMessage', 'restoreQueuedMessage'].map(name => app.match(new RegExp(`function ${name}\\([^]*?\\n\\}`))?.[0]).join('\n');
  const input = { value: '', dispatchEvent() {}, focus() {} };
  const state = { chat: { sessionId: 'A', attachments: [], drafts: new Map() } };
  const context = { state, $: selector => selector === '#chatInput' ? input : null, toast() {}, chatDraftBusy: () => false,
    renderChatAttachments() {}, renderChatGoal() {}, Event: class {} };
  vm.createContext(context); vm.runInContext(source, context);
  const draft = { text: '/queue restored', attachments: [{ kind: 'image', url: '/uploads/a.png' }] };
  assert.equal(context.canEditQueuedMessage('A'), true);
  input.value = 'existing draft'; assert.equal(context.canEditQueuedMessage('A'), false);
  assert.equal(context.restoreQueuedMessage(draft, 'A'), false); assert.equal(input.value, 'existing draft');
  state.chat.sessionId = 'B';
  assert.equal(context.restoreQueuedMessage(draft, 'A'), true); assert.equal(input.value, 'existing draft');
  assert.equal(state.chat.drafts.get('A').text, draft.text); assert.equal(state.chat.drafts.get('A').goalArmed, false);
  state.chat.sessionId = 'A'; input.value = ''; state.chat.inputSending = true;
  assert.equal(context.restoreQueuedMessage(draft, 'A'), false);
  state.chat.inputSending = false; state.chat.inputRequest = { id: 'unconfirmed' };
  assert.equal(context.restoreQueuedMessage(draft, 'A'), false);
  state.chat.inputRequest = null;
  assert.equal(context.restoreQueuedMessage(draft, 'A'), true);
  assert.equal(input.value, draft.text); assert.equal(state.chat.attachments[0].name, undefined);
  assert.equal(state.chat.attachments[0].url, '/uploads/a.png');
});
