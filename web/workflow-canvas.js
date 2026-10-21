/* Harbour 固定工作流画布：展示映射 ≠ 任意 DAG 编辑器；备注不进入模型。 */
(() => {
  "use strict";
  const drafts = new Map();
  const KINDS = { agent: ["LLM", "✦"], knowledge: ["知识 · 资料", "▤"], code: ["CODE · 脚本", "⌘"],
    model: ["IMAGE MODEL", "◈"], state: ["STATE · 落盘", "▣"], human: ["HUMAN · 人工", "✓"] };
  const PHASES = { before: "调用前", executor: "Workflow 内", after: "返回后" };
  const esc = text => String(text ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const copy = value => JSON.parse(JSON.stringify(value));
  const W = 248, H = 126;
  function fingerprint(document) {
    const normalized = { ...document, notes: Object.fromEntries(Object.entries(document.notes)
      .filter(([, text]) => text !== "").map(([id, text]) => [id, text.replace(/\r\n?/g, "\n")])) };
    return JSON.stringify(normalized, (_key, value) => value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.keys(value).sort().map(key => [key, value[key]])) : value);
  }
  function dirty(state) { return fingerprint(state.document) !== fingerprint(state.saved); }

  async function mount(host, name, services) {
    const { api, toast } = services;
    const token = Symbol("workflow mount"); host._workflowMount = token;
    host.innerHTML = '<div class="wf-loading">正在读取执行器流程…</div>';
    const alive = () => host.isConnected && host._workflowMount === token;
    let remote;
    try { remote = await api(`/api/workflow-graphs/${encodeURIComponent(name)}`); }
    catch (error) {
      if (alive()) {
        host.innerHTML = `<div class="wf-unavailable"><b>流程画布暂不可用</b><p>${esc(error.message)}</p>
          <p>仍可切到「文件与契约」。如果刚更新了执行器代码，请重启所连接的 Harbour 后端后重试；画布不需要单独部署。</p>
          <button type="button" class="btn primary" data-wf="retry">重新加载画布</button></div>`;
        host.querySelector('[data-wf="retry"]').addEventListener("click", () => { if (alive()) void mount(host, name, services); });
      }
      return;
    }
    if (!alive()) return;
    let state = drafts.get(name);
    if (!state || (!dirty(state) && !state.pending)) {
      state = { document: copy(remote.document), saved: copy(remote.document), revision: remote.revision,
        selected: remote.definition.nodes[0]?.id, zoom: 1, x: 0, y: 0, fitted: false };
      drafts.set(name, state);
    }
    const definition = remote.definition;
    const conflict = state.revision !== remote.revision;
    let sourceEpoch = 0;
    host.innerHTML = `
      <div class="wf-summary"><div><span class="wf-eyebrow">WORKFLOW STUDIO · 固定编排</span><h4>${esc(definition.title)}</h4>
        <p>${esc(definition.description)}</p></div><span class="wf-counter">${definition.nodes.length}<small>步骤</small></span></div>
      <div class="wf-toolbar">
        <div class="wf-tool-group"><button type="button" class="btn ghost" data-wf="fit" title="查看完整流程">适应画布</button>
          <button type="button" class="btn ghost icon" data-wf="minus" aria-label="缩小流程图">−</button><output class="wf-zoom">100%</output>
          <button type="button" class="btn ghost icon" data-wf="plus" aria-label="放大流程图">＋</button>
          <button type="button" class="btn ghost" data-wf="focus">展开画布</button></div>
        <div class="wf-tool-group"><span class="wf-save-status" role="status"></span>
          <button type="button" class="btn ghost" data-wf="reset">重置布局</button>
          <button type="button" class="btn ghost" data-wf="cancel">取消修改</button>
          <button type="button" class="btn primary" data-wf="save">保存并提交审批</button></div>
      </div>
      <div class="wf-notice" role="status" ${!conflict && !state.pending ? "hidden" : ""}></div>
      <div class="wf-workspace">
        <section class="wf-stage" tabindex="0" aria-label="工作流画布。拖动空白平移，选择节点查看详情，方向键移动所选节点。">
          <div class="wf-world"><svg class="wf-edges" aria-hidden="true"></svg><div class="wf-nodes"></div></div>
          <div class="wf-canvas-hint">拖动节点布局 · 空白处平移 · Ctrl + 滚轮缩放</div>
        </section>
        <aside class="wf-inspector" aria-label="节点详情与编辑"></aside>
      </div>
      <div class="wf-foot"><div class="wf-legend">${Object.entries(KINDS).map(([kind, [label]]) => `<span data-kind="${kind}"><i></i>${esc(label)}</span>`).join("")}</div>
        <p>布局 / 备注不影响执行。已绑定参数经审批后用于新任务；连线来自 TypeScript，不支持在此增删或重排执行步骤。</p></div>`;
    const q = selector => host.querySelector(selector);
    const stage = q(".wf-stage"), world = q(".wf-world"), edges = q(".wf-edges"), nodeBox = q(".wf-nodes");
    function notice(text) { const el = q(".wf-notice"); el.hidden = !text; el.textContent = text; }
    if (conflict) notice("服务端已有更新。你的本地草稿仍保留；请取消修改并重新载入后再提交。");
    else if (state.pending) showPending();
    function showPending() {
      const el = q(".wf-notice"); el.hidden = false;
      el.innerHTML = `提案 ${esc(state.pending)} 已保存，尚未应用。<a href="#governance">前往 Governance 审批</a> · 审批后重新载入即可查看生效版本。`;
    }
    let basePositions = {};
    const position = id => state.document.positions[id] || basePositions[id] || definition.nodes.find(n => n.id === id);
    function freezeLayout() {
      // 第一次手动拖动时冻结全部节点，避免换窗口比例后未拖动节点独自跳位。
      if (!Object.keys(state.document.positions).length) state.document.positions = Object.fromEntries(definition.nodes.map(n => [n.id, { x: position(n.id).x, y: position(n.id).y }]));
    }
    function bounds() {
      return { width: Math.max(...definition.nodes.map(n => position(n.id).x + W)) + 40,
        height: Math.max(...definition.nodes.map(n => position(n.id).y + H)) + 72 };
    }
    function viewport() {
      world.style.transform = `translate(${state.x}px, ${state.y}px) scale(${state.zoom})`;
      q(".wf-zoom").textContent = `${Math.round(state.zoom * 100)}%`;
    }
    function fit() {
      const r = stage.getBoundingClientRect();
      if (!r.width || !r.height) return;
      basePositions = r.width / r.height > 1.8 ? (definition.widePositions || {}) : {};
      nodeBox.querySelectorAll("[data-node]").forEach(el => { const p = position(el.dataset.node); el.style.left = `${p.x}px`; el.style.top = `${p.y}px`; });
      renderEdges();
      const b = bounds();
      state.zoom = Math.max(.3, Math.min(1, (r.width - 36) / b.width, (r.height - 50) / b.height));
      state.x = (r.width - b.width * state.zoom) / 2; state.y = Math.max(12, (r.height - b.height * state.zoom) / 2 - 8);
      state.fitted = true; viewport();
    }
    function zoom(amount, x = stage.clientWidth / 2, y = stage.clientHeight / 2) {
      const previous = state.zoom; state.zoom = Math.max(.25, Math.min(1.8, previous * amount));
      state.x = x - (x - state.x) * state.zoom / previous;
      state.y = y - (y - state.y) * state.zoom / previous; viewport();
    }
    function controls() {
      if (!alive()) return;
      const changed = dirty(state);
      if (changed || state.pending || state.saving) drafts.set(name, state);
      else if (drafts.get(name) === state) drafts.delete(name);
      q(".wf-save-status").textContent = state.saving ? "正在提交…" : changed ? "有未保存修改" : state.pending ? "已保存为待审批提案" : "已与已加载版本一致";
      q('[data-wf="save"]').disabled = state.saving || !changed || conflict || !!state.pending;
      q('[data-wf="cancel"]').disabled = state.saving || (!changed && !conflict && !state.pending);
      q('[data-wf="reset"]').disabled = state.saving || !!state.pending;
      q(".wf-inspector").querySelectorAll("input,textarea").forEach(el => { el.disabled = state.saving || !!state.pending; });
      stage.classList.toggle("wf-readonly", state.saving || !!state.pending);
    }
    function renderEdges() {
      const b = bounds(); edges.setAttribute("width", b.width + 40); edges.setAttribute("height", b.height + 40);
      edges.innerHTML = `<defs><marker id="wf-arrow-${name}" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto"><path d="M1 1 L7 4 L1 7" fill="none" stroke="currentColor" stroke-width="1.4"/></marker></defs>` + definition.edges.map(edge => {
        const a = position(edge.from), z = position(edge.to);
        const dx = z.x - a.x, dy = z.y - a.y;
        let sx, sy, tx, ty, d, lx, ly;
        if (Math.abs(dx) > Math.abs(dy)) {
          sx = a.x + (dx > 0 ? W : 0); sy = a.y + H / 2;
          tx = z.x + (dx > 0 ? 0 : W); ty = z.y + H / 2;
          d = `M${sx},${sy} C${(sx + tx) / 2},${sy} ${(sx + tx) / 2},${ty} ${tx},${ty}`;
        } else {
          sx = a.x + W / 2; sy = a.y + (dy > 0 ? H : 0);
          tx = z.x + W / 2; ty = z.y + (dy > 0 ? 0 : H);
          d = `M${sx},${sy} C${sx},${(sy + ty) / 2} ${tx},${(sy + ty) / 2} ${tx},${ty}`;
        }
        lx = (sx + tx) / 2; ly = (sy + ty) / 2 - 10;
        if (edge.label && Math.abs(dx) > Math.abs(dy) && Math.abs(sx - tx) < edge.label.length * 12 + 24) {
          // 短连线标签放在节点上方的留白，避免被卡片遮掉前后字。
          ly = Math.min(a.y, z.y) - 16;
        }
        if (edge.kind === "loop") {
          sx = a.x + W / 2; sy = a.y + H; tx = z.x + W; ty = z.y + H / 2;
          const bottom = b.height - 28, right = b.width - 14;
          d = `M${sx},${sy} L${sx},${bottom} Q${sx},${bottom + 8} ${sx + 8},${bottom + 8} L${right},${bottom + 8} L${right},${ty} L${tx},${ty}`;
          lx = (sx + right) / 2; ly = bottom - 8;
        }
        const labelWidth = (edge.label?.length || 0) * 12 + 16;
        return `<g class="wf-edge ${esc(edge.kind || "flow")}"><path d="${d}" marker-end="url(#wf-arrow-${name})"/>${edge.label ? `<rect x="${lx - labelWidth / 2}" y="${ly - 13}" width="${labelWidth}" height="22" rx="7"/><text x="${lx}" y="${ly + 2}" text-anchor="middle">${esc(edge.label)}</text>` : ""}</g>`;
      }).join("");
    }
    function renderNodes() {
      nodeBox.innerHTML = definition.nodes.map((node, index) => {
        const p = position(node.id), [label, icon] = KINDS[node.kind];
        return `<button type="button" class="wf-node${state.selected === node.id ? " selected" : ""}" data-node="${esc(node.id)}" data-kind="${node.kind}"
          aria-pressed="${state.selected === node.id}" style="left:${p.x}px;top:${p.y}px" title="${esc(node.title)}：${esc(node.summary)}">
          <span class="wf-node-meta"><span>${esc(icon)} ${esc(label)}</span><small>${esc(PHASES[node.phase])}</small></span>
          <b>${esc(node.title)}</b><span class="wf-node-summary">${esc(node.summary)}</span>
          <span class="wf-node-index">${String(index + 1).padStart(2, "0")}${definition.settings.some(s => s.node === node.id) ? " · 可调参数" : ""}${state.document.notes[node.id] ? " · 备注" : ""}</span></button>`;
      }).join("");
    }
    function select(id, focus = false) {
      state.selected = id;
      nodeBox.querySelectorAll("[data-node]").forEach(el => {
        const selected = el.dataset.node === id; el.classList.toggle("selected", selected); el.setAttribute("aria-pressed", String(selected));
        if (focus && selected) el.focus({ preventScroll: true });
      });
      renderInspector(); controls();
    }
    function renderInspector() {
      sourceEpoch++;
      const node = definition.nodes.find(n => n.id === state.selected) || definition.nodes[0];
      if (!node) return;
      const fields = definition.settings.filter(s => s.node === node.id);
      q(".wf-inspector").innerHTML = `<div class="wf-inspector-label">节点详情 <span>${esc(PHASES[node.phase])}</span></div>
        <h5>${esc(node.title)}</h5><span class="wf-type" data-kind="${node.kind}">${esc(KINDS[node.kind][0])}</span>
        <p class="wf-node-detail">${esc(node.detail)}</p>
        ${fields.length ? `<section class="wf-property-section"><h6>执行参数 <span>绑定代码</span></h6>${fields.map(field => `<label class="wf-field">${esc(field.label)}
          <input class="inp" type="number" min="${field.min}" max="${field.max}" step="1" value="${state.document.settings[field.key]}" data-setting="${esc(field.key)}">
          <small>${esc(field.description)}</small></label>`).join("")}</section>` : ""}
        <section class="wf-property-section"><h6>个人备注 <span>仅画布</span></h6><textarea class="inp wf-note" rows="3" maxlength="1200" aria-label="节点备注" placeholder="解释这个步骤，或记下下一次的改造想法…">${esc(state.document.notes[node.id] || "")}</textarea><small>不进入 Prompt，不会改变步骤的行为。</small></section>
        ${node.source ? `<section class="wf-property-section"><h6>实际实现 <span>只读</span></h6><code class="wf-source-path">${esc(node.source.path)}</code>
          <button class="btn ghost" type="button" data-wf="source">查看实现片段 ↗</button><div class="wf-source" hidden></div></section>` : ""}
        <details class="wf-step-index"><summary>全部 ${definition.nodes.length} 个步骤</summary>${definition.nodes.map(n => `<button type="button" data-select-node="${esc(n.id)}">${esc(n.title)} <small>${esc(KINDS[n.kind][0])}</small></button>`).join("")}</details>`;
      q(".wf-note").addEventListener("input", e => {
        if (!alive() || state.saving || state.pending) return;
        const value = e.target.value;
        if (!value && !Object.hasOwn(state.saved.notes, node.id)) delete state.document.notes[node.id];
        else state.document.notes[node.id] = value;
        controls();
      });
      q(".wf-inspector").querySelectorAll("[data-setting]").forEach(input => input.addEventListener("input", () => {
        if (!alive() || state.saving || state.pending) return;
        state.document.settings[input.dataset.setting] = input.value === "" ? null : Number(input.value); controls();
      }));
      q(".wf-inspector").querySelectorAll("[data-select-node]").forEach(button => button.addEventListener("click", () => {
        const id = button.dataset.selectNode, p = position(id);
        select(id, true); state.zoom = Math.max(state.zoom, .8);
        state.x = stage.clientWidth / 2 - (p.x + W / 2) * state.zoom;
        state.y = stage.clientHeight / 2 - (p.y + H / 2) * state.zoom; viewport();
      }));
      q('[data-wf="source"]')?.addEventListener("click", async () => {
        const box = q(".wf-source"), epoch = ++sourceEpoch; box.hidden = false; box.textContent = "读取中…";
        try {
          const result = await api(`/api/workflow-graphs/${encodeURIComponent(name)}/source?node=${encodeURIComponent(node.id)}`);
          if (!alive() || epoch !== sourceEpoch || !box.isConnected) return;
          box.innerHTML = `<small>第 ${result.startLine}–${result.endLine} 行 / 共 ${result.totalLines} 行</small><pre></pre>`;
          box.querySelector("pre").textContent = result.content;
        } catch (error) { if (alive() && epoch === sourceEpoch && box.isConnected) box.textContent = error.message; }
      });
    }
    let drag;
    stage.addEventListener("pointerdown", event => {
      if (!alive() || event.button !== 0 || event.target.closest(".wf-canvas-hint")) return;
      const button = event.target.closest("[data-node]"), id = button?.dataset.node;
      if (id) select(id);
      drag = { id: state.saving || state.pending ? null : id, pointer: event.pointerId, sx: event.clientX, sy: event.clientY,
        original: id ? { x: position(id).x, y: position(id).y } : { x: state.x, y: state.y }, moved: false };
      if (id && (state.saving || state.pending)) { drag = null; return; }
      stage.setPointerCapture(event.pointerId);
    });
    stage.addEventListener("pointermove", event => {
      if (!alive() || !drag || drag.pointer !== event.pointerId || (drag.id && (state.saving || state.pending))) return;
      const dx = event.clientX - drag.sx, dy = event.clientY - drag.sy;
      if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 5) return;
      drag.moved = true;
      if (drag.id) {
        freezeLayout();
        const p = { x: Math.round(Math.max(0, Math.min(8000, drag.original.x + dx / state.zoom))),
          y: Math.round(Math.max(0, Math.min(8000, drag.original.y + dy / state.zoom))) };
        state.document.positions[drag.id] = p;
        const el = nodeBox.querySelector(`[data-node="${drag.id}"]`); el.style.left = `${p.x}px`; el.style.top = `${p.y}px`;
        renderEdges(); controls();
      } else { state.x = drag.original.x + dx; state.y = drag.original.y + dy; viewport(); }
    });
    const endDrag = () => { drag = null; };
    stage.addEventListener("pointerup", endDrag); stage.addEventListener("pointercancel", endDrag); stage.addEventListener("lostpointercapture", endDrag);
    nodeBox.addEventListener("click", event => { const id = event.target.closest("[data-node]")?.dataset.node; if (id && state.selected !== id) select(id); });
    stage.addEventListener("keydown", event => {
      const id = event.target.closest("[data-node]")?.dataset.node;
      if (alive() && id && !state.saving && !state.pending && ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
        freezeLayout();
        event.preventDefault(); const p = position(id), amount = event.shiftKey ? 30 : 10;
        state.document.positions[id] = { x: Math.max(0, Math.min(8000, p.x + (event.key === "ArrowLeft" ? -amount : event.key === "ArrowRight" ? amount : 0))),
          y: Math.max(0, Math.min(8000, p.y + (event.key === "ArrowUp" ? -amount : event.key === "ArrowDown" ? amount : 0))) };
        renderNodes(); renderEdges(); select(id, true); controls();
      }
    });
    stage.addEventListener("wheel", event => {
      event.preventDefault();
      if (event.ctrlKey || event.metaKey) { const r = stage.getBoundingClientRect(); zoom(event.deltaY < 0 ? 1.1 : 1 / 1.1, event.clientX - r.x, event.clientY - r.y); }
      else { state.x -= event.deltaX; state.y -= event.deltaY; viewport(); }
    }, { passive: false });
    q('[data-wf="fit"]').onclick = fit;
    q('[data-wf="plus"]').onclick = () => zoom(1.2);
    q('[data-wf="minus"]').onclick = () => zoom(1 / 1.2);
    q('[data-wf="focus"]').onclick = () => {
      const expanded = host.closest(".cap-layout").classList.toggle("wf-expanded");
      q('[data-wf="focus"]').textContent = expanded ? "显示能力目录" : "展开画布";
      requestAnimationFrame(fit);
    };
    q('[data-wf="reset"]').onclick = () => {
      if (!alive() || state.saving || state.pending) return;
      state.document.positions = {}; renderNodes(); renderEdges(); controls(); fit();
    };
    function discard() {
      if (!alive() || state.saving) return false;
      drag = null; sourceEpoch++;
      state.document = copy(state.saved); state.error = null;
      renderNodes(); renderEdges(); renderInspector(); controls();
      if (state.pending) showPending();
      else if (conflict) notice("服务端已有更新。已放弃本地修改；重新载入后可编辑最新版本。");
      else notice("");
      return !dirty(state);
    }
    q('[data-wf="cancel"]').onclick = async () => {
      if (!alive() || state.saving) return false;
      if (dirty(state) && !await services.confirm("将放弃尚未提交的布局、备注与参数修改。已提交的提案不会被撤回。", { title: "取消画布修改？", confirmLabel: "放弃并重新载入" })) return;
      if (!discard()) return false;
      drafts.delete(name); await mount(host, name, services);
      return true;
    };
    async function save() {
      if (!alive() || state.saving) return false;
      if (!dirty(state)) return true;
      if (conflict || state.pending) return false;
      for (const field of definition.settings) {
        const v = state.document.settings[field.key];
        if (!Number.isInteger(v) || v < field.min || v > field.max) { toast(`${field.label} 必须为 ${field.min}–${field.max} 的整数`, true); return false; }
      }
      const submitted = copy(state.document);
      state.saving = true; state.error = null; controls();
      try {
        const result = await api(`/api/workflow-graphs/${encodeURIComponent(name)}/proposals`, { method: "POST",
          body: JSON.stringify({ revision: state.revision, document: submitted }) });
        if (!result?.proposal?.id) throw new Error("后端未确认提案已保存；本地修改已保留。");
        // Saving is a Governance proposal, not an application. This snapshot is
        // now safely persisted; a newer local document must remain unsaved.
        state.saved = submitted;
        state.pending = result.proposal.id;
        if (alive()) { showPending(); toast("画布已保存为提案；审批应用后生效，不会启动任务"); }
        return alive() && !dirty(state);
      } catch (error) { state.error = error.message; if (alive()) { notice(error.message); toast(error.message, true); } return false; }
      finally { state.saving = false; state.onChange?.(); }
    }
    q('[data-wf="save"]').onclick = save;
    const editor = { isActive: alive, isDirty: () => dirty(state), isBusy: () => !!state.saving,
      label: `Workflow ${definition.title || name} · 流程画布`,
      version: () => `${state.revision}|${state.pending || ""}|${fingerprint(state.document)}`, save, discard };
    window.HarbourUnsavedChanges?.register(`workflow-graph:${name}`, editor);
    state.onChange = () => { if (alive()) { controls(); if (state.pending) showPending(); else if (state.error) notice(state.error); } };
    renderNodes(); renderEdges(); renderInspector(); controls(); viewport();
    requestAnimationFrame(() => { if (alive()) fit(); });
    const resize = new ResizeObserver(() => { if (alive()) { if (!drag) fit(); } else resize.disconnect(); });
    resize.observe(stage);
    return editor;
  }
  window.HarbourWorkflowCanvas = { mount };
})();
