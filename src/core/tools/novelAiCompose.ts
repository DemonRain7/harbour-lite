import type { ToolDef } from "../../types";
import { composeNovelAiPromptBundle, type NovelAiComposeInput, type NovelAiBrowserPromptForm, type NovelAiReferenceAssembly } from "../novelAiPromptComposer";
import { NOVELAI_TEMPLATE_MAX_SELECTIONS } from "../novelAiTemplateModules";

const templateModulesSchema = {
  type: "array", maxItems: NOVELAI_TEMPLATE_MAX_SELECTIONS,
  description: "Select registered parameterized templates after read_workflow loads their contracts. Declared requires add scoped modules; provide missing creative values on the target. Supply id + values, never copied wording or model/version. Unknown/conflicting parameters fail before generation.",
  items: { type: "object", additionalProperties: false, required: ["id"], properties: {
    id: { type: "string", minLength: 1, maxLength: 80 },
    values: { type: "object", maxProperties: 16, additionalProperties: {
      anyOf: [{ type: "string", minLength: 1, maxLength: 80 },
        { type: "array", maxItems: 8, uniqueItems: true, items: { type: "string", minLength: 1, maxLength: 80 } }],
    } },
  } },
};

// Canonical and legacy locations share the exact same leaf schema.
const garmentsSchema = { type: "array", maxItems: 12, items: { type: "string", minLength: 1, maxLength: 300 } };
const hosierySchema = {
  type: "object",
  properties: {
    color: { type: "string", enum: ["white", "nude", "black"] },
    structure: { type: "string", enum: ["standard", "male-sheath"] },
    denier: { type: "integer", minimum: 5, maximum: 80 },
  },
  required: ["color"],
};
const underwearSchema = {
  type: "object",
  additionalProperties: false,
  description: "Optional underwear layer beside hosiery within outfit. worn = panties beneath the pantyhose; none = no second garment (never auto-expands body detail). Omitted = legacy compile behavior.",
  properties: {
    state: { type: "string", enum: ["worn", "none"] },
    color: { type: "string", minLength: 1, maxLength: 80, description: "Only valid when state=worn; panty color" },
    style: { type: "string", minLength: 1, maxLength: 160, description: "Only valid when state=worn; optional panty style" },
  },
  required: ["state"],
};

/**
 * 角色 Prompt 编译器。角色/服装/动作分别通过结构化参数进入，避免 Agent 临场把多人
 * 身份、材质和空间关系拼成一段不可验证的文本。
 */
