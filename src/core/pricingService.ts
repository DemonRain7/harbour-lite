import type { Logger } from "pino";
import type { Runtime } from "../runtime";
import { loadPricing, savePricing, refreshFromDeepSeekOfficial, refreshFromOpenRouter, type PricingTable } from "./pricing";
import { enabledModelsForSlot } from "./modelSlots";

export { loadPricing, savePricing } from "./pricing";
export type { PricingTable, PriceEntry } from "./pricing";

/**
 * 该给哪些模型抓价 —— 从【运行时实际配置的后端】推导，不是写死一张清单。
 * 用户 以后会加很多备用模型（models.json 里加一条就多一个后端），
 * 这里跟着 modelSlots 走，加了自动纳入，不用再改代码。
 */
export function wantedModels(runtime: Pick<Runtime, "modelSlots">): string[] {
  const names = new Set<string>();
  for (const s of runtime.modelSlots) {
    // ChatGPT OAuth Harness 走固定订阅，不是按 token 结算的 API 端点；不能拿
    // OpenRouter/API 单价伪装成这次运行的真实花费。
    if (s.kind === "codex-harness") continue;
    for (const entry of enabledModelsForSlot(s)) {
      // Claude Code/Agent SDK 端点允许用 deepseek-v4-pro[1m] 这类上下文后缀；
      // 定价表与 OpenRouter 的正式模型 id 不带后缀，抓价前归一化。
      const m = entry.id.trim().replace(/\[[^\]]+\]$/, "");
      if (m && m !== "default") names.add(m);
    }
  }
  return [...names];
}

/**
 * 立刻刷新一次计费表并落盘。
 * 【故意不经过 LLM】价格是要进账单展示的数字，让模型去"查"价格等于允许它编一个
 * 看起来合理的数 —— 那比不更新危险得多。这里走 OpenRouter 的公开接口，纯数据。
 * 失败不抛错：把上次的表原样留着（旧价格好过没价格），只把失败记进 lastRefresh。
 */
export async function refreshPricingNow(
  runtime: Pick<Runtime, "modelSlots" | "metrics">,
  logger?: Logger
): Promise<{ ok: boolean; added: number; updated: number; skippedManual: number; notFound: string[]; warnings?: string[]; error?: string }> {
  const table = await loadPricing(logger);
  const wanted = wantedModels(runtime);
  const warnings: string[] = [];
  let added = 0, updated = 0, skippedManual = 0;
  const notFound = new Set<string>();
  let successes = 0;
  if (wanted.some((m) => /^deepseek-/i.test(m))) {
    try {
      const r = await refreshFromDeepSeekOfficial(table, wanted, logger);
      added += r.added; updated += r.updated; skippedManual += r.skippedManual;
      r.notFound.forEach((m) => notFound.add(m));
      successes++;
    } catch (e) {
      warnings.push(`DeepSeek 官方价：${(e as Error).message}`);
    }
  }
  try {
    const r = await refreshFromOpenRouter(table, wanted, logger);
    added += r.added; updated += r.updated; skippedManual += r.skippedManual;
    r.notFound.forEach((m) => notFound.add(m));
    successes++;
  } catch (e) {
    warnings.push(`OpenRouter：${(e as Error).message}`);
  }
  if (successes > 0) {
    table.lastRefresh = {
      at: new Date().toISOString(),
      ok: true,
      added,
      updated,
      ...(warnings.length ? { warnings } : {}),
    };
    await savePricing(table);
    // 热切换只供【之后】的 usage 入账；MetricsStore 内已有 DayBucket.cost 不会被改写。
    runtime.metrics.setPricingTable(table);
    if (warnings.length) logger?.warn({ warnings }, "部分计费来源刷新失败，成功来源已保存");
    return { ok: true, added, updated, skippedManual, notFound: [...notFound], ...(warnings.length ? { warnings } : {}) };
  } else {
    const error = warnings.join("；") || "没有可用的计费来源";
    table.lastRefresh = { at: new Date().toISOString(), ok: false, added: 0, updated: 0, error };
    // 只写回 lastRefresh，models 保持原样 —— 抓取失败绝不能清空已有价格。
    try { await savePricing(table); } catch { /* 落盘失败就算了，下次再试 */ }
    runtime.metrics.setPricingTable(table);
    logger?.warn({ err: error }, "计费表刷新失败，沿用上一次的价格");
    return { ok: false, added: 0, updated: 0, skippedManual: 0, notFound: [], warnings, error };
  }
}

/** 给面板用的摘要：哪些模型有价、哪些没有。 */
export function pricingCoverage(table: PricingTable, wanted: string[]): { priced: string[]; unpriced: string[] } {
  const priced: string[] = [];
  const unpriced: string[] = [];
  for (const m of wanted) (table.models[m] ? priced : unpriced).push(m);
  return { priced, unpriced };
}
