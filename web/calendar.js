/* Calendar owns only its mounted page and compact response cards. No global polling or model calls. */
(() => {
  "use strict";
  const escape = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const zoneOr = value => {
    for (const zone of [value, window.HarbourTime?.getTimeZone?.(), "America/New_York"]) {
      if (!zone) continue;
      try { new Intl.DateTimeFormat("en", { timeZone: zone }).format(); return zone; } catch { /* Try the host's configured display timezone. */ }
    }
    return "America/New_York";
  };
  const pad = number => String(number).padStart(2, "0");
  const requestId = () => {
    if (typeof window.crypto.randomUUID === "function") return window.crypto.randomUUID();
    const bytes = window.crypto.getRandomValues(new Uint8Array(16));
    bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
    return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("").replace(/^(........)(....)(....)(....)(............)$/, "$1-$2-$3-$4-$5");
  };
  const validDay = value => { const date = new Date(`${value}T12:00:00Z`); return /^\d{4}-\d{2}-\d{2}$/.test(value || "") && Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value; };
  const addDays = (day, amount) => new Date(Date.parse(`${day}T12:00:00Z`) + amount * 86400000).toISOString().slice(0, 10);
  function parts(value, zone) {
    const date = new Date(value);
    if (!Number.isFinite(date.getTime())) return null;
    const fields = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: zoneOr(zone), year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(date).map(item => [item.type, item.value]));
    return { day: `${fields.year}-${fields.month}-${fields.day}`, time: `${fields.hour}:${fields.minute}`, seconds: fields.second };
  }
  // Resolve wall-clock input against IANA rules, never the computer's possibly different timezone.
  function localInstant(day, time, zone) {
    if (!validDay(day) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error("请填写有效的日期和时间。");
    const wanted = `${day}T${time}:00`, nominal = Date.parse(`${wanted}Z`), offsets = new Set();
    for (const delta of [-36, -12, 0, 12, 36]) {
      const stamp = nominal + delta * 3600000, p = parts(stamp, zone);
      offsets.add(Date.parse(`${p.day}T${p.time}:${p.seconds}Z`) - stamp);
    }
    const candidates = [...offsets].map(offset => nominal - offset).filter(stamp => { const p = parts(stamp, zone); return p.day === day && p.time === time; });
    if (!candidates.length) throw new Error("这个时间在夏令时切换中不存在，请选择其它时间。");
    if (candidates.length > 1) throw new Error("这个时间在夏令时切换中出现两次，请选择明确的其它时间，或在 Google 日历中编辑。");
    const offset = (nominal - candidates[0]) / 60000, absolute = Math.abs(offset);
    return `${wanted}${offset < 0 ? "-" : "+"}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`;
  }
  function eventDay(event, zone) { return validDay(event?.start?.date) ? event.start.date : parts(event?.start?.dateTime, zone)?.day || ""; }
  function eventTime(event, zone) {
    if (event?.start?.date) return "全天";
    const start = parts(event?.start?.dateTime, zone), end = parts(event?.end?.dateTime, zone);
    return start ? `${start.time}${end ? ` – ${end.day !== start.day ? `${end.day} ` : ""}${end.time}` : ""}` : "时间待确认";
  }
  function googleLink(value, auth = false) {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && !url.username && !url.password && (auth ? url.hostname === "accounts.google.com" : url.hostname === "calendar.google.com" || url.hostname === "www.google.com" && url.pathname.startsWith("/calendar/")) ? url.href : "";
    } catch { return ""; }
  }
  function calendarLink(day, id, calendarId) {
    const query = new URLSearchParams();
    if (validDay(day)) query.set("date", day);
    if (id) query.set("event", String(id));
    if (calendarId) query.set("calendar", String(calendarId));
    return `#calendar${query.size ? `?${query}` : ""}`;
  }
  const weekdays = [["MO", "一"], ["TU", "二"], ["WE", "三"], ["TH", "四"], ["FR", "五"], ["SA", "六"], ["SU", "日"]];
  const weekdayOf = day => weekdays[(new Date(`${day}T12:00:00Z`).getUTCDay() + 6) % 7][0];
  // One bounded Google recurrence, not a collection of independently created events.
  // Keep the first DTSTART on a chosen weekday so it cannot become an extra off-pattern event.
  function weeklyEditor(form, zone) {
    const fields = form.elements, firstDay = fields.startDate.value;
    const schedule = form.querySelector("[data-schedule]"), singleDates = schedule.querySelector("[data-single-dates]");
    const initialSpan = Math.max(0, Math.round((Date.parse(fields.endDate.value) - Date.parse(firstDay)) / 86400000));
    schedule.insertAdjacentHTML("afterbegin", `<fieldset class="cal-schedule-kind"><legend>安排方式</legend><div class="cal-schedule-choices">
      <label class="cal-schedule-choice"><input type="radio" name="repeat" value="none" checked><span><strong>单次日程</strong><small>指定日期，仅此一次</small></span></label>
      <label class="cal-schedule-choice"><input type="radio" name="repeat" value="weekly"><span><strong>每周重复</strong><small>选择星期，按周安排</small></span></label>
    </div></fieldset>
    <fieldset class="cal-repeat-days" data-repeat-options hidden><legend>每周哪几天</legend><div class="cal-weekday-choices">${weekdays.map(([value, label]) => `<label class="cal-weekday"><input type="checkbox" name="repeatDays" value="${value}" aria-label="周${label}"${value === weekdayOf(firstDay) ? " checked" : ""}><span aria-hidden="true">${label}</span></label>`).join("")}</div></fieldset>`);
    schedule.insertAdjacentHTML("beforeend", `<section class="cal-repeat" data-repeat-options aria-label="每周日程生效范围" hidden>
      <details class="cal-repeat-span" data-repeat-span${initialSpan ? " open" : ""}><summary>跨天安排（可选）</summary><label>每次结束于几天后（0 为当天）<input name="repeatSpan" type="number" min="0" max="366" step="1" value="${initialSpan}"></label></details>
      <h3>生效范围</h3>
      <div class="cal-form-pair"><label>从哪天起生效<input name="repeatFrom" type="date" value="${firstDay}"></label><label>结束重复<select name="repeatEnd" aria-label="结束重复"><option value="count">按次数结束</option><option value="until">到指定日期</option></select></label></div>
      <label data-repeat-count>总共发生几次<input name="repeatCount" type="number" min="1" max="1000" step="1" value="12"><small>包含首次；选中多天时，每次日程分别计数。</small></label>
      <label data-repeat-until hidden>重复到哪天（含当天）<input name="repeatUntil" type="date" value="${addDays(firstDay, 84)}"></label>
      <p class="cal-repeat-summary" data-repeat-summary role="status" aria-live="polite"></p>
    </section>`);
    const summary = schedule.querySelector("[data-repeat-summary]");
    function readRule() {
      if (fields.repeat.value !== "weekly") return null;
      const start = fields.repeatFrom.value;
      if (!validDay(start)) throw new Error("请填写有效的生效日期。");
      const chosen = new Set([...schedule.querySelectorAll('[name="repeatDays"]:checked')].map(input => input.value));
      const days = weekdays.filter(([value]) => chosen.has(value));
      if (!days.length) throw new Error("请至少选择一个重复的星期。");
      let shift = 0;
      while (shift < 7 && !chosen.has(weekdayOf(addDays(start, shift)))) shift += 1;
      const first = addDays(start, shift);
      const span = Number(fields.repeatSpan.value);
      if (!fields.repeatSpan.value || !Number.isInteger(span) || span < 0 || span > 366) throw new Error("每次跨天数须为 0–366 的整数，0 表示当天结束。");
      const end = addDays(first, span);
      const startTime = fields.startTime.value, endTime = fields.endTime.value;
      if (!fields.allDay.checked) {
        const startInstant = localInstant(first, startTime, zone), endInstant = localInstant(end, endTime, zone);
        if (Date.parse(endInstant) <= Date.parse(startInstant)) throw new Error("结束时间须晚于开始；跨夜日程请展开「跨天安排」设置次日结束。");
      }
      let ending, label;
      if (fields.repeatEnd.value === "until") {
        const until = fields.repeatUntil.value;
        if (!validDay(until) || until < first) throw new Error("重复截止日期不能早于首次日程。");
        // Google expects DATE for all-day recurrence and UTC for timed recurrence.
        const cutoff = fields.allDay.checked ? until.replace(/-/g, "")
          : new Date(Date.parse(localInstant(addDays(until, 1), "00:00", zone)) - 1000).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
        ending = `UNTIL=${cutoff}`; label = `至 ${until}（含当天）`;
      } else {
        const count = Number(fields.repeatCount.value);
        if (!Number.isInteger(count) || count < 1 || count > 1000) throw new Error("重复次数须为 1–1000 的整数，包含第一次。");
        ending = `COUNT=${count}`; label = `共 ${count} 次（含第一次）`;
      }
      const timeLabel = fields.allDay.checked ? `全天${span ? ` · 每次 ${span + 1} 天` : ""}` : `${startTime} – ${span ? `${span === 1 ? "次日" : `${span} 天后`} ` : ""}${endTime}`;
      return { first, end, recurrence: [`RRULE:FREQ=WEEKLY;BYDAY=${days.map(([value]) => value).join(",")};${ending}`], label: `每周${days.map(([, label]) => label).join("、")} · ${timeLabel} · ${label}` };
    }
    function update() {
      const weekly = fields.repeat.value === "weekly", byDate = fields.repeatEnd.value === "until";
      singleDates.hidden = weekly;
      [fields.startDate, fields.endDate].forEach(input => { input.disabled = weekly; input.required = !weekly; });
      schedule.querySelectorAll('[data-repeat-options]').forEach(element => { element.hidden = !weekly; });
      schedule.querySelectorAll('[name="repeatDays"]').forEach(input => { input.disabled = !weekly; });
      [fields.repeatFrom, fields.repeatSpan].forEach(input => { input.disabled = !weekly; input.required = weekly; });
      fields.repeatEnd.disabled = !weekly;
      fields.repeatCount.disabled = !weekly || byDate; fields.repeatCount.required = weekly && !byDate;
      fields.repeatUntil.disabled = !weekly || !byDate; fields.repeatUntil.required = weekly && byDate;
      schedule.querySelector("[data-repeat-count]").hidden = byDate;
      schedule.querySelector("[data-repeat-until]").hidden = !byDate;
      fields.repeatUntil.min = validDay(fields.repeatFrom.value) ? fields.repeatFrom.value : "";
      if (!weekly) { summary.textContent = ""; return; }
      try {
        const rule = readRule();
        summary.textContent = `${rule.label}\n首次：${rule.first}${fields.allDay.checked ? "" : ` · ${zone}`}`;
        summary.classList.remove("is-error");
      } catch (error) { summary.textContent = error.message; summary.classList.add("is-error"); }
    }
    form.addEventListener("input", update); form.addEventListener("change", update); update();
    return { read: readRule };
  }
  function cardsHtml(cards) {
    if (!Array.isArray(cards)) return "";
    const labels = { listed: "日程", created: "已创建", updated: "已更新", deleted: "已删除", slots: "可用时间" };
    return cards.slice(0, 8).filter(card => card && labels[card.action]).map(card => {
      const events = Array.isArray(card.events) ? card.events : [], slots = Array.isArray(card.slots) ? card.slots : [];
      const zone = zoneOr(card.timeZone || events[0]?.start?.timeZone || slots[0]?.timeZone);
      const items = card.action === "slots" ? slots.slice(0, 4).map(slot => {
        const start = parts(slot?.start, zone), end = parts(slot?.end, zone);
        return start ? `<a class="cal-response-item" href="${escape(calendarLink(start.day))}"><strong>${escape(start.day)}</strong><span>${escape(`${start.time} – ${end?.time || "?"}`)}</span></a>` : "";
      }) : events.slice(0, 4).filter(Boolean).map(event => `<a class="cal-response-item" href="${escape(calendarLink(eventDay(event, zone), event.id, event.calendarId))}"><strong>${escape(event.summary || "未命名日程")}</strong><span>${escape(`${eventDay(event, zone)} · ${eventTime(event, zone)}`)}</span></a>`);
      const total = card.action === "slots" ? slots.length : events.length;
      return `<section class="cal-response" aria-label="日历结果"><div class="cal-response-heading"><span class="cal-response-badge">${labels[card.action]}</span><small>${escape(zone)}</small></div>${items.join("") || '<p class="cal-muted">没有匹配的项目。</p>'}<a class="cal-response-open" href="#calendar">打开日历${total > 4 ? ` · 另有 ${total - 4} 项` : ""} →</a></section>`;
    }).join("");
  }

  function mount(root, options = {}) {
    if (!root || typeof options.api !== "function") throw new Error("Calendar requires a root and api function");
    const api = options.api, baseZone = zoneOr(options.timeZone), now = parts(Date.now(), baseZone).day;
    const initialDay = validDay(options.initialDate) ? options.initialDate : now;
    const state = { status: null, calendars: [], calendarId: options.initialCalendarId || "", zone: baseZone, day: initialDay, month: initialDay.slice(0, 7), events: [], loading: true, error: "", note: "", query: "", truncated: false };
    let disposed = false, revision = 0, controller = null, dialog = null, connecting = false, poll = null, unregisterEditor = null;
    let openEventId = options.initialEventId || "";
    root.classList.add("harbour-calendar");
    const read = (url, signal) => api(url, { signal });
    const write = (url, method, body) => api(url, { method, body: JSON.stringify(body || {}) });
    const currentCalendar = () => state.calendars.find(item => item.id === state.calendarId);
    const writable = () => ["owner", "writer"].includes(currentCalendar()?.accessRole);
    const fail = error => String(error?.message || "日历暂时不可用，请稍后刷新。");
    const live = () => !disposed;
    function banner() {
      const area = root.querySelector("[data-cal-message]");
      if (area) { area.textContent = state.error || state.note; area.className = `cal-message${state.error ? " is-error" : ""}`; area.hidden = !(state.error || state.note); area.setAttribute("role", state.error ? "alert" : "status"); }
    }
    function range() {
      const first = `${state.month}-01`, weekday = (new Date(`${first}T12:00Z`).getUTCDay() + 6) % 7;
      const start = addDays(first, -weekday);
      return { start, end: addDays(start, 42) };
    }
    function matchesDay(event, day) {
      const start = eventDay(event, state.zone);
      if (!start || event.status === "cancelled") return false;
      if (event.start.date) return start <= day && day < (event.end?.date || addDays(start, 1));
      const end = parts(event.end?.dateTime, state.zone);
      return start <= day && day <= (end?.day || start) && !(end?.day === day && end.time === "00:00" && start !== day);
    }
    function renderAgenda() {
      const target = root.querySelector("[data-cal-agenda]");
      if (!target) return;
      const events = state.events.filter(event => matchesDay(event, state.day)).sort((a, b) => String(a.start.date || a.start.dateTime).localeCompare(String(b.start.date || b.start.dateTime)));
      target.innerHTML = `<header class="cal-agenda-heading"><div><span class="cal-eyebrow">当天日程</span><h2>${escape(state.day)}</h2></div><span class="cal-count">${events.length}</span></header>${state.loading ? '<p class="cal-muted" role="status">正在同步…</p>' : ""}${events.map((event, index) => `<button type="button" class="cal-agenda-event" data-agenda-index="${index}"><span class="cal-event-time">${escape(eventTime(event, state.zone))}</span><strong>${escape(event.summary || "未命名日程")}</strong>${event.location ? `<span class="cal-muted">${escape(event.location)}</span>` : ""}${event.recurrence?.length || event.recurringEventId ? '<span class="cal-muted">↻ 重复日程 · 在 Google 中管理</span>' : ""}</button>`).join("") || (!state.loading ? '<div class="cal-empty"><span aria-hidden="true">☀</span><p>这一天还没有日程</p><small>留一些空白，也可以安排新的事情。</small></div>' : "")}`;
      target.querySelectorAll("[data-agenda-index]").forEach(button => button.addEventListener("click", () => openEditor(events[Number(button.dataset.agendaIndex)])));
    }
    function renderGrid() {
      const target = root.querySelector("[data-cal-grid]");
      if (!target) return;
      const { start } = range(), today = parts(Date.now(), state.zone).day;
      target.innerHTML = Array.from({ length: 42 }, (_, index) => {
        const day = addDays(start, index), events = state.events.filter(event => matchesDay(event, day));
        return `<button type="button" class="cal-day${day.slice(0, 7) !== state.month ? " is-outside" : ""}${day === state.day ? " is-selected" : ""}${day === today ? " is-today" : ""}" data-day="${day}" aria-label="${day}，${events.length} 项日程" aria-pressed="${day === state.day}"><span class="cal-day-number">${Number(day.slice(-2))}</span><span class="cal-day-events">${events.slice(0, 2).map(event => `<span>${escape(event.summary || "未命名日程")}</span>`).join("")}${events.length > 2 ? `<small>+${events.length - 2} 项</small>` : ""}</span></button>`;
      }).join("");
      target.querySelectorAll("[data-day]").forEach(button => button.addEventListener("click", () => { state.day = button.dataset.day; renderGrid(); renderAgenda(); }));
    }
    function slotsHtml() {
      return `<details class="cal-slots">
        <summary>
          <span class="cal-slots-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3 2"/></svg></span>
          <span class="cal-slots-heading"><strong>找一个空闲时间</strong><span>先查看空档，确认后再安排日程</span></span>
          <svg class="cal-slots-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m7 10 5 5 5-5"/></svg>
        </summary>
        <form data-cal-slots-form class="cal-slots-form">
          <div class="cal-slots-fields">
            <fieldset class="cal-slots-group cal-slots-dates"><legend>查询日期</legend><div class="cal-slots-pair">
              <label>开始日期<input type="date" name="from" value="${state.day}" required></label>
              <label>结束日期<input type="date" name="to" value="${addDays(state.day, 6)}" required></label>
            </div></fieldset>
            <fieldset class="cal-slots-group"><legend>需要多久</legend>
              <label>连续空闲时长<span class="cal-slots-duration"><input type="number" name="duration" aria-label="连续空闲时长（分钟）" value="60" min="5" max="1440" required><span aria-hidden="true">分钟</span></span></label>
            </fieldset>
            <fieldset class="cal-slots-group"><legend>每天的时间段</legend><div class="cal-slots-pair">
              <label>开始（24 小时制）<input type="number" name="workStart" value="9" min="0" max="23" required></label>
              <label>结束（24 小时制）<input type="number" name="workEnd" value="18" min="1" max="24" required></label>
            </div></fieldset>
          </div>
          <div class="cal-slots-actions"><label class="cal-check"><input type="checkbox" name="weekends" checked>跳过周末</label><p class="cal-slots-context">仅查询当前日历 · ${escape(state.zone)}</p><button type="submit" class="cal-button is-primary">查找空档 <span aria-hidden="true">→</span></button></div>
        </form>
        <div class="cal-slots-results" data-cal-slots-results role="status" aria-live="polite" aria-atomic="true"></div>
      </details>`;
    }
    function render() {
      if (!live()) return;
      const connected = state.status?.connected, configured = state.status?.configured;
      root.innerHTML = `<header class="cal-page-heading"><div><span class="cal-eyebrow">YOUR TIME, TOGETHER</span><h1>日历 <span>Calendar</span></h1><p class="cal-muted">日程与空闲时间，在这里一起安排。</p></div><div class="cal-heading-actions"><span class="cal-connection ${connected ? "is-connected" : ""}">${connected ? "Google 已连接" : "尚未连接"}</span><button class="cal-button" data-cal-refresh type="button">刷新</button>${connected ? '<button class="cal-button cal-subtle" data-cal-disconnect type="button">断开连接</button>' : ""}</div></header><div data-cal-message hidden></div>`;
      root.querySelector("[data-cal-refresh]").onclick = () => void boot();
      if (connected) root.querySelector("[data-cal-disconnect]").onclick = openDisconnect;
      if (state.loading && !state.status) { root.insertAdjacentHTML("beforeend", '<div class="cal-connect-card" role="status">正在读取日历连接…</div>'); banner(); return; }
      if (!connected) {
        root.insertAdjacentHTML("beforeend", `<section class="cal-connect-card"><span class="cal-connect-icon" aria-hidden="true">▦</span><h2>${configured ? "把日程带进 Harbour" : "先配置 Google 日历连接"}</h2><p>连接后可查看、创建和修改日程，查找空闲时间。手机上使用同一个 Google 日历账号即可同步。</p>${configured ? '<button type="button" class="cal-button is-primary" data-cal-connect>连接 Google Calendar ↗</button><p class="cal-muted">将在外部浏览器完成 Google 授权，不在 Harbour 内输入密码。</p><div data-cal-auth-link></div>' : `<div class="cal-setup"><p>在后端环境中配置 OAuth 客户端：</p><code>GOOGLE_CALENDAR_CLIENT_ID<br>GOOGLE_CALENDAR_CLIENT_SECRET<br>GOOGLE_CALENDAR_REDIRECT_URI</code><p>授权回调地址须与 Google Cloud 控制台完全一致：</p><code>${escape(state.status?.redirectUri || "http://localhost:7788/api/calendar/oauth/callback")}</code>${Array.isArray(state.status?.missing) && state.status.missing.length ? `<p>缺少：${escape(state.status.missing.join("、"))}</p>` : ""}<p class="cal-muted">凭据仅保存在后端，不填写到聊天或网页中；配置后重启 Harbour 后端，再点击刷新。</p></div>`}</section>`);
        const connect = root.querySelector("[data-cal-connect]");
        if (connect) connect.onclick = () => void startConnect(connect);
        banner(); return;
      }
      root.insertAdjacentHTML("beforeend", `<div class="cal-toolbar"><label class="cal-calendar-picker"><span>日历</span><select data-cal-calendar aria-label="选择日历">${state.calendars.map(item => `<option value="${escape(item.id)}"${item.id === state.calendarId ? " selected" : ""}>${escape(item.summary || item.id)}${item.primary ? " · 主日历" : ""}</option>`).join("")}</select></label><span class="cal-zone" title="当前日历时区">${escape(state.zone)}</span><form class="cal-search" data-cal-search><input type="search" name="q" aria-label="搜索当月日程" placeholder="搜索当月日程" value="${escape(state.query)}"><button type="submit" class="cal-button">搜索</button></form><button type="button" class="cal-button is-primary" data-cal-new${!writable() ? " disabled" : ""}>＋ 新建日程</button></div><div class="cal-layout"><section class="cal-month"><header class="cal-month-heading"><h2>${escape(state.month.replace("-", " 年 "))} 月</h2><div class="cal-month-nav"><button type="button" class="cal-button" data-cal-prev aria-label="上个月">‹</button><button type="button" class="cal-button" data-cal-today>今天</button><button type="button" class="cal-button" data-cal-next aria-label="下个月">›</button></div></header><div class="cal-weekdays" aria-hidden="true">${["一", "二", "三", "四", "五", "六", "日"].map(day => `<span>${day}</span>`).join("")}</div><div class="cal-grid" data-cal-grid></div><p class="cal-month-footnote">${state.truncated ? "结果较多，仅显示部分日程；请缩小搜索范围或前往 Google 查看。" : "按当前日历时区显示 · 选中日期查看完整安排"}${!writable() ? " · 此日历为只读" : ""}</p></section><aside class="cal-agenda" data-cal-agenda></aside></div>${slotsHtml()}`);
      root.querySelector("[data-cal-calendar]").onchange = event => { state.calendarId = event.target.value; state.zone = zoneOr(currentCalendar()?.timeZone || baseZone); state.events = []; void loadEvents(); };
      root.querySelector("[data-cal-search]").onsubmit = event => { event.preventDefault(); state.query = new FormData(event.currentTarget).get("q").trim(); void loadEvents(); };
      root.querySelector("[data-cal-new]").onclick = () => openEditor();
      const moveMonth = direction => { const date = new Date(`${state.month}-15T12:00Z`); date.setUTCMonth(date.getUTCMonth() + direction); state.month = date.toISOString().slice(0, 7); state.day = `${state.month}-01`; void loadEvents(); };
      root.querySelector("[data-cal-prev]").onclick = () => moveMonth(-1);
      root.querySelector("[data-cal-next]").onclick = () => moveMonth(1);
      root.querySelector("[data-cal-today]").onclick = () => { state.day = parts(Date.now(), state.zone).day; state.month = state.day.slice(0, 7); void loadEvents(); };
      root.querySelector("[data-cal-slots-form]").onsubmit = searchSlots;
      banner(); renderGrid(); renderAgenda();
    }
    async function boot() {
      const ticket = ++revision; controller?.abort(); controller = new AbortController(); const signal = controller.signal;
      state.loading = true; state.error = ""; render();
      try {
        const status = await read("/api/calendar/status", signal);
        if (!live() || ticket !== revision) return;
        state.status = status;
        if (!status.connected) { state.calendars = []; state.events = []; state.loading = false; render(); return; }
        const response = await read("/api/calendar/calendars", signal);
        if (!live() || ticket !== revision) return;
        state.calendars = Array.isArray(response.calendars) ? response.calendars : [];
        if (!currentCalendar()) state.calendarId = state.calendars.find(item => item.primary)?.id || state.calendars[0]?.id || "";
        state.zone = zoneOr(currentCalendar()?.timeZone || baseZone);
        await loadEvents();
      } catch (error) { if (live() && ticket === revision && error.name !== "AbortError") { state.error = fail(error); state.loading = false; render(); } }
    }
    async function loadEvents({ quiet = false } = {}) {
      if (!live() || !state.status?.connected) return;
      const ticket = ++revision; controller?.abort(); controller = new AbortController(); const signal = controller.signal;
      if (!state.calendarId) { state.loading = false; state.events = []; state.note = "没有可用的日历，请先在 Google 日历中创建或订阅一个日历。"; render(); return; }
      if (!quiet) { state.loading = true; state.events = []; state.error = ""; render(); }
      try {
        const { start, end } = range(), query = new URLSearchParams({ calendarId: state.calendarId, timeMin: localInstant(start, "00:00", state.zone), timeMax: localInstant(end, "00:00", state.zone) });
        if (state.query) query.set("q", state.query);
        const response = await read(`/api/calendar/events?${query}`, signal);
        if (!live() || ticket !== revision) return;
        state.events = (Array.isArray(response.events) ? response.events : []).filter(item => item?.start && item.status !== "cancelled"); state.truncated = Boolean(response.truncated); state.loading = false;
        if (!dialog) {
          if (quiet) {
            renderGrid(); renderAgenda(); banner();
            const footnote = root.querySelector(".cal-month-footnote");
            if (footnote) footnote.textContent = `${state.truncated ? "结果较多，仅显示部分日程；请缩小搜索范围或前往 Google 查看。" : "按当前日历时区显示 · 选中日期查看完整安排"}${!writable() ? " · 此日历为只读" : ""}`;
          } else render();
        }
        if (openEventId) {
          const found = state.events.find(event => event.id === openEventId); openEventId = "";
          if (found) openEditor(found);
          else { state.note = "这个日程未出现在当前日期范围内，可能已移动、删除或来自不可用的日历。请切换日期或在 Google 日历核对。"; banner(); }
        }
      } catch (error) { if (live() && ticket === revision && error.name !== "AbortError") { state.loading = false; state.error = fail(error); if (!dialog && !quiet) render(); else banner(); } }
    }
    async function startConnect(button) {
      if (connecting) return;
      connecting = true; button.disabled = true;
      try {
        const response = await write("/api/calendar/connect", "POST"), url = googleLink(response.url, true);
        if (!url) throw new Error("授权地址无效，请检查后端配置。");
        if (!live()) return;
        window.open(url, "_blank", "noopener,noreferrer");
        const target = root.querySelector("[data-cal-auth-link]");
        if (target) target.innerHTML = `<p>若浏览器未打开，<a href="${escape(url)}" target="_blank" rel="noopener noreferrer">点击继续 Google 授权 ↗</a>。完成后点击上方刷新。</p>`;
      } catch (error) { if (live()) { state.error = fail(error); banner(); } }
      finally { connecting = false; if (button.isConnected) button.disabled = false; }
    }
    function createDialog(html) {
      if (dialog) return null;
      const previousFocus = document.activeElement, element = document.createElement("dialog");
      element.className = "cal-dialog"; element.innerHTML = html; root.appendChild(element); dialog = element;
      element.addEventListener("close", () => { if (dialog === element) dialog = null; element.remove(); if (previousFocus?.isConnected) previousFocus.focus(); });
      element.showModal(); return element;
    }
    function openDisconnect() {
      const element = createDialog('<form method="dialog"><header><h2>断开 Google 日历？</h2></header><p>Harbour 将停止读取和修改日历。Google 中的日程不会删除，也不会改变手机同步设置。</p><p class="cal-form-error" role="alert"></p><footer><button class="cal-button" value="cancel">取消</button><button class="cal-button is-danger" type="button" data-confirm-disconnect>断开连接</button></footer></form>');
      if (!element) return;
      element.querySelector("[data-confirm-disconnect]").onclick = async () => {
        const buttons = [...element.querySelectorAll("button")]; buttons.forEach(button => { button.disabled = true; });
        try { await write("/api/calendar/disconnect", "POST"); if (!live()) return; element.close(); state.note = "已断开连接，Google 日历中的日程保持不变。"; await boot(); }
        catch (error) { if (live()) { element.querySelector(".cal-form-error").textContent = fail(error); buttons.forEach(button => { button.disabled = false; }); } }
      };
    }
    function openEditor(event = null, slot = null) {
      const recurrence = Boolean(event?.recurrence?.length || event?.recurringEventId), editable = writable() && !recurrence;
      const start = parts(slot?.start || event?.start?.dateTime, state.zone), end = parts(slot?.end || event?.end?.dateTime, state.zone), allDay = Boolean(event?.start?.date);
      const from = event?.start?.date || start?.day || state.day, to = allDay ? addDays(event.end?.date || addDays(from, 1), -1) : end?.day || from;
      const reminder = event?.reminders, reminderValue = !event ? 15 : !reminder || reminder.useDefault ? "default" : reminder.overrides?.[0]?.minutes ?? "none";
      const external = googleLink(event?.htmlLink), createRequestId = requestId();
      const element = createDialog(`<form class="cal-event-form"><header><div><span class="cal-eyebrow">${escape(state.zone)}</span><h2>${event ? "日程详情" : "新的安排"}</h2></div><button type="button" class="cal-button" data-close aria-label="关闭日程">×</button></header>${recurrence ? '<p class="cal-form-notice">这是重复日程。请在 Google 日历中选择修改此实例或整个系列，Harbour 不会猜测修改范围。</p>' : ""}<fieldset${!editable ? " disabled" : ""}><label>日程标题<input name="summary" maxlength="500" value="${escape(event?.summary || "")}" required placeholder="准备面试、一起去看展…"></label><section class="cal-schedule" data-schedule><div class="cal-form-pair" data-single-dates><label>开始日期<input name="startDate" type="date" value="${escape(from)}" required></label><label>结束日期（全天含当天）<input name="endDate" type="date" value="${escape(to)}" required></label></div><label class="cal-check"><input name="allDay" type="checkbox"${allDay ? " checked" : ""}>全天</label><div class="cal-form-pair"><label data-time-label>开始时间<input name="startTime" type="time" value="${escape(start?.time || "09:00")}" required></label><label data-time-label>结束时间<input name="endTime" type="time" value="${escape(end?.time || "10:00")}" required></label></div></section><label>地点<input name="location" maxlength="2000" value="${escape(event?.location || "")}" placeholder="可选"></label><label>备注<textarea name="description" rows="3" maxlength="8000" placeholder="可选">${escape(event?.description || "")}</textarea></label><label>提醒<select name="reminder" aria-label="提醒"><option value="default">跟随日历默认提醒</option><option value="none">不提醒</option>${[0, 5, 10, 15, 30, 60, 1440].map(minutes => `<option value="${minutes}">${minutes === 0 ? "开始时" : `提前 ${minutes} 分钟`}</option>`).join("")}${!['default', 'none', 0, 5, 10, 15, 30, 60, 1440].includes(reminderValue) ? `<option value="${escape(reminderValue)}">提前 ${escape(reminderValue)} 分钟</option>` : ""}</select></label></fieldset><p class="cal-form-error" role="alert"></p><p class="cal-form-notice" data-write-note hidden></p><div class="cal-delete-confirm" hidden>确定删除这个日程？此操作会同步到 Google。<button type="button" class="cal-button is-danger" data-confirm-delete>确认删除</button><button type="button" class="cal-button" data-keep-event>保留</button></div><footer>${event && editable ? '<button type="button" class="cal-button is-danger cal-delete" data-delete>删除</button>' : ""}${external ? `<a class="cal-button" href="${escape(external)}" target="_blank" rel="noopener noreferrer">Google 日历 ↗</a>` : ""}<button type="button" class="cal-button" data-cancel>取消</button>${editable ? '<button type="submit" class="cal-button is-primary" data-save>保存日程</button>' : ""}</footer></form>`);
      if (!element) return;
      const form = element.querySelector("form"), fields = form.elements; let busy = false, frozen = null, baseline = "";
      const repeatEditor = !event && editable ? weeklyEditor(form, state.zone) : null;
      fields.reminder.value = String(reminderValue);
      const timeVisibility = () => element.querySelectorAll("[data-time-label]").forEach(label => { label.hidden = fields.allDay.checked; label.querySelector("input").required = !fields.allDay.checked; });
      timeVisibility(); fields.allDay.onchange = timeVisibility;
      const serialize = () => JSON.stringify([...new FormData(form)]); baseline = serialize();
      if (editable && window.HarbourUnsavedChanges?.register) {
        const unregister = window.HarbourUnsavedChanges.register("calendar-event", {
          isActive: () => live() && element.isConnected && element.open,
          isDirty: () => Boolean(frozen) || serialize() !== baseline,
          isBusy: () => busy,
          label: "日历 · 未保存的日程",
          version: serialize,
          discard: () => { if (busy) return false; element.close(); return true; },
        });
        unregisterEditor = unregister;
        element.addEventListener("close", () => { unregister(); if (unregisterEditor === unregister) unregisterEditor = null; }, { once: true });
      }
      const close = () => {
        if (busy) return;
        if (editable && serialize() !== baseline && !element.querySelector("[data-discard]")) {
          const note = element.querySelector("[data-write-note]"); note.hidden = false; note.innerHTML = '尚有未保存的修改。<button type="button" class="cal-button" data-discard>放弃修改并关闭</button>'; note.querySelector("button").onclick = () => element.close(); return;
        }
        element.close();
      };
      element.querySelector("[data-close]").onclick = close; element.querySelector("[data-cancel]").onclick = close;
      element.addEventListener("cancel", e => { e.preventDefault(); close(); });
      const setBusy = value => { busy = value; element.querySelectorAll("button").forEach(button => { button.disabled = value; }); fields.summary.closest("fieldset").disabled = value || !editable || Boolean(frozen); };
      async function mutate(method, payload) {
        if (busy) return;
        setBusy(true); element.querySelector(".cal-form-error").textContent = "";
        try {
          await write(event ? `/api/calendar/events/${encodeURIComponent(event.id)}` : "/api/calendar/events", method, payload);
          if (!live()) return;
          element.close(); state.note = method === "DELETE" ? "日程已删除。" : "日程已保存，并同步到 Google 日历。"; await loadEvents();
        } catch (error) {
          if (!live()) return;
          if (error.status === 412 || ["PRECONDITION_FAILED", "ETAG_MISMATCH"].includes(error.code)) {
            element.close(); await loadEvents(); state.error = "这个日程已在其它设备修改，已重新读取。请打开最新版本后再编辑；本次没有覆盖远端改动。"; banner(); return;
          }
          element.querySelector(".cal-form-error").textContent = fail(error);
          if (error?.data?.writeOutcome === "unknown" || !error.status || error.status >= 500 || error.status === 408) {
            frozen = { method, payload };
            const note = element.querySelector("[data-write-note]"); note.hidden = false;
            note.textContent = event ? "提交结果未知，未自动重试。请先在 Google 日历核对，再关闭此窗并刷新读取最新版本；本窗口已禁止再次修改或删除。" : "提交结果未知，未自动重试。参数已锁定；核对原请求沿用同一请求号，只查询后端已有记录，不另建相同日程。";
            const save = element.querySelector("[data-save]"); if (save) save.textContent = event ? "请先核对结果" : "核对原请求";
          }
        } finally {
          if (live() && element.isConnected) {
            setBusy(false);
            if (frozen && event) element.querySelectorAll("[data-save],[data-delete],[data-confirm-delete]").forEach(button => { button.disabled = true; });
          }
        }
      }
      form.onsubmit = e => {
        e.preventDefault(); if (!editable || busy) return;
        if (frozen) { if (!event) void mutate(frozen.method, frozen.payload); return; }
        try {
          const summary = fields.summary.value.trim(); if (!summary) throw new Error("请填写日程标题。");
          const eventInput = { summary, location: fields.location.value.trim(), description: fields.description.value };
          const repeat = repeatEditor?.read();
          const startDay = repeat ? repeat.first : fields.startDate.value, endDay = repeat ? repeat.end : fields.endDate.value;
          if (!validDay(startDay) || !validDay(endDay)) throw new Error("请填写有效的日期。");
          if (fields.allDay.checked) {
            if (endDay < startDay) throw new Error("结束日期不能早于开始日期。");
            eventInput.start = { date: startDay }; eventInput.end = { date: addDays(endDay, 1) };
          } else {
            const startTime = localInstant(startDay, fields.startTime.value, state.zone), endTime = localInstant(endDay, fields.endTime.value, state.zone);
            if (Date.parse(endTime) <= Date.parse(startTime)) throw new Error("结束时间必须晚于开始时间。");
            eventInput.start = { dateTime: startTime, timeZone: state.zone }; eventInput.end = { dateTime: endTime, timeZone: state.zone };
          }
          if (repeat) eventInput.recurrence = repeat.recurrence;
          const minutes = fields.reminder.value;
          // Preserve multi-method reminders unless the user explicitly changes the control.
          if (!event || minutes !== String(reminderValue)) eventInput.reminders = minutes === "default" ? { useDefault: true } : { useDefault: false, overrides: minutes === "none" ? [] : [{ method: "popup", minutes: Number(minutes) }] };
          void mutate(event ? "PATCH" : "POST", event ? { calendarId: event.calendarId || state.calendarId, etag: event.etag, event: eventInput } : { calendarId: state.calendarId, requestId: createRequestId, event: eventInput });
        } catch (error) { element.querySelector(".cal-form-error").textContent = fail(error); }
      };
      const remove = element.querySelector("[data-delete]");
      if (remove) {
        remove.onclick = () => { element.querySelector(".cal-delete-confirm").hidden = false; };
        element.querySelector("[data-keep-event]").onclick = () => { element.querySelector(".cal-delete-confirm").hidden = true; };
        element.querySelector("[data-confirm-delete]").onclick = () => void mutate("DELETE", { calendarId: event.calendarId || state.calendarId, etag: event.etag });
      }
      fields.summary.focus();
    }
    async function searchSlots(e) {
      e.preventDefault(); const form = e.currentTarget, result = root.querySelector("[data-cal-slots-results]"), button = form.querySelector("button"), values = new FormData(form);
      if (button.disabled) return;
      try {
        const from = String(values.get("from")), to = String(values.get("to"));
        if (!validDay(from) || !validDay(to) || to < from) throw new Error("请填写正确的查询日期范围。");
        if (Number(values.get("workEnd")) <= Number(values.get("workStart"))) throw new Error("工作结束时间必须晚于开始时间。");
        button.disabled = true; result.setAttribute("role", "status"); result.textContent = "正在查找…";
        const query = new URLSearchParams({ calendarIds: JSON.stringify([state.calendarId]), timeMin: localInstant(from, "00:00", state.zone), timeMax: localInstant(addDays(to, 1), "00:00", state.zone), durationMinutes: values.get("duration"), timeZone: state.zone, workStartHour: values.get("workStart"), workEndHour: values.get("workEnd"), excludeWeekends: String(values.has("weekends")) });
        const response = await read(`/api/calendar/slots?${query}`, controller?.signal);
        if (!live() || !result.isConnected) return;
        const slots = (Array.isArray(response.slots) ? response.slots : []).slice(0, 20);
        result.innerHTML = slots.length ? `<div class="cal-slot-options">${slots.map((slot, index) => `<button type="button" class="cal-button cal-slot-option" data-slot="${index}"${!writable() ? " disabled" : ""}><span>${escape(parts(slot.start, state.zone)?.day)}</span><strong>${escape(parts(slot.start, state.zone)?.time)} – ${escape(parts(slot.end, state.zone)?.time)}</strong></button>`).join("")}</div><p class="cal-muted">${response.truncated || response.slots.length > 20 ? "仅显示前 20 个空档。" : ""}仅检查所选日历；点击空档填写新日程，保存前不会占用时间。</p>` : '<p class="cal-muted">这个范围内没有符合条件的空档。</p>';
        result.querySelectorAll("[data-slot]").forEach(item => { item.onclick = () => openEditor(null, slots[Number(item.dataset.slot)]); });
      } catch (error) { if (live() && result.isConnected && error.name !== "AbortError") { result.textContent = fail(error); result.setAttribute("role", "alert"); } }
      finally { if (button.isConnected) button.disabled = false; }
    }
    const onVisible = () => { if (!document.hidden && state.status?.connected && !dialog && !state.loading) void loadEvents({ quiet: true }); };
    document.addEventListener("visibilitychange", onVisible);
    poll = window.setInterval(onVisible, 60000);
    void boot();
    return () => { disposed = true; revision += 1; controller?.abort(); window.clearInterval(poll); document.removeEventListener("visibilitychange", onVisible); unregisterEditor?.(); unregisterEditor = null; dialog?.close(); dialog = null; root.replaceChildren(); root.classList.remove("harbour-calendar"); };
  }
  window.HarbourCalendar = { mount, cardsHtml };
})();
