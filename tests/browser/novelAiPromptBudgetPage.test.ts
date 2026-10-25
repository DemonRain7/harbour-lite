import assert from "node:assert/strict";
import vm from "node:vm";
import {
  novelAiPromptBudgetProofScript,
  novelAiPromptAuditScript,
  novelAiPromptCounterClearScript,
  novelAiPromptCounterReadScript,
  novelAiPromptCounterTargetScript,
  novelAiPromptCounterPreparationScript,
} from "../../src/core/tools/novelAiPromptBudgetPage";
import { novelAiGenerateScript } from "../../src/core/tools/openCliBrowser";

// Offline neutral DOM/VM fixture. No website, browser, profiles, tokens or account.
class Element {
  attrs = new Map<string, string>();
  style = { display: "block", visibility: "visible", opacity: "1" };
  parentElement: Element | null = null;
  children: Element[] = [];
  className = "";
  innerText = "";
  value = "";
  checked = false;
  disabled = false;
  tagName = "DIV";
  hovered = false;
  isConnected = true;
  clicks = 0;
  get textContent() { return this.innerText; }
  getBoundingClientRect() { return { width: 100, height: 30, top: 10, left: 10, right: 110, bottom: 40 }; }
  setAttribute(name: string, value: string) { this.attrs.set(name, value); }
  getAttribute(name: string) { return this.attrs.get(name) ?? null; }
  removeAttribute(name: string) { this.attrs.delete(name); }
  scrollIntoView() {}
  click() { this.clicks++; }
  add(...children: Element[]) { for (const child of children) { child.parentElement = this; this.children.push(child); } return this; }
  contains(element: Element): boolean { return this === element || this.children.some(child => child.contains(element)); }
  matches(selector: string): boolean {
    if (selector === ":hover") return this.hovered;
    if (selector.startsWith(".")) return this.className.split(/\s+/).includes(selector.slice(1));
    const match = /^(\w+)?(?:\[([^=\]]+)(?:="([^"]*)")?\])?$/.exec(selector.trim());
    if (!match) throw new Error(`Unsupported neutral fixture selector ${selector}`);
    if (match[1] && this.tagName.toLowerCase() !== match[1]) return false;
    return !match[2] || (match[3] === undefined ? this.attrs.has(match[2]) : this.attrs.get(match[2]) === match[3]);
  }
  closest(selector: string): Element | null {
    for (let element: Element | null = this; element; element = element.parentElement) if (element.matches(selector)) return element;
    return null;
  }
  querySelectorAll(selector: string): Element[] {
    const selectors = selector.split(",").map(item => item.trim());
    return this.children.flatMap(child => [
      ...(selectors.some(item => child.matches(item)) ? [child] : []), ...child.querySelectorAll(selector),
    ]);
  }
  querySelector(selector: string) { return this.querySelectorAll(selector)[0] ?? null; }
}

