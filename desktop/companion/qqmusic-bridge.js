const path = require("node:path");
const { execFile } = require("node:child_process");

const ACTIONS = new Set(["status", "open", "play", "pause", "resume", "stop", "next", "previous"]);

function scriptCandidates(baseDir = __dirname) {
  const normal = path.join(baseDir, "qqmusic-bridge.ps1");
  return [normal, normal.replace(`${path.sep}app.asar${path.sep}`, `${path.sep}app.asar.unpacked${path.sep}`)];
}

function parseBridgeOutput(stdout) {
  const lines = String(stdout || "").split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (!lines[index].startsWith("{")) continue;
    try { return JSON.parse(lines[index]); } catch { /* keep looking */ }
  }
  throw new Error("QQ 音乐 Bridge 未返回有效 JSON");
}

function defaultRun(script, action, timeoutMs) {
  return new Promise((resolve, reject) => {
    execFile("powershell.exe", [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy", "Bypass",
      "-Command",
      "& ([scriptblock]::Create([IO.File]::ReadAllText($env:HARBOUR_QQMUSIC_SCRIPT, [Text.Encoding]::UTF8))) -Action $env:HARBOUR_QQMUSIC_ACTION",
    ], {
      windowsHide: true,
      timeout: timeoutMs,
      encoding: "utf8",
      maxBuffer: 256 * 1024,
      env: {
        ...process.env,
        HARBOUR_QQMUSIC_SCRIPT: script,
        HARBOUR_QQMUSIC_ACTION: action,
      },
    }, (error, stdout) => {
      let result;
      try { result = parseBridgeOutput(stdout); } catch (parseError) {
        reject(error || parseError);
        return;
      }
      if (result?.ok === false) reject(new Error(String(result.error || "QQ 音乐控制失败")));
      else resolve(result);
    });
  });
}

class QQMusicBridge {
  constructor({ platform = process.platform, baseDir = __dirname, timeoutMs = 9_000, run = defaultRun } = {}) {
    this.platform = platform;
    this.timeoutMs = timeoutMs;
    this.runProcess = run;
    this.script = scriptCandidates(baseDir).find((candidate) => require("node:fs").existsSync(candidate)) || scriptCandidates(baseDir)[0];
  }

  async execute(action) {
    const value = String(action || "").toLowerCase();
    if (!ACTIONS.has(value)) throw new Error(`不支持的 QQ 音乐命令：${value}`);
    if (this.platform !== "win32") {
      if (value === "status") return {
        ok: true,
        provider: "qqmusic",
        installed: false,
        connected: false,
        loaded: false,
        paused: true,
        capabilities: ["status"],
        reason: "QQ 音乐 Provider 只支持 Windows Electron 客户端",
      };
      throw new Error("QQ 音乐 Provider 只支持 Windows Electron 客户端");
    }
    return this.runProcess(this.script, value, this.timeoutMs);
  }

  status() { return this.execute("status"); }
}

module.exports = { QQMusicBridge, ACTIONS, parseBridgeOutput, scriptCandidates };
