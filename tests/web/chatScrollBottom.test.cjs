const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "../..");
const source = fs.readFileSync(path.join(root, "web/app.js"), "utf8");
const css = fs.readFileSync(path.join(root, "web/styles.css"), "utf8");
const implementation = source.match(/^function installChatScrollBottom\(\) \{[\s\S]*?^}/m)?.[0];
assert.ok(implementation);
assert.match(source, /id="chatScrollBottom"[^>]*aria-label="回到聊天底部"[^>]*hidden/);
assert.match(source, /async function route\(\)[\s\S]*?disposeChatScrollBottom\(\)/);
assert.match(source, /installChatComposerResize\(\);\s*installChatScrollBottom\(\);/);
assert.match(css, /\.chat-scroll-bottom\[hidden\]\s*\{\s*display: none;/);
assert.match(css, /\.chat-stream\s*\{[^}]*overflow-y: auto;[^}]*scrollbar-width: none;/, "hide only the chat scrollbar, retaining native scrolling");
assert.match(css, /\.chat-stream::-webkit-scrollbar\s*\{[^}]*display: none;/, "Electron/WebKit also hide the scrollbar");
assert.doesNotMatch(implementation, /setInterval|setTimeout|localStorage|sessionStorage|\bapi\(|\bfetch\(/);

class Element extends EventTarget {
  constructor() { super(); this.isConnected = true; this.hidden = false; this.children = []; }
  querySelector() { return this.children.find(child => child.isMessage) || null; }
  scrollTo(options) { this.lastScroll = options; this.scrollTop = Math.max(0, Math.min(options.top, this.scrollHeight - this.clientHeight)); }
}
const resizeObservers = [], mutationObservers = [];
class ResizeObserver {
  constructor(fn) { this.fn = fn; this.targets = new Set(); resizeObservers.push(this); }
  observe(target) { this.targets.add(target); }
  unobserve(target) { this.targets.delete(target); }
  disconnect() { this.disconnected = true; this.targets.clear(); }
}
class MutationObserver {
  constructor(fn) { this.fn = fn; mutationObservers.push(this); }
  observe(target, options) { this.target = target; this.options = options; }
  disconnect() { this.disconnected = true; }
}
const win = new Element();
win.ResizeObserver = ResizeObserver; win.MutationObserver = MutationObserver;
let reducedMotion = false;
win.matchMedia = () => ({ matches: reducedMotion });
let stream, button;
function mount() {
  stream = new Element(); button = new Element(); button.hidden = true;
  stream.scrollHeight = 2400; stream.clientHeight = 600; stream.scrollTop = 1800;
  const message = new Element(); message.isMessage = true; message.parentElement = stream;
  stream.children = [message];
}
const frames = new Map(); let sequence = 0;
const context = vm.createContext({
  window: win, document: { getElementById: id => ({ chatStream: stream, chatScrollBottom: button })[id] },
  AbortController, ResizeObserver, MutationObserver,
  requestAnimationFrame: fn => { frames.set(++sequence, fn); return sequence; },
  cancelAnimationFrame: id => frames.delete(id),
});
vm.runInContext(`let disposeChatScrollBottom = () => {};\n${implementation}`, context);
const run = code => vm.runInContext(code, context);
const flush = () => { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(fn => fn()); };
const fire = (target, type) => target.dispatchEvent(new Event(type));
const scroll = top => { stream.scrollTop = top; fire(stream, "scroll"); flush(); };

mount(); run("installChatScrollBottom()");
assert.equal(button.hidden, true, "already at bottom needs no button");
scroll(200); assert.equal(button.hidden, false);
scroll(1792); assert.equal(button.hidden, true, "fractional/near-bottom rounding must not flicker");
scroll(1790); assert.equal(button.hidden, false);
scroll(1804); assert.equal(button.hidden, true, "bottom overscroll is still bottom");
scroll(-4); assert.equal(button.hidden, false);
const currentTop = stream.scrollTop;
for (const event of ["load", "error", "loadedmetadata", "toggle", "scroll"]) fire(stream, event);
fire(win, "resize"); resizeObservers.at(-1).fn();
mutationObservers.at(-1).fn([{ type: "characterData", target: stream.children[0] }]);
assert.equal(frames.size, 1, "coalesce concurrent layout events to one frame"); flush();
assert.equal(stream.scrollTop, currentTop, "visibility updates never steal the reader's scroll position");
fire(button, "click"); flush();
assert.equal(stream.lastScroll.behavior, "smooth"); assert.equal(stream.scrollTop, 1800); assert.equal(button.hidden, true);

scroll(0); reducedMotion = true; fire(button, "click"); flush();
assert.equal(stream.lastScroll.behavior, "auto", "respect reduced-motion preference");
assert.equal(button.hidden, true);
stream.scrollHeight += 400; resizeObservers.at(-1).fn(); flush();
assert.equal(button.hidden, false, "late image/content expansion updates navigation without a new scroll event");
const oldMessage = stream.children[0]; oldMessage.parentElement = null;
const newMessage = new Element(); newMessage.isMessage = true; newMessage.parentElement = stream;
stream.children = [newMessage];
mutationObservers.at(-1).fn([{ type: "childList", target: stream }]); flush();
assert.equal(resizeObservers.at(-1).targets.has(oldMessage), false, "stop observing replaced message DOM");
assert.equal(resizeObservers.at(-1).targets.has(newMessage), true);
stream.children = []; mutationObservers.at(-1).fn([{ type: "childList", target: stream }]); flush();
assert.equal(button.hidden, true, "empty/loading/error conversation has no jump control");
stream.children = [newMessage]; stream.scrollHeight = 400; stream.scrollTop = 0;
resizeObservers.at(-1).fn(); flush(); assert.equal(button.hidden, true, "short conversation does not overflow");
stream.scrollHeight = 2400; stream.clientHeight = 0;
resizeObservers.at(-1).fn(); flush(); assert.equal(button.hidden, true, "hidden stream stays quiet");
stream.clientHeight = 600;
run("installChatScrollBottom()");
assert.equal(resizeObservers.at(-2).disconnected, true);
assert.equal(mutationObservers.at(-2).disconnected, true);
assert.equal(button.hidden, false);
fire(stream, "scroll");
const previous = { stream, button };
run("disposeChatScrollBottom()");
assert.equal(frames.size, 0); assert.equal(button.hidden, true);
assert.equal(resizeObservers.at(-1).disconnected, true);
assert.equal(mutationObservers.at(-1).disconnected, true);
fire(previous.stream, "scroll"); fire(win, "resize"); fire(previous.button, "click");
assert.equal(frames.size, 0, "route cleanup detaches all listeners");
mount(); run("installChatScrollBottom()"); assert.equal(button.hidden, true);
stream.isConnected = false; fire(stream, "scroll"); flush(); assert.equal(button.hidden, true);
run("disposeChatScrollBottom()");
console.log("web chat bottom navigation passed (scroll/layout/media updates, reduced motion, no forced following, lifecycle cleanup)");
