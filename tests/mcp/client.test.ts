import assert from "node:assert/strict";
import { test } from "node:test";
import pino from "pino";
import type { Tool } from "@modelcontextprotocol/client";
import { McpDefinitionSchema } from "../../src/config/loadAgents";
import { RemoteMcpClient, type McpConnector } from "../../src/mcp/remoteClient";
import { createMcpTools } from "../../src/core/tools/mcp";
import { ToolRegistry } from "../../src/core/tools/registry";
import type { AgentMcpServer, ToolContext } from "../../src/types";

const logger = pino({ level: "silent" });
export const server: AgentMcpServer = { name: "exa", transport: "http", url: "https://mcp.exa.ai/mcp?tools=web_search_exa",
  readOnly: true, allow: ["web_search_exa"] };
export const schema: Tool = { name: "web_search_exa", description: "Official fixture search", inputSchema: {
  type: "object", additionalProperties: false, properties: { query: { type: "string", minLength: 1 }, objective: { type: "string" } }, required: ["query", "objective"],
} };
export const query = { query: "public TypeScript docs", objective: "Find official documentation" };
export function context(): ToolContext {
  return { agent: { name: "main-elaina", taskType: "main", systemPrompt: "fixture", tools: ["read_mcp", "call_mcp"], mcpServers: [structuredClone(server)] },
    logger, runState: new Map(), source: { channel: "web", key: "web:fixture", actor: { role: "owner", platform: "web", id: "fixture-owner" } } };
}
export function fixture() {
  const calls: unknown[] = [];
  let connects = 0, lists = 0, closes = 0;
  const connect: McpConnector = async () => {
    connects++;
    return { async listTools() { lists++; return { tools: [structuredClone(schema), { ...schema, name: "agent_run" }] }; },
      async callTool(params) { calls.push(params); return { content: [{ type: "text", text: "https://www.typescriptlang.org/docs/ official docs" }] }; },
      async close() { closes++; } };
  };
  return { service: new RemoteMcpClient(connect), calls, counts: () => ({ connects, lists, closes }) };
}

test("HTTP config requires keyless HTTPS, exact allow and local read-only approval; stdio unchanged", () => {
  assert.ok(McpDefinitionSchema.safeParse(server).success);
  assert.ok(McpDefinitionSchema.safeParse({ name: "legacy", command: "npx", args: ["fixture"], env: { PATH: "fixture" } }).success);
  for (const change of [{ url: "http://example.com/mcp" }, { url: "https://user:password@example.com/mcp" },
    { url: "https://example.com/mcp?exaApiKey=private" }, { url: "https://example.com/mcp?login" }, { allow: [] }, { allow: ["*"] },
    { command: "npx" }, { env: { EXA_API_KEY: "private" } }, { readOnly: false }, { readOnly: undefined }]) {
    assert.equal(McpDefinitionSchema.safeParse({ ...server, ...change }).success, false, JSON.stringify(change));
  }
});

test("catalog is lazy, official schema is preserved and paid/unmounted tools never exposed", async () => {
  const f = fixture();
  assert.equal(f.counts().connects, 0);
  const output = await f.service.read("exa", context()) as any;
  assert.deepEqual(output.tools, [{ name: schema.name, description: schema.description, inputSchema: schema.inputSchema }]);
  await f.service.read("exa", context());
  assert.deepEqual(f.counts(), { connects: 1, lists: 1, closes: 1 });
  assert.equal(f.calls.length, 0);
});

test("call forwards exact official arguments and always closes, catalog shared across Main personas", async () => {
  const f = fixture(), ctx = context();
  await f.service.read("exa", ctx);
  ctx.agent.name = "main-aemeath";
  const result = await f.service.call("exa", schema.name, query, ctx) as any;
  assert.deepEqual(f.calls, [{ name: schema.name, arguments: query }]);
  assert.equal(result.isError, false); assert.equal(result.trust, "external-untrusted");
  assert.deepEqual(f.counts(), { connects: 2, lists: 1, closes: 2 });
});

test("unknown required official parameter blocks before tools/call, without modifying args", async () => {
  const f = fixture();
  const output = await f.service.call("exa", schema.name, { query: "public docs" }, context()) as any;
  assert.equal(output.code, "INVALID_ARGUMENTS"); assert.equal(output.sent, false);
  assert.deepEqual(output.inputSchema, schema.inputSchema); assert.equal(f.calls.length, 0);
});

test("identity, mount, tool and MCP permission denials happen before any network", async () => {
  const mutations: Array<(ctx: ToolContext) => void> = [
    ctx => { ctx.source = undefined; },
    ctx => { ctx.source!.actor = { role: "other", platform: "qq", id: "not-owner" }; },
    ctx => { ctx.source!.actor = { role: "system", platform: "cron", id: "automatic" }; },
    ctx => { ctx.agent.mcpServers = []; },
    ctx => { ctx.agent.tools = []; },
    ctx => { ctx.agent.governance = { permissions: { mcp: ["other"] } }; },
    ctx => { ctx.agent.governance = { permissions: { tools: ["read_file"] } }; },
    ctx => { ctx.agent.mcpServers![0]!.readOnly = false; },
  ];
  for (const mutate of mutations) {
    const f = fixture(), ctx = context(); mutate(ctx);
    await assert.rejects(f.service.read("exa", ctx));
    await assert.rejects(f.service.call("exa", schema.name, query, ctx));
    assert.equal(f.counts().connects, 0);
  }
});

