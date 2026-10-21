const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { create } = require("../../web/unsaved-changes.js");

const script = fs.readFileSync(path.join(__dirname, "../../web/workflow-canvas.js"), "utf8");
const tick = () => new Promise(resolve => setImmediate(resolve));
const decode = text => text.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
class Element {
  style = {}; dataset = {}; isConnected = true; listeners = {}; classList = { toggle() {} };
  clientWidth = 1000; clientHeight = 600;
  addEventListener(event, callback) { this.listeners[event] = callback; }
  setAttribute() {}
  focus() {}
  querySelectorAll() { return []; }
  getBoundingClientRect() { return { width: 1000, height: 600 }; }
  fire(event = "input") { this.listeners[event]?.({ target: this }); }
}
class Host extends Element {
  elements = new Map();
  set innerHTML(html) {
    if (html.includes('data-wf="retry"')) {
      this.elements = new Map([['[data-wf="retry"]', new Element()]]);
      return;
    }
    if (!html.includes("wf-workspace")) return;
    this.elements = new Map([".wf-stage", ".wf-world", ".wf-edges", ".wf-nodes", ".wf-zoom", ".wf-save-status", ".wf-notice",
      ...["fit", "minus", "plus", "focus", "reset", "cancel", "save"].map(key => `[data-wf="${key}"]`)].map(key => [key, new Element()]));
    const inspector = new Element(), elements = this.elements;
    Object.defineProperty(inspector, "innerHTML", { set(markup) {
      const note = new Element();
      note.value = decode(markup.match(/<textarea[^>]*>([\s\S]*?)<\/textarea>/)[1]);
      elements.set(".wf-note", note);
      this.inputs = [...markup.matchAll(/<input[^>]*value="([^"]*)"[^>]*data-setting="([^"]*)"/g)].map(match => {
        const input = new Element(); input.value = match[1]; input.dataset.setting = match[2]; return input;
      });
      this.querySelectorAll = selector => selector === "[data-setting]" ? this.inputs : selector === "input,textarea" ? [note, ...this.inputs] : [];
    } });
    this.elements.set(".wf-inspector", inspector);
  }
  querySelector(selector) { return this.elements.get(selector) || null; }
  inputNote(text) { const note = this.querySelector(".wf-note"); note.value = text; note.fire(); }
  inputSetting(number) { const input = this.querySelector(".wf-inspector").inputs[0]; input.value = String(number); input.fire(); }
}
async function harness(overrides = {}) {
  const host = new Host(), requests = [], confirmations = [], prompts = [], entries = new Map();
  let action = "stay";
  const guard = create({ ask: async labels => { prompts.push(labels); return action; } });
  const register = guard.register;
  guard.register = (id, entry) => { entries.set(id, entry); return register(id, entry); };
  const fixture = {
    revision: "fixture-v1", document: { version: 1, executor: "example", positions: {}, notes: {}, settings: { batchSize: 2 } },
    definition: { title: "Fixture workflow", description: "Offline canvas fixture", nodes: [{ id: "batch", kind: "code", phase: "executor", x: 20, y: 20, title: "Batch", detail: "fixture", summary: "fixture" }], edges: [],
      settings: [{ key: "batchSize", node: "batch", label: "Batch size", description: "fixture", min: 1, max: 3 }] },
  };
  const services = {
    toast() {}, confirm: async (...args) => { confirmations.push(args); return true; },
    api: async (url, options) => {
      requests.push({ url, ...options });
      return options?.method === "POST" ? { proposal: { id: "proposal-fixture" } } : structuredClone(fixture);
    }, ...overrides,
  };
  const context = vm.createContext({ window: { HarbourUnsavedChanges: guard }, requestAnimationFrame() {}, ResizeObserver: class { observe() {} disconnect() {} } });
  vm.runInContext(script, context);
  const editor = await context.window.HarbourWorkflowCanvas.mount(host, "example", services);
  return { host, editor, guard, entries, fixture, requests, confirmations, prompts, services,
    action: value => { action = value; },
    remount: () => context.window.HarbourWorkflowCanvas.mount(host, "example", services) };
}

