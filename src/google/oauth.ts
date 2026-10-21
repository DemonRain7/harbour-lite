import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

// Shared by Calendar and Gmail; each service owns an independent scoped connection.
const TOKEN = "https://oauth2.googleapis.com/token";
const REVOKE = "https://oauth2.googleapis.com/revoke";
const AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const AUTH_TTL = 10 * 60_000;
const MAX_BODY = 2 * 1024 * 1024;
type Json = Record<string, unknown>;

interface Tokens {
  version: 1;
  clientFingerprint: string;
  connectionId: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scopes: string[];
}
interface AuthAttempt { state: string; verifier: string; expiresAt: number; generation: number }

export interface GoogleOAuthStatus {
  configured: boolean;
  connected: boolean;
  redirectUri: string;
  missing: string[];
  scopes: string[];
  connectionError?: string;
}
export class GoogleOAuthError extends Error {
  constructor(readonly code: string, message: string, readonly httpStatus = 400,
    readonly writeOutcome?: "rejected" | "unknown") { super(message); this.name = "GoogleOAuthError"; }
}
export interface GoogleOAuthOptions {
  dataDir: string;
  clientId?: string;
  clientSecret?: string;
  redirectUri?: string;
  fetch?: typeof fetch;
  now?: () => number;
  scopes: readonly string[];
  callbackPath: string;
  configPrefix: string;
  errorFactory?: (code: string, message: string, httpStatus?: number, writeOutcome?: "rejected" | "unknown") => GoogleOAuthError;
}

/** State, PKCE, local token storage, refresh coalescing and connection-race guard. */
export class GoogleOAuthConnection {
  private readonly tokenFile: string;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly redirectUri: string;
  private readonly fingerprint: string;
  private readonly scopes: readonly string[];
  private readonly callbackPath: string;
  private readonly configPrefix: string;
  private readonly error: NonNullable<GoogleOAuthOptions["errorFactory"]>;
  private tokens?: Tokens;
  private loaded?: Promise<void>;
  private connectionError?: string;
  private generation = 0;
  private auth?: AuthAttempt;
  private authWrites: Promise<void> = Promise.resolve();
  private refreshing?: Promise<void>;

  constructor(options: GoogleOAuthOptions) {
    this.tokenFile = path.join(path.resolve(options.dataDir), "tokens.json");
    this.fetcher = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.clientId = options.clientId?.trim() ?? "";
    this.clientSecret = options.clientSecret?.trim() ?? "";
    this.callbackPath = options.callbackPath;
    this.configPrefix = options.configPrefix;
    this.redirectUri = options.redirectUri?.trim() || `http://localhost:7788${this.callbackPath}`;
    // Preserve Calendar's existing v1 token fingerprint and storage format.
    this.fingerprint = hash(`${this.clientId}\n${this.redirectUri}`);
    this.scopes = [...options.scopes];
    this.error = options.errorFactory ?? ((...args) => new GoogleOAuthError(...args));
  }

  get currentGeneration(): number { return this.generation; }

  async status(): Promise<GoogleOAuthStatus> {
    await this.load();
    const missing = this.missing();
    return { configured: missing.length === 0, connected: missing.length === 0 && !!this.tokens,
      redirectUri: this.displayRedirect(), missing, scopes: [...this.scopes],
      ...(this.connectionError ? { connectionError: this.connectionError } : {}) };
  }

