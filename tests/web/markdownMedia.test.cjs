const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");

const appPath = path.resolve(__dirname, "../../web/app.js");
const source = fs.readFileSync(appPath, "utf8");
const ast = ts.createSourceFile(appPath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);

function declaration(name) {
  // Regex literals and nested template interpolation cannot be parsed with a
  // quote counter. Extract the actual declaration with the project's parser.
  const node = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
  assert.ok(node, `missing ${name}`);
  return node.getText(ast);
}

const imageRe = source.match(/const LOCAL_UPLOAD_IMAGE_RE = .*?;\r?\n/);
assert.ok(imageRe, "missing LOCAL_UPLOAD_IMAGE_RE");

const context = {
  window: {},
  localStorage: { getItem: () => "test token" },
  location: { href: "http://localhost:7788/" },
};
vm.createContext(context);
vm.runInContext([
  'const esc = (s) => String(s ?? "").replace(/[&<>\"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", \'"\': "&quot;" }[c]));',
  declaration("authToken"),
  declaration("withToken"),
  imageRe[0],
  declaration("safeLocalUploadUrl"),
  declaration("renderLocalUploadLink"),
  declaration("renderMarkdownLite"),
  declaration("mediaDisplayName"),
  declaration("renderPlayableMedia"),
  declaration("renderAssistantBubble"),
  declaration("attachmentHtml"),
  "globalThis.renderMarkdownLite = renderMarkdownLite;",
  "globalThis.renderAssistantBubble = renderAssistantBubble;",
  "globalThis.attachmentHtml = attachmentHtml;",
].join("\n"), context);

const image = context.renderMarkdownLite("已完成：[查看生成结果](/uploads/novelai/elaina/result.png)");
assert.match(image, /<img class="md-img-real"/);
assert.match(image, /src="\/uploads\/novelai\/elaina\/result\.png\?token=test%20token"/);

const explicitImage = context.renderMarkdownLite("![成图](/uploads/novelai/elaina/result.webp)");
assert.equal((explicitImage.match(/<img class="md-img-real"/g) || []).length, 1);

const file = context.renderMarkdownLite("[参数文件](/uploads/novelai/elaina/manifest.json)");
assert.match(file, /<a href="\/uploads\/novelai\/elaina\/manifest\.json\?token=test%20token"/);
assert.doesNotMatch(file, /md-img-real/);

const traversal = context.renderMarkdownLite("[坏路径](/uploads/%2e%2e/secret.png)");
assert.doesNotMatch(traversal, /<img|<a /);
assert.match(traversal, />坏路径<\/p>/);

const unsafe = context.renderMarkdownLite("[点我](javascript:alert(1))");
assert.doesNotMatch(unsafe, /<a /);

const video = context.renderAssistantBubble("结果： /uploads/demo/result.mp4");
assert.match(video, /<video class="att-video"/);
assert.match(video, /data-media-kind="video"/);
assert.match(video, /data-media-url="\/uploads\/demo\/result\.mp4\?token=test%20token"/);

const audio = context.attachmentHtml({ kind: "audio", name: "回答.wav", url: "/uploads/demo/answer.wav" });
assert.match(audio, /<audio class="att-audio"/);
assert.match(audio, /data-media-kind="audio"/);

const attachedImage = context.attachmentHtml({ kind: "image", name: "成图.png", url: "/uploads/demo/result.png" });
assert.match(attachedImage, /data-media-kind="image"/);
assert.doesNotMatch(attachedImage, /target="_blank"/);

console.log("web markdown media tests passed");
