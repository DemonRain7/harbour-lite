"use strict";

/** Transport/UI are injected so failures and double-clicks can be tested without touching a real service. */
function createServiceActions({ request, confirm, onState, notify, quitGuard, app, sleep = ms => new Promise(r => setTimeout(r, ms)), now = Date.now, timeoutMs = 60_000 }) {
  let pending = null;
  function exclusive(action) {
    if (pending) return pending;
    pending = Promise.resolve().then(action).catch(error => notify("error", error.message || String(error)))
      .finally(() => { pending = null; onState("idle"); });
    return pending;
  }
  return {
    restartBackend() {
      return exclusive(async () => {
        let before;
        try { before = await request("/api/service"); }
        catch (error) {
          if (error.status === 404) throw new Error("当前仍是旧版后端，尚无重启接口。首次升级需要完整重启后端；只刷新页面无效。");
          throw error;
        }
        if (!before.restartSupported || !before.instanceId) throw new Error(before.restartReason || "后端尚不支持重启接口。需要先更新并完整启动新版后端；仅刷新页面无效。");
        if (!await confirm("重启 Harbour 后端服务？", "QQ / Discord 和客户端连接会短暂断开。不会重发任务或删除聊天、文件；正在执行的任务需先停止或等待完成。")) return;
        onState("restarting");
        // A lost POST receipt is uncertain: poll instance identity, never retry the write.
        let receiptError;
        try { await request("/api/service/restart", { instanceId: before.instanceId }); }
        catch (error) { if (error.status) throw error; receiptError = error; }
        const start = now();
        while (now() - start < timeoutMs) {
          await sleep(500);
          let current;
          try { current = await request("/api/service"); } catch { continue; }
          if (current.instanceId && current.instanceId !== before.instanceId && current.phase === "ready") {
            notify("success", `后端已重新启动并加载代码（PID ${current.pid}）。客户端会自动重连；未保存草稿保持原样。`);
            return;
          }
        }
        throw new Error(`未能确认新后端就绪${receiptError ? "（重启回执连接中断）" : ""}。没有重复发送重启请求；请检查后端日志。`);
      });
    },
    restartClient() {
      return exclusive(async () => {
        if (!await confirm("重启 Harbour 客户端？", "关闭并重新打开窗口和托盘，加载桌面端代码；未保存修改会另外确认。独立运行的后端不会因此重启。")) return;
        onState("client-restarting");
        const relaunch = () => app.relaunch();
        app.once("will-quit", relaunch);
        try { if (!await quitGuard.requestQuit()) app.removeListener("will-quit", relaunch); }
        catch (error) { app.removeListener("will-quit", relaunch); throw error; }
      });
    },
  };
}

/** Only our own direct child may ask this parent to replace it. */
function wireManagedServiceRestart(child, { isCurrent, isQuitting, onRestart }) {
  let nonce = null, committed = false, timer;
  const clear = () => { nonce = null; committed = false; clearTimeout(timer); };
  child.on("message", message => {
    if (!isCurrent() || isQuitting() || !message || typeof message.nonce !== "string") return;
    if (message.type === "harbour:restart-prepare") {
      if (nonce && nonce !== message.nonce) return;
      nonce = message.nonce;
      clearTimeout(timer); timer = setTimeout(clear, 30_000); timer.unref?.();
      if (child.connected) child.send({ type: "harbour:restart-ready", nonce }, () => {});
    } else if (message.nonce === nonce) {
      if (message.type === "harbour:restart-commit") committed = true;
      if (message.type === "harbour:restart-cancel") clear();
    }
  });
  child.once("exit", code => {
    const restart = committed && code === 0 && isCurrent() && !isQuitting();
    clear(); if (restart) onRestart();
  });
}

module.exports = { createServiceActions, wireManagedServiceRestart };
