import { z } from "zod";
import { WorkflowInputValidationError } from "./registry";
import {
  normalizeComicBible,
  normalizeComicPanel,
  normalizeComicPanelTextAliases,
} from "../comics/comicJobStore";
import { comicJobCreateSchema } from "../tools/comic";
import { novelAiComposeTool } from "../tools/novelAiCompose";
import { withComicVisualDefaults } from "../comics/comicCanvas";
import { comicCameraIssues } from "../comics/comicCamera";
import type { NovelAiComposeInput } from "../novelAiPromptComposer";

const MAX_INPUT_ISSUES = 120;
const basePanelSchema = comicJobCreateSchema.properties.panels.items;
const generationSchema = novelAiComposeTool.parameters as { properties: Record<string, unknown> };
const nullableText = (schema: object) => ({ ...schema, type: ["string", "null"] });
const panelSchema = {
  ...basePanelSchema,
  properties: {
    ...basePanelSchema.properties,
    ...Object.fromEntries((["caption", "narration", "title", "text"] as const).map((name) => [name, nullableText(basePanelSchema.properties[name])])),
    continuity: {
      ...basePanelSchema.properties.continuity,
      properties: {
        ...basePanelSchema.properties.continuity.properties,
        intentionalAxisBreak: nullableText(basePanelSchema.properties.continuity.properties.intentionalAxisBreak),
      },
      required: basePanelSchema.properties.continuity.required.filter((name) => name !== "props"),
    },
    generation: {
      ...generationSchema,
      properties: {
        ...generationSchema.properties,
        numberOfImages: { type: "integer", enum: [1] },
      },
    },
    // 已冻结的旧任务仍可交回；完整表单由 Store 的领域校验器复核。
    novelAiRequest: { type: "object" },
  },
  required: basePanelSchema.required.filter((name) => !["dialogue", "characters", "emphasis"].includes(name)),
};
const jobSchema = {
  ...comicJobCreateSchema,
  properties: {
    ...comicJobCreateSchema.properties,
    workflowKey: nullableText(comicJobCreateSchema.properties.workflowKey),
    language: nullableText(comicJobCreateSchema.properties.language),
    bible: {
      ...comicJobCreateSchema.properties.bible,
      properties: {
        ...comicJobCreateSchema.properties.bible.properties,
        characters: {
          ...comicJobCreateSchema.properties.bible.properties.characters,
          items: {
            ...comicJobCreateSchema.properties.bible.properties.characters.items,
            properties: {
              ...comicJobCreateSchema.properties.bible.properties.characters.items.properties,
              referenceQuery: nullableText(comicJobCreateSchema.properties.bible.properties.characters.items.properties.referenceQuery),
            },
          },
        },
      },
    },
    panels: { ...comicJobCreateSchema.properties.panels, items: panelSchema },
  },
  // 与 Store 的既有缺省值兼容；显式给出的错误值仍完整校验。
  required: ["title", "premise", "bible", "panels"],
};

function fromSchema(schema: unknown) {
  return z.fromJSONSchema(schema as Parameters<typeof z.fromJSONSchema>[0]);
}
const jobValidator = fromSchema(jobSchema);
const panelValidator = fromSchema(panelSchema);
const costValidator = fromSchema({ type: "integer", minimum: 0, maximum: 10_000 });

// Authoring contracts are projections of the same execution schemas, not a second
// set of story/material rules. Numbering and task metadata belong to the program.
const { panels: _panels, workflowKey: _key, ...bookProperties } = jobSchema.properties;
const { number: _number, novelAiRequest: _request, ...contentProperties } = panelSchema.properties;
export const comicDraftBookSchema = { ...jobSchema, properties: bookProperties,
  required: jobSchema.required.filter(name => name !== "panels") };
export const comicDraftPanelSchema = { ...panelSchema, properties: contentProperties,
  required: [...panelSchema.required.filter(name => name !== "number"), "generation"] };
const bookValidator = fromSchema(comicDraftBookSchema);
const contentValidator = fromSchema(comicDraftPanelSchema);
// Story-only input is the same panel contract, without an executable drawing.
// The original full-panel contract stays available for saved drafts.
const { generation: _drawing, ...storyProperties } = contentProperties;
export const comicStoryboardPanelSchema = { ...comicDraftPanelSchema, properties: storyProperties,
  required: [...comicDraftPanelSchema.required.filter(name => name !== "generation"), "characters"] };
