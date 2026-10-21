const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { attachmentTarget, authorizeFileSender, createFileOpener } = require("../companion/file-opener");

const base = "http://127.0.0.1:7788";
test("source files use text copies; executable and external destinations cannot be launched", () => {
  assert.equal(attachmentTarget({ url: "/uploads/a.py", name: "demo.py" }, base).name, "demo.py.txt");
  assert.equal(attachmentTarget({ url: "/uploads/a.txt", name: "../CON.txt" }, base).name, "attachment.txt");
  assert.equal(attachmentTarget({ url: "/uploads/a.pdf", name: "bad.exe" }, base).name, "bad.exe.pdf");
  assert.equal(attachmentTarget({ url: base + "/uploads/a.pdf?token=secret#x" }, base).url.href, base + "/uploads/a.pdf");
  for (const url of ["/uploads/a.exe", "/uploads/a.lnk", "/uploads/a.url", "/uploads/a.msi", "/uploads/a.unknown", "https://outside.test/uploads/a.pdf", "file:///a.pdf", "\\\\host\\a.pdf", "/uploads/../a.pdf", "/uploads/%2e%2e/a.pdf", "/uploads/%252e/a.pdf", "/uploads/a%2fb.pdf", "/uploads/a.pdf:ads", "/uploads/%00.pdf", "/uploads/a./b.pdf"]) {
    assert.throws(() => attachmentTarget({ url }, base), url);
  }
});
test("IPC only accepts the known Dashboard main frame, not child frames or navigated uploads", () => {
  const frame = { url: base + "/#chat" }, sender = { mainFrame: frame, isDestroyed: () => false };
  const windows = [{ webContents: sender, isDestroyed: () => false }];
  assert.equal(authorizeFileSender({ sender, senderFrame: frame }, windows, base), true);
  assert.equal(authorizeFileSender({ sender, senderFrame: { ...frame } }, windows, base), false);
  for (const url of [base + "/uploads/a.html", "https://other.test/", "file:///orb.html"]) {
    frame.url = url; assert.equal(authorizeFileSender({ sender, senderFrame: frame }, windows, base), false);
  }
});
test("bounded native download keeps tokens on current service, opens only a complete copy, reveals when no app", { timeout: 15000 }, async () => {
  const cacheRoot = await fs.mkdtemp(path.join(os.tmpdir(), "harbour-file-opener-"));
  const opened = [], revealed = [], requests = [];
  let error = "", response = () => new Response("attachment bytes");
  const open = createFileOpener({ getConfig: () => ({ url: base, token: "private-fixture" }), cacheRoot, maxBytes: 64,
    shell: { openPath: async file => { opened.push(file); assert.equal(await fs.readFile(file, "utf8"), "attachment bytes"); return error; }, showItemInFolder: file => revealed.push(file) },
    fetchImpl: async (url, options) => { requests.push({ url: url.href, options }); return response(); },
  });
  try {
    assert.equal((await open({ url: "/uploads/a.pdf?token=not-forwarded", name: "report.pdf" })).opened, true);
    assert.equal(requests[0].url, base + "/uploads/a.pdf"); assert.equal(requests[0].options.headers["x-harbour-token"], "private-fixture"); assert.equal(requests[0].options.redirect, "error");
    assert.ok(opened[0].startsWith(cacheRoot)); assert.equal(path.basename(opened[0]), "report.pdf");
    error = "No app"; assert.equal((await open({ url: "/uploads/a.pdf" })).revealed, true); assert.equal(revealed.length, 1);
    response = () => new Response("", { status: 404 }); await assert.rejects(open({ url: "/uploads/a.pdf" }), /过期|失败/);
    response = () => new Response("a".repeat(65)); await assert.rejects(open({ url: "/uploads/a.pdf" }), /上限/);
    response = () => new Response("x", { headers: { "content-length": "65" } }); await assert.rejects(open({ url: "/uploads/a.pdf" }), /256/);
    response = () => { throw new TypeError("https://secret-in-error"); }; await assert.rejects(open({ url: "/uploads/a.pdf" }), error => !error.message.includes("secret"));
    assert.equal(opened.length, 2, "failed downloads never launch any app");
  } finally { await fs.rm(cacheRoot, { recursive: true, force: true }); }
});
