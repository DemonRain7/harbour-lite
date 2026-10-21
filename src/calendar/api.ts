import type { IncomingMessage, ServerResponse } from "node:http";
import { CalendarServiceError, type GoogleCalendarService } from "./service";

export const CALENDAR_CALLBACK = "/api/calendar/oauth/callback";
type Json = (res: ServerResponse, status: number, value: unknown) => void;

/** The OAuth callback uses a short-lived, single-use state, not a Harbour bearer in a URL. */
export async function calendarCallback(res: ServerResponse, url: URL, service?: GoogleCalendarService): Promise<void> {
  let message = "日历已连接，可以关闭此页并回到 Harbour 日历。", status = 200;
  try {
    if (!service) throw new Error("unavailable");
    await service.completeAuth({ state: url.searchParams.get("state") || "", code: url.searchParams.get("code") || undefined,
      error: url.searchParams.get("error") || undefined });
  } catch {
    status = 400; message = "日历授权未完成或已过期。请回到 Harbour 日历页重新连接；没有创建或修改日程。";
  }
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'" });
  res.end(`<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Harbour 日历连接</title><body style="font:18px system-ui;background:#15151d;color:#eee;padding:8vh 8vw"><h1>Harbour · Calendar</h1><p>${message}</p><a style="color:#c1b7ff" href="/#calendar">返回日历</a></body></html>`);
}

export async function calendarApi(req: IncomingMessage, res: ServerResponse, url: URL, service: GoogleCalendarService | undefined,
  readJson: (req: IncomingMessage) => Promise<Record<string, unknown>>, sendJson: Json): Promise<void> {
  res.setHeader("Cache-Control", "no-store");
  const pathname = url.pathname, method = req.method || "GET";
  try {
    if (!service) return sendJson(res, 503, { error: "日历服务尚未加载，请重启新版后端", code: "calendar_unavailable" });
    if (pathname === "/api/calendar/status" && method === "GET") return sendJson(res, 200, await service.status());
    if (pathname === "/api/calendar/connect" && method === "POST") return sendJson(res, 200, await service.beginAuth());
    if (pathname === "/api/calendar/disconnect" && method === "POST") {
      await service.disconnect(); return sendJson(res, 200, { disconnected: true });
    }
    if (pathname === "/api/calendar/calendars" && method === "GET") return sendJson(res, 200, await service.calendars());
    const calendarId = url.searchParams.get("calendarId") || undefined;
    if (pathname === "/api/calendar/events" && method === "GET") return sendJson(res, 200, await service.events({ calendarId,
      timeMin: url.searchParams.get("timeMin") || "", timeMax: url.searchParams.get("timeMax") || "", q: url.searchParams.get("q") || undefined }));
    if (pathname === "/api/calendar/slots" && method === "GET") {
      const raw = url.searchParams.get("calendarIds"), weekend = url.searchParams.get("excludeWeekends");
      let calendarIds: string[] | undefined;
      try { calendarIds = raw ? JSON.parse(raw) : undefined; } catch { return sendJson(res, 400, { error: "calendarIds 必须是 JSON 数组" }); }
      if (weekend !== null && !["true", "false"].includes(weekend)) return sendJson(res, 400, { error: "excludeWeekends 必须是 true 或 false" });
      return sendJson(res, 200, await service.findSlots({ calendarIds,
        timeMin: url.searchParams.get("timeMin") || "", timeMax: url.searchParams.get("timeMax") || "",
        durationMinutes: Number(url.searchParams.get("durationMinutes") || 60), timeZone: url.searchParams.get("timeZone") || "",
        ...(url.searchParams.has("workStartHour") ? { workStartHour: Number(url.searchParams.get("workStartHour")) } : {}),
        ...(url.searchParams.has("workEndHour") ? { workEndHour: Number(url.searchParams.get("workEndHour")) } : {}),
        ...(weekend !== null ? { excludeWeekends: weekend === "true" } : {}),
      }));
    }
    if (pathname === "/api/calendar/events" && method === "POST") {
      const body = await readJson(req);
      if (Object.keys(body).some(key => !["calendarId", "requestId", "event"].includes(key))) return sendJson(res, 400, { error: "未声明的日历创建参数" });
      return sendJson(res, 200, await service.create(body as unknown as Parameters<GoogleCalendarService["create"]>[0]));
    }
    if (pathname.startsWith("/api/calendar/events/")) {
      let eventId: string;
      try { eventId = decodeURIComponent(pathname.slice("/api/calendar/events/".length)); } catch { return sendJson(res, 400, { error: "事件 ID 无效" }); }
      if (method === "GET") return sendJson(res, 200, await service.get({ calendarId, eventId }));
      if (method === "PATCH" || method === "DELETE") {
        const body = await readJson(req);
        if (Object.keys(body).some(key => !(method === "PATCH" ? ["calendarId", "etag", "event"] : ["calendarId", "etag"]).includes(key))) return sendJson(res, 400, { error: "未声明的日历修改参数" });
        return sendJson(res, 200, method === "PATCH"
          ? await service.update({ ...body, eventId } as Parameters<GoogleCalendarService["update"]>[0])
          : await service.remove({ ...body, eventId } as Parameters<GoogleCalendarService["remove"]>[0]));
      }
    }
    sendJson(res, 404, { error: "日历接口不存在" });
  } catch (error) {
    if (error instanceof CalendarServiceError) return sendJson(res, error.httpStatus, { error: error.message, code: error.code, writeOutcome: error.writeOutcome });
    // Never echo raw provider responses, OAuth codes, tokens or arbitrary request bodies.
    sendJson(res, 500, { error: "日历请求未完成，请查询状态后再操作；不要重复提交未知写入。", code: "calendar_failed" });
  }
}
