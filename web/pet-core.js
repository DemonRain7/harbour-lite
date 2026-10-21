(() => {
  const STATES = Object.freeze({
    idle:            { row: 0, frames: [0, 1, 2, 3, 4, 5], ms: [280, 110, 110, 140, 140, 320], label: "待机" },
    "running-right": { row: 1, frames: [0, 1, 2, 3, 4, 5, 6, 7], ms: [120, 120, 120, 120, 120, 120, 120, 220], label: "向右跑" },
    "running-left":  { row: 2, frames: [0, 1, 2, 3, 4, 5, 6, 7], ms: [120, 120, 120, 120, 120, 120, 120, 220], label: "向左跑" },
    waving:          { row: 3, frames: [0, 1, 2, 3], ms: [140, 140, 140, 280], label: "收到消息" },
    jumping:         { row: 4, frames: [0, 1, 2, 3, 4], ms: [140, 140, 140, 140, 280], label: "发现你啦" },
    failed:          { row: 5, frames: [0, 1, 2, 3, 4, 5, 6, 7], ms: [140, 140, 140, 140, 140, 140, 140, 240], label: "遇到问题" },
    waiting:         { row: 6, frames: [0, 1, 2, 3, 4, 5], ms: [150, 150, 150, 150, 150, 260], label: "等你回答" },
    running:         { row: 7, frames: [0, 1, 2, 3, 4, 5], ms: [120, 120, 120, 120, 120, 220], label: "处理中" },
    review:          { row: 8, frames: [0, 1, 2, 3, 4, 5], ms: [150, 150, 150, 150, 150, 280], label: "完成" },
  });

  const ACTION_REPEATS = 3;
  const APPENDED_IDLE_SLOWDOWN = 6;
  const LOOK_STATES = new Set(["idle", "running", "waving"]);

  function newest(rows, statuses) {
    return rows
      .filter((item) => statuses.includes(String(item?.status || "")))
      .sort((a, b) => Number(b?.updatedAt || 0) - Number(a?.updatedAt || 0))[0];
  }

  function workCue(detail) {
    const value = String(detail || "");
    if (/(?:novelai|image|comic|draw|绘图|生图|图像|渲染)/iu.test(value)) {
      return { action: "conjure", label: "编织幻象" };
    }
    if (/(?:browser|opencli|网页|浏览器|搜索|fetch|download|upload|下载|上传)/iu.test(value)) {
      return { action: "scry", label: "远视检索" };
    }
    if (/(?:spawn_subagent|message_agent|orchestrator|派发|子代理|协作者)/iu.test(value)) {
      return { action: "summon", label: "召来协作者" };
    }
    if (/(?:tool-result|结果|核验|验证|test|typecheck|lint)/iu.test(value)) {
      return { action: "verify", label: "核对结果" };
    }
    if (/(?:read|list|history|skill|memory|inspect|get_|读取|查阅|目录)/iu.test(value)) {
      return { action: "study", label: "查阅资料" };
    }
    if (/(?:write|edit|patch|bash|create|save|append|写入|修改|保存|命令)/iu.test(value)) {
      return { action: "scribe", label: "记录咒式" };
    }
    return { action: "prepare", label: "准备工作" };
  }

  /**
   * One deterministic state selector is shared by the pixel renderer and Live2D renderer.
   * Raw activity events and the desktop snapshot arrive on separate IPC messages; resolving
   * their priority here prevents an older snapshot from overwriting a newer task animation.
   */
  function deriveFeedback({ activities = [], asks = [], companion = null, speechActive = false, music = null, dragDirection = null } = {}) {
    const rows = Array.isArray(activities) ? activities : [];
    const pendingAsks = Array.isArray(asks) ? asks : [];
    const make = (state, action, mood, label, row = null, pixelState = "idle") => ({
      state,
      action,
      mood,
      label,
      pixelState,
      source: row?.source || "WEB · Main Chat",
      active: state !== "idle" && state !== "listening",
    });

    if (dragDirection === "left" || dragDirection === "right") {
      return make("dragging", "dragging", "focused", "移动中", null, `running-${dragDirection}`);
    }
    if (speechActive || companion?.status === "speaking") {
      return make("speaking", companion?.action || "talk", companion?.mood || "calm", "正在回应", null, "idle");
    }
    if (pendingAsks.length) {
      const ask = [...pendingAsks].sort((a, b) => Number(b?.updatedAt || 0) - Number(a?.updatedAt || 0))[0];
      return make("waiting", "question", "curious", "等你回答", ask, "waiting");
    }

    const error = newest(rows, ["error"]);
    if (error) return make("failed", "worry", "concerned", "遇到阻塞", error, "failed");
    const incoming = newest(rows, ["incoming"]);
    if (incoming) return make("incoming", "greet", "happy", "收到消息", incoming, "waving");
    const running = newest(rows, ["running"]);
    if (running) {
      const detail = String(running.detail || "");
      if (/(?:整理计划|规划|plan)/iu.test(detail)) return make("thinking", "plan", "focused", "整理旅程", running, "running");
      if (/(?:思考|分析|推理)/u.test(detail)) return make("thinking", "think", "focused", "推演咒式", running, "running");
      if (/(?:重连|连接中断|切换备用|尝试其它|连接恢复|WebSocket|HTTPS)/iu.test(detail)) {
        return make("reconnecting", "reconnecting", "concerned", "连接恢复中", running, "running");
      }
      if (/(?:使用|调用|工具|读取|写入|生成|下载|上传)/u.test(detail)) {
        const cue = workCue(detail);
        return make("working", cue.action, "focused", cue.label, running, "running");
      }
      return make("working", "prepare", "focused", "准备工作", running, "running");
    }
    const complete = newest(rows, ["complete"]);
    if (complete) return make("complete", "celebrate", "happy", "已完成", complete, "review");

    const status = String(companion?.status || "idle");
    if (status === "thinking") return make("thinking", companion?.action || "think", companion?.mood || "focused", "正在思考", null, "running");
    if (status === "working" || status === "running") return make("working", companion?.action || "prepare", companion?.mood || "focused", "准备工作", null, "running");
    if (status === "waiting") return make("waiting", companion?.action || "question", companion?.mood || "curious", "等你回答", null, "waiting");
    if (status === "complete") return make("complete", companion?.action || "celebrate", companion?.mood || "happy", "已完成", null, "review");
    if (status === "error") return make("failed", companion?.action || "worry", companion?.mood || "concerned", "遇到阻塞", null, "failed");
    if (status === "incoming") return make("incoming", companion?.action || "greet", companion?.mood || "curious", "收到消息", null, "waving");
    if (music?.loaded && !music.paused && music.connected !== false && music.running !== false) {
      return { ...make("listening", "listening", "happy", "音乐陪伴"), source: music.provider === 'folia' ? 'Folia · 本机' : '音乐播放器' };
    }
    return make("idle", "idle", "calm", "待机");
  }

  function sourceLabel(source) {
    if (!source) return "WEB · Main Chat";
    const app = source.platform === "discord" ? "DISCORD" : String(source.platform || "WEB").toUpperCase();
    const where = [source.accountLabel, source.containerName, source.locationName].filter(Boolean).join(" · ");
    return where ? `${app} · ${where}` : app;
  }

  // v2 图集的最后两行存放 16 个视线方向：从正上方开始，顺时针每 22.5° 一格。
  function lookFrameFromPointer(rect, point, spriteVersionNumber = 1) {
    if (spriteVersionNumber < 2 || !rect || !point) return null;
    const dx = point.x - (rect.left + rect.width / 2);
    const dy = point.y - (rect.top + rect.height / 2);
    if (Math.hypot(dx, dy) <= 1) return null;
    const degrees = (Math.atan2(dx, -dy) * 180 / Math.PI + 360) % 360;
    const direction = Math.round(degrees / 22.5) % 16;
    return { col: direction % 8, row: 9 + Math.floor(direction / 8) };
  }

  function createAnimator({
    sprite,
    stateText,
    sourceText,
    activeTarget,
    agentName,
    columns = 8,
    rows = 11,
    spriteVersionNumber = 1,
  }) {
    let requested = "idle";
    let current = "idle";
    let frame = 0;
    let cycles = 0;
    let timer = 0;
    let hovering = false;
    let movement = null;
    let lookFrame = null;
    let appendedIdle = false;
    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)");

    function effectiveState() {
      if (movement === "left") return "running-left";
      if (movement === "right") return "running-right";
      if (hovering) return "jumping";
      return requested;
    }

    function paintCell(row, col) {
      const x = columns > 1 ? col / (columns - 1) * 100 : 0;
      const y = rows > 1 ? row / (rows - 1) * 100 : 0;
      sprite.style.backgroundPosition = `${x}% ${y}%`;
    }

    function canLook() {
      return spriteVersionNumber >= 2 && !movement && !hovering && LOOK_STATES.has(current);
    }

    function draw() {
      const def = STATES[current] || STATES.idle;
      if (lookFrame && canLook()) paintCell(lookFrame.row, lookFrame.col);
      else paintCell(def.row, def.frames[frame] ?? 0);
      if (stateText) stateText.textContent = STATES[requested]?.label || def.label;
      activeTarget?.classList.toggle("is-active", requested !== "idle");
      clearTimeout(timer);
      if (window.HarbourVisualActivity?.isActive() === false || reducedMotion?.matches || (lookFrame && canLook())) return;

      const baseDelay = def.ms[Math.min(frame, def.ms.length - 1)] || 160;
      timer = window.setTimeout(() => {
        frame += 1;
        if (frame >= def.frames.length) {
          frame = 0;
          cycles += 1;
          // 与 Codex 的 v2 pet runtime 一致：动作播放三轮，随后接一段缓慢待机，
          // 不让长任务持续高频闪动；新的状态事件会随时打断并重播动作。
          if (current !== "idle" && cycles >= ACTION_REPEATS) {
            current = "idle";
            cycles = 0;
            appendedIdle = true;
          }
        }
        draw();
      }, appendedIdle && current === "idle" ? baseDelay * APPENDED_IDLE_SLOWDOWN : baseDelay);
    }

    function restart(name) {
      current = STATES[name] ? name : "idle";
      frame = 0;
      cycles = 0;
      appendedIdle = false;
      lookFrame = null;
      draw();
    }

    function signal(name, detail = {}) {
      requested = STATES[name] ? name : "idle";
      if (sourceText && detail.source) sourceText.textContent = detail.source;
      restart(effectiveState());
    }

    function gesture(name) {
      if (STATES[name]) restart(name);
    }

    function setHover(value) {
      const next = !!value;
      if (hovering === next) return;
      hovering = next;
      restart(effectiveState());
    }

    function setMovement(direction) {
      const next = direction === "left" || direction === "right" ? direction : null;
      if (movement === next) return;
      movement = next;
      restart(effectiveState());
    }

    function lookAt(rect, point) {
      if (!canLook()) {
        if (lookFrame) restart(effectiveState());
        return false;
      }
      const next = lookFrameFromPointer(rect, point, spriteVersionNumber);
      if (!next) {
        if (lookFrame) restart(effectiveState());
        return false;
      }
      if (lookFrame?.row === next.row && lookFrame?.col === next.col) return true;
      lookFrame = next;
      draw();
      return true;
    }

    function consume(event) {
      if (!event || event.agent !== agentName) return false;
      const detail = { source: sourceLabel(event.source) };
      if (event.phase === "incoming") signal("waving", detail);
      else if (event.phase === "running") signal("running", detail);
      else if (event.phase === "complete") signal("review", detail);
      else if (event.phase === "error") signal("failed", detail);
      else if (event.phase === "cancelled") signal("idle", detail);
      else return false;
      return true;
    }

    function consumeAsk(event) {
      if (event?.ask?.agent !== agentName) return false;
      signal(event.kind === "resolved" ? "running" : "waiting", { source: sourceLabel(event.ask.source) });
      return true;
    }

    const onReducedMotionChange = () => restart(effectiveState());
    reducedMotion?.addEventListener?.("change", onReducedMotionChange);
    const removeVisualListener = window.HarbourVisualActivity?.subscribe(() => draw());
    draw();
    return {
      signal,
      gesture,
      setHover,
      setMovement,
      lookAt,
      consume,
      consumeAsk,
      destroy() {
        clearTimeout(timer);
        removeVisualListener?.();
        reducedMotion?.removeEventListener?.("change", onReducedMotionChange);
      },
      get state() { return current; },
      get requestedState() { return requested; },
    };
  }

  window.HarbourPetCore = { STATES, createAnimator, sourceLabel, lookFrameFromPointer, deriveFeedback, workCue };
})();
