"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { readStartupAppearance } = require("../companion/startup-appearance");

test("custom splash images are optional, local, raster-only, and separate from identity", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "harbour-public-splash-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.equal(readStartupAppearance({root,env:{}}), null);
  const config = path.join(root,"startup.config.json");
  const image = path.resolve(__dirname,"../renderer/assets/startup/aemeath-v6.webp");
  fs.writeFileSync(config, JSON.stringify({left:{file:image,label:"自定义角色"},right:false}));
  const loaded = readStartupAppearance({root,env:{}});
  assert.match(loaded.left.src,/^data:image\/webp;base64,/);
  assert.equal(loaded.left.label,"自定义角色");
  assert.deepEqual(loaded.right,{hidden:true});
  assert.equal(JSON.stringify(loaded).includes(image),false,"no filesystem path across IPC");
  fs.writeFileSync(path.join(root,"not-an-image.txt"),"must-not-be-exported");
  fs.writeFileSync(config, JSON.stringify({left:{file:"not-an-image.txt"},right:{file:"https://example.com/a.png"}}));
  assert.deepEqual(readStartupAppearance({root,env:{}}),{});
  fs.writeFileSync(config,"[");
  assert.equal(readStartupAppearance({root,env:{}}),null);
});