test("a local read-only plan may read/query, but cannot access excluded remote tools", async () => {
  const f = fixture(), ctx = context();
  ctx.permissionMode = "plan"; ctx.agent.governance = { permissions: { readOnly: true, mcp: ["exa"] } };
  await f.service.call("exa", schema.name, query, ctx);
  const before = f.counts();
  await assert.rejects(f.service.call("exa", "agent_run", {}, ctx), /allow/);
  await assert.rejects(f.service.call("exa", "invented_tool", {}, ctx), /allow/);
  assert.deepEqual(f.counts(), before);
});

test("changed mount cannot reuse cached authorization/catalog", async () => {
  const f = fixture(), ctx = context();
  await f.service.read("exa", ctx);
  ctx.agent.mcpServers = [];
  await assert.rejects(f.service.read("exa", ctx));
  ctx.agent.mcpServers = [{ ...server, url: "https://other.example/mcp" }];
  await f.service.read("exa", ctx);
  assert.equal(f.counts().lists, 2);
});

test("429/transport errors are sanitized, not retried, and connection is closed", async () => {
  for (const message of ["HTTP 429 SECRET_SENTINEL", "transport failed SECRET_SENTINEL"]) {
    let attempts = 0, closed = 0;
    const service = new RemoteMcpClient(async () => ({
      async listTools() { return { tools: [schema] }; },
      async callTool() { attempts++; throw new Error(message); }, async close() { closed++; },
    }));
    await assert.rejects(service.call("exa", schema.name, query, context()), error => {
      assert.doesNotMatch(String(error), /SECRET_SENTINEL/); assert.match(String(error), /不自动重试|没有自动重试/); return true;
    });
    assert.equal(attempts, 1); assert.equal(closed, 1);
  }
});

test("abort before connection performs no network; in-flight abort reaches protocol client", async () => {
  const ctx = context(), controller = new AbortController(), f = fixture();
  ctx.signal = controller.signal; controller.abort();
  await assert.rejects(f.service.read("exa", ctx)); assert.equal(f.counts().connects, 0);
  const next = new AbortController(); ctx.signal = next.signal;
  let closed = false;
  const service = new RemoteMcpClient(async (_server, signal) => ({
    async listTools() { return { tools: [schema] }; },
    async callTool() { return new Promise((_resolve, reject) => { signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }); next.abort(); }); },
    async close() { closed = true; },
  }));
  await assert.rejects(service.call("exa", schema.name, query, ctx), /取消/); assert.ok(closed);
});

test("MCP is exposed through the existing registry, preserves arbitrary nested arguments", async () => {
  const f = fixture(), registry = new ToolRegistry(); registry.registerAll(createMcpTools(f.service));
  assert.equal(registry.get("web_search"), undefined);
  const result = await registry.execute("call_mcp", { server: "exa", tool: schema.name, arguments: query }, context()) as any;
  assert.equal(result.isError, false); assert.deepEqual(f.calls, [{ name: schema.name, arguments: query }]);
  await assert.rejects(registry.execute("call_mcp", { server: "exa", tool: schema.name, arguments: [] }, context()));
});

test("large/unsupported results are bounded and marked; remote error does not become success", async () => {
  const service = new RemoteMcpClient(async () => ({
    async listTools() { return { tools: [schema] }; }, async close() {},
    async callTool() { return { isError: true, content: [{ type: "text", text: "x".repeat(90_000) }, { type: "image", data: "not-image", mimeType: "image/png" }], structuredContent: { text: "x".repeat(70_000) } }; },
  }));
  const result = await service.call("exa", schema.name, query, context()) as any;
  assert.equal(result.isError, true); assert.equal(result.truncated, true);
  assert.equal(result.content[0].text.length, 64_000); assert.equal(result.structuredContent, undefined);
});

test("official HTTP transport sends no credentials, uses real MCP handshake and schemas", async () => {
  const original = globalThis.fetch;
  const sent: any[] = [];
  globalThis.fetch = async (input, init) => {
    assert.equal(String(input), server.url); assert.equal(init?.redirect, "error");
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("authorization"), null); assert.equal(headers.get("x-api-key"), null); assert.equal(headers.get("cookie"), null);
    if (init?.method === "GET") return new Response(null, { status: 405 });
    if (init?.method === "DELETE") return new Response(null, { status: 204 });
    const request = JSON.parse(String(init?.body)); sent.push(request);
    if (!request.id && request.id !== 0) return new Response(null, { status: 202 });
    let result: unknown;
    if (request.method === "initialize") result = { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } };
    else if (request.method === "tools/list") result = { tools: [schema] };
    else if (request.method === "tools/call") result = { content: [{ type: "text", text: "https://example.com official fixture" }] };
    else throw new Error(`unexpected MCP method ${request.method}`);
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }), { headers: { "content-type": "application/json" } });
  };
  try {
    const result = await new RemoteMcpClient().call("exa", schema.name, query, context()) as any;
    assert.equal(result.isError, false);
    assert.equal(sent.filter(request => request.method === "tools/call").length, 1);
    assert.deepEqual(sent.find(request => request.method === "tools/call").params.arguments, query);
  } finally { globalThis.fetch = original; }
});
