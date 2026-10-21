"use strict";

const http = require("node:http");
const https = require("node:https");
const { randomUUID, createHash } = require("node:crypto");
const { MAX_DRAFT_BYTES, MAX_FILES, uploadPayload, publicAttachment } = require("./orb-attachments");
const { OrbFeedback } = require("./orb-feedback");
const { projectMessage, rasterMime } = require("./orb-messages");
const { OrbSessionSync } = require("./orb-session-sync");
const { sessionContext } = require("./orb-context");
const { revision, validReceipt, rememberReceipt } = require("./orb-read-state");

// This client calls existing Harbour APIs. It owns no model, tools or credentials store.
class OrbChat {
  constructor({ getConfig, deviceId, agents, onChange = () => {}, onRead = () => {}, timeoutMs = 20 * 60_000 }) {
    Object.assign(this, { getConfig, agents, onChange, onRead, timeoutMs });
    this.deviceId = createHash("sha256").update(deviceId).digest("hex").slice(0, 16);
    this.rows = new Map(); this.requests = new Set(); this.imageRequests = new Map(); this.disposed = false;
    this.readReplies = new Map(); this.readRequests = new Map();
    this.sync = new OrbSessionSync(this);
  }
  row(agent) {
    if (!this.agents.some(item => item.agentName === agent)) throw new Error("请选择已登记的 Main 角色");
    if (!this.rows.has(agent)) this.rows.set(agent, { agent, key: `web:default:${agent}`, channel: "web", readOnly: false,
      title: "", source: null, summary: "",
      sessionId: null, messages: [], runId: null, localRunId: null, external: null, messageCount: 0, phase: "idle", detail: "", asks: [], loaded: false,
      staged: new Map(), images: new Map(), uploading: 0, reservedBytes: 0, config: {}, replyReadyAt: 0, feedback: new OrbFeedback() });
    return this.rows.get(agent);
  }
  historyRevision(row) {
    // Messages are replaced on sync and appended on send; progress only changes
    // metadata. Do not walk/clone the entire conversation for every tool event.
    const previous = row.historyStamp;
    if (!previous || previous.messages !== row.messages || previous.length !== row.messages.length
      || previous.last !== row.messages.at(-1) || previous.sessionId !== row.sessionId || previous.summary !== row.summary) {
      const lastMessageKey = JSON.stringify(row.messages.at(-1));
      row.historyStamp = { messages: row.messages, length: row.messages.length, last: row.messages.at(-1),
        sessionId: row.sessionId, summary: row.summary, revision: (previous?.revision || 0) + 1, lastMessageKey,
        lastMessageRevision: (previous?.lastMessageRevision || 0) + Number(lastMessageKey !== previous?.lastMessageKey) };
      const active = new Set(row.messages.flatMap(m => (m.parts || []).filter(p => p.type === "image").map(p => p.id)));
      for (const id of row.images.keys()) if (!active.has(id)) row.images.delete(id);
    }
    return row.historyStamp.revision;
  }
  noticeKey(row) {
    this.historyRevision(row);
    return JSON.stringify([row.sessionId, row.replyRevision, row.historyStamp.lastMessageRevision, row.messages.length, row.phase, row.feedback.snapshot()]);
  }
  notificationRead(row) {
    const known = this.readReplies.get(row.sessionId);
    return row.readNoticeKey === this.noticeKey(row)
      || (known?.replyRevision > 0 && known.readReplyRevision === known.replyRevision && known.replyRunId === row.feedback.runId)
      || (row.replyRevision > 0 && (known?.readReplyRevision || 0) >= row.replyRevision
      && (!row.feedback.runId || row.replyRunId === row.feedback.runId));
  }
  acceptReplyState(row, session, runId) {
    row.replyRevision = revision(session?.replyRevision) ? session.replyRevision : null;
    row.replyRunId = runId || null;
    rememberReceipt(this.readReplies, session);
  }
  snapshot(agent, { includeHistory = true } = {}) {
    const row = this.row(agent);
    const historyRevision = this.historyRevision(row);
    return structuredClone({ agent, sessionId: row.sessionId, historyRevision, lastMessageRevision: row.historyStamp.lastMessageRevision,
      lastMessageRole: row.messages.at(-1)?.role || "",
      replyRevision: row.replyRevision, readReplyRevision: revision(row.replyRevision)
        ? Math.min(row.replyRevision, this.readReplies.get(row.sessionId)?.readReplyRevision || 0) : null,
      notificationRead: this.notificationRead(row), noticeKey: this.noticeKey(row),
      ...(includeHistory ? { messages: row.messages, summary: row.summary } : {}),
      runId: row.runId, phase: row.phase, detail: row.detail, asks: row.asks, preparing: !!row.preparing,
      loading: !!row.loading || !!row.changing || !!row.syncing, canStop: !!row.localRunId && row.localRunId === row.runId,
      config: row.config, context: row.context || null, modelLabel: row.modelLabels?.[row.config.modelRef || row.context?.modelRef || row.defaultModelRef] || "",
      title: row.title, source: row.source, readOnly: row.readOnly,
      syncError: row.syncError || "", replyReadyAt: row.replyReadyAt, failure: row.feedback.snapshot(),
      inputSending: !!row.inputSending, inputNotice: row.inputNotice || "" });
  }
  changed(row) {
    this.onChange(this.snapshot(row.agent, { includeHistory: false }));
  }
  message(row, value) {
    const serverUrl = this.getConfig().url;
    return projectMessage(value, serverUrl, pathname => {
      const id = createHash("sha256").update(JSON.stringify([row.agent, row.sessionId, serverUrl, pathname])).digest("hex");
      row.images.set(id, { pathname, serverUrl });
      return id;
    });
  }
  async image(agent, id) {
    const row = this.row(agent), media = row.images.get(id), sessionId = row.sessionId;
    if (this.disposed || !media || media.serverUrl !== this.getConfig().url) throw new Error("图片已不属于当前会话，请重新打开会话");
    if (!this.imageRequests.has(id)) {
      if (this.imageRequests.size >= 4) throw new Error("图片加载较多，请稍后重试");
      const request = this.request(media.pathname, undefined, 15_000, "GET", "image");
      this.imageRequests.set(id, request);
      request.finally(() => this.imageRequests.delete(id)).catch(() => {});
    }
    const value = await this.imageRequests.get(id);
    if (row.sessionId !== sessionId || !row.images.has(id) || media.serverUrl !== this.getConfig().url) throw new Error("会话已切换，已丢弃旧图片");
    return value;
  }

