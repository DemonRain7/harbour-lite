import type { ToolContext } from "../../types";

/** Public DOM-only model selection. These helpers never upload or Generate. */
function selectableModel(expectedModel: string): string {
  if (typeof expectedModel !== "string") throw new Error("NovelAI model selection requires a frozen model name.");
  const name = expectedModel.trim().replace(/^NAI Diffusion /, "");
  if (name !== "V4.5 Full" && name !== "V5 Full") {
    throw new Error("NovelAI automatic model selection supports only V4.5 Full or V5 Full.");
  }
  return `NAI Diffusion ${name}`;
}

const modelInputScript = `
const visible = el => {
  if (!el || !el.isConnected) return false;
  const rect = el.getBoundingClientRect();
  if (!(rect.width > 1 && rect.height > 1)) return false;
  for (let current = el; current; current = current.parentElement) {
    const style = getComputedStyle(current);
    if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' ||
        Number.parseFloat(style.opacity) === 0) return false;
  }
  return true;
};
const inputs = Array.from(document.querySelectorAll('input[aria-label="Select the Model"]'))
  // React-Select may use an opacity:0, one-pixel focus input. Visibility
  // belongs to its displayed select container; focus is verified separately.
  .filter(input => input.isConnected && visible(input.closest('.select')));
if (inputs.length !== 1) throw new Error('NovelAI model selection requires exactly one visible model input.');
const input = inputs[0];
if (input.disabled || input.getAttribute('aria-disabled') === 'true') throw new Error('NovelAI model input is disabled.');
`;

/** The caller opens the native dropdown with ArrowDown after successful focus. */
export function novelAiModelFocusScript(expectedModel: string): string {
  const model = selectableModel(expectedModel);
  return `(() => {
    ${modelInputScript}
    input.focus();
    if (document.activeElement !== input) throw new Error('NovelAI model input could not be focused.');
    return { focused: true, model: ${JSON.stringify(model)} };
  })()`;
}

/** Reference-only menu compatibility: some OpenCLI key dispatchers omit the
 * legacy keyCode React-Select currently needs. Never called for the V5 path. */
export function novelAiReferenceModelOpenScript(expectedModel: string): string {
  if (selectableModel(expectedModel) !== "NAI Diffusion V4.5 Full") throw new Error("Reference model menu helper only supports V4.5 Full.");
  return `(() => {
    ${modelInputScript}
    if (document.activeElement !== input) throw new Error('NovelAI reference model input lost focus.');
    if (input.getAttribute('aria-expanded') !== 'true') {
      input.dispatchEvent(new KeyboardEvent('keydown', {key:'ArrowDown', code:'ArrowDown', keyCode:40, bubbles:true}));
    }
    return { referenceModelMenuOpened: true };
  })()`;
}

/** Click one exact visible option; the caller must re-read the selected model. */
export function novelAiModelSelectScript(expectedModel: string): string {
  const model = selectableModel(expectedModel);
  return `(() => {
    ${modelInputScript}
    if (document.activeElement !== input) throw new Error('NovelAI model input lost focus before selection.');
    const expectedModel = ${JSON.stringify(model)};
    const options = Array.from(document.querySelectorAll('[role="option"]')).filter(option => {
      if (!visible(option)) return false;
      const firstLine = String(option.innerText ?? option.textContent ?? '').trim().split(/\\r?\\n/, 1)[0].trim();
      return firstLine === expectedModel;
    });
    if (options.length !== 1) throw new Error('NovelAI model selection requires exactly one visible exact model option.');
    const option = options[0];
    if (option.disabled || option.getAttribute('aria-disabled') === 'true') throw new Error('NovelAI model option is disabled.');
    option.click();
    return { selected: true, model: expectedModel };
  })()`;
}

/** One bounded public-DOM transaction. Opening the dropdown is not proof that
 * its asynchronous menu exists, and clicking an option is not model readback.
 * The keyboard event includes the legacy code React-Select needs on both paths.
 * No guessed CSS classes, global option search, fixed sleeps or paid actions. */