type Mutation = { type: string; target?: Element; attributeName?: string };
function fixture() {
  const root = new Element(); root.attrs.set("data-prompt-input", "true"); root.innerText = "adult librarian reading an atlas";
  const editor = new Element(); editor.attrs.set("data-harbour-richtext-target", "positive"); editor.attrs.set("contenteditable", "true");
  const target = new Element();
  const bar = new Element(); bar.className = "sc-427b8d4-1"; target.add(bar); root.add(editor, target);
  const reference = new Element(); reference.tagName = "INPUT"; reference.attrs.set("type", "file");
  const generate = new Element(); generate.tagName = "BUTTON"; generate.innerText = "Generate 1 Image 0 Anlas";
  const body = new Element(); body.innerText = "Anlas 100"; body.add(root, reference, generate);
  const tooltips: Element[] = [];
  const roots = [root];
  const handlers = new Map<string, Set<(event: { target: Element }) => void>>();
  const observations: Array<{ observer: Observer; target: Element; options: Record<string, unknown> }> = [];
  let ticks = 0;
  let onTick: ((tick: number) => void) | undefined;
  class Observer {
    disconnected = false;
    constructor(readonly callback: (records: Mutation[]) => void) {}
    observe(target: Element, options: Record<string, unknown>) { observations.push({ observer: this, target, options }); }
    disconnect() { this.disconnected = true; }
  }
  const all = () => [...roots, ...roots.flatMap(item => item.querySelectorAll("div,input,select,button")), reference, generate, ...tooltips];
  const document = {
    body,
    querySelectorAll(selector: string): Element[] {
      if (selector === '[data-popper-placement] p,[role="tooltip"] p') return tooltips;
      return all().filter(element => selector.split(",").some(item => element.matches(item.trim())));
    },
    querySelector(selector: string) { return this.querySelectorAll(selector)[0] ?? null; },
    addEventListener(name: string, handler: (event: { target: Element }) => void) {
      if (!handlers.has(name)) handlers.set(name, new Set()); handlers.get(name)!.add(handler);
    },
    removeEventListener(name: string, handler: (event: { target: Element }) => void) { handlers.get(name)?.delete(handler); },
  };
  const realm = vm.createContext({ document, getComputedStyle: (element: Element) => element.style, MutationObserver: Observer,
    setTimeout(callback: () => void) { ticks++; onTick?.(ticks); callback(); } });
  const run = (script: string) => vm.runInContext(script, realm);
  const dispatch = (type: string, element: Element) => { for (const handler of handlers.get(type) ?? []) handler({ target: element }); };
  const mutate = (target: Element, type: string, attributeName?: string) => {
    for (const row of observations) {
      if (row.observer.disconnected || !(row.target === target || row.options.subtree && row.target.contains(target))) continue;
      if (row.options[type] === true || type === "attributes" && row.options.attributes === true) row.observer.callback([{ type, target, attributeName }]);
    }
  };
  const install = (nonce = "measured") => run(novelAiPromptBudgetProofScript(nonce, true));
  const verify = (nonce = "measured") => run(novelAiPromptBudgetProofScript(nonce));
  const submit = (nonce = "measured") => run(novelAiGenerateScript(0, 1, 0, undefined, undefined, undefined, nonce));
  const tooltip = (count: number) => { const element = new Element(); element.tagName = "P";
    element.innerText = `This prompt is using ${count} of the currently used NaN tokens. Max total tokens: 512`;
    tooltips.push(element); return element; };
  return { root, roots, editor, target, bar, reference, generate, tooltips, tooltip, run, dispatch, mutate, install, verify, submit,
    handlers, observations, setTick: (fn: (tick: number) => void) => { onTick = fn; }, tickCount: () => ticks };
}

