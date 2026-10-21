import { promises as fs } from "node:fs";
import path from "node:path";
import type { ToolDef } from "../../types";
import { expandSkillResources, loadSkillResourceIndex, resolveSkillResourceFile, SKILL_RESOURCE_INDEX } from "../skillResourceIndex";
import { workflowInputGuide } from "../workflows/workflowInputGuide";
import { NOVELAI_WORKFLOW_ALIASES, workflowContextFor } from "../workflows/workflowAliases";
import { COMIC_DRAFT_CONTRACT, COMIC_STORYBOARD_CONTRACT } from "../workflows/comicAuthoringDraft";
import { resourceReadCache } from "../resourceReadCache";
import type { describeNovelAiTemplateModules } from "../novelAiTemplateModules";
import { isSfwAuthoringResource, SFW_ART_DIRECTION, sfwAuthoringResourceIndex, usesSfwArtDirection } from "../workflows/novelAiSfwAuthoring";

const CACHE_PREFIX = "read_workflow:loaded:";

/** Thin public contract; creative nodes explicitly load the catalog and conditional resources. */
export const readWorkflowTool: ToolDef = {
  name: "read_workflow",
  description: "按需读取已挂载 Workflow 的契约或资源。resource 省略只读薄入口；resources 可批量读 1–4 个资源，索引及模块依赖自动补读去重。需要再次取得正文时 reload:true。执行用 run_workflow。",
  readOnly: true,
  parameters: {
    type: "object", additionalProperties: false,
    properties: {
      name: { type: "string", description: "已挂载 Workflow 名称" },
      resource: { type: "string", description: "相对文本路径；省略 WORKFLOW.md；input-staging 为当前写稿指南，input-staging-legacy 为旧稿协议；comic-storyboard-schema 为新分镜字段，comic-draft-schema 含旧完整稿字段" },
      resources: { type: "array", minItems: 1, maxItems: 4, items: { type: "string" }, description: "批量读取，不能同时传 resource" },
      reload: { type: "boolean", description: "仅重读明确请求的资源；依赖仍按需补齐，不预载全部模板" },
    },
    required: ["name"],
  },
  async execute(args, ctx) {
    const name = String(args.name ?? "").trim();
    ctx = workflowContextFor(name, ctx);
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) throw new Error("read_workflow: 非法名称");
    const workflow = ctx.agent.workflows?.find(candidate => candidate.name === name);
    if (!workflow) throw new Error(`read_workflow: Workflow「${name}」没有挂载给 ${ctx.agent.name}`);
    const novelAiWorkflow = name === "novelai-generation" || Object.hasOwn(NOVELAI_WORKFLOW_ALIASES, name);
    if (args.reload !== undefined && typeof args.reload !== "boolean") throw new Error("reload 必须是 boolean");
    if (args.resource !== undefined && args.resources !== undefined) throw new Error("resource 与 resources 不能同时使用");
    if (args.resources !== undefined && !Array.isArray(args.resources)) throw new Error("resources 必须是数组");
    const requested = args.resources !== undefined ? (args.resources as unknown[]).map(String)
      : [String(args.resource ?? NOVELAI_WORKFLOW_ALIASES[name] ?? "WORKFLOW.md")];
    // These are virtual resources, not guessed filesystem paths. Only exact,
    // known aliases are accepted; all other paths retain normal containment checks.
    const resources = requested.map(value => {
      const resource = value.trim().replace(/\\/g, "/");
      if (novelAiWorkflow && resource.toLowerCase() === SKILL_RESOURCE_INDEX) return SKILL_RESOURCE_INDEX;
      const character = /^references\/characters\/(elaina|assistant)\.md$/.exec(resource);
      if (name === "novelai-generation" && character) return `assets/character-library/${character[1]}/notes.md`;
      const alias = /^references\/(input-staging|input-staging-legacy|comic-draft-schema|comic-storyboard-schema)\.md$/.exec(resource);
      return alias ? alias[1]! : resource;
    });
    if (!resources.length || resources.length > 4 || resources.some(value => !value)
      || new Set(resources).size !== resources.length) throw new Error("一次读取 1–4 个不同的非空资源路径");
    const sfwAuthoring = novelAiWorkflow && usesSfwArtDirection(ctx);
    const fullIndex = await loadSkillResourceIndex(workflow.directory);
    const index = novelAiWorkflow ? sfwAuthoringResourceIndex(fullIndex, sfwAuthoring) : fullIndex;
    if (novelAiWorkflow && !sfwAuthoring && resources.some(isSfwAuthoringResource)) {
      throw new Error("read_workflow: SFW 创作资料只对显式 contentRating:sfw 的画师任务开放，旧任务不自动切换。");
    }
    const expanded = name === "novelai-generation"
      ? await (await import("../novelAiTemplateModules")).expandNovelAiTemplateModuleResources(workflow.directory, index, resources)
      : expandSkillResources(index, resources);
    if (sfwAuthoring && expanded.some(resource => ["WORKFLOW.md", "references/illustration.md", "references/prompting.md", "input-staging"].includes(resource)) && !expanded.includes(SFW_ART_DIRECTION)) {
      expanded.push(SFW_ART_DIRECTION);
    }
    if (novelAiWorkflow && !sfwAuthoring && expanded.some(isSfwAuthoringResource)) {
      throw new Error("read_workflow: 非 SFW 任务不能通过依赖加载 SFW 创作资料。");
    }
    if (index && resources.some(resource => resource.startsWith("references/")) && !expanded.includes(SKILL_RESOURCE_INDEX)) expanded.push(SKILL_RESOURCE_INDEX);
    if (expanded.length > 16) throw new Error("read_workflow: 包含依赖后最多 16 个资源");
    const bound = !!ctx.execution?.delegationTasks?.taskRef;
    const seen = resourceReadCache(ctx);
    // Virtual guides vary by caller; sharing a runState must not hide a different author's guide.
    const implicitIndex = name === "novelai-generation" && !resources.includes(SKILL_RESOURCE_INDEX);
    const cacheKey = (resource: string, fullIndex = !implicitIndex) => `${CACHE_PREFIX}${workflow.directory}:${name}:${resource}${
      resource === "input-staging" || resource === "input-staging-legacy" ? `:${ctx.agent.name}:${bound}` : ""}${
      resource === SKILL_RESOURCE_INDEX && !fullIndex ? ":discovery" : ""}${
      resource === SKILL_RESOURCE_INDEX && sfwAuthoring ? ":sfw-authoring" : ""}`;
    const loaded: Array<{ resource: string; content: string }> = [];
    const alreadyLoaded: string[] = [];
    let moduleContracts: ReturnType<typeof describeNovelAiTemplateModules> | undefined;
    let bytes = 0;
    for (const resource of expanded) {
      const wasRead = seen?.has(cacheKey(resource)) || (resource === SKILL_RESOURCE_INDEX && implicitIndex && seen?.has(cacheKey(resource, true)));
      if (wasRead && !(args.reload === true && resources.includes(resource))) { alreadyLoaded.push(resource); continue; }
      let content: string;
      if (resource === "input-staging" || resource === "input-staging-legacy") {
        content = workflowInputGuide(name, ctx.agent.name, bound, resource === "input-staging-legacy");
      }
      else if (resource === "comic-draft-schema" && name === "novelai-generation") content = JSON.stringify(COMIC_DRAFT_CONTRACT);
      else if (resource === "comic-storyboard-schema" && name === "novelai-generation") content = JSON.stringify(COMIC_STORYBOARD_CONTRACT);
      else {
        const { target } = await resolveSkillResourceFile(workflow.directory, resource);
        const stat = await fs.stat(target);
        if (stat.size > 256 * 1024) throw new Error("read_workflow: 单个资源超过 256KB");
        // index.requires has ALREADY driven dependency-first reads above. This
        // thin presentation is not the execution graph; use_when stays semantic
        // author discovery. An explicit index read returns the complete metadata.
        content = resource === SKILL_RESOURCE_INDEX && index ? JSON.stringify(implicitIndex
          ? { version: index.version, resources: index.resources.map(({ name, path, description, use_when }) => ({ name, path, description, use_when })) }
          : index) : await fs.readFile(target, "utf8");
        if (name === "novelai-generation" && resource === "references/template-parameters.md") {
          const { listNovelAiTemplateModules } = await import("../novelAiTemplateModules");
          content += "\n\n已登记模块导航（不是 Prompt 正文；详细参数随来源资源按需返回）：\n" +
            JSON.stringify(await listNovelAiTemplateModules(workflow.directory));
        } else if (name === "novelai-generation" && resource.startsWith("references/") && resource !== SKILL_RESOURCE_INDEX) {
          moduleContracts ??= import("../novelAiTemplateModules")
            .then(api => api.describeNovelAiTemplateModules(workflow.directory, expanded));
          const selected = (await moduleContracts).filter(module => module.source === resource);
          if (selected.length) content += "\n\n程序生成的本资源参数契约（不是 Prompt 正文）：\n" + JSON.stringify(selected) +
            (selected.some(module => module.requires?.length)
              ? "\nrequires 由程序按条件补齐模块；same=当前作用域，base=共享区，each-character=每个角色。values 是依赖约束，fromParameter 读取父参数。缺少创作参数时补目标模块的 values；不得跳过校验只装无条件词。读取本页及依赖不等于已选择模块。" : "");
        }
      }
      bytes += Buffer.byteLength(content);
      if (bytes > 512 * 1024) throw new Error("read_workflow: 本次资源总量超过 512KB");
      loaded.push({ resource, content });
    }
    // A failed batch delivers nothing and must not poison the read cache.
    for (const { resource } of loaded) {
      seen?.add(cacheKey(resource));
      ctx.logger.info({ workflow: name, resource }, "workflow:loaded");
    }
    const common = { workflow: name, version: workflow.version, executor: workflow.executor,
      directory: path.relative(process.cwd(), workflow.directory).split(path.sep).join("/") };
    if (!loaded.length) return { ...common, resource: resources[0], alreadyLoaded: true, loadedResources: alreadyLoaded, note: "当前上下文阶段已加载；正文不在上下文或需要核对最新文件时，用 reload:true 按需重读。" };
    return { ...common,
      ...(args.resources !== undefined || expanded.length > 1 ? { resources: loaded } : loaded[0]),
      ...(alreadyLoaded.length ? { alreadyLoaded } : {}),
      ...(resources.includes("WORKFLOW.md") ? {
        inputTransport: name === "novelai-generation" && ctx.agent.name.startsWith("main-")
          ? "Main 只用 start 交原始要求；写稿、分块与字段契约由内部作者读取，不需要 Main 准备计划。"
          : "作者按需读取 input-staging，使用当前稿件或兼容的 prepare_input 分块后提交。",
        ...(ctx.execution?.delegationTasks?.taskRef ? { taskRef: ctx.execution.delegationTasks.taskRef,
          draftPersistence: "新漫画 begin_storyboard/save_scene；旧完整稿 begin_draft/save_panel；画师 save_draft。inspect_draft 核对、submit_draft 提交。已有 Job 用 status/resume input:{}，不重造稿。" } : {}),
      } : {}),
    };
  },
};