const storyboardValidator = fromSchema(comicStoryboardPanelSchema);

export function preflightComicStoryboardPanel(value: unknown, number: number, book: Record<string, unknown>): Record<string, unknown> {
  const issues = schemaIssues(storyboardValidator, value, "input.content");
  if (issues.length) throw new ComicGenerationInputError(issues);
  try {
    return { ...normalizeComicPanel({ ...value as Record<string, unknown>, number }, number, normalizeComicBible(book.bible)) };
  } catch (error) { throw new ComicGenerationInputError([`input.content.${message(error)}`]); }
}

export function preflightComicDraftBook(value: unknown): Record<string, unknown> {
  const issues = schemaIssues(bookValidator, value, "input.content");
  if (issues.length) throw new ComicGenerationInputError(issues);
  const book = value as Record<string, unknown>;
  try { normalizeComicBible(book.bible); }
  catch (error) { throw new ComicGenerationInputError([`input.content.${message(error)}`]); }
  return book;
}

/** Validate one creative payload against the book before publishing its slot. */
export function preflightComicDraftPanel(value: unknown, number: number, book: Record<string, unknown>): Record<string, unknown> {
  const issues = schemaIssues(contentValidator, value, "input.content");
  if (issues.length) throw new ComicGenerationInputError(issues);
  const content = value as Record<string, unknown>;
  const generation = content.generation as Record<string, unknown>;
  const names = (generation.characters as { name: string }[]).map(character => character.name);
  const panel = { ...content, number, characters: content.characters ?? names,
    generation: { ...generation, numberOfImages: 1 } };
  try {
    const bible = normalizeComicBible(book.bible);
    panel.generation = withComicVisualDefaults(panel.generation as unknown as NovelAiComposeInput, bible) as typeof panel.generation;
    const normalized = preflightComicGenerationPanel(panel, number - 1);
    normalizeComicPanel(normalized, number, bible);
    const declared = (panel.characters as string[]).map(name => name.trim().toLocaleLowerCase("en-US"));
    const visible = names.map(name => name.trim().toLocaleLowerCase("en-US"));
    if (declared.length !== visible.length || declared.some(name => !visible.includes(name))) {
      throw new Error("characters: 须与 generation.characters[].name 一一对应；可省略，由程序回填");
    }
    return normalized;
  } catch (error) {
    const details = error instanceof ComicGenerationInputError ? error.issues : [message(error)];
    throw new ComicGenerationInputError(details.map(detail => detail
      .replace(/^input\.panel/, "input.content")
      .replace(/^panels\[\d+\]/, "input.content")
      .replace(/^characters:/, "input.content.characters:")));
  }
}

/** 仅描述输入错误，不表示 Workflow/Browser 已执行，也不授权任何重试。 */
export class ComicGenerationInputError extends WorkflowInputValidationError {
  readonly issues: string[];
  readonly truncated: boolean;
  readonly totalIssues: number;

  constructor(issues: string[], details?: Readonly<Record<string, unknown>>) {
    const unique = [...new Set(issues)];
    const visible = unique.slice(0, MAX_INPUT_ISSUES).map((issue) => issue.slice(0, 600));
    const truncated = unique.length > visible.length;
    super(`comic-generation 输入预检失败（本次未创建/修改漫画 Job，未调用 Browser）：\n${visible.map((issue) => `- ${issue}`).join("\n")}${truncated ? `\n- 另有 ${unique.length - visible.length} 项错误未展开；请先修正以上字段。` : ""}`,
      "invalid_input", [], undefined, details);
    this.name = "ComicGenerationInputError";
    this.issues = visible;
    this.truncated = truncated;
    this.totalIssues = unique.length;
  }
}

function fieldPath(prefix: string, path: PropertyKey[]): string {
  return path.reduce<string>((result, key) => typeof key === "number" ? `${result}[${key}]` : `${result}.${String(key)}`, prefix);
}

