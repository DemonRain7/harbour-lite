import type { NovelAiSfwSampling } from "../workflows/novelAiSfwSampling";

/** V4.5's numeric boxes can display an uncommitted React draft after a DOM
 * value assignment. Use keyboard input and Tab, then independently read back.
 * This is used only by the explicitly pinned SFW sampling path. */
export async function configureNovelAiSfwSampling(
  expected: NovelAiSfwSampling,
  command: (args: string[]) => Promise<unknown>,
): Promise<void> {
  assertNovelAiSfwSamplingReadback(await command(["eval", novelAiSfwSamplingScript(expected, true)]), expected);
  const controls = {
    steps: '.image-gen-steps input[type="number"]',
    guidance: '.image-gen-guidance input[type="number"]',
    seed: '.image-gen-seed input[placeholder="Enter a seed"]',
  };
  for (const key of ["steps", "guidance", "seed"] as const) {
    const marker = '[data-harbour-sfw-numeric="true"]';
    const focused = await command(["eval", `(() => {
      for (const e of document.querySelectorAll('${marker}')) e.removeAttribute('data-harbour-sfw-numeric');
      const rows = Array.from(document.querySelectorAll(${JSON.stringify(controls[key])})).filter(e => {
        for (let p=e;p;p=p.parentElement) {const s=getComputedStyle(p);if(s.display==='none'||s.visibility==='hidden'||s.opacity==='0')return false;}
        return e.getBoundingClientRect().width>1 && !e.disabled && !e.readOnly;
      });
      if(rows.length!==1)throw Error('SFW numeric control missing or ambiguous');
      rows[0].setAttribute('data-harbour-sfw-numeric','true');rows[0].focus();
      return {focused:document.activeElement===rows[0]};
    })()`]);
    if (!focused || typeof focused !== "object" || (focused as {focused?:boolean}).focused !== true) {
      throw new Error("SFW numeric control could not receive keyboard focus; Generate not submitted.");
    }
    await command(["keys", "CTRL+A"]);
    await command(["type", marker, String(expected[key])]);
    await command(["keys", "Tab"]);
  }
  assertNovelAiSfwSamplingReadback(await command(["eval", novelAiSfwSamplingScript(expected, false)]), expected);
}

/** A successful CLI transport is not proof that the page verified its controls. */
export function assertNovelAiSfwSamplingReadback(result: unknown, expected: NovelAiSfwSampling): void {
  const row = result && typeof result === "object" ? result as Record<string, unknown> : undefined;
  const actual = row?.actual && typeof row.actual === "object" ? row.actual as Record<string, unknown> : undefined;
  if (row?.verified !== true || !actual || Object.keys(expected).some(key => actual[key] !== expected[key as keyof NovelAiSfwSampling])) {
    throw new Error("SFW sampling 网页读回缺失或不匹配；未通过参数检查，不能提交 Generate。");
  }
}

/** Public DOM controls only. Never submits a generation or touches other model settings. */
export function novelAiSfwSamplingScript(expected: NovelAiSfwSampling, configure: boolean): string {
  return `(async () => {
    const expected = ${JSON.stringify(expected)}, configure = ${JSON.stringify(configure)};
    const visible = e => !!e && e.isConnected && e.getBoundingClientRect().width > 0 &&
      getComputedStyle(e).display !== 'none' && getComputedStyle(e).visibility !== 'hidden';
    const fail = message => new Error('[sfw_sampling] ' + message + '; Generate not submitted by this check');
    const one = selector => {
      const rows = Array.from(document.querySelectorAll(selector)).filter(visible);
      if (rows.length !== 1) throw fail('expected one control: ' + selector);
      return rows[0];
    };
    if (!Array.from(document.querySelectorAll('.image-gen-steps input[type="number"]')).some(visible)) {
      const label = Array.from(document.querySelectorAll('label')).find(e => visible(e) && e.textContent.trim() === 'Steps');
      let panel = label;
      while (panel && !panel.querySelector('input[aria-label="Select a sampler"]')) panel = panel.parentElement;
      if (!panel || panel === document.body) throw fail('cannot locate compact AI settings');
      const buttons = Array.from(panel.querySelectorAll('button')).filter(e => visible(e) && !e.disabled && !e.textContent.trim() && !e.getAttribute('aria-label'));
      if (buttons.length !== 1) throw fail('ambiguous AI settings expander');
      buttons[0].click();
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    const controls = {
      steps: () => one('.image-gen-steps input[type="number"]'),
      guidance: () => one('.image-gen-guidance input[type="number"]'),
      seed: () => one('.image-gen-seed input[placeholder="Enter a seed"]'),
    };
    if (configure) {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      for (const key of ['steps','guidance','seed']) {
        const input = controls[key]();
        if (input.disabled || input.readOnly) throw fail(key + ' is not editable');
        // DOM draft/readback only; configureNovelAiSfwSampling also performs
        // real keyboard input before this can be used for a paid submission.
        input.focus();
        setter.call(input, String(expected[key]));
        input.dispatchEvent(new Event('input', {bubbles:true}));
        input.dispatchEvent(new Event('change', {bubbles:true}));
        await new Promise(resolve => setTimeout(resolve, 120));
        input.blur();
        await new Promise(resolve => setTimeout(resolve, 120));
      }
    }
    const samplerControl = () => one('.image-gen-sampler input[aria-label="Select a sampler"]');
    const selected = () => samplerControl().closest('.select')?.querySelector('[class*="-singleValue"]')?.textContent.trim();
    if (configure && selected() !== expected.sampler) {
      const sampler = samplerControl();
      sampler.focus();
      sampler.dispatchEvent(new KeyboardEvent('keydown', {key:'ArrowDown',code:'ArrowDown',keyCode:40,which:40,bubbles:true}));
      await new Promise(resolve => setTimeout(resolve, 200));
      const options = Array.from(document.querySelectorAll('[role="option"]')).filter(e => visible(e) && e.textContent.trim() === expected.sampler);
      if (options.length !== 1) throw fail('sampler option absent or ambiguous');
      options[0].click();
      await new Promise(resolve => setTimeout(resolve, 120));
    }
    const actual = {steps:Number(controls.steps().value),guidance:Number(controls.guidance().value),seed:controls.seed().value === '' ? null : Number(controls.seed().value),sampler:selected()};
    for (const key of Object.keys(expected)) if (actual[key] !== expected[key]) throw fail(key + ' readback mismatch: ' + actual[key] + ' != ' + expected[key]);
    return {verified:true,configured:configure,actual,noiseSchedule:'not-controlled'};
  })()`;
}