  async beginAuth(): Promise<{ url: string }> {
    this.requireConfigured();
    await this.load();
    const state = randomBytes(32).toString("base64url");
    const verifier = randomBytes(64).toString("base64url");
    // Serialize consent supersession with durable commits. A newer flow cannot make an
    // already-writing token file invalid while leaving that rejected account on disk.
    await this.authWrite(async () => {
      this.generation++;
      this.auth = { state, verifier, expiresAt: this.now() + AUTH_TTL, generation: this.generation };
    });
    const url = new URL(AUTH);
    url.search = new URLSearchParams({ client_id: this.clientId, redirect_uri: this.redirectUri,
      response_type: "code", scope: this.scopes.join(" "), access_type: "offline",
      prompt: "consent", state, code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256" }).toString();
    return { url: url.toString() };
  }

  async completeAuth(input: { state: string; code?: string; error?: string }): Promise<void> {
    this.requireConfigured();
    const attempt = this.auth;
    if (!attempt || typeof input.state !== "string" || input.state.length > 200
      || !equal(input.state, attempt.state) || attempt.expiresAt <= this.now() || attempt.generation !== this.generation) {
      throw this.error("OAUTH_STATE_INVALID", "Google 授权状态无效或已过期，请重新连接。");
    }
    this.auth = undefined; // Single-use even on denial, exchange failure, or callback races.
    if (input.error) throw this.error("OAUTH_DENIED", "Google 授权未完成；未连接账户。");
    if (typeof input.code !== "string" || !input.code.trim() || input.code.length > 4096 || /[\u0000-\u001f\u007f]/u.test(input.code)) {
      throw this.error("INVALID_INPUT", "授权码无效。");
    }
    const code = input.code.trim();
    const response = await this.oauth(new URLSearchParams({ client_id: this.clientId, client_secret: this.clientSecret,
      redirect_uri: this.redirectUri, grant_type: "authorization_code", code, code_verifier: attempt.verifier }));
    const tokens = this.parseTokens(response, randomUUID());
    await this.commitTokens(tokens, attempt.generation, true);
  }

  async disconnect(options: { revoke?: boolean } = {}): Promise<void> {
    // Invalidate every in-flight exchange/refresh before any await; queued writes cannot resurrect tokens.
    const previous = this.tokens;
    let token = previous?.refreshToken || previous?.accessToken;
    this.generation++;
    this.tokens = undefined;
    this.auth = undefined;
    this.loaded = Promise.resolve();
    this.connectionError = undefined;
    await this.authWrite(async () => {
      if (!token && options.revoke !== false) {
        try {
          const stored = object(JSON.parse(await fs.readFile(this.tokenFile, "utf8")));
          if (stored.clientFingerprint === this.fingerprint) token = string(stored.refreshToken) || string(stored.accessToken);
        } catch { /* Corrupt/missing state is still removed locally without exposing it. */ }
      }
      try { await fs.rm(this.tokenFile, { force: true }); }
      catch { throw this.error("LOCAL_STATE_FAILED", "连接已在本进程停用，但本机授权记录删除失败，请检查存储权限。", 503); }
      if (token && options.revoke !== false) {
        // New consent waits behind revocation, so an old disconnect cannot intentionally
        // revoke an already-established replacement connection to the same Google account.
        try {
          const response = await this.fetcher(REVOKE, { method: "POST", redirect: "error", signal: AbortSignal.timeout(5000),
            headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token }) });
          await response.body?.cancel().catch(() => {});
        } catch { /* Local disconnect is authoritative even when revocation is unavailable. */ }
      }
    });
  }

  private missing(): string[] {
    const missing: string[] = [];
    if (!this.clientId) missing.push(`${this.configPrefix}_CLIENT_ID`);
    if (!this.clientSecret) missing.push(`${this.configPrefix}_CLIENT_SECRET`);
    try {
      const uri = new URL(this.redirectUri);
      if (uri.username || uri.password || uri.hash || uri.search || uri.pathname !== this.callbackPath || (uri.protocol !== "https:"
        && !(uri.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(uri.hostname)))) throw new Error();
    } catch { missing.push(`${this.configPrefix}_REDIRECT_URI`); }
    return missing;
  }

  private displayRedirect(): string {
    try { const uri = new URL(this.redirectUri); return `${uri.origin}${uri.pathname}`; }
    catch { return ""; }
  }

  private requireConfigured(): void {
    if (this.missing().length) throw this.error("NOT_CONFIGURED", "请先配置 Google OAuth 客户端与有效回调地址。", 503);
  }

  private async load(): Promise<void> {
    if (!this.loaded) {
      const generation = this.generation;
      this.loaded = (async () => {
        let value: unknown;
        try { value = JSON.parse(await fs.readFile(this.tokenFile, "utf8")); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT" && generation === this.generation) this.connectionError = "本机授权记录不可读取，请重新连接；原文件未覆盖。";
          return;
        }
        if (generation !== this.generation) return;
        const row = object(value);
        if (row.version !== 1 || row.clientFingerprint !== this.fingerprint || typeof row.accessToken !== "string" || !row.accessToken
          || typeof row.refreshToken !== "string" || !row.refreshToken || typeof row.expiresAt !== "number" || !Number.isFinite(row.expiresAt)
          || typeof row.connectionId !== "string" || !Array.isArray(row.scopes)
          || !this.scopes.every(scope => (row.scopes as unknown[]).includes(scope))) {
          this.connectionError = "本机授权记录与当前配置不匹配或权限不足，请重新连接。"; return;
        }
        this.tokens = row as unknown as Tokens;
      })();
    }
    await this.loaded;
  }

  async access(): Promise<{ token: string; generation: number; connectionId: string }> {
    this.requireConfigured();
    await this.load();
    const generation = this.generation;
    if (!this.tokens) throw this.error("NOT_CONNECTED", "请先连接 Google。", 428);
    if (this.tokens.expiresAt <= this.now() + 60_000) {
      if (!this.refreshing) {
        const previous = this.tokens;
        const refresh = (async () => {
          try {
            const response = await this.oauth(new URLSearchParams({ client_id: this.clientId, client_secret: this.clientSecret,
              grant_type: "refresh_token", refresh_token: previous.refreshToken }));
            await this.commitTokens(this.parseTokens(response, previous.connectionId, previous), generation);
          } catch (error) {
            if (hasCode(error) && error.code === "OAUTH_EXPIRED") await this.expireConnection(generation);
            throw error;
          }
        })();
        this.refreshing = refresh;
        void refresh.then(() => { if (this.refreshing === refresh) this.refreshing = undefined; },
          () => { if (this.refreshing === refresh) this.refreshing = undefined; });
      }
      await this.refreshing;
    }
    this.assertGeneration(generation);
    if (!this.tokens) throw this.error("NOT_CONNECTED", "Google 已断开。", 428);
    return { token: this.tokens.accessToken, generation, connectionId: this.tokens.connectionId };
  }

