import type { ToolContext } from "../../types";
import { WorkflowInputValidationError } from "./registry";

export interface NovelAiSfwSampling { steps: number; guidance: number; seed: number; sampler: "Euler Ancestral" }
export type NovelAiSamplingContext = Pick<ToolContext, "attachments"> & Partial<Pick<ToolContext, "execution">>;

/** Opt-in only: legacy/NSFW compilation is byte-identical, including omitted settings. */
export function sfwSampling(input: object, ctx?: NovelAiSamplingContext): NovelAiSfwSampling | undefined {
  if (ctx?.execution?.novelAiContentRating !== "sfw") return undefined;
  const row = input as Record<string, unknown>;
  if (["steps", "guidance", "seed", "sampler", "noiseSchedule", "parameters"].some(key => row[key] !== undefined)) {
    throw new WorkflowInputValidationError("SFW 参数必须写在 generation.sampling:{steps,guidance,seed,sampler}；不支持的顶层参数不能静默忽略。V5 网页未提供 Noise Schedule 控件，本次不声称已控制它。", "sfw_sampling_invalid");
  }
  if (row.sampling === undefined) return undefined;
  const s = row.sampling;
  if (!s || typeof s !== "object" || Array.isArray(s)) throw new WorkflowInputValidationError("sampling 必须是对象", "sfw_sampling_invalid");
  const v = s as Record<string, unknown>;
  if (Object.keys(v).some(key => !["steps", "guidance", "seed", "sampler"].includes(key)) ||
    !Number.isInteger(v.steps) || Number(v.steps) < 1 || Number(v.steps) > 50 ||
    typeof v.guidance !== "number" || !Number.isFinite(v.guidance) || v.guidance < 0 || v.guidance > 10 ||
    !Number.isSafeInteger(v.seed) || Number(v.seed) < 0 || Number(v.seed) > 4294967295 || v.sampler !== "Euler Ancestral") {
    throw new WorkflowInputValidationError("sampling 须完整提供 steps(1–50)、guidance(0–10)、seed(0–4294967295)、sampler:Euler Ancestral；不猜参数、不自动降级。", "sfw_sampling_invalid");
  }
  return { steps: Number(v.steps), guidance: v.guidance, seed: Number(v.seed), sampler: v.sampler };
}
