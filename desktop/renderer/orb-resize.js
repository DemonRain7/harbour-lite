/* Chat-only resize handles; native cursor coordinates and persistence stay in
 * the trusted controller. No API requests, message refreshes or image changes. */
window.OrbResize = class {
  constructor({ invoke, notice }) {
    this.invoke = invoke; this.notice = notice;
    this.root = document.getElementById("panelResize");
    const names = { n: "上边", s: "下边", e: "右边", w: "左边", nw: "左上角", ne: "右上角", sw: "左下角", se: "右下角" };
    for (const [edge, label] of Object.entries(names)) {
      const handle = document.createElement("button");
      handle.type = "button"; handle.className = "panel-resize-handle"; handle.dataset.resize = edge;
      handle.tabIndex = edge === "se" ? 0 : -1;
      handle.setAttribute("aria-label", `调整聊天框大小 · ${label}；方向键微调，Shift 加速`);
      handle.title = "拖动调整大小 · 自动记住";
      this.root.append(handle);
      handle.addEventListener("pointerdown", event => {
        if (event.button !== 0 || this.active) return;
        event.preventDefault(); event.stopPropagation();
        for (const animation of document.getElementById("panel").getAnimations())
          if (animation.animationName === "preview-arrive") animation.finish();
        const active = this.active = { id: event.pointerId, handle, started: false };
        handle.setPointerCapture(event.pointerId);
        void invoke("resize-start", { edge }).then(ok => {
          if (this.active === active) { active.started = ok; if (!ok) this.release(); }
        }).catch(error => { if (this.active === active) this.release(); notice(error.message); });
      });
      handle.addEventListener("pointermove", () => {
        if (!this.active || this.tick) return;
        this.tick = requestAnimationFrame(() => {
          this.tick = 0;
          if (this.active) void invoke("resize-move").catch(error => notice(error.message));
        });
      });
      handle.addEventListener("pointerup", () => this.finish(false));
      handle.addEventListener("pointercancel", () => this.finish(false));
      handle.addEventListener("lostpointercapture", () => this.finish(false));
      handle.addEventListener("keydown", event => {
        const delta = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
        if (!delta || this.active) return;
        event.preventDefault(); event.stopPropagation();
        const step = event.shiftKey ? 40 : 10;
        void invoke("resize-step", { edge, dx: delta[0] * step, dy: delta[1] * step }).catch(error => notice(error.message));
      });
    }
    document.addEventListener("keydown", event => {
      if (event.key === "Escape" && this.active) {
        event.preventDefault(); event.stopImmediatePropagation(); this.finish(true);
      }
    }, true);
    window.addEventListener("blur", () => this.finish(false));
    window.addEventListener("pagehide", () => this.finish(false));
  }
  release() {
    const active = this.active; this.active = null;
    cancelAnimationFrame(this.tick); this.tick = 0;
    if (active?.handle.hasPointerCapture(active.id)) active.handle.releasePointerCapture(active.id);
  }
  finish(cancel) {
    if (!this.active) return;
    this.release();
    void this.invoke(cancel ? "resize-cancel" : "resize-end").catch(error => this.notice(error.message));
  }
  layout(value) {
    const p = value?.panel, visible = value?.expanded && !value.retracting;
    this.root.hidden = !visible;
    if (p) Object.assign(this.root.style, { left: p.x + "px", top: p.y + "px", width: p.width + "px", height: p.height + "px" });
    document.body.dataset.resizing = value?.resizing || "none";
    document.body.dataset.compactChat = String(!!p && p.height < 380);
    if (this.active?.started && (!visible || !value.resizing)) this.release();
  }
};