async function main() {
  let f = fixture();
  assert.throws(() => f.verify(), /unverified|not submitted/);
  assert.throws(() => f.submit(), /unverified|not submitted/);
  assert.equal(f.generate.clicks, 0, "an absent proof cannot activate Generate");
  f.install();
  assert.equal(f.verify().verified, true);
  assert.throws(() => f.verify("other-job"), /unverified|not submitted/);
  assert.equal(f.generate.clicks, 0);
  f.dispatch("input", f.reference);
  f.mutate(f.reference, "childList");
  assert.equal(f.verify().verified, true, "reference uploads outside prompt roots must not invalidate prompt proof");
  assert.equal(f.submit().activated, true);
  assert.equal(f.generate.clicks, 1);

  for (const event of ["input", "change"]) {
    f = fixture(); f.install(); f.dispatch(event, f.editor);
    assert.throws(() => f.verify(), /changed|unverified/);
    assert.throws(() => f.submit(), /changed|unverified/);
    assert.equal(f.generate.clicks, 0, `${event} after measurement cannot submit`);
  }
  for (const mutation of ["childList", "characterData"]) {
    f = fixture(); f.install(); f.mutate(f.editor, mutation);
    assert.throws(() => f.verify(), /changed|unverified/, `prompt ${mutation} invalidates evidence even if visible text returns to the old value`);
  }
  f = fixture(); f.install(); f.root.innerText = "a different neutral scene";
  assert.throws(() => f.submit(), /changed|unverified/, "snapshot catches a silent text change before observer delivery");
  assert.equal(f.generate.clicks, 0);
  f = fixture(); const preset = new Element(); preset.tagName = "SELECT"; preset.value = "light"; f.root.add(preset);
  f.install(); preset.value = "heavy";
  assert.throws(() => f.verify(), /changed|unverified/, "silent select changes invalidate preset evidence");
  for (const property of ["checked", "aria-pressed", "aria-selected"]) {
    f = fixture(); const control = new Element(); control.tagName = "INPUT"; f.root.add(control);
    if (property !== "checked") control.attrs.set(property, "false");
    f.install();
    if (property === "checked") control.checked = true; else control.attrs.set(property, "true");
    assert.throws(() => f.verify(), /changed|unverified/, `${property} changes cannot reuse a measured preset`);
  }
  f = fixture(); f.install(); f.roots.push(new Element());
  f.roots[1]!.attrs.set("data-prompt-input", "true");
  assert.throws(() => f.verify(), /changed|unverified/, "adding a prompt field makes the old readings incomplete");
  f = fixture(); f.roots.length = 0;
  assert.throws(() => f.install(), /no editors/);
  f = fixture(); f.install("first"); const previousObservers = [...f.observations];
  f.install("second");
  assert.ok(previousObservers.every(row => row.observer.disconnected), "reinstallation disconnects old observers");
  assert.equal(f.handlers.get("input")?.size, 1, "reinstallation removes old input listeners");
  assert.equal(f.handlers.get("change")?.size, 1, "reinstallation removes old change listeners");
  assert.throws(() => f.verify("first"), /unverified/);
  assert.equal(f.verify("second").verified, true);

  f = fixture();
  f.run(novelAiPromptAuditScript("audit", true));
  f.dispatch("change", f.reference); f.mutate(f.reference, "childList");
  assert.equal(f.run(novelAiPromptAuditScript("audit", false)).verified, true, "reference events do not alter prompt measurements");
  for (const edit of ["input", "change", "characterData", "childList"]) {
    f = fixture(); f.run(novelAiPromptAuditScript("audit", true));
    if (edit === "input" || edit === "change") f.dispatch(edit, f.editor); else f.mutate(f.editor, edit);
    assert.throws(() => f.run(novelAiPromptAuditScript("audit", false)), /edited during token audit/,
      `${edit} between measured fields cannot be blessed by later proof installation`);
  }
  f = fixture(); f.run(novelAiPromptAuditScript("audit", true));
  assert.throws(() => f.run(novelAiPromptAuditScript("different-audit", false)), /edited during token audit/);

  f = fixture();
  assert.equal(f.run(novelAiPromptCounterTargetScript("positive")).targeted, true);
  f.target.hovered = true;
  f.setTick(tick => { if (tick === 1) f.tooltip(42); });
  const result = await f.run(novelAiPromptCounterReadScript("positive"));
  assert.equal(result.text, "This prompt is using 42 of the currently used NaN tokens. Max total tokens: 512");
  assert.ok(f.tickCount() >= 3, "one observation is not stable evidence");
  f = fixture(); f.root.add(new Element()); f.root.children[2]!.className = "sc-427b8d4-1";
  assert.throws(() => f.run(novelAiPromptCounterTargetScript("positive")), /unavailable/);
  f = fixture(); f.editor.style.visibility = "hidden";
  assert.throws(() => f.run(novelAiPromptCounterTargetScript("positive")), /unavailable/);
  f = fixture(); f.bar.className = "sc-bf0df139-1";
  assert.equal(f.run(novelAiPromptCounterTargetScript("positive")).targeted, true,
    "current website layout works without a content-rating or experimental-style flag");
  f.target.hovered = true; f.tooltip(172);
  assert.match((await f.run(novelAiPromptCounterReadScript("positive"))).text, /using 172/,
    "the new layout still reads the site's actual tooltip, never estimates tokens");
  f = fixture(); const secondMeter = new Element(); secondMeter.className = "sc-bf0df139-1"; f.root.add(secondMeter);
  assert.throws(() => f.run(novelAiPromptCounterTargetScript("positive")), /unavailable/,
    "two different meter versions in the same field remain ambiguous");
  f = fixture(); f.bar.className = "unknown-layout";
  assert.throws(() => f.run(novelAiPromptCounterTargetScript("positive")), (error: any) => error.harbourCounterReason === "token-meter-missing",
    "unknown website changes still fail closed, never guess a generic progress bar");
  f = fixture(); const unrelatedRoot = new Element(); unrelatedRoot.attrs.set("data-prompt-input", "true");
  const unrelatedBar = new Element(); unrelatedBar.className = "sc-bf0df139-1"; unrelatedRoot.add(unrelatedBar); f.root.add(unrelatedRoot);
  assert.equal(f.run(novelAiPromptCounterTargetScript("positive")).targeted, true, "nested field meters cannot be mistaken for this field");

  // Exercise the real preparation envelope, without echoing either page text or
  // submitted script text when scope, frozen-text verification, or targeting fails.
  for (const [prepare, verify, expected] of [
    ["(() => { throw Error('private prompt in scope error') })()", "({verified:true})", { step: "editor-target", reason: "page-step-failed" }],
    ["({prepared:true})", "({verified:false,actual:'private changed prompt'})", { step: "frozen-prompt", reason: "frozen-prompt-mismatch" }],
    ["({prepared:true})", "(() => { throw Error('private verification text') })()", { step: "frozen-prompt", reason: "page-step-failed" }],
  ] as const) {
    f = fixture();
    const result = await f.run(novelAiPromptCounterPreparationScript(prepare, verify, "positive"));
    assert.equal(result.prepared, false);
    assert.deepEqual(JSON.parse(JSON.stringify(result.failure)), expected);
    assert.ok(!JSON.stringify(result).includes("private"));
    assert.equal(f.target.getAttribute("data-harbour-token-target"), null, "failed preparation cannot proceed to hover/read");
  }
  for (const layout of ["sc-427b8d4-1", "sc-bf0df139-1", "unknown-layout"]) {
    f = fixture(); f.bar.className = layout;
    const result = await f.run(novelAiPromptCounterPreparationScript("({prepared:true})", "({verified:true})", "positive"));
    assert.equal(result.prepared, layout !== "unknown-layout");
    if (layout === "unknown-layout") assert.deepEqual(JSON.parse(JSON.stringify(result.failure)), { step: "token-meter", reason: "token-meter-missing" });
  }
  f = fixture();
  await assert.rejects(f.run(novelAiPromptCounterReadScript("positive")), /disappeared|not hovered/);
  f = fixture(); f.run(novelAiPromptCounterTargetScript("positive")); f.target.hovered = true; f.tooltip(1); f.tooltip(2);
  await assert.rejects(f.run(novelAiPromptCounterReadScript("positive")), /unavailable|unstable/);

  // A tooltip from the previously visited lane cannot become proof for this one.
  f = fixture(); f.tooltip(7); f.run(novelAiPromptCounterTargetScript("positive"));
  await assert.rejects(f.run(novelAiPromptCounterClearScript()), /did not close|not submitted/,
    "the required clear step cannot admit a tooltip left over from the preceding lane");
  f = fixture(); const oldTooltip = f.tooltip(7); oldTooltip.style.visibility = "hidden";
  assert.equal((await f.run(novelAiPromptCounterClearScript())).cleared, true);
  f = fixture(); f.tooltip(7); f.setTick(tick => { if (tick === 2) f.tooltips.length = 0; });
  assert.equal((await f.run(novelAiPromptCounterClearScript())).cleared, true, "the clear step waits for a delayed close");
  f = fixture(); f.run(novelAiPromptCounterTargetScript("positive")); f.tooltip(7);
  await assert.rejects(f.run(novelAiPromptCounterReadScript("positive")), /not hovered/);

  for (const drift of ["unhovered", "removed", "hidden"] as const) {
    f = fixture(); f.run(novelAiPromptCounterTargetScript("positive")); f.target.hovered = true; f.tooltip(7);
    f.setTick(tick => { if (tick !== 1) return;
      if (drift === "unhovered") f.target.hovered = false;
      if (drift === "removed") f.target.isConnected = false;
      if (drift === "hidden") f.target.style.visibility = "hidden";
    });
    await assert.rejects(f.run(novelAiPromptCounterReadScript("positive")), /not hovered|not submitted/,
      `${drift} meter while its asynchronous tooltip settles must invalidate the reading`);
  }

  console.log("PASS neutral NovelAI token page: scoped meter, fresh counter, proof lifetime, atomic Generate, reference-upload isolation");
}

main().catch(error => { console.error(error); process.exitCode = 1; });
