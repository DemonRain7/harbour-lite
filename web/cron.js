/* Cron is a view of the existing scheduler. Polling only reads receipts; never retries a run. */
(function () {
  "use strict";
  const execution = { queued: "等待执行", running: "执行中", completed: "执行完成", failed: "执行失败", interrupted: "执行已中断" };
  const delivery = { none: "仅保存在 Harbour", pending: "等待发送", sending: "正在发送", sent: "已发送", failed: "发送失败", unknown: "送达状态未知" };
  const active = job => ["queued", "running"].includes(job.lastStatus) || ["pending", "sending"].includes(job.lastDeliveryStatus);
  const attention = job => Boolean(job.lastError || job.lastDeliveryError || job.authorizationStatus === "required" || ["failed", "interrupted"].includes(job.lastStatus) || ["failed", "unknown"].includes(job.lastDeliveryStatus));
  const icon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">${name === "code" ? '<path d="m8 7-5 5 5 5m8-10 5 5-5 5m-3-14-2 18"/>' : '<circle cx="12" cy="12" r="9"/><path d="M12 6v6l4 2"/>'}</svg>`;
  const duration = ms => ms == null ? "—" : ms < 1000 ? "不足 1 秒" : ms < 60000 ? `${(ms / 1000).toFixed(1)} 秒` : `${Math.floor(ms / 60000)} 分 ${Math.round(ms % 60000 / 1000)} 秒`;

  function mount(root, helpers) {
    const { api, esc, humanizeCron, timeHtml, scheduleTimeZone, outcomeHtml, openEditor, confirm, toast, showResult } = helpers;
    let jobs = [], agents = [], disposed = false, loading = false, timer, drawer = null, selected = null, tab = "history", openRun = null;
    let historyVersion = 0, runVersion = 0, historySignature = "", filter = "all", query = "", listSignature = "";
    const actions = new Set(), pending = new Map(), aborter = new AbortController();
    const get = path => api(path, { signal: aborter.signal });
    const date = value => value ? timeHtml(value, "short") : "—";
    const stamp = value => value ? timeHtml(value) : "未记录";
    const message = (text, error = false) => {
      if (disposed) return;
      const node = root.querySelector(".cron-feedback");
      node.textContent = text; node.hidden = false; node.classList.toggle("is-error", error);
    };
    root.innerHTML = `<section class="cron-page">
      <header class="cron-heading"><div><span class="cron-eyebrow">AUTOMATIONS / CRON</span><h1>定时任务</h1><p>让固定的事按时发生。执行结果与发送状态，都在这里。</p></div>
        <div class="cron-heading-actions"><button class="cron-button" data-refresh>刷新</button><button class="cron-button is-primary" id="cronNew">＋ 新建任务</button></div></header>
      <div class="cron-feedback" role="status" aria-live="polite" hidden></div>
      <div class="cron-toolbar"><div class="cron-filters" aria-label="任务筛选">${[["all", "全部"], ["enabled", "已启用"], ["active", "执行中"], ["attention", "需关注"]].map(([key, label]) => `<button data-filter="${key}" aria-pressed="${key === "all"}">${label} <span data-count="${key}">0</span></button>`).join("")}</div>
        <input class="cron-search" type="search" aria-label="搜索定时任务" placeholder="搜索任务或 Agent…"></div>
      <div class="cron-jobs" aria-live="polite"><div class="cron-empty">正在加载任务…</div></div>
      <p class="cron-footnote">新任务默认暂停。手动运行不改变定时开关，也不代表已经执行成功。</p>
    </section>`;

    function renderJobs() {
      if (disposed) return;
      for (const [key, count] of Object.entries({ all: jobs.length, enabled: jobs.filter(j => j.enabled).length, active: jobs.filter(active).length, attention: jobs.filter(attention).length })) root.querySelector(`[data-count="${key}"]`).textContent = count;
      root.querySelectorAll("[data-filter]").forEach(b => b.setAttribute("aria-pressed", b.dataset.filter === filter));
      const visible = jobs.filter(job => (filter === "all" || filter === "enabled" && job.enabled || filter === "active" && active(job) || filter === "attention" && attention(job)) && `${job.name} ${job.agent}`.toLowerCase().includes(query.toLowerCase()));
      const signature = JSON.stringify([visible, [...actions], [...pending], filter, query]);
      if (signature === listSignature) return;
      listSignature = signature;
      const focused = document.activeElement;
      const focusKey = focused?.closest(".cron-jobs") && ["cronOpen", "cronOnce", "cronToggle", "cronView"].find(key => focused.dataset[key]);
      const focusId = focusKey && focused.dataset[focusKey];
      root.querySelector(".cron-jobs").innerHTML = visible.map(job => {
        const busy = active(job) || actions.has(job.id) || pending.has(job.id);
        const blocked = busy || job.lastDeliveryStatus === "unknown" || job.authorizationStatus === "required";
        return `<article class="cron-task ${active(job) ? "is-running" : ""}" data-task="${esc(job.id)}">
          <div class="cron-task-top"><span class="cron-task-icon">${icon(job.builtin ? "code" : "clock")}</span>
            <div class="cron-task-title"><button data-cron-open="${esc(job.id)}" aria-label="查看 ${esc(job.name || job.id)} 的执行历史与配置">${esc(job.name || job.id)}</button><span>${esc(job.builtin ? "系统维护 · 不调用模型" : job.agent)}<span class="cron-identity">${job.builtin ? "" : job.authorizationStatus === "required" ? "待主人重新授权" : job.executionIdentity === "owner" ? "主人授权" : "系统身份"}</span></span></div>
            <button class="cron-switch" data-cron-toggle="${esc(job.id)}" data-cron-en="${job.enabled ? "1" : "0"}" aria-pressed="${!!job.enabled}" aria-label="${job.enabled ? "暂停" : "启用"}定时任务 ${esc(job.name)}" ${actions.has(job.id) ? "disabled" : ""}><span></span>${job.enabled ? "已启用" : "已暂停"}</button></div>
          <div class="cron-task-schedule"><strong>${esc(humanizeCron(job.schedule))}</strong><span>${esc(scheduleTimeZone(job))}</span></div>
          <div class="cron-task-next">${job.enabled ? `下次 ${date(job.nextTick)}` : "自动执行已暂停 · 仍可手动运行"}</div>
          <div class="cron-task-outcome"><div class="cron-last-label">最近执行 <span>${date(job.lastRun)}</span></div>${outcomeHtml(job)}</div>
          <footer><span class="cron-delivery-target">${esc(job.delivery?.label || (job.delivery ? job.delivery.channel.toUpperCase() : "仅 Harbour"))}</span>
            <button class="cron-button" data-cron-once="${esc(job.id)}" ${blocked ? 'disabled title="仍在处理、需要授权或需要核对投递状态"' : ""}>${busy ? "处理中…" : "▷ 运行一次"}</button><button class="cron-button is-subtle" data-cron-open="${esc(job.id)}">详情 ↗</button></footer>
        </article>`;
      }).join("") || `<div class="cron-empty"><span>${jobs.length ? "没有匹配的任务" : "还没有定时任务"}</span><p>${jobs.length ? "试试其他筛选或关键词。" : "创建一个任务，按自己的节奏开启。"}</p></div>`;
      if (focusKey) [...root.querySelectorAll(".cron-jobs button")].find(b => b.dataset[focusKey] === focusId)?.focus({ preventScroll: true });
    }

    function checkPending() {
      for (const [id, track] of pending) {
        const job = jobs.find(j => j.id === id);
        if (!job) { pending.delete(id); continue; }
        if (!track.runId && job.lastRunId && job.lastRunId !== track.before) track.runId = job.lastRunId;
        if (!track.runId || track.runId !== job.lastRunId) continue;
        if (active(job)) { message(`「${job.name}」${execution[job.lastStatus] || delivery[job.lastDeliveryStatus]}，完成后会在这里显示结果。`); continue; }
        if (!["completed", "failed", "interrupted"].includes(job.lastStatus)) continue;
        pending.delete(id);
        const warning = attention(job);
        const suffix = job.lastError || job.lastDeliveryError || (job.lastDeliveryStatus === "sent" ? "已发送到指定会话" : job.lastResult || "结果已保存");
        const text = `「${job.name}」${execution[job.lastStatus]}${job.lastDeliveryError ? `，${delivery[job.lastDeliveryStatus]}` : ""}：${suffix}`;
        message(text, warning); toast(text.length > 140 ? text.slice(0, 140) + "…（详情中查看）" : text, warning);
      }
    }

    function planPoll() {
      clearTimeout(timer);
      if (!disposed && !document.hidden) timer = setTimeout(() => void refresh(), pending.size || jobs.some(active) ? 1800 : 12000);
    }
    async function refresh() {
      if (disposed || loading) return;
      loading = true;
      root.querySelector("[data-refresh]").disabled = true;
      try {
        const response = await get("/api/cron");
        if (disposed) return;
        if (!Array.isArray(response.jobs)) throw new Error("任务列表返回格式无效");
        jobs = response.jobs; checkPending(); renderJobs();
        if (drawer) { renderDrawerHeading(); if (tab === "history") await loadHistory(); else renderConfiguration(); }
      } catch (error) { if (!disposed) message(`暂时无法获取最新状态：${error.message}。未重新执行任务。`, true); }
      finally { loading = false; if (!disposed) root.querySelector("[data-refresh]").disabled = false; planPoll(); }
    }
    async function act(id, action) {
      const job = jobs.find(j => j.id === id);
      if (!job || actions.has(id)) return;
      actions.add(id); renderJobs();
      try {
        if (action === "run-once") {
          if (active(job) || pending.has(id) || job.lastDeliveryStatus === "unknown" || job.authorizationStatus === "required") return;
          pending.set(id, { before: job.lastRunId });
          message(`正在提交「${job.name}」…`); renderJobs();
        }
        const response = await api(`/api/cron/${encodeURIComponent(id)}/${action}`, { method: "POST", ...(action === "toggle" ? { body: JSON.stringify({ enabled: !job.enabled }) } : {}) });
        if (disposed) return;
        if (action === "run-once") {
          pending.set(id, { before: job.lastRunId, runId: response.job?.lastRunId });
          message(`「${job.name}」已受理，等待执行完成；不会重复提交。`);
        } else message(`「${job.name}」${job.enabled ? "已暂停自动执行，当前运行不会被中止" : "已启用自动执行"}。`);
        if (Array.isArray(response.jobs)) jobs = response.jobs;
        checkPending();
      } catch (error) {
        if (disposed) return;
        if (action === "run-once" && (!error.status || error.status >= 500)) {
          message(`「${job.name}」提交回执未确认：${error.message}。正在查询状态，不会自动重发。`, true);
        } else { pending.delete(id); message(error.message, true); }
      } finally { actions.delete(id); renderJobs(); if (!disposed) void refresh(); }
    }

    function closeDrawer() {
      historyVersion++; runVersion++; selected = null; openRun = null; historySignature = "";
      const trigger = drawer?.returnFocus; drawer?.remove(); drawer = null;
      if (trigger?.isConnected) trigger.focus();
    }
    function renderDrawerHeading() {
      const job = jobs.find(j => j.id === selected);
      if (!drawer || !job) { if (drawer) closeDrawer(); return; }
      drawer.querySelector("h2").textContent = job.name || job.id;
      drawer.querySelector(".cron-detail-sub").textContent = `${job.enabled ? "自动执行已启用" : "自动执行已暂停"} · ${humanizeCron(job.schedule)} · ${scheduleTimeZone(job)}`;
      drawer.querySelectorAll("[data-tab]").forEach(b => b.setAttribute("aria-selected", b.dataset.tab === tab));
    }
    function configHtml(config, legacy = false) {
      if (!config) return `<p class="cron-muted">${legacy ? "旧版本没有记录当时配置，不能用现在的配置冒充历史。" : "没有配置记录"}</p>`;
      return `<dl class="cron-config-grid">${[
        ["执行方式", config.builtin ? `系统代码 · ${config.builtin}` : config.agent], ["运行时间", humanizeCron(config.schedule)],
        ["Cron 表达式", config.schedule], ["执行时区", config.timeZone],
        ["执行身份", config.builtin ? "系统代码" : config.executionIdentity === "owner" ? "主人授权" : "系统身份"],
        ["会话", config.builtin ? "不使用模型会话" : config.sessionMode === "continue" ? "沿用该任务的独立会话" : "每次独立会话"],
        ["结果保存 / 发送", config.deliveryLabel || "仅保存在 Harbour"],
      ].map(([label, value]) => `<div><dt>${esc(label)}</dt><dd>${esc(value || "—")}</dd></div>`).join("")}</dl>${!config.builtin ? `<h4>任务指令</h4><pre class="cron-result">${esc(config.input)}</pre>${config.inputTruncated ? '<p class="cron-muted">历史指令较长，此处仅保留前 16,384 字符。</p>' : ""}` : '<p class="cron-muted">由确定性程序刷新目录和报价，不会调用 LLM。旧用量账本不会追溯重算。</p>'}`;
    }
    function renderConfiguration() {
      const job = jobs.find(j => j.id === selected);
      if (!drawer || !job || tab !== "config") return;
      drawer.querySelector(".cron-detail-content").innerHTML = `<div class="cron-config-heading"><h3>当前配置</h3><button class="cron-button" data-edit>编辑配置</button></div>
        ${job.authorizationStatus === "required" ? '<p class="cron-inline-error">需要在此后端重新获得主人授权，保存配置不会自动开始执行。</p>' : ""}
        ${configHtml({ ...job, deliveryLabel: job.delivery?.label })}
        <dl class="cron-config-grid"><div><dt>任务 ID</dt><dd>${esc(job.id)}</dd></div><div><dt>创建于</dt><dd>${stamp(job.createdAt)}</dd></div><div><dt>最后修改</dt><dd>${stamp(job.updatedAt)}</dd></div></dl>
        <div class="cron-danger-zone"><span>删除配置将同时移除此任务的本机执行历史。</span><button class="cron-button is-danger" data-delete ${active(job) ? "disabled" : ""}>删除任务</button></div>`;
    }
    async function loadHistory() {
      if (!drawer || tab !== "history") return;
      const id = selected, version = ++historyVersion;
      try {
        const response = await get(`/api/cron/${encodeURIComponent(id)}/history`);
        if (disposed || !drawer || selected !== id || tab !== "history" || version !== historyVersion) return;
        if (!Array.isArray(response.runs)) throw new Error("历史接口尚未就绪，请确认后端已加载新版");
        const signature = JSON.stringify(response);
        if (signature === historySignature) return;
        historySignature = signature;
        if (!openRun) openRun = response.runs[0]?.id || null;
        drawer.querySelector(".cron-detail-content").innerHTML = `<p class="cron-history-note">本机保留最近 ${esc(response.retentionLimit || 50)} 次。执行和渠道发送分别记录。</p>
          <div class="cron-history-list">${response.runs.map(run => `<details class="cron-history-item" data-run="${esc(run.id)}" ${run.id === openRun ? "open" : ""}>
            <summary><span class="cron-run-dot ${esc(run.status || "unknown")}"></span><span><b>${esc(execution[run.status] || "旧版记录")}</b><small>${date(run.queuedAt)} · ${esc(run.trigger === "manual" ? "手动运行" : run.trigger === "cron" ? "定时触发" : "来源未记录")}</small></span><span class="cron-run-duration">${duration(run.durationMs)}</span></summary>
            <div class="cron-history-preview">${esc(run.summary || delivery[run.deliveryStatus] || "等待结果")}</div><div class="cron-run-content">正在读取回执…</div></details>`).join("") || '<div class="cron-empty">尚无执行历史<p>运行后，这里会记录每次结果。</p></div>'}</div>`;
        if (openRun) void loadRun(id, openRun);
      } catch (error) {
        if (disposed || !drawer || selected !== id || tab !== "history" || version !== historyVersion) return;
        historySignature = "";
        drawer.querySelector(".cron-detail-content").innerHTML = `<p class="cron-inline-error">无法读取执行历史：${esc(error.message)}。可关闭详情后重试；不会执行任务。</p>`;
      }
    }
    async function loadRun(id, runId) {
      const version = ++runVersion;
      try {
        const { run } = await get(`/api/cron/${encodeURIComponent(id)}/history/${encodeURIComponent(runId)}`);
        if (disposed || !drawer || selected !== id || tab !== "history" || openRun !== runId || version !== runVersion) return;
        if (!run || run.id !== runId) throw new Error("执行回执不匹配");
        const item = [...drawer.querySelectorAll("[data-run]")].find(node => node.dataset.run === runId);
        if (!item) return;
        item.querySelector(".cron-run-content").innerHTML = `${run.legacy ? '<p class="cron-muted">从旧版最近一次记录恢复；触发方式、耗时和当时配置未保存。更早记录无法补回。</p>' : ""}
          <dl class="cron-run-times"><div><dt>入队</dt><dd>${stamp(run.queuedAt)}</dd></div><div><dt>开始</dt><dd>${stamp(run.startedAt)}</dd></div><div><dt>完成</dt><dd>${stamp(run.finishedAt)}</dd></div><div><dt>渠道发送</dt><dd>${esc(delivery[run.deliveryStatus] || "未记录")}</dd></div></dl>
          ${run.error ? `<p class="cron-inline-error">${esc(run.error)}</p>` : ""}${run.deliveryError ? `<p class="cron-inline-error">投递：${esc(run.deliveryError)}</p>` : ""}
          ${typeof run.result === "string" ? `<h4>执行结果</h4><pre class="cron-result">${esc(run.result)}</pre>${run.resultTruncated ? '<p class="cron-muted">结果较长，历史保留前 65,536 字符。</p>' : ""}` : '<p class="cron-muted">本次尚无成功结果；不会显示上一轮结果冒充本轮。</p>'}
          <details class="cron-run-config"><summary>查看本次执行时的配置</summary>${configHtml(run.configuration, run.legacy)}</details><small class="cron-run-id">${esc(run.id)}</small>`;
      } catch (error) {
        if (!disposed && drawer && selected === id && openRun === runId && tab === "history" && version === runVersion) {
          const item = [...drawer.querySelectorAll("[data-run]")].find(node => node.dataset.run === runId);
          if (item) item.querySelector(".cron-run-content").textContent = `读取失败：${error.message}`;
        }
      }
    }
    function openDetails(id) {
      if (!jobs.some(job => job.id === id)) return;
      closeDrawer(); selected = id; tab = "history";
      drawer = document.createElement("div"); drawer.className = "cron-detail-overlay";
      drawer.returnFocus = document.activeElement;
      drawer.innerHTML = `<section class="cron-detail" role="dialog" aria-modal="true" aria-labelledby="cronDetailTitle"><header><div><span class="cron-eyebrow">TASK DETAILS</span><h2 id="cronDetailTitle"></h2><p class="cron-detail-sub"></p></div><button class="cron-button is-subtle" data-close aria-label="关闭任务详情">✕</button></header>
        <div class="cron-detail-tabs" role="tablist" aria-label="任务详情"><button role="tab" data-tab="history">执行历史</button><button role="tab" data-tab="config">任务配置</button></div><div class="cron-detail-content">正在读取执行历史…</div></section>`;
      document.body.appendChild(drawer); renderDrawerHeading(); drawer.querySelector("[data-close]").focus();
      drawer.addEventListener("click", async event => {
        if (event.target === drawer || event.target.closest("[data-close]")) return closeDrawer();
        const btn = event.target.closest("button");
        if (!btn) return;
        if (btn.dataset.tab) {
          tab = btn.dataset.tab; historyVersion++; runVersion++; historySignature = "";
          renderDrawerHeading(); if (tab === "config") renderConfiguration(); else { drawer.querySelector(".cron-detail-content").textContent = "正在读取执行历史…"; void loadHistory(); }
        } else if (btn.hasAttribute("data-edit")) {
          const job = jobs.find(j => j.id === selected); closeDrawer(); openEditor(job, agents, () => void refresh());
        } else if (btn.hasAttribute("data-delete")) {
          const id = selected;
          if (!await confirm("任务配置及其本机执行历史将被删除。", { title: "删除定时任务？", confirmLabel: "删除", tone: "danger" })) return;
          if (disposed || selected !== id) return;
          btn.disabled = true;
          try { await api(`/api/cron/${encodeURIComponent(id)}`, { method: "DELETE" }); closeDrawer(); message("任务已删除，自动调度已停止。"); void refresh(); }
          catch (error) { message(error.message, true); btn.disabled = false; }
        }
      });
      drawer.addEventListener("toggle", event => {
        const item = event.target;
        if (!item.matches("details[data-run]") || !item.open || item.dataset.run === openRun) return;
        openRun = item.dataset.run;
        drawer.querySelectorAll("details[data-run]").forEach(other => { if (other !== item) other.open = false; });
        void loadRun(selected, openRun);
      }, true);
      drawer.addEventListener("keydown", event => {
        if (event.key === "Escape") { event.preventDefault(); closeDrawer(); }
        if (event.key === "Tab") {
          const nodes = [...drawer.querySelectorAll("button:not(:disabled),summary")].filter(node => node.getClientRects().length);
          const first = nodes[0], last = nodes.at(-1);
          if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
          else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
        }
      });
      void loadHistory();
    }

    const click = event => {
      const btn = event.target.closest("button");
      if (!btn || btn.disabled) return;
      if (btn.dataset.cronOpen) openDetails(btn.dataset.cronOpen);
      else if (btn.dataset.cronOnce) void act(btn.dataset.cronOnce, "run-once");
      else if (btn.dataset.cronToggle) void act(btn.dataset.cronToggle, "toggle");
      else if (btn.dataset.cronView) { const job = jobs.find(j => j.id === btn.dataset.cronView); if (job) void showResult(job); }
      else if (btn.dataset.filter) { filter = btn.dataset.filter; renderJobs(); }
      else if (btn.hasAttribute("data-refresh")) void refresh();
      else if (btn.id === "cronNew") openEditor(null, agents, () => void refresh());
    };
    const input = event => { if (event.target.matches(".cron-search")) { query = event.target.value; renderJobs(); } };
    const visibility = () => { clearTimeout(timer); if (!document.hidden) void refresh(); };
    root.addEventListener("click", click); root.addEventListener("input", input); document.addEventListener("visibilitychange", visibility);
    const dispose = () => { disposed = true; clearTimeout(timer); aborter.abort(); closeDrawer(); document.getElementById("cronModal")?.closeCronEditor?.(); root.removeEventListener("click", click); root.removeEventListener("input", input); document.removeEventListener("visibilitychange", visibility); };
    dispose.ready = Promise.all([refresh(), get("/api/agents").then(response => { if (!disposed) agents = response.agents || []; }).catch(error => { if (!disposed) message(`Agent 列表读取失败：${error.message}`, true); })]);
    return dispose;
  }
  window.HarbourCron = { mount };
})();
