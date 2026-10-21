import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

const PLACES = "https://places.googleapis.com/v1/places";
const ROUTES = "https://routes.googleapis.com/directions/v2:computeRoutes";
const PLACE_FIELDS = "id,displayName,formattedAddress,location,businessStatus,attributions";
const ROUTE_FIELDS = "routes.distanceMeters,routes.duration,routes.description,routes.warnings";
const MAX_RESPONSE_BYTES = 256 * 1024;
const reservationQueues = new Map<string, Promise<void>>();
type Json = Record<string, unknown>;

export class MapsServiceError extends Error {
  constructor(public readonly code: string, message: string, public readonly statusCode = 400) {
    super(message); this.name = "MapsServiceError";
  }
}
export interface GoogleMapsServiceOptions {
  apiKey?: string;
  dailyRequestLimit?: number;
  dataDir?: string;
  fetch?: typeof fetch;
  now?: () => number;
}
export interface MapsRequestOptions { signal?: AbortSignal }
export interface MapsSearchInput {
  query: string;
  limit?: number;
  languageCode?: string;
  regionCode?: string;
  locationBias?: { latitude: number; longitude: number; radiusMeters: number };
}
export interface MapsPlaceInput { placeId: string; languageCode?: string }
export type MapsTravelMode = "drive" | "walk" | "bicycle" | "transit";
export interface MapsRouteInput { origin: string; destination: string; mode?: MapsTravelMode; languageCode?: string }
export interface MapsAttribution { provider: string; providerUri?: string }
export interface MapsPlace {
  placeId: string;
  name: string;
  address?: string;
  location?: { latitude: number; longitude: number };
  businessStatus?: string;
  googleMapsUrl: string;
  attributions: MapsAttribution[];
}
export interface MapsStatus {
  configured: boolean;
  ready: boolean;
  missing: string[];
  requestsToday: number;
  remaining: number;
  dailyRequestLimit: number;
  quotaDay: string;
  quotaTimeZone: "UTC";
  error?: string;
  message: string;
}
interface Usage { version: 1; day: string; requests: number }

/** The only Maps transport. A local request cap is not a Google Cloud monetary spending cap. */
export class GoogleMapsService {
  private readonly apiKey: string;
  private readonly directory: string;
  private readonly fetcher: typeof fetch;
  private readonly now: () => number;
  private readonly limit: number;
  private active = 0;

  constructor(options: GoogleMapsServiceOptions = {}) {
    this.apiKey = options.apiKey?.trim() ?? "";
    this.directory = path.resolve(options.dataDir ?? path.join(process.cwd(), "data", "maps"));
    this.fetcher = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.limit = options.dailyRequestLimit ?? 50;
    if (!Number.isSafeInteger(this.limit) || this.limit < 1 || this.limit > 10_000) {
      throw new MapsServiceError("INVALID_CONFIG", "GOOGLE_MAPS_DAILY_REQUEST_LIMIT 必须是 1–10000 的整数");
    }
  }

  async status(): Promise<MapsStatus> {
    let usage: Usage | undefined;
    let error: string | undefined;
    try { usage = await this.readUsage(); } catch { error = "本机 Maps 用量记录异常；请求已关闭，请先检查 data/maps 用量文件。"; }
    const requestsToday = usage?.requests ?? this.limit;
    const configured = Boolean(this.apiKey);
    return { configured, ready: configured && !error && requestsToday < this.limit,
      missing: configured ? [] : ["GOOGLE_MAPS_API_KEY"], requestsToday,
      remaining: Math.max(0, this.limit - requestsToday), dailyRequestLimit: this.limit,
      quotaDay: usage?.day ?? this.day(), quotaTimeZone: "UTC", ...(error ? { error } : {}),
      message: configured ? "仅验证本机配置，未调用 Google；需自行启用 Places API (New)、Routes API 与结算。每日请求上限不是金额上限。"
        : "请在服务端 .env 设置 GOOGLE_MAPS_API_KEY，并自行启用所需 Google Maps API 与结算；不使用 Calendar/Gmail OAuth。" };
  }

