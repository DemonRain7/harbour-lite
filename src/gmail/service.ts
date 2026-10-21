import path from "node:path";
import { boundedResponse, GoogleOAuthConnection, GoogleOAuthError, type GoogleOAuthStatus } from "../google/oauth";

export const GOOGLE_GMAIL_SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"] as const;
const API = "https://gmail.googleapis.com/gmail/v1/users/me";
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_BODY_CHARS = 20_000;
type Json = Record<string, unknown>;

export class GmailServiceError extends GoogleOAuthError {
  constructor(code: string, message: string, httpStatus = 400) { super(code, message, httpStatus); this.name = "GmailServiceError"; }
}
export interface GmailServiceOptions {
  dataDir?: string;
  clientId?: string;
  clientSecret?: string;
  redirectUri?: string;
  fetch?: typeof fetch;
  now?: () => number;
}
export interface GmailReadOptions { signal?: AbortSignal }
export type GmailStatus = GoogleOAuthStatus;
export interface GmailMessageSummary {
  id: string;
  threadId: string;
  subject: string;
  from: string;
  to: string;
  date: string;
  snippet: string;
  labelIds: string[];
}
export interface GmailMessage extends GmailMessageSummary {
  bodyText: string;
  bodyTruncated: boolean;
  bodyUnavailable: boolean;
  attachmentsOmitted: boolean;
  contentTrust: "untrusted_email";
}

/** Explicit owner consent only. Never sends, mutates labels/read state, or retrieves attachments. */
export class GmailService {
  private readonly auth: GoogleOAuthConnection;
  private readonly fetcher: typeof fetch;

  constructor(options: GmailServiceOptions = {}) {
    this.fetcher = options.fetch ?? fetch;
    this.auth = new GoogleOAuthConnection({ ...options,
      dataDir: options.dataDir ?? path.join(process.cwd(), "data", "gmail"), scopes: GOOGLE_GMAIL_SCOPES,
      callbackPath: "/api/gmail/oauth/callback", configPrefix: "GOOGLE_GMAIL",
      errorFactory: (code, message, status) => new GmailServiceError(code, message, status) });
  }

  status(): Promise<GmailStatus> { return this.auth.status(); }
  beginAuth(): Promise<{ url: string }> { return this.auth.beginAuth(); }
  completeAuth(input: { state: string; code?: string; error?: string }): Promise<void> { return this.auth.completeAuth(input); }
  async disconnect(): Promise<{ disconnected: true; localOnly: true; providerGrantRevoked: false }> {
    // Google's revocation is project-wide, not scope-local. A Gmail-only disconnect
    // must not silently invalidate Calendar or other grants for the same project.
    await this.auth.disconnect({ revoke: false });
    return { disconnected: true, localOnly: true, providerGrantRevoked: false };
  }

  /** One explicitly requested page; metadata only, never silently downloads every body. */
  async search(input: { q?: string; maxResults?: number; pageToken?: string }, options: GmailReadOptions = {}) {
    exact(input, ["q", "maxResults", "pageToken"]);
    const q = input.q === undefined ? undefined : bounded(input.q, "搜索词", 1000);
    const maxResults = integer(input.maxResults, 10, 1, 20, "maxResults");
    const pageToken = input.pageToken === undefined ? undefined : bounded(input.pageToken, "pageToken", 4096);
    const auth = await this.access(options);
    const list = await this.api("/messages", { maxResults: String(maxResults), includeSpamTrash: "false",
      fields: "messages(id,threadId),nextPageToken,resultSizeEstimate", ...(q ? { q } : {}), ...(pageToken ? { pageToken } : {}) }, auth, options);
    if (list.messages !== undefined && !Array.isArray(list.messages)) throw invalidResponse();
    const raw = rows(list.messages);
    const selected = raw.slice(0, maxResults).map(row => identifier(object(row).id, "messageId"));
    const messages = await mapBounded(selected, async id => {
      const data = await this.api(`/messages/${id}`, {
        format: "metadata", fields: "id,threadId,snippet,labelIds,payload(headers)" }, auth, options);
      if (data.id !== id) throw invalidResponse();
      return summary(data);
    });
    this.auth.assertGeneration(auth.generation);
    checkCancelled(options.signal);
    const nextPageToken = outputPage(list.nextPageToken);
    return { messages, contentTrust: "untrusted_email" as const, truncated: !!nextPageToken || raw.length > maxResults,
      ...(nextPageToken ? { nextPageToken } : {}),
      ...(typeof list.resultSizeEstimate === "number" && Number.isSafeInteger(list.resultSizeEstimate) && list.resultSizeEstimate >= 0
        ? { resultSizeEstimate: list.resultSizeEstimate } : {}) };
  }

  async get(input: { messageId: string; maxBodyChars?: number }, options: GmailReadOptions = {}): Promise<{ message: GmailMessage }> {
    exact(input, ["messageId", "maxBodyChars"]);
    const id = identifier(input.messageId, "messageId");
    const limit = integer(input.maxBodyChars, 8000, 1, MAX_BODY_CHARS, "maxBodyChars");
    const auth = await this.access(options);
    return { message: await this.message(id, limit, auth, options) };
  }

