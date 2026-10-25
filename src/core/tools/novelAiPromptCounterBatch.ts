import path from "node:path";
import { pathToFileURL } from "node:url";
import { spawnOpenCliHelper, OpenCliCommandTimeoutError } from "./openCliProcess";
import { NovelAiPreparationBatchReceiptError } from "./novelAiPreparationProgress";
import { novelAiCounterPreparationReasons, novelAiCounterPreparationSteps } from "./novelAiPromptBudgetPage";

export interface NovelAiCounterBatchInput {
  entryPath: string;
  profile: string;
  session: string;
  tab: string;
  idleTimeoutSeconds: number;
  marker: string;
  prepareScript: string;
  clearScript: string;
  readScript: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  onDiagnostics?: (timings: Record<string, number>) => void;
}
export interface NovelAiCounterBatchReceipt {
  prepared: Record<string, unknown>;
  counter: Record<string, unknown> & { text: string };
  timings: Record<string, number>;
}

// Fixed host operation, not a general script tool. Reuses pinned OpenCLI's Page
// routing and native hover. Frozen text/proof scripts stay on stdin, never argv.
const HELPER = String.raw`
let phase='input';
let failure;
const preparationSteps=${JSON.stringify(novelAiCounterPreparationSteps)};
const preparationReasons=${JSON.stringify(novelAiCounterPreparationReasons)};
const timings={};
const measure=async(name,fn)=>{phase=name;const t=Date.now();try{return await fn()}finally{timings[name]=Date.now()-t}};
const output=async(value,code)=>{await new Promise((resolve,reject)=>process.stdout.write(JSON.stringify(value)+'\n',error=>error?reject(error):resolve()));process.exit(code)};
try {
  process.stdin.setEncoding('utf8');
  let text='';for await(const chunk of process.stdin){text+=chunk;if(text.length>1000000)throw Error('counter input too large')}
  const input=JSON.parse(text);
  const mode=process.env.OPENCLI_WINDOW||'foreground';
  if(!['foreground','background'].includes(mode))throw Error('invalid OPENCLI_WINDOW');
  const {Page}=await import(input.pageModule);
  const {resolveProfileSelection}=await import(input.profileModule);
  const selection=resolveProfileSelection(input.profile);
  if(selection?.source!=='explicit'||!selection.contextId)throw Error('explicit profile required');
  const page=new Page(input.session,input.idleTimeoutSeconds,selection.contextId,mode,'browser');
  const tabs=await measure('tabs',()=>page.tabs());
  if(!Array.isArray(tabs)||tabs.filter(item=>item?.page===input.tab).length!==1)throw Error('target not in exact browser session');
  page.setActivePage(input.tab);
  let hovering=false;
  const evaluate=page.evaluate.bind(page);
  page.evaluate=(source,...args)=>{
    if(hovering&&String(source).includes('dispatchEvent'))throw Error('native hover unavailable; synthetic fallback forbidden');
    return evaluate(source,...args);
  };
  // OpenCLI normally catches native failures and synthesizes DOM hover. This
  // exact-counter path must fail instead: CSS :hover is part of its proof.
  page.tryNativeMouseMove=async(x,y)=>{
    if(!Number.isFinite(x)||!Number.isFinite(y))throw Error('invalid native hover coordinates');
    await page.cdp('Input.dispatchMouseEvent',{type:'mouseMoved',x,y});return true;
  };
  const hover=async(selector)=>{hovering=true;try{return await page.hover(selector)}finally{hovering=false}};
  const prepared=await measure('prepare',()=>page.evaluate(input.prepareScript));
  if(prepared?.prepared!==true||prepared?.verification?.verified!==true){
    if(preparationSteps.includes(prepared?.failure?.step)&&preparationReasons.includes(prepared?.failure?.reason))failure={step:prepared.failure.step,reason:prepared.failure.reason};
    throw Error('invalid frozen preparation receipt');
  }
  await measure('leave',()=>hover('[data-harbour-richtext-target="'+input.marker+'"]'));
  const cleared=await measure('clear',()=>page.evaluate(input.clearScript));
  if(cleared?.cleared!==true)throw Error('previous counter tooltip not confirmed cleared');
  await measure('hover',()=>hover('[data-harbour-token-target="'+input.marker+'"]'));
  const counter=await measure('read',()=>page.evaluate(input.readScript));
  if(!counter||typeof counter!=='object'||typeof counter.text!=='string'||!counter.text.trim())throw Error('invalid counter receipt');
  await output({version:1,prepared,cleared:true,counter,timings},0);
} catch {
  // Third-party evaluation/transport errors can quote the submitted script.
  // Return only fixed stage/reason enums, never arbitrary errors or prompt text.
  await output({version:1,error:{phase,code:'counter-audit-failed',...(failure?{failure}:{})},timings},1);
}`;

