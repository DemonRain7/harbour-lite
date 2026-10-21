import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";

export interface CommandShellInfo {
  name: string;
  executable: string;
  available: boolean;
  version?: string;
}

/** The same selection feeds command execution, the environment UI, and the model. */
export function commandShell(
  platform = process.platform,
  env = process.env,
  exists: (file: string) => boolean = fs.existsSync,
): CommandShellInfo {
  if (platform !== "win32") return { name: "Bash", executable: "/bin/bash", available: exists("/bin/bash") };
  const winPath = path.win32;
  const find = (name: string) => (env.Path || env.PATH || "").split(";")
    .map(dir => dir.trim().replace(/^"|"$/g, "")).filter(Boolean)
    .map(dir => winPath.join(dir, name)).find(exists);
  const pwsh = find("pwsh.exe");
  if (pwsh) return { name: "PowerShell 7", executable: pwsh, available: true };
  const fallback = find("powershell.exe") || winPath.join(env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return { name: "Windows PowerShell 5", executable: exists(fallback) ? fallback : "powershell.exe", available: exists(fallback) };
}

const versions = new Map<string, string | undefined>();
const pending = new Map<string, Promise<void>>();
export function currentCommandShell(): CommandShellInfo {
  const shell = commandShell();
  const version = versions.get(shell.executable);
  return { ...shell, ...(version ? { version } : {}) };
}

/** A bounded, constant, profile-free probe, at most once per executable per process. */
export async function inspectCommandShell(): Promise<void> {
  const shell = commandShell();
  if (!shell.available || versions.has(shell.executable)) return;
  const existing = pending.get(shell.executable);
  if (existing) return existing;
  const args = shell.name === "Bash" ? ["--noprofile", "--norc", "-c", "printf '%s' \"$BASH_VERSION\""]
    : ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.ToString()"];
  const probeEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    /^(?:PATH|SYSTEMROOT|WINDIR|TEMP|TMP|HOME|USERPROFILE|LANG|LC_ALL)$/i.test(key)));
  const work = new Promise<void>(resolve => {
    execFile(shell.executable, args, { windowsHide: true, timeout: 1500, maxBuffer: 1024, env: probeEnv }, (error, stdout) => {
      const version = !error ? String(stdout).trim().match(/^\d+\.\d+(?:\.\d+){0,2}/)?.[0] : undefined;
      versions.set(shell.executable, version);
      pending.delete(shell.executable);
      resolve();
    });
  });
  pending.set(shell.executable, work);
  return work;
}