function schemaIssues(validator: z.ZodType, value: unknown, prefix: string): string[] {
  const result = validator.safeParse(value);
  if (result.success) return [];
  const describe = (issue: z.core.$ZodIssue, parent: PropertyKey[] = []): string[] => {
    const at = [...parent, ...issue.path];
    if (issue.code === "invalid_union") {
      // Compatibility unions must retain leaf paths (e.g. outfit.hosiery.color),
      // not obscure an otherwise precise error behind a generic "Invalid input".
      const detailed = issue.errors.filter((branch) => branch.some((child) => child.path.length > 0 || child.code !== "invalid_type"));
      return (detailed.length ? detailed : issue.errors).flatMap((branch) => branch.flatMap((child) => describe(child, at)));
    }
    return issue.code === "unrecognized_keys"
      ? issue.keys.map((key) => `${fieldPath(prefix, [...at, key])}: 未声明的字段`)
      : [`${fieldPath(prefix, at)}: ${issue.message}`];
  };
  return result.error.issues.flatMap((issue) => describe(issue));
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function panelInputIssues(value: unknown, index: number, field: string): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const row = value as Record<string, unknown>;
  const issues: string[] = [];
  if (row.generation === undefined && row.novelAiRequest === undefined) {
    issues.push(`${field}.generation: 缺少单格生成参数（或既有冻结 novelAiRequest）`);
  }
  if (row.generation !== undefined && row.novelAiRequest !== undefined) {
    issues.push(`${field}.generation: 不能与 novelAiRequest 同时提供，避免两份冻结参数冲突`);
  }
  if (row.generation && typeof row.generation === "object" && !Array.isArray(row.generation)) {
    const generation = row.generation as Record<string, unknown>;
    issues.push(...comicCameraIssues(row.angle, generation.camera).map(issue => `${field}.generation.camera: ${issue}`));
  }
  if (typeof row.number === "number" && row.number !== index + 1) {
    issues.push(`${field}.number: 格号必须连续，期望 ${index + 1}`);
  }
  // 两对别名各自检查，不能让第一对冲突遮住第二对。
  for (const [alias, canonical] of [["title", "caption"], ["text", "narration"]] as const) {
    const a = row[alias];
    const b = row[canonical];
    if (typeof a === "string" && typeof b === "string" && a.trim() && b.trim() && a.trim() !== b.trim()) {
      issues.push(`${field}.${alias}: 与 ${field}.${canonical} 冲突；请保留同一份交付文字`);
    }
  }
  return issues;
}

/** 纯输入预检：共享 Tool schemas + Store 领域校验；不读角色库、不创建 Job、不调用 Browser。 */
export function preflightComicGenerationStart(input: Record<string, unknown>): { job: Record<string, unknown>; expectedCostAnlas: number } {
  const expectedCostAnlas = input.expectedCostAnlas ?? 26;
  const issues = [
    ...schemaIssues(costValidator, expectedCostAnlas, "input.expectedCostAnlas"),
    ...schemaIssues(jobValidator, input.job, "input.job"),
  ];
  const job = input.job as Record<string, unknown> | undefined;
  if (Array.isArray(job?.panels)) {
    job.panels.forEach((panel, index) => issues.push(...panelInputIssues(panel, index, `input.job.panels[${index}]`)));
  }
  if (issues.length) throw new ComicGenerationInputError(issues);
  const normalizedJob = { ...job! };
  normalizedJob.panels = (job!.panels as unknown[]).map((panel, index) => normalizeComicPanelTextAliases(panel, `input.job.panels[${index}]`));
  let bible;
  try {
    bible = normalizeComicBible(normalizedJob.bible);
  } catch (error) {
    throw new ComicGenerationInputError([`input.job.${message(error)}`]);
  }
  (normalizedJob.panels as unknown[]).forEach((panel, index) => {
    try { normalizeComicPanel(panel, index + 1, bible); }
    catch (error) {
      const detail = message(error);
      issues.push(`input.job.${detail.startsWith("novelAiRequest") ? `panels[${index}].` : ""}${detail}`);
    }
  });
  if (issues.length) throw new ComicGenerationInputError(issues);
  return { job: normalizedJob, expectedCostAnlas: expectedCostAnlas as number };
}

/** 修订单格同样先完成纯校验，不能先改 Job 再发现参数错误。 */
export function preflightComicGenerationPanel(value: unknown, index: number): Record<string, unknown> {
  const field = "input.panel";
  const issues = [...schemaIssues(panelValidator, value, field), ...panelInputIssues(value, index, field)];
  if (issues.length) throw new ComicGenerationInputError(issues);
  return normalizeComicPanelTextAliases(value, field);
}
