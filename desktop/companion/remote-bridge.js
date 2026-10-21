const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const WebSocket = require("ws");

function socketUrl(baseUrl, token) {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/ws`.replace(/\/+/g, "/");
  url.search = token ? `?token=${encodeURIComponent(token)}` : "";
  url.hash = "";
  return url.toString();
}

class RemoteCompanionBridge {
  constructor({ baseUrl, token, dataDir, label = "Harbour Desktop", logger = console, onEvent, onConnection, onCommand }) {
    this.url = socketUrl(baseUrl, token);
    this.label = label;
    this.logger = logger;
    this.onEvent = onEvent;
    this.onConnection = onConnection;
    this.onCommand = onCommand;
    this.socket = null;
    this.closed = false;
    this.retryTimer = null;
    this.retryCount = 0;
    this.musicState = null;
    this.coworkExecutor = null;
    this.clientId = this.loadClientId(dataDir);
  }

  loadClientId(dataDir) {
    const file = path.join(dataDir, "desktop-client-id.txt");
    try {
      const existing = fs.readFileSync(file, "utf8").trim();
      if (/^[a-z0-9-]{8,100}$/i.test(existing)) return existing;
    } catch { /* first run */ }
    const id = `desktop-${randomUUID()}`;
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(file, `${id}\n`, { encoding: "utf8", mode: 0o600 });
    } catch { /* a transient read-only userData still gets an in-memory identity */ }
    return id;
  }

  start() {
    this.closed = false;
    this.connect();
  }

  connect() {
    if (this.closed || this.socket?.readyState === WebSocket.CONNECTING || this.socket?.readyState === WebSocket.OPEN) return;
    const socket = new WebSocket(this.url, { handshakeTimeout: 8_000 });
    this.socket = socket;
    this.onConnection?.("connecting");
    socket.on("open", () => {
      if (this.socket !== socket) return;
      this.retryCount = 0;
      this.onConnection?.("open");
      this.send({
        __harbour: "desktop:hello",
        version: 1,
        clientId: this.clientId,
        label: this.label,
        capabilities: ["companion", "music", "stickers", "appearance"],
      });
      if (this.musicState) this.send({ __harbour: "desktop:state", capability: "music", state: this.musicState });
      if (this.coworkExecutor) this.send(this.coworkExecutor.hello());
    });
    socket.on("message", (data) => {
      let event;
      try { event = JSON.parse(Buffer.from(data).toString("utf8")); } catch { return; }
      if (typeof event?.__harbour === "string" && event.__harbour.startsWith("cowork:")) {
        void this.coworkExecutor?.handleEnvelope(event);
        return;
      }
      if (event?.__harbour === "companion:command") {
        void this.executeCommand(socket, event);
        return;
      }
      this.onEvent?.(event);
    });
    socket.on("error", (error) => {
      if (this.socket === socket) this.logger.warn?.(`[harbour-desktop] companion WS: ${error.message}`);
    });
    socket.on("close", () => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.onConnection?.("closed");
      this.scheduleReconnect();
    });
  }

  async executeCommand(socket, envelope) {
    const commandId = String(envelope.commandId || "").slice(0, 100);
    if (!commandId || envelope.capability !== "music") return;
    try {
      const result = await this.onCommand?.(envelope.capability, envelope.command || {});
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({ __harbour: "desktop:command-result", commandId, ok: true, result }));
      }
    } catch (error) {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify({
          __harbour: "desktop:command-result",
          commandId,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }));
      }
    }
  }

  scheduleReconnect() {
    if (this.closed || this.retryTimer) return;
    const delay = Math.min(15_000, 800 * 2 ** Math.min(this.retryCount++, 5));
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.connect();
    }, delay);
    this.retryTimer.unref?.();
  }

  send(payload) {
    if (this.socket?.readyState !== WebSocket.OPEN) return false;
    try { this.socket.send(JSON.stringify(payload)); return true; } catch { return false; }
  }

  updateMusicState(state) {
    this.musicState = { ...(this.musicState || {}), ...(state || {}) };
    this.send({ __harbour: "desktop:state", capability: "music", state });
  }

  setCoworkExecutor(executor) {
    this.coworkExecutor = executor;
    if (executor) {
      executor.send = (payload) => this.send(payload);
      if (this.socket?.readyState === WebSocket.OPEN) this.send(executor.hello());
    }
  }

  stop() {
    this.closed = true;
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    const socket = this.socket;
    this.socket = null;
    try { socket?.close(1000, "desktop shutdown"); } catch { /* ignore */ }
  }
}

module.exports = { RemoteCompanionBridge, socketUrl };
