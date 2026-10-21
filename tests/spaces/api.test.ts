import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { SpaceStore } from "../../src/spaces/store";
import { spacesApi } from "../../src/spaces/api";
import { createServer as createProbe } from "node:net";
import pino from "pino";
import { startServer, type ServerDeps } from "../../src/server/api";
import { LogBroadcaster } from "../../src/server/logBroadcaster";
test("HTTP import, preview/download, metadata conflicts and nonexecuting HTML", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "harbour-space-http-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new SpaceStore(root);
  const server = createServer((req, res) => void spacesApi(req, res, new URL(req.url!, "http://localhost"), "assets/uploads", (r, status, data) => { r.writeHead(status, { "Content-Type": "application/json" }); r.end(JSON.stringify(data)); }, store));
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r)); t.after(() => new Promise<void>(r => server.close(() => r())));
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}/api/spaces`;
  const send = (url: string, value: object, method = "POST") => fetch(base + url, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(value) });
  const bytes = Buffer.from('<script>alert("never execute")</script>');
  const imported = await send("/import", { name: "文档.html", base64: bytes.toString("base64") }); assert.equal(imported.status, 201);
  const item = await imported.json() as any;
  const file = await fetch(`${base}/files/${item.files[0].id}`); assert.match(file.headers.get("Content-Disposition")!, /^attachment;/);
  assert.match(file.headers.get("Content-Security-Policy")!, /sandbox/); assert.equal(file.headers.get("X-Content-Type-Options"), "nosniff"); assert.equal(await file.text(), bytes.toString());
  const preview = await (await fetch(`${base}/files/${item.files[0].id}?text=1`)).json() as any; assert.equal(preview.text, bytes.toString());
  assert.equal((await send(`/entries/${item.id}`, { revision: item.revision, title: "New title" }, "PATCH")).status, 200);
  assert.equal((await send(`/entries/${item.id}`, { revision: item.revision, title: "Stale" }, "PATCH")).status, 409);
  assert.equal((await send("/import", { name: "x.txt", base64: "%%%" })).status, 400);
  assert.equal((await fetch(`${base}/files/${"a".repeat(64)}.png`)).status, 404);
  assert.equal(((await (await fetch(base)).json()) as any).total, 1);
  const sharp = (await import("sharp")).default;
  const png = await sharp({ create: { width: 16, height: 16, channels: 3, background: "#d9c2bb" } }).png().toBuffer();
  const image = await (await send("/import", { name: "original.png", base64: png.toString("base64") })).json() as any;
  const original = await fetch(`${base}/files/${image.files[0].id}`); assert.deepEqual(Buffer.from(await original.arrayBuffer()), png);
  const thumb = await fetch(`${base}/files/${image.files[0].id}?thumb=1`); assert.equal(thumb.status, 200); assert.equal(thumb.headers.get("content-type"), "image/webp");
  assert.equal(Buffer.from(await thumb.arrayBuffer()).toString("ascii", 0, 4), "RIFF");
});
test("real server enforces owner token and same-origin boundary on library and files", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "harbour-space-auth-")); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new SpaceStore(root); const entry = await store.importFile("private.txt", Buffer.from("private content"));
  const probe = createProbe(); await new Promise<void>(r => probe.listen(0, "127.0.0.1", r));
  const address = probe.address(); assert.ok(address && typeof address !== "string"); await new Promise<void>(r => probe.close(() => r()));
  const server = startServer({ port: address.port, host: "127.0.0.1", spaceStore: store, runtime: { asks: { onChange() {} } },
    logger: pino({ level: "silent" }), broadcaster: new LogBroadcaster(2), env: { WEB_AUTH_TOKEN: "spaces-test", WEB_CORS: true },
  } as unknown as ServerDeps); t.after(() => server.close());
  const base = `http://127.0.0.1:${address.port}`, headers = { Authorization: "Bearer spaces-test" };
  for (const suffix of ["", `/files/${entry.files[0]!.id}`]) {
    assert.equal((await fetch(base + "/api/spaces" + suffix)).status, 401);
    assert.equal((await fetch(base + "/api/spaces" + suffix, { headers: { ...headers, Origin: "https://untrusted.test" } })).status, 403);
    const good = await fetch(base + "/api/spaces" + suffix, { headers }); assert.equal(good.status, 200); assert.equal(good.headers.get("access-control-allow-origin"), null);
  }
  const denied = await fetch(base + "/api/spaces/import", { method: "POST", headers: { ...headers, Origin: "https://untrusted.test", "Content-Type": "application/json" }, body: '{}' });
  assert.equal(denied.status, 403); assert.equal((await store.list()).total, 1);
});
