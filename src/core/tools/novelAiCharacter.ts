import path from "node:path";
import type { ToolDef } from "../../types";
import {
  defaultNovelAiCharacterLibraryDir,
  resolveNovelAiCharacter,
} from "../novelAiCharacterLibrary";

export interface NovelAiCharacterToolConfig {
  libraryDir: string;
  maxReferenceBytes: number;
}

export function resolveNovelAiCharacterToolConfig(): NovelAiCharacterToolConfig {
  return {
    libraryDir: defaultNovelAiCharacterLibraryDir(),
    maxReferenceBytes: 20 * 1024 * 1024,
  };
}

export function createNovelAiCharacterTool(
  cfg: NovelAiCharacterToolConfig = resolveNovelAiCharacterToolConfig()
): ToolDef {
  return {
    name: "novelai_character",
    description:
      "按角色名/别名查询薄角色库：返回身份锚点、none|required 参考图策略、候选中仅一张的句柄及可选 notesResource。执行以 Workflow 冻结的句柄为准；未命中/图片缺失明确降级。found:false 只表示本地库未命中，不表示 NovelAI 不认识角色。未命中不自动联网；具名角色在 generation.characters[].identityTag 写已核实的英文 tag（name (work)，括号不加反斜杠），name 保留故事显示名。编译器将 tag 放入该角色正向 Prompt；外貌词不能替代身份。不确定作品或同名角色先澄清，不凭空编 tag、外貌或参考图。不加载全库或补充正文。",
    readOnly: true,
    parameters: {
      type: "object",
      properties: {
        characters: {
          type: "array",
          minItems: 1,
          maxItems: 8,
          items: { type: "string", minLength: 1, maxLength: 160 },
          description: "本次画面涉及的角色名；中文名、英文名或角色库别名均可",
        },
      },
      required: ["characters"],
    },
    async execute(args) {
      if (!Array.isArray(args.characters) || args.characters.length < 1 || args.characters.length > 8) {
        throw new Error("novelai_character.characters 必须包含 1–8 个角色名");
      }
      const characters = args.characters.map((value, index) => {
        if (typeof value !== "string" || !value.trim() || value.length > 160) {
          throw new Error(`novelai_character.characters[${index}] 必须是 1–160 字符的角色名`);
        }
        return value.trim();
      });
      const routes = [];
      for (const character of characters) {
        routes.push(await resolveNovelAiCharacter(path.resolve(cfg.libraryDir), character, cfg.maxReferenceBytes));
      }
      const availableReference = routes.some(route => route.referencePolicy === "required" && route.reference?.available);
      return { routes, ...(availableReference ? { promptPlanning: {
        whenUsingReference: "reference-512-v1",
        compiledTargets: { positive: 480, negative: 416 },
        includes: "Base + all Character fields + compiler defaults; not a per-field allowance",
        instruction: "引用实际启用时走 V4.5：先短写完整动作、身份、服装、场景等要求；仅可有可无的装饰放 optionalDetails，程序按预算整块选入。不要把明确要求移入可选项。先 novelai_compose 查看编译后预算，再保存；固定约束超限不反复缩写。取消引用不是自动解法。无参考图 V5 保持完整装配，不套此预算。",
      } } : {}) };
    },
  };
}
