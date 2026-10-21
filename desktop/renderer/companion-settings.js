(() => {
  const desktop = window.harbourDesktop;
  const ids = ["theme", "font", "chatStyle", "bubbleStyle", "followDashboard", "alwaysOnTop"];
  let hydrating = false;
  const orbToggle = document.getElementById("orbToggle");
  const orbAutoStart = document.getElementById("orbAutoStart"), orbNotice = document.getElementById("orbNotice");
  async function syncOrb() {
    if (!desktop.orbStatus) { orbToggle.textContent = "重启客户端以启用"; orbToggle.disabled = true; return; }
    const state = await desktop.orbStatus();
    orbToggle.dataset.enabled = String(state.enabled); orbToggle.textContent = state.enabled ? "隐藏悬浮球" : "开启悬浮球";
    orbAutoStart.checked = state.autoStart !== false;
    orbAutoStart.disabled = !desktop.setOrbAutoStart;
  }
  orbToggle.addEventListener("click", async () => {
    orbToggle.disabled = true;
    try { await desktop.setOrbEnabled(orbToggle.dataset.enabled !== "true"); await syncOrb(); }
    catch { orbToggle.textContent = "暂不可用，请重启客户端"; }
    finally { orbToggle.disabled = false; }
  });
  orbAutoStart.addEventListener("change", async () => {
    const value = orbAutoStart.checked;
    orbAutoStart.disabled = true; orbNotice.hidden = true;
    try { const saved = await desktop.setOrbAutoStart(value); orbAutoStart.checked = saved.autoStart; }
    catch { orbAutoStart.checked = !value; orbNotice.textContent = "自启设置未保存，请稍后重试。"; orbNotice.hidden = false; }
    finally { orbAutoStart.disabled = !desktop.setOrbAutoStart; }
  });
  syncOrb().catch(() => { orbToggle.textContent = "请重启客户端"; orbToggle.disabled = true; });
  async function hydrate() {
    hydrating = true;
    const state = await desktop.getCompanionState();
    for (const id of ids) {
      const control = document.getElementById(id);
      if (control.type === "checkbox") control.checked = state.appearance?.[id] !== false;
      else control.value = state.appearance?.[id] || control.value;
    }
    const character = await desktop.getCompanionCharacter("elaina");
    document.getElementById("visualMode").value = character.manifest?.visual?.preferred || "pixel";
    document.getElementById("assetNotice").textContent = character.manifest?.visual?.live2d?.assetLabel || "角色包使用本地像素图集";
    hydrating = false;
  }
  async function saveAppearance() {
    if (hydrating) return;
    await desktop.setCompanionAppearance({
      theme: document.getElementById("theme").value,
      font: document.getElementById("font").value,
      chatStyle: document.getElementById("chatStyle").value,
      bubbleStyle: document.getElementById("bubbleStyle").value,
      followDashboard: document.getElementById("followDashboard").checked,
      alwaysOnTop: document.getElementById("alwaysOnTop").checked,
    });
  }
  ids.forEach((id) => document.getElementById(id).addEventListener("change", saveAppearance));
  document.getElementById("visualMode").addEventListener("change", async (event) => { await desktop.setCompanionVisualMode("elaina", event.target.value); });
  document.getElementById("openCharacter").addEventListener("click", () => desktop.openCompanionFolder("elaina"));
  document.querySelectorAll("[data-open]").forEach((button) => button.addEventListener("click", () => desktop.openCompanionWindow(button.dataset.open)));
  desktop.onCompanionState?.((state) => { if (state?.appearance) window.HarbourAppearance.apply(state.appearance); });
  hydrate();
})();