  /** Read only the latest bounded set; first fetch IDs without downloading other message bodies. */
  async thread(input: { threadId: string; maxMessages?: number; maxBodyChars?: number }, options: GmailReadOptions = {}) {
    exact(input, ["threadId", "maxMessages", "maxBodyChars"]);
    const id = identifier(input.threadId, "threadId");
    const maxMessages = integer(input.maxMessages, 5, 1, 10, "maxMessages");
    const bodyBudget = integer(input.maxBodyChars, 12_000, 1, MAX_BODY_CHARS, "maxBodyChars");
    const auth = await this.access(options);
    const thread = await this.api(`/threads/${id}`, { format: "minimal", fields: "id,messages(id)" }, auth, options);
    if (thread.id !== id || !Array.isArray(thread.messages)) throw invalidResponse();
    const selected = thread.messages.slice(-maxMessages).map(row => identifier(object(row).id, "messageId"));
    // maxBodyChars is a total thread response budget, not multiplied by message count.
    let remaining = bodyBudget;
    const messages: GmailMessage[] = [];
    for (let index = 0; index < selected.length; index++) {
      const allowance = Math.floor(remaining / (selected.length - index));
      const message = await this.message(selected[index]!, allowance, auth, options);
      if (message.threadId !== id) throw invalidResponse();
      remaining -= message.bodyText.length;
      messages.push(message);
    }
    this.auth.assertGeneration(auth.generation);
    checkCancelled(options.signal);
    return { threadId: id, messages, totalMessages: thread.messages.length,
      truncated: thread.messages.length > maxMessages || messages.some(message => message.bodyTruncated),
      contentTrust: "untrusted_email" as const };
  }

  private async access(options: GmailReadOptions) {
    checkCancelled(options.signal);
    // Cancelling one caller must not cancel a refresh shared with another caller.
    const auth = await cancellable(this.auth.access(), options.signal);
    checkCancelled(options.signal);
    return auth;
  }

  private async message(id: string, limit: number, auth: Awaited<ReturnType<GoogleOAuthConnection["access"]>>, options: GmailReadOptions) {
    const data = await this.api(`/messages/${id}`, { format: "full", fields: "id,threadId,snippet,labelIds,payload" }, auth, options);
    if (data.id !== id) throw invalidResponse();
    return { ...summary(data), ...plainBody(data.payload, limit), contentTrust: "untrusted_email" as const };
  }

  private async api(route: string, query: Record<string, string>, auth: Awaited<ReturnType<GoogleOAuthConnection["access"]>>, options: GmailReadOptions): Promise<Json> {
    checkCancelled(options.signal);
    this.auth.assertGeneration(auth.generation);
    const url = new URL(`${API}${route}`);
    url.search = new URLSearchParams(query).toString();
    if (query.format === "metadata") for (const name of ["Subject", "From", "To", "Date"]) url.searchParams.append("metadataHeaders", name);
    const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(20_000)]) : AbortSignal.timeout(20_000);
    let response: Response;
    try { response = await this.fetcher(url.toString(), { method: "GET", redirect: "error", signal,
      headers: { Authorization: `Bearer ${auth.token}` } }); }
    catch { checkCancelled(options.signal); throw new GmailServiceError("GOOGLE_UNAVAILABLE", "无法连接 Gmail，请检查网络或稍后重试。", 502); }
    if (options.signal?.aborted) { void response.body?.cancel().catch(() => {}); checkCancelled(options.signal); }
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      const status = response.status;
      const code = status === 401 ? "NOT_CONNECTED" : status === 403 ? "PERMISSION_DENIED" : status === 404 ? "NOT_FOUND" : status === 429 ? "RATE_LIMITED" : "GOOGLE_REJECTED";
      const message = status === 401 ? "Gmail 授权已失效，请重新连接。" : status === 403 ? "Gmail 访问被拒绝，请检查 API 是否启用及只读授权。"
        : status === 404 ? "邮件或会话不存在。" : status === 429 ? "Gmail 请求频率受限；未自动重试。" : `Gmail 返回 ${status}；未自动重试。`;
      throw new GmailServiceError(code, message, status === 401 ? 428 : status);
    }
    let data: unknown;
    try { data = JSON.parse(await boundedResponse(response, MAX_RESPONSE_BYTES)); }
    catch { checkCancelled(options.signal); throw invalidResponse(); }
    checkCancelled(options.signal);
    this.auth.assertGeneration(auth.generation);
    if (!data || typeof data !== "object" || Array.isArray(data)) throw invalidResponse();
    return data as Json;
  }
}

