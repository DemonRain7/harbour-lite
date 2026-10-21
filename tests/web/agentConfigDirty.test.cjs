const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const script = fs.readFileSync(path.join(__dirname, "../../web/agent-config.js"), "utf8");
test("runtime settings expand into one page scroller without changing the file workspace", () => {
  const css = fs.readFileSync(path.join(__dirname, "../../web/collections.css"), "utf8");
  const declarations = (selector) => [...css.matchAll(new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*\\{([^}]*)\\}", "g"))].map(match => match[1]).join(" ");
  const page = ".agent-studio .agents-layout:not(:has(.fa-layout:not([hidden])))";
  assert.match(declarations(page), /overflow-y: auto;/);
  assert.match(declarations(page), /min-height: 0;/, "small screens must not force a viewport-taller page shell");
  assert.match(declarations(page + " > .agents-detail-shell"), /display: block; flex: none;/);
  assert.match(declarations(page + " #agentsDetail"), /height: auto; overflow: visible;/);
  assert.match(declarations(".agent-studio .ac-editor"), /flex: none; overflow: visible;/);
  assert.match(declarations(".agent-studio .ac-scroll"), /flex: none; overflow: visible; overscroll-behavior: auto;/);
  assert.match(declarations(".agent-studio .ac-toolbar"), /position: sticky; top: 0;/, "save controls remain reachable while reading a long configuration");
});
const decode = (text) => text.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const tick = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

// Deliberately small DOM surface: exercise the actual mount, generated controls,
// registered input handlers and save/reset buttons without a browser or network.
function control(html) {
  const tagName = html.match(/^<(\w+)/)[1].toUpperCase();
  const attributes = html.slice(0, html.indexOf(">"));
  const element = {
    tagName, type: attributes.match(/type="([^"]*)"/)?.[1] || "",
    value: decode(attributes.match(/value="([^"]*)"/)?.[1] || ""),
    checked: /\bchecked\b/.test(attributes), disabled: /\bdisabled\b/.test(attributes),
    listeners: {}, classList: { toggle() {} },
    addEventListener(event, listener) { this.listeners[event] = listener; },
    fire() { this.listeners[this.tagName === "SELECT" || this.type === "checkbox" ? "change" : "input"](); },
  };
  if (tagName === "TEXTAREA") element.value = decode(html.match(/>([\s\S]*?)<\/textarea>/)[1]);
  if (tagName === "SELECT") {
    const options = [...html.matchAll(/<option value="([^"]*)"([^>]*)>/g)];
    element.value = decode((options.find((option) => /selected/.test(option[2])) || options[0])[1]);
  }
  return element;
}
class Root {
  isConnected = true;
  rows = new Map();
  buttons = new Map();
  set innerHTML(html) {
    this.rows.clear();
    this.buttons = new Map(["save", "reset", "governance", "status"].map((name) => [`[data-ac-${name}]`, { classList: { toggle() {} } }]));
    for (const fragment of html.split('data-ac-field="').slice(1)) {
      const name = fragment.slice(0, fragment.indexOf('"'));
      const controls = new Map();
      for (const match of fragment.matchAll(/<(input|textarea|select)\b[^>]*data-ac-(value|enabled|context)[^>]*(?:>[\s\S]*?<\/\1>|>)/g)) {
        controls.set(`[data-ac-${match[2]}]`, control(match[0]));
      }
      this.rows.set(name, {
        dataset: { acField: name },
        querySelector: (selector) => controls.get(selector) || null,
        querySelectorAll: () => [...controls.values()],
      });
    }
  }
  querySelector(selector) {
    if (selector.includes('data-ac-field="reasoningEffort"')) return this.rows.get("reasoningEffort")?.querySelector("[data-ac-value]");
    return this.buttons.get(selector) || null;
  }
  querySelectorAll(selector) {
    return selector === "[data-ac-field]" ? [...this.rows.values()] : [...this.rows.values()].flatMap((row) => row.querySelectorAll());
  }
  input(name, value, part = "value") {
    const input = this.rows.get(name).querySelector(`[data-ac-${part}]`);
    if (part === "enabled") input.checked = value;
    else input.value = String(value);
    input.fire();
  }
}
function harness(config = {}, overrides = {}) {
  const root = new Root(), drafts = overrides.drafts || new Map(), calls = [], proposals = [], notices = [];
  let source = JSON.stringify(config), current = true;
  const context = vm.createContext({ structuredClone });
  vm.runInContext(script, context);
  const options = {
    name: "example", drafts, isCurrent: () => current, readSource: () => source,
    onDirty: (dirty) => notices.push(dirty), confirm: async () => true,
    api: async (url, request) => {
      const data = JSON.parse(request.body);
      calls.push(data);
      const next = JSON.parse(data.source);
      for (const [field, value] of Object.entries(data.patch)) {
        const segments = field.split("."), leaf = segments.pop();
        let node = next;
        for (const segment of segments) node = node[segment] ||= {};
        if (value === null) delete node[leaf]; else node[leaf] = value;
      }
      return { config: next, content: JSON.stringify(next) };
    },
    saveContent: async (content, original) => { proposals.push({ content, original }); source = content; },
    ...overrides,
  };
  const editor = context.HarbourAgentConfig.mount(root, options);
  return { root, editor, drafts, calls, proposals, notices, options,
    setSource: (value) => { source = JSON.stringify(value); },
    close: () => { current = false; },
  };
}

