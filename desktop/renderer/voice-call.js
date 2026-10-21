(() => {
  const desktop = window.harbourDesktop;
  const recordButton = document.getElementById("record");
  const stopButton = document.getElementById("stop");
  const status = document.getElementById("status");
  const transcript = document.getElementById("transcript");
  const agentSelect = document.getElementById("agent");
  const connection = document.getElementById("connection");
  const portraitGlyph = document.getElementById("portraitGlyph");
  const voicePicker = new window.HarbourVoicePicker({ host: document.getElementById("callVoicePicker"),
    getCompanionId: () => agentSelect.value.replace(/^main-/, ""),
    request: (action, payload, signal) => {
      if (!desktop.voiceChoice) return Promise.reject(new Error("请重启桌面客户端以加载音色选择"));
      const cancel = () => { void desktop.voiceChoice({ action: "cancel" }).catch(() => {}); };
      signal?.addEventListener("abort", cancel, { once: true });
      return desktop.voiceChoice({ action, ...payload }).finally(() => signal?.removeEventListener("abort", cancel));
    } });
  let recording = null;
  let activeRun = null;

  async function api(pathname, options = {}) {
    if (typeof desktop.voiceRequest !== "function") throw new Error("请重启桌面客户端以加载安全语音连接");
    return desktop.voiceRequest(pathname, options.body || "{}");
  }
  function dataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error || new Error("读取录音失败"));
      reader.readAsDataURL(blob);
    });
  }
  function addTurn(role, text) {
    transcript.querySelector(".empty")?.remove();
    const row = document.createElement("div");
    row.className = `turn ${role}`;
    const label = document.createElement("small");
    label.textContent = role === "user" ? "你" : agentSelect.value === "main-elaina" ? "Elaina" : "Aemeath";
    const content = document.createElement("p");
    content.textContent = text;
    row.append(label, content);
    transcript.appendChild(row);
    transcript.scrollTop = transcript.scrollHeight;
  }
  function setRecording(active) {
    document.body.classList.toggle("is-recording", active);
    recordButton.setAttribute("aria-pressed", String(active));
    recordButton.querySelector("b").textContent = active ? "结束并发送" : "开始说话";
  }
  async function sendRecording(blob, durationMs) {
    status.textContent = "正在上传并转写…";
    const mediaType = blob.type || "audio/webm";
    const extension = mediaType.includes("ogg") ? "ogg" : mediaType.includes("mp4") ? "m4a" : "webm";
    const upload = await api("/api/upload", {
      method: "POST",
      body: JSON.stringify({ name: `voice-${Date.now()}.${extension}`, mime: mediaType, kind: "audio", durationMs, dataBase64: await dataUrl(blob) }),
    });
    const stt = await api("/api/stt/transcribe", { method: "POST", body: JSON.stringify({ attachment: upload.attachment }) });
    const text = String(stt.text || "").trim();
    if (!text) throw new Error("语音转写为空，请重试");
    addTurn("user", text);
    status.textContent = `${stt.provider || "STT"} 已听懂 · 正在回答…`;
    const runId = `call-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    activeRun = { runId };
    stopButton.hidden = false;
    const result = await api("/api/run", {
      method: "POST",
      body: JSON.stringify({
        runId,
        agent: agentSelect.value,
        input: text,
        session: { key: `electron:call:${agentSelect.value}`, channel: "web" },
        attachments: [upload.attachment],
        sttPrepared: [upload.attachment.url],
      }),
    });
    addTurn("assistant", result.answer || "（没有文字回答）");
    status.textContent = "回答完成 · 可以继续说话";
  }
  async function toggleRecording() {
    if (recording) { recording.recorder.stop(); return; }
    if (activeRun) return;
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      status.textContent = "当前系统不支持麦克风录音";
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const chunks = [];
      const recorder = new MediaRecorder(stream);
      const startedAt = Date.now();
      recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
      recorder.onstop = async () => {
        stream.getTracks().forEach((track) => track.stop());
        recording = null;
        setRecording(false);
        try {
          await sendRecording(new Blob(chunks, { type: recorder.mimeType || "audio/webm" }), Math.max(1, Date.now() - startedAt));
        } catch (error) {
          status.textContent = activeRun?.stopping ? "已请求停止 · 请在原会话核对进度" : `通话失败：${error.message || error}`;
        } finally {
          activeRun = null;
          stopButton.hidden = true;
        }
      };
      recorder.start();
      recording = { recorder, stream };
      setRecording(true);
      status.textContent = "正在听你说话…";
    } catch (error) {
      status.textContent = `无法使用麦克风：${error.message || error}`;
    }
  }
  async function stopAnswer() {
    if (!activeRun) return;
    const { runId } = activeRun;
    activeRun.stopping = true;
    status.textContent = "正在停止并保存进度…";
    try { await api(`/api/runs/${encodeURIComponent(runId)}/abort`, { method: "POST", body: "{}" }); }
    catch { desktop.cancelVoiceRequests?.(); }
  }

  recordButton.addEventListener("click", toggleRecording);
  stopButton.addEventListener("click", stopAnswer);
  agentSelect.addEventListener("change", () => { portraitGlyph.textContent = agentSelect.value === "main-elaina" ? "E" : "A"; voicePicker.sync(); });
  desktop.onCompanionState?.((state) => {
    connection.textContent = state?.connection === "open" ? "Harbour 在线" : "正在重连";
    if (state?.appearance) window.HarbourAppearance.apply(state.appearance);
  });
  desktop.getCompanionState?.().then((state) => {
    connection.textContent = state?.connection === "open" ? "Harbour 在线" : "正在连接";
    if (state?.appearance) window.HarbourAppearance.apply(state.appearance);
  }).catch(() => { connection.textContent = "Harbour 离线"; });
  window.addEventListener("beforeunload", () => {
    voicePicker.destroy();
    recording?.stream?.getTracks().forEach((track) => track.stop());
    desktop.cancelVoiceRequests?.();
  });
})();