export const novelAiComposeTool: ToolDef = {
  name: "novelai_compose",
  description:
    "确定性编译一个画面的 0–6 人 NovelAI 提示词：身份/服装/动作写入独立角色，关系/构图/场景放 Base。固定模板由程序装配。实际 reference/V4.5 返回本地预算，超限用当前稿件 inspect_prompt/revise_prompt 整体精简（含固定措辞），不机械截尾。无图 V5 完整装配不变。网页计数仍是提交门禁。多格漫画派 comic_generator。",
  readOnly: true,
  parameters: {
    type: "object",
    properties: {
      referencePromptRevision: { type: "object", additionalProperties: false,
        description: "程序保存的整稿精简结果，通常由 run_workflow revise_prompt 回填，不手工填元数据；仅实际 reference/V4.5 使用。",
        required: ["version", "sourceHash", "prompt"], properties: {
          version: { type: "integer", enum: [1] }, sourceHash: { type: "string", pattern: "^[a-f0-9]{64}$" },
          prompt: { type: "object", additionalProperties: false,
            required: ["basePrompt", "undesiredPrompt", "characterPrompts", "characterUndesiredPrompts"], properties: {
              basePrompt: { type: "string", minLength: 1, maxLength: 32768 }, undesiredPrompt: { type: "string", maxLength: 32768 },
              characterPrompts: { type: "array", maxItems: 6, items: { type: "string", minLength: 1, maxLength: 32768 } },
              characterUndesiredPrompts: { type: "array", maxItems: 6, items: { type: "string", maxLength: 32768 } },
            } },
        } },
      reference: { anyOf: [{ type: "string", enum: ["auto", "none"] }, {
        type: "object", additionalProperties: false, properties: { attachmentIndex: { type: "integer", minimum: 0 } }, required: ["attachmentIndex"],
      }] },
      resolution: { type: "object", additionalProperties: false, properties: {
        category: { type: "string", enum: ["Normal", "Large", "Wallpaper", "Small", "Custom"] },
        width: { type: "integer", minimum: 64, maximum: 4096 }, height: { type: "integer", minimum: 64, maximum: 4096 },
      }, required: ["category"] },
      characters: {
        type: "array",
        minItems: 0,
        maxItems: 6,
        items: {
          type: "object",
          properties: {
            name: { type: "string", minLength: 1, maxLength: 160 },
            identityTag: { type: "string", minLength: 1, maxLength: 300,
              description: "未入角色库的具名角色：已核实的英文 tag，例如 name (work)，不加反斜杠、权重或外貌词。name 可保留中文/故事名；英文带作品限定的 name 可自动沿用。命中库时沿用库 tag，不用此字段换人。" },
            type: { type: "string", enum: ["female", "male", "other"] },
            action: { type: "string", minLength: 1, maxLength: 800, description: "只属于该角色的局部动作，不写另一人的外貌" },
            position: {
              type: "string",
              enum: ["left", "right", "center", "foreground", "background", "front", "behind"],
              description: "该角色在多人构图中的空间位置；省略时才按人数确定性分配",
            },
            expression: { type: "string", minLength: 1, maxLength: 300 },
            outfit: {
              description: "New inputs use {garments?, hosiery?, underwear?}. Legacy garment arrays and sibling layers remain supported; duplicate layer values must agree.",
              anyOf: [
                { type: "object", additionalProperties: false,
                  properties: { garments: garmentsSchema, hosiery: hosierySchema, underwear: underwearSchema } },
                garmentsSchema,
              ],
            },
            templateFragments: { type: "array", maxItems: 32, items: { type: "string", minLength: 1, maxLength: 160 },
              description: "该角色专属的已登记固定模板片段 id，可选 #序号 取菜单项；程序按登记的作用域装配，一个角色的片段不会进入另一个角色。" },
            templateModules: templateModulesSchema,
            extraAnchors: {
              type: "array",
              maxItems: 24,
              items: { type: "string", minLength: 1, maxLength: 300 },
              description: "外貌补充，不替代具名角色 identityTag；无库、无明确 tag 的原创/未知角色必填。命中库时只补新细节，明确替换库内外貌用 identityPatch",
            },
            extraUndesired: { type: "array", maxItems: 24, items: { type: "string", minLength: 1, maxLength: 300 } },
            identityPatch: {
              type: "object",
              additionalProperties: false,
              description: "本格明确的外貌替换，不改角色库。from/removeNegative 必须完整匹配库内锚点（忽略大小写和空白）；不猜测冲突项。",
              properties: {
                replacePositive: {
                  type: "array", maxItems: 24,
                  items: {
                    type: "object", additionalProperties: false, required: ["from", "to"],
                    properties: {
                      from: { type: "string", minLength: 1, maxLength: 300 },
                      to: { type: "string", minLength: 1, maxLength: 300 },
                    },
                  },
                },
                removeNegative: { type: "array", maxItems: 24, items: { type: "string", minLength: 1, maxLength: 300 } },
              },
            },
            hosiery: hosierySchema,
            underwear: underwearSchema,
          },
          required: ["name", "type", "action"],
        },
      },
      interaction: { type: "string", minLength: 1, maxLength: 1200, description: "双方共享的唯一核心互动，只写一次" },
      setting: { type: "string", minLength: 1, maxLength: 800 },
      camera: { type: "string", minLength: 1, maxLength: 500 },
      lighting: { type: "string", minLength: 1, maxLength: 500 },
      style: { type: "string", minLength: 1, maxLength: 500 },
      globalUndesired: { type: "array", maxItems: 40, items: { type: "string", minLength: 1, maxLength: 300 } },
      templateFragments: { type: "array", maxItems: 32, items: { type: "string", minLength: 1, maxLength: 160 },
        description: "已登记固定模板片段的 id（Base 作用域），可选 #序号 取菜单项。正文由程序从 references/assembly.json 读取并校验哈希；不要手抄模板正文。角色专属片段放进 characters[].templateFragments。" },
      templateModules: templateModulesSchema,
      optionalDetails: { type: "object", additionalProperties: false,
        description: "Only discretionary decoration, in priority order. Never move explicit user requirements, actions, identity, clothing or material here to fit a budget. Reference V4.5 packs whole optional blocks locally; no-reference V5 includes all. Existing fields remain required and are never trimmed.",
        properties: {
          positive: { type: "array", maxItems: 16, items: { type: "string", minLength: 1, maxLength: 300 } },
          negative: { type: "array", maxItems: 16, items: { type: "string", minLength: 1, maxLength: 300 } },
        } },
      orientation: { type: "string", enum: ["landscape", "portrait", "square"], default: "square",
        description: "Default square (Normal 1024×1024) for images and comic panels. Use another aspect only when explicitly requested, not inferred from portrait subjects or story scenes." },
      numberOfImages: { type: "integer", minimum: 1, maximum: 4 },
    },
    required: ["characters", "interaction", "setting", "camera", "lighting"],
  },
  async execute(args, ctx) {
    const input = args as unknown as NovelAiComposeInput;
    let requiredForm: NovelAiBrowserPromptForm | undefined;
    let assembly: NovelAiReferenceAssembly | undefined;
    const bundle = await composeNovelAiPromptBundle(input, input.reference === "none" ? {} : {
      onRequiredForm(form) { requiredForm = form; },
      onReferenceAssembly(value) { assembly = value; },
    });
    // The shared workflow schemas import this ToolDef; defer runtime compilation
    // until invocation instead of creating a schema-initialization cycle.
    const { previewNovelAiReferenceCompilation } = await import("../workflows/novelAiGenerationUnit");
    const preview = await previewNovelAiReferenceCompilation(input, bundle, ctx, requiredForm, assembly);
    if (!preview) return bundle;
    const { width: _width, height: _height, ...browserForm } = preview.browserForm as NovelAiBrowserPromptForm & { width: number; height: number };
    return { ...bundle, browserForm, bundleId: preview.bundleId,
      referencePromptBudget: preview.referencePromptBudget, referencePromptAssembly: preview.referencePromptAssembly,
      ...(preview.referencePromptRefinement ? { referencePromptRefinement: preview.referencePromptRefinement } : {}) };
  },
};