function summary(value: unknown): GmailMessageSummary {
  const data = object(value);
  const headers = rows(object(data.payload).headers);
  const header = (name: string) => text(object(headers.find(item => text(object(item).name, 100).toLowerCase() === name)).value, 1000);
  return { id: identifier(data.id, "messageId"), threadId: identifier(data.threadId, "threadId"),
    subject: header("subject"), from: header("from"), to: header("to"), date: header("date"),
    snippet: text(data.snippet, 500), labelIds: rows(data.labelIds).slice(0, 50).map(label => text(label, 100)) };
}

/** MIME plain-text only. HTML, embedded resources, attachment IDs and filenames never leave the service. */
function plainBody(payload: unknown, limit: number) {
  let bodyText = "", bodyTruncated = false, attachmentsOmitted = false, plainFound = false, visited = 0;
  const walk = (value: unknown, depth: number): void => {
    if (++visited > 100 || depth > 12) { bodyTruncated = true; return; }
    const part = object(value), body = object(part.body);
    const headers = rows(part.headers);
    const header = (name: string) => text(object(headers.find(item => text(object(item).name, 100).toLowerCase() === name)).value, 200);
    if (part.filename || body.attachmentId || /^attachment\b/i.test(header("content-disposition"))) { attachmentsOmitted = true; return; }
    const mime = text(part.mimeType, 100).toLowerCase();
    if (mime === "message/rfc822") { attachmentsOmitted = true; return; }
    if (mime === "text/plain" && typeof body.data === "string") {
      if (!/^[A-Za-z0-9_-]*={0,2}$/.test(body.data)) { bodyTruncated = true; return; }
      const charset = /charset\s*=\s*["']?([^;\s"']+)/i.exec(header("content-type"))?.[1] ?? "utf-8";
      let decoded: string;
      try { decoded = new TextDecoder(charset).decode(Buffer.from(body.data, "base64url")); }
      catch { bodyTruncated = true; return; }
      plainFound = true;
      decoded = decoded.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "");
      const addition = (bodyText && decoded ? "\n" : "") + decoded;
      const remaining = Math.max(0, limit - bodyText.length);
      bodyText += addition.slice(0, remaining);
      if (addition.length > remaining) bodyTruncated = true;
    }
    // Descend MIME containers only, never an attached message/rfc822 or HTML resource.
    if (mime.startsWith("multipart/")) {
      const parts = rows(part.parts);
      if (parts.length > 100) bodyTruncated = true;
      for (const child of parts.slice(0, 100)) { if (visited >= 100) { bodyTruncated = true; break; } walk(child, depth + 1); }
    }
  };
  walk(payload, 0);
  return { bodyText, bodyTruncated, bodyUnavailable: !plainFound, attachmentsOmitted };
}

function checkCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new GmailServiceError("OPERATION_CANCELLED", "Gmail 查询已停止。", 409);
}
async function cancellable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const abort = () => { cleanup(); reject(new GmailServiceError("OPERATION_CANCELLED", "Gmail 查询已停止。", 409)); };
    const cleanup = () => signal.removeEventListener("abort", abort);
    // Always observe the shared promise, including an already-aborted caller.
    promise.then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true });
  });
}
async function mapBounded<T, R>(items: T[], run: (item: T) => Promise<R>): Promise<R[]> {
  const output: R[] = []; let cursor = 0, failed = false;
  await Promise.all(Array.from({ length: Math.min(items.length, 3) }, async () => {
    while (!failed) {
      const index = cursor++; if (index >= items.length) return;
      try { output[index] = await run(items[index]!); } catch (error) { failed = true; throw error; }
    }
  }));
  return output;
}
function object(value: unknown): Json { return value && typeof value === "object" && !Array.isArray(value) ? value as Json : {}; }
function rows(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function text(value: unknown, limit: number): string { return typeof value === "string" ? value.slice(0, limit).replace(/[\u0000-\u001f\u007f]/gu, " ") : ""; }
function bounded(value: unknown, field: string, limit: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > limit || /[\u0000-\u001f\u007f]/u.test(value)) throw new GmailServiceError("INVALID_INPUT", `${field} 无效。`);
  return value.trim();
}
function identifier(value: unknown, field: string): string {
  const id = bounded(value, field, 256);
  if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new GmailServiceError("INVALID_INPUT", `${field} 无效。`);
  return id;
}
function integer(value: unknown, fallback: number, minimum: number, maximum: number, field: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value) || value < minimum || value > maximum) throw new GmailServiceError("INVALID_INPUT", `${field} 超出允许范围。`);
  return value;
}
function outputPage(value: unknown): string | undefined {
  if (value === undefined || value === "") return undefined;
  if (typeof value !== "string" || value.length > 4096 || /[\u0000-\u001f\u007f]/u.test(value)) throw invalidResponse();
  return value;
}
function exact(value: unknown, allowed: string[]): asserts value is Json {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) {
    throw new GmailServiceError("INVALID_INPUT", "Gmail 操作包含未声明参数。");
  }
}
function invalidResponse(): GmailServiceError { return new GmailServiceError("GOOGLE_RESPONSE_INVALID", "Gmail 返回结果无效或超过 2 MB 限制；请缩小查询范围。", 502); }
