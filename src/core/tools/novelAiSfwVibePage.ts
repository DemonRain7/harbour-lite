/** Opt-in SFW reference hygiene. A cached Vibe embedding has no FileList, so
 * inspecting upload inputs alone cannot prove that a request has no reference.
 * Only public panel previews/counts and its explicitly identified trash icon
 * are used; no stored embeddings or private application state are read. */
export function novelAiSfwVibeScript(clearOne = false): string {
  return `(() => {
    const visible=e=>{if(!e||e.getBoundingClientRect().width<1)return false;
      for(let p=e;p;p=p.parentElement){const s=getComputedStyle(p);if(s.display==='none'||s.visibility==='hidden'||s.opacity==='0')return false;}return true;};
    const roots=Array.from(document.querySelectorAll('.image-gen-vibe-transfer')).filter(visible);
    if(roots.length>1)throw Error('SFW Vibe panel is ambiguous; Generate not submitted');
    if(!roots.length)return {vibeChecked:true,active:0,clicked:false,panelCount:0};
    const root=roots[0], text=root.innerText||root.textContent||'';
    const declared=Number(/Vibe Transfer\\s*\\((\\d+)\\)/.exec(text)?.[1]||0);
    const sources=new Set(Array.from(root.querySelectorAll('img,[style*="background-image"]')).map(e=>
      e.tagName==='IMG'?e.currentSrc||e.src:getComputedStyle(e).backgroundImage).filter(s=>s&&s!=='none'));
    const active=Math.max(declared,sources.size);
    if(!Number.isInteger(active)||active>8)throw Error('Invalid SFW Vibe inventory; Generate not submitted');
    let clicked=false;
    if(${JSON.stringify(clearOne)}&&active){
      const trash=/\\/trash[.-][^/\\)"'?]*\\.svg(?:[?"')]|$)/i;
      const buttons=Array.from(root.querySelectorAll('button')).filter(b=>visible(b)&&!b.disabled&&Array.from(b.querySelectorAll('*')).some(i=>{
        const s=getComputedStyle(i);return trash.test(String(s.maskImage||s.webkitMaskImage||''));}));
      if(buttons.length!==active)throw Error('SFW Vibe removal controls do not match previews; Generate not submitted');
      buttons[0].click();clicked=true;
    }
    return {vibeChecked:true,active,clicked,panelCount:1};
  })()`;
}

export function assertNovelAiSfwVibeEmpty(result: unknown): void {
  const row=result&&typeof result==='object'?result as Record<string,unknown>:undefined;
  if(row?.vibeChecked!==true||row.active!==0)throw new Error('SFW Vibe reference remains or cannot be verified; Generate not submitted.');
}
