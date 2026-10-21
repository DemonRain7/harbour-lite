#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { resolveHarbourDataRoot } = require("../desktop/companion/platform-paths");

const projectRoot = path.resolve(__dirname, "..");
const desktopRoot = path.join(projectRoot, "desktop");

function packageDirectory(nodeModules, name) {
  return path.join(nodeModules, ...name.split("/"));
}

function electronBinaryReady(nodeModules, { platform = process.platform, env = process.env } = {}) {
  const electronRoot = path.join(nodeModules, "electron");
  const expectedPath = platform === "win32" ? "electron.exe"
    : platform === "darwin" ? "Electron.app/Contents/MacOS/Electron" : "electron";
  try {
    // Do not require("electron") here: newer releases download missing binaries from their
    // module entry point, which would make --check/--dry-run mutate a fresh checkout.
    const pathFile = path.join(electronRoot, "path.txt");
    const installedPath = fs.existsSync(pathFile) ? fs.readFileSync(pathFile, "utf8") : "";
    const override = env.ELECTRON_OVERRIDE_DIST_PATH;
    if (!override && installedPath !== expectedPath) return false;
    // An explicit override follows Electron's own entry-point semantics, including its
    // literal "electron" fallback when path.txt is absent (even on macOS/Windows).
    const dist = override || path.join(electronRoot, "dist");
    const executable = path.join(dist, ...(installedPath || "electron").split("/"));
    if (!fs.statSync(executable).isFile()) return false;
    if (platform !== "win32") fs.accessSync(executable, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function inspectDependencies(root, { requireElectronBinary = false, ...binaryOptions } = {}) {
  const manifestPath = path.join(root, "package.json");
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (error) {
    return {
      ready: false,
      missing: [manifestPath],
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const nodeModules = path.join(root, "node_modules");
  const direct = [...new Set([
    ...Object.keys(manifest.dependencies || {}),
    ...Object.keys(manifest.devDependencies || {}),
  ])].sort();
  const missing = direct.filter((name) => !fs.existsSync(path.join(packageDirectory(nodeModules, name), "package.json")));

  let binaryReady = false;
  if (requireElectronBinary && !missing.includes("electron")) {
    binaryReady = electronBinaryReady(nodeModules, binaryOptions);
    if (!binaryReady) missing.push("electron (binary)");
  }

  return {
    ready: missing.length === 0,
    missing,
    dependencyCount: direct.length,
    ...(requireElectronBinary ? { electronBinaryReady: binaryReady } : {}),
  };
}

function inspectDesktopDependencies(root = desktopRoot) {
  return inspectDependencies(root, { requireElectronBinary: true });
}

function isLoopbackUrl(value) {
  try {
    const hostname = new URL(value).hostname.toLowerCase();
    return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
  } catch {
    return false;
  }
}

function launcherRuntime(env = process.env) {
  let file = {};
  const candidates = [
    env.HARBOUR_CONFIG && path.resolve(env.HARBOUR_CONFIG),
    env.PORTABLE_EXECUTABLE_DIR && path.join(env.PORTABLE_EXECUTABLE_DIR, "config.json"),
    path.join(resolveHarbourDataRoot({ env }), "config.json"),
    env.APPDATA && path.join(env.APPDATA, "HarbourPublic", "config.json"),
    path.join(desktopRoot, "config.json"),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      file = JSON.parse(fs.readFileSync(candidate, "utf8"));
      break;
    } catch {
      // A missing local config is the normal fresh-clone case.
    }
  }
  const url = env.HARBOUR_URL || file.url || "http://localhost:7799";
  const spawnOverride = env.HARBOUR_SPAWN;
  const spawnLocal = spawnOverride !== undefined
    ? spawnOverride === "1"
    : typeof file.spawn === "boolean" ? file.spawn : isLoopbackUrl(url);
  return { url, spawnLocal };
}

function npmInvocation(args) {
  const npmCli = String(process.env.npm_execpath || "").trim();
  if (npmCli && fs.existsSync(npmCli)) {
    return { command: process.execPath, args: [npmCli, ...args], shell: false };
  }
  return {
    command: process.platform === "win32" ? "npm.cmd" : "npm",
    args,
    shell: process.platform === "win32",
  };
}

function displayInvocation(invocation) {
  return [invocation.command, ...invocation.args]
    .map((part) => (/\s/u.test(part) ? JSON.stringify(part) : part))
    .join(" ");
}

function runNpm(args, cwd, options = {}) {
  const invocation = npmInvocation(args);
  return spawnSync(invocation.command, invocation.args, {
    cwd,
    env: process.env,
    stdio: "inherit",
    shell: invocation.shell,
    ...options,
  });
}

function electronInstallerInvocation(root = desktopRoot) {
  return {
    command: process.execPath,
    args: [path.join(root, "node_modules", "electron", "install.js")],
    shell: false,
  };
}

function runElectronInstaller(root = desktopRoot, options = {}) {
  const invocation = electronInstallerInvocation(root);
  return spawnSync(invocation.command, invocation.args, {
    cwd: root,
    env: process.env,
    stdio: "inherit",
    shell: false,
    windowsHide: true,
    ...options,
  });
}

function launchDesktop(forwardedArgs = []) {
  const invocation = npmInvocation(["start", ...(forwardedArgs.length ? ["--", ...forwardedArgs] : [])]);
  const child = spawn(invocation.command, invocation.args, {
    cwd: desktopRoot,
    env: { ...process.env, HARBOUR_NODE_EXECUTABLE: process.execPath },
    stdio: "inherit",
    shell: invocation.shell,
  });
  child.on("error", (error) => {
    console.error(`[harbour-desktop] 无法启动 Electron：${error.message}`);
    process.exitCode = 1;
  });
  child.on("exit", (code, signal) => {
    process.exitCode = Number.isInteger(code) ? code : signal ? 1 : 0;
  });
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      if (!child.killed) child.kill(signal);
    });
  }
  return child;
}

function main(argv = process.argv.slice(2)) {
  const checkOnly = argv.includes("--check");
  const dryRun = argv.includes("--dry-run");
  const forwardedArgs = argv.filter((value) => value !== "--check" && value !== "--dry-run");
  let state = inspectDesktopDependencies();
  const runtime = launcherRuntime();
  let backendState = runtime.spawnLocal
    ? inspectDependencies(projectRoot)
    : { ready: true, skipped: true, reason: "remote-or-external-backend" };
  const install = npmInvocation(["install"]);
  const start = npmInvocation(["start", ...(forwardedArgs.length ? ["--", ...forwardedArgs] : [])]);

  if (checkOnly || dryRun) {
    console.log(JSON.stringify({
      mode: checkOnly ? "check" : "dry-run",
      ...state,
      backend: backendState,
      backendMode: runtime.spawnLocal ? "local" : "remote",
      harbourUrl: runtime.url,
      wouldInstall: !state.ready,
      wouldInstallBackend: !backendState.ready,
      wouldInstallElectron: state.missing.includes("electron") || state.missing.includes("electron (binary)"),
      installCommand: displayInvocation(install),
      electronInstallCommand: displayInvocation(electronInstallerInvocation()),
      startCommand: displayInvocation(start),
    }, null, 2));
    if (checkOnly && (!state.ready || !backendState.ready)) process.exitCode = 1;
    return;
  }

  if (!backendState.ready) {
    console.log(`[harbour-desktop] 本机后端依赖不完整（${backendState.missing.join(", ")}），正在仓库根自动执行 npm install…`);
    const installed = runNpm(["install"], projectRoot);
    if (installed.error || installed.status !== 0) {
      console.error("[harbour-desktop] Harbour 后端依赖安装失败；请检查 npm 网络/代理后重试。");
      process.exitCode = Number.isInteger(installed.status) ? installed.status : 1;
      return;
    }
    backendState = inspectDependencies(projectRoot);
    if (!backendState.ready) {
      console.error(`[harbour-desktop] 根目录 npm install 已结束，但依赖仍不完整：${backendState.missing.join(", ")}`);
      process.exitCode = 1;
      return;
    }
  }

  if (!state.ready) {
    if (state.missing.some((name) => name !== "electron (binary)")) {
      console.log(`[harbour-desktop] 桌面依赖不完整（${state.missing.join(", ")}），正在 desktop/ 自动执行 npm install…`);
      const installed = runNpm(["install"], desktopRoot);
      if (installed.error || installed.status !== 0) {
        console.error("[harbour-desktop] Electron 依赖安装失败；请检查 npm 网络/代理后重试 npm run desktop。");
        process.exitCode = Number.isInteger(installed.status) ? installed.status : 1;
        return;
      }
      state = inspectDesktopDependencies();
    }
    if (state.missing.includes("electron (binary)")) {
      // Electron 43 has no postinstall: npm ci/rebuild installs the package but not its binary.
      // Invoke the installed, lockfile-selected installer explicitly; never use an npx fallback.
      console.log("[harbour-desktop] Electron 二进制缺失或平台不匹配，正在运行本地 Electron install.js…");
      const prepared = runElectronInstaller(desktopRoot);
      if (prepared.error || prepared.status !== 0) {
        console.error("[harbour-desktop] Electron 二进制安装失败；请检查下载网络/代理后重试。");
        process.exitCode = Number.isInteger(prepared.status) ? prepared.status : 1;
        return;
      }
      state = inspectDesktopDependencies();
    }
    if (!state.ready) {
      console.error(`[harbour-desktop] npm install 已结束，但依赖仍不完整：${state.missing.join(", ")}`);
      process.exitCode = 1;
      return;
    }
  }

  launchDesktop(forwardedArgs);
}

if (require.main === module) main();

module.exports = {
  displayInvocation,
  electronBinaryReady,
  inspectDesktopDependencies,
  inspectDependencies,
  isLoopbackUrl,
  launcherRuntime,
  npmInvocation,
  runElectronInstaller,
};