test("matching prepared preview renders immediately without a second request; reload stays fresh", async () => {
  const config = { maxSteps: 20, description: "prepared" };
  const source = JSON.stringify(config);
  const h = harness(config, { initialPreview: { source, result: { config, content: source } } });
  assert.equal(h.editor.isBusy(), false);
  assert.equal(h.root.rows.get("maxSteps").querySelector("[data-ac-value]").value, "20");
  assert.equal(h.calls.length, 0);
  assert.equal(h.editor.isDirty(), false);
  h.setSource({ maxSteps: 30 });
  assert.equal(await h.editor.reload(), true);
  assert.equal(h.calls.length, 1);
  assert.equal(h.root.rows.get("maxSteps").querySelector("[data-ac-value]").value, "30");
  assert.equal(h.proposals.length, 0);
});

test("prepared preview from a different source cannot replace the current configuration", async () => {
  const h = harness({ maxSteps: 40 }, {
    initialPreview: { source: '{"maxSteps":20}', result: { config: { maxSteps: 20 } } },
  });
  await tick();
  assert.equal(h.calls.length, 1);
  assert.equal(h.root.rows.get("maxSteps").querySelector("[data-ac-value]").value, "40");
  assert.equal(h.editor.isDirty(), false);
});

test("failed prepared preview keeps controls disabled and can be explicitly reloaded", async () => {
  const h = harness({ maxSteps: 20 }, {
    initialPreview: { source: '{"maxSteps":20}', error: new Error("Fixture preview unavailable") },
  });
  assert.equal(h.calls.length, 0, "do not immediately repeat a failed read");
  assert.equal(h.root.rows.get("maxSteps").querySelector("[data-ac-value]").disabled, true);
  assert.equal(await h.editor.save(), false);
  assert.equal(h.proposals.length, 0);
  assert.equal(await h.editor.reload(), true);
  assert.equal(h.calls.length, 1);
  assert.equal(h.root.rows.get("maxSteps").querySelector("[data-ac-value]").disabled, false);
});

