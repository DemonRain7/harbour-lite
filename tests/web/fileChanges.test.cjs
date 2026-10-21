// Real dashboard functions in a deterministic VM: no model, disk preview or production sessions.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const app = fs.readFileSync(path.join(__dirname, "../../web/app.js"), "utf8");
function source(name) {
  const match = app.match(new RegExp(`^(?:async )?function ${name}\\([^\\n]*\\) \\{[\\s\\S]*?^}`, "m"));
  assert.ok(match, `missing function ${name}`); return match[0];
}
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
const file = (id, kind = "modified") => ({ id, path: `src/${id}.ts`, kind, source: "tool", location: "local" });
const response = (f, content = "const safe = true;\n") => ({ file: f, view: "current", status: "text", content });
function fixture() {
  const classes = new Set();
  const layout = { classList: { add: (v) => classes.add(v), remove: (v) => classes.delete(v) } };
  const host = { hidden: true, innerHTML: "", contains: () => false, closest: () => layout };
  const close = { focus() {} };
  const events = {}, calls = [];
  const state = { chat: { sessionId: "A", agent: "test", detailRequestSeq: 0, messages: [{ role: "assistant", fileChanges: [file("one"), file("two")] }] } };
  const document = { body: { dataset: { panel: "chat" } }, activeElement: null,
    querySelectorAll: (selector) => selector === ".has-file-preview" ? [layout] : [], getElementById: () => close,
    addEventListener: (type, fn) => { events[type] = fn; } };
  const context = vm.createContext({ state, document, histView: { sel: "H", agent: "test", requestSeq: 0 },
    $: (selector) => selector === "#filePreview" ? host : selector === "#filePreviewClose" ? close : null,
    api: (url, opts) => { const gate = deferred(); calls.push({ url, opts, gate }); return gate.promise; },
  });
  vm.runInContext(app.match(/^const esc = .*$/m)[0] + "\n" + ["viewedChatSessionId", "viewedChatMessages", "normalizedFileChanges", "fileChangeKindLabel", "messageFileChangesHtml", "filePreviewContext", "isCurrentFilePreview", "closeFilePreview", "filePreviewBodyHtml", "renderFilePreview", "openFilePreview", "initFilePreview", "sessionChatMessages"].map(source).join("\n"), context);
  return { context, state, document, host, classes, calls, events };
}

