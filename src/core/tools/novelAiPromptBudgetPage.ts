// Read the website's own tokenizer, including its active quality/UC presets.
// Do not substitute character counts or a generic LLM tokenizer for T5 tokens.
const visible = `const visible = el => { const s=getComputedStyle(el), r=el.getBoundingClientRect();
  return s.display!=="none" && s.visibility!=="hidden" && s.opacity!=="0" && r.width>1 && r.height>1; };`;

export function novelAiPromptCounterTargetScript(marker: string, allowSfwCurrentLayout = false): string {
  // The opt-in SFW experiment observed this replacement styled-component on
  // 2026-10-18. Legacy/NSFW behavior stays unchanged until separately reviewed.
  // Both versions still require one scoped meter and the site's fresh tooltip.
  const meterSelector = allowSfwCurrentLayout ? ".sc-427b8d4-1,.sc-bf0df139-1" : ".sc-427b8d4-1";
  return `(() => {
    ${visible}
    const editor=document.querySelector('[data-harbour-richtext-target="'+${JSON.stringify(marker)}+'"]');
    const root=editor?.closest('[data-prompt-input="true"]');
    // Stable styled-component ID observed on NovelAI's token meter. A layout
    // change must fail closed instead of accidentally reading another meter.
    const bars=root ? Array.from(root.querySelectorAll(${JSON.stringify(meterSelector)})).filter(visible) : [];
    if(!editor || !visible(editor) || bars.length!==1 || !bars[0].parentElement)
      throw new Error('NovelAI token meter unavailable for the verified prompt; not submitted');
    document.querySelectorAll('[data-harbour-token-target]').forEach(el=>el.removeAttribute('data-harbour-token-target'));
    bars[0].parentElement.setAttribute('data-harbour-token-target',${JSON.stringify(marker)});
    return {targeted:true};
  })()`;
}

export function novelAiPromptCounterReadScript(marker: string): string {
  return `(async () => {
    ${visible}
    const target=document.querySelector('[data-harbour-token-target="'+${JSON.stringify(marker)}+'"]');
    if(!target || !visible(target) || !target.matches(':hover')) throw new Error('NovelAI token meter target is not hovered; not submitted');
    let previous='', repeats=0;
    // Tooltip/tokenization is asynchronous. Wait for a unique, stable readout;
    // do not reuse a stale toast or the previous field's tooltip.
    for(let attempt=0;attempt<15;attempt++) {
      await new Promise(resolve=>setTimeout(resolve,150));
      if(!target.isConnected || !visible(target) || !target.matches(':hover'))
        throw new Error('NovelAI token meter hover changed during read; not submitted');
      const matches=Array.from(document.querySelectorAll('[data-popper-placement] p,[role="tooltip"] p'))
        .filter(visible).map(el=>String(el.innerText||'').replace(/\\s+/g,' ').trim())
        .filter(text=>/^This prompt is using .+ Max total tokens:/i.test(text));
      const value=matches.length===1?matches[0]:'';
      repeats=value && value===previous?repeats+1:0; previous=value;
      if(repeats>=2) return {text:value};
    }
    throw new Error('NovelAI token count unavailable or unstable; not submitted');
  })()`;
}

export function novelAiPromptCounterClearScript(): string {
  return `(async () => { ${visible}
    for(let attempt=0;attempt<12;attempt++) {
      const old=Array.from(document.querySelectorAll('[data-popper-placement] p,[role="tooltip"] p'))
        .filter(visible).some(el=>/^This prompt is using /i.test(String(el.innerText||'')));
      if(!old) return {cleared:true};
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    throw new Error('Previous NovelAI token tooltip did not close; not submitted');
  })()`;
}

/** No prompt edits are allowed between the first measured field and the last. */
export function novelAiPromptAuditScript(nonce: string, start: boolean): string {
  return `(() => {
    const old=globalThis.__harbourNovelAiPromptAudit;
    ${start ? `
      old?.observer?.disconnect(); if(old?.listener) { document.removeEventListener('input',old.listener,true); document.removeEventListener('change',old.listener,true); }
      const audit={nonce:${JSON.stringify(nonce)},valid:true};
      audit.listener=event=>{ if(event.target?.closest?.('[data-prompt-input="true"]')) audit.valid=false; };
      document.addEventListener('input',audit.listener,true); document.addEventListener('change',audit.listener,true);
      audit.observer=new MutationObserver(records=>{if(records.some(record=>record.target.parentElement?.closest('[contenteditable="true"]')||record.target.closest?.('[contenteditable="true"]'))) audit.valid=false;});
      audit.observer.observe(document.body,{subtree:true,childList:true,characterData:true});
      globalThis.__harbourNovelAiPromptAudit=audit;
    ` : `
      if(!old || old.nonce!==${JSON.stringify(nonce)} || !old.valid) throw new Error('NovelAI prompt edited during token audit; not submitted');
      old.observer.disconnect(); document.removeEventListener('input',old.listener,true); document.removeEventListener('change',old.listener,true);
      delete globalThis.__harbourNovelAiPromptAudit;
    `}
    return {verified:true};
  })()`;
}

const snapshot = `const snapshot=()=>JSON.stringify(Array.from(document.querySelectorAll('[data-prompt-input="true"]'))
  .map(el=>[el.className,el.textContent,Array.from(el.querySelectorAll('input,select,[aria-pressed],[aria-selected]'))
    .map(input=>[input.value,input.checked,input.getAttribute('aria-pressed'),input.getAttribute('aria-selected')])]));`;

export function novelAiPromptBudgetProofScript(nonce: string, install = false): string {
  return `(() => {
    ${snapshot}
    ${install ? `
      const old=globalThis.__harbourNovelAiPromptBudget;
      old?.observer?.disconnect(); if(old?.listener) { document.removeEventListener('input',old.listener,true); document.removeEventListener('change',old.listener,true); }
      const roots=Array.from(document.querySelectorAll('[data-prompt-input="true"]'));
      if(!roots.length) throw new Error('NovelAI prompt proof has no editors; not submitted');
      const proof={nonce:${JSON.stringify(nonce)},valid:true,snapshot:snapshot()};
      proof.listener=event=>{ if(event.target?.closest?.('[data-prompt-input="true"]')) proof.valid=false; };
      document.addEventListener('input',proof.listener,true); document.addEventListener('change',proof.listener,true);
      proof.observer=new MutationObserver(()=>{proof.valid=false;});
      roots.forEach(root=>proof.observer.observe(root,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['checked','aria-pressed','aria-selected']}));
      globalThis.__harbourNovelAiPromptBudget=proof;
    ` : `
      const proof=globalThis.__harbourNovelAiPromptBudget;
      if(!proof || proof.nonce!==${JSON.stringify(nonce)} || !proof.valid || proof.snapshot!==snapshot())
        throw new Error('NovelAI prompt changed or token budget unverified; prepare the frozen form again; not submitted');
    `}
    return {verified:true};
  })()`;
}