test("unchanged fields and edits reverted to their baseline leave no phantom drafts", async () => {
  const h = harness({ description: "original", maxSteps: 20, routerOverrides: { research: "a", coding: "b" }, fallbacks: ["one", "two"] });
  await tick();
  assert.equal(h.editor.isDirty(), false);
  assert.equal(await h.editor.save(), true);
  assert.equal(h.calls.length, 1);
  for (const [field, value] of [["maxSteps", "020"], ["routerOverrides", '{ "coding": "b", "research": "a" }'], ["fallbacks", "one\n\n two "]]) {
    h.root.input(field, value);
    assert.equal(h.editor.isDirty(), false, `${field} compares effective values`);
  }
  h.root.input("description", "changed");
  assert.equal(h.editor.isDirty(), true);
  assert.equal(h.drafts.has("example"), true);
  h.root.input("description", "original");
  assert.equal(h.editor.isDirty(), false);
  assert.equal(h.drafts.has("example"), false);
  assert.equal(h.notices.at(-1), false);
});

test("optional policies distinguish absent, explicit empty lists, and explicit false", async () => {
  const h = harness();
  await tick();
  h.root.input("governance.permissions.writePaths", true, "enabled");
  assert.equal(h.editor.isDirty(), true, "an empty enabled path list denies all");
  h.root.input("governance.permissions.writePaths", false, "enabled");
  assert.equal(h.editor.isDirty(), false);
  h.root.input("governance.permissions.readOnly", "false");
  assert.equal(h.editor.isDirty(), true);
  h.root.input("governance.permissions.readOnly", "");
  assert.equal(h.editor.isDirty(), false);
  h.root.input("contextBudget", "manual", "context");
  h.root.input("contextBudget", "4096");
  assert.equal(h.editor.isDirty(), true);
  h.root.input("contextBudget", "auto", "context");
  assert.equal(h.editor.isDirty(), false, "absent contextBudget is already displayed as auto");
  assert.equal(h.drafts.has("example"), false);
});

test("returning to an explicit empty or whitespace-bearing string preserves that baseline", async () => {
  for (const description of ["", "  original  "]) {
    const h = harness({ description });
    await tick();
    h.root.input("description", "changed");
    h.root.input("description", description);
    assert.equal(h.editor.isDirty(), false);
    assert.equal(h.drafts.has("example"), false);
    assert.equal(await h.editor.save(), true);
    assert.equal(h.proposals.length, 0);
  }
});

test("discard clears real state synchronously without preview or proposal calls", async () => {
  const h = harness({ maxSteps: 20 });
  await tick();
  h.root.input("maxSteps", "40");
  assert.equal(h.editor.discard(), true);
  assert.equal(h.root.rows.get("maxSteps").querySelector("[data-ac-value]").value, "20");
  assert.equal(h.editor.isDirty(), false);
  assert.equal(h.drafts.has("example"), false);
  assert.equal(h.calls.length, 1);
  assert.equal(h.proposals.length, 0);
  assert.equal(await h.editor.save(), true);
});

test("save and discard refuse loading, failed validation and in-flight persistence", async () => {
  const loading = deferred(), h = harness({}, { api: () => loading.promise });
  assert.equal(h.editor.isBusy(), true);
  assert.equal(await h.editor.save(), false);
  assert.equal(h.editor.discard(), false);
  loading.resolve({ config: {}, content: "{}" });
  await tick();
  h.root.input("maxSteps", "-1");
  assert.equal(await h.editor.save(), false);
  assert.equal(h.editor.isDirty(), true);
  assert.equal(h.proposals.length, 0);
  h.editor.discard();
  h.root.input("routerOverrides", true, "enabled");
  h.root.input("routerOverrides", "null");
  assert.equal(await h.editor.save(), false, "enabled JSON null cannot accidentally clear the property");
  assert.equal(h.editor.isDirty(), true);
});

test("successful save cleans the actual edit map and advances the baseline", async () => {
  const h = harness({ maxSteps: 20 });
  await tick();
  h.root.input("maxSteps", "40");
  assert.equal(await h.editor.save(), true);
  assert.equal(h.proposals.length, 1);
  assert.equal(h.editor.isDirty(), false);
  assert.equal(h.drafts.has("example"), false);
  h.root.input("maxSteps", "50");
  h.root.input("maxSteps", "40");
  assert.equal(h.editor.isDirty(), false);
});

