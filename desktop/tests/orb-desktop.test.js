"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { createOrbDesktop } = require("../companion/orb-desktop");

// No OS clipboard or desktop is read: exercise the user-triggered native boundary.
test("clipboard/search/capture are explicit, source-bound and never call a model", async () => {
  const calls = [];
  const picture = { isEmpty: () => false, toPNG: () => Buffer.from("image"), toDataURL: () => "data:image/png;base64,aW1hZ2U=" };
  const actions = createOrbDesktop({
    clipboard: { readText: () => { calls.push("text"); return "what & why"; }, readImage: () => { calls.push("image"); return picture; }, writeText: s => calls.push(s) },
    shell: { openExternal: url => calls.push(url) }, getWindow: () => ({ isDestroyed: () => false }),
    desktopCapturer: { getSources: async () => { calls.push("sources"); return [{ id: "window:1", name: "Window", thumbnail: picture }, { id: "window:2", name: "Harbour · 悬浮助手", thumbnail: picture }]; } },
  });
  assert.deepEqual(calls, []);
  assert.equal(actions.clipboard({ textOnly: true }).text, "what & why"); assert.equal(calls.includes("image"), false);
  assert.equal(actions.clipboard().file.mime, "image/png");
  await actions.search({ text: "test & private" }); assert.equal(calls.at(-1), "https://www.bing.com/search?q=test%20%26%20private");
  await assert.rejects(actions.capture({ id: "window:1" }), /重新选择/);
  const sources = await actions["capture-sources"](); assert.equal(sources.length, 1);
  await assert.rejects(actions.capture({ id: "window:2" }), /重新选择/);
  const captured = await actions.capture({ id: "window:1" }); assert.equal(captured.dataBase64, "aW1hZ2U=");
  await assert.rejects(actions.capture({ id: "window:1" }), /重新选择/);
});
