import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import pino from "pino";
import { loadAgents } from "../../src/config/loadAgents";
import { ContextManager } from "../../src/core/contextManager";
import { agentForActor } from "../../src/core/identity";
import { buildChatMessages } from "../../src/core/promptAssembly";
import { estimateMessageTokens } from "../../src/core/tokenEstimate";
import type { ActorIdentity } from "../../src/types";

async function main(): Promise<void> {
  const logger = pino({ level: "silent" });
  const names = ["main-elaina", "main-aemeath"] as const;
  const loaded = await loadAgents("agents", logger);
  const privateFiles = ["SOUL.md", "MASTER.md", "PREFERENCE.md", "MEMORY.md"] as const;
  const normalize = (text: string) => text.replace(/\r\n?/g, "\n").trim();
  const personas = await Promise.all(names.map(async name => {
    const agent = loaded.find(item => item.name === name);
    assert.ok(agent, `${name} 必须实际装载`);
    const sections = await Promise.all(privateFiles.map(async file => ({
      file,
      content: normalize(await fs.readFile(`agents/${name}/${file}`, "utf8")),
    })));
    return { agent, sections };
  }));
  const context = new ContextManager(logger);
  for (const { agent, sections } of personas) {
    const prompt = agent.systemPrompt;
    const normalizedPrompt = normalize(prompt);
    for (const { file, content } of sections) {
      assert.ok(content, `${agent.name}/${file} 夹具不能为空`);
      assert.equal(normalizedPrompt.split(content).length - 1, 1,
        `${agent.name}/${file} 必须首轮完整装配且只出现一次，不依赖工具重读`);
    }
    assert.doesNotMatch(prompt, /^@(?:SOUL|MASTER|PREFERENCE|MEMORY)\.md\s*$/m, `${agent.name} 不得残留未展开的人格引用`);
    const other = personas.find(item => item.agent.name !== agent.name)!;
    for (const { file, content } of other.sections) {
      // 主人档案可含共享事实；只检查两份文件确实不同的完整私有片段。
      if (!sections.some(section => section.content === content)) {
        assert.ok(!normalizedPrompt.includes(content), `${agent.name} 不得混入 ${other.agent.name}/${file}`);
      }
    }
    for (const platform of ["web", "qq", "discord"] as const) {
      const actor: ActorIdentity = { role: "owner", platform, id: "fixture-owner" };
      const source = { channel: platform, key: `${platform}:${agent.name}:consistency-fixture`, actor };
      const first = buildChatMessages(agentForActor(agent, actor), {
        source, input: "请给普通连裤袜穿搭写两句介绍，不生图。",
      });
      assert.equal(first[0]?.content, prompt, `${agent.name}/${platform} 首轮必须使用自己的完整人格`);
      assert.match(first.at(-1)!.content, /主人本人（已验证/);
      const followup = buildChatMessages(agentForActor(agent, actor), {
        source,
        history: [{ role: "user", content: "旧背景".repeat(300), actor },
          { role: "assistant", content: "此前的回复。" }],
        input: "谁说不行？请核实依据。",
      });
      // A valid hard budget must fit the immutable system/current task; only old history is trimmable.
      const anchorBudget = estimateMessageTokens(followup[0]!) + estimateMessageTokens(followup.at(-1)!) + 64;
      const trimmed = context.build({ ...agent, contextBudget: anchorBudget }, followup);
      assert.equal(trimmed.messages[0]?.content, first[0]?.content,
        `${agent.name}/${platform} 追问或历史裁切不能改变首轮就已提供的 persona/偏好`);
      assert.match(trimmed.messages.at(-1)!.content, /主人本人（已验证/);
      assert.ok(trimmed.stats.droppedMessages > 0, `${agent.name}/${platform} 夹具应实际触发历史裁切`);

      const publicAgent = agentForActor(agent, { role: "other", platform, id: "fixture-guest" });
      assert.equal(normalize(publicAgent.systemPrompt), normalize(await fs.readFile(`agents/${agent.name}/PUBLIC.md`, "utf8")),
        `${agent.name}/${platform} 公开模式只能装载自己的 PUBLIC.md`);
      for (const { file, content } of sections) {
        assert.ok(!normalize(publicAgent.systemPrompt).includes(content), `${agent.name}/${platform} 不能泄露私人 ${file}`);
      }
      for (const field of ["tools", "skills", "workflows", "subagents", "mcpServers", "heartbeats"] as const) {
        assert.deepEqual(publicAgent[field], [], `${agent.name}/${platform} 公开模式不得继承 ${field}`);
      }
      assert.equal(publicAgent.readsGlobalMemory, false);
    }
  }
  console.log("PASS persona consistency prompt contract (both Mains: first-turn assembly / no persona cross-contamination / web-qq-discord identity / trim / public isolation; not live behavior)");
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
