import type { IncomingMessage, ServerResponse } from "node:http";
import { GmailServiceError, type GmailService } from "../gmail/service";
import type { GoogleCalendarService } from "../calendar/service";
import type { GoogleMapsService } from "../maps/service";

export const GMAIL_CALLBACK = "/api/gmail/oauth/callback";
type Json = (res: ServerResponse, status: number, value: unknown) => void;
interface Services { calendar?: GoogleCalendarService; gmail?: GmailService; maps?: GoogleMapsService; googleCredentialError?: string }

/** Only single-use PKCE state is allowed to authorize this Google redirect. No bearer in the URL. */
export async function gmailCallback(res: ServerResponse, url: URL, service?: GmailService): Promise<void> {
  let status = 200, message = "Gmail 只读连接已完成。可以关闭此页，回 Harbour 的 Settings → Google 刷新状态。";
  try {
    if (!service) throw new Error("unavailable");
    await service.completeAuth({ state: url.searchParams.get("state") || "", code: url.searchParams.get("code") || undefined,
      error: url.searchParams.get("error") || undefined });
  } catch {
    status = 400; message = "Gmail 授权未完成或已过期。请回 Harbour 重新连接；没有发送、修改或删除任何邮件。";
  }
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'" });
  res.end(`<!doctype html><html lang="zh"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Harbour Gmail 连接</title><body style="font:18px system-ui;background:#15151d;color:#eee;padding:8vh 8vw"><h1>Harbour · Gmail</h1><p>${message}</p><a style="color:#c1b7ff" href="/#settings">返回设置</a></body></html>`);
}

/** Management only; private mail/maps data is queried through the same owner-checked Agent tools. */
export async function googleApi(req: IncomingMessage, res: ServerResponse, url: URL, services: Services,
  readJson: (req: IncomingMessage) => Promise<Record<string, unknown>>, sendJson: Json): Promise<void> {
  res.setHeader("Cache-Control", "no-store");
  const route = `${req.method || "GET"} ${url.pathname}`;
  try {
    if (route === "GET /api/google/status") {
      const [calendar, gmail, maps] = await Promise.all([
        services.calendar?.status(), services.gmail?.status(), services.maps?.status(),
      ]);
      return sendJson(res, 200, { calendar, gmail, maps,
        ...(services.googleCredentialError ? { credentialError: services.googleCredentialError } : {}) });
    }
    if (route === "GET /api/maps/status") return services.maps
      ? sendJson(res, 200, await services.maps.status()) : sendJson(res, 503, { error: "Maps 服务未加载，请重启新版后端" });
    if (url.pathname.startsWith("/api/gmail/")) {
      if (!services.gmail) return sendJson(res, 503, { error: "Gmail 服务未加载，请重启新版后端" });
      if (route === "GET /api/gmail/status") return sendJson(res, 200, await services.gmail.status());
      if (route === "POST /api/gmail/connect" || route === "POST /api/gmail/disconnect") {
        const body = await readJson(req);
        if (Object.keys(body).length) return sendJson(res, 400, { error: "连接操作不接受额外参数" });
        if (route.endsWith("/connect")) return sendJson(res, 200, await services.gmail.beginAuth());
        return sendJson(res, 200, await services.gmail.disconnect());
      }
    }
    sendJson(res, 404, { error: "Google 接口不存在" });
  } catch (error) {
    if (error instanceof GmailServiceError) return sendJson(res, error.httpStatus, { error: error.message, code: error.code });
    sendJson(res, 503, { error: "Google 连接状态读取失败，请检查后端配置后刷新。", code: "google_unavailable" });
  }
}