test("canvas registers active mount and no-op/reverted notes and settings are clean", async () => {
  const h = await harness();
  assert.equal(h.entries.get("workflow-graph:example"), h.editor);
  assert.equal(h.editor.isActive(), true);
  assert.equal(h.guard.hasChanges(), false);
  h.host.inputNote("new note");
  assert.equal(h.guard.hasChanges(), true);
  h.host.inputNote("");
  assert.equal(h.guard.hasChanges(), false);
  h.host.inputSetting(3);
  assert.equal(h.editor.isDirty(), true);
  h.host.inputSetting(2);
  assert.equal(h.editor.isDirty(), false);
  assert.equal(await h.guard.requestLeave(), true);
  assert.equal(h.prompts.length, 0);
  h.host.isConnected = false;
  assert.equal(h.editor.isActive(), false);
});

test("unavailable canvas retries only its read request after backend reload", async () => {
  const fixture = (await harness()).fixture;
  let calls = 0;
  const h = await harness({ api: async (_url, options) => {
    assert.equal(options?.method, undefined, "retry must not launch or mutate a Workflow");
    if (++calls === 1) throw new Error("Workflow 执行器未注册");
    return structuredClone(fixture);
  } });
  assert.equal(h.editor, undefined);
  h.host.querySelector('[data-wf="retry"]').fire("click");
  await tick();
  assert.equal(calls, 2);
  assert.ok(h.host.querySelector(".wf-stage"));
  assert.equal(h.guard.hasChanges(), false);
});

test("shared leave Stay retains notes; discard resets the actual canvas draft", async () => {
  const h = await harness();
  h.host.inputNote("keep until confirmed");
  assert.equal(await h.guard.requestLeave(), false);
  assert.equal(h.editor.isDirty(), true);
  assert.equal(h.host.querySelector(".wf-note").value, "keep until confirmed");
  h.action("discard");
  assert.equal(await h.guard.requestLeave(), true);
  assert.equal(h.editor.isDirty(), false);
  assert.equal(h.host.querySelector(".wf-note").value, "");
  assert.equal(h.requests.length, 1, "shared discard is synchronous and never writes/reloads");
  const reopened = await h.remount();
  assert.equal(reopened.isDirty(), false);
  assert.equal(h.host.querySelector(".wf-note").value, "");
});

test("Cancel uses the themed confirmation and clears state only after confirmation", async () => {
  const h = await harness();
  h.host.inputSetting(3);
  h.services.confirm = async () => false;
  await h.host.querySelector('[data-wf="cancel"]').onclick();
  assert.equal(h.editor.isDirty(), true);
  h.services.confirm = async (message, options) => { h.confirmations.push({ message, options }); return true; };
  assert.equal(await h.host.querySelector('[data-wf="cancel"]').onclick(), true);
  assert.equal(h.editor.isActive(), false, "reload supersedes the prior mount");
  assert.equal(h.entries.get("workflow-graph:example").isDirty(), false);
  assert.equal(h.host.querySelector(".wf-inspector").inputs[0].value, "2");
  assert.match(h.confirmations[0].options.title, /取消画布修改/);
  assert.equal(h.requests.filter(request => request.method === "POST").length, 0);
});

test("save-and-leave persists a proposal and leaves no phantom unsaved state", async () => {
  const h = await harness();
  h.host.inputNote("saved note");
  h.action("save");
  assert.equal(await h.guard.requestLeave(), true);
  assert.equal(h.editor.isDirty(), false);
  assert.equal(h.guard.hasChanges(), false);
  assert.equal(h.host.querySelector('[data-wf="save"]').disabled, true);
  assert.match(h.host.querySelector(".wf-save-status").textContent, /待审批提案/);
  assert.match(h.host.querySelector(".wf-notice").innerHTML, /尚未应用/);
  const posts = h.requests.filter(request => request.method === "POST");
  assert.equal(posts.length, 1);
  assert.equal(JSON.parse(posts[0].body).document.notes.batch, "saved note");
  assert.equal(await h.editor.save(), true, "saved pending proposals are clean, not another write");
  assert.equal(h.requests.filter(request => request.method === "POST").length, 1);
  const reopened = await h.remount();
  assert.equal(reopened.isDirty(), false);
  assert.equal(h.host.querySelector(".wf-note").value, "saved note", "pending proposal remains visible until apply/reload");
});

