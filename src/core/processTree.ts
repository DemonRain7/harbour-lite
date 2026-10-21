import { execFile, type ChildProcess } from "node:child_process";
import path from "node:path";

export type ProcessTreeCleanup = { confirmed: boolean; reason?: string };

/** Only terminate a child owned by this invocation, never a process-name match. */
export async function terminateProcessTree(child: Pick<ChildProcess, "pid" | "exitCode" | "signalCode">): Promise<ProcessTreeCleanup> {
  const pid = child.pid;
  if (!pid || !Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) {
    return { confirmed: false, reason: "invalid-child-pid" };
  }
  if (process.platform === "win32") {
    // Once the parent has exited its PID may be reused. Do not kill that PID or
    // guess its orphan descendants. Report uncertainty instead of false success.
    if (child.exitCode !== null || child.signalCode !== null) {
      return { confirmed: false, reason: "parent-already-exited" };
    }
    const executable = path.win32.join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe");
    return new Promise(resolve => {
      // /T must run BEFORE killing the shell: child.kill() alone leaves Node,
      // Chrome, and their inherited stdout pipes alive on Windows.
      execFile(executable, ["/PID", String(pid), "/T", "/F"],
        { windowsHide: true, timeout: 5000, maxBuffer: 64 * 1024 }, error => {
          resolve(error ? { confirmed: false, reason: "tree-termination-failed" } : { confirmed: true });
        });
    });
  }
  // bash.ts starts POSIX shells in their own detached process group.
  try { process.kill(-pid, "SIGKILL"); return { confirmed: true }; }
  catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH"
      ? { confirmed: true } : { confirmed: false, reason: "tree-termination-failed" };
  }
}
