/* Execution display is a projection of trace events, never an execution controller. */
(function (root) {
  "use strict";
  const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const scopeLabels = { task: "总计划", skill: "Skill · 局部", workflow: "Workflow · 局部" };
  const statusLabels = { pending: "待办", in_progress: "进行中", completed: "已完成", blocked: "受阻", cancelled: "已取消" };
  const names = { "main-elaina": "Elaina", "main-aemeath": "Aemeath", orchestrator: "Orchestrator", browser_controller: "Browser" };
  const kind = e => e.msg || ({ START: "loop:start", FINAL: "loop:final", SPAWN: "spawn_subagent", THINK: "loop:thinking" })[e.tag] || "";
  const eventKey = e => JSON.stringify([e.traceId || e.agent, e.parentTraceId, kind(e), e.at ?? e.time,
    e.jobId, e.action, e.status, e.completed, e.total, e.tag, e.text]);
  const tone = n => ["accent", "teal", "rose", "gold", "blue"][n % 5];
  const eventTime = e => typeof (e.at ?? e.time) === "number" ? (e.at ?? e.time) : Date.parse(e.at ?? e.time);

  // This is a compact *view*, not the audit log. A workflow/job owns one mutable
  // progress row; repeated polling must not push real tool activity off screen.
  function projectFeed(events, limit = 24) {
    const feed = [], snapshots = new Map();
    for (const e of events) {
      if (["plan:submitted", "progress:updated", "loop:turn", "loop:start", "loop:end"].includes(kind(e))) continue;
      if (kind(e) === "workflow:progress") {
        const key = JSON.stringify([e.workflow, e.jobId || "", e.action || ""]);
        const previous = snapshots.get(key);
        if (previous && eventTime(e) < eventTime(previous)) continue;
        if (previous && ["status", "completed", "total", "text"].every(k => e[k] === previous[k])) continue;
        if (previous) feed.splice(feed.indexOf(previous), 1);
        snapshots.set(key, e);
      }
      feed.push(e);
    }
    return feed.slice(-limit);
  }

  function validPlan(p) {
    if (!p || typeof p.id !== "string" || !Array.isArray(p.steps) || !scopeLabels[p.scope]) return null;
    const steps = p.steps.slice(0, 20).map((s, i) => ({ n: Number(s.n) || i + 1, title: String(s.title || "").slice(0, 240),
      detail: String(s.detail || "").slice(0, 600), agent: String(s.agent || "").slice(0, 100),
      status: statusLabels[s.status] ? s.status : "pending" }));
    return { id: p.id, scope: p.scope, title: String(p.title || "").slice(0, 320), source: String(p.source || "").slice(0, 100),
      owner: String(p.owner || ""), revision: Number(p.revision) || 0, steps };
  }

  function buildModel(events, options = {}) {
    const mainAgent = options.agent || events.find(e => !e.depth && e.agent)?.agent || "Harbour";
    const makeLane = (id, agent, depth) => ({ id, agent, depth, events: [], plans: [], capabilities: new Map(), terminal: "", last: null,
      traceIds: new Set(), parentTraceId: "", firstOrder: -1, lastWorkOrder: -1 });
    const main = makeLane("main", mainAgent, 0);
    const lanes = new Map([["main", main]]), plans = new Map(), seen = new Set();
    const dispatches = [];
    // Reconnect sends anchors before the tail. Keep that replay from rewinding
    // a live lane; legacy traces without timestamps retain their original order.
    const ordered = events.every(e => Number.isFinite(eventTime(e))) ? [...events].sort((a, b) => eventTime(a) - eventTime(b)) : events;
    for (const [order, e] of ordered.entries()) {
      const key = eventKey(e);
      if (seen.has(key) && kind(e) !== "progress:updated") continue;
      seen.add(key);
      const isMain = (!e.parentTraceId && e.agent === mainAgent) || (!e.agent && !e.depth);
      const id = isMain ? "main" : (e.traceId || `legacy:${e.agent || "Agent"}`);
      if (!lanes.has(id)) lanes.set(id, makeLane(id, e.agent || "Agent", Math.max(1, Number(e.depth) || 1)));
      const lane = lanes.get(id), msg = kind(e);
      if (lane.firstOrder < 0) lane.firstOrder = order;
      if (e.traceId) lane.traceIds.add(e.traceId);
      if (e.parentTraceId) lane.parentTraceId = e.parentTraceId;
      if (["loop:thinking", "loop:tool-calls", "loop:tool-result", "loop:final"].includes(msg)) lane.lastWorkOrder = order;
      lane.events.push(e);
      lane.last = e;
      if (msg === "loop:end") lane.terminal = e.status || "incomplete";
      else if (msg === "loop:interrupted" && !lane.terminal) lane.terminal = e.aborted ? "interrupted" : "failed";
      if (msg === "spawn_subagent" && e.to) dispatches.push({ event: e, parent: lane, order });
      if (msg === "skill:loaded" || msg.startsWith("workflow:")) {
        const scope = msg === "skill:loaded" ? "skill" : "workflow", source = e.skill || e.workflow;
        if (source) {
          const old = lane.capabilities.get(`${scope}:${source}`);
          // Reading another reference must not reset a running/finished workflow badge.
          const loaded = msg.endsWith(":loaded");
          if (old && eventTime(e) < old.at) continue;
          lane.capabilities.set(`${scope}:${source}`, {
            at: eventTime(e),
            scope, source, phase: loaded && old ? old.phase : loaded ? "已读取" : msg === "workflow:start" ? "执行中"
              : msg === "workflow:error" ? "失败" : ({ planned: "已规划", running: "执行中", blocked: "受阻", completed: "完成", succeeded: "完成", failed: "失败", unknown: "结果待核对", paused: "暂停" })[e.status] || "已返回",
          });
        }
      }
      let plan = validPlan(e.progress);
      if (!plan && msg === "plan:submitted" && e.plan?.steps) {
        plan = validPlan({ ...e.plan, id: e.plan.id || `legacy-plan:${e.plan.at || ""}`, title: e.plan.goal,
          scope: "task", owner: mainAgent, revision: 0 });
      }
      if (plan && (!plans.has(plan.id) || plans.get(plan.id).revision < plan.revision)) {
        plan.laneId = plan.scope === "task" ? "main" : id;
        plans.set(plan.id, plan);
      }
    }
    // Pair dispatches with actual invocations, never by agent name alone: the
    // same worker can be called twice, or by two different parents in parallel.
    const paired = new Set();
    for (const { event: e, parent, order } of dispatches) {
      const child = [...lanes.values()].find(l => l.depth && !paired.has(l.id) && l.agent === e.to
        && (e.traceId ? l.parentTraceId === e.traceId : !l.parentTraceId) && l.firstOrder >= order);
      if (child) { paired.add(child.id); continue; }
      if (options.live === false || parent.terminal || parent.lastWorkOrder > order) continue;
      const id = `pending:${eventKey(e)}`, pending = makeLane(id, e.to, parent.depth + 1);
      pending.parentTraceId = e.traceId || ""; pending.parentId = parent.id; pending.firstOrder = order;
      lanes.set(id, pending);
    }
    for (const plan of plans.values()) (lanes.get(plan.laneId) || main).plans.push(plan);
    let index = 0;
    for (const lane of lanes.values()) {
      lane.tone = tone(index++);
      lane.primary = [...lane.plans].reverse().find(p => p.scope === "task") || lane.plans.at(-1);
      // Keep scope controls stationary while newer revisions move within the trace buffer.
      const scopeOrder = { task: 0, workflow: 1, skill: 2 };
      lane.plans.sort((a, b) => scopeOrder[a.scope] - scopeOrder[b.scope] || a.id.localeCompare(b.id));
      const p = lane.primary;
      lane.done = p?.steps.filter(s => s.status === "completed").length || 0;
      lane.total = p?.steps.length || 0;
      lane.feed = projectFeed(lane.events);
      const active = p?.steps.find(s => s.status === "in_progress"), blocked = p?.steps.find(s => s.status === "blocked");
      const ended = !!lane.terminal || options.live === false;
      lane.state = lane.terminal === "failed" ? "failed" : lane.terminal === "interrupted" ? "paused"
        : blocked ? "blocked" : ended ? "ended" : "active";
      lane.stage = ({ failed: "运行失败", paused: "已中止", blocked: "等待处理", ended: "本轮结束" })[lane.state]
        || (active ? "正在推进" : p ? lane.done === lane.total ? "阶段已完成 · 收尾中" : "计划已就绪" : stageFromEvent(lane.feed.at(-1) || lane.last));
      lane.title = blocked?.title || active?.title || (p ? p.title : lane.depth ? "" : ended ? "本轮执行" : "正在处理你的请求");
      if (ended && lane.total && lane.done < lane.total) lane.stage += " · 待办未全部完成";
      const children = [...lanes.values()].filter(child => child !== lane && !child.terminal &&
        (child.parentTraceId ? lane.traceIds.has(child.parentTraceId) : child.parentId === lane.id));
      lane.waiting = !ended && lane.state === "active" && children.some(child => child.firstOrder >= lane.lastWorkOrder);
      if (lane.waiting) lane.stage = `等待${children.length > 1 ? ` ${children.length} 个` : ""}子任务返回`;
      if (ended) {
        const unresolved = [...lane.capabilities.values()].filter(c => ["失败", "受阻", "暂停", "结果待核对"].includes(c.phase)).at(-1);
        const label = lane.terminal === "failed" ? "执行失败" : lane.terminal === "interrupted" ? "已中止"
          : unresolved?.phase || (lane.terminal === "completed" && !blocked && (!lane.total || lane.done === lane.total) ? "已完成" : "已结束");
        lane.settled = { label, success: label === "已完成", detail: unresolved ? `${unresolved.source} · 详见执行回执`
          : lane.total && lane.done < lane.total ? "待办尚未全部完成" : lane.terminal === "incomplete" ? "任务尚未完成" : lane.depth ? "子任务已返回" : "本轮执行已结束" };
      }
    }
    return { lanes: [...lanes.values()], plans, mainAgent, live: options.live !== false, events };
  }

  function stageFromEvent(e) {
    if (!e) return "准备中";
    const msg = kind(e);
    if (msg === "spawn_subagent") return "协作中";
    if (msg.includes("reconnect") || e.tag === "WAIT") return "等待连接";
    if (msg.startsWith("workflow:") && !msg.endsWith("loaded")) return "流程执行中";
    if (msg === "skill:loaded" || msg === "workflow:loaded") return "读取能力";
    if (msg === "loop:tool-calls" || e.cls === "call") return "执行中";
    if (msg === "loop:final") return "正在收尾";
    return "处理中";
  }

  function ring(lane) {
    const count = lane.total ? `${lane.done}<small>/${lane.total}</small>` : '<span class="tp-orbit-core"></span>';
    const attrs = lane.primary ? `data-tp-plan="${esc(lane.primary.id)}" aria-haspopup="dialog" aria-expanded="false" aria-label="查看${esc(scopeLabels[lane.primary.scope])}，${lane.done}/${lane.total} 项完成"`
      : `aria-label="${esc(lane.stage)}，暂无结构化待办"`;
    const node = lane.primary ? "button" : "span";
    return `<${node} class="tp-orbit ${!lane.total && lane.state === "active" ? "is-indeterminate" : ""}" ${node === "button" ? 'type="button"' : ""} ${attrs}>
      <svg viewBox="0 0 56 56" aria-hidden="true"><circle class="tp-track" cx="28" cy="28" r="23"/><circle class="tp-arc" cx="28" cy="28" r="23" pathLength="100" style="stroke-dasharray:${lane.total ? 100 * lane.done / lane.total : lane.state === "active" ? 26 : 0} 100"/></svg>
      <span class="tp-count">${count}</span></${node}>`;
  }

  function planChip(p) {
    const n = p.steps.filter(s => s.status === "completed").length;
    return `<button type="button" class="tp-scope" data-scope="${p.scope}" data-tp-plan="${esc(p.id)}" aria-haspopup="dialog" aria-expanded="false"><i aria-hidden="true"></i>${scopeLabels[p.scope]} <span>${n}/${p.steps.length}</span></button>`;
  }

  function feedHtml(lane) {
    if (lane.settled) return `<div class="tp-settled${lane.settled.success ? " is-success" : ""}" role="status"><span class="tp-settled-mark" aria-hidden="true">${lane.settled.success ? "✓" : lane.state === "failed" ? "!" : "−"}</span><span><b>${esc(lane.settled.label)}</b><small>${esc(lane.settled.detail)}</small></span></div>`;
    if (!lane.feed.length) return '<div class="tp-feed-empty">等待执行回执<span aria-hidden="true"> · · ·</span></div>';
    return `<div class="tp-feed-window" tabindex="0" role="region" aria-label="${esc(names[lane.agent] || lane.agent)} 的实时细节，上下滚动查看，End 回到最新">${lane.feed.map((e, i) => `<div class="tp-feed-line${i === lane.feed.length - 1 ? " is-latest is-current" : ""}" data-event-key="${esc(eventKey(e))}" title="${esc(e.text)}"><span class="tp-feed-tag">${esc(e.tag)}</span><span class="tp-feed-text">${esc(e.text)}</span></div>`).join("")}</div><button class="tp-feed-latest" type="button" hidden>回到最新 ↓</button>`;
  }

  const chevron = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m6 4 4 4-4 4"/></svg>';
  const reviewText = e => String(e?.text || "").replace(/^[←→]\s*/, "").trim();
  // Display protocol envelopes as expandable data, never as proof of success.
  // Only the saved preview is available here; do not invent a fuller result.
  function recordData(text) {
    const payload = text.replace(/^[A-Z][A-Z0-9_]*_(?:RESULT|RECEIPT)\s*:?[\s\n]*/, "")
      .replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```$/, "").trim();
    if (!/^[\[{]/.test(payload)) return null;
    try { return JSON.stringify(JSON.parse(payload), null, 2); } catch { return payload; }
  }

  function reviewSummary(lane) {
    const failure = [...lane.events].reverse().find(e => kind(e) === "loop:interrupted" || kind(e) === "workflow:error");
    const final = [...lane.events].reverse().find(e => kind(e) === "loop:final");
    const result = ["failed", "paused"].includes(lane.state) && failure ? failure : final;
    if (result && reviewText(result)) {
      const text = reviewText(result);
      if (recordData(text) !== null) return "已返回结构化回执，展开可查看操作与返回内容。";
      return text.length > 240 ? text.slice(0, 240) + "…" : text;
    }
    const tools = lane.events.filter(e => kind(e) === "loop:tool-result" || e.cls === "result").length;
    if (tools) return `记录了 ${tools} 次工具返回，展开查看执行过程。`;
    return lane.settled?.detail || "展开查看本轮记录。";
  }

  function elapsedLabel(ms) {
    const seconds = Math.max(0, Math.floor(ms / 1000));
    return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
  }

  function reviewEvent(e, started) {
    const msg = kind(e), text = reviewText(e), data = recordData(text);
    const result = msg === "loop:tool-result" || e.cls === "result";
    const thinking = msg === "loop:thinking" || e.cls === "thinking";
    const call = msg === "loop:tool-calls" || (e.cls === "call" && /^STEP\b/.test(e.tag || ""));
    const label = result ? "工具返回" : thinking ? "思考记录" : call ? "调用工具" : msg === "loop:final" ? "最终回复"
      : msg === "spawn_subagent" ? "委派子任务" : msg.startsWith("workflow:") ? "工作流"
      : msg === "skill:loaded" ? "读取技能" : msg === "loop:interrupted" ? "运行中断" : e.tag || "运行记录";
    const tool = result ? e.tool || e.tag : "";
    const at = eventTime(e), relative = Number.isFinite(started) && Number.isFinite(at) && at >= started ? `+ ${elapsedLabel(at - started)}` : "";
    const folded = data !== null || thinking || (result && (text.includes("\n") || text.length > 120));
    const content = folded ? `<details class="tp-record" data-review-key="${esc(eventKey(e))}"><summary>${chevron}<span>${data !== null ? "结构化回执预览" : thinking ? "查看思考记录" : "查看返回内容"}</span></summary>${data !== null || result ? `<pre>${esc(data ?? text)}</pre>` : `<p>${esc(text)}</p>`}</details>`
      : `<p class="tp-event-text${call ? " is-code" : ""}">${esc(text || "未保存文字预览")}</p>`;
    return `<li class="tp-event"><div class="tp-event-heading"><span class="tp-event-kind">${esc(label)}</span>${tool ? `<code>${esc(tool)}</code>` : ""}${relative ? `<time>${relative}</time>` : ""}</div>${content}</li>`;
  }

  function renderReview(model, options) {
    const lanes = model.lanes.filter(lane => lane.events.length || lane.plans.length);
    const count = lanes.filter(lane => lane.depth).length;
    const rows = lanes.map(lane => {
      const events = projectFeed(lane.events, 400);
      const start = lane.events.find(e => kind(e) === "loop:start"), end = [...lane.events].reverse().find(e => kind(e) === "loop:end");
      const started = eventTime(start || {}), ended = eventTime(end || {});
      const duration = Number.isFinite(started) && Number.isFinite(ended) && ended >= started ? elapsedLabel(ended - started) : "";
      const outcome = lane.settled.success ? "success" : ["执行失败", "失败", "受阻"].includes(lane.settled.label) ? "attention" : "neutral";
      const mark = lane.settled.success ? '<path d="m5 10 3 3 7-7"/>' : outcome === "attention" ? '<path d="M10 5v6m0 3v.1"/>' : '<path d="M6 10h8"/>';
      return `<section class="tp-lane tp-review-lane" data-lane-id="${esc(lane.id)}" data-tone="${lane.tone}" data-state="${lane.state}" aria-label="${esc(lane.agent)} 的执行回顾">
        <div class="tp-review-marker">${lane.total ? ring(lane) : `<span class="tp-review-symbol" data-outcome="${outcome}" aria-hidden="true"><svg viewBox="0 0 20 20">${mark}</svg></span>`}</div>
        <div class="tp-review-body"><div class="tp-review-top"><b class="tp-review-name">${esc(names[lane.agent] || lane.agent)}</b><span class="tp-review-role">${lane.depth ? "子任务" : "主任务"}</span><span class="tp-review-status" data-outcome="${outcome}">${esc(lane.settled.label)}</span>${duration ? `<time class="tp-review-duration">${duration}</time>` : ""}</div>
          <p class="tp-review-summary">${esc(reviewSummary(lane))}</p>
          <div class="tp-scopes">${lane.plans.map(planChip).join("")}${[...lane.capabilities.values()].filter(c => !lane.plans.some(p => p.scope === c.scope && p.source === c.source)).map(c => `<span class="tp-capability">${esc(c.source)} · ${c.phase}</span>`).join("")}</div>
          ${events.length ? `<details class="tp-review-details" data-review-key="lane:${esc(lane.id)}"><summary>${chevron}<span class="tp-review-open-label">查看过程</span><span class="tp-review-close-label">收起过程</span><span class="tp-review-record-count">${events.length} 条</span></summary><ol class="tp-timeline">${events.map(e => reviewEvent(e, started)).join("")}</ol><p class="tp-review-note">按已保存的 Trace 展示，长返回可能仅保留预览。</p></details>` : ""}
        </div></section>`;
    }).join("");
    return `<div class="tp-board tp-review" data-mode="review"><div class="tp-heading"><span class="tp-heading-dot"></span><span>执行回顾</span>${count ? `<span class="tp-team">${count} 个子任务</span>` : ""}<span class="tp-hover-hint">${model.plans.size ? "点击进度查看待办" : "展开过程，查看记录"}</span></div><div class="tp-lanes">${rows}</div>${rawHtml(model, options)}</div>`;
  }

  function rawHtml(model, options = {}) {
    const raw = options.rowsHtml ? options.rowsHtml(model.events) : model.events.map(e => `<div class="ct-ev"><span class="ct-tag">${esc(e.tag)}</span><span class="ct-txt">${esc(e.text)}</span></div>`).join("");
    return `<details class="tp-raw"><summary><span>${model.live ? "执行细节" : "原始记录"}</span><span>${model.events.length} 条记录</span><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m5 6 3 3 3-3"/></svg></summary><div class="tp-raw-list" tabindex="0" aria-label="已保存的执行日志">${raw || '<span class="tp-feed-empty">尚无记录</span>'}</div></details>`;
  }

  function render(model, options = {}) {
    if (!model.live) return renderReview(model, options);
    const count = model.lanes.length - 1;
    const rows = model.lanes.map(lane => `<section class="tp-lane${lane.depth ? " tp-child" : ""}${lane.title ? "" : " tp-untitled"}${lane.waiting ? " is-waiting" : ""}" data-lane-id="${esc(lane.id)}" data-tone="${lane.tone}" data-state="${lane.state}" aria-label="${esc(lane.agent)} 的运行进度">
        <div class="tp-orbit-column">${ring(lane)}</div>
        <div class="tp-stage"><div class="tp-eyebrow"><span>${lane.depth ? "SUBAGENT" : "HARBOUR"}</span><b>${esc(names[lane.agent] || lane.agent)}</b></div>
          ${lane.title ? `<div class="tp-stage-title">${esc(lane.title)}</div>` : ""}<div class="tp-state">${esc(lane.stage)}</div>
          <div class="tp-scopes">${lane.plans.map(planChip).join("")}${[...lane.capabilities.values()].filter(c => !lane.plans.some(p => p.scope === c.scope && p.source === c.source)).slice(-3).map(c => `<span class="tp-capability" title="${esc(c.source)} · ${c.phase}">${esc(c.source)} · ${c.phase}</span>`).join("")}</div>
        </div>
        <div class="tp-feed" aria-label="最新执行细节">${feedHtml(lane)}</div>
      </section>`).join("");
    return `<div class="tp-board"><div class="tp-heading"><span class="tp-heading-dot"></span><span>${model.live ? "执行进度" : "执行回顾"}</span>${count ? `<span class="tp-team">${count} 个子任务</span>` : ""}<span class="tp-hover-hint">${model.plans.size ? "悬停圆环查看待办" : "按真实运行阶段展示"}</span></div>
      <div class="tp-lanes">${rows}</div>
      ${rawHtml(model, options)}</div>`;
  }

  // Only our append/trim-owned arrays are versioned. Unmanaged history arrays
  // keep the conservative path, so callers cannot accidentally cache a mutation.
  const revisions = new WeakMap();
  function trim(events, max = 400) {
    const before = events.length;
    while (events.length > max) {
      const disposable = events.findIndex(e => !e.progress && !e.plan && !["loop:start", "loop:end"].includes(kind(e)));
      events.splice(disposable < 0 ? 0 : disposable, 1);
    }
    if (events.length !== before) revisions.set(events, (revisions.get(events) || 0) + 1);
  }

  function append(events, event) {
    if (event.progress?.id) {
      const prior = events.findIndex(e => e.progress?.id === event.progress.id);
      if (prior >= 0) {
        if ((events[prior].progress.revision || 0) >= (event.progress.revision || 0)) return;
        events.splice(prior, 1);
      }
    } else {
      const key = eventKey(event);
      if (events.some(e => eventKey(e) === key)) return;
    }
    // Plan/loop anchors are retained; chatty log rows can age out without losing the Todo.
    events.push(event);
    revisions.set(events, (revisions.get(events) || 0) + 1);
    trim(events);
  }

  const mounted = new WeakMap();
  const feeds = new WeakMap();
  const reducedMotion = () => root.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
  let popup = null, anchor = null, activeHost = null, activeId = "", pinned = false, hideTimer;

  // Preserve rings, focused controls and other lanes instead of replacing the
  // whole board on each log event (which also restarted breathing animations).
  function patchNode(node, next) {
    if (node.nodeType !== next.nodeType || node.nodeName !== next.nodeName) { node.replaceWith(next); return; }
    if (node.nodeType !== 1) { if (node.textContent !== next.textContent) node.textContent = next.textContent; return; }
    const samePlan = node.hasAttribute("data-tp-plan") && node.dataset.tpPlan === next.dataset.tpPlan;
    const sameDisclosure = node.nodeName === "DETAILS" && node.dataset.reviewKey && node.dataset.reviewKey === next.dataset.reviewKey;
    const keep = name => samePlan && ["aria-expanded", "aria-controls"].includes(name) || sameDisclosure && name === "open";
    for (const attr of [...node.attributes]) if (!keep(attr.name) && !next.hasAttribute(attr.name)) node.removeAttribute(attr.name);
    for (const attr of next.attributes) if (!keep(attr.name) && node.getAttribute(attr.name) !== attr.value) node.setAttribute(attr.name, attr.value);
    const oldChildren = [...node.childNodes], newChildren = [...next.childNodes];
    for (let i = 0; i < Math.max(oldChildren.length, newChildren.length); i++) {
      if (!newChildren[i]) oldChildren[i].remove();
      else if (!oldChildren[i]) node.append(newChildren[i]);
      else patchNode(oldChildren[i], newChildren[i]);
    }
  }

  const feedRows = viewport => [...viewport.children];
  const feedTop = (viewport, row) => Math.max(0, row.offsetTop + row.offsetHeight / 2 - viewport.clientHeight / 2);
  function paintFeed(viewport) {
    const rows = feedRows(viewport);
    let nearest = 0, distance = Infinity;
    rows.forEach((row, i) => { const d = Math.abs(feedTop(viewport, row) - viewport.scrollTop); if (d < distance) { nearest = i; distance = d; } });
    rows.forEach((row, i) => { row.classList.toggle("is-current", i === nearest); row.classList.toggle("is-near", Math.abs(i - nearest) === 1); });
    const state = feeds.get(viewport.parentElement);
    if (state) {
      const atLatest = Math.abs(viewport.scrollTop - feedTop(viewport, rows.at(-1))) < 2;
      // Native smooth scrolling can emit its first frame at the old bottom.
      // Resume following only after the reader actually left and returned.
      if (state.manual && !atLatest) state.leftLatest = true;
      if (state.manual && state.leftLatest && atLatest) { state.following = true; state.manual = false; }
      const button = viewport.parentElement.querySelector(".tp-feed-latest");
      if (button) button.hidden = state.following;
    }
  }
  function scrollFeed(viewport, index, animate) {
    const row = viewport.children[index];
    if (!row) return;
    viewport.scrollTo({ top: feedTop(viewport, row), behavior: animate && !reducedMotion() ? "smooth" : "instant" });
    paintFeed(viewport);
  }
  function latestFeed(feed, animate = true) {
    const viewport = feed.querySelector(".tp-feed-window"), state = feeds.get(feed);
    if (!viewport || !state) return;
    state.following = true; state.manual = false;
    scrollFeed(viewport, viewport.children.length - 1, animate);
  }
  function wireFeed(feed) {
    const viewport = feed.querySelector(".tp-feed-window");
    if (!viewport) return;
    viewport.addEventListener("scroll", () => paintFeed(viewport), { passive: true });
    const beginReading = e => {
      const atLatest = Math.abs(viewport.scrollTop - feedTop(viewport, viewport.lastElementChild)) < 2;
      if (e.type === "wheel" && e.deltaY >= 0 && atLatest) return;
      const state = feeds.get(feed); state.manual = true; state.following = false; state.leftLatest = !atLatest;
    };
    viewport.addEventListener("wheel", beginReading, { passive: true });
    viewport.addEventListener("touchstart", beginReading, { passive: true });
    viewport.addEventListener("keydown", e => {
      if (!["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End"].includes(e.key)) return;
      e.preventDefault();
      const rows = feedRows(viewport), current = Math.max(0, rows.findIndex(row => row.classList.contains("is-current")));
      const index = Math.max(0, Math.min(rows.length - 1, e.key === "Home" ? 0 : e.key === "End" ? rows.length - 1 : current + ({ ArrowUp: -1, ArrowDown: 1, PageUp: -3, PageDown: 3 })[e.key]));
      const state = feeds.get(feed); state.following = index === rows.length - 1; state.manual = false;
      scrollFeed(viewport, index, true);
    });
    feed.querySelector(".tp-feed-latest")?.addEventListener("click", () => latestFeed(feed));
    latestFeed(feed, false);
  }
  function syncFeed(feed, next) {
    const html = next.innerHTML, state = feeds.get(feed);
    if (state?.html === html) return;
    const viewport = feed.querySelector(".tp-feed-window"), nextViewport = next.querySelector(".tp-feed-window");
    if (!state || !viewport || !nextViewport) {
      feed.innerHTML = html; feeds.set(feed, { html, following: true, manual: false }); wireFeed(feed); return;
    }
    const previous = feedRows(viewport), current = previous.find(row => row.classList.contains("is-current"));
    const offset = current ? viewport.scrollTop - feedTop(viewport, current) : 0;
    const byKey = new Map(previous.map(row => [row.dataset.eventKey, row]));
    const incoming = feedRows(nextViewport), keys = new Set(incoming.map(row => row.dataset.eventKey));
    for (const row of previous) if (!keys.has(row.dataset.eventKey)) row.remove();
    incoming.forEach((row, i) => {
      const existing = byKey.get(row.dataset.eventKey), item = existing || row;
      item.classList.toggle("is-latest", i === incoming.length - 1);
      if (viewport.children[i] !== item) viewport.insertBefore(item, viewport.children[i] || null);
    });
    state.html = html;
    if (current?.isConnected) viewport.scrollTop = feedTop(viewport, current) + offset;
    if (state.following) {
      const changed = previous.at(-1)?.dataset.eventKey !== incoming.at(-1)?.dataset.eventKey;
      latestFeed(feed, changed);
      // A status replacement can occupy the same slot: a short arrival still
      // communicates the change. No replay, polling or other lane restarts it.
      if (changed && !reducedMotion()) viewport.lastElementChild.animate(
        [{ opacity: .25, translate: "0 10px" }, { opacity: 1, translate: "0 0" }], { duration: 360, easing: "ease-out" });
    } else paintFeed(viewport);
  }

  function mount(host, events, options = {}) {
    const old = mounted.get(host), revision = revisions.get(events);
    if (revision !== undefined && old?.events === events && old.revision === revision
      && old.length === events.length && old.last === events.at(-1)
      && old.options.agent === options.agent && old.options.live === options.live
      && old.options.rowsHtml === options.rowsHtml) return false;
    const model = buildModel(events || [], options);
    const html = render(model, options);
    const memo = { html, model, options: { ...options }, events, revision, length: events?.length, last: events?.at(-1) };
    mounted.set(host, memo);
    if (old?.html === html) return false;
    const details = host.querySelector(".tp-raw"), log = host.querySelector(".tp-raw-list");
    const opened = !!details?.open, top = log?.scrollTop || 0;
    const follows = !log || log.scrollHeight - top - log.clientHeight < 36;
    const focus = host.contains(document.activeElement) ? document.activeElement : null;
    const focusedPlan = focus?.getAttribute("data-tp-plan"), focusRaw = focus?.matches(".tp-raw > summary"), focusLog = focus?.matches(".tp-raw-list");
    if (!old || old.model.live !== model.live || !host.querySelector(".tp-board")) {
      host.innerHTML = html;
      host.querySelectorAll(".tp-feed").forEach(feed => { feeds.set(feed, { html: feed.innerHTML, following: true, manual: false }); wireFeed(feed); });
    } else {
      const template = document.createElement("template"); template.innerHTML = html;
      const next = template.content, container = host.querySelector(".tp-lanes");
      patchNode(host.querySelector(".tp-heading"), next.querySelector(".tp-heading"));
      const lanes = new Map([...container.children].map(el => [el.dataset.laneId, el]));
      const nextLanes = [...next.querySelector(".tp-lanes").children];
      const ids = new Set(nextLanes.map(el => el.dataset.laneId));
      for (const [id, el] of lanes) if (!ids.has(id)) el.remove();
      nextLanes.forEach((nextLane, i) => {
        const lane = lanes.get(nextLane.dataset.laneId) || nextLane;
        if (container.children[i] !== lane) container.insertBefore(lane, container.children[i] || null);
        for (const attr of nextLane.attributes) if (lane.getAttribute(attr.name) !== attr.value) lane.setAttribute(attr.name, attr.value);
        if (!model.live) {
          if (lane !== nextLane) patchNode(lane, nextLane);
        } else {
          if (lane !== nextLane) {
            for (const part of [".tp-orbit-column", ".tp-stage"]) patchNode(lane.querySelector(part), nextLane.querySelector(part));
          }
          syncFeed(lane.querySelector(".tp-feed"), nextLane.querySelector(".tp-feed"));
        }
      });
      // Keep the open log and its focus/reading position; only patch its content.
      patchNode(host.querySelector(".tp-raw > summary"), next.querySelector(".tp-raw > summary"));
      const nextLog = next.querySelector(".tp-raw-list");
      if (log.innerHTML !== nextLog.innerHTML) log.innerHTML = nextLog.innerHTML;
    }
    host.classList.add("has-trace-progress");
    if (opened) {
      host.querySelector(".tp-raw").open = true;
      const list = host.querySelector(".tp-raw-list");
      list.scrollTop = follows ? list.scrollHeight : top;
    }
    if (focus && !focus.isConnected) {
      if (focusedPlan) findAnchor(host, focusedPlan)?.focus({ preventScroll: true });
      else if (focusRaw) host.querySelector(".tp-raw > summary")?.focus({ preventScroll: true });
      else if (focusLog) host.querySelector(".tp-raw-list")?.focus({ preventScroll: true });
    }
    if (activeHost === host) {
      anchor = findAnchor(host, activeId);
      if (anchor) showPlan(anchor, pinned); else closePlan();
    }
    return true;
  }

  function findAnchor(host, id) { return [...host.querySelectorAll("[data-tp-plan]")].find(el => el.dataset.tpPlan === id); }
  function planHtml(plan) {
    return `<div class="tp-pop-head"><span class="tp-pop-scope" data-scope="${plan.scope}">${scopeLabels[plan.scope]}</span><button type="button" data-tp-close aria-label="关闭待办">×</button></div>
      <h3 id="tp-pop-title">${esc(plan.title)}</h3>${plan.source ? `<p class="tp-pop-source">${esc(plan.source)}</p>` : ""}
      <ol class="tp-todos">${plan.steps.map(s => `<li data-status="${s.status}"><span class="tp-todo-mark" aria-hidden="true">${s.status === "completed" ? "✓" : s.status === "blocked" ? "!" : s.status === "cancelled" ? "−" : s.n}</span><div><span class="tp-todo-title">${esc(s.title)}</span>${s.detail ? `<p>${esc(s.detail)}</p>` : ""}</div><span class="tp-todo-state">${statusLabels[s.status]}</span></li>`).join("")}</ol><div class="tp-pop-note">阶段状态由执行者更新 · 不等同于耗时百分比</div>`;
  }

  function showPlan(button, pin = false) {
    clearTimeout(hideTimer);
    const host = button.closest(".has-trace-progress"), data = mounted.get(host), id = button.dataset.tpPlan;
    const plan = data?.model.plans.get(id);
    if (!plan) return;
    if (!popup) {
      popup = document.createElement("div"); popup.className = "tp-popover";
      popup.setAttribute("role", "dialog"); popup.setAttribute("aria-label", "阶段待办"); popup.id = "traceTodoPopover";
      document.body.append(popup);
      popup.addEventListener("pointerenter", () => clearTimeout(hideTimer));
      popup.addEventListener("pointerleave", hideSoon);
    }
    if (anchor && anchor !== button) anchor.setAttribute("aria-expanded", "false");
    anchor = button; activeHost = host; activeId = id; pinned = pin;
    button.setAttribute("aria-expanded", "true"); button.setAttribute("aria-controls", popup.id);
    const oldTop = popup.scrollTop;
    const html = planHtml(plan);
    if (popup._html !== html) {
      const focusClose = popup.contains(document.activeElement);
      popup.innerHTML = html; popup._html = html;
      if (focusClose) popup.querySelector("[data-tp-close]")?.focus({ preventScroll: true });
    }
    popup.scrollTop = oldTop; popup.hidden = false;
    positionPlan();
  }

  function positionPlan() {
    if (!popup || popup.hidden) return;
    if (!anchor?.isConnected || !activeHost?.isConnected) { closePlan(); return; }
    const r = anchor.getBoundingClientRect(), gap = 12, pad = 12;
    if (r.bottom < 0 || r.top > innerHeight) { closePlan(); return; }
    popup.style.maxHeight = `${Math.max(160, innerHeight - pad * 2)}px`;
    const height = popup.getBoundingClientRect().height, width = popup.getBoundingClientRect().width;
    const below = r.bottom + gap, above = r.top - height - gap;
    const top = below + height < innerHeight - pad ? below : above >= pad ? above : Math.max(pad, Math.min(below, innerHeight - height - pad));
    popup.style.top = `${top}px`;
    popup.style.left = `${Math.max(pad, Math.min(r.left, innerWidth - width - pad))}px`;
  }

  function closePlan(refocus = false) {
    clearTimeout(hideTimer);
    if (popup) popup.hidden = true;
    if (anchor) { anchor.setAttribute("aria-expanded", "false"); if (refocus && anchor.isConnected) anchor.focus({ preventScroll: true }); }
    anchor = null; activeHost = null; activeId = ""; pinned = false;
  }
  function hideSoon() { if (!pinned) { clearTimeout(hideTimer); hideTimer = setTimeout(() => closePlan(), 180); } }

  if (typeof document !== "undefined") {
    document.addEventListener("pointerover", e => { const b = e.target.closest?.("[data-tp-plan]"); if (b && !pinned && b !== anchor) showPlan(b); });
    document.addEventListener("pointerout", e => { if (e.target.closest?.("[data-tp-plan]") && !e.relatedTarget?.closest?.("[data-tp-plan],.tp-popover")) hideSoon(); });
    document.addEventListener("focusin", e => { const b = e.target.closest?.("[data-tp-plan]"); if (b && !pinned) showPlan(b); });
    document.addEventListener("focusout", e => { if (e.target.closest?.("[data-tp-plan],.tp-popover") && !e.relatedTarget?.closest?.("[data-tp-plan],.tp-popover")) hideSoon(); });
    document.addEventListener("click", e => {
      const b = e.target.closest?.("[data-tp-plan]");
      if (b) { if (pinned && b === anchor) closePlan(); else showPlan(b, true); }
      else if (e.target.closest?.("[data-tp-close]")) closePlan(true);
      else if (!e.target.closest?.(".tp-popover")) closePlan();
    });
    document.addEventListener("keydown", e => { if (e.key === "Escape" && popup && !popup.hidden) { e.preventDefault(); closePlan(true); } });
    const layoutFeeds = scope => scope.querySelectorAll(".tp-feed").forEach(feed => {
      if (feeds.get(feed)?.following) latestFeed(feed, false);
      else { const viewport = feed.querySelector(".tp-feed-window"); if (viewport) paintFeed(viewport); }
    });
    window.addEventListener("resize", () => { positionPlan(); layoutFeeds(document); });
    document.addEventListener("toggle", e => { if (e.target.open) layoutFeeds(e.target); }, true);
    document.addEventListener("scroll", positionPlan, true);
    // Chat routing replaces nodes; never leave an orphaned floating Todo over another page.
    new MutationObserver(() => { if (anchor && !anchor.isConnected) closePlan(); }).observe(document.body, { childList: true, subtree: true });
  }
  const api = { buildModel, render, mount, append, trim, closePlan };
  root.HarbourTrace = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
