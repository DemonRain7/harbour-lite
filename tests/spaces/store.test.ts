import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { SpaceStore } from "../../src/spaces/store";

async function fixture(t: test.TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "harbour-spaces-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new SpaceStore(root);
  async function write(file: string, data: string | Buffer | object) {
    const target = path.join(root, file); await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, typeof data === "object" && !Buffer.isBuffer(data) ? JSON.stringify(data) : data as string | Buffer); return target;
  }
  return { root, store, write };
}
test("archive keeps original bytes, survives restart and expired uploads, preserves ordered comic grouping", async t => {
  const { root, store, write } = await fixture(t);
  await write("assets/uploads/one.png", "page-one"); await write("assets/uploads/two.png", "page-two");
  const job = { schemaVersion: 1, id: "comic-test", ownerKey: "owner", title: "海边的一天", status: "completed", panels: [
    { number: 2, status: "completed", asset: { url: "/uploads/two.png" } },
    { number: 1, status: "completed", asset: { url: "/uploads/one.png" }, caption: "第一幕" },
  ] };
  await write("data/comicJobs/comic-test.json", job);
  const original = await fs.readFile(path.join(root, "data/comicJobs/comic-test.json"));
  assert.equal((await store.sync()).imported, 1);
  let list = await store.list(); assert.equal(list.total, 1); assert.equal(list.entries[0]!.fileCount, 2);
  let entry = await store.detail(list.entries[0]!.id);
  assert.deepEqual(entry.files.map(f => f.name), ["one.png", "two.png"]);
  assert.equal(await fs.readFile((await store.file(entry.files[0]!.id)).path, "utf8"), "page-one");
  assert.deepEqual(await fs.readFile(path.join(root, "data/comicJobs/comic-test.json")), original);
  const folder = await store.createCollection("故事");
  entry = await store.update(entry.id, { revision: entry.revision, title: "我的漫画", favorite: true, collectionId: folder.id });
  await fs.unlink(path.join(root, "assets/uploads/one.png"));
  await write("assets/uploads/three.png", "page-three");
  job.panels.push({ number: 3, status: "completed", asset: { url: "/uploads/three.png" } });
  await write("data/comicJobs/comic-test.json", job);
  assert.equal((await store.sync(true)).unavailable, 0);
  const restarted = new SpaceStore(root); entry = await restarted.detail(entry.id);
  assert.equal(entry.files.length, 3); assert.equal(entry.title, "我的漫画"); assert.equal(entry.favorite, true);
  assert.equal((await restarted.list({ collection: folder.id })).total, 1);
  assert.equal((await restarted.sync(true)).imported, 0);
});
test("image sets absorb loose images, never duplicate or rewrite execution ledgers", async t => {
  const { store, write } = await fixture(t);
  await write("assets/uploads/a.png", "art-a"); await write("assets/uploads/b.png", "art-b");
  await store.captureDelivery("![图](/uploads/a.png)", "个人作品"); assert.equal((await store.list()).total, 1);
  await write("data/novelAiImageSets/job.json", { schemaVersion: 1, id: "job", ownerKey: "owner", title: "画集", totalImages: 2, groups: [
    { index: 2, artifacts: [{ url: "/uploads/b.png" }] }, { index: 1, artifacts: [{ url: "/uploads/a.png" }] },
  ] });
  await store.sync(true); const list = await store.list(); assert.equal(list.total, 1); assert.equal(list.entries[0]!.fileCount, 2);
  await store.captureDelivery("![图](/uploads/a.png)", "不能重复"); assert.equal((await store.list()).total, 1);
});
test("document delivery accepts local output but rejects internal data, remote and traversal paths", async t => {
  const { root, store, write } = await fixture(t);
  await write("assets/reports/hello world.md", "# Saved document"); await write(".env", "do-not-read");
  await write("data/private.txt", "private"); await write("agents/a/SOUL.md", "private-persona");
  await store.captureDelivery(`[doc](<${root.replace(/\\/g, "/")}/assets/reports/hello world.md>)\n[no](data/private.txt) [no](agents/a/SOUL.md) [no](.env) [no](https://example.com/report.pdf) [no](/uploads/../../data/private.txt)`, "会话");
  const list = await store.list(); assert.equal(list.total, 1); assert.equal(list.entries[0]!.title, "hello world.md");
  assert.equal(list.entries[0]!.kind, "document");
  await assert.rejects(store.file("../index.json"));
  await assert.rejects(store.file("a".repeat(64) + ".md"));
});
test("metadata validation, stale revisions, unsupported uploads and parallel dedup", async t => {
  const { store } = await fixture(t);
  const imported = await Promise.all(Array.from({ length: 8 }, () => store.importFile("notes.txt", Buffer.from("hello"))));
  assert.equal((await store.list()).total, 1);
  const entry = await store.detail(imported[0]!.id);
  await store.update(entry.id, { revision: entry.revision, favorite: true });
  await assert.rejects(store.update(entry.id, { revision: entry.revision, favorite: false }), { status: 409 });
  await assert.rejects(store.createCollection(" "));
  await assert.rejects(store.importFile("run.exe", Buffer.from("MZ")));
  await assert.rejects(store.importFile("empty.txt", Buffer.alloc(0)));
  await assert.rejects(store.importFile("note.txt", Buffer.from("a"), "missing"));
  assert.equal((await store.list({ favorite: true })).total, 1);
  assert.equal((await store.list({ q: "不存在" })).total, 0);
});
test("corrupt index fails closed and is never overwritten", async t => {
  const { store, root, write } = await fixture(t);
  await write("data/spaces/index.json", "broken");
  await assert.rejects(store.importFile("test.txt", Buffer.from("test")), { status: 500 });
  assert.equal(await fs.readFile(path.join(root, "data/spaces/index.json"), "utf8"), "broken");
});
test("custom upload directory outside repository remains archivable", async t => {
  const { root } = await fixture(t);
  const external = await fs.mkdtemp(path.join(os.tmpdir(), "harbour-uploads-")); t.after(() => fs.rm(external, { recursive: true, force: true }));
  await fs.writeFile(path.join(external, "test.txt"), "external upload");
  const store = new SpaceStore(root, external); await store.captureDelivery("[文件](/uploads/test.txt)", "文件");
  assert.equal((await store.list()).total, 1);
});
test("historical backfill accepts only owner assistant deliveries, not quoted user uploads or public conversations", async t => {
  const { store, write } = await fixture(t);
  await write("assets/reports/saved.md", "archived report"); await write("assets/uploads/private.txt", "not an owner delivery");
  await write("data/sessions/owner.json", { title: "过去的工作", origin: { actorRole: "owner" }, messages: [
    { role: "user", actor: { role: "owner" }, content: "[附件](/uploads/private.txt)" },
    { role: "assistant", content: "[报告](assets/reports/saved.md)" },
    { role: "user", actor: { role: "public" }, content: "hello" },
    { role: "assistant", content: "[他人的文件](/uploads/private.txt)" },
  ] });
  await write("data/sessions/public.json", { title: "Public", origin: { actorRole: "public" }, messages: [
    { role: "assistant", content: "[不能归档](/uploads/private.txt)" },
  ] });
  assert.equal((await store.sync()).imported, 1); assert.equal((await store.list()).total, 1);
  assert.equal((await store.sync(true)).imported, 0);
});
test("comic archive prefers original panels over composed pages and absorbs both delivery forms", async t => {
  const { store, write } = await fixture(t);
  await write("assets/uploads/panel.png", "panel"); await write("assets/uploads/page.png", "assembled-page");
  await store.captureDelivery("![原格](/uploads/panel.png)", "原格");
  const loose = (await store.list()).entries[0]!; await store.update(loose.id, { revision: loose.revision, favorite: true });
  await write("data/comicJobs/assembled.json", { schemaVersion: 1, id: "assembled", ownerKey: "owner", title: "整部漫画", status: "completed",
    panels: [{ number: 1, status: "completed", asset: { url: "/uploads/panel.png" } }], artifacts: { pages: [{ url: "/uploads/page.png" }] } });
  await store.sync(); await store.captureDelivery("![旧消息](/uploads/panel.png)\n![拼版](/uploads/page.png)", "不能拆散");
  const list = await store.list(); assert.equal(list.total, 1); assert.equal(list.entries[0]!.kind, "comic"); assert.equal(list.entries[0]!.favorite, true);
  const detail = await store.detail(list.entries[0]!.id);
  assert.deepEqual(detail.files.map(f => f.name), ["panel.png"]);
  assert.equal(await fs.readFile((await store.file(detail.files[0]!.id)).path, "utf8"), "panel");
});

