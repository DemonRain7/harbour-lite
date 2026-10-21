(() => {
  const desktop = window.harbourDesktop;
  const query = new URLSearchParams(location.search);
  const petContext = desktop?.petContext || {};
  const petId = String(petContext.id || query.get("pet") || "elaina").replace(/[^a-z0-9_-]/gi, "") || "elaina";
  const agentName = String(petContext.agentName || query.get("agent") || `main-${petId}`);
  const displayName = String(petContext.displayName || query.get("name") || petId);
  const host = document.getElementById("desktopPet");
  const stage = document.getElementById("petStage");
  const sprite = document.getElementById("petSprite");
  const live2dCanvas = document.getElementById("petLive2d");
  const interactionZone = document.getElementById("petInteractionZone");
  const interactButton = document.getElementById("petInteract");
  const voiceButton = document.getElementById("petVoice");
  const stateText = document.getElementById("petState");
  const sourceText = document.getElementById("petSource");
  const nameText = document.getElementById("petName");
  const placeholder = document.getElementById("petPlaceholder");
  const placeholderName = document.getElementById("petPlaceholderName");
  const placeholderMessage = document.getElementById("petPlaceholderMessage");
  const activity = document.getElementById("petActivity");
  const activityTitle = document.getElementById("petActivityTitle");
  const activityCount = document.getElementById("petActivityCount");
  const taskList = document.getElementById("petTaskList");
  const petSpeech = document.getElementById("petSpeech");
  const petSpeechText = document.getElementById("petSpeechText");
  const petSpeechOpen = document.getElementById("petSpeechOpen");
  const petSpeechSource = document.getElementById("petSpeechSource");
  const petSpeechDismiss = document.getElementById("petSpeechDismiss");
  let visibleBubble = null;
  let bubbleTimer = null;
  const dismissedBubbles = new Set();
  const dismissedReplies = new Set();
  const activities = new Map();
  const asks = new Map();
  const cleanupTimers = new Map();
  let socket = null;
  let animator = null;
  let live2dHost = null;
  let character = null;
  let voiceEnabled = false;
  let voiceServiceConfigured = false;
  let speechQueue = [];
  let speechGeneration = 0;
  let currentSpeech = null;
  let audioContext = null;
  let visualState = "idle";
  let activityRenderKey = "", companionPresentationKey = "";
  let companionSnapshotState = null;
  let companionMusicState = null;
  let dragDirection = null;
  let inputRegionFrame = 0;
  let interactionFeedbackTimer = 0;
  let interactionFeedbackRevision = 0;
  let removeCompanionEventListener = null;
  let removeCompanionStateListener = null;
  const musicControls = window.HarbourPetMusic?.mount({ desktop, changed: scheduleInputRegionSync });
  host.dataset.agent = agentName;
  host.dataset.petId = petId;

  function setPetIdentity(name) {
    document.title = `${name} · Harbour Pet`;
    host.setAttribute("aria-label", `${name} 桌面宠物`);
    nameText.textContent = name;
    if (placeholderName) placeholderName.textContent = name;
    interactionZone?.setAttribute("title", `轻触 ${name}`);
    interactionZone?.setAttribute("aria-label", `轻触 ${name} 互动`);
  }

  function showVisualUnavailable(message = "外观加载失败") {
    try { live2dHost?.destroy(); } catch { /* Keep the recovery controls usable. */ }
    try { animator?.destroy(); } catch { /* Keep the recovery controls usable. */ }
    live2dHost = null;
    animator = null;
    host.dataset.visualStatus = "unavailable";
    sprite.hidden = true;
    live2dCanvas.hidden = true;
    if (placeholder) placeholder.hidden = false;
    if (placeholderMessage) placeholderMessage.textContent = message;
    stage.style.width = "132px";
    stage.style.height = "121.333px";
    document.documentElement.style.setProperty("--pet-stage-height", "121.333px");
    stateText.textContent = "外观不可用";
    sourceText.textContent = "可拖动或关闭";
    scheduleInputRegionSync();
  }

  function loadPixelImage(src) {
    // A valid JSON manifest alone does not mean the sheet exists/decodes. Never leave an
    // invisible pet with working tasks, or show another character's default sheet.
    return new Promise((resolve, reject) => {
      const image = new Image();
      const finish = (error) => {
        clearTimeout(timer);
        image.onload = image.onerror = null;
        error ? reject(error) : resolve();
      };
      const timer = setTimeout(() => finish(new Error("桌宠图集加载超时")), 10000);
      image.onload = () => finish();
      image.onerror = () => finish(new Error("桌宠图集无法读取"));
      image.src = src;
    });
  }

  function serverBase() {
    const configured = String(desktop?.serverUrl || "").trim();
    if (configured) return configured.replace(/\/+$/, "");
    return location.origin;
  }

  function apiUrl(pathname) {
    return new URL(pathname.replace(/^\//, ""), `${serverBase()}/`).toString();
  }

  function webAssetUrl(pathname) {
    const clean = pathname.replace(/^\//, "");
    return location.protocol === "file:"
      ? new URL(`./${clean}`, location.href).toString()
      : apiUrl(clean);
  }

  const statusLabels = {
    incoming: "收到消息",
    running: "进行中",
    waiting: "需要回答",
    complete: "已完成",
    error: "遇到阻塞",
    cancelled: "已停止",
  };

  function esc(value) {
    return String(value ?? "").replace(/[&<>"']/g, (char) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[char]);
  }

  function shortTask(value, fallback = "正在处理任务") {
    const text = String(value || "").replace(/\s+/g, " ").trim();
    return text ? text.slice(0, 160) : fallback;
  }

  function askSource(ask) {
    if (ask?.source) return window.HarbourPetCore.sourceLabel(ask.source);
    const channel = String(ask?.channel || "web").toLowerCase();
    if (channel === "discord") return "DISCORD";
    if (channel === "qq") return "QQ";
    return "WEB · Main Chat";
  }

  function newestActivity(statuses) {
    return [...activities.values()]
      .filter((item) => statuses.includes(item.status))
      .sort((a, b) => b.updatedAt - a.updatedAt)[0];
  }

  function currentFeedback() {
    const rows = activityRows();
    return window.HarbourPetCore.deriveFeedback({
      activities: rows.filter((item) => !String(item.id).startsWith("ask:")),
      asks: rows.filter((item) => String(item.id).startsWith("ask:")),
      companion: companionSnapshotState,
      speechActive: !!currentSpeech,
      music: companionMusicState,
      dragDirection,
    });
  }

  function titleForState(state) {
    if (state === "waiting") return "需要你的回答";
    if (state === "failed") return "任务遇到阻塞";
    if (state === "complete") return "任务已完成";
    return "正在处理任务";
  }

  function activityRows() {
    const pendingAsks = [...asks.values()].map((ask) => ({
      id: `ask:${ask.id}`,
      status: "waiting",
      title: shortTask(ask.question, "需要你的回答"),
      detail: "等待确认",
      source: askSource(ask),
      updatedAt: Date.parse(ask.createdAt || "") || Date.now(),
    }));
    return pendingAsks.concat([...activities.values()]).sort((a, b) => {
      const priority = { waiting: 0, error: 1, running: 2, incoming: 2, complete: 3, cancelled: 4 };
      return (priority[a.status] ?? 9) - (priority[b.status] ?? 9) || b.updatedAt - a.updatedAt;
    });
  }

  function renderActivity() {
    const rows = activityRows();
    const feedback = currentFeedback();
    musicControls?.update(companionMusicState, rows.length > 0 || !petSpeech.hidden || !['idle', 'listening'].includes(feedback.state));
    const source = feedback.source || rows[0]?.source || "WEB · Main Chat";
    const showingInteraction = host.classList.contains("is-interacting");
    const label = currentSpeech?.audio ? "正在说话" : currentSpeech ? "正在准备语音" : feedback.label;
    // Playback telemetry still reaches the music controls, but elapsed time is
    // not a new task/pose. Avoid rebuilding task DOM and resetting Live2D each beat.
    const key = JSON.stringify([rows, feedback, source, showingInteraction, label,
      !!petSpeechText.textContent, !!animator, !!live2dHost, companionPresentationKey]);
    if (key === activityRenderKey) return;
    activityRenderKey = key;
    host.dataset.petState = feedback.state;
    host.dataset.petAction = feedback.action || "idle";
    host.classList.toggle("has-activity", rows.length > 0);
    host.classList.toggle("is-active", feedback.active || rows.length > 0 || !!petSpeechText.textContent);
    activity.hidden = rows.length === 0;
    if (!rows.length) {
      taskList.innerHTML = "";
      activityCount.textContent = "";
    } else {
      activityTitle.textContent = titleForState(feedback.state);
      activityCount.textContent = rows.length > 2 ? `+${rows.length - 2}` : "";
      taskList.innerHTML = rows.map((item) => {
        const detail = [item.detail || statusLabels[item.status], item.source].filter(Boolean).join(" · ");
        const dismissible = ["complete", "error", "cancelled"].includes(item.status);
        return `<div class="pet-task${dismissible ? " is-dismissible" : ""}" data-status="${esc(item.status)}" title="${esc(item.title)}">
          <span class="pet-task-copy"><b>${esc(item.title)}</b><small>${esc(detail)}</small></span>
          ${dismissible ? `<button type="button" class="pet-task-dismiss" data-dismiss-task="${esc(item.id)}" aria-label="收起这条任务">×</button>` : ""}
        </div>`;
      }).join("");
    }

    if (sourceText && !showingInteraction) sourceText.textContent = source;
    if (animator && feedback.state !== visualState) animator.signal(feedback.pixelState, { source });
    live2dHost?.setState(feedback.state, {
      source,
      mood: feedback.mood,
      action: feedback.action,
    });
    if (stateText && !showingInteraction) stateText.textContent = label;
    visualState = feedback.state;
    scheduleInputRegionSync();
  }

  async function runPetInteraction(point) {
    const revision = ++interactionFeedbackRevision;
    clearTimeout(interactionFeedbackTimer);
    // A click must acknowledge immediately. Live2D expression loading and task-state traffic are
    // asynchronous; neither is allowed to make the control appear unresponsive.
    host.classList.remove("is-interacting");
    void host.offsetWidth;
    host.classList.add("is-interacting");
    host.dataset.interactionState = "pending";
    stateText.textContent = "回应你啦";
    sourceText.textContent = "轻触互动";
    interactionFeedbackTimer = window.setTimeout(() => {
      if (revision !== interactionFeedbackRevision) return;
      host.classList.remove("is-interacting");
      host.dataset.interactionState = "idle";
      const feedback = currentFeedback();
      if (stateText.textContent === "回应你啦") {
        stateText.textContent = currentSpeech?.audio ? "正在说话" : currentSpeech ? "正在准备语音" : feedback.label;
      }
      if (sourceText.textContent === "轻触互动") sourceText.textContent = feedback.source || "WEB · Main Chat";
    }, 1_700);
    try {
      const reacted = live2dHost?.ready
        ? await live2dHost.interact(point)
        : (animator?.signal("waving", { source: "桌面互动" }), true);
      if (revision !== interactionFeedbackRevision) return;
      host.dataset.interactionState = reacted ? "active" : "fallback";
      if (!reacted) animator?.signal("waving", { source: "桌面互动" });
    } catch (error) {
      host.dataset.interactionState = "failed";
      console.warn("[Harbour Pet] interaction failed", error);
    }
  }

  function elementRegion(element, padding = 0) {
    if (!element || element.hidden || getComputedStyle(element).display === "none") return null;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    return {
      x: rect.left - padding,
      y: rect.top - padding,
      width: rect.width + padding * 2,
      height: rect.height + padding * 2,
    };
  }

  function consumeServerMessage(msg) {
    host.dataset.eventCount = String(Number(host.dataset.eventCount || 0) + 1);
    host.dataset.lastEvent = String(msg?.__harbour || msg?.msg || "log").slice(0, 48);
    host.dataset.lastEventAgent = String(msg?.agent || msg?.ask?.agent || "").slice(0, 64);
    host.dataset.lastEventPhase = String(msg?.phase || msg?.kind || "").slice(0, 32);
    if (msg?.__harbour === "channel-activity") consumeActivity(msg);
    else if (msg?.__harbour === "activity-snapshot") consumeActivitySnapshot(msg);
    else if (msg?.__harbour === "ask") consumeAsk(msg);
    else if (msg?.__harbour === "companion:utterance") consumeUtterance(msg);
    else consumeLog(msg);
  }

  function applyCompanionState(snapshot) {
    const appearance = snapshot?.appearance || {};
    const state = snapshot?.characters?.[petId];
    companionSnapshotState = state || null;
    companionMusicState = snapshot?.music || null;
    const key = JSON.stringify([appearance, state, snapshot?.connection]);
    if (key !== companionPresentationKey) {
      companionPresentationKey = key;
      host.dataset.theme = appearance.theme || "anime-wisteria";
      host.dataset.font = appearance.font || "system";
      host.dataset.bubbleStyle = appearance.bubbleStyle || "glass";
      host.dataset.connection = snapshot?.connection || host.dataset.connection || "connecting";
      showBubble(state?.bubble);
    }
    renderActivity();
  }

  function rememberDismissed(set, id) {
    if (!id) return;
    set.add(id);
    if (set.size > 128) set.delete(set.values().next().value);
  }

  function hideBubble(notify = false) {
    if (!visibleBubble && petSpeech.hidden) return;
    clearTimeout(bubbleTimer);
    bubbleTimer = null;
    const previous = visibleBubble;
    visibleBubble = null;
    if (previous) {
      rememberDismissed(dismissedBubbles, previous.id);
      rememberDismissed(dismissedReplies, previous.runId);
      // Do not reveal a duplicate "completed" task card behind the dismissed reply.
      if (["complete", "error", "cancelled"].includes(activities.get(previous.runId)?.status)) {
        activities.delete(previous.runId);
        clearTimeout(cleanupTimers.get(previous.runId));
        cleanupTimers.delete(previous.runId);
      }
      if (notify) Promise.resolve(desktop?.dismissCompanionBubble?.(previous.id, petId)).catch(() => {});
    }
    petSpeech.hidden = true;
    petSpeechText.textContent = "";
    host.classList.remove("has-speech");
    renderActivity();
  }

  function showBubble(bubble) {
    if (!bubble?.text) { hideBubble(); return; }
    const id = bubble.id || `${bubble.createdAt || "legacy"}:${bubble.text}`;
    const createdAt = Number(bubble.createdAt) || Date.parse(bubble.createdAt) || Date.now();
    const expiresAt = visibleBubble?.id === id ? visibleBubble.expiresAt
      : Math.min(Number(bubble.expiresAt) || createdAt + 8_000, Date.now() + 8_000);
    if (dismissedBubbles.has(id) || expiresAt <= Date.now()) {
      if (visibleBubble?.id === id) hideBubble();
      return;
    }
    if (visibleBubble && visibleBubble.id !== id) hideBubble();
    visibleBubble = { ...bubble, id, expiresAt };
    petSpeechText.textContent = String(bubble.text);
    const platform = String(bubble.source?.platform || "").toUpperCase();
    const canOpen = !!bubble.sessionId && typeof desktop?.openConversation === "function";
    if (petSpeechOpen) {
      petSpeechOpen.disabled = !canOpen;
      petSpeechOpen.title = canOpen ? "查看这条回复对应的会话" : "这条通知没有关联会话；可用下方箭头打开 Harbour";
    }
    if (petSpeechSource) petSpeechSource.textContent = [platform, canOpen ? "查看 ↗" : ""].filter(Boolean).join(" · ");
    petSpeech.hidden = false;
    host.classList.add("has-speech");
    clearTimeout(bubbleTimer);
    // Renderer fallback also retires stale snapshots from an older/reconnecting shell.
    bubbleTimer = setTimeout(() => { if (visibleBubble?.id === id) hideBubble(true); }, expiresAt - Date.now());
  }

  function syncInputRegions() {
    inputRegionFrame = 0;
    if (!desktop?.setPetInputRegions) return;
    const regions = [
      elementRegion(stage, 2),
      elementRegion(activity, 2),
      elementRegion(petSpeech, 2),
      elementRegion(document.getElementById('petMusicBar'), 2),
      elementRegion(document.querySelector(".desktop-pet-controls"), 2),
      elementRegion(document.querySelector(".desktop-pet-caption"), 1),
    ].filter(Boolean);
    desktop.setPetInputRegions(regions, petId);
  }

  function scheduleInputRegionSync() {
    if (!desktop?.setPetInputRegions || inputRegionFrame) return;
    inputRegionFrame = requestAnimationFrame(syncInputRegions);
  }

  function scheduleRemoval(id, delay) {
    clearTimeout(cleanupTimers.get(id));
    const stamp = activities.get(id)?.updatedAt;
    cleanupTimers.set(id, window.setTimeout(() => {
      if (activities.get(id)?.updatedAt !== stamp) return;
      activities.delete(id);
      cleanupTimers.delete(id);
      renderActivity();
    }, delay));
  }

  function consumeActivity(event) {
    if (!event || event.agent !== agentName) return;
    const id = String(event.runId || event.taskId || event.sessionId || `${event.agent}:current`);
    if (event.intakeHandoff) {
      activities.delete(id); clearTimeout(cleanupTimers.get(id)); cleanupTimers.delete(id);
      renderActivity(); return;
    }
    const previous = activities.get(id);
    const status = event.phase === "incoming" ? "incoming"
      : event.phase === "complete" ? "complete"
      : event.phase === "error" ? "error"
      : event.phase === "cancelled" ? "cancelled"
      : "running";
    const source = window.HarbourPetCore.sourceLabel(event.source);
    if (["complete", "error", "cancelled"].includes(status) && dismissedReplies.has(id)) {
      activities.delete(id);
      clearTimeout(cleanupTimers.get(id));
      cleanupTimers.delete(id);
      renderActivity();
      return;
    }
    activities.set(id, {
      id,
      status,
      title: shortTask(event.task, previous?.title),
      detail: event.detail || statusLabels[status],
      source,
      updatedAt: Date.now(),
    });
    clearTimeout(cleanupTimers.get(id));
    if (status === "complete") scheduleRemoval(id, 30000);
    else if (status === "error") scheduleRemoval(id, 45000);
    else if (status === "cancelled") scheduleRemoval(id, 8000);
    if ((status === "error" || status === "cancelled") && currentSpeech?.runId === id) cancelSpeech(true);
    renderActivity();
  }

  function consumeActivitySnapshot(event) {
    const activeRunIds = new Set(Array.isArray(event?.activeRunIds)
      ? event.activeRunIds.map((id) => String(id))
      : []);
    let changed = false;
    for (const [id, item] of activities) {
      if (!["incoming", "running"].includes(item.status) || activeRunIds.has(id)) continue;
      clearTimeout(cleanupTimers.get(id));
      cleanupTimers.delete(id);
      activities.delete(id);
      changed = true;
    }
    if (changed) renderActivity();
  }

  function consumeAsk(event) {
    if (event?.ask?.agent !== agentName) return;
    if (event.kind === "resolved") asks.delete(event.ask.id);
    else asks.set(event.ask.id, event.ask);
    renderActivity();
  }

  function refineCurrentTask(detail) {
    const item = newestActivity(["running", "incoming"]);
    if (!item || item.detail === detail) return;
    item.detail = detail;
    item.status = "running";
    item.updatedAt = Date.now();
    renderActivity();
  }

  function consumeLog(msg) {
    if (msg?.agent !== agentName) return;
    if (msg.msg === "loop:thinking") refineCurrentTask("正在思考");
    else if (msg.msg === "loop:tool-calls") {
      const calls = Array.isArray(msg.calls) ? msg.calls.slice(0, 2).join("、") : "";
      refineCurrentTask(calls ? `正在使用 ${calls}` : "正在调用工具");
    } else if (msg.msg === "loop:tool-result") refineCurrentTask("正在核验工具结果");
    else if (msg.msg === "plan:submitted") refineCurrentTask("正在整理计划");
    else if (msg.msg === "loop:fallback") refineCurrentTask(msg.isLast ? "正在切换备用模型" : "正在尝试其它模型");
    else if (msg.msg === "loop:reconnecting") refineCurrentTask("模型连接中断 · 正在重试");
    else if (msg.msg === "loop:transport-fallback") refineCurrentTask("WebSocket 不可用 · 已切换 HTTPS");
    else if (msg.msg === "loop:reconnected") refineCurrentTask("模型连接已恢复");
    else if (msg.msg === "loop:interrupted") refineCurrentTask("任务已中断 · 进度已保存");
  }

  function authToken() {
    return localStorage.getItem("harbour-token") || "";
  }

  async function loadPendingAsks() {
    try {
      const response = await fetch(apiUrl("/api/asks"), {
        headers: authToken() ? { Authorization: `Bearer ${authToken()}` } : {},
      });
      if (!response.ok) return;
      const body = await response.json();
      asks.clear();
      for (const ask of body.asks || []) if (ask.agent === agentName) asks.set(ask.id, ask);
      renderActivity();
    } catch {
      /* WS 重连会继续尝试，ask 拉取失败不影响桌宠动画 */
    }
  }

  function connect() {
    if (socket && (socket.readyState === WebSocket.CONNECTING || socket.readyState === WebSocket.OPEN)) return;
    const base = new URL(serverBase());
    const proto = base.protocol === "https:" ? "wss" : "ws";
    const token = authToken();
    const ws = new WebSocket(`${proto}://${base.host}/ws${token ? `?token=${encodeURIComponent(token)}` : ""}`);
    socket = ws;
    ws.onopen = () => {
      if (socket !== ws) return;
      host.dataset.connection = "open";
      if (!activityRows().length) sourceText.textContent = "WEB · Main Chat";
      loadPendingAsks();
    };
    ws.onerror = () => { host.dataset.connection = "error"; };
    ws.onclose = (event) => {
      if (socket !== ws) return;
      socket = null;
      host.dataset.connection = `closed:${event.code || 0}`;
      for (const item of activities.values()) {
        if (["incoming", "running"].includes(item.status)) item.detail = "Harbour 连接中 · 等待核验";
      }
      renderActivity();
      if (!activityRows().length) sourceText.textContent = "Harbour 连接中…";
      window.setTimeout(connect, 1500);
    };
    ws.onmessage = (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      consumeServerMessage(msg);
    };
  }

  function splitSpeech(text) {
    const maxChars = Math.max(80, Math.min(600, Number(character?.manifest?.voice?.maxChunkChars) || 220));
    const maxChunks = Math.max(1, Math.min(8, Number(character?.manifest?.voice?.maxQueuedChunks) || 4));
    const sentences = String(text || "").split(/(?<=[。！？!?…；;\.])\s*|\n+/u).map((item) => item.trim()).filter(Boolean);
    const chunks = [];
    let current = "";
    for (const sentence of sentences) {
      const pieces = sentence.length <= maxChars
        ? [sentence]
        : Array.from({ length: Math.ceil(sentence.length / maxChars) }, (_, index) => sentence.slice(index * maxChars, (index + 1) * maxChars));
      for (const piece of pieces) {
        if (current && current.length + piece.length > maxChars) {
          chunks.push(current);
          current = "";
        }
        current += piece;
        if (chunks.length >= maxChunks) break;
      }
      if (chunks.length >= maxChunks) break;
    }
    if (current && chunks.length < maxChunks) chunks.push(current);
    return chunks;
  }

  function updateVoiceButton() {
    if (!voiceButton) return;
    voiceButton.textContent = voiceEnabled ? "♫" : "♩";
    voiceButton.classList.toggle("is-enabled", voiceEnabled);
    voiceButton.classList.toggle("is-unavailable", !voiceServiceConfigured);
    voiceButton.setAttribute("aria-pressed", String(voiceEnabled));
    voiceButton.setAttribute("aria-disabled", String(!voiceServiceConfigured));
    const provider = character?.voiceService?.provider || "未配置";
    voiceButton.title = !voiceServiceConfigured
      ? "语音服务未配置 · 请在 Harbour 后端设置 TTS_URL"
      : voiceEnabled ? `关闭角色语音 · ${provider}` : `开启角色语音 · ${provider}`;
    voiceButton.setAttribute("aria-label", voiceButton.title);
  }

  function resetMouth() {
    live2dHost?.setMouthOpen(0);
    host.style.setProperty("--pet-mouth", "0");
    host.classList.remove("is-speaking");
  }

  function cancelSpeech(terminate = false) {
    speechGeneration += 1;
    speechQueue = [];
    const active = currentSpeech;
    currentSpeech = null;
    if (active?.audio) {
      active.audio.pause();
      active.audio.src = "";
    }
    if (active?.requestId) {
      desktop?.cancelCompanionSpeech?.(active.requestId, terminate).catch(() => {});
      if (active.focus) desktop?.companionAudioFocus?.("release", active.requestId).catch(() => {});
    }
    resetMouth();
    renderActivity();
  }

  async function acquireAudioFocus(requestId, generation) {
    for (let index = 0; index < 160 && generation === speechGeneration; index += 1) {
      if (await desktop?.companionAudioFocus?.("acquire", requestId)) return true;
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    return false;
  }

  function animateMouth(analyser, audio, generation) {
    const samples = new Uint8Array(analyser.fftSize);
    let envelope = 0;
    const tick = () => {
      if (generation !== speechGeneration || audio.paused || audio.ended) {
        resetMouth();
        return;
      }
      analyser.getByteTimeDomainData(samples);
      let squareSum = 0;
      for (const sample of samples) {
        const centered = (sample - 128) / 128;
        squareSum += centered * centered;
      }
      const rms = Math.sqrt(squareSum / samples.length);
      const target = Math.max(0, Math.min(1, (rms - 0.018) * 11));
      envelope += (target - envelope) * (target > envelope ? 0.42 : 0.14);
      live2dHost?.setMouthOpen(envelope);
      host.style.setProperty("--pet-mouth", envelope.toFixed(3));
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  async function playSpeechAudio(result, item, generation) {
    const requestId = item.requestId;
    if (!await acquireAudioFocus(requestId, generation)) return;
    if (generation !== speechGeneration) {
      await desktop?.companionAudioFocus?.("release", requestId);
      return;
    }
    const audio = new Audio(`data:${result.mime || "audio/wav"};base64,${result.data}`);
    currentSpeech = { ...item, audio, focus: true };
    renderActivity();
    audioContext ||= new AudioContext();
    if (audioContext.state === "suspended") await audioContext.resume();
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 256;
    analyser.smoothingTimeConstant = 0.18;
    const source = audioContext.createMediaElementSource(audio);
    source.connect(analyser);
    analyser.connect(audioContext.destination);
    host.classList.add("is-speaking");
    animateMouth(analyser, audio, generation);
    try {
      await new Promise((resolve, reject) => {
        audio.addEventListener("ended", resolve, { once: true });
        audio.addEventListener("error", () => reject(new Error("音频播放失败")), { once: true });
        audio.play().catch(reject);
      });
    } finally {
      source.disconnect();
      analyser.disconnect();
      await desktop?.companionAudioFocus?.("release", requestId);
      if (currentSpeech?.requestId === requestId) currentSpeech = null;
      resetMouth();
      renderActivity();
    }
  }

  async function runSpeechQueue(generation) {
    while (speechQueue.length && generation === speechGeneration && voiceEnabled) {
      const item = speechQueue.shift();
      currentSpeech = item;
      renderActivity();
      try {
        const result = await desktop.synthesizeCompanionSpeech({
          requestId: item.requestId,
          text: item.text,
          emotion: item.emotion,
          source: item.source,
        });
        if (generation !== speechGeneration || !voiceEnabled) break;
        await playSpeechAudio(result, item, generation);
      } catch (error) {
        if (generation === speechGeneration) {
          host.dataset.voiceError = error instanceof Error ? error.message.slice(0, 160) : String(error).slice(0, 160);
          sourceText.textContent = "远端语音暂不可用 · 文字回答不受影响";
          window.setTimeout(() => {
            if (!activityRows().length) sourceText.textContent = "WEB · Main Chat";
          }, 5000);
        }
        break;
      } finally {
        if (currentSpeech?.requestId === item.requestId) currentSpeech = null;
      }
    }
    resetMouth();
    renderActivity();
  }

  function consumeUtterance(event) {
    if (!voiceEnabled || !desktop?.synthesizeCompanionSpeech) return;
    if (event?.agent !== agentName || event?.companionId !== petId) return;
    const chunks = splitSpeech(event.text);
    if (!chunks.length) return;
    cancelSpeech(true);
    const generation = speechGeneration;
    speechQueue = chunks.map((text, index) => ({
      requestId: `${String(event.runId || "run")}-${index}-${Date.now().toString(36)}`,
      runId: String(event.runId || ""),
      text,
      emotion: "neutral",
      source: event.source || { platform: "web" },
    }));
    void runSpeechQueue(generation);
  }

  async function start() {
    try {
      character = await desktop?.getCompanionCharacter?.(petId);
      voiceServiceConfigured = character?.voiceService?.configured === true;
      voiceEnabled = voiceServiceConfigured && character?.voiceEnabled === true;
    } catch {
      character = null;
      voiceServiceConfigured = false;
      voiceEnabled = false;
    }
    updateVoiceButton();
    if (!desktop?.synthesizeCompanionSpeech && voiceButton) voiceButton.hidden = true;
    desktop?.onCompanionVoiceChanged?.((enabled) => {
      voiceEnabled = enabled;
      if (!enabled) cancelSpeech(true);
      updateVoiceButton();
    });

    const live2dConfig = character?.manifest?.visual?.live2d;
    if (live2dConfig?.enabled === true) {
      host.dataset.propStyle = String(live2dConfig.propStyle || "none").replace(/[^a-z0-9_-]/gi, "");
      const renderedWidth = Number(live2dConfig.renderedWidth) || 150;
      const renderedHeight = Number(live2dConfig.renderedHeight) || 188;
      // Pixi reads canvas.clientWidth/clientHeight while constructing its renderer. Establish
      // the final footprint first; resizing the DOM only after WebGL initialisation leaves the
      // real high-DPI desktop window clipped even though a fixed-size smoke page looks healthy.
      stage.style.width = `${renderedWidth}px`;
      stage.style.height = `${renderedHeight}px`;
      document.documentElement.style.setProperty("--pet-stage-height", `${renderedHeight}px`);
      live2dCanvas.hidden = false;
    }

    if (character && window.HarbourLive2D?.createHost) {
      try {
        live2dHost = await window.HarbourLive2D.createHost({
          canvas: live2dCanvas,
          manifest: character.manifest,
          assetBase: character.assetBase,
        });
        host.dataset.live2d = live2dHost.ready ? "ready" : "fallback";
        host.dataset.live2dReason = live2dHost.reason || "";
      } catch (error) {
        live2dCanvas.hidden = true;
        host.dataset.live2d = "fallback";
        console.warn("[Harbour Pet] Live2D unavailable; trying this character's pixel assets", error);
      }
    }

    let manifest = null;
    try {
      const response = await fetch(webAssetUrl(`assets/pets/${encodeURIComponent(petId)}/pet.json`));
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      manifest = await response.json();
      if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) throw new Error("桌宠图集清单无效");
    } catch {
      if (!live2dHost?.ready) {
        showVisualUnavailable("尚未安装桌宠外观");
        return;
      }
    }

    let assetVersion = 1;
    if (live2dHost?.ready) {
      sprite.hidden = true;
      live2dCanvas.hidden = false;
      live2dHost.resize();
    } else if (manifest) {
      const cellWidth = Number(manifest.cellWidth) || 192;
      const cellHeight = Number(manifest.cellHeight) || 208;
      const columns = Number(manifest.columns) || 8;
      const rows = Number(manifest.rows) || (Number(manifest.spriteVersionNumber) >= 2 ? 11 : 9);
      // Codex 当前 overlay 的默认 petSize 是 112px；高度严格按 192:208 比例计算。
      const renderedWidth = Number(manifest.renderedCellWidth) || 112;
      const renderedHeight = Number(manifest.renderedCellHeight) || renderedWidth * cellHeight / cellWidth;
      assetVersion = Number(manifest.spriteVersionNumber) || 1;
      const assetPath = `${webAssetUrl(`assets/pets/${encodeURIComponent(petId)}/${encodeURIComponent(manifest.spritesheetPath || "spritesheet.webp")}`)}?v=${assetVersion}`;
      await loadPixelImage(assetPath);
      document.documentElement.style.setProperty("--pet-sheet", `url("${assetPath}")`);
      document.documentElement.style.setProperty("--pet-sheet-width", `${columns * 100}%`);
      document.documentElement.style.setProperty("--pet-sheet-height", `${rows * 100}%`);
      sprite.style.width = `${renderedWidth}px`;
      sprite.style.height = `${renderedHeight}px`;
      stage.style.width = `${renderedWidth}px`;
      stage.style.height = `${renderedHeight}px`;
      document.documentElement.style.setProperty("--pet-stage-height", `${renderedHeight}px`);
      sprite.hidden = false;
      animator = window.HarbourPetCore.createAnimator({
        sprite,
        stateText,
        sourceText,
        activeTarget: host,
        agentName,
        columns,
        rows,
        spriteVersionNumber: assetVersion,
      });
    }

    const resolvedName = character?.manifest?.displayName || manifest?.displayName || displayName;
    setPetIdentity(resolvedName);
    host.dataset.visualStatus = "ready";
    if (placeholder) placeholder.hidden = true;

    // Electron 的原生 drag region 负责窗口跟手；主进程只把方向回传给动画层。
    desktop?.onPetDragDirection?.((direction) => {
      const wasDragging = dragDirection === "left" || dragDirection === "right";
      animator?.setHover(false);
      animator?.setMovement(direction);
      dragDirection = direction === "left" || direction === "right" ? direction : null;
      if (wasDragging && !dragDirection) void live2dHost?.resetPose?.();
      renderActivity();
    });
    if (assetVersion >= 2) {
      desktop?.onPetCursor?.((point) => animator?.lookAt(stage.getBoundingClientRect(), point));
      if (!desktop?.onPetCursor) {
        document.addEventListener("pointermove", (event) => animator?.lookAt(stage.getBoundingClientRect(), event));
      }
    }
    if (live2dHost?.ready) desktop?.onPetCursor?.((point) => live2dHost.lookAt(point));
    scheduleInputRegionSync();
    renderActivity();
    if (desktop?.usesSharedCompanionBridge) {
      removeCompanionEventListener = desktop.onCompanionEvent?.(consumeServerMessage) || null;
      removeCompanionStateListener = desktop.onCompanionState?.(applyCompanionState) || null;
      desktop.getCompanionState?.().then(applyCompanionState).catch(() => {});
      loadPendingAsks();
    } else {
      connect();
    }
  }

  stage.addEventListener("dblclick", (event) => {
    void runPetInteraction({ x: event.clientX, y: event.clientY });
    desktop?.openDashboard();
  });
  interactionZone?.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    void runPetInteraction({ x: event.clientX, y: event.clientY });
  });
  interactionZone?.addEventListener("dblclick", (event) => event.stopPropagation());
  activity.addEventListener("dblclick", () => desktop?.openDashboard());
  petSpeechDismiss?.addEventListener("click", (event) => {
    event.stopPropagation();
    hideBubble(true);
  });
  petSpeechOpen?.addEventListener("click", async (event) => {
    event.stopPropagation();
    const bubble = visibleBubble;
    if (!bubble?.sessionId || !desktop?.openConversation) return;
    try {
      const opened = await desktop.openConversation({ sessionId: bubble.sessionId, agentName: bubble.agentName || agentName });
      if (!opened && visibleBubble?.id === bubble.id) petSpeechSource.textContent = "暂时无法打开";
    } catch {
      if (visibleBubble?.id === bubble.id) petSpeechSource.textContent = "连接失败，请重试";
    }
  });
  taskList.addEventListener("click", (event) => {
    const button = event.target.closest("[data-dismiss-task]");
    if (!button) return;
    event.stopPropagation();
    const id = button.dataset.dismissTask;
    clearTimeout(cleanupTimers.get(id));
    cleanupTimers.delete(id);
    activities.delete(id);
    renderActivity();
  });
  document.getElementById("petOpen").addEventListener("click", () => desktop?.openDashboard());
  document.getElementById("petHide").addEventListener("click", () => desktop?.hidePet(petId));
  interactButton?.addEventListener("click", () => {
    void runPetInteraction();
  });
  voiceButton?.addEventListener("click", async () => {
    if (!desktop?.setCompanionVoice) return;
    try {
      if (!voiceServiceConfigured) {
        character = await desktop?.getCompanionCharacter?.(petId);
        voiceServiceConfigured = character?.voiceService?.configured === true;
        if (!voiceServiceConfigured) {
          sourceText.textContent = character?.voiceService?.error || "Harbour 后端尚未配置语音服务";
          updateVoiceButton();
          return;
        }
      }
      voiceEnabled = await desktop.setCompanionVoice(!voiceEnabled, petId);
      if (!voiceEnabled) cancelSpeech(true);
      updateVoiceButton();
    } catch (error) {
      sourceText.textContent = error instanceof Error ? error.message : "无法切换角色语音";
    }
  });
  voiceButton?.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    desktop?.openCompanionFolder?.(petId);
  });
  window.addEventListener("beforeunload", () => {
    regionObserver.disconnect();
    regionMutationObserver.disconnect();
    cancelAnimationFrame(inputRegionFrame);
    cancelSpeech(false);
    removeCompanionEventListener?.();
    removeCompanionStateListener?.();
    musicControls?.dispose();
    socket?.close();
    clearTimeout(interactionFeedbackTimer);
    clearTimeout(bubbleTimer);
    for (const timer of cleanupTimers.values()) clearTimeout(timer);
    live2dHost?.destroy();
    animator?.destroy();
  });
  // Input and closing must work before any async character/model/asset operation. The
  // Electron window starts click-through; delaying this until success strands failed pets.
  setPetIdentity(displayName);
  host.dataset.visualStatus = "loading";
  stage.style.width = "132px";
  if (placeholder) placeholder.hidden = false;
  const regionObserver = new ResizeObserver(scheduleInputRegionSync);
  regionObserver.observe(host);
  regionObserver.observe(stage);
  regionObserver.observe(activity);
  regionObserver.observe(petSpeech);
  const regionMutationObserver = new MutationObserver(scheduleInputRegionSync);
  regionMutationObserver.observe(activity, { attributes: true, childList: true, subtree: true });
  regionMutationObserver.observe(petSpeech, { attributes: true, childList: true, subtree: true });
  syncInputRegions();
  start().catch((error) => {
    console.warn("[Harbour Pet] visual startup failed", error);
    showVisualUnavailable();
  });
})();