export function novelAiModelSelectionScript(expectedModel: string): string {
  const model = selectableModel(expectedModel);
  return `(async () => {
    ${modelInputScript}
    const expectedModel = ${JSON.stringify(model)};
    const control = input.closest('.select');
    const normalize = value => {
      const text = String(value || '').trim();
      return text === 'V4.5 Full' || text === 'V5 Full' ? 'NAI Diffusion ' + text : text;
    };
    const selected = () => normalize(control.querySelector('[class*="-singleValue"]')?.textContent);
    const fail = code => new Error('[novelai_model_selection:' + code + '] ' + expectedModel +
      '; no Generate was attempted by this model-selection step. Stop preparation; do not guess selectors or change the frozen model.');
    const waitFor = (read, timeoutCode) => new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => { observer.disconnect(); clearTimeout(timer); };
      const finish = (error, value) => {
        if (settled) return;
        settled = true; cleanup(); error ? reject(error) : resolve(value);
      };
      const check = () => {
        try { const value = read(); if (value) finish(null, value); }
        catch (error) { finish(error); }
      };
      const observer = new MutationObserver(check);
      const timer = setTimeout(() => finish(fail(timeoutCode)), 4000);
      observer.observe(document.documentElement, {subtree:true, childList:true, attributes:true, characterData:true});
      check();
    });
    if (selected() === expectedModel) return {modelSelection:true, verified:true, changed:false, model:expectedModel};
    input.focus();
    if (document.activeElement !== input) throw fail('focus_failed');
    if (input.getAttribute('aria-expanded') !== 'true') {
      input.dispatchEvent(new KeyboardEvent('keydown', {
        key:'ArrowDown', code:'ArrowDown', keyCode:40, which:40, bubbles:true, cancelable:true
      }));
    }
    const option = await waitFor(() => {
      if (!input.isConnected || !control.isConnected || document.activeElement !== input) throw fail('focus_lost');
      if (input.getAttribute('aria-expanded') !== 'true') return null;
      const ids = String(input.getAttribute('aria-controls') || input.getAttribute('aria-owns') || '').trim().split(/\\s+/).filter(Boolean);
      const menus = (ids.length ? ids.map(id => document.getElementById(id)) :
        Array.from(control.querySelectorAll('[role="listbox"]'))).filter(menu =>
          menu && menu.getAttribute('role') === 'listbox' && visible(menu));
      if (menus.length > 1) throw fail('menu_ambiguous');
      if (!menus.length) return null;
      const options = Array.from(menus[0].querySelectorAll('[role="option"]')).filter(visible);
      const matches = options.filter(candidate => normalize(String(candidate.innerText ?? candidate.textContent ?? '')
        .trim().split(/\\r?\\n/, 1)[0]) === expectedModel);
      if (matches.length > 1) throw fail('option_ambiguous');
      if (!matches.length) return null;
      if (matches[0].disabled || matches[0].getAttribute('aria-disabled') === 'true') throw fail('option_disabled');
      return matches[0];
    }, 'menu_or_option_timeout');
    option.click();
    await waitFor(() => {
      if (!control.isConnected) throw fail('control_replaced');
      return selected() === expectedModel && input.getAttribute('aria-expanded') !== 'true';
    }, 'selected_model_unconfirmed');
    return {modelSelection:true, verified:true, changed:true, model:expectedModel};
  })()`;
}

const selectionFailureKey = "novelai:model-selection-failure";
const afterFailureObservations = new Set([
  "adapter:match", "state", "snapshot", "extract", "get", "find", "inspect_novelai", "tabs", "close", "handoff", "wait", "screenshot", "collect_novelai_result",
]);

/** A failed bounded selector returns to Workflow, never to LLM click guessing.
 * This is a run-local stop, not a paid-attempt flag or a ledger modification. */
export function markNovelAiModelSelectionFailed(ctx: ToolContext): void {
  if (!ctx.execution?.novelAiSubmission?.form) return;
  ctx.runState ??= new Map();
  ctx.runState.set(selectionFailureKey, ctx.execution.novelAiSubmission.onceKey);
}

/** Call before recording/dispatching a rejected action. It must not turn a
 * proven pre-submit failure into uncertain merely because fallback was denied. */
export function assertNovelAiModelSelectionUsable(ctx: ToolContext, action: string): void {
  const submission = ctx.execution?.novelAiSubmission;
  if (!submission?.form || ctx.runState?.get(selectionFailureKey) !== submission.onceKey || afterFailureObservations.has(action)) return;
  throw new Error("NovelAI 固定模型选择未确认，本轮停止表单准备；不得改模型、猜 selector、重复准备或通过通用点击/键盘兜底。仅保留观察与 handoff，然后交回 Workflow；本次拦截未执行页面操作。");
}
