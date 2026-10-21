/** Page helpers never upload, select a model, or submit Generate. The explicit
 * reset helper only removes an existing reference within the precise panel. */
const visibleScript = `const visible = el => { const style = getComputedStyle(el), rect = el.getBoundingClientRect();
  return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0' && rect.width > 1 && rect.height > 1; };`;

const modelScript = `const normalizeModel = value => {
  const compact = String(value || '').trim().toLowerCase().replace(/^nai[\\s-]+diffusion[\\s-]+/, '').replace(/^v/, '').replace(/[\\s_-]/g, '');
  const known = { '5full': 'V5 Full', '5curated': 'V5 Curated', '4.5full': 'V4.5 Full', '45full': 'V4.5 Full',
    '4.5curated': 'V4.5 Curated', '45curated': 'V4.5 Curated', '4full': 'V4 Full', '4curated': 'V4 Curated' };
  return known[compact] || null;
};
const modelInputs = Array.from(document.querySelectorAll('input[aria-label="Select the Model"]'));
const modelContainers = [...new Set(modelInputs.map(input => input.closest('.select')).filter(Boolean))];
const visibleModels = modelContainers.filter(visible);
const modelNames = [...new Set((visibleModels.length ? visibleModels : modelContainers)
  .map(el => normalizeModel((el.querySelector('[class*="-singleValue"]') || el).textContent)))];
const model = modelNames.length === 1 ? modelNames[0] : null;`;

/** Frozen models are compared, never silently replaced. Unknown labels fail closed. */
export function novelAiModelCheckScript(expectedModel: string): string {
  return `(() => {
    ${visibleScript}
    ${modelScript}
    const expectedModel = normalizeModel(${JSON.stringify(expectedModel)});
    return { modelCheck: true, model, expectedModel, modelMatches: !!model && !!expectedModel && model === expectedModel };
  })()`;
}

/** Legacy callers lacking a frozen model still cannot submit precise references
 * on a model that does not support them. Read-only, safe for the atomic guard. */
export function novelAiPreciseReferenceModelCheckScript(): string {
  return `(() => {
    ${visibleScript}
    ${modelScript}
    return { modelCheck: true, model, modelMatches: !!model && /^V4\\.5 (Full|Curated)$/.test(model) };
  })()`;
}

export const NOVEL_AI_PRECISE_REFERENCE_INPUT_SELECTOR = 'input[type="file"][data-harbour-precise-reference-input="true"]';

/** Resolve the currently displayed responsive panel, not an LLM-supplied file
 * selector. Hidden file inputs are valid; their parent panel must be displayed.
 * The marker is an ephemeral locator only, not evidence of an applied reference. */
export function novelAiPreciseReferenceInputScript(expectedModel?: string): string {
  return `(() => {
    ${visibleScript}
    ${modelScript}
    for (const el of document.querySelectorAll('[data-harbour-precise-reference-input]')) el.removeAttribute('data-harbour-precise-reference-input');
    const expectedModel = ${expectedModel === undefined ? "null" : `normalizeModel(${JSON.stringify(expectedModel)})`};
    const base = { referenceInput: true, model, expectedModel };
    if (!model) return { ...base, status: 'model_unknown', reason: 'Cannot uniquely identify the selected NovelAI model.' };
    ${expectedModel === undefined ? "" : `if (!expectedModel || model !== expectedModel) return { ...base, status: 'model_mismatch', reason: 'The page model does not match the frozen model; no upload was attempted.' };`}
    if (!/^V4\\.5 (Full|Curated)$/.test(model)) return { ...base, status: 'unsupported_model', reason: 'Precise Reference is currently supported only by V4.5; this page model cannot accept a character reference.' };
    const roots = Array.from(document.querySelectorAll('.image-gen-character-references')).filter(visible);
    if (roots.length !== 1) return { ...base, status: roots.length ? 'reference_panel_ambiguous' : 'reference_panel_missing',
      reason: 'A unique displayed Precise Reference panel is required.', panelCount: roots.length };
    const root = roots[0];
    const inputs = Array.from(root.querySelectorAll('input[type="file"]')).filter(input =>
      !input.disabled && input.closest('.image-gen-character-references') === root &&
      !input.closest('.image-gen-input-image,.image-gen-vibe-transfer'));
    if (inputs.length !== 1) return { ...base, status: inputs.length ? 'reference_input_ambiguous' : 'reference_input_missing',
      reason: 'The Precise Reference panel must contain exactly one enabled file input.', inputCount: inputs.length };
    inputs[0].setAttribute('data-harbour-precise-reference-input', 'true');
    return { ...base, status: 'ready', selector: ${JSON.stringify(NOVEL_AI_PRECISE_REFERENCE_INPUT_SELECTOR)} };
  })()`;
}

/** Remove at most one existing precise reference. The caller can re-inspect
 * between removals; no Image2Image/Vibe/global trash controls are considered. */
