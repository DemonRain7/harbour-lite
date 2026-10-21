import { promises as fs } from "node:fs";
import path from "node:path";
import { readWorkflowTool } from "./readWorkflow";
import type { ToolDef } from "../../types";
import { resourceReadCache } from "../resourceReadCache";
import {
  expandSkillResources,
  loadSkillResourceIndex,
  resolveSkillResourceFile,
  SKILL_RESOURCE_INDEX,
} from "../skillResourceIndex";

/**
 * read_skill —— 技能懒加载。
 * system 里只常驻「技能清单」（名+一句话）；agent 需要某技能详细步骤时调本工具读全文，
 * 避免把所有 SKILL.md 都灌进 context。真身统一位于项目根 skills/，这里只能读取
 * 当前 agent 的 skills/index.md 已挂载条目。
 */
export const readSkillTool: ToolDef = {
  name: "read_skill",
  description:
    "按需只读某技能的 SKILL.md 或其 references/scripts 文本资源（懒加载）。" +
    "读 SKILL.md 同时返回薄目录与声明的基础资料；按目录 path 选模板，依赖自动补读。" +
    "已知需要多个小资源时用 resources 一次批量读取（最多 4 个），避免重复模型往返；" +
    "需要再次取得正文时 reload:true。技能名与触发描述见 system 的『可用技能』清单，用户无需说出技能名。",
  readOnly: true,
  parameters: {
    type: "object",
    properties: {
      name: { type: "string", description: "技能名（skills 清单里列出的）" },
      resource: {
        type: "string",
        description: "可选：技能目录内的相对文本路径，如 references/anatomy.md；省略则读 SKILL.md",
      },
      resources: {
        type: "array",
        minItems: 1,
        maxItems: 4,
        items: { type: "string" },
        description: "可选：一次读取 1–4 个已知的小型文本资源；不能与 resource 同时使用",
      },
      reload: { type: "boolean", description: "仅重读明确请求的资源；已读依赖仍去重，压缩后按需补齐" },
    },
    required: ["name"],
  },
  async execute(args, ctx) {
    const name = String(args.name ?? "").trim();
    if (!name) throw new Error("read_skill: 缺少技能名 name");
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) throw new Error(`read_skill: 非法技能名「${name}」`);
    const skill = ctx.agent.skills?.find((s) => s.name === name);
    if (!skill && name === "novelai-art" && ctx.agent.workflows?.some(workflow => workflow.name === "novelai-generation")) {
      return readWorkflowTool.execute({ ...args, name: "novelai-generation",
        ...(args.resource === "SKILL.md" ? { resource: "WORKFLOW.md" } : {}),
        ...(Array.isArray(args.resources) ? { resources: args.resources.map(resource => resource === "SKILL.md" ? "WORKFLOW.md" : resource) } : {}),
      }, ctx);
    }
    if (!skill) throw new Error(`read_skill: 技能「${name}」没有挂载给 ${ctx.agent.name}`);
    if (args.reload !== undefined && typeof args.reload !== "boolean") throw new Error("read_skill: reload 必须是 boolean");
    const hasSingle = args.resource !== undefined;
    const hasBatch = args.resources !== undefined;
    if (hasSingle && hasBatch) throw new Error("read_skill: resource 与 resources 不能同时使用");
    if (hasBatch && !Array.isArray(args.resources)) throw new Error("read_skill: resources 必须是数组");
    const batchMode = hasBatch;
    const resources = hasBatch
      ? (args.resources as unknown[]).map((value) => String(value ?? "").trim().replace(/\\/g, "/"))
      : [String(args.resource ?? "SKILL.md").trim().replace(/\\/g, "/") || "SKILL.md"];
    if (resources.length < 1 || resources.length > 4) {
      throw new Error("read_skill: resources 一次只允许 1–4 个资源");
    }
    if (resources.some((resource) => !resource)) throw new Error("read_skill: 资源路径不能为空");
    if (new Set(resources).size !== resources.length) throw new Error("read_skill: resources 不得包含重复路径");
    const index = await loadSkillResourceIndex(skill.directory);
    const expanded = expandSkillResources(index, resources);
    if (index && resources.includes("SKILL.md") && !expanded.includes(SKILL_RESOURCE_INDEX)) {
      expanded.push(SKILL_RESOURCE_INDEX);
    }
    if (expanded.length > 16) throw new Error("read_skill: 包含索引和依赖后最多允许 16 个资源");
    const seen = resourceReadCache(ctx);
    const key = (resource: string) => `read_skill:${skill.directory}:${name}:${resource}`;
    const skip = (resource: string) => seen?.has(key(resource)) && !(args.reload === true && resources.includes(resource));
    const alreadyLoaded = expanded.filter(skip);
    const pending = expanded.filter((resource) => !skip(resource));
    if (!pending.length) {
      return {
        skill: name,
        directory: path.relative(process.cwd(), skill.directory).split(path.sep).join("/"),
        source: skill.source,
        alreadyLoaded,
        note: "这些资源当前上下文阶段已经加载，不重复回灌全文；正文不在上下文或需要最新文件时，用 reload:true 按需重读。",
      };
    }
    let totalBytes = 0;
    const loaded: Array<{ resource: string; content: string }> = [];
    for (const resource of pending) {
      try {
        const { target } = await resolveSkillResourceFile(skill.directory, resource);
        const stat = await fs.stat(target);
        if (!stat.isFile()) throw new Error("not a file");
        totalBytes += stat.size;
        if (stat.size > 512 * 1024 || totalBytes > 512 * 1024) {
          throw new Error("本次资源总量超过 512KB，只允许按需读取小型文本资源");
        }
        // 目录只交付一份紧凑元数据，不展开任何未选中的模板正文。
        const content = resource === SKILL_RESOURCE_INDEX && index
          ? JSON.stringify(index)
          : await fs.readFile(target, "utf8");
        loaded.push({ resource, content });
      } catch (e) {
        const detail = e instanceof Error ? e.message : String(e);
        throw new Error(`read_skill: 无法读取技能「${name}」资源「${resource}」：${detail}`);
      }
    }
    // 整批成功后才发布加载状态；失败时模型没有收到任何正文，重试仍须返回全文。
    for (const { resource } of loaded) {
      seen?.add(key(resource));
      ctx.logger.info({ skill: name, resource, source: skill.source }, "skill:loaded");
    }
    const common = {
      skill: name,
      directory: path.relative(process.cwd(), skill.directory).split(path.sep).join("/"),
      source: skill.source,
    };
    return batchMode || expanded.length > 1
      ? { ...common, resources: loaded, ...(alreadyLoaded.length ? { alreadyLoaded } : {}) }
      : { ...common, ...loaded[0], ...(alreadyLoaded.length ? { alreadyLoaded } : {}) };
  },
};
