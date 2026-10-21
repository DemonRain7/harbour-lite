// Pure rendering/filter regression. No browser, model calls or user session writes.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '../..');
const app = fs.readFileSync(path.join(root, 'web/app.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'web/chat-sessions.css'), 'utf8');
function source(name) {
  const value = app.match(new RegExp(`^(?:async )?function ${name}\\([^\\n]*\\) \\{[\\s\\S]*?^}`, 'm'));
  assert.ok(value, name); return value[0];
}
const ctx = vm.createContext({
  esc: s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])),
  formatDate: s => `absolute:${s}`, timeAgo: s => `relative:${s}`,
});
vm.runInContext(app.slice(app.indexOf('const SESSION_SOURCE_FILTERS'), app.indexOf('function userRoleLabel'))
  + ['sourceFilterOptions', 'sourceFilterMark', 'sourceFilterHtml', 'chatSessionRowHtml'].map(source).join('\n'), ctx);
const sample = (id, channel, key) => ({ id, channel, key, title: `Title ${id}`, messageCount: 8, createdAt: '2026-09-01',
  lastMessageAt: '2026-09-29', updatedAt: '2099-12-31', source: { app: channel, accountLabel: 'Harbour', locationLabel: channel === 'web' ? 'Main Chat' : '测试频道' } });
const sessions = [sample('main', 'web', 'web:default:main-elaina'), sample('town', 'web', 'web:town:main-elaina'),
  sample('work', 'web', 'web:cowork:main-elaina'), sample('qq', 'qq', 'qq:fixture'), sample('dc', 'discord', 'discord:fixture'),
  sample('scheduled', 'cron', 'cron:fixture'), sample('unknown', 'future', 'future:fixture')];
const before = JSON.stringify(sessions);
assert.equal(ctx.sessionApp(sessions[1]), 'web', 'presentation must not change the underlying channel');
assert.equal(ctx.sessionSourceKind(sessions[1]), 'town');
assert.equal(ctx.sourceWhere(sessions[1]), 'Harbour 小镇', 'override legacy Main Chat display for known Town keys');
assert.equal(ctx.sessionSourceKind({ ...sessions[3], key: 'web:town:forged', title: '小镇' }), 'qq');
assert.equal(ctx.sessionSourceKind({ ...sessions[0], title: '小镇' }), 'web', 'never classify by title');
assert.equal(ctx.sessionSourceKind({ channel: 'web', key: 'web:townhouse:main-elaina' }), 'web');
assert.equal(ctx.sourceBadgeText(sessions[1]), '小镇');
for (const [filter, expected] of [['web', 'main'], ['town', 'town'], ['cowork', 'work'], ['qq', 'qq'], ['discord', 'dc'], ['cron', 'scheduled']]) {
  assert.equal(ctx.sessionsInFilter(sessions, filter).map(s => s.id).join(','), expected);
}
assert.equal(ctx.sessionsInFilter(sessions, 'all').length, sessions.length);
assert.equal(JSON.stringify(sessions), before);
const options = Array.from(ctx.sourceFilterOptions(sessions, 'wecom'), value => ({ ...value }));
assert.equal(options.find(o => o.id === 'web').count, 1);
assert.equal(options.find(o => o.id === 'town').count, 1);
assert.equal(options.find(o => o.id === 'wecom').count, 0, 'empty active filter stays accessible');
assert.equal(options.find(o => o.id === 'future').count, 1);
assert.match(ctx.sourceFilterHtml(sessions, 'town'), /data-source-filter="town"/);
assert.match(ctx.sourceFilterHtml(sessions, 'town'), /source-town">小镇/);
assert.equal(ctx.sourceFilterOptions([], 'all').length, 1);

const row = ctx.chatSessionRowHtml({ ...sessions[1], title: '<script>long title & "quote"…', compactions: 2 }, true, true);
assert.match(row, /<button type="button" class="cs-main"/);
assert.match(row, /aria-current="true"/);
assert.match(row, /data-session-actions="town"/);
assert.match(row, /aria-haspopup="menu" aria-expanded="false"/);
assert.doesNotMatch(row, /data-session-delete/, 'destructive action is tucked inside a menu');
assert.match(row, /source-town/);
assert.match(row, /cs-state-running/);
assert.match(row, /cs-title is-shortened"><span>&lt;script&gt;long title &amp; &quot;quote&quot;<\/span>/);
assert.match(row, /value="&lt;script&gt;long title &amp; &quot;quote&quot;…"/, 'rename keeps exact original title');
assert.match(row, /8 条消息 · 2 次压缩/);
assert.match(row, /absolute:2026-09-29/);
assert.doesNotMatch(row, /2099-12-31|<script>|cs-meta|cs-location|class="cs-source"/);
assert.match(ctx.chatSessionRowHtml({ ...sessions[3], readOnlyMirror: true, checkpoint: { status: 'interrupted' } }, false, false), /cs-state-interrupted/);
assert.match(ctx.chatSessionRowHtml({ ...sessions[0], goal: { status: 'paused' } }, false, false), /cs-state-goal/);
assert.doesNotMatch(ctx.chatSessionRowHtml(sessions[0], false, false), /cs-state|aria-current/);
const unread = ctx.chatSessionRowHtml(sessions[2], false, true, true);
assert.match(unread, /has-unread/);
assert.match(unread, /cs-unread/);
assert.match(unread, /cs-state-running/, 'running and unread are separate states');
assert.match(unread, /有新回复未读/);
assert.doesNotMatch(ctx.chatSessionRowHtml(sessions[2], false, true, false), /cs-unread|有新回复未读/);
assert.match(css, /background:\s*#38aa78/);
assert.match(css, /mask-image: linear-gradient/);
assert.match(css, /text-overflow: clip/);
assert.doesNotMatch(css, /text-overflow:\s*ellipsis/);
assert.match(css, /focus-visible/);
assert.match(css, /hover: none/);
assert.match(source('renderSessionList'), /box\.scrollTop = scrollTop/, 'refresh must retain rail scroll');
assert.match(source('renderSessionList'), /switchChatSession\(b\.dataset\.sessionSwitch\)/, 'same switching/execution boundary');
assert.match(source('switchChatMode'), /mode === "cowork" \? "cowork" : "all"/);
assert.match(source('newChatSession'), /mode === "cowork" \? "cowork" : "web"/);
console.log('session rail passed: source identity, Town/Web split, filters, safe one-line markup, original title, activity time, statuses, keyboard and Cowork');
