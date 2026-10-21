/* Connection metadata only: no mailbox/map viewer, credentials form or background polling. */
(() => {
  "use strict";
  const escape = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  function oauthUrl(value) {
    try {
      const url = new URL(value);
      return url.origin === "https://accounts.google.com" && url.pathname === "/o/oauth2/v2/auth"
        && !url.username && !url.password && !url.hash ? url.href : "";
    } catch { return ""; }
  }
  const count = value => Number.isSafeInteger(value) && value >= 0 ? value.toLocaleString() : "—";
  const statusPill = (configured, connected, label) => `<span class="google-status${connected ? " is-connected" : ""}"><i aria-hidden="true"></i>${connected ? label || "已连接" : configured ? "待授权" : "未配置"}</span>`;

  function mount(root, options = {}) {
    if (!root || typeof options.api !== "function") throw new Error("Google integrations requires a root and api function");
    const api = options.api;
    const state = { status: null, loading: false, busy: false, error: "", note: "", authUrl: "", confirmDisconnect: false };
    let disposed = false, revision = 0, readController = null, actionController = null;
    const live = () => !disposed && root.isConnected && Boolean(root.querySelector("[data-google-integrations]"));
    const visible = () => live() && !document.hidden;
    const disabled = () => state.busy || state.loading ? " disabled" : "";

    function setup(service, key) {
      const missing = Array.isArray(service?.missing) ? service.missing.filter(value => typeof value === "string" && /^[A-Z][A-Z0-9_]{0,100}$/.test(value)) : [];
      return `<details class="google-setup"><summary>后端配置与授权范围</summary><div>
        <p>${key === "gmail" ? "可复用日历的 OAuth 客户端；在 Google Cloud 启用 Gmail API，并为同一客户端添加 Gmail 回调地址。" : "在 Google Cloud 启用 Calendar API，并配置后端 OAuth 客户端。"}</p>
        <p>授权回调地址（须与 Google Cloud 完全一致）：</p><code>${escape(service?.redirectUri || `/api/${key}/oauth/callback`)}</code>
        ${missing.length ? `<p>缺少环境配置：<span class="google-code-list">${missing.map(value => `<code>${escape(value)}</code>`).join(" ")}</span></p>` : ""}
        <p>${key === "gmail" ? "Gmail 仅请求 gmail.readonly：搜索和阅读邮件，不发送、不删除、不修改。" : "Calendar 用于读取日历、查询空闲以及创建、修改和删除日程。"}</p>
        ${key === "gmail" ? '<p>“断开 Gmail”仅移除当前后端的 Gmail 连接，不撤销 Google 侧授权。在 Google 账号权限页撤销整个应用、或由日历撤销共用的 OAuth 授权，才可能同时影响其它 Google 连接。</p>' : ""}
        <p>凭据只在后端 .env 配置；不要粘贴到聊天或此页面。变更配置后重启后端，再刷新状态。</p>
      </div></details>`;
    }
    function render() {
      if (disposed || !root.isConnected) return;
      const status = state.status, calendar = status?.calendar, gmail = status?.gmail, maps = status?.maps;
      const unknown = !status;
      root.innerHTML = `<section class="settings-section google-integrations" data-google-integrations aria-label="Google 集成">
        <header class="settings-section-head google-heading"><span class="settings-section-icon" aria-hidden="true">G</span><div><h3 class="settings-h">Google 集成</h3><p>日程、邮件与地点，按需连接到你的 Harbour。</p></div><button type="button" class="btn ghost" data-google-refresh${disabled()}>${state.loading ? "读取中…" : "刷新状态"}</button></header>
        <div class="settings-section-body google-body">
          <p class="google-privacy">连接凭据只留在后端。这一页仅查看配置与授权状态，不会读取邮件或查询地图。</p>
          <div class="google-message${state.error ? " is-error" : ""}" role="${state.error ? "alert" : "status"}" aria-live="polite"${!state.error && !state.note ? " hidden" : ""}>${escape(state.error || state.note)}</div>
          ${status?.credentialError ? '<p class="google-message is-error" role="alert">Google 凭据配置无法读取，请检查后端环境配置。此页面不会显示凭据内容。</p>' : ""}
          <div class="google-cards">
            <article class="google-card" data-google-card="calendar"><div class="google-card-heading"><span class="google-card-icon" aria-hidden="true">▦</span><div><span class="google-eyebrow">YOUR SCHEDULE</span><h4>Calendar <small>日历</small></h4></div>${unknown ? '<span class="google-status">状态未知</span>' : statusPill(calendar?.configured, calendar?.connected)}</div>
              <p>查看和安排日程，与同一 Google 账号的手机日历同步。</p>
              ${calendar?.connectionError ? '<p class="google-card-warning">授权状态读取失败，请到日历页检查连接。</p>' : ""}
              <div class="google-card-actions"><a class="btn ghost" href="#calendar">${calendar?.connected ? "打开日历" : "前往日历连接"} →</a></div>${setup(calendar, "calendar")}
            </article>
            <article class="google-card" data-google-card="gmail"><div class="google-card-heading"><span class="google-card-icon" aria-hidden="true">✉</span><div><span class="google-eyebrow">READ, WITH YOUR PERMISSION</span><h4>Gmail <small>邮件</small></h4></div>${unknown ? '<span class="google-status">状态未知</span>' : statusPill(gmail?.configured, gmail?.connected)}</div>
              <p>让 Main 帮你搜索和阅读邮件。仅只读授权，不发送、删除或修改邮件。</p>
              ${gmail?.connectionError ? '<p class="google-card-warning">授权状态读取失败，请检查后端或重新授权。</p>' : ""}
              <div class="google-card-actions">${gmail?.connected ? `<button type="button" class="btn ghost" data-google-disconnect${disabled()}>断开 Gmail</button>` : `<button type="button" class="btn primary" data-google-connect${!gmail?.configured || state.busy || state.loading ? " disabled" : ""}>连接 Gmail ↗</button>`}<span class="google-action-hint">${gmail?.configured ? "在 Google 官方页面完成授权" : "先完成后端 OAuth 配置"}</span></div>
              ${state.authUrl ? `<p class="google-auth-link">如果授权窗口未打开，<a href="${escape(state.authUrl)}" target="_blank" rel="noopener noreferrer">点击这里继续 Google 授权 ↗</a>。完成后刷新状态。</p>` : ""}
              ${state.confirmDisconnect ? `<div class="google-confirm" role="group" aria-label="确认断开 Gmail"><strong>在此后端断开 Gmail？</strong><p>只移除当前后端的 Gmail 令牌，不撤销 Google 侧授权，不会因此断开日历。若要撤销整个应用的授权，请到 Google 账号权限页操作。</p><div><button type="button" class="btn ghost" data-google-cancel${disabled()}>取消</button><button type="button" class="btn google-danger" data-google-confirm${disabled()}>${state.busy ? "正在断开…" : "确认断开"}</button></div></div>` : ""}
              ${setup(gmail, "gmail")}
            </article>
            <article class="google-card" data-google-card="maps"><div class="google-card-heading"><span class="google-card-icon" aria-hidden="true">⌖</span><div><span class="google-eyebrow">PLACES & ROUTES</span><h4>Maps <small>地点与路线</small></h4></div>${unknown ? '<span class="google-status">状态未知</span>' : statusPill(false, maps?.configured, "已配置")}</div>
              <p>由 Main 按需查询地点与路线；API Key 保存在后端，无需 Google 账号授权。</p>
              ${maps?.error ? '<p class="google-card-warning">本机用量记录异常，地图请求已停用，请检查后端记录。</p>' : maps?.configured && maps?.remaining === 0 ? '<p class="google-card-warning">今日本机请求上限已用完，地图请求暂不可用。</p>' : ""}
              <dl class="google-usage"><div><dt>今日请求</dt><dd>${count(maps?.requestsToday)}</dd></div><div><dt>每日上限</dt><dd>${count(maps?.dailyRequestLimit)}</dd></div><div><dt>今日剩余</dt><dd>${count(maps?.remaining)}</dd></div></dl>
              <p class="google-usage-note">按 UTC 日界统计的本机请求数，不是美元费用，也不代表 Google Cloud 账单或额度。</p>
              <details class="google-setup"><summary>后端配置与计费提示</summary><div><p>在后端 .env 配置 <code>GOOGLE_MAPS_API_KEY</code>；启用 Places API (New) 与 Routes API，并在 Google Cloud 关联结算账号。</p><p>按 API 和服务器来源限制密钥；实际价格、账单与用量以 Google Cloud 为准。配置后重启后端，再刷新状态。</p></div></details>
            </article>
          </div>
          <p class="google-footnote">授权状态表示本机连接记录，不保证 Google 服务实时可用；仅在打开本节、返回窗口或手动刷新时更新。</p>
        </div>
      </section>`;
    }
    async function refresh() {
      if (!visible() || state.busy) return;
      const current = ++revision;
      readController?.abort();
      const controller = new AbortController(); readController = controller;
      state.loading = true; state.error = ""; render();
      try {
        const result = await api("/api/google/status", { signal: controller.signal });
        if (!visible() || current !== revision) return;
        if (!result || typeof result.calendar !== "object" || !result.calendar || typeof result.gmail !== "object" || !result.gmail || typeof result.maps !== "object" || !result.maps) throw new Error("Invalid status");
        state.status = result;
        if (result.gmail.connected) { state.authUrl = ""; state.note = ""; }
        state.confirmDisconnect = false;
      } catch (error) {
        if (!visible() || current !== revision || controller.signal.aborted) return;
        state.error = error?.status === 404 ? "Google 集成接口不可用，请重启或更新 Harbour 后端后重试。" : "无法读取 Google 连接状态，请检查后端连接并刷新重试。";
      } finally {
        if (live() && current === revision) { state.loading = false; readController = null; render(); }
      }
    }
    async function action(kind) {
      if (!visible() || state.busy || state.loading) return;
      if (kind === "connect" && (!state.status?.gmail?.configured || state.status.gmail.connected)) return;
      if (kind === "disconnect" && (!state.status?.gmail?.connected || !state.confirmDisconnect)) return;
      state.busy = true; state.error = ""; state.note = ""; state.authUrl = "";
      const controller = new AbortController(); actionController = controller;
      render();
      let disconnected = false;
      try {
        const result = await api(`/api/gmail/${kind}`, { method: "POST", signal: controller.signal });
        if (!live() || controller.signal.aborted) return;
        if (kind === "connect") {
          const url = oauthUrl(result?.url);
          if (!url) { state.error = "Google 授权地址无效，已阻止打开。请检查后端配置。"; return; }
          state.authUrl = url;
          state.note = "请在 Google 页面完成只读授权，然后返回刷新状态。";
          if (visible()) window.open(url, "_blank", "noopener,noreferrer");
        } else {
          disconnected = true; state.confirmDisconnect = false;
          state.note = "已在当前后端断开 Gmail；Google 侧授权和日历连接保持不变。";
        }
      } catch {
        if (!live() || controller.signal.aborted) return;
        state.error = kind === "disconnect" ? "断开结果尚未确认，请刷新状态后检查；不会自动重试。" : "无法创建 Google 授权链接，请检查后端配置后重试。";
      } finally {
        if (live() && !controller.signal.aborted) {
          state.busy = false; actionController = null; render();
          if (disconnected) void refresh();
        }
      }
    }
    function onClick(event) {
      const button = event.target.closest("[data-google-refresh],[data-google-connect],[data-google-disconnect],[data-google-cancel],[data-google-confirm]");
      if (!button || !root.contains(button) || button.disabled || !visible() || state.busy) return;
      if (button.hasAttribute("data-google-refresh")) void refresh();
      else if (button.hasAttribute("data-google-connect")) void action("connect");
      else if (button.hasAttribute("data-google-disconnect")) { state.confirmDisconnect = true; state.error = ""; render(); root.querySelector("[data-google-cancel]")?.focus(); }
      else if (button.hasAttribute("data-google-cancel")) { state.confirmDisconnect = false; render(); root.querySelector("[data-google-disconnect]")?.focus(); }
      else if (button.hasAttribute("data-google-confirm")) void action("disconnect");
    }
    const onFocus = () => { if (visible() && !state.loading && !state.busy && !state.confirmDisconnect) void refresh(); };
    const onVisibility = () => {
      if (document.hidden) { ++revision; readController?.abort(); readController = null; state.loading = false; }
      else onFocus();
    };
    render();
    root.addEventListener("click", onClick);
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisibility);
    void refresh();
    return () => {
      if (disposed) return;
      disposed = true; ++revision; readController?.abort(); actionController?.abort();
      root.removeEventListener("click", onClick);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }
  window.HarbourGoogleIntegrations = { mount };
})();
