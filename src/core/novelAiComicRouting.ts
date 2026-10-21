const COUNTED_PANELS = /(?:[2-9]|10|[二两三四五六七八九十])\s*(?:格|幕)(?:\s*(?:漫画|分镜))?|\b(?:two|three|four|five|six|seven|eight|nine|ten|[2-9]|10)[- ](?:panel|scene)\b/iu;
const SEQUENTIAL_PANELS = /\b(?:multi[- ]panel|sequential\s+(?:comic\s+)?panels?|comic\s+(?:page|strip)\s+(?:with\s+)?(?:multiple|several|[2-9]|ten)\s+panels?)\b/iu;
const PANEL_GRID = /\b(?:[2-9]\s*[x×]\s*[2-9])\s*(?:comic\s+)?(?:panel\s+)?grid\b/iu;
const ENGLISH_PANEL_NUMBER = /\bpanel\s*([1-9]\d?)\b/giu;
const CHINESE_PANEL_NUMBER = /第\s*([一二两三四五六七八九十]{1,3}|[1-9]\d?)\s*(?:格|幕)/gu;
const NOVELAI_MARKER = /\b(?:novelai|nai\s+diffusion|anlas|browserform|baseprompt|character\s+prompt)\b/iu;
const GENERATION_MARKER = /\b(?:generate|generation|render|numberofimages)\b|生成|出图|绘制|画图/iu;

function hasAtLeastTwoNumberedPanels(text: string, pattern: RegExp): boolean {
  const values = new Set<string>();
  pattern.lastIndex = 0;
  for (const match of text.matchAll(pattern)) {
    if (match[1]) values.add(match[1]);
    if (values.size >= 2) return true;
  }
  return false;
}

/**
 * 只识别明确的多格/连续分镜指令；“manga panel style” 这类单张画风描述不会命中。
 * 这是副作用前的确定性路由闸门，不调用模型，也不增加上下文。
 */
export function isMultiPanelComicRequest(text: string): boolean {
  const normalized = String(text ?? "");
  // A frozen single-panel title such as “第 2 格” identifies an ordinal,
  // not a request for two images. Keep the original text for the separate
  // distinct-panel check, so “第1格…第2格…” still routes to the comic branch.
  const countedText = normalized.replace(CHINESE_PANEL_NUMBER, "");
  return COUNTED_PANELS.test(countedText)
    || SEQUENTIAL_PANELS.test(normalized)
    || PANEL_GRID.test(normalized)
    || hasAtLeastTwoNumberedPanels(normalized, ENGLISH_PANEL_NUMBER)
    || hasAtLeastTwoNumberedPanels(normalized, CHINESE_PANEL_NUMBER);
}

/** Main 错把完整漫画交给 NovelAI Browser 时才触发；普通网页阅读不会被改派。 */
export function isNovelAiMultiPanelGenerationRequest(text: string): boolean {
  const normalized = String(text ?? "");
  return NOVELAI_MARKER.test(normalized)
    && GENERATION_MARKER.test(normalized)
    && isMultiPanelComicRequest(normalized);
}

export const MULTI_PANEL_COMIC_ROUTE_REASON =
  "检测到多格或连续分镜：NovelAI 单次表单只能表达一个冻结画面。请进入 novelai-generation Workflow 的 comic 分支，内部由 comic_generator 创作并逐格生成、按标题/文字＋单图交付；禁止合成网格 batch。";