test("reverting a submitted field during Save remains a newer unsaved edit", async () => {
  const pending = deferred(), h = harness({ maxSteps: 20, description: "  preserve untouched spacing  " });
  await tick();
  const persist = h.options.saveContent;
  h.options.saveContent = async (...args) => { await pending.promise; await persist(...args); };
  h.root.input("maxSteps", "40");
  const saving = h.editor.save();
  await tick();
  assert.equal(h.editor.isBusy(), true);
  assert.equal(h.editor.discard(), false);
  assert.equal(await h.editor.save(), false);
  h.root.input("maxSteps", "20");
  pending.resolve();
  assert.equal(await saving, false);
  assert.equal(h.editor.isDirty(), true);
  assert.deepEqual(Object.keys(h.drafts.get("example").edit), ["maxSteps"], "rebasing must not edit untouched fields");
  assert.equal(h.drafts.get("example").edit.maxSteps.raw, "20");
  assert.equal(await h.editor.save(), true);
  assert.equal(JSON.parse(h.proposals.at(-1).content).maxSteps, 20);
});

test("source conflicts preserve drafts and cached drafts use their own baseline", async () => {
  const drafts = new Map([["example", { source: '{"maxSteps":20}', edit: { maxSteps: { raw: "40", enabled: true, manual: false } } }]]);
  const h = harness({ maxSteps: 40 }, { drafts });
  await tick();
  assert.equal(h.calls[0].source, '{"maxSteps":20}');
  assert.equal(h.editor.isDirty(), true, "new file source cannot hide pending config changes");
  assert.equal(await h.editor.save(), false);
  assert.equal(h.proposals.length, 0);
  assert.equal(h.drafts.has("example"), true);
  assert.equal(h.editor.discard(), true);
  assert.equal(h.calls.length, 1);
  assert.equal(await h.editor.reload(), true);
  assert.equal(h.root.rows.get("maxSteps").querySelector("[data-ac-value]").value, "40");
});

test("late old-editor acknowledgements never clear a newer shared draft", async () => {
  const pending = deferred(), h = harness({ maxSteps: 20 }, { saveContent: () => pending.promise });
  await tick();
  h.root.input("maxSteps", "40");
  const saving = h.editor.save();
  await tick();
  h.close();
  const newer = { source: "new source", edit: { description: { raw: "newer", enabled: true } } };
  h.drafts.set("example", newer);
  pending.resolve();
  assert.equal(await saving, false);
  assert.equal(h.drafts.get("example"), newer);
  assert.equal(h.editor.discard(), false);
});

test("failed persistence retains the pending draft and Cancel rereads without saving", async () => {
  const h = harness({ maxSteps: 20 }, { saveContent: async () => { throw new Error("offline"); } });
  await tick();
  h.root.input("maxSteps", "40");
  assert.equal(await h.editor.save(), false);
  assert.equal(h.editor.isBusy(), false);
  assert.equal(h.editor.isDirty(), true);
  assert.equal(h.drafts.has("example"), true);
  await h.root.querySelector("[data-ac-reset]").onclick();
  assert.equal(h.editor.isDirty(), false);
  assert.equal(h.drafts.has("example"), false);
  assert.equal(h.root.rows.get("maxSteps").querySelector("[data-ac-value]").value, "20");
  assert.equal(h.calls.at(-1).patch && Object.keys(h.calls.at(-1).patch).length, 0);
});

test("canceling the discard confirmation keeps the current draft", async () => {
  const h = harness({ maxSteps: 20 }, { confirm: async () => false });
  await tick();
  h.root.input("maxSteps", "40");
  await h.root.querySelector("[data-ac-reset]").onclick();
  assert.equal(h.editor.isDirty(), true);
  assert.equal(h.drafts.has("example"), true);
  assert.equal(h.calls.length, 1);
});
