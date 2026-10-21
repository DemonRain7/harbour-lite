/** A positive page signal is required: a missing Generate button alone can also
 * mean that NovelAI is still loading or temporarily unavailable. */
export interface NovelAiAuthenticationIssue {
  kind: "login_required" | "verification_required";
  reason: string;
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

export function novelAiAuthenticationIssue(inspection: unknown): NovelAiAuthenticationIssue | undefined {
  const snapshot = record(inspection);
  const page = record(snapshot.page);
  const auth = record(snapshot.auth);
  const form = record(snapshot.form);
  const generation = record(snapshot.generation);
  let host = "", route = "";
  try {
    const url = new URL(String(page.url ?? ""));
    host = url.hostname.toLowerCase();
    // NovelAI can use either a path or a hash route for its sign-in screen.
    route = `${url.pathname}${url.hash.startsWith("#/") ? url.hash.slice(1) : ""}`.toLowerCase();
  } catch { /* Missing page URL is not proof of an expired session. */ }
  const novelAiHost = host === "novelai.net" || host.endsWith(".novelai.net");
  const challengePath = novelAiHost && /(?:^|\/)(?:captcha|challenge|verification)(?:\/|$)/.test(route);
  if (auth.challengeVisible === true || challengePath) return {
    kind: "verification_required", reason: "NovelAI 登录验证或验证码待人工完成；已暂停当前任务，未自动重试 Generate。",
  };
  const loginPath = novelAiHost && (host === "auth.novelai.net" ||
    /(?:^|\/)(?:login|log-in|signin|sign-in)(?:\/|$)/.test(route));
  const appReady = !!generation.button && Number(form.visiblePromptEditors) > 0;
  if (auth.expiredNoticeVisible === true || loginPath ||
    auth.loginFormVisible === true ||
    auth.loginActionVisible === true && (!appReady || record(snapshot.overlay).active === true)) return {
    kind: "login_required", reason: "NovelAI 登录状态已失效或页面要求登录；已暂停当前任务，请在隔离浏览器重新登录后从原 Job 恢复。",
  };
  return undefined;
}

export function novelAiAuthenticationFailureKey(submission?: { onceKey: string }): string | undefined {
  return submission?.onceKey ? `novelai:authentication:${submission.onceKey}` : undefined;
}
