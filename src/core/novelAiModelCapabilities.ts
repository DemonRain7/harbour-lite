import type { NovelAiRequiredReference } from "../types";
import { validateNovelAiRequiredReferences } from "./novelAiReferences";

/** Select only while compiling a new request, never while resuming a frozen Job. */
export function selectNovelAiGenerationModel(requiredReferences: NovelAiRequiredReference[]): "NAI Diffusion V4.5 Full" | "NAI Diffusion V5 Full" {
  validateNovelAiRequiredReferences(requiredReferences);
  return requiredReferences.length ? "NAI Diffusion V4.5 Full" : "NAI Diffusion V5 Full";
}

/** Precise Reference support, verified against NovelAI's official documentation.
 * https://docs.novelai.net/en/image/precisereference/
 * https://novelai.net/v5 (V5 does not currently support Precise Reference).
 * Keep unknown future models closed until their actual reference UI is verified.
 */
export function supportsNovelAiPreciseReferences(model: string): boolean {
  const name = model.trim().replace(/^nai[\s-]+diffusion[\s-]+/i, "");
  return /^v?4[.-]5(?:[\s-]+(?:full|curated))?$/i.test(name);
}