export function novelAiClearPreciseReferenceScript(): string {
  return `(() => {
    ${visibleScript}
    const roots = Array.from(document.querySelectorAll('.image-gen-character-references')).filter(visible);
    if (roots.length > 1) throw new Error('Cannot clear ambiguous Precise Reference panels.');
    const root = roots[0];
    if (!root) return { preciseReferenceCleared: true, clicked: 0, remainingCandidates: 0 };
    const trash = /\\/trash[.-][^/\\)"'?]*\\.svg(?:[?"')]|$)/i;
    const buttons = Array.from(root.querySelectorAll('button')).filter(button => visible(button) && !button.disabled &&
      button.closest('.image-gen-character-references') === root && !button.closest('.image-gen-input-image,.image-gen-vibe-transfer') &&
      Array.from(button.querySelectorAll('*')).some(icon => { const style = getComputedStyle(icon);
        return trash.test(String(style.maskImage || style.webkitMaskImage || '')); }));
    if (buttons.length > 8) throw new Error('Too many Precise Reference removal controls.');
    if (buttons[0]) buttons[0].click();
    return { preciseReferenceCleared: true, clicked: buttons.length ? 1 : 0, remainingCandidates: Math.max(0, buttons.length - 1) };
  })()`;
}

/** Actual NAI previews are CSS background images, not necessarily <img>s.
 * Local blob/data sources only; no image bytes leave the page. A small page-local
 * Image cache lets the caller poll decoding, while the final pre-Generate check
 * remains synchronous. Pending/invalid/mode errors must never count as an empty
 * baseline. Fingerprints are change detectors, not server-side attestations. */
export function novelAiPreciseReferenceSnapshotScript(): string {
  return `(() => {
    ${visibleScript}
    ${modelScript}
    const allRoots = Array.from(document.querySelectorAll('.image-gen-character-references'));
    const roots = allRoots.filter(visible);
    const sources = new Map();
    let invalidModes = 0, invalidPreviews = (!allRoots.length && /^V4\\.5 (Full|Curated)$/.test(model || '')) ||
      (!roots.length && allRoots.some(root => root.querySelectorAll('[role="combobox"]').length)) ? 1 : 0, disabledReferences = 0;
    const local = src => src.startsWith('blob:') || src.startsWith('data:image/');
    for (const root of roots) {
      const previews = Array.from(root.querySelectorAll('img,[style*="background-image"]')).filter(visible);
      const collected = [];
      for (const el of previews) {
        if (el.closest('.image-gen-input-image,.image-gen-vibe-transfer')) continue;
        if (String(el.tagName).toLowerCase() === 'img') {
          const src = String(el.currentSrc || el.src || '');
          if (local(src)) collected.push({ src, image: el });
        } else {
          const background = String(getComputedStyle(el).backgroundImage || '');
          const match = /^url\\(\\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\\s*\\)$/.exec(background);
          const src = (match && (match[1] || match[2] || match[3]) || '').trim();
          if (local(src)) collected.push({ src });
        }
      }
      const modeSelects = [...new Set(Array.from(root.querySelectorAll('[role="combobox"]'))
        .map(input => input.closest('.select')).filter(Boolean))];
      if (!collected.length) {
        if (modeSelects.length) invalidPreviews++;
        continue;
      }
      if (modeSelects.length !== new Set(collected.map(item => item.src)).size) { invalidPreviews++; continue; }
      const inactive = modeSelects.some(select => { for (let el = select; el && el !== root; el = el.parentElement) {
        const opacity = Number.parseFloat(getComputedStyle(el).opacity);
        if (Number.isFinite(opacity) && opacity < 1) return true;
      } return false; });
      if (inactive) { disabledReferences++; continue; }
      const modes = [...new Set(modeSelects.map(select => String((select.querySelector('[class*="-singleValue"]') || select).textContent || '').replace(/\\s+/g, ' ').trim()))];
      if (!modes.length || modes.some(mode => !/^(?:Character|Character\\s*&\\s*Style)$/i.test(mode))) { invalidModes++; continue; }
      for (const item of collected) if (!sources.has(item.src) || item.image) sources.set(item.src, item);
    }
    const cacheKey = '__harbourNovelAiPrecisePreviewCache';
    let state = globalThis[cacheKey];
    if (!state || state.document !== document || !(state.images instanceof Map)) state = globalThis[cacheKey] = { document, images: new Map() };
    for (const src of state.images.keys()) if (!sources.has(src)) state.images.delete(src);
    const fingerprints = new Set();
    let pending = 0;
    if (sources.size > 8) return { referenceSnapshot: true, fingerprints: [], pending: 0, invalidModes, invalidPreviews: sources.size, disabledReferences, panelCount: roots.length };
    for (const [src, item] of sources) {
      let image = item.image || state.images.get(src);
      if (!image) { image = new Image(); state.images.set(src, image); image.src = src; }
      if (!image.complete) { pending++; continue; }
      if (!(image.naturalWidth > 0 && image.naturalHeight > 0)) { invalidPreviews++; continue; }
      let a = 2166136261, b = 5381;
      for (let i = 0; i < src.length; i++) { a = Math.imul(a ^ src.charCodeAt(i), 16777619); b = Math.imul(b, 33) ^ src.charCodeAt(i); }
      fingerprints.add(src.length + ':' + (a >>> 0).toString(16) + ':' + (b >>> 0).toString(16) + ':' + image.naturalWidth + 'x' + image.naturalHeight);
    }
    return { referenceSnapshot: true, fingerprints: [...fingerprints].sort(), pending, invalidModes, invalidPreviews, disabledReferences, panelCount: roots.length };
  })()`;
}
