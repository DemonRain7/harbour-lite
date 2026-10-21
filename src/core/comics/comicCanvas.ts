import type { NovelAiComposeInput } from "../novelAiPromptComposer";
import type { ComicVisualBible } from "./comicTypes";

/** The book's canvas also applies to panels that omit their own orientation. */
export function withComicCanvas(generation: NovelAiComposeInput, bible: Pick<ComicVisualBible, "aspectRatio">): NovelAiComposeInput {
  return generation.orientation === undefined ? { ...generation, orientation: bible.aspectRatio } : generation;
}

/** Reuse explicit prompt-ready intent, never inject/translate narrative prose.
 * A panel's intentional style override replaces the default instead of stacking
 * competing art directions. Character/material/module fields remain untouched. */
export function withComicVisualDefaults(
  generation: NovelAiComposeInput,
  bible: Pick<ComicVisualBible, "aspectRatio" | "renderStyle">,
): NovelAiComposeInput {
  const canvas = withComicCanvas(generation, bible);
  return canvas.style === undefined && bible.renderStyle !== undefined
    ? { ...canvas, style: bible.renderStyle }
    : canvas;
}