  request(pathname, body, timeoutMs = 12_000, method, responseKind = "json") {
    if (this.disposed) return Promise.reject(new Error("悬浮助手已退出"));
    const config = this.getConfig(), base = new URL(config.url);
    if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw new Error("Harbour 地址无效");
    const target = new URL(pathname.replace(/^\//, ""), `${base.href.replace(/\/+$/, "")}/`);
    const token = String(config.token || ""), payload = body === undefined ? null : JSON.stringify(body);
    return new Promise((resolve, reject) => {
      let done = false, timer;
      const finish = (err, value) => {
        if (done) return; done = true; clearTimeout(timer); this.requests.delete(req);
        err ? reject(err) : resolve(value);
      };
      const req = (base.protocol === "https:" ? https : http).request(target, { method: method || (payload === null ? "GET" : "POST"), headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(payload !== null ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
      } }, res => {
        const chunks = []; let size = 0;
        const picture = responseKind === "image", limit = (picture ? 16 : 4) * 1024 * 1024;
        if (picture && (res.statusCode !== 200 || !/^image\/(?:png|jpeg|gif|webp|bmp|avif)(?:;|$)/i.test(res.headers["content-type"] || ""))) {
          finish(new Error(res.statusCode === 401 ? "图片鉴权失败，请检查客户端连接配置"
            : res.statusCode === 404 || res.statusCode === 410 ? "图片已过期或不存在" : "图片暂时无法加载"));
          res.destroy(); return;
        }
        if (picture && Number(res.headers["content-length"]) > limit) {
          finish(new Error("图片超过 16 MB，请在完整会话查看")); res.destroy(); return;
        }
        res.on("data", chunk => {
          size += chunk.length;
          if (size > limit) { finish(new Error(picture ? "图片超过 16 MB，请在完整会话查看" : "会话较长，请在完整窗口查看；未重试")); req.destroy(); }
          else chunks.push(chunk);
        });
        res.on("end", () => {
          if (done) return;
          try {
            if (picture) {
              const bytes = Buffer.concat(chunks), mime = rasterMime(bytes);
              if (!mime) throw new Error("图片格式无效，请在完整会话查看");
              finish(null, { bytes, mime }); return;
            }
            const value = JSON.parse(Buffer.concat(chunks).toString("utf8"), (_key, value) =>
              token && typeof value === "string" ? value.split(token).join("[redacted]") : value);
            if (res.statusCode < 200 || res.statusCode >= 300) {
              const error = new Error(res.statusCode === 401 ? "Harbour 鉴权失败，请检查客户端连接配置" : `Harbour 返回 HTTP ${res.statusCode}；请核对原会话`);
              error.status = res.statusCode; error.result = value; throw error;
            }
            finish(null, value);
          } catch (error) { finish(error instanceof SyntaxError ? new Error("Harbour 响应无效；未重试") : error); }
        });
        res.on("error", () => finish(new Error("连接中断；请核对原会话，未自动重发")));
      });
      this.requests.add(req);
      req.on("error", () => finish(new Error("无法连接 Harbour；未自动重发")));
      timer = setTimeout(() => { finish(new Error("等待超时；请核对原会话，未自动重发")); req.destroy(); }, timeoutMs);
      req.end(payload);
    });
  }

  assertSession(row, session, adopt = false) {
    if (!session || session.agentName !== row.agent || typeof session.key !== "string" || !session.key
      || typeof session.channel !== "string" || !session.channel
      || (!adopt && (session.key !== row.key || session.channel !== row.channel))) throw new Error("会话归属不匹配，已停止读取");
    return session;
  }
  readOnly(session) {
    // Cowork must retain its explicit execution device; never silently run it
    // on the server through this smaller composer. Channels stay mirrors.
    return !!session && (session.channel !== "web" || !!session.readOnlyMirror
      || session.key.startsWith("web:cowork:") || !!session.cowork && session.cowork.deviceId !== "server");
  }
  assertWritable(row) {
    if (row.readOnly) throw new Error("这段对话在悬浮助手中只读，请在原渠道或完整会话继续，也可以新建 Web 对话");
  }
  readSession(id) {
    // The backend keeps its complete retained chat history; traces/checkpoints
    // are not needed for small-window reading and can dwarf the actual messages.
    return this.request(`/api/conversations/${encodeURIComponent(id)}?view=chat`);
  }
  acceptSession(row, session, adopt = false) {
    if (session) this.assertSession(row, session, adopt);
    if (row.sessionId !== (session?.id || null)) {
      row.replyReadyAt = 0; row.feedback.reset(); row.external = null; row.runId = null; row.progressTime = 0; row.syncError = "";
      row.inputNotice = "";
    }
    row.sessionId = session?.id || null;
    row.key = session?.key || `web:default:${row.agent}`; row.channel = session?.channel || "web";
    row.readOnly = this.readOnly(session); row.title = session?.title || "新对话";
    row.source = sessionSource(session); row.summary = typeof session?.summary === "string" ? session.summary : "";
    row.messages = (session?.messages || []).filter(m => ["user", "assistant"].includes(m.role))
      .map(m => this.message(row, m));
    const lastReply = session?.messages?.filter(m => m.role === "assistant").at(-1);
    this.acceptReplyState(row, session, lastReply?.runRecord?.attemptId || lastReply?.fileChangeRunId);
    row.config = Object.fromEntries(["modelRef", "permissionMode", "reasoningEffort"].map(k => [k, session?.[k] || ""]));
    row.context = sessionContext(session);
    row.messageCount = session?.messages?.length || 0; row.loaded = true;
    this.sync.bind(row);
  }
  async markRead(agent, input) {
    const row = this.row(agent), sessionId = row.sessionId, serverUrl = this.getConfig().url;
    if (!sessionId || input.sessionId !== sessionId || input.historyRevision !== this.historyRevision(row)
      || input.replyRevision !== row.replyRevision || input.noticeKey !== this.noticeKey(row)
      || row.loading || row.changing || row.syncing || row.runId || row.preparing
      || row.messages.at(-1)?.role !== "assistant") return false;
    const { replyRevision } = row;
    const key = JSON.stringify([serverUrl, sessionId, replyRevision]);
    let receipt;
    if (revision(replyRevision) && replyRevision > 0) {
      const known = this.readReplies.get(sessionId);
      if ((known?.readReplyRevision || 0) >= replyRevision) receipt = { id: sessionId, ...known };
      else {
        if (!this.readRequests.has(key)) {
          const request = this.request(`/api/conversations/${encodeURIComponent(sessionId)}/read`, { key: row.key, replyRevision });
          this.readRequests.set(key, request);
          request.finally(() => this.readRequests.delete(key)).catch(() => {});
        }
        receipt = await this.readRequests.get(key);
        if (!validReceipt(receipt) || receipt.id !== sessionId || receipt.readReplyRevision < replyRevision)
          throw new Error("已读回执无效，提醒已保留");
      }
    }
    if (this.disposed || this.getConfig().url !== serverUrl) return false;
    if (receipt) {
      rememberReceipt(this.readReplies, receipt);
      this.onRead({ __harbour: "session-read", ...receipt });
    }
    // A late receipt can acknowledge its old revision, but not a newer view,
    // persona, failure or reply that arrived while the request was in flight.
    if (row.sessionId === sessionId && this.historyRevision(row) === input.historyRevision && this.noticeKey(row) === input.noticeKey) {
      row.readNoticeKey = input.noticeKey;
      if (!receipt && !revision(replyRevision)) this.onRead({ __harbour: "orb-legacy-read", agent, sessionId, historyRevision: input.historyRevision });
      this.changed(row);
    }
    return true;
  }
  assertIdle(row) {
    if (row.inputRequest) throw new Error("上条补充的回执尚未确认，请先用原文重试核对，或打开完整会话查看");
    if (row.runId || row.preparing || row.loading || row.changing || row.syncing || row.inputSending) throw new Error("这位角色正在处理任务或切换会话，请稍候");
  }
  async upload(agent, input) {
    const row = this.row(agent);
    this.assertWritable(row);
    if (row.uploading >= 2 || row.staged.size + row.uploading >= MAX_FILES) throw new Error("每条消息最多 10 个附件，请等待当前上传完成");
    const { payload, size } = uploadPayload(input);
    const total = [...row.staged.values()].reduce((sum, file) => sum + file.size, 0);
    if (total + row.reservedBytes + size > MAX_DRAFT_BYTES) throw new Error("附件总大小超过 64 MB");
    row.uploading++; row.reservedBytes += size;
    try {
      const result = await this.request("/api/upload", payload, 60_000);
      const attachment = publicAttachment(result.attachment);
      if (!attachment) throw new Error("上传未返回有效附件；没有发送消息");
      const id = randomUUID(); row.staged.set(id, { ...attachment, size });
      return { id, ...attachment, size };
    } finally { row.uploading--; row.reservedBytes -= size; }
  }
  removeUpload(agent, id) { this.row(agent).staged.delete(id); }
  async history(agent) {
    const row = this.row(agent);
    const result = await this.request(`/api/conversations/explorer?agentName=${encodeURIComponent(agent)}`);
    if (result.enabled === false) throw new Error("请先开启 Harbour 会话记忆");
    return (result.sessions || []).filter(s => s.agentName === agent)
      .map(s => ({ id: s.id, title: s.title || "新对话", updatedAt: s.lastMessageAt || s.updatedAt,
        active: s.id === row.sessionId, source: sessionSource(s), readOnly: this.readOnly(s), unread: !!s.unread }));
  }
  async select(agent, id) {
    const row = this.row(agent); this.assertIdle(row);
    if (typeof id !== "string" || !/^[\w-]{1,128}$/.test(id)) throw new Error("会话编号无效");
    const revision = this.sync.revisions.get(id) || 0;
    row.changing = true; this.changed(row);
    try {
      let { session } = await this.readSession(id);
      this.assertSession(row, session, true);
      if (session.id !== id) throw new Error("会话编号不匹配");
      // Browsing a QQ/DC/Cowork record must not move its channel's active pointer.
      if (!this.readOnly(session)) {
        const result = await this.request("/api/conversations/switch", { key: session.key, id, view: "chat" });
        this.assertSession(row, result.session, true);
        if (result.session.id !== id || result.session.key !== session.key) throw new Error("会话归属不匹配");
        session = result.session;
      }
      row.phase = "idle"; row.detail = ""; row.replyReadyAt = 0; row.feedback.reset();
      this.acceptSession(row, session, true);
      return this.snapshot(agent);
    } finally {
      row.changing = false;
      if (row.sessionId === id && revision !== (this.sync.revisions.get(id) || 0)) await this.sync.refresh(row);
      this.changed(row);
    }
  }
  async settings(agent) {
    const row = this.row(agent);
    if (!row.loaded) await this.load(agent);
    this.assertWritable(row);
    const sessionId = row.sessionId, serverUrl = this.getConfig().url;
    const { models = [], agents = [] } = await this.request("/api/agent-defaults");
    if (sessionId !== row.sessionId || serverUrl !== this.getConfig().url) throw new Error("会话或后端已切换，请重新打开设置");
    const defaults = agents.find(a => a.name === agent);
    row.defaultModelRef = defaults?.effectiveModelRef || "";
    row.modelLabels = Object.fromEntries(models.map(m => [m.modelRef, m.modelLabel || m.model || m.modelRef]));
    this.changed(row);
    return { sessionId, config: row.config, defaults: { modelRef: defaults?.effectiveModelRef || "",
      permissionMode: defaults?.effectivePermissionMode || "", reasoningEffort: defaults?.defaultReasoningEffort || "" },
      models: models.map(m => ({ value: m.modelRef, label: m.modelLabel || m.modelName || m.model || m.modelRef,
        detail: m.connectionLabel || m.providerLabel || m.providerId || "", group: m.providerLabel || m.providerId || "",
        efforts: m.effortOptions || [], fallbackEffort: m.defaultEffort || "", defaultEffort: m.effort || defaults?.defaultReasoningEffort || m.defaultEffort || "" })) };
  }
  async configure(agent, config, sessionId) {
    const row = this.row(agent); this.assertIdle(row);
    if (sessionId !== undefined && sessionId !== row.sessionId) throw new Error("会话已切换，请重新打开设置；未修改任何配置");
    const fields = ["modelRef", "permissionMode", "reasoningEffort"];
    if (!config || Object.keys(config).some(k => !fields.includes(k))
      || Object.values(config).some(v => typeof v !== "string" || v.length > 200)) throw new Error("运行设置无效");
    row.changing = true; this.changed(row);
    try {
      if (!row.loaded) await this.load(agent);
      this.assertWritable(row);
      if (!row.sessionId) await this.load(agent, true);
      const { session } = await this.readSession(row.sessionId);
      this.assertSession(row, session);
      if (session.id !== row.sessionId) throw new Error("会话编号不匹配，未修改配置");
      if (this.readOnly(session)) throw new Error("这段会话只读，请在完整会话中修改设置");
      const result = await this.request(`/api/conversations/${encodeURIComponent(row.sessionId)}`, config, 12_000, "PATCH");
      this.assertSession(row, result.session);
      if (result.session.id !== row.sessionId) throw new Error("配置回执会话编号不匹配，请核对原会话");
      this.acceptSession(row, result.session);
      return this.snapshot(agent);
    } finally { row.changing = false; this.changed(row); }
  }

  async load(agent, fresh = false) {
    const row = this.row(agent);
    if (row.localRunId) return this.snapshot(agent);
    if (row.runId) {
      if (row.external?.terminal) await this.sync.refresh(row);
      return this.snapshot(agent);
    }
    if (row.loading) {
      if (fresh) throw new Error("正在读取会话，请稍候再新建");
      return row.loading;
    }
    // Once selected, reread this exact session; a Dashboard selection elsewhere
    // must not silently redirect the orb when its panel is reopened.
    if (!fresh && row.loaded && row.sessionId) {
      await this.sync.refresh(row); return this.snapshot(agent);
    }
    row.loading = (async () => {
      let session, readRevision;
      if (fresh) {
        session = (await this.request("/api/conversations/new", { key: `web:default:${agent}`, channel: "web", agentName: agent })).session;
        if (session?.key !== `web:default:${agent}` || session.channel !== "web") throw new Error("会话归属不匹配");
      } else {
        const list = await this.request(`/api/conversations?key=${encodeURIComponent(row.key)}`);
        if (list.enabled === false) throw new Error("请先开启 Harbour 会话记忆，再使用悬浮助手");
        let id = list.activeId, expectedKey = row.key;
        if (!id) {
          // No new namespace migration or copying: old orb/town/Web conversations
          // remain selectable by their original IDs, including on another device.
          const explorer = await this.request(`/api/conversations/explorer?agentName=${encodeURIComponent(agent)}`);
          const fallback = explorer.sessions?.find(s => s.agentName === agent && !this.readOnly(s));
          id = fallback?.id; expectedKey = fallback?.key;
        }
        if (id) {
          readRevision = this.sync.revisions.get(id) || 0;
          session = (await this.readSession(id)).session;
          if (session?.key !== expectedKey || this.readOnly(session)) throw new Error("会话归属不匹配，已停止读取");
          if (session?.id !== id) throw new Error("会话编号不匹配");
        }
      }
      if (fresh) { row.phase = "idle"; row.detail = ""; row.replyReadyAt = 0; row.feedback.reset(); }
      this.acceptSession(row, session, true);
      if (session && readRevision !== undefined && readRevision !== (this.sync.revisions.get(session.id) || 0)) await this.sync.refresh(row);
      this.changed(row);
      return this.snapshot(agent);
    })();
    this.changed(row);
    try { return await row.loading; } finally { delete row.loading; this.changed(row); }
  }

  validateMessage(row, input, fileIds) {
    if (!Array.isArray(fileIds) || fileIds.length > MAX_FILES || new Set(fileIds).size !== fileIds.length
      || fileIds.some(id => typeof id !== "string" || !row.staged.has(id))) throw new Error("附件已失效或不属于当前角色，请重新添加");
    if (typeof input !== "string" || (!input.trim() && !fileIds.length) || input.length > 24_000) throw new Error("请输入 1–24000 字的消息，或添加附件");
    return fileIds.map(id => row.staged.get(id));
  }

  // The composer uses the existing authenticated inbox for an active task;
  // starting an idle turn retains the original run/ask/stop ownership below.
  async submit(agent, input, fileIds = [], mode = "queue") {
    if (mode !== "queue" && mode !== "steer") throw new Error("消息模式只能是 queue 或 steer");
    const row = this.row(agent), attachments = this.validateMessage(row, input, fileIds);
    this.assertWritable(row);
    if (row.inputSending || row.loading || row.changing || row.syncing || row.preparing && !row.runId) throw new Error("消息正在提交或会话正在切换，请稍候");
    if (!row.runId && !row.inputRequest) return this.send(agent, input, fileIds);
    if (!row.sessionId || row.phase === "uncertain") throw new Error("当前任务状态尚未确认，请先打开完整会话核对");
    const text = input.trim(), attachmentKey = JSON.stringify(fileIds);
    if (row.inputRequest && (row.inputRequest.sessionId !== row.sessionId || row.inputRequest.text !== text || row.inputRequest.attachmentKey !== attachmentKey
      || row.inputRequest.serverUrl !== this.getConfig().url)) throw new Error("上条补充的回执尚未确认，请先用原文和附件重试核对，勿改为另一条消息");
    // A lost receipt is retried with the original ID AND mode, even if the
    // user presses a different shortcut or the original task has since ended.
    const request = row.inputRequest ||= { id: `orb-input-${randomUUID()}`, sessionId: row.sessionId,
      text, attachmentKey, attachments, mode, serverUrl: this.getConfig().url };
    row.inputSending = true; row.inputNotice = ""; this.changed(row);
    try {
      const receipt = await this.request(`/api/conversations/${encodeURIComponent(request.sessionId)}/inputs`, {
        input: request.text, attachments: request.attachments, mode: request.mode, clientMessageId: request.id,
      });
      if (receipt.id !== request.id && typeof receipt.reply !== "string") throw new Error("补充回执无效");
      row.inputRequest = null;
      fileIds.forEach(id => row.staged.delete(id));
      row.inputNotice = receipt.reply || (receipt.state === "withdrawn" ? "这条消息已撤回，未再次发送。"
        : receipt.state === "paused" ? "消息已保存到暂停队列，请在完整会话中查看或恢复。"
        : receipt.state === "unknown" ? "这条消息的执行结果待核对，请在完整会话中查看，勿重复提交。"
        : receipt.state === "completed" ? "这条消息已处理，请在完整会话中查看结果。"
        : receipt.mode === "queue" ? "已排队，当前任务结束后处理 · 可在完整会话撤回编辑"
          : "已提交补充，等待当前任务接收 · 无法接收时会排队");
    } catch (error) {
      row.inputNotice = "未确认投递，原文与附件已保留；再次发送会用同一编号核对，不会自动重发。";
      throw new Error(`${error.message}。${row.inputNotice}`);
    } finally { row.inputSending = false; this.changed(row); }
    return this.snapshot(agent);
  }

  async send(agent, input, fileIds = []) {
    const row = this.row(agent);
    const attachments = this.validateMessage(row, input, fileIds);
    this.assertIdle(row);
    if (row.phase === "uncertain") throw new Error("上次连接中断，请先打开完整会话核对，不要重复提交");
    row.preparing = true; row.inputNotice = "";
    let ownedRunId;
    const text = input.trim() || "请查看这些附件。";
    try {
      if (!row.loaded) await this.load(agent);
      this.assertWritable(row);
      // Create/pin before sending, so a parallel Dashboard change cannot redirect the turn.
      if (!row.sessionId) await this.load(agent, true);
      if (row.runId) throw new Error("完整会话正在处理这条任务，请等待完成");
      row.runId = `orb-${randomUUID()}`; row.phase = "running"; row.detail = "已交给 Main"; row.asks = []; row.replyReadyAt = 0;
      ownedRunId = row.localRunId = row.runId; row.localStartedAt = Date.now(); row.progressTime = 0;
      row.feedback.reset(row.runId, row.sessionId, row.agent);
      row.messages.push(this.message(row, { role: "user", content: text, ...(attachments.length ? { attachments } : {}) }));
      fileIds.forEach(id => row.staged.delete(id)); this.changed(row);
      const result = await this.request("/api/run", { runId: row.runId, agent, input: text,
        ...(attachments.length ? { attachments } : {}),
        session: { id: row.sessionId, key: row.key, channel: "web" } }, this.timeoutMs);
      if (result.session?.id === row.sessionId) row.context = sessionContext(result.session);
      row.messages.push(this.message(row, { role: "assistant", content: String(result.answer || (result.attachments?.length ? "" : "（没有文字回答，请查看完整会话）")), attachments: result.attachments }));
      this.acceptReplyState(row, result.session?.id === row.sessionId ? result.session : null, ownedRunId);
      row.phase = "complete"; row.detail = "已回复"; row.replyReadyAt = Date.now();
    } catch (error) {
      if (ownedRunId && row.runId === ownedRunId) {
        if (error.result?.session?.id === row.sessionId) row.context = sessionContext(error.result.session);
        row.phase = error.status === 499 ? "cancelled" : "uncertain";
        row.detail = error.status === 499 ? "已停止，断点保留" : error.message;
        if (error.status === 499) row.feedback.cancel();
      }
      if (error.status !== 499) throw error;
    } finally {
      if (ownedRunId) {
        this.sync.active.delete(ownedRunId); this.sync.remember(ownedRunId);
        row.runId = null; row.localRunId = null; row.asks = [];
        this.sync.bind(row);
        if (row.external) this.sync.refresh(row);
      }
      row.preparing = false; this.changed(row);
    }
    return this.snapshot(agent);
  }

  async stop(agent) {
    const row = this.row(agent);
    if (!row.runId) return false;
    if (row.runId !== row.localRunId) throw new Error("这条任务在完整会话中发起，请在那里停止");
    const runId = row.runId;
    const result = await this.request(`/api/runs/${encodeURIComponent(runId)}/abort`, {});
    if (row.runId === runId) { row.phase = "stopping"; row.detail = "正在停止并保存断点…"; this.changed(row); }
    return result;
  }

  ownsAsk(row, ask) {
    if (!row.localRunId || row.localRunId !== row.runId || row.readOnly || ask.channel !== "web" || ask.sessionKey !== row.key) return false;
    if (ask.runId) return ask.runId === row.localRunId && (!ask.sessionId || ask.sessionId === row.sessionId);
    // Old servers only emit a key. Shared Main/orb history means more than one
    // session may be running under it; ambiguous questions belong in Main Chat.
    if (Date.parse(ask.createdAt) < row.localStartedAt) return false;
    return ![...this.sync.active.values()].some(e => e.sessionKey === row.key && e.runId !== row.localRunId);
  }
  async answer(agent, id, answer) {
    const row = this.row(agent);
    if (!row.runId || !row.asks.some(a => a.id === id && this.ownsAsk(row, a) && Date.parse(a.expiresAt) > Date.now())) throw new Error("提问已失效或归属不明确，请查看完整会话");
    if (typeof answer !== "string" || !answer.trim() || answer.length > 24_000) throw new Error("答复无效");
    const runId = row.runId;
    const result = await this.request(`/api/asks/${encodeURIComponent(id)}/answer`, { answer: answer.trim() });
    if (row.runId === runId) {
      row.askRevision = (row.askRevision || 0) + 1;
      row.asks = row.asks.filter(a => a.id !== id); row.phase = row.asks.length ? "waiting" : "running"; this.changed(row);
    }
    return result;
  }

  consume(event) {
    if (this.disposed || !event || typeof event !== "object") return;
    if (event.__harbour === "session-read") {
      if (rememberReceipt(this.readReplies, event)) for (const row of this.rows.values()) {
        if (row.sessionId === event.id) this.changed(row);
      }
      return;
    }
    this.sync.consume(event);
    for (const row of this.rows.values()) {
      // Late WS evidence may arrive just after HTTP; bind it to this exact run,
      // including its child trace IDs, without unlocking an uncertain submission.
      if (row.feedback.consume(event)) this.changed(row);
      if (!row.runId) continue;
      if (row.localRunId && event.__harbour === "channel-activity" && event.runId === row.runId) {
        // Only the original HTTP response confirms completion; no optimistic success from WS.
        if (event.sessionId === row.sessionId && event.phase === "running") { row.detail = String(event.detail || "正在处理任务").slice(0, 140); this.changed(row); }
      }
      // Legacy asks carry a source key, not an exact session/run. Mirrored tasks
      // show their waiting stage, but their confirmation remains in Main Chat.
      if (event.__harbour === "ask" && event.ask && this.ownsAsk(row, event.ask)) {
        row.askRevision = (row.askRevision || 0) + 1;
        row.asks = row.asks.filter(a => a.id !== event.ask.id);
        if (event.kind === "new") row.asks.push(event.ask);
        row.phase = row.asks.length ? "waiting" : "running"; this.changed(row);
      }
    }
  }
  async refreshAsks() {
    const targets = [...this.rows.values()].filter(row => row.localRunId).map(row => ({ row, runId: row.runId, revision: row.askRevision }));
    if (!targets.length) return;
    const { asks = [] } = await this.request("/api/asks");
    for (const { row, runId, revision } of targets) {
      if (row.runId !== runId || row.askRevision !== revision) continue;
      row.asks = asks.filter(a => this.ownsAsk(row, a));
      row.phase = row.asks.length ? "waiting" : row.phase === "waiting" ? "running" : row.phase; this.changed(row);
    }
  }
  dispose() { this.disposed = true; for (const req of this.requests) req.destroy(); this.requests.clear(); }
}

function sessionSource(session) {
  if (!session) return { kind: "web", label: "Web" };
  const key = String(session.key || ""), channel = session.channel;
  if (channel === "web") {
    if (key.startsWith("web:cowork:")) return { kind: "cowork", label: "Cowork" };
    if (key.startsWith("web:town:")) return { kind: "town", label: "小镇" };
    if (key.startsWith("web:orb:")) return { kind: "orb", label: "悬浮助手" };
    return { kind: "web", label: "Web" };
  }
  return { kind: ["qq", "discord"].includes(channel) ? channel : "other",
    label: channel === "qq" ? "QQ" : channel === "discord" ? "Discord" : session.source?.appLabel || "其它渠道" };
}

module.exports = { OrbChat };
