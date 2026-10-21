export const COMIC_SHOTS = [
  "establishing",
  "wide",
  "full",
  "medium",
  "close-up",
  "extreme-close-up",
  "over-the-shoulder",
  "two-shot",
  "detail",
  "point-of-view",
] as const;

export const COMIC_ANGLES = [
  "eye-level",
  "high-angle",
  "low-angle",
  "bird-eye",
  "worm-eye",
  "dutch-angle",
  "over-the-shoulder",
  "point-of-view",
] as const;

export const COMIC_TRANSITIONS = [
  "moment-to-moment",
  "action-to-action",
  "subject-to-subject",
  "scene-to-scene",
] as const;

export const COMIC_CONTENT_RATINGS = ["sfw", "nsfw"] as const;

export type ComicShot = (typeof COMIC_SHOTS)[number];
export type ComicAngle = (typeof COMIC_ANGLES)[number];
export type ComicTransition = (typeof COMIC_TRANSITIONS)[number];
export type ComicJobStatus = "planned" | "running" | "paused" | "blocked" | "ready" | "completed" | "aborted";
export type ComicPanelStatus = "pending" | "running" | "completed" | "blocked";
export type ComicContentRating = (typeof COMIC_CONTENT_RATINGS)[number];

export interface ComicDialogueLine {
  speaker: string;
  text: string;
}

export interface ComicCharacterBible {
  name: string;
  role: string;
  appearance: string;
  initialWardrobe: string;
  referenceQuery?: string;
}

export interface ComicLocationBible {
  name: string;
  visualAnchors: string;
}

export interface ComicVisualBible {
  style: string;
  /** Optional prompt-ready shared style; prose bible.style is not a model prompt. */
  renderStyle?: string;
  palette: string;
  lighting: string;
  aspectRatio: "portrait" | "landscape" | "square";
  characters: ComicCharacterBible[];
  locations: ComicLocationBible[];
}

export interface ComicContinuitySnapshot {
  location: string;
  time: string;
  axis: string;
  screenDirection: string;
  characterStates: Record<string, string>;
  props: string[];
  intentionalAxisBreak?: string;
}

export interface ComicPanelDraft {
  number: number;
  beat: string;
  transition: ComicTransition;
  shot: ComicShot;
  angle: ComicAngle;
  focalPoint: string;
  action: string;
  emotion: string;
  visualDescription: string;
  caption?: string;
  narration?: string;
  dialogue: ComicDialogueLine[];
  characters: string[];
  continuity: ComicContinuitySnapshot;
  emphasis: 1 | 2 | 3;
  /** Workflow 在创建任务前冻结的 NovelAI 执行表单；普通手工 job 可省略。 */
  novelAiRequest?: Record<string, unknown>;
}

export interface ComicPanelAsset {
  path: string;
  url: string;
  mime: "image/webp";
  width: number;
  height: number;
  size: number;
  sha256: string;
}

export interface ComicPanel extends ComicPanelDraft {
  status: ComicPanelStatus;
  attempts: number;
  claimId?: string;
  visibleCostAnlas?: number;
  asset?: ComicPanelAsset;
  /** Durable Generate receipt. Import recovery must never submit a second Generate. */
  /** false is a durable not-started marker; absent in a legacy running claim means unknown. */
  generationStarted?: { maxCostAnlas: number } | false;
  generationReceipt?: import("../workflows/novelAiGenerationUnit").NovelAiRenderedReceipt;
  blocked?: {
    stage: string;
    evidence: string;
    retrySafety: "safe" | "uncertain";
    promptBudgetOverflow?: import("../novelAiPromptBudget").NovelAiPromptBudgetOverflowReport;
  };
}

/** 聊天交付用的单幕；不复制本地绝对路径，也不替代 pages/ 归档成品。 */
export interface ComicDeliveryScene {
  panelNumber: number;
  title: string;
  text: string;
  image: { url: string; width: number; height: number };
}

export interface ComicJobArtifacts {
  pages: Array<{ path: string; url: string; width: number; height: number; panelNumbers: number[] }>;
  manifest: { path: string; url: string };
  /** 按 Panel 顺序绑定标题/对白与原图，供 Web、QQ、Discord 逐幕交付。 */
  scenes: ComicDeliveryScene[];
}

export interface ComicJob {
  schemaVersion: 1;
  id: string;
  /** 同一顶层 run 重放 start 时复用同一 job，避免重复付费任务。 */
  workflowKey?: string;
  /** 创建时的归一化计划摘要；同一幂等键不能静默接受另一个故事。 */
  planHash?: string;
  ownerKey: string;
  source: { channel: string; key: string; actorId?: string; sessionId?: string };
  title: string;
  premise: string;
  contentRating: ComicContentRating;
  /** Harbour 可信 owner 路由生成的机器授权位；不承载自然语言政策。 */
  nsfwAuthorized?: 0 | 1;
  readingDirection: "ltr" | "rtl";
  language: string;
  status: ComicJobStatus;
  batchSize: number;
  layout: { columns: number; panelsPerPage: number };
  budget: { maxTotalAnlas: number; visibleSpentAnlas: number; uncertainReservedAnlas?: number;
    plan?: import("../workflows/novelAiBudget").NovelAiBudgetPlan };
  waitingFor?: import("../workflows/novelAiBudget").NovelAiWaiting;
  bible: ComicVisualBible;
  panels: ComicPanel[];
  revision: number;
  createdAt: string;
  updatedAt: string;
  artifacts?: ComicJobArtifacts;
  abortedReason?: string;
}

export interface ComicJobCreateInput {
  title: string;
  workflowKey?: string;
  premise: string;
  contentRating?: ComicContentRating;
  nsfwAuthorized?: 0 | 1;
  readingDirection?: "ltr" | "rtl";
  language?: string;
  batchSize?: number;
  layout?: { columns?: number; panelsPerPage?: number };
  budget?: { maxTotalAnlas?: number };
  bible: ComicVisualBible;
  panels: ComicPanelDraft[];
}
