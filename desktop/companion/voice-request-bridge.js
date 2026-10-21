const http = require("node:http");
const https = require("node:https");

const RUN_ID = /^call-[a-z0-9]+-[a-z0-9]+$/;
const LIMITS = Object.freeze({ uploadBytes: 36 * 1024 * 1024, bodyBytes: 256 * 1024,
  responseBytes: 2 * 1024 * 1024, timeoutMs: 20 * 60 * 1000, maxPending: 4 });

/** Only the bundled call window can send these four POSTs to the configured backend. */
function createVoiceRequestBridge({ getWindow, getConfig, expectedUrl, limits = {}, voiceChoice }) {
  const bounds = { ...LIMITS, ...limits };
  const pending = new Map();
  function assertSender(event) {
    const win = getWindow();
    if (!win || win.isDestroyed() || win.webContents !== event.sender || event.sender.isDestroyed()
      || event.senderFrame !== event.sender.mainFrame || event.senderFrame.url !== expectedUrl
      || event.sender.getURL() !== expectedUrl) throw new Error("语音请求仅接受本地通话主窗口");
    return event.sender;
  }
  function close(sender) {
    if (voiceChoice) void Promise.resolve(voiceChoice({ action: "cancel" })).catch(() => {});
    const active = pending.get(sender);
    pending.delete(sender);
    for (const entry of active || []) entry.request.destroy(new Error("语音窗口已停止请求；未自动重试"));
  }
  function cancel(event) { close(assertSender(event)); return true; }
  async function request(event, input) {
    const sender = assertSender(event);
    if (!input || typeof input !== "object" || Array.isArray(input)
      || Object.keys(input).some(key => key !== "pathname" && key !== "body")
      || typeof input.pathname !== "string" || typeof input.body !== "string") throw new Error("语音请求参数无效");
    const { pathname, body } = input;
    const abort = pathname.match(/^\/api\/runs\/(call-[a-z0-9]+-[a-z0-9]+)\/abort$/);
    if (!["/api/upload", "/api/stt/transcribe", "/api/run"].includes(pathname) && !abort) throw new Error("不支持的语音接口");
    if (Buffer.byteLength(body) > (pathname === "/api/upload" ? bounds.uploadBytes : bounds.bodyBytes)) throw new Error("语音请求体超过上限");
    let parsed;
    try { parsed = JSON.parse(body); } catch { throw new Error("语音请求体必须是 JSON"); }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("语音请求体必须是对象");
    const active = pending.get(sender) || new Set();
    if (active.size >= bounds.maxPending) throw new Error("语音请求过多，请等待当前操作结束");
    const runId = pathname === "/api/run" ? parsed.runId : undefined;
    if (pathname === "/api/run" && (typeof runId !== "string" || !RUN_ID.test(runId) || runId.length > 120
      || [...active].some(entry => entry.runId))) throw new Error("语音运行标识无效或已有运行");
    if (abort && ![...active].some(entry => entry.runId === abort[1])) throw new Error("只能停止此语音窗口正在执行的运行");
    const config = getConfig();
    const base = new URL(config.url);
    if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw new Error("后端地址无效");
    const target = new URL(pathname.slice(1), `${base.href.replace(/\/+$/, "")}/`);
    const token = typeof config.token === "string" ? config.token : "";
    return new Promise((resolve, reject) => {
      let settled = false, timer;
      const entry = { request: null, runId };
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        active.delete(entry);
        if (!active.size && pending.get(sender) === active) pending.delete(sender);
        if (error) reject(error); else resolve(value);
      };
      // node:http never follows redirects; neither a redirect nor any failure is replayed.
      const transport = target.protocol === "https:" ? https : http;
      const req = transport.request(target, { method: "POST", headers: {
        "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      } }, res => {
        const chunks = []; let size = 0;
        res.on("data", chunk => {
          size += chunk.length;
          if (size > bounds.responseBytes) {
            finish(new Error("语音响应超过上限；请核对原会话，不要重复提交")); req.destroy();
          } else chunks.push(chunk);
        });
        res.on("end", () => {
          if (settled) return;
          try {
            assertSender(event);
            if (res.statusCode < 200 || res.statusCode >= 300) throw new Error(`语音接口返回 HTTP ${res.statusCode}；请核对原会话，不要重复提交`);
            const value = JSON.parse(Buffer.concat(chunks).toString("utf8"), (_key, item) =>
              token && typeof item === "string" ? item.split(token).join("[redacted]") : item);
            finish(null, value);
          } catch (error) {
            finish(error instanceof SyntaxError ? new Error("语音接口没有返回有效 JSON；未自动重试") : error);
          }
        });
        res.on("error", () => finish(new Error("语音响应中断；请核对原会话，不要重复提交")));
      });
      entry.request = req;
      active.add(entry); pending.set(sender, active);
      req.on("error", () => finish(new Error("语音请求未完成或已停止；请核对原会话，不要重复提交")));
      timer = setTimeout(() => { finish(new Error("语音请求超时；请核对原会话，不要重复提交")); req.destroy(); }, bounds.timeoutMs);
      req.end(body);
    });
  }
  return { request, cancel, close, choice(event, input) {
    assertSender(event);
    if (!voiceChoice) throw new Error("音色选择尚未初始化");
    return voiceChoice(input);
  } };
}

module.exports = { createVoiceRequestBridge, LIMITS };