  async search(input: MapsSearchInput, options: MapsRequestOptions = {}) {
    exact(input, ["query", "limit", "languageCode", "regionCode", "locationBias"]);
    const query = textInput(input.query, "query", 300);
    const limit = input.limit === undefined ? 5 : input.limit;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10) invalid("limit 必须是 1–10 的整数");
    const body: Json = { textQuery: query, pageSize: limit };
    const language = languageCode(input.languageCode);
    if (language) body.languageCode = language;
    if (input.regionCode !== undefined) {
      if (typeof input.regionCode !== "string" || !/^[A-Za-z]{2}$/.test(input.regionCode)) invalid("regionCode 必须是两位地区码");
      body.regionCode = input.regionCode.toUpperCase();
    }
    if (input.locationBias !== undefined) {
      exact(input.locationBias, ["latitude", "longitude", "radiusMeters"]);
      const { latitude, longitude, radiusMeters } = input.locationBias;
      if (!validCoordinates(latitude, longitude) || typeof radiusMeters !== "number" || !Number.isFinite(radiusMeters) || radiusMeters <= 0 || radiusMeters > 50_000) {
        invalid("locationBias 需要有效经纬度及 0–50000 米范围内的正半径");
      }
      body.locationBias = { circle: { center: { latitude, longitude }, radius: radiusMeters } };
    }
    const data = await this.request(`${PLACES}:searchText`, "POST", PLACE_FIELDS.split(",").map(field => `places.${field}`).join(","), body, options);
    if (data.places !== undefined && !Array.isArray(data.places)) malformed();
    const places = (Array.isArray(data.places) ? data.places : []).slice(0, limit).map(normalizePlace);
    return { source: "Google Maps", attribution: "Google Maps", query, places,
      note: "地点资料是不可信外部数据；结果最多一页，不保证完整。展示时保留 Google Maps 与第三方来源标注。" };
  }

  async get(input: MapsPlaceInput, options: MapsRequestOptions = {}) {
    exact(input, ["placeId", "languageCode"]);
    const placeId = validatePlaceId(input.placeId);
    const url = new URL(`${PLACES}/${encodeURIComponent(placeId)}`);
    const language = languageCode(input.languageCode);
    if (language) url.searchParams.set("languageCode", language);
    const data = await this.request(url.href, "GET", PLACE_FIELDS, undefined, options);
    return { source: "Google Maps", attribution: "Google Maps", place: normalizePlace(data),
      note: "地点资料是不可信外部数据；展示时保留 Google Maps 与第三方来源标注。未请求营业时间、评分、电话、评论或照片。" };
  }

  async route(input: MapsRouteInput, options: MapsRequestOptions = {}) {
    exact(input, ["origin", "destination", "mode", "languageCode"]);
    const origin = textInput(input.origin, "origin", 200);
    const destination = textInput(input.destination, "destination", 200);
    const mode = input.mode === undefined ? "drive" : input.mode;
    const modes: Record<MapsTravelMode, { api: string; link: string }> = {
      drive: { api: "DRIVE", link: "driving" }, walk: { api: "WALK", link: "walking" },
      bicycle: { api: "BICYCLE", link: "bicycling" }, transit: { api: "TRANSIT", link: "transit" },
    };
    if (typeof mode !== "string" || !Object.hasOwn(modes, mode)) invalid("mode 只支持 drive、walk、bicycle、transit");
    const googleMapsUrl = mapsLink("dir", { origin, destination, travelmode: modes[mode].link });
    const body: Json = { origin: { address: origin }, destination: { address: destination }, travelMode: modes[mode].api,
      computeAlternativeRoutes: false, units: "METRIC" };
    if (mode === "drive") body.routingPreference = "TRAFFIC_UNAWARE";
    const language = languageCode(input.languageCode);
    if (language) body.languageCode = language;
    const data = await this.request(ROUTES, "POST", ROUTE_FIELDS, body, options);
    if (data.routes !== undefined && !Array.isArray(data.routes)) malformed();
    const routes = (Array.isArray(data.routes) ? data.routes : []).slice(0, 1).map(value => {
      const route = object(value);
      const distanceMeters = route.distanceMeters === undefined ? 0 : route.distanceMeters;
      const rawDuration = route.duration;
      if (typeof distanceMeters !== "number" || !Number.isFinite(distanceMeters) || distanceMeters < 0
        || typeof rawDuration !== "string" || !/^\d+(?:\.\d{1,9})?s$/.test(rawDuration)) malformed();
      const durationSeconds = Number(rawDuration.slice(0, -1));
      if (!Number.isFinite(durationSeconds)) malformed();
      return { distanceMeters, durationSeconds, ...(shortText(route.description, 300) ? { description: shortText(route.description, 300) } : {}),
        warnings: stringList(route.warnings, 20, 1000) };
    });
    return { source: "Google Maps", attribution: "Google Maps", origin, destination, mode, routes, googleMapsUrl,
      warnings: mode === "walk" || mode === "bicycle"
        ? ["步行与骑行路线仍为测试功能，可能缺少明确的人行道或自行车道；请结合现场路况、安全规则核对。"] : [],
      note: mode === "drive" ? "估计时长不考虑实时交通；链接会在 Google Maps 重新计算路线。" : "班次、时长与通行情况可能变化；链接会在 Google Maps 重新计算路线。" };
  }

  private day(): string { return new Date(this.now()).toISOString().slice(0, 10); }

  private async readUsage(): Promise<Usage> {
    let raw: string;
    try { raw = await fs.readFile(path.join(this.directory, "usage.json"), "utf8"); }
    catch (error) { if (isCode(error, "ENOENT")) return { version: 1, day: this.day(), requests: 0 }; throw error; }
    let value: unknown;
    try { value = JSON.parse(raw); } catch { throw new MapsServiceError("USAGE_UNAVAILABLE", "Maps 本机用量记录无法读取；为避免失控计费已拒绝请求。", 503); }
    const usage = object(value);
    if (usage.version !== 1 || typeof usage.day !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(usage.day)
      || typeof usage.requests !== "number" || !Number.isSafeInteger(usage.requests) || usage.requests < 0 || usage.day > this.day()) {
      throw new MapsServiceError("USAGE_UNAVAILABLE", "Maps 本机用量记录无效或时钟倒退；为避免失控计费已拒绝请求。", 503);
    }
    return usage.day === this.day() ? usage as unknown as Usage : { version: 1, day: this.day(), requests: 0 };
  }

  private async reserve(signal?: AbortSignal): Promise<void> {
    const previous = reservationQueues.get(this.directory) ?? Promise.resolve();
    const pending = previous.catch(() => {}).then(async () => {
      stopped(signal);
      await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
      const lockFile = path.join(this.directory, "usage.lock");
      let lock;
      try { lock = await fs.open(lockFile, "wx", 0o600); }
      catch { throw new MapsServiceError("USAGE_LOCKED", "Maps 用量记录正被另一进程使用或存在遗留锁；未发送请求，请先检查运行进程。", 503); }
      const temporary = path.join(this.directory, `usage-${randomUUID()}.tmp`);
      try {
        const usage = await this.readUsage();
        stopped(signal);
        if (usage.requests >= this.limit) throw new MapsServiceError("DAILY_LIMIT", `今日 Maps 请求已达本机上限 ${this.limit} 次（UTC 日界）；未发送请求。`, 429);
        // Reserve durably before the network: failed and uncertain requests still consume the cap.
        const output = await fs.open(temporary, "wx", 0o600);
        try { await output.writeFile(JSON.stringify({ ...usage, requests: usage.requests + 1 })); await output.sync(); }
        finally { await output.close(); }
        await fs.rename(temporary, path.join(this.directory, "usage.json"));
      } catch (error) {
        if (error instanceof MapsServiceError) throw error;
        throw new MapsServiceError("USAGE_UNAVAILABLE", "Maps 本机用量记录无法安全保存；未发送请求。", 503);
      } finally {
        await fs.unlink(temporary).catch(() => {});
        await lock.close();
        await fs.unlink(lockFile);
      }
    });
    const queue = pending.catch(() => {});
    reservationQueues.set(this.directory, queue);
    try { await pending; } finally { if (reservationQueues.get(this.directory) === queue) reservationQueues.delete(this.directory); }
  }

  private async request(url: string, method: "GET" | "POST", fields: string, body: Json | undefined, options: MapsRequestOptions): Promise<Json> {
    if (!this.apiKey) throw new MapsServiceError("NOT_CONFIGURED", "Google Maps 未配置：请在服务端 .env 设置 GOOGLE_MAPS_API_KEY；不要在聊天中提供密钥。", 503);
    stopped(options.signal);
    if (this.active >= 3) throw new MapsServiceError("BUSY", "Maps 已有 3 个进行中的请求，请等待它们完成。", 429);
    this.active++;
    const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000);
    try {
      await this.reserve(signal);
      stopped(signal);
      const response = await this.fetcher(url, { method, headers: { "X-Goog-Api-Key": this.apiKey, "X-Goog-FieldMask": fields,
        "Content-Type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}), redirect: "error", signal });
      const data = await boundedJson(response, signal);
      if (!response.ok) throw apiError(response.status, data);
      return data;
    } catch (error) {
      if (options.signal?.aborted) throw new MapsServiceError("ABORTED", "Maps 查询已停止；已发送的请求仍计入每日上限。", 499);
      if (signal.aborted) throw new MapsServiceError("TIMEOUT", "Google Maps 查询超时；未自动重试，本次预留仍计入每日上限。", 504);
      if (error instanceof MapsServiceError) throw error;
      throw new MapsServiceError("NETWORK_ERROR", "无法连接 Google Maps；检查服务端网络。未自动重试，本次预留仍计入每日上限。", 502);
    } finally { this.active--; }
  }
}

function invalid(message: string): never { throw new MapsServiceError("INVALID_INPUT", message); }
function malformed(): never { throw new MapsServiceError("INVALID_RESPONSE", "Google Maps 返回了不完整或无效的数据；未自动重试。", 502); }
function object(value: unknown): Json {
  if (!value || typeof value !== "object" || Array.isArray(value)) malformed();
  return value as Json;
}
function exact(value: unknown, keys: string[]): void {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key))) invalid("Maps 参数必须是对象且不能包含未声明字段");
}
function textInput(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) invalid(`${label} 必须是 1–${max} 字符的单行文字`);
  return value.trim();
}
function languageCode(value: unknown): string | undefined {
  if (value === undefined) return;
  if (typeof value !== "string" || !/^[a-zA-Z]{2,3}(?:-[a-zA-Z0-9]{2,8}){0,2}$/.test(value)) invalid("languageCode 必须是有效语言代码，例如 zh-CN 或 en-US");
  return value;
}
function validatePlaceId(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,256}$/.test(value)) invalid("placeId 必须使用搜索回执中的地点 ID，不接受网址或资源路径");
  return value;
}
function validCoordinates(latitude: unknown, longitude: unknown): boolean {
  return typeof latitude === "number" && Number.isFinite(latitude) && latitude >= -90 && latitude <= 90
    && typeof longitude === "number" && Number.isFinite(longitude) && longitude >= -180 && longitude <= 180;
}
function shortText(value: unknown, max: number): string | undefined {
  return typeof value === "string" && value.trim() ? value.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, max) : undefined;
}
function stringList(value: unknown, count: number, max: number): string[] {
  return Array.isArray(value) ? value.slice(0, count).flatMap(item => shortText(item, max) ? [shortText(item, max)!] : []) : [];
}
function mapsLink(action: "search" | "dir", params: Record<string, string>): string {
  const url = new URL(`https://www.google.com/maps/${action}/`);
  url.searchParams.set("api", "1");
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  if (url.href.length > 2048) invalid("地点文字过长，无法生成有效的 Google Maps 链接；请缩短具体地址");
  return url.href;
}
function attribution(value: unknown): MapsAttribution | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const item = value as Json;
  const provider = shortText(item.provider, 200);
  if (!provider) return;
  let providerUri: string | undefined;
  try {
    const url = new URL(String(item.providerUri));
    if (url.protocol === "https:" && !url.username && !url.password && url.href.length <= 2048) providerUri = url.href;
  } catch { /* Untrusted supplier URLs are never fetched. */ }
  return { provider, ...(providerUri ? { providerUri } : {}) };
}
function normalizePlace(value: unknown): MapsPlace {
  const item = object(value);
  if (typeof item.id !== "string" || !/^[A-Za-z0-9_-]{1,256}$/.test(item.id)) malformed();
  const displayName = item.displayName && typeof item.displayName === "object" ? (item.displayName as Json).text : undefined;
  const name = shortText(displayName, 200) ?? item.id;
  const location = item.location && typeof item.location === "object" ? item.location as Json : undefined;
  return { placeId: item.id, name, ...(shortText(item.formattedAddress, 500) ? { address: shortText(item.formattedAddress, 500) } : {}),
    ...(location && validCoordinates(location.latitude, location.longitude) ? { location: { latitude: location.latitude as number, longitude: location.longitude as number } } : {}),
    ...(shortText(item.businessStatus, 100) ? { businessStatus: shortText(item.businessStatus, 100) } : {}),
    googleMapsUrl: mapsLink("search", { query: name.slice(0, 100), query_place_id: item.id }),
    attributions: Array.isArray(item.attributions) ? item.attributions.slice(0, 20).flatMap(value => attribution(value) ? [attribution(value)!] : []) : [] };
}
function stopped(signal?: AbortSignal): void {
  if (signal?.aborted) throw new MapsServiceError("ABORTED", "Maps 查询已停止；已预留的请求仍计入每日上限。", 499);
}
function isCode(error: unknown, code: string): boolean { return Boolean(error && typeof error === "object" && "code" in error && error.code === code); }
async function boundedJson(response: Response, signal: AbortSignal): Promise<Json> {
  if (Number(response.headers.get("content-length")) > MAX_RESPONSE_BYTES) { await response.body?.cancel(); malformed(); }
  const reader = response.body?.getReader();
  if (!reader) malformed();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      stopped(signal);
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) { await reader.cancel(); malformed(); }
      chunks.push(chunk.value);
    }
    return object(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  } catch (error) { if (error instanceof MapsServiceError) throw error; malformed(); }
  finally { reader.releaseLock(); }
}
function apiError(status: number, data: Json): MapsServiceError {
  // Classify provider errors, but never return raw messages (may contain keys, project IDs or HTML).
  const text = JSON.stringify(data).toUpperCase();
  if (/BILLING/.test(text)) return new MapsServiceError("BILLING_REQUIRED", "Google Maps 项目未启用结算或结算不可用；请主人在 Google Cloud 控制台检查。", 403);
  if (/SERVICE_DISABLED|API_DISABLED|ACCESSNOTCONFIGURED|HAS NOT BEEN USED|IS DISABLED/.test(text)) return new MapsServiceError("API_DISABLED", "请主人在 Google Cloud 项目启用 Places API (New) 和 Routes API，并检查密钥 API 限制。", 403);
  if (status === 401 || /API_KEY_INVALID|API KEY NOT VALID/.test(text)) return new MapsServiceError("INVALID_KEY", "Google Maps API key 无效；请检查服务端 .env，勿在聊天中发送密钥。", 403);
  if (status === 403) return new MapsServiceError("PERMISSION_DENIED", "Google Maps 拒绝访问；请检查 API 启用、服务端 IP/API 密钥限制及结算状态。", 403);
  if (status === 429) return new MapsServiceError("GOOGLE_QUOTA", "Google Maps 配额或速率限制已触发；未自动重试。", 429);
  if (status === 404) return new MapsServiceError("NOT_FOUND", "Google Maps 未找到该地点；请重新搜索并核对 placeId。", 404);
  if (status === 400) return new MapsServiceError("GOOGLE_INVALID_REQUEST", "Google Maps 无法处理这些查询参数；请核对地址、语言或路线模式。", 400);
  return new MapsServiceError("GOOGLE_ERROR", "Google Maps 暂时不可用；未自动重试。", 502);
}
