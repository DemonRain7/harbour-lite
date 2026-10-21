import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";

export class OpenCliCommandTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`OpenCLI Browser 执行超过 ${timeoutMs}ms`);
    this.name = "OpenCliCommandTimeoutError";
  }
}

// Electron's Node mode still exposes versions.electron. Commander's auto-detection
// then assumes a packaged app and consumes argv from index 1, treating main.js as
// a command. Only this CLI child needs Node-style argv (executable, script, args).
// --import keeps argv intact; unlike --eval it does not introduce eval parsing.
const ELECTRON_NODE_ARGV = "data:text/javascript," + encodeURIComponent(
  'Object.defineProperty(process, "defaultApp", { value: true, configurable: true });',
);

/** One process boundary for daemon/profile commands, adapters and generic Browser. */
export function spawnOpenCli(
  entryPath: string,
  args: readonly string[],
  options: SpawnOptions = {},
): ChildProcess {
  return spawnOpenCliRuntime([entryPath, ...args], options, true);
}

/** Fixed host helper source only; page text and routing are delivered on stdin. */
export function spawnOpenCliHelper(source: string, options: SpawnOptions = {}): ChildProcess {
  return spawnOpenCliRuntime(["--input-type=module", "--eval", source], options, false);
}

function spawnOpenCliRuntime(args: readonly string[], options: SpawnOptions, cliArgv: boolean): ChildProcess {
  const env: NodeJS.ProcessEnv = { ...process.env, ...options.env };
  for (const key of Object.keys(env)) {
    if (/(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|COOKIE|CREDENTIAL|ANTHROPIC|OPENAI|DISCORD)/i.test(key)) {
      delete env[key];
    }
  }
  const electron = !!process.versions.electron;
  if (electron) env.ELECTRON_RUN_AS_NODE = "1";
  // Never change Harbour's process flags or require a second installed Node.
  const prefix = electron && cliArgv ? ["--import", ELECTRON_NODE_ARGV] : [];
  return spawn(process.execPath, [...prefix, ...args], {
    ...options,
    env,
    shell: false,
    windowsHide: true,
  });
}