test("failed/invalid saves block leaving and preserve local edits", async () => {
  const h = await harness();
  h.host.inputSetting(0);
  assert.equal(await h.editor.save(), false);
  assert.equal(h.requests.length, 1);
  let fail = false;
  const f = await harness({ api: async (_url, options) => {
    if (options?.method === "POST") { fail = true; throw new Error("offline"); }
    return structuredClone(h.fixture);
  } });
  f.host.inputNote("unsaved"); f.action("save");
  assert.equal(await f.guard.requestLeave(), false);
  assert.equal(fail, true);
  assert.equal(f.editor.isDirty(), true);
  assert.equal(f.editor.isBusy(), false);
  assert.equal(f.host.querySelector(".wf-note").value, "unsaved");
});

test("in-flight proposals refuse discard and guard leave, then clear only on success", async () => {
  const fixture = (await harness()).fixture, pending = deferred();
  const h = await harness({ api: async (_url, options) => options?.method === "POST" ? pending.promise : structuredClone(fixture) });
  h.host.inputNote("submitted snapshot");
  const saving = h.editor.save();
  await tick();
  assert.equal(h.editor.isBusy(), true);
  assert.equal(h.editor.discard(), false);
  assert.equal(await h.editor.save(), false);
  assert.equal(await h.guard.requestLeave(), false);
  pending.resolve({ proposal: { id: "confirmed" } });
  assert.equal(await saving, true);
  assert.equal(h.editor.isBusy(), false);
  assert.equal(h.editor.isDirty(), false);
});

test("malformed proposal acknowledgements do not erase the local draft", async () => {
  const fixture = (await harness()).fixture;
  const h = await harness({ api: async (_url, options) => options?.method === "POST" ? {} : structuredClone(fixture) });
  h.host.inputNote("not yet persisted");
  assert.equal(await h.editor.save(), false);
  assert.equal(h.editor.isDirty(), true);
  assert.match(h.host.querySelector(".wf-notice").textContent, /未确认提案已保存/);
});

test("superseded mounts cannot discard the active canvas or grant an old leave", async () => {
  const fixture = (await harness()).fixture, pending = deferred();
  const h = await harness({ api: async (_url, options) => options?.method === "POST" ? pending.promise : structuredClone(fixture) });
  h.host.inputNote("persisting");
  const saving = h.editor.save();
  const reopened = await h.remount();
  assert.equal(h.editor.isActive(), false);
  assert.equal(h.editor.discard(), false);
  assert.equal(reopened.isActive(), true);
  assert.equal(reopened.isBusy(), true);
  pending.resolve({ proposal: { id: "late-success" } });
  assert.equal(await saving, false);
  assert.equal(reopened.isBusy(), false);
  assert.equal(reopened.isDirty(), false);
  assert.equal(h.host.querySelector(".wf-note").value, "persisting");
});

test("returning a CRLF note to its displayed LF text does not create a draft", async () => {
  const fixture = (await harness()).fixture;
  fixture.document.notes.batch = "first\r\nsecond";
  const h = await harness({ api: async () => structuredClone(fixture) });
  h.host.inputNote("changed");
  assert.equal(h.editor.isDirty(), true);
  h.host.inputNote("first\nsecond");
  assert.equal(h.editor.isDirty(), false);
  assert.equal(await h.guard.requestLeave(), true);
  assert.equal(h.prompts.length, 0);
});
