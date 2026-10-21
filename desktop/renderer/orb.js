(() => {
  const bridge = window.harbourOrb, $ = id => document.getElementById(id);
  let state, pointer = null, dragHandle = null, composing = false, statusView = null;
  let messageKey = "", askKey = "", agentKey = "";
  const drafts = new Map(), pending = new Map();
  const atlases = new Map();
  const hairMotion = new window.OrbHairMotion();
  const portraitView = new window.OrbPortrait({ cache: atlases, onReady: () => { if (state) render(state); } });
  let expressionTimer, expressionDeadline = 0;
  const invoke = (action, rest = {}) => bridge.invoke({ action, ...rest });
  const notice = text => { $("notice").textContent = text || ""; $("notice").hidden = !text; };
  const attempt = (action, rest) => invoke(action, rest).catch(error => notice(error.message || String(error)));
  const messages = new window.OrbMessages({ root: $("messages"), scroller: $("conversation"), invoke, notice });
  const unread = new window.OrbUnread({ panel: $("panel"), stream: $("conversation"), getState: () => state, invoke,
    obscured: () => !$("drawer").hidden || $("imageViewer").open });
  window.addEventListener("pagehide", () => unread.dispose());
  const extras = new window.OrbExtras({ invoke, getState: () => state, notice, changed: () => { if (state) render(state); } });
  const music = new window.OrbMusic({ invoke, bridge, extras });
  const runControls = new window.OrbRunControls({ invoke, getState: () => state, beforeOpen: () => extras.close() });
  const voicePicker = new window.HarbourVoicePicker({ host: $("orbVoicePicker"), boundary: $("panel"),
    getCompanionId: () => state?.agent?.replace(/^main-/, ""), onOpen: () => { extras.close(); runControls.close(); },
    request: (choice, payload, signal) => {
      const agent = `main-${payload.companionId || state?.agent?.replace(/^main-/, "")}`;
      const cancel = () => { void invoke("voice-choice", { agent, choice: "cancel" }).catch(() => {}); };
      signal?.addEventListener("abort", cancel, { once: true });
      return invoke("voice-choice", { agent, choice, voiceId: payload.voiceId })
        .finally(() => signal?.removeEventListener("abort", cancel));
    } });
  window.addEventListener("beforeunload", () => voicePicker.destroy());
  extras.openRunSettings = () => runControls.open();
  extras.closeRunSettings = () => runControls.close();
  const panelResize = new window.OrbResize({ invoke, notice });
  function peekMotion() {
    // Explicitly stop illustration clocks when hidden/dragging. All motion is
    // local and visual: never resize the hit target or ask a model for frames.
    const visible = !!state?.enabled && !document.hidden && window.HarbourVisualActivity?.isActive() !== false && pointer === null;
    const docked = document.body.dataset.docked === "true";
    document.body.dataset.peekMotion = String(visible && docked);
    document.body.dataset.freeMotion = String(visible && !docked);
    document.body.dataset.visualMotion = String(visible);
    // Edge-hidden portraits breathe as a single intact image. The hair clock
    // belongs only to the full orb and must not keep running behind the tab.
    hairMotion.setEnabled(visible && !docked);
    if (!visible) portraitView.finishTransition();
  }
  function peekAsset(url) {
    // Lazy, once per persona/frame. No image bytes in IPC or re-decode on trace.
    if (state.enabled && document.body.dataset.edge !== "none" && url && !atlases.has(url)) {
      const image = new Image(), asset = { ready: false, image };
      atlases.set(url, asset);
      image.onload = () => {
        asset.ready = image.naturalWidth > 0 && image.naturalWidth === image.naturalHeight;
        if (state) peek(state.agents.find(a => a.agentName === state.agent));
      };
      image.onerror = () => { asset.ready = false; };
      image.src = url;
    }
    return url ? atlases.get(url) : undefined;
  }
  function peek(active) {
    const url = active?.peekAtlas, blinkUrl = active?.peekBlinkAtlas;
    const base = peekAsset(url), blink = peekAsset(blinkUrl);
    const ready = !!base?.ready, blinkReady = ready && !!blink?.ready
      && base.image.naturalWidth === blink.image.naturalWidth;
    for (const [id, source, loaded] of [["dockPortrait", url, ready], ["dockBlink", blinkUrl, blinkReady]]) {
      const tile = $(id); tile.hidden = !loaded;
      if (loaded && tile.dataset.source !== source) {
        tile.dataset.source = source; tile.style.backgroundImage = `url(${JSON.stringify(source)})`;
      }
      if (loaded) {
        const edge = state.layout?.edge, size = edge === "top" ? 76 : 88;
        const image = (id === "dockPortrait" ? base : blink).image;
        const frame = window.OrbPeekFrames.paint(source, edge, image.naturalWidth, image.naturalHeight, size);
        if (frame) {
          Object.assign(tile.style, frame.style);
          tile.dataset.frame = edge; tile.dataset.sourceRect = JSON.stringify(frame.rect);
        }
      }
    }
    $("dockLiving").dataset.blink = String(blinkReady);
    const fallback = $("dockFallback"), avatar = active?.avatar || "";
    fallback.hidden = ready;
    fallback.textContent = avatar ? "" : (active?.displayName || "Harbour").slice(0, 1);
    if (fallback.dataset.source !== avatar) {
      fallback.dataset.source = avatar;
      fallback.style.backgroundImage = avatar ? `url(${JSON.stringify(avatar)})` : "none";
    }
    peekMotion();
  }
  function portrait(active) {
    const expression = window.orbExpression(state);
    const deadline = state.enabled ? expression.resetAt : 0;
    if (deadline !== expressionDeadline) {
      clearTimeout(expressionTimer); expressionDeadline = deadline;
      if (deadline) expressionTimer = setTimeout(() => {
        expressionDeadline = 0;
        if (state) portrait(state.agents.find(a => a.agentName === state.agent));
      }, Math.max(1, deadline - Date.now()));
    }
    document.body.dataset.emotion = expression.mood;
    portraitView.paint(active, expression, state.enabled && !document.hidden && window.HarbourVisualActivity?.isActive() !== false && !state.layout?.dock && pointer === null);
    renderSignals(active, expression);
  }
  function renderSignals(active, expression) {
    const view = statusView = window.orbStatus(state, expression), { task, music } = view;
    document.body.dataset.taskState = view.kind;
    document.body.dataset.taskBusy = String(view.busy);
    document.body.dataset.signalAlert = view.alert;
    document.body.dataset.music = view.musicState;
    $("unread").hidden = view.alert === "none";
    const taskText = task ? [...new Set([task.title === "当前任务" || task.own ? task.label : task.title,
      task.detail || task.label, task.count > 1 ? `${task.count} 项任务` : ""].filter(Boolean))].join(" · ") : "";
    const musicText = music ? `${music.paused ? "已暂停" : "正在播放"} · ${music.title}${music.artist ? ` · ${music.artist}` : ""}` : "";
    const taskButton = $("taskSignal"), musicButton = $("musicSignal");
    // The current orb run already has a progress row above the composer.
    // Only other-channel activity needs an extra line; no duplicate progress.
    const showTask = task && !task.own;
    $("signals").hidden = !showTask && !music;
    taskButton.hidden = !showTask; taskButton.disabled = !!task && !task.canOpen;
    $("taskSignalText").textContent = taskText;
    taskButton.title = task ? `${task.label} · ${task.source}\n${taskText}${task.canOpen ? "\n打开对应完整会话" : ""}` : "";
    taskButton.setAttribute("aria-label", taskButton.title);
    musicButton.hidden = !music; $("musicSignalText").textContent = musicText;
    musicButton.title = music ? `${musicText}\n展开音乐控制` : "";
    musicButton.setAttribute("aria-label", musicButton.title);
    const taskSummary = task ? `${task.label} · ${task.source}\n${taskText}` : view.alert === "reply" ? "有新回复" : expression.label;
    // Native title tooltips live outside our renderer. Click-through / docking
    // can leave them stranded after the handle moves or disappears. Keep the
    // accessible status, with visible details in the existing expanded panel.
    for (const id of ["orb", "dock"]) {
      $(id).setAttribute("aria-label", `${state.expanded ? "收起" : "展开"} ${active?.displayName || "Harbour"} 悬浮助手 · ${[taskSummary, musicText].filter(Boolean).join(" · ")}`);
      $(id).removeAttribute("title");
    }
  }
  function layout(value) {
    if (!value) return;
    panelResize.layout(value);
    music.lyrics.layout(value.lyric);
    for (const [id, box] of [["orb", value.ball], ["panel", value.panel], ["dock", value.tab]]) {
      if (box) Object.assign($(id).style, { left: `${box.x}px`, top: `${box.y}px`, width: `${box.width}px`, height: `${box.height}px` });
    }
    $("panel").hidden = !value.expanded;
    $("panel").inert = !!value.retracting;
    $("orb").hidden = !!value.dock;
    // Keep the captured element mounted while pulling the tab into free space.
    // Hiding it mid-drag would let Chromium cancel pointer capture.
    const draggingTab = pointer !== null && dragHandle === $("dock");
    $("dock").hidden = !value.edge && !draggingTab;
    document.body.dataset.draggingTab = String(draggingTab && !value.edge);
    messages.visibility(value.expanded);
    document.body.dataset.docked = String(!!value.dock);
    document.body.dataset.edge = value.edge || "none";
    document.body.dataset.retracting = String(!!value.retracting);
    document.body.dataset.preview = String(value.expanded && !value.retracting);
    document.body.dataset.snap = value.snapTarget || "none";
    if (state) peek(state.agents.find(a => a.agentName === state.agent));
  }
  function render(next) {
    // Initial state RPC may return after a newer connection/visibility push.
    next = window.OrbState.merge(state, next);
    if (!next) return;
    const previous = state;
    const draftKey = value => `${value.agent}:${value.chat.sessionId || "new"}`;
    if (!previous || draftKey(previous) !== draftKey(next)) {
      if (previous) drafts.set(draftKey(previous), $("input").value);
      $("input").value = drafts.get(draftKey(next)) || ""; notice("");
    }
    state = next; layout(next.layout);
    voicePicker.sync();
    if (!next.enabled || !next.expanded) voicePicker.close();
    music.shell(next);
    if (!next.enabled) cancelDrag();
    if ((previous?.chat.phase !== next.chat.phase || previous?.chat.failure && !next.chat.failure || previous?.chat.syncError && !next.chat.syncError)
      && !["uncertain", "cancelled"].includes(next.chat.phase)) notice("");
    document.body.dataset.theme = next.appearance?.theme || "anime-wisteria";
    document.body.dataset.persona = next.agent;
    document.body.dataset.font = next.appearance?.font || "system";
    document.body.dataset.pinned = String(next.pinned);
    document.body.dataset.online = String(next.connection === "open");
    document.body.dataset.busy = String(!!next.chat.runId);
    document.body.dataset.enabled = String(next.enabled);
    $("connection").textContent = next.connection === "open" ? "在你身边" : "Harbour 尚未连接";
    $("pin").setAttribute("aria-pressed", String(next.pinned));
    $("alwaysOnTop").setAttribute("aria-pressed", String(next.alwaysOnTop));
    $("alwaysOnTop").title = next.alwaysOnTop ? "取消窗口置顶；仍可固定展开" : "保持在其他窗口上方";
    $("unread").hidden = !next.unread;
    document.body.dataset.unread = String(next.unread);
    $("orb").setAttribute("aria-expanded", String(next.expanded));
    $("dock").setAttribute("aria-expanded", String(next.expanded));
    const active = next.agents.find(a => a.agentName === next.agent);
    $("orbGlyph").textContent = next.agent === "main-aemeath" ? "a" : next.agent === "main-elaina" ? "e" : "h";
    $("orbAvatar").hidden = !active?.avatar; $("orbGlyph").hidden = !!active?.avatar;
    if (active?.avatar && $("orbAvatar").src !== active.avatar) $("orbAvatar").src = active.avatar;
    portrait(active);
    extras.render(next);
    runControls.render(next);
    if (!next.enabled || !next.expanded) music.hide();
    $("sessionTitle").textContent = next.chat.title || "新对话";
    $("sessionSource").textContent = next.chat.source?.label || "Web";
    $("sessionSource").dataset.source = next.chat.source?.kind || "web";
    $("sessionAccess").textContent = next.chat.readOnly ? "只读" : "";
    $("currentSession").title = `${next.chat.title || "新对话"}\n查看此角色的全部对话 · 与 Main Chat 共用历史`;
    const key = JSON.stringify([next.agents.map(a => [a.agentName, a.displayName]), next.agent, next.unreadAgents]);
    if (agentKey !== key) {
      agentKey = key; $("agents").replaceChildren();
      next.agents.forEach(agent => {
        const button = document.createElement("button"); button.className = "agent"; button.textContent = agent.displayName;
        button.setAttribute("aria-pressed", String(agent.agentName === next.agent));
        button.dataset.unread = String(next.unreadAgents?.includes(agent.agentName) === true);
        button.addEventListener("click", () => attempt("agent", { agent: agent.agentName })); $("agents").append(button);
      });
    }
    const mk = JSON.stringify([next.agent, next.chat.sessionId, next.chat.historyRevision]);
    if (next.enabled && next.expanded && next.historyReady && mk !== messageKey) {
      messageKey = mk; messages.render(next, active);
    }
    unread.schedule();
    const running = !!next.chat.runId || next.chat.preparing;
    // The initial /api/run remains open until completion. Once its run ID is
    // known, the same composer can submit queue/steer without launching a run.
    if (next.chat.canStop && !next.chat.inputSending && pending.get(next.agent)?.starting) {
      const started = pending.get(next.agent); pending.delete(next.agent);
      extras.consumed(next.agent, started.fileIds);
    }
    $("send").disabled = next.chat.readOnly || next.chat.preparing && !next.chat.runId || next.chat.inputSending || next.chat.loading || pending.has(next.agent) || extras.blocked(next.agent)
      || (!$("input").value.trim() && !extras.readyIds(next.agent).length) || next.chat.phase === "uncertain";
    $("new").disabled = running || next.chat.loading || next.chat.inputSending;
    for (const id of ["input", "attach", "capture"]) $(id).disabled = !!next.chat.readOnly;
    $("input").placeholder = next.chat.readOnly ? "只读历史 · 请在原渠道继续，或新建对话" : "想说什么，或想一起做什么？";
    $("composerHint").hidden = !next.chat.readOnly;
    $("composerHint").textContent = next.chat.readOnly ? "原渠道会话 · 只读" : "";
    $("send").title = "发送／排队";
    $("progress").hidden = !running;
    $("phase").textContent = next.chat.phase === "waiting" ? "等你确认"
      : next.chat.failure ? `${next.chat.failure.label}${next.chat.failure.scope === "task" ? "" : " · 主任务仍在处理"}`
      : next.chat.detail || "正在处理";
    $("stop").disabled = !next.chat.canStop || next.chat.phase === "stopping";
    $("stop").title = next.chat.runId && !next.chat.canStop ? "这条任务在完整会话中发起，请在那里停止" : "停止当前任务";
    if (["uncertain", "cancelled"].includes(next.chat.phase)) notice(next.chat.detail);
    else if (next.chat.inputNotice) notice(next.chat.inputNotice);
    else if (next.chat.syncError) notice(next.chat.syncError);
    else if (next.chat.failure && !running) notice(`${next.chat.failure.scope === "subagent" ? "子任务曾失败" : next.chat.failure.label}；请查看完整会话中的回执。`);
    const ak = JSON.stringify([next.agent, next.chat.asks]);
    if (ak !== askKey) {
      askKey = ak; const area = $("ask"); area.replaceChildren(); area.hidden = !next.chat.asks.length;
      for (const ask of next.chat.asks) {
        const title = document.createElement("strong"); title.textContent = ask.question; area.append(title);
        if (ask.detail) { const detail = document.createElement("pre"); detail.textContent = ask.detail; area.append(detail); }
        const answer = async text => {
          const buttons = [...area.querySelectorAll("button")]; buttons.forEach(b => b.disabled = true);
          try { await invoke("answer", { agent: next.agent, id: ask.id, text }); } catch (error) { notice(error.message); buttons.forEach(b => b.disabled = false); }
        };
        for (const option of ask.options || []) {
          const button = document.createElement("button"); button.textContent = option.label; button.title = option.hint || "";
          button.addEventListener("click", () => answer(option.value)); area.append(button);
        }
        const field = document.createElement("input"); field.placeholder = "也可以输入自己的回答"; field.setAttribute("aria-label", "回答提问");
        const submit = document.createElement("button"); submit.textContent = "答复"; submit.addEventListener("click", () => { if (field.value.trim()) void answer(field.value); });
        area.append(field, submit);
      }
      if (next.chat.asks.length) {
        const scroller = $("conversation");
        scroller.scrollTop += area.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
      }
    }
  }
  $("input").addEventListener("input", () => { drafts.set(`${state.agent}:${state.chat.sessionId || "new"}`, $("input").value); render(state); });
  // A preview becomes a conversation as soon as the user interacts. Includes
  // ask fields, keyboard navigation, image previews and native file pickers.
  function engage(event) {
    if (state?.expanded && !state.pinned && !event.target.closest("#pin, #collapse")) {
      void attempt("expand", { expanded: true, pinned: true });
    }
  }
  $("panel").addEventListener("pointerdown", engage, true);
  $("panel").addEventListener("focusin", engage);
  $("input").addEventListener("compositionstart", () => { composing = true; });
  $("input").addEventListener("compositionend", () => { composing = false; });
  $("input").addEventListener("keydown", event => {
    if (event.key !== "Enter" || event.shiftKey || event.altKey || composing || event.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    if (!event.repeat) void submitMessage(event.ctrlKey || event.metaKey ? "steer" : "queue");
  });
  $("composer").addEventListener("submit", event => { event.preventDefault(); void submitMessage("queue"); });
  async function submitMessage(mode) {
    if (!state || $("send").disabled || pending.has(state.agent)) return;
    const text = $("input").value.trim(), agent = state.agent, fileIds = extras.readyIds(state.agent), draft = `${agent}:${state.chat.sessionId || "new"}`;
    const submission = { starting: !state.chat.runId, fileIds };
    pending.set(agent, submission); notice(""); render(state);
    try {
      // Send immediately; no model-driven classifier or invisible background calls.
      const request = invoke("send", { agent, text, fileIds, mode });
      $("input").value = ""; drafts.delete(draft);
      await request;
      extras.consumed(agent, fileIds);
    } catch (error) {
      if (state.agent === agent && state.chat.phase === "uncertain") extras.consumed(agent, fileIds);
      if (state.agent === agent) {
        notice(error.message);
        if (!$("input").value) { $("input").value = text; drafts.set(`${agent}:${state.chat.sessionId || "new"}`, text); }
      } else if (!drafts.get(draft)) drafts.set(draft, text);
    }
    finally { if (pending.get(agent) === submission) pending.delete(agent); render(state); }
  }
  $("stop").addEventListener("click", () => attempt("stop", { agent: state.agent }));
  $("new").addEventListener("click", () => { notice(""); void attempt("new"); });
  $("open").addEventListener("click", () => attempt("open"));
  $("taskSignal").addEventListener("click", () => {
    const task = statusView?.task;
    if (!task?.canOpen) return;
    void attempt(task.own ? "open" : "open-task", { agent: state.agent, runId: task.runId });
  });
  $("musicSignal").addEventListener("click", () => music.open());
  $("music").addEventListener("click", () => music.open());
  $("pin").addEventListener("click", () => attempt("expand", { expanded: true, pinned: !state.pinned }));
  $("alwaysOnTop").addEventListener("click", () => attempt("always-on-top", { value: !state.alwaysOnTop }));
  const collapse = () => void attempt("expand", { expanded: false, pinned: false });
  async function toggleOrb() {
    try {
      // Native state is authoritative: rapid clicks must not both read the same
      // stale renderer snapshot and turn into two identical "open" requests.
      const next = await invoke("toggle"); render(next);
      if (next.expanded && state.expanded && next.stateRevision === state.stateRevision) $("input").focus();
    } catch (error) { notice(error.message); }
  }
  $("collapse").addEventListener("click", () => collapse());
  document.addEventListener("keydown", event => { if (event.key === "Escape" && !composing) {
    if (messages.closePreview()) { event.preventDefault(); return; }
    if (!$("drawer").hidden) extras.close(); else collapse();
  } });
  for (const handle of [$("orb"), $("dock")]) {
    handle.addEventListener("dragstart", event => event.preventDefault());
    handle.addEventListener("pointerdown", event => {
      if (event.button !== 0) return;
      event.preventDefault();
      pointer = event.pointerId; dragHandle = handle; peekMotion(); handle.setPointerCapture(pointer); void attempt("drag-start");
    });
    handle.addEventListener("pointermove", () => { if (pointer !== null) void attempt("drag-move"); });
    handle.addEventListener("pointerup", async event => {
      if (pointer === null) return; pointer = null; dragHandle = null;
      peekMotion();
      if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId);
      try { if (!await invoke("drag-end")) await toggleOrb(); } catch (error) { notice(error.message); }
    });
    handle.addEventListener("pointercancel", cancelDrag);
    handle.addEventListener("lostpointercapture", cancelDrag);
    handle.addEventListener("keydown", event => {
      if (event.key === "Enter") { event.preventDefault(); if (!event.repeat) void toggleOrb(); }
      if (event.key === "ArrowDown" && event.altKey && state?.layout?.edge) { event.preventDefault(); void attempt("undock"); }
    });
    handle.addEventListener("click", event => { if (event.detail === 0) void toggleOrb(); });
  }
  function cancelDrag() {
    if (pointer === null) return;
    const id = pointer, handle = dragHandle; pointer = null; dragHandle = null;
    peekMotion();
    if (handle?.hasPointerCapture(id)) handle.releasePointerCapture(id);
    void attempt("drag-end");
  }
  bridge.onState(render); bridge.onNotice(notice); bridge.onLayout(layout);
  document.addEventListener("visibilitychange", peekMotion);
  window.HarbourVisualActivity?.subscribe(() => { peekMotion(); if (state) portrait(state.agents.find(a => a.agentName === state.agent)); });
  window.addEventListener("pagehide", () => clearTimeout(expressionTimer));
  invoke("state").then(render).catch(error => notice(error.message));
})();