  private parseTokens(response: Json, connectionId: string, previous?: Tokens): Tokens {
    const scopes = typeof response.scope === "string" ? response.scope.split(/\s+/).filter(Boolean) : previous?.scopes ?? [];
    const refreshToken = typeof response.refresh_token === "string" ? response.refresh_token : previous?.refreshToken;
    if (typeof response.access_token !== "string" || !response.access_token || !refreshToken
      || typeof response.expires_in !== "number" || !Number.isFinite(response.expires_in) || response.expires_in < 1
      || !this.scopes.every(scope => scopes.includes(scope))) {
      throw this.error("OAUTH_INCOMPLETE", "Google 未返回完整离线授权或所需权限，请重新授权并勾选所需权限。", 428);
    }
    return { version: 1, clientFingerprint: this.fingerprint, connectionId, accessToken: response.access_token,
      refreshToken, expiresAt: this.now() + Math.min(response.expires_in, 86400) * 1000, scopes };
  }

  private async commitTokens(tokens: Tokens, generation: number, replaceConnection = false): Promise<void> {
    await this.authWrite(async () => {
      this.assertGeneration(generation);
      try { await atomicJson(this.tokenFile, tokens); }
      catch { throw this.error("LOCAL_STATE_FAILED", "本机授权记录保存失败，未确认连接完成。", 503); }
      this.assertGeneration(generation);
      if (replaceConnection) this.generation++;
      this.tokens = tokens;
      this.loaded = Promise.resolve();
      this.connectionError = undefined;
    });
  }

  private async expireConnection(generation: number): Promise<void> {
    await this.authWrite(async () => {
      if (generation !== this.generation) return;
      this.tokens = undefined;
      this.loaded = Promise.resolve();
      this.connectionError = "Google 离线授权已失效，请重新连接。";
      try { await fs.rm(this.tokenFile, { force: true }); }
      catch { throw this.error("LOCAL_STATE_FAILED", "过期授权已停止使用，但本机清理失败，请检查存储后重新连接。", 503); }
    });
  }

  private authWrite(operation: () => Promise<void>): Promise<void> {
    const result = this.authWrites.then(operation);
    this.authWrites = result.catch(() => {});
    return result;
  }

  assertGeneration(generation: number): void {
    if (generation !== this.generation) throw this.error("CONNECTION_CHANGED", "Google 连接已变化，本次操作未继续；请重新确认目标账户。", 409, "rejected");
  }

  private async oauth(body: URLSearchParams): Promise<Json> {
    return this.http({ method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body });
  }

  private async http(init: RequestInit): Promise<Json> {
    let response: Response;
    try { response = await this.fetcher(TOKEN, { ...init, redirect: "error", signal: AbortSignal.timeout(20_000) }); }
    catch { throw this.error("GOOGLE_UNAVAILABLE", "无法连接 Google 授权服务，请检查网络或稍后重试。", 502); }
    if (!response.ok) {
      const status = response.status;
      if (status === 400 || status === 401) {
        let oauthError: unknown;
        try { oauthError = object(JSON.parse(await boundedResponse(response))).error; } catch { /* Never expose provider bodies. */ }
        if (oauthError === "invalid_grant" || status === 401) throw this.error("OAUTH_EXPIRED", "Google 离线授权已失效，请重新连接。", 428);
      }
      void response.body?.cancel().catch(() => {});
      throw this.error(status === 429 ? "RATE_LIMITED" : status === 403 ? "PERMISSION_DENIED" : "GOOGLE_REJECTED",
        `Google 授权服务返回 ${status}；未自动重试。`, status);
    }
    try {
      const value: unknown = JSON.parse(await boundedResponse(response));
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
      return value as Json;
    } catch { throw this.error("GOOGLE_RESPONSE_INVALID", "Google 授权服务返回了无效结果。", 502); }
  }
}

export async function atomicJson(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await fs.open(temporary, "wx", 0o600);
    try { await handle.writeFile(JSON.stringify(value, null, 2) + "\n"); await handle.sync(); }
    finally { await handle.close(); }
    await fs.rename(temporary, file);
  } finally { await fs.rm(temporary, { force: true }); }
}

export async function boundedResponse(response: Response, limit = MAX_BODY): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const parts: Uint8Array[] = [];
  let length = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > limit) throw new Error("response limit");
      parts.push(part.value);
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  return Buffer.concat(parts).toString("utf8");
}

function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
function equal(a: string, b: string): boolean { return timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest()); }
function object(value: unknown): Json { return value && typeof value === "object" && !Array.isArray(value) ? value as Json : {}; }
function string(value: unknown): string { return typeof value === "string" ? value : ""; }

function hasCode(error: unknown): error is GoogleOAuthError {
  return error instanceof Error && "code" in error;
}