test("v2 comics migrate to ordered originals with separate existing story and preserve metadata/ledgers", async t => {
  const { root, store, write } = await fixture(t);
  await write("assets/uploads/panel-1.png", "square-original-1");
  await write("assets/uploads/panel-2.png", "portrait-original-2");
  await write("assets/uploads/book.png", "composed-book-with-text");
  const job = { schemaVersion: 1, id: "book", ownerKey: "owner", title: "一本书", status: "completed",
    artifacts: { pages: [{ url: "/uploads/book.png" }] }, panels: [] as object[] };
  const jobFile = await write("data/comicJobs/book.json", job);
  await store.sync();
  const old = (await store.list()).entries[0]!;
  const folder = await store.createCollection("我的收藏");
  await store.update(old.id, { revision: old.revision, title: "保留自定义标题", collectionId: folder.id, favorite: true });
  job.panels = [
    { number: 2, status: "completed", asset: { url: "/uploads/panel-2.png" }, caption: "第二幕" },
    { number: 1, status: "completed", asset: { url: "/uploads/panel-1.png" }, caption: "第一幕", narration: "窗边的日光", dialogue: [{ speaker: "旅人", text: "早安" }] },
  ];
  await write("data/comicJobs/book.json", job);
  const original = await fs.readFile(jobFile);
  // Simulate an existing, already scanned v2 index without touching the Job again.
  const indexFile = path.join(root, "data/spaces/index.json");
  const index = JSON.parse(await fs.readFile(indexFile, "utf8")), stat = await fs.stat(jobFile);
  index.fingerprints["comic:book.json"] = `2:${stat.mtimeMs}:${stat.size}`;
  await fs.writeFile(indexFile, JSON.stringify(index));
  const restarted = new SpaceStore(root);
  assert.equal((await restarted.sync()).unavailable, 0);
  const entry = await restarted.detail(old.id);
  assert.deepEqual(entry.files.map(f => f.name), ["panel-1.png", "panel-2.png"]);
  assert.equal(entry.files[0]!.caption, "第一幕\n窗边的日光\n旅人: 早安");
  assert.equal(entry.title, "保留自定义标题"); assert.equal(entry.favorite, true); assert.equal(entry.collectionId, folder.id);
  assert.deepEqual(await fs.readFile(jobFile), original, "projection never rewrites jobs or spends credits");
  assert.equal(await fs.readFile((await restarted.file(entry.files[0]!.id)).path, "utf8"), "square-original-1");
  assert.equal(await fs.readFile(path.join(root, "assets/uploads/book.png"), "utf8"), "composed-book-with-text");
});

