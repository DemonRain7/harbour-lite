"use strict";
(() => {
  // Optional decoration cannot block startup or leave a broken-image rectangle.
  for (const art of document.querySelectorAll(".visitor-art")) {
    const unavailable = () => { art.closest(".illustration").dataset.unavailable = "true"; };
    art.addEventListener("error", unavailable, { once: true });
    if (art.complete && !art.naturalWidth) unavailable();
  }
  const text = document.getElementById("connectionText"), details = document.getElementById("details"), skipButton = document.getElementById("skip");
  const messages = { connecting: "正在点亮你的小港湾", starting: "正在唤醒 Harbour 服务", opening: "正在准备你的对话空间", ready: "今天，也一起。",
    attention: "暂时还没准备好，可以查看连接详情" };
  const reasons = { auth: "需要验证连接，请打开详情完成登录", data: "界面数据还没准备好，可在详情中重试", network: "实时连接尚未就绪", backend: "后端未能启动，请查看连接详情" };
  const unsubscribe = window.harbourStartup?.onState(state => {
    if (!state || !Object.hasOwn(messages, state.phase)) return;
    // Use the same two illustration slots and original motion; only their content changes.
    for (const [side, selector] of [["left", ".elaina-visitor"], ["right", ".aemeath-visitor"]]) {
      const entry = state.appearance?.[side], slot = document.querySelector(selector);
      if (!entry || !slot) continue;
      slot.hidden = entry.hidden === true;
      if (entry.label) slot.setAttribute("aria-label", entry.label);
      const art = slot.querySelector(".visitor-art");
      if (art && /^data:image\/(png|jpeg|webp);base64,/.test(entry.src || "") && art.src !== entry.src) {
        delete slot.dataset.unavailable;
        art.src = entry.src;
      }
    }
    // Assign destination geometry before toggling the transition; no remote CSS/HTML.
    if (state.phase === "ready" && state.target) {
      for (const key of ["x", "y", "width", "height", "radius"]) {
        if (Number.isFinite(state.target[key])) document.body.style.setProperty("--target-" + key, state.target[key] + "px");
      }
      for (const key of ["background", "surface", "border"]) {
        if (state.palette?.[key] && CSS.supports("color", state.palette[key])) document.body.style.setProperty("--" + key, state.palette[key]);
      }
    }
    document.body.dataset.phase = state.phase;
    document.body.dataset.quiet = String(state.quiet === true);
    details.hidden = !state.slow && state.phase !== "attention";
    skipButton.hidden = state.quiet === true;
    text.textContent = state.phase === "attention" ? reasons[state.reason] || messages.attention
      : state.slow && state.phase !== "ready" ? "还在准备中；连接就绪后会自动进入" : messages[state.phase];
  });
  const skip = () => window.harbourStartup?.skip();
  skipButton.addEventListener("click", skip);
  details.addEventListener("click", () => window.harbourStartup?.details());
  window.addEventListener("keydown", event => { if (event.key === "Escape") skip(); });
  const visibility = () => { document.body.dataset.paused = String(document.hidden); };
  document.addEventListener("visibilitychange", visibility);
  visibility();
  window.addEventListener("pagehide", () => unsubscribe?.(), { once: true });
})();