/** Call only after bridge readiness, inside the existing preparation deadline.
 * Failure is terminal for this invocation: never replay via the old CLI path. */
export async function runNovelAiPromptCounterBatch(input: NovelAiCounterBatchInput): Promise<NovelAiCounterBatchReceipt> {
  input.signal?.throwIfAborted();
  if (!path.isAbsolute(input.entryPath) || !input.profile.trim() || input.profile.length > 256 ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(input.session) || !/^[A-Za-z0-9_-]{1,128}$/.test(input.tab) ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(input.marker) || !Number.isFinite(input.idleTimeoutSeconds) || input.idleTimeoutSeconds <= 0 ||
      [input.prepareScript, input.clearScript, input.readScript].some(value => typeof value !== "string" || !value || value.length > 300_000)) {
    throw new Error("NovelAI counter batch: invalid host request");
  }
  const timeoutMs = input.timeoutMs ?? 90_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 180_000) throw new Error("NovelAI counter batch: invalid deadline");
  const directory = path.dirname(input.entryPath);
  const payload = JSON.stringify({ profile: input.profile, session: input.session, tab: input.tab, marker: input.marker,
    idleTimeoutSeconds: input.idleTimeoutSeconds, prepareScript: input.prepareScript, clearScript: input.clearScript, readScript: input.readScript,
    pageModule: pathToFileURL(path.join(directory, "browser", "page.js")).href,
    profileModule: pathToFileURL(path.join(directory, "browser", "profile.js")).href });
  return new Promise((resolve, reject) => {
    const child = spawnOpenCliHelper(HELPER, { stdio: ["pipe", "pipe", "pipe"],
      env: { OPENCLI_BROWSER_IDLE_TIMEOUT: String(input.idleTimeoutSeconds) } });
    let stdout = "", settled = false;
    const finish = (error?: Error, receipt?: NovelAiCounterBatchReceipt) => {
      if (settled) return;
      settled = true; clearTimeout(timer); input.signal?.removeEventListener("abort", abort);
      if (error) { child.kill(); reject(error); } else resolve(receipt!);
    };
    const abort = () => finish(input.signal?.reason instanceof Error ? input.signal.reason : new Error("NovelAI counter batch cancelled"));
    const timer = setTimeout(() => finish(new OpenCliCommandTimeoutError(timeoutMs)), timeoutMs);
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", chunk => {
      stdout += String(chunk);
      if (stdout.length > 256_000) finish(new NovelAiPreparationBatchReceiptError());
    });
    // Drain stderr but do not relay arbitrary page/prompt contents into diagnostics.
    child.stderr?.on("data", () => undefined);
    child.on("error", error => finish(error));
    child.stdin?.on("error", () => finish(new NovelAiPreparationBatchReceiptError()));
    child.on("close", code => {
      if (settled) return;
      let receipt: any;
      try { receipt = JSON.parse(stdout); } catch { finish(new NovelAiPreparationBatchReceiptError()); return; }
      if (receipt?.timings && typeof receipt.timings === "object") {
        const timings = Object.fromEntries(Object.entries(receipt.timings).filter(([name, ms]) =>
          ["tabs", "prepare", "leave", "clear", "hover", "read"].includes(name) && typeof ms === "number" && Number.isFinite(ms) && ms >= 0));
        try { input.onDiagnostics?.(timings as Record<string, number>); } catch { /* diagnostics never replace evidence */ }
      }
      if (code !== 0 || receipt?.version !== 1 || receipt?.prepared?.prepared !== true || receipt?.cleared !== true ||
          receipt.prepared?.verification?.verified !== true || typeof receipt?.counter?.text !== "string" || !receipt.counter.text.trim() ||
          !receipt.timings || ["tabs", "prepare", "leave", "clear", "hover", "read"].some(name =>
            !Number.isFinite(receipt.timings[name]) || receipt.timings[name] < 0)) {
        const error = new NovelAiPreparationBatchReceiptError();
        if (["input", "tabs", "prepare", "leave", "clear", "hover", "read"].includes(receipt?.error?.phase)) {
          error.message += ` phase=${receipt.error.phase}`;
        }
        const failure = receipt?.error?.failure;
        if (receipt?.error?.phase === "prepare" && novelAiCounterPreparationSteps.includes(failure?.step) &&
            novelAiCounterPreparationReasons.includes(failure?.reason)) {
          error.message += `, step=${failure.step}, reason=${failure.reason}`;
        }
        finish(error); return;
      }
      finish(undefined, { prepared: receipt.prepared, counter: receipt.counter, timings: receipt.timings });
    });
    if (input.signal?.aborted) abort(); else input.signal?.addEventListener("abort", abort, { once: true });
    if (!settled) child.stdin?.end(payload);
  });
}
