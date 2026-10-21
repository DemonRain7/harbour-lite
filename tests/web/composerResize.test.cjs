const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "../..");
const source = fs.readFileSync(path.join(root, "web/app.js"), "utf8");
const css = fs.readFileSync(path.join(root, "web/styles.css"), "utf8");
const resizeSource = source.match(/^function installChatComposerResize\(\) \{[\s\S]*?^}/m)?.[0];
assert.ok(resizeSource);
assert.match(source, /role="separator"[^>]*aria-controls="chatInput"/);
assert.match(source, /async function route\(\)[\s\S]*?disposeChatComposerResize\(\)/);
assert.match(source, /syncChatControlLocks\(\);\s*installChatComposerResize\(\)/);
assert.match(css, /\.chat-compose textarea\.inp\s*\{[^}]*resize: none/);
assert.match(css, /\.chat-resize-handle\s*\{[^}]*touch-action: none/);
assert.match(css, /prefers-reduced-motion: reduce/);
assert.doesNotMatch(resizeSource, /localStorage|sessionStorage|\bapi\(|\bfetch\(/);

class Element extends EventTarget {
  constructor(height = 0) {
    super();
    this.height = height;
    this.isConnected = true;
    this.children = [];
    this.attributes = {};
    this.captures = new Set();
    this.classes = new Set();
    this.classList = {
      add: (name) => this.classes.add(name), remove: (name) => this.classes.delete(name),
      contains: (name) => this.classes.has(name),
    };
    this.style = { removeProperty: (key) => { delete this.style[key === "max-height" ? "maxHeight" : key]; } };
  }
  getBoundingClientRect() { return { height: parseFloat(this.style.height) || this.height }; }
  setAttribute(key, value) { this.attributes[key] = value; }
  setPointerCapture(id) { this.captures.add(id); }
  hasPointerCapture(id) { return this.captures.has(id); }
  releasePointerCapture(id) { this.captures.delete(id); fire(this, "lostpointercapture", { pointerId: id }); }
  focus() { this.focused = true; }
}
function fire(target, type, fields = {}) {
  const event = new Event(type, { cancelable: true });
  Object.assign(event, fields);
  target.dispatchEvent(event);
  return event;
}
const win = new Element();
win.innerHeight = 900;
win.visualViewport = new Element();
win.visualViewport.height = 900;
const body = new Element();
let elements;
function mount() {
  const input = new Element(72), handle = new Element(), composer = new Element(), bench = new Element();
  const layout = new Element(); layout.style.setProperty = (key, value) => { layout.style[key] = value; };
  input.value = "草稿\n".repeat(100);
  input.selectionStart = 3; input.selectionEnd = 9;
  input.closest = () => composer;
  composer.closest = () => bench;
  composer.overhead = 158;
  composer.getBoundingClientRect = () => ({ height: input.getBoundingClientRect().height + composer.overhead });
  composer.marginTop = 4; composer.marginBottom = 18;
  const stream = new Element(); stream.classes.add("chat-stream-wrap");
  bench.children = [stream, composer]; bench.clientHeight = 720;
  bench.closest = () => layout;
  bench.getBoundingClientRect = () => ({ height: bench.clientHeight + 2 });
  elements = { input, handle, composer, bench, stream, layout };
  return elements;
}
const observers = [];
class Observer {
  constructor(fn) { this.fn = fn; this.targets = []; observers.push(this); }
  observe(target) { this.targets.push(target); }
  disconnect() { this.disconnected = true; }
}
win.ResizeObserver = Observer;
let nextFrame = 0;
const frames = new Map();
const context = vm.createContext({
  window: win, document: { body, getElementById: (id) => ({ chatInput: elements.input, chatResizeHandle: elements.handle })[id] },
  AbortController, ResizeObserver: Observer,
  getComputedStyle: (el) => ({ marginTop: String(el.marginTop || 0), marginBottom: String(el.marginBottom || 0) }),
  requestAnimationFrame: (fn) => { frames.set(++nextFrame, fn); return nextFrame; },
  cancelAnimationFrame: (id) => frames.delete(id),
});
vm.runInContext(`let chatComposerHeight = null; let disposeChatComposerResize = () => {};\n${resizeSource}`, context);
const run = (code) => vm.runInContext(code, context);
const height = () => elements.input.getBoundingClientRect().height;
const flush = () => { const pending = [...frames.values()]; frames.clear(); pending.forEach((fn) => fn()); };
const down = (extra = {}) => fire(elements.handle, "pointerdown", { button: 0, pointerId: 1, clientY: 500, ...extra });
const move = (y, extra = {}) => fire(win, "pointermove", { pointerType: "mouse", buttons: 1, pointerId: 1, clientY: y, ...extra });
const key = (key) => fire(elements.handle, "keydown", { key });
const idle = () => {
  assert.equal(body.classes.has("chat-composer-resizing"), false);
  assert.equal(elements.composer.classes.has("is-resizing"), false);
  assert.equal(elements.handle.captures.size, 0);
};

mount();
run("installChatComposerResize()");
assert.equal(height(), 72);
assert.equal(elements.handle.attributes["aria-valuemax"], "420");
assert.equal(elements.layout.style['--chat-workbench-min-height'], '354px', "narrow row minimum includes fixed controls, input minimum, message reserve and borders");
assert.ok(observers.at(-1).targets.includes(elements.stream), "observe the flexible stream when dynamic siblings occupy space");
assert.equal(down().defaultPrevented, true);
move(350, { pointerId: 2 }); assert.equal(height(), 72, "other pointers cannot interfere");
move(350); assert.equal(height(), 222, "up enlarges the bottom-anchored input");
assert.equal(elements.layout.style['--chat-workbench-min-height'], '354px', "requested input height must not cause a layout growth feedback loop");
fire(win, "pointerup", { pointerId: 1 }); idle();
move(100); assert.equal(height(), 222, "release outside handle ends resize");
down(); move(5000); assert.equal(height(), 52);
move(-5000); assert.equal(height(), 420);
fire(win, "pointercancel", { pointerId: 1 }); idle();
assert.equal(key("Home").defaultPrevented, true); assert.equal(height(), 72);
key("ArrowUp"); assert.equal(height(), 96);
key("ArrowDown"); assert.equal(height(), 72);
key("ArrowUp"); fire(elements.handle, "dblclick"); assert.equal(height(), 72);
assert.equal(elements.input.value, "草稿\n".repeat(100));
assert.equal(elements.input.selectionStart, 3);
assert.equal(elements.input.selectionEnd, 9);

for (const end of ["blur", "lostpointercapture", "buttons", "Escape"]) {
  down();
  if (end === "lostpointercapture") fire(elements.handle, end, { pointerId: 1 });
  else if (end === "buttons") move(500, { buttons: 0 });
  else if (end === "Escape") key(end);
  else fire(win, end);
  idle();
}
down({ button: 2 }); idle();
down({ isPrimary: false }); idle();
elements.handle.setPointerCapture = () => { throw new Error("capture unavailable"); };
down(); move(400); assert.equal(height(), 172);
fire(win, "pointerup", { pointerId: 1 }); idle();

elements.bench.clientHeight = 400;
fire(win, "resize"); fire(win, "resize");
assert.equal(frames.size, 1, "coalesce layout notifications"); flush();
assert.equal(height(), 100, "clamp to smaller workbench while retaining message space");
elements.bench.clientHeight = 720;
fire(win, "resize"); flush(); assert.equal(height(), 172, "restore requested height when room returns");
win.visualViewport.height = 200;
fire(win.visualViewport, "resize"); flush(); assert.equal(height(), 120);
win.visualViewport.height = 900;
elements.composer.overhead = 458;
observers.at(-1).fn(); flush(); assert.equal(height(), 120, "toolbars/checkpoints reduce available height");
elements.composer.overhead = 158;
observers.at(-1).fn(); flush(); assert.equal(height(), 172);
const activity = new Element(300);
elements.bench.children.unshift(activity);
observers.at(-1).fn(); flush(); assert.equal(height(), 120, "dynamic sibling reduces resize limit without changing workbench/composer height");
assert.equal(elements.layout.style['--chat-workbench-min-height'], '654px');
elements.bench.children.shift();
observers.at(-1).fn(); flush(); assert.equal(height(), 172, "requested height returns when sibling is removed");

// Rebinding the same DOM is idempotent and reset still returns to the CSS default.
run("installChatComposerResize()");
assert.equal(observers.at(-2).disconnected, true);
assert.equal(height(), 172);
key("Enter"); assert.equal(height(), 72);
key("ArrowUp"); assert.equal(height(), 96, "one keyboard listener only");
elements.input.disabled = true;
key("ArrowUp"); assert.equal(height(), 120, "read-only mirrors still allow local sizing");
assert.equal(elements.input.disabled, true);
down(); fire(win, "resize");
const old = elements;
run("disposeChatComposerResize()"); idle();
assert.equal(elements.layout.style['--chat-workbench-min-height'], undefined, "disposing clears the adaptive narrow row minimum");
assert.equal(frames.size, 0);
assert.equal(observers.at(-1).disconnected, true);
move(200); fire(old.handle, "keydown", { key: "ArrowUp" });
assert.equal(height(), 120, "detached listeners cannot mutate the old composer");
mount(); run("installChatComposerResize()");
assert.equal(height(), 120, "same-page navigation keeps temporary height");
run("disposeChatComposerResize(); chatComposerHeight = null; installChatComposerResize()");
assert.equal(height(), 72, "fresh page starts at default size");
run("disposeChatComposerResize()");
console.log("web composer resize tests passed");
