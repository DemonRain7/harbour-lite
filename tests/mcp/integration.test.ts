import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile, access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import pino from "pino";
import { z } from "zod";
import { loadAgents } from "../../src/config/loadAgents";
import { createMcpTools } from "../../src/core/tools/mcp";
import { RemoteMcpClient } from "../../src/mcp/remoteClient";
import { ClaudeAgentSdkBackend } from "../../src/core/backends/claudeAgentSdk";
import { CodexAppServerBackend } from "../../src/core/backends/codexAppServer";
import { agentForActor } from "../../src/core/identity";
import type { Agent, ToolContext, CompletionRequest } from "../../src/types";

const logger = pino({ level: "silent" });
const root = process.cwd();
const read = (file: string) => readFile(path.join(root, file), "utf8");
const names = ["main-elaina", "main-aemeath"];
async function mains() { return (await loadAgents("agents", logger)).filter(agent => names.includes(agent.name)); }

test("both actual Main manifests mount one Exa MCP, matching entry points, proactive policy and generated schemas", async () => {
  const agents = await mains(); assert.equal(agents.length, 2);
  for (const agent of agents) {
    assert.equal(agent.mcpServers?.filter(server => server.name === "exa").length, 1);
    assert.ok(!agent.tools.includes("web_search"));
    for (const tool of createMcpTools()) {
      assert.ok(agent.tools.includes(tool.name));
      assert.ok(agent.systemPrompt.includes(`- \`${tool.name}\` — ${tool.description}`));
    }
    assert.match(agent.systemPrompt, /主动联网查证/);
    assert.match(agent.systemPrompt, /不等用户说工具名/);
    assert.match(agent.systemPrompt, /用户明确禁止联网时不搜索/);
    assert.match(agent.systemPrompt, /限流或失败就如实说明/);
    const publicAgent = agentForActor(agent, { role: "other", platform: "qq", id: "fixture-public" });
    assert.deepEqual(publicAgent.mcpServers, []); assert.deepEqual(publicAgent.tools, []);
  }
  assert.deepEqual(agents[0]!.mcpServers, agents[1]!.mcpServers);
});

test("custom REST search and its UI/settings/registration are completely removed", async () => {
  for (const file of ["src/search/exa.ts", "src/search/api.ts", "src/core/tools/webSearch.ts", "web/web-search.js", "web/web-search.css"]) {
    await assert.rejects(access(path.join(root, file)));
  }
  for (const file of ["src/runtime.ts", "src/server/api.ts", "src/config/env.ts", "web/app.js", "web/index.html", "package.json", "scripts/build-indexes.ts"]) {
    assert.equal(/createWebSearchTools|HarbourWebSearch|ExaSearchService|WEB_SEARCH_DAILY_REQUEST_LIMIT|EXA_API_KEY|\/api\/search\/|web-search\.(css|js)/.test(await read(file)), false, `${file} 残留旧搜索接入`);
  }
});

type Sdk = Awaited<ReturnType<NonNullable<ConstructorParameters<typeof ClaudeAgentSdkBackend>[0]["loadSdk"]>>>;
function testService() {
  const calls: unknown[] = [];
  const service = new RemoteMcpClient(async () => ({
    async listTools() { return { tools: [{ name: "web_search_exa", description: "official schema fixture", inputSchema: {
      type: "object" as const, properties: { query: { type: "string" }, objective: { type: "string" } }, required: ["query", "objective"],
    } }] }; },
    async callTool(params) { calls.push(params); return { content: [{ type: "text", text: "https://www.typescriptlang.org/docs/" }] }; },
    async close() {},
  }));
  return { calls, tools: createMcpTools(service) };
}
function request(agent: Agent, tools: ReturnType<typeof createMcpTools>, backend: string): CompletionRequest {
  const ctx: ToolContext = { agent, logger, runState: new Map(), permissionMode: "plan",
    source: { channel: "web", key: "web:mcp-offline", actor: { role: "owner", platform: "web", id: "fixture" } } };
  return { modelRef: `${backend}/fixture`, model: "fixture", messages: [{ role: "system", content: "offline protocol test" }, { role: "user", content: "查 TypeScript 官方文档并给出处" }],
    tools, toolContext: ctx, permissionMode: "plan", maxTurns: 8 };
}

test("Claude SDK executes official MCP through governed tools, no duplicate native server, nested args survive", async () => {
  for (const agent of await mains()) {
    const f = testService();
    const handlers = new Map<string, (args: unknown) => Promise<any>>();
    const sdk = {
      tool(name: string, _description: string, shape: z.ZodRawShape, handler: (args: unknown) => Promise<unknown>) {
        handlers.set(name, args => handler(z.object(shape).parse(args)));
        return { name };
      },
      createSdkMcpServer() { return { type: "sdk", name: "harbour_tools", instance: {} }; },
      query({ options }: { options: any }) {
        assert.equal(options.mcpServers.exa, undefined);
        assert.ok(options.allowedTools.includes("mcp__harbour_tools__call_mcp"));
        return (async function* () {
          const catalog = await handlers.get("read_mcp")!({ server: "exa" });
          assert.match(JSON.stringify(catalog), /official schema fixture/);
          const result = await handlers.get("call_mcp")!({ server: "exa", tool: "web_search_exa", arguments: { query: "public TypeScript docs", objective: "Find official documentation" } });
          assert.match(JSON.stringify(result), /typescriptlang/);
          yield { type: "result", subtype: "success", result: "MCP fixture passed" };
        })();
      },
    } as unknown as Sdk;
    const backend = new ClaudeAgentSdkBackend({ apiKey: "offline", authToken: "", baseURL: "https://fixture.invalid", defaultModel: "fixture", fallbackModel: "",
      uploadDir: os.tmpdir(), logger, loadSdk: async () => sdk });
    Object.defineProperty(backend, "buildEnv", { value: () => ({}) });
    const result = await backend.complete(request(agent, f.tools, "claude-agent"));
    assert.equal(result.message.content, "MCP fixture passed"); assert.equal(f.calls.length, 1);
  }
});

test("Codex Harness executes both lazy MCP tools while native MCP/web remains disabled", async () => {
  for (const agent of await mains()) {
    const f = testService();
    const backend = new CodexAppServerBackend({ logger, uploadDir: os.tmpdir(), startupTimeoutMs: 3000,
      launch: { command: process.execPath, args: [path.join(root, "tests/mcp/fakeAppServer.cjs")] } });
    const result = await backend.complete(request(agent, f.tools, "codex-app-server"));
    assert.equal(f.calls.length, 1);
    assert.match(result.message.content, /typescriptlang/);
    assert.match(result.message.content, /tools.web_search=false/);
    assert.match(result.message.content, /read_mcp.*call_mcp/);
  }
});
