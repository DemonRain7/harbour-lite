/* Shared compact picker, with exact-window IPC and the existing context ring. */
window.OrbRunControls = class OrbRunControls {
  constructor({ invoke, getState, beforeOpen }) {
    this.getState = getState;
    this.picker = new window.HarbourRunPicker({ host: document.getElementById("runPicker"), boundary: document.getElementById("panel"),
      modelId: "runSettings", modelLabelId: "runModel", modeId: "runMode",
      onOpen: async () => {
        beforeOpen();
        const request = this.catalogRequest = (this.catalogRequest || 0) + 1;
        const state = getState(), identity = `${state.agent}:${state.chat.sessionId || 'new'}`;
        const data = await invoke("config", { agent: state.agent });
        const now = getState();
        if (request !== this.catalogRequest || identity !== `${now.agent}:${now.chat.sessionId || 'new'}` || data.sessionId !== now.chat.sessionId) return;
        this.catalog = { ...data, agent: state.agent }; this.render(now);
      },
      onChange: async (key, value) => {
        const state = getState();
        await invoke("configure", { agent: state.agent, sessionId: state.chat.sessionId, config: { [key]: value } });
        this.render(getState()); return true;
      },
    });
    this.ring = document.getElementById("runContext");
    this.fill = document.getElementById("runContextFill");
    this.tip = document.getElementById("runContextTip");
  }
  open() { return this.picker.open(); }
  close() { this.picker.close(false); }
  render(state) {
    const { chat } = state;
    if (this.catalog && (this.catalog.agent !== state.agent || this.catalog.sessionId !== chat.sessionId)) this.catalog = null;
    this.picker.update({ identity: `${state.agent}:${chat.sessionId || 'new'}`, config: chat.config || {},
      defaults: this.catalog?.defaults || {}, models: this.catalog?.models || [], modelLabel: chat.modelLabel,
      locked: !!(chat.runId || chat.preparing || chat.loading || chat.inputSending), readOnly: !!chat.readOnly });
    if (!state.enabled || !state.expanded) this.close();
    const context = chat.context;
    const known = context && Number.isFinite(context.ratio);
    this.ring.dataset.tone = known ? context.tone : "unknown";
    this.fill.style.strokeDasharray = `${known ? Math.max(0, Math.min(1, context.ratio)) * 100 : 0} 100`;
    if (known) this.ring.setAttribute("aria-valuenow", String(Math.round(context.ratio * 100)));
    else this.ring.removeAttribute("aria-valuenow");
    const status = !known ? "上下文暂未统计" : ({ normal: "上下文充裕", warm: "上下文逐渐填满", compact: "已到压缩线", full: "已到输入上限" })[context.tone] || "上下文占用";
    const detail = !known ? "会话数据就绪后显示；空心不代表零占用。"
      : `${context.source === "native" ? "后端最近观测" : "已保存会话估算"}，并非累计用量。${context.tone === "compact" || context.tone === "full" ? "下次发送由后端按需压缩。" : chat.runId ? "本轮结束后更新。" : ""}`;
    this.tip.textContent = `${status} · ${detail}`;
    this.ring.setAttribute("aria-valuetext", status);
  }
};
