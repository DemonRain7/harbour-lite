import type { ToolContext } from "../../types";
import type { SkillResourceIndex } from "../skillResourceIndex";
import { WorkflowInputValidationError } from "./registry";

export type NovelAiContentRating = "sfw" | "nsfw";
export const SFW_ART_DIRECTION = "references/sfw/reference-direction.md";

/** Explicit request metadata only. Never infer an opt-in from free text or owner authorization. */
export function novelAiContentRating(value: unknown): NovelAiContentRating | undefined {
  if (value === undefined) return undefined;
  if (value !== "sfw" && value !== "nsfw") {
    throw new WorkflowInputValidationError("contentRating 只接受 sfw / nsfw；省略沿用原创作路径。", "invalid_content_rating");
  }
  return value;
}

export function isSfwAuthoringResource(resource: string): boolean {
  return resource.toLowerCase().startsWith("references/sfw/");
}

/** Only the ordinary artist (including a frozen comic panel) receives the extra guide. */
export function usesSfwArtDirection(ctx: ToolContext): boolean {
  return ctx.agent.name === "novelai_artist" && ctx.execution?.novelAiContentRating === "sfw" &&
    (!ctx.execution.novelAiPanelArt || ctx.execution.novelAiPanelArt.book.contentRating === "sfw");
}

/** Keep the pre-existing catalog projection byte-for-byte for non-opted-in readers. */
export function sfwAuthoringResourceIndex(index: SkillResourceIndex | null, enabled: boolean): SkillResourceIndex | null {
  if (!index || enabled) return index;
  return { ...index, resources: index.resources.filter(entry => !isSfwAuthoringResource(entry.path)),
    ...(index.entrypoint_requires ? { entrypoint_requires: index.entrypoint_requires.filter(resource => !isSfwAuthoringResource(resource)) } : {}) };
}

/** Once SFW guidance has been loaded, that task cannot be repurposed as another content route. */
export function assertSfwAuthoringPlan(plan: Record<string, unknown>, ctx: ToolContext): void {
  if (ctx.execution?.novelAiContentRating !== "sfw") return;
  for (const field of ["set", "job"] as const) {
    const value = plan[field];
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const rating = (value as Record<string, unknown>).contentRating;
      if (rating !== undefined && rating !== "sfw") {
        throw new WorkflowInputValidationError("本任务已固定为 SFW 创作，不能改用其它 contentRating；新要求请交回 Main 新建任务。", "sfw_authoring_route_conflict");
      }
    }
  }
}
