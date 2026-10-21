import path from "node:path";
import { promises as fsp } from "node:fs";
import type { ToolDef } from "../../types";
import { resolveWrite } from "../permissions";
import { createAndApplyProposal } from "../../governance/proposalStore";
import { formatZonedIso } from "../timeZone";

/**
 * skill-creator —— create_skill 工具：按自然语言需求在全局注册表脚手架技能
 * skills/<id>/，遵循 https://agentskills.io/specification：
 *   - SKILL.md                 必需；frontmatter.name + description
 *   - references/reference.md  可选的按需参考
 *   - evals/eval.yaml          Harbour 的可选回归用例（规范允许附加目录）
 *
 * Skill 真身只保留一份；是否授权给某 agent，由其 skills/index.md 挂载白名单决定。
 * 路径经 resolveWrite 过 sandbox 写权限校验。
 */

const SKILLS_ROOT = path.resolve(process.cwd(), "skills");

function today(): string {
  return formatZonedIso(Date.now()).slice(0, 10);
}

function slug(s: string): string {
  return String(s).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/-+/g, "-").replace(/^-+|-+$/g, "");
}

function skillMd(id: string, title: string, description: string, tags: string[], steps: string): string {
  const desc = description.replace(/\s+/g, " ").trim();
  return `---
name: ${id}
description: >-
  ${desc}
metadata:
  status: "draft"
  created: "${today()}"${tags.length ? `\n  tags: ${JSON.stringify(tags.join(","))}` : ""}
---

# ${title}

> ${description}

## 何时用
- （触发条件：什么情况下该召唤这个技能）

## 步骤（playbook）
${steps || "1. （第一步）\n2. （第二步）\n3. （收尾：给出结论 / 产物）"}

## 注意
- 详细概念 / 参数 / gotcha 见 [references/reference.md](references/reference.md)。
- Harbour 回归用例见 [evals/eval.yaml](evals/eval.yaml)。
`;
}

function referenceMd(title: string, description: string): string {
  return `# ${title} · Reference

## 概念
- （关键概念）

## 参数 / 输入
- （这个技能需要的输入与含义）

## Gotcha
- （容易踩的坑）
`;
}

function evalYaml(id: string, title: string): string {
  return `# eval：${title}（${id}）
# 每条用例描述一次期望行为，便于回归。
cases:
  - name: 基本可用
    input: "（给这个技能的典型输入）"
    expect: "（期望产物 / 结论的判定要点）"
`;
}

export const createSkillTool: ToolDef = {
  name: "create_skill",
  description:
    "按 Agent Skills 开放规范在项目根 skills/ 脚手架全局技能真身（SKILL.md + references/ + evals/）。创建后需在目标 agent 的 skills/index.md 中显式挂载。",
  parameters: {
    type: "object",
    properties: {
      id: { type: "string", description: "技能 id（kebab-case，作目录名）" },
      title: { type: "string", description: "技能标题" },
      description: { type: "string", description: "一句话说明这个技能干什么" },
      steps: { type: "string", description: "可选：playbook 步骤正文（markdown）" },
      tags: { type: "array", description: "可选：标签数组" },
    },
    required: ["id", "title", "description"],
  },
  async execute(args, ctx) {
    const id = slug(String(args.id ?? ""));
    if (!id || id.length > 64) throw new Error("create_skill: id 非法（需 1–64 字符的小写 kebab-case）");
    const title = String(args.title ?? id);
    const description = String(args.description ?? "").replace(/\s+/g, " ").trim();
    if (!description || description.length > 1024) {
      throw new Error("create_skill: description 必须是 1–1024 字符，并说明技能做什么、何时使用");
    }
    const steps = args.steps ? String(args.steps) : "";
    const tags = Array.isArray(args.tags) ? args.tags.map(String) : [];
    const skillDir = path.resolve(SKILLS_ROOT, id);
    if (!skillDir.startsWith(SKILLS_ROOT + path.sep)) throw new Error("create_skill: 目标路径越界");
    resolveWrite(ctx, skillDir); // sandbox：越权写直接拒绝

    const files = {
      "SKILL.md": skillMd(id, title, description, tags, steps),
      "references/reference.md": referenceMd(title, description),
      "evals/eval.yaml": evalYaml(id, title),
    };
    // 【走 governance 但自动通过】以前这里是直接 fs.writeFile：能用，但零留痕——
    // 事后查不到「这技能哪来的、之前什么样、怎么退回去」。改走 createAndApplyProposal 后，
    // proposals.json + audit.jsonl 会留下发起方/理由/前后全文，配合 git 历史可复原任意版本。
    // 自动通过是因为「agent 建自己的新技能」属正常产物、不该卡人工审批；
    // 需要人把关的是改既有人格/边界那类，那些仍走人工审批。
    // 【先探路再动手】三个文件是一组，不该出现「写了一半」。
    // 没有事务可用，就退而求其次：任一目标已存在就整体拒绝，不做部分覆盖。
    // 否则中途失败会留半个技能目录，而重试又会被 applyProposal 的 beforeHash 比对
    // 判成「目标文件已变化」——形成一个自己解不开的死结。
    const existing: string[] = [];
    for (const name of Object.keys(files)) {
      try {
        await fsp.access(path.join(skillDir, name));
        existing.push(name);
      } catch { /* 不存在才是正常情况 */ }
    }
    if (existing.length) {
      throw new Error(
        `create_skill: 技能「${id}」下已存在 ${existing.join(" / ")}。` +
          `为免覆盖既有内容，这里不做部分写入——换个 id，或先在面板上处理掉这些文件。`
      );
    }

    const proposals: string[] = [];
    for (const [name, content] of Object.entries(files)) {
      try {
        const p = await createAndApplyProposal({
          targetType: "skill",
          targetPath: `skills/${id}/${name}`,
          operation: "write",
          content,
          reason: `create_skill：${ctx.agent.name} 脚手架新技能「${id}」`,
          sourceAgent: ctx.agent.name,
        });
        proposals.push(p.id);
      } catch (e) {
        // 中途失败：把这一轮已经落盘的文件撤掉，让目录回到「干净不存在」的状态，
        // 这样重试不会撞上 beforeHash 死结。撤销失败也要如实说，不假装成功。
        const rolledBack: string[] = [];
        const failed: string[] = [];
        for (const done of proposals.length ? Object.keys(files).slice(0, proposals.length) : []) {
          try { await fsp.rm(path.join(skillDir, done), { force: true }); rolledBack.push(done); }
          catch { failed.push(done); }
        }
        throw new Error(
          `create_skill: 建「${id}」失败于 ${name}（${e instanceof Error ? e.message : String(e)}）。` +
            (rolledBack.length ? `已撤回：${rolledBack.join(" / ")}。` : "") +
            (failed.length ? `⚠ 这些没能撤回，需手动清理：${failed.join(" / ")}。` : "可以直接重试。")
        );
      }
    }
    ctx.logger.info({ by: ctx.agent.name, id, proposals }, "create_skill:scaffolded");
    return {
      created: `skills/${id}/`,
      files: Object.keys(files),
      proposals,
      note:
        `已脚手架全局真身并落盘（每个文件都留了自动通过的 governance 提案，可在面板查看/复原）。` +
        `为避免隐式扩权，本工具不会自动授权；请把「${id}」加入目标 agent 的 skills/index.md frontmatter.skills。`,
    };
  },
};