test("expired original panels keep the intact archived page instead of replacing it with a partial book", async t => {
  const { root, store, write } = await fixture(t);
  await write("assets/uploads/book.png", "intact-book");
  const job = { schemaVersion: 1, id: "legacy", ownerKey: "owner", title: "旧存档", status: "completed",
    artifacts: { pages: [{ url: "/uploads/book.png" }] }, panels: [] as object[] };
  await write("data/comicJobs/legacy.json", job); await store.sync();
  const id = (await store.list()).entries[0]!.id;
  await fs.unlink(path.join(root, "assets/uploads/book.png"));
  await write("assets/uploads/first.png", "only-first-original");
  job.panels = [
    { number: 1, status: "completed", asset: { url: "/uploads/first.png" } },
    { number: 2, status: "completed", asset: { url: "/uploads/missing.png" } },
  ];
  await write("data/comicJobs/legacy.json", job);
  assert.equal((await store.sync(true)).unavailable, 1);
  const entry = await store.detail(id);
  assert.deepEqual(entry.files.map(f => f.name), ["book.png"]);
  assert.equal(entry.files[0]!.presentation, "comic-page");
  assert.equal(await fs.readFile((await store.file(entry.files[0]!.id)).path, "utf8"), "intact-book");
  // If the missing source arrives later, a forced sync can complete the migration.
  await write("assets/uploads/missing.png", "second-original");
  assert.equal((await store.sync(true)).unavailable, 0);
  assert.deepEqual((await store.detail(id)).files.map(f => f.name), ["first.png", "missing.png"]);
});
