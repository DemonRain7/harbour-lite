const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "../..");
const app = fs.readFileSync(path.join(root, "web", "app.js"), "utf8");
const css = fs.readFileSync(path.join(root, "web", "styles.css"), "utf8");
const api = fs.readFileSync(path.join(root, "src", "server", "api.ts"), "utf8");
const sdkEffort = fs.readFileSync(path.join(root, "src", "core", "backends", "claudeSdkEffort.ts"), "utf8");
const channels = fs.readFileSync(path.join(root, "src", "index.ts"), "utf8");

assert.match(app, /id="chatEffort"[^>]*data-run-picker-native hidden/);
assert.match(app, /new window\.HarbourRunPicker/);
assert.match(app, /function fillChatEfforts\(/);
assert.match(app, /function effectiveChatDefaultEffort\(/);
assert.match(app, /agentDefaultReasoningEffort/);
assert.match(app, /function setChatReasoningEffort\(/);
assert.match(app, /setChatRunOverride\("reasoningEffort", reasoningEffort\)/);
assert.match(app, /JSON\.stringify\(\{ \[field\]: value \|\| null \}\)/);
assert.match(app, /\.\.\.\(reasoningEffort \? \{ reasoningEffort \} : \{\}\)/);
assert.match(app, /CHAT_RUN_LOCK_CONTROLS[^\n]*"chatEffort"/);
assert.match(css, /data-hs-for="chatEffort"/);
assert.match(api, /supportedReasoningEfforts/);
assert.match(api, /claudeSdkEffortOptions\(s\.baseURL\)/);
assert.match(channels, /claudeSdkEffortOptions\(slot\.baseURL\)/);
assert.match(sdkEffort, /effort: "medium", description: "约 8K thinking token"/);
const claudeEffortOptions = sdkEffort.match(/=\s*\[\s*(\{ effort: "off",[\s\S]*?)\];/);
assert.ok(claudeEffortOptions, "Claude SDK 的 Effort 选项必须保持独立于原生 Codex 档位");
assert.deepEqual(
  [...claudeEffortOptions[1].matchAll(/effort: "([^"]+)"/g)].map((match) => match[1]),
  ["off", "low", "medium", "high"],
  "其他 SDK 端点不能因 DeepSeek/Codex 扩档而冒充支持原生 max"
);
assert.match(sdkEffort, /if \(isOfficialDeepSeekAnthropicEndpoint\(baseURL\)\)\s*\{\s*options\.push\(\{ effort: "max"/);
assert.match(api, /defaultReasoningEffort:\s*agent\.reasoningEffort\s*\?\?\s*defaultReasoningEffortForAgent\(agent\.name\)/);
assert.match(api, /reasoningEffort:\s*s\.reasoningEffort\s*\?\?\s*null/);

console.log("web effort control tests passed");
