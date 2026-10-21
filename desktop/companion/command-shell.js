// Standalone Electron worker: report the very same shell used to run commands.
const fs = require("node:fs");
const path = require("node:path");
const { execFile } = require("node:child_process");

function commandShell(platform = process.platform, env = process.env, exists = fs.existsSync) {
  if (platform !== "win32") return { name: "Bash", executable: "/bin/bash", available: exists("/bin/bash") };
  const find = name => (env.Path || env.PATH || "").split(";")
    .map(dir => dir.trim().replace(/^"|"$/g, "")).filter(Boolean)
    .map(dir => path.win32.join(dir, name)).find(exists);
  const pwsh = find("pwsh.exe");
  if (pwsh) return { name: "PowerShell 7", executable: pwsh, available: true };
  const fallback = find("powershell.exe") || path.win32.join(env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return { name: "Windows PowerShell 5", executable: exists(fallback) ? fallback : "powershell.exe", available: exists(fallback) };
}
const versions = new Map();
const pending = new Map();
function currentCommandShell() {
  const shell = commandShell();
  const version = versions.get(shell.executable);
  return { ...shell, ...(version ? { version } : {}) };
}
async function inspectCommandShell() {
  const shell = commandShell();
  if (!shell.available || versions.has(shell.executable)) return;
  if (pending.has(shell.executable)) return pending.get(shell.executable);
  const args = shell.name === "Bash" ? ["--noprofile", "--norc", "-c", "printf '%s' \"$BASH_VERSION\""]
    : ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.ToString()"];
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    /^(?:PATH|SYSTEMROOT|WINDIR|TEMP|TMP|HOME|USERPROFILE|LANG|LC_ALL)$/i.test(key)));
  const work = new Promise(resolve => {
    execFile(shell.executable, args, { windowsHide: true, timeout: 1500, maxBuffer: 1024, env }, (error, stdout) => {
      versions.set(shell.executable, !error ? String(stdout).trim().match(/^\d+\.\d+(?:\.\d+){0,2}/)?.[0] : undefined);
      pending.delete(shell.executable);
      resolve();
    });
  });
  pending.set(shell.executable, work);
  return work;
}
function shellLaunch(command) {
  const shell = currentCommandShell();
  if (shell.name === "Bash") return { executable: shell.executable, args: ["--noprofile", "--norc", "-c", command], flavor: shell.name };
  const legacyPrefix = "[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding $false; $OutputEncoding = [Console]::OutputEncoding; $PSDefaultParameterValues['*:Encoding'] = 'utf8'; ";
  return { executable: shell.executable, args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", shell.name === "PowerShell 7" ? command : legacyPrefix + command], flavor: shell.name };
}
module.exports = { commandShell, currentCommandShell, inspectCommandShell, shellLaunch };
