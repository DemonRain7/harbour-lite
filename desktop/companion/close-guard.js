"use strict";

const { randomUUID } = require("node:crypto");

// Keep renderer approval separate from process teardown. In particular, before-quit is
// cancellable; only will-quit proves that Electron actually closed every window.
function createCloseGuard({ app, ipcMain, dialog, cleanup, timeoutMs = 8_000, logger = console, showWindow }) {
  const windows = new Map();
  const pending = new Map();
  let activeAction = null;
  let quitting = false;
  let cleaned = false;

  function trusted(event, request) {
    return request && !request.entry.win.isDestroyed()
      && event.sender === request.entry.win.webContents
      && event.senderFrame === event.sender.mainFrame
      && event.senderFrame === request.frame;
  }

  function reveal(win) {
    if (win.isDestroyed()) return;
    if (showWindow) { showWindow(win); return; }
    if (win.isMinimized()) win.restore();
    if (!win.isVisible()) win.show();
    win.focus();
  }

  function fallbackOptions(reason) {
    const action = { close: "关闭窗口", quit: "退出 Harbour", reload: "刷新页面", navigate: "离开页面" }[reason] || "离开页面";
    return {
        type: "warning",
        title: "Harbour · 确认离开",
        message: `无法确认页面是否有未保存的修改。仍要${action}吗？`,
        detail: "页面可能尚未加载完成、版本较旧或暂时没有响应。继续操作可能丢失尚未保存的内容；选择留下不会停止后台服务。",
        buttons: ["留下继续编辑", `仍然${action}`],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
    };
  }

  async function fallback(entry, reason) {
    if (entry.win.isDestroyed()) return true;
    reveal(entry.win);
    try {
      const result = await dialog.showMessageBox(entry.win, fallbackOptions(reason));
      return result.response === 1;
    } catch (error) {
      logger.warn("[harbour-desktop] 无法显示离开确认", error);
      return false;
    }
  }

  function requestLeave(entry, reason, phase) {
    if (entry.win.isDestroyed()) return Promise.resolve(true);
    const contents = entry.win.webContents;
    const requestId = randomUUID();
    return new Promise((resolve) => {
      if (phase !== "commit" && phase !== "cancel") entry.checkedWithRenderer = false;
      const request = { entry, frame: contents.mainFrame, timer: null, revealTimer: null, finish: null, refresh: null };
      request.finish = (allowed) => {
        if (!pending.delete(requestId)) return;
        clearTimeout(request.timer);
        clearTimeout(request.revealTimer);
        resolve(allowed === true);
      };
      const unavailable = () => {
        if (!pending.delete(requestId)) return;
        clearTimeout(request.timer);
        clearTimeout(request.revealTimer);
        entry.checkedWithRenderer = false;
        if (phase === "commit" || phase === "cancel") { resolve(false); return; }
        // Once a request becomes stale, a late renderer reply cannot approve anything.
        void fallback(entry, reason).then(resolve);
      };
      request.refresh = () => {
        clearTimeout(request.timer);
        request.timer = setTimeout(unavailable, timeoutMs);
      };
      request.onPending = () => {
        entry.checkedWithRenderer = true;
        request.refresh();
        if (!request.revealTimer && phase !== "commit" && phase !== "cancel") {
          request.revealTimer = setTimeout(() => reveal(entry.win), 150);
        }
      };
      request.unavailable = unavailable;
      pending.set(requestId, request);
      request.refresh();
      try {
        contents.send("desktop:before-close", { requestId, reason, phase, required: entry.required });
      } catch { unavailable(); }
    });
  }

  function onReply(event, payload) {
    if (!payload || typeof payload.requestId !== "string") return;
    const request = pending.get(payload.requestId);
    if (!trusted(event, request)) return;
    if (payload.phase === "pending") request.onPending();
    else if (payload.phase === "unavailable") request.unavailable();
    else if (payload.phase === "result" && typeof payload.allowed === "boolean") request.finish(payload.allowed);
  }
  ipcMain.on("desktop:before-close-result", onReply);

  function perform(reason, operation) {
    if (quitting) return Promise.resolve(false);
    // Repeated keyboard/tray/OS requests share one prompt. A different action must not
    // silently queue behind Cancel and surprise the user with a second navigation.
    if (activeAction) return activeAction.reason === reason ? activeAction.promise : Promise.resolve(false);
    const action = { reason, promise: null };
    activeAction = action;
    action.promise = Promise.resolve().then(operation).catch((error) => {
      logger.warn("[harbour-desktop] 离开操作失败", error);
      return false;
    }).finally(() => {
      if (activeAction === action) activeAction = null;
    });
    return action.promise;
  }

  function allowUnload(entry) {
    entry.allowUnload = true;
    clearTimeout(entry.approvalTimer);
    // Approval only covers the imminent native operation, not future edits if some
    // unrelated close listener cancels that operation.
    entry.approvalTimer = setTimeout(() => { entry.allowUnload = false; }, timeoutMs);
  }

  function run(win, reason, operation) {
    const entry = windows.get(win?.webContents?.id);
    if (!entry || win.isDestroyed()) return Promise.resolve(false);
    return perform(reason, async () => {
      if (!await requestLeave(entry, reason) || win.isDestroyed()) return false;
      allowUnload(entry);
      try { await operation(); return true; }
      catch (error) {
        entry.allowUnload = false;
        clearTimeout(entry.approvalTimer);
        throw error;
      }
    });
  }

  function register(win, { required = false } = {}) {
    const id = win.webContents.id;
    if (windows.has(id)) { windows.get(id).required ||= required; return; }
    const entry = { win, required, allowUnload: false, approvalTimer: null };
    windows.set(id, entry);
    win.on("close", (event) => {
      if (entry.allowUnload) return;
      event.preventDefault();
      void run(win, "close", () => win.close());
    });
    win.webContents.on("will-prevent-unload", (event) => {
      if (!entry.required && !entry.checkedWithRenderer) {
        // Companion windows have no shared draft editor and normally close without a
        // prompt. Never let that absence of a handler override a future native veto.
        reveal(win);
        let allowed = false;
        try { allowed = dialog.showMessageBoxSync(win, fallbackOptions(quitting ? "quit" : "close")) === 1; }
        catch (error) { logger.warn("[harbour-desktop] 无法显示离开确认", error); }
        if (allowed) event.preventDefault();
        else {
          quitting = false;
          for (const other of windows.values()) {
            other.allowUnload = false;
            clearTimeout(other.approvalTimer);
          }
        }
        return;
      }
      if (entry.allowUnload) {
        // Electron's event is inverted: preventDefault permits the approved unload.
        event.preventDefault();
        return;
      }
      // A renderer-initiated reload (or an old page) may bypass the preflight routes.
      // Keep the original unload cancelled, then repeat it only after visible approval.
      void run(win, "reload", () => win.webContents.reload());
    });
    win.webContents.on("did-stop-loading", () => {
      entry.allowUnload = false;
      clearTimeout(entry.approvalTimer);
    });
    win.on("closed", () => {
      windows.delete(id);
      clearTimeout(entry.approvalTimer);
      for (const request of pending.values()) if (request.entry === entry) request.finish(true);
    });
  }

  function requestQuit() {
    return perform("quit", async () => {
      const approved = new Set();
      const checked = new Set();
      const cancel = async () => {
        await Promise.all([...checked].filter((entry) => entry.checkedWithRenderer && !entry.win.isDestroyed())
          .map((entry) => requestLeave(entry, "quit", "cancel")));
        return false;
      };
      // Account for dashboard surfaces opened while another window's dialog was shown.
      while (true) {
        const next = [...windows.values()].find((entry) => !entry.win.isDestroyed() && !approved.has(entry));
        if (!next) break;
        checked.add(next);
        if (!await requestLeave(next, "quit", "check")) return cancel();
        approved.add(next);
      }
      for (const entry of approved) {
        if (entry.checkedWithRenderer && !entry.win.isDestroyed()
          && !await requestLeave(entry, "quit", "commit")) return cancel();
      }
      // A commit may await a save request. A newly opened dashboard during that
      // wait has never approved this transaction and must not be closed by app.quit.
      if ([...windows.values()].some((entry) => !entry.win.isDestroyed() && !approved.has(entry))) return cancel();
      for (const entry of approved) if (!entry.win.isDestroyed()) allowUnload(entry);
      quitting = true;
      app.quit();
      return true;
    });
  }

  app.on("before-quit", (event) => {
    if (quitting) return;
    event.preventDefault();
    void requestQuit();
  });
  app.on("will-quit", (event) => {
    if (cleaned) return;
    cleaned = true;
    const result = cleanup();
    if (result && typeof result.then === "function") {
      event.preventDefault();
      // A resolved Promise can finish before Electron unwinds its cancelled quit.
      // Re-entering quit in that microtask is ignored; schedule a fresh native turn.
      Promise.resolve(result).catch(error => console.error("[harbour-desktop] cleanup:", error)).finally(() => setImmediate(() => app.quit()));
    }
  });

  return { register, run, requestQuit, get quitting() { return quitting; } };
}

module.exports = { createCloseGuard };