async function main() {
  const f = fixture(), c = f.context;
  for (const message of [{ role: "assistant" }, { role: "assistant", fileChanges: [] }, { role: "assistant", pending: true, fileChanges: [file("one")] }, { role: "user", fileChanges: [file("one")] }]) assert.equal(c.messageFileChangesHtml(message, "A"), "", "no empty frame or unconfirmed pending chips");
  const metadata = { id: 'id/"<&', path: 'src/<img onerror=alert(1)>.ts', kind: "renamed", oldPath: 'old/<script>.ts', location: "remote", deviceLabel: '<svg onload="bad">', source: "tool" };
  const html = c.messageFileChangesHtml({ role: "assistant", fileChanges: [metadata, metadata, { id: "bad", path: "?", kind: "<script>" }] }, "A");
  assert.match(html, /<b>1<\/b>/); assert.match(html, /重命名/); assert.match(html, /&lt;img/); assert.doesNotMatch(html, /<img|<svg|<script|href=/);
  assert.equal(c.messageFileChangesHtml({ role: "assistant", fileChanges: [file("one")] }, null), "", "stateless turns must not link to an unrelated session");
  const restored = c.sessionChatMessages({ agentName: "test", messages: [{ role: "assistant", content: "", fileChanges: [metadata] }] });
  assert.equal(restored[0].fileChanges[0].oldPath, metadata.oldPath);
  assert.equal(restored[0].fileChanges[0].location, "remote", "history preserves remote provenance");
  const code = c.filePreviewBodyHtml(response(file("one"), '<script>alert("x")</script>\r\nsecond'));
  assert.doesNotMatch(code, /<script>/); assert.match(code, /&lt;script&gt;/); assert.match(code, /line-number" aria-hidden="true">2</); assert.match(code, /tabindex="0"/);
  assert.match(c.filePreviewBodyHtml(response(file("one"), "")), /空文件/);
  assert.match(c.filePreviewBodyHtml(response(file("one"), "x".repeat(1024 * 1024 + 1))), /文件过大/);
  assert.match(c.filePreviewBodyHtml(response(file("one"), "\n".repeat(20001))), /文件过大/);
  for (const [status, expected] of Object.entries({ loading: "正在读取", deleted: "文件已不存在", binary: "二进制", too_large: "文件过大", unavailable: "暂不可预览", remote_unavailable: "同名路径", error: "重新读取", unknown: "暂不可预览" })) {
    const content = c.filePreviewBodyHtml({ status, reason: '<img src=x onerror="bad">' });
    assert.ok(content.includes(expected), status); assert.doesNotMatch(content, /<img/);
  }

  const first = c.openFilePreview("A", file("one"));
  assert.equal(f.host.hidden, false); assert.match(f.host.innerHTML, /正在读取/); assert.ok(f.classes.has("has-file-preview"));
  const second = c.openFilePreview("A", file("two"));
  f.calls[1].gate.resolve(response(file("two"), "LATEST")); await second;
  f.calls[0].gate.resolve(response(file("one"), "STALE")); await first;
  assert.match(f.host.innerHTML, /LATEST/); assert.doesNotMatch(f.host.innerHTML, /STALE/);
  assert.match(f.host.innerHTML, /当前文件 · 非历史快照/); assert.match(f.host.innerHTML, /Shell 间接改动/);
  assert.equal(f.calls[0].url, "/api/conversations/A/files/one"); assert.equal(f.calls[0].opts, undefined, "preview is read-only GET");

  const closed = c.openFilePreview("A", file("one")); c.closeFilePreview();
  f.calls[2].gate.resolve(response(file("one"), "REOPEN")); await closed;
  assert.equal(f.host.hidden, true); assert.equal(f.host.innerHTML, "");
  const leaving = c.openFilePreview("A", file("one"));
  f.state.chat.sessionId = "B"; c.renderFilePreview();
  f.state.chat.sessionId = "A";
  f.calls[3].gate.resolve(response(file("one"), "A-B-A STALE")); await leaving;
  assert.equal(f.host.hidden, true, "A→B→A does not resurrect an old response");
  const sameIdNavigation = c.openFilePreview("A", file("one"));
  f.state.chat.detailRequestSeq++; f.calls[4].gate.resolve(response(file("one"), "OLD NAVIGATION")); await sameIdNavigation;
  c.renderFilePreview(); assert.equal(f.host.hidden, true, "navigation generation guards even before next session loads");
  const wrong = c.openFilePreview("A", file("one"));
  f.calls[5].gate.resolve(response(file("wrong"))); await wrong;
  assert.match(f.host.innerHTML, /归属不匹配/); assert.doesNotMatch(f.host.innerHTML, /const safe/);
  const failure = c.openFilePreview("A", file("one")); f.calls[6].gate.reject(new Error("offline")); await failure;
  assert.match(f.host.innerHTML, /读取失败/); assert.match(f.host.innerHTML, /offline/);
  const count = f.calls.length; await c.openFilePreview("OTHER", file("one")); assert.equal(f.calls.length, count);

  f.document.body.dataset.panel = "history";
  c.histView.messages = [{ role: "assistant", fileChanges: [metadata] }];
  const history = c.openFilePreview("H", metadata);
  assert.match(f.calls.at(-1).url, /\/conversations\/H\/files\/id%2F%22%3C%26$/);
  f.calls.at(-1).gate.resolve({ file: metadata, view: "current", status: "remote_unavailable" }); await history;
  assert.match(f.host.innerHTML, /远端文件暂不可预览/); assert.equal(f.state.chat.sessionId, "A", "history never switches the executing conversation");
  c.initFilePreview(); let prevented = false;
  f.events.keydown({ key: "Escape", preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true); assert.equal(f.host.hidden, true);
  assert.match(source("renderChatMessages"), /\|\| !!fileChanges/, "a file-only receipt is not dropped as an empty assistant reply");
  assert.match(source("executeChat"), /pending\.fileChanges = res\.fileChanges/, "live completion retains server-owned metadata");
  console.log("file changes web tests passed (metadata, safe chips/code, statuses, session/request races, history, GET-only, Escape)");
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
