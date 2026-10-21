import type { Logger } from "pino";
import type { ModelCatalogState, ModelSlot, SlotModel } from "../modelSlots";
import type { WorkflowExecutor, WorkflowInvocation } from "./registry";
import type { CodexRuntimeUpdate } from "../codexRuntime";

export interface PricingRefreshCatalogResult {
  slots: ModelSlot[];
  ok: number;
  failed: number;
  skipped: number;
  added: number;
}

export interface RuntimeCatalogRefreshResult {
  id: string;
  ok: boolean;
  added: number;
  total: number;
  skipped?: boolean;
  error?: string;
  updatedAt?: string;
  component?: CodexRuntimeUpdate;
  warnings?: string[];
}

export interface PricingRefreshPriceResult {
  ok: boolean;
  added: number;
  updated: number;
  skippedManual: number;
  notFound: string[];
  warnings?: string[];
  error?: string;
}

export interface PricingRefreshWorkflowResult {
  status: "completed" | "completed_with_warnings" | "failed";
  terminal: true;
  ok: boolean;
  startedAt: string;
  finishedAt: string;
  catalog: Omit<PricingRefreshCatalogResult, "slots"> & {
    error?: string;
    runtime?: RuntimeCatalogRefreshResult[];
  };
  pricing: PricingRefreshPriceResult;
  warnings: string[];
  summary: string;
}

export interface PricingRefreshWorkflowConfig {
  readSlots(): Promise<ModelSlot[]>;
  refreshCatalogs(slots: ModelSlot[]): Promise<PricingRefreshCatalogResult>;
  saveSlots(slots: ModelSlot[]): Promise<void>;
  updateRuntimeCatalog(id: string, models: SlotModel[], catalog?: ModelCatalogState): void;
  /** OAuth 等运行时目录独立热更新、失败保留旧值；结果绝不写入模型槽文件。 */
  refreshRuntimeCatalogs?(): Promise<RuntimeCatalogRefreshResult[]>;
  refreshPricing(): Promise<PricingRefreshPriceResult>;
  logger?: Logger;
  now?: () => Date;
}

function summaryText(
  catalog: PricingRefreshWorkflowResult["catalog"],
  pricing: PricingRefreshPriceResult,
): string {
  const runtimeText = catalog.runtime?.map((result) => {
    const status = result.skipped ? "跳过" : result.ok ? "成功" : "失败（保留旧目录）";
    const component = result.component;
    const versionText = component ? `；Codex ${component.version}` +
      (component.status === "updated" ? `（从 ${component.previousVersion} 升至最新稳定版）`
        : component.status === "current" ? "（已核对最新稳定版）" : component.message ? `（${component.message}）` : "（尚未检查更新）") : "";
    return `${result.id}：${status}、新增 ${result.added}、共 ${result.total}${versionText}` +
      (!result.skipped && !result.ok && result.error ? `（${result.error}）` : "");
  }).join("；");
  const catalogText = `模型目录：成功 ${catalog.ok}、跳过 ${catalog.skipped}、失败 ${catalog.failed}、新增 ${catalog.added}；` +
    (catalog.error ? `Provider 模型目录刷新失败并保留旧目录：${catalog.error}；` : "") +
    (runtimeText ? `运行时目录：${runtimeText}；` : "");
  if (!pricing.ok) return `${catalogText}计费刷新失败（沿用上次价格）：${pricing.error ?? "未知错误"}`;
  return `${catalogText}计费表已更新：新增 ${pricing.added}、更新 ${pricing.updated}、跳过锁定价 ${pricing.skippedManual}` +
    (pricing.notFound.length ? `；上游查无此模型：${pricing.notFound.join("、")}` : "") +
    (pricing.warnings?.length ? `；部分来源未更新（沿用旧价）：${pricing.warnings.join("；")}` : "");
}

/**
 * 模型目录与计价表的唯一刷新实现。
 *
 * Cron 与主人管理 API 复用同一个 runner；并发触发时共享同一 Promise，
 * 避免同时覆写目录/报价。固定官方 Codex 包的维护与 HTTP 刷新均为确定性代码，不调用 LLM；
 * 普通 Agent 入口只允许查询状态，不能借此安装组件。
 */
