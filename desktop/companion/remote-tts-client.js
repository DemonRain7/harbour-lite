class RemoteTtsClient {
  constructor({ baseUrl, token = "", logger = console, timeoutMs = 120_000, maxAudioBytes = 25 * 1024 * 1024 }) {
    this.baseUrl = String(baseUrl || "http://localhost:7788").replace(/\/+$/, "");
    this.token = String(token || "");
    this.logger = logger;
    this.timeoutMs = timeoutMs;
    this.maxAudioBytes = maxAudioBytes;
    this.abortControllers = new Map();
  }

  endpoint(pathname) {
    return `${this.baseUrl}/${String(pathname).replace(/^\/+/, "")}`;
  }

  headers(json = false) {
    return {
      ...(json ? { "Content-Type": "application/json" } : {}),
      ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
    };
  }

  async status(requestId) {
    const controller = new AbortController();
    const id = String(requestId || "");
    if (id) {
      this.cancel(id);
      this.abortControllers.set(id, controller);
    }
    const timer = setTimeout(() => controller.abort(), Math.min(this.timeoutMs, 8_000));
    try {
      const response = await fetch(this.endpoint("api/companion/tts/status"), {
        headers: this.headers(),
        signal: controller.signal,
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) return { configured: false, mode: "remote", provider: null, error: body.error || `HTTP ${response.status}` };
      return body;
    } catch (error) {
      return {
        configured: false,
        mode: "remote",
        provider: null,
        error: controller.signal.aborted ? "Harbour TTS 状态检查超时" : error.message,
      };
    } finally {
      clearTimeout(timer);
      if (id && this.abortControllers.get(id) === controller) this.abortControllers.delete(id);
    }
  }

  async voiceChoice(surface, input) {
    if (!["orb", "call"].includes(surface)) throw new Error("无效的音色入口");
    const { action, companionId, voiceId } = input || {};
    const requestId = `voice-preview:${surface}`;
    if (action === "cancel") return this.cancel(requestId);
    if (!["list", "select", "preview"].includes(action)) throw new Error("无效的音色操作");
    if (action !== "list" && (!/^[a-z0-9_-]{1,48}$/.test(companionId || "")
      || !/^(auto|tencent:\d{6}|(?:primary|custom):[a-z0-9_-]{1,48})$/.test(voiceId || ""))) throw new Error("无效的角色或音色");
    if (action === "preview") return this.synthesize(requestId, { characterId: companionId, voiceId, text: "今天也一起出发吧。" }, true);
    const response = await fetch(this.endpoint(action === "list" ? "api/tts/voices" : "api/tts/selection"), {
      method: action === "list" ? "GET" : "POST", headers: this.headers(action === "select"),
      ...(action === "select" ? { body: JSON.stringify({ companionId, voiceId }) } : {}),
      redirect: "error", signal: AbortSignal.timeout(8000),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || `音色接口 HTTP ${response.status}`);
    return body;
  }

  async synthesize(requestId, payload, preview = false) {
    const id = String(requestId || "");
    if (!id) throw new Error("missing TTS request id");
    const controller = new AbortController();
    this.cancel(id);
    this.abortControllers.set(id, controller);
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await fetch(this.endpoint(preview ? "api/tts/test" : "api/companion/tts"), {
        method: "POST",
        redirect: "error",
        headers: this.headers(true),
        body: JSON.stringify({
          companionId: payload.characterId,
          text: payload.text,
          emotion: payload.emotion || "neutral",
          ...(preview ? { voiceId: payload.voiceId } : {}),
        }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || `Harbour TTS HTTP ${response.status}`);
      }
      const announced = Number(response.headers.get("content-length") || 0);
      if (announced > this.maxAudioBytes) throw new Error("语音响应超过大小上限");
      const buffer = Buffer.from(await response.arrayBuffer());
      if (!buffer.byteLength) throw new Error("Harbour TTS 返回了空音频");
      if (buffer.byteLength > this.maxAudioBytes) throw new Error("语音响应超过大小上限");
      return {
        mime: response.headers.get("content-type") || "audio/wav",
        data: buffer.toString("base64"),
        provider: response.headers.get("x-harbour-tts-provider") || "remote",
        voiceId: response.headers.get("x-harbour-tts-voice") || "auto",
      };
    } catch (error) {
      if (controller.signal.aborted) throw new Error("语音请求已取消或超时");
      throw error;
    } finally {
      clearTimeout(timer);
      if (this.abortControllers.get(id) === controller) this.abortControllers.delete(id);
    }
  }

  cancel(requestId) {
    const controller = this.abortControllers.get(String(requestId || ""));
    if (!controller) return false;
    controller.abort();
    this.abortControllers.delete(String(requestId || ""));
    return true;
  }

  cancelPrefix(prefix) {
    const value = String(prefix || "");
    if (!value) return 0;
    let cancelled = 0;
    for (const [requestId, controller] of this.abortControllers) {
      if (!requestId.startsWith(value)) continue;
      controller.abort();
      this.abortControllers.delete(requestId);
      cancelled += 1;
    }
    return cancelled;
  }

  cancelAll() {
    for (const controller of this.abortControllers.values()) controller.abort();
    this.abortControllers.clear();
  }

  stop() {
    this.cancelAll();
  }
}

module.exports = { RemoteTtsClient };