export function createPricingRefreshWorkflowExecutor(config: PricingRefreshWorkflowConfig): WorkflowExecutor {
  let inFlight: Promise<PricingRefreshWorkflowResult> | undefined;
  let lastRun: PricingRefreshWorkflowResult | undefined;
  let runningSince: string | undefined;
  const now = () => (config.now?.() ?? new Date()).toISOString();

  const refresh = async (): Promise<PricingRefreshWorkflowResult> => {
    if (inFlight) return inFlight;
    runningSince = now();
    inFlight = (async () => {
      const warnings: string[] = [];
      let catalog: PricingRefreshWorkflowResult["catalog"] = {
        ok: 0,
        failed: 0,
        skipped: 0,
        added: 0,
      };
      try {
        const storedSlots = await config.readSlots();
        const result = await config.refreshCatalogs(storedSlots);
        await config.saveSlots(result.slots);
        for (const slot of result.slots) {
          config.updateRuntimeCatalog(slot.id, slot.models, slot.catalog);
        }
        catalog = {
          ok: result.ok,
          failed: result.failed,
          skipped: result.skipped,
          added: result.added,
        };
        if (result.failed > 0) warnings.push(`${result.failed} 个模型目录刷新失败，已保留各槽旧目录`);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        catalog = { ...catalog, error: message };
        warnings.push(`模型目录：${message}`);
        config.logger?.warn({ err: message }, "pricing-refresh:catalog-failed");
      }

      if (config.refreshRuntimeCatalogs) {
        try {
          catalog.runtime = await config.refreshRuntimeCatalogs();
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          catalog.runtime = [{ id: "runtime-catalogs", ok: false, added: 0, total: 0, error: message }];
          config.logger?.warn({ err: message }, "pricing-refresh:runtime-catalog-failed");
        }
        for (const result of catalog.runtime) {
          if (result.warnings?.length) warnings.push(...result.warnings);
          catalog.added += result.added;
          if (result.skipped) {
            catalog.skipped += 1;
          } else if (result.ok) {
            catalog.ok += 1;
          } else {
            catalog.failed += 1;
            warnings.push(`运行时模型目录 ${result.id}：${result.error ?? "刷新失败，已保留旧目录"}`);
          }
        }
      }

      let pricing: PricingRefreshPriceResult;
      try {
        pricing = await config.refreshPricing();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        pricing = {
          ok: false,
          added: 0,
          updated: 0,
          skippedManual: 0,
          notFound: [],
          error: message,
        };
      }
      if (pricing.warnings?.length) warnings.push(...pricing.warnings);
      if (!pricing.ok && pricing.error) warnings.push(pricing.error);
      const finishedAt = now();
      const result: PricingRefreshWorkflowResult = {
        status: pricing.ok
          ? (warnings.length ? "completed_with_warnings" : "completed")
          : "failed",
        terminal: true,
        ok: pricing.ok,
        startedAt: runningSince!,
        finishedAt,
        catalog,
        pricing,
        warnings: [...new Set(warnings)],
        summary: summaryText(catalog, pricing),
      };
      lastRun = result;
      config.logger?.info({ status: result.status, catalog, pricing }, "pricing-refresh:complete");
      return result;
    })().finally(() => {
      inFlight = undefined;
      runningSince = undefined;
    });
    return inFlight;
  };

  const execute = async (invocation: WorkflowInvocation): Promise<unknown> => {
    if (invocation.action === "refresh") return refresh();
    if (invocation.action === "status") {
      return inFlight
        ? { status: "running", terminal: false, startedAt: runningSince }
        : { status: lastRun?.status ?? "idle", terminal: true, lastRun: lastRun ?? null };
    }
    throw new Error(`pricing-refresh: 不支持 action=${invocation.action}（仅 refresh/status）`);
  };

  return {
    id: "pricing-refresh",
    execute: async (invocation) => {
      if (invocation.action !== "status") throw new Error("pricing-refresh: 更新组件仅允许 Cron/主人管理 API 的系统入口");
      return execute(invocation);
    },
    executeSystem: execute,
  };
}
