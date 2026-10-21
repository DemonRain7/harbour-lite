/* Shared, presentation-only session controls for Dashboard and the desktop orb.
 * Hosts own catalogs, permission checks and persistence. Never invent model/effort options. */
(() => {
  const modes = {
    plan: ['仅规划', '只读分析与规划，不执行修改。'],
    default: ['按需确认', '需要批准的操作会先询问。'],
    acceptEdits: ['自动编辑', '自动批准文件编辑，其它操作仍按权限处理。'],
    dontAsk: ['不弹询问', '未获授权的操作仍会被拒绝，不代表完全访问。'],
    auto: ['自动判断', '由执行后端判断操作是否需要批准。'],
    bypassPermissions: ['跳过确认', '绕过执行后端的交互批准；Harbour 治理与身份边界仍生效。'],
  };
  const icons = {
    down: 'm6 9 6 6 6-6', back: 'm14 6-6 6 6 6', check: 'm5 12 4 4L19 6',
    bolt: 'm13 2-9 12h7l-1 8 10-12h-7Z', reset: 'M3 10a9 9 0 1 1 2 8M3 4v6h6',
    shield: 'M12 3 3 7v5c0 5 9 9 9 9s9-4 9-9V7ZM12 8v5m0 3h.01',
    close: 'm6 6 12 12M6 18 18 6',
  };
  const svg = name => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${icons[name]}"/></svg>`;
  const node = (tag, cls, text) => { const el = document.createElement(tag); el.className = cls; if (text !== undefined) el.textContent = text; return el; };
  const titleCase = value => ({ xhigh: 'Extra high', none: '关闭', minimal: 'Minimal' }[value] || (value ? value[0].toUpperCase() + value.slice(1) : '默认'));
  let serial = 0;
  class RunPicker {
    constructor({ host, boundary, anchorRegion, onChange, onOpen, modelId, modelLabelId, modeId }) {
      Object.assign(this, { host, boundary, anchorRegion, onChange, onOpen });
      this.id = `run-picker-${++serial}`; this.state = { models: [], config: {}, defaults: {} }; this.openSeq = 0;
      host.classList.add('run-picker'); this.abort = new AbortController();
      this.mode = this.button('rp-trigger rp-mode', '', () => this.open('mode'));
      this.mode.innerHTML = svg('shield'); this.modeLabel = node('span', 'rp-mode-label'); this.mode.append(this.modeLabel);
      this.model = this.button('rp-trigger rp-model', '', () => this.open('effort'));
      this.modelLabel = node('span', 'rp-model-label', '选择模型'); this.effortLabel = node('span', 'rp-effort-label');
      this.model.append(this.modelLabel, this.effortLabel); this.model.insertAdjacentHTML('beforeend', svg('down'));
      if (modelId) this.model.id = modelId;
      if (modelLabelId) this.modelLabel.id = modelLabelId;
      if (modeId) this.mode.id = modeId;
      this.popup = node('section', 'run-picker-popup'); this.popup.id = this.id; this.popup.hidden = true;
      this.popup.setAttribute('role', 'dialog'); this.popup.setAttribute('aria-label', '当前对话的运行设置');
      this.popup.tabIndex = -1; document.body.append(this.popup); host.replaceChildren(this.mode, this.model);
      for (const trigger of [this.mode, this.model]) {
        trigger.setAttribute('aria-haspopup', 'dialog'); trigger.setAttribute('aria-controls', this.id); trigger.setAttribute('aria-expanded', 'false');
      }
      document.addEventListener('pointerdown', event => {
        if (this.view && !this.popup.contains(event.target) && !host.contains(event.target)) this.close(false);
      }, { capture: true, signal: this.abort.signal });
      document.addEventListener('keydown', event => this.keydown(event), { capture: true, signal: this.abort.signal });
      window.addEventListener('resize', () => this.position(), { signal: this.abort.signal });
      document.addEventListener('scroll', event => {
        if (this.view && !this.popup.contains(event.target)) this.position();
      }, { capture: true, passive: true, signal: this.abort.signal });
    }
    button(cls, label, click, key) {
      const el = node('button', cls, label); el.type = 'button'; el.onclick = click; if (key) el.dataset.key = key; return el;
    }
    effective() {
      const { config = {}, defaults = {}, models = [] } = this.state;
      const ref = config.modelRef || defaults.modelRef || '';
      const model = models.find(row => row.value === ref);
      const efforts = model?.efforts || [];
      const preferred = model?.defaultEffort || defaults.reasoningEffort;
      const fallback = efforts.some(row => row.effort === preferred) ? preferred
        : efforts.some(row => row.effort === model?.fallbackEffort) ? model.fallbackEffort
          : efforts.some(row => row.effort === 'medium') ? 'medium' : efforts[0]?.effort || '';
      return { ref, model, efforts, effort: config.reasoningEffort || fallback, fallback, mode: config.permissionMode || defaults.permissionMode || '' };
    }
    update(state) {
      if (this.state.identity !== undefined && state.identity !== this.state.identity) { this.close(false); this.error = ''; }
      this.state = state; this.render();
    }
    render() {
      const { model, ref, effort, mode } = this.effective();
      this.modelLabel.textContent = model?.label || this.state.modelLabel || ref || '选择模型';
      this.effortLabel.textContent = effort ? titleCase(effort) : '';
      this.modeLabel.textContent = modes[mode]?.[0] || mode || '权限';
      this.mode.dataset.risk = mode === 'bypassPermissions' ? 'high' : 'normal';
      this.host.dataset.locked = String(!!this.state.locked);
      const lock = this.state.locked ? this.state.lockReason || '当前任务运行或同步中；结束后可修改。' : '仅调整当前对话，不改变 Agent 默认配置。';
      this.model.title = `${this.modelLabel.textContent} · ${titleCase(effort)}\n${lock}`;
      this.model.setAttribute('aria-label', `模型与思考强度 · ${this.modelLabel.textContent} · ${titleCase(effort)}`);
      this.mode.title = `${modes[mode]?.[1] || ''}\n${lock}`;
      this.mode.setAttribute('aria-label', `操作权限 · ${this.modeLabel.textContent}`);
      this.model.disabled = this.mode.disabled = !!this.state.readOnly;
      if (this.state.readOnly) this.close(false);
      if (this.view) this.renderPopup();
    }
    async open(view = 'effort') {
      if (this.state.readOnly) return;
      if (this.view === view) { this.close(); return; }
      const wasOpen = !!this.view;
      this.view = view; this.query = '';
      this.anchor = view === 'mode' ? this.mode : this.model;
      // Switching tabs shares the in-flight catalog read. Do not clear its lock,
      // discard its failure, or invalidate its completion just to change views.
      if (wasOpen) { this.renderPopup(); this.focusInitial(); return; }
      this.error = '';
      const seq = ++this.openSeq;
      this.loading = !!this.onOpen; this.loadFailed = false;
      this.popup.hidden = false; this.renderPopup();
      try { await this.onOpen?.(); }
      catch (error) { if (seq === this.openSeq) { this.loadFailed = true; this.error = error.message || '读取失败，请关闭后重试。'; } }
      if (seq !== this.openSeq || !this.view) return;
      this.loading = false; this.renderPopup(); this.focusInitial();
    }
    close(restoreFocus = true) {
      const wasOpen = !!this.view; this.view = ''; this.openSeq++; this.loading = false; this.signature = '';
      this.popup.hidden = true; this.mode.setAttribute('aria-expanded', 'false'); this.model.setAttribute('aria-expanded', 'false');
      if (wasOpen && restoreFocus && this.anchor?.isConnected) this.anchor.focus({ preventScroll: true });
    }
    async choose(key, value) {
      if (this.pending || this.loading || this.loadFailed || this.state.locked || this.state.readOnly) return;
      if ((this.state.config?.[key] || '') === value) {
        if (key === 'modelRef') { this.view = 'effort'; this.renderPopup(); this.focusInitial(); }
        if (key === 'permissionMode') this.close();
        return;
      }
      const identity = this.state.identity; this.pending = true; this.error = ''; this.renderPopup();
      try {
        const ok = await this.onChange(key, value);
        if (identity !== this.state.identity) return;
        if (ok === false) this.error = '未能保存，已保留原设置。请稍后重试。';
        else if (key === 'modelRef' && this.view) { this.view = 'effort'; this.query = ''; }
        else if (key === 'permissionMode') this.close();
      } catch (error) { if (identity === this.state.identity) this.error = error.message || '未能保存，原设置不变。'; }
      finally { this.pending = false; this.render(); }
    }
    option(value, label, detail, selected, onClick, disabled = false) {
      const button = this.button('rp-option', '', onClick, `option-${value || 'default'}`);
      button.setAttribute('role', 'option'); button.setAttribute('aria-selected', String(selected));
      button.disabled = disabled || this.blocked; button.dataset.value = value;
      const copy = node('span', 'rp-option-copy'); copy.append(node('span', 'rp-option-name', label));
      if (detail) copy.append(node('small', 'rp-option-detail', detail));
      button.append(copy); const check = node('span', 'rp-check'); check.innerHTML = selected ? svg('check') : ''; button.append(check);
      return button;
    }
    renderPopup() {
      if (!this.view) return;
      const signature = JSON.stringify([this.view, this.state, this.loading, this.pending, this.error]);
      if (signature === this.signature) { this.position(); return; }
      this.signature = signature;
      const focus = this.popup.contains(document.activeElement) ? document.activeElement.dataset.key : '';
      this.popup.replaceChildren(); this.popup.dataset.view = this.view;
      this.popup.setAttribute('aria-busy', String(!!(this.pending || this.loading)));
      this.blocked = !!(this.state.locked || this.state.readOnly || this.pending || this.loading || this.loadFailed);
      this.mode.setAttribute('aria-expanded', String(this.view === 'mode'));
      this.model.setAttribute('aria-expanded', String(this.view !== 'mode'));
      const head = node('header', 'rp-heading');
      if (this.view === 'models') {
        const back = this.button('rp-icon', '', () => { this.view = 'effort'; this.renderPopup(); this.focusInitial(); }, 'back');
        back.innerHTML = svg('back'); back.setAttribute('aria-label', '返回思考强度'); head.append(back);
      }
      head.append(node('span', 'rp-heading-label', this.view === 'mode' ? '操作权限' : this.view === 'models' ? '选择模型' : '思考强度'));
      const close = this.button('rp-icon', '', () => this.close(), 'close'); close.innerHTML = svg('close'); close.setAttribute('aria-label', '关闭运行设置'); head.append(close);
      this.popup.append(head);
      if (this.loading) this.popup.append(node('p', 'rp-note', '正在读取当前会话配置…'));
      else if (this.view === 'effort') this.renderEffort();
      else if (this.view === 'models') this.renderModels();
      else this.renderModes();
      const note = node('p', 'rp-note'); note.setAttribute('role', 'status');
      note.textContent = this.pending ? '正在保存…' : this.error || (this.state.locked ? this.state.lockReason || '当前任务运行或同步中；结束后可修改。' : '仅此对话 · 选择后自动保存');
      note.dataset.error = String(!!this.error); this.popup.append(note);
      this.position();
      if (focus) [...this.popup.querySelectorAll('[data-key]')].find(el => el.dataset.key === focus)?.focus({ preventScroll: true });
    }
    renderEffort() {
      const { model, efforts, effort, fallback } = this.effective();
      const current = efforts.findIndex(row => row.effort === effort);
      const content = node('div', 'rp-effort');
      const topline = node('div', 'rp-effort-top');
      const bolt = node('span', 'rp-bolt'); bolt.innerHTML = svg('bolt');
      const label = node('strong', 'rp-effort-title', titleCase(effort));
      const reset = this.button('rp-icon rp-reset', '', () => this.choose('reasoningEffort', ''), 'reset-effort');
      reset.innerHTML = svg('reset'); reset.title = `恢复默认${fallback ? ` · ${titleCase(fallback)}` : ''}`; reset.setAttribute('aria-label', reset.title);
      reset.disabled = this.blocked || !this.state.config?.reasoningEffort;
      topline.append(bolt, label, reset); content.append(topline);
      const modelButton = this.button('rp-model-link', '', () => { this.view = 'models'; this.renderPopup(); this.focusInitial(); }, 'models');
      modelButton.append(node('span', '', model?.label || this.modelLabel.textContent)); modelButton.insertAdjacentHTML('beforeend', svg('down'));
      modelButton.title = '更换模型'; content.append(modelButton);
      const description = node('p', 'rp-effort-description', current >= 0 ? efforts[current].description || '按任务需要调节思考深度' : effort ? '当前档位不在模型目录中，请选择可用档位。' : '当前模型没有可调节的思考档位。');
      if (efforts.length) {
        const track = node('div', 'rp-effort-track'), ticks = node('div', 'rp-ticks');
        ticks.setAttribute('aria-hidden', 'true');
        efforts.forEach(() => ticks.append(node('i', ''))); track.append(ticks);
        const range = node('input', 'rp-range'); range.type = 'range'; range.min = '0'; range.max = String(Math.max(1, efforts.length - 1)); range.step = '1';
        range.dataset.key = 'effort'; range.disabled = this.blocked || efforts.length < 2; range.setAttribute('aria-label', '思考强度');
        range.value = String(Math.max(0, current));
        const preview = () => {
          const entry = efforts[Number(range.value)] || efforts[0];
          label.textContent = titleCase(entry.effort); range.setAttribute('aria-valuetext', entry.effort);
          track.style.setProperty('--rp-fill', `${efforts.length < 2 ? 0 : Number(range.value) / (efforts.length - 1) * 100}%`);
          description.textContent = entry.description || '按任务需要调节思考深度';
        };
        preview();
        if (current < 0) {
          label.textContent = titleCase(effort);
          description.textContent = '当前档位不在模型目录中，请选择可用档位。';
          range.setAttribute('aria-valuetext', `当前 ${effort || '默认'} 不在目录中；调节后选择可用档位`);
        }
        range.oninput = preview;
        range.onchange = () => { const entry = efforts[Number(range.value)]; if (entry) void this.choose('reasoningEffort', entry.effort); };
        track.append(range); content.append(track);
        const endpoints = node('div', 'rp-endpoints'); endpoints.append(node('span', '', titleCase(efforts[0].effort)), node('span', '', titleCase(efforts.at(-1).effort))); content.append(endpoints);
      }
      content.append(description); this.popup.append(content);
    }
    renderModels() {
      const list = node('div', 'rp-options'); list.setAttribute('role', 'listbox'); list.setAttribute('aria-label', '模型');
      const models = this.state.models || [], selected = this.state.config?.modelRef || '';
      // Catalogs arrive in connection/runtime order, so one maker can occur in
      // several non-adjacent blocks. Group before filtering, without changing
      // the source catalog, exact model refs, or the order within each maker.
      const groups = new Map();
      for (const row of models) {
        const group = row.group || '';
        if (!groups.has(group)) groups.set(group, []);
        groups.get(group).push(row);
      }
      const renderList = () => {
        list.replaceChildren();
        if (!this.query) {
          const defaultModel = models.find(row => row.value === this.state.defaults?.modelRef);
          list.append(this.option('', '跟随 Agent', defaultModel?.label || '使用当前 Agent 的默认模型', !selected, () => this.choose('modelRef', '')));
        }
        const query = (this.query || '').toLowerCase();
        for (const [group, rows] of groups) {
          const matches = rows.filter(row => `${row.label} ${row.detail || ''} ${group}`.toLowerCase().includes(query));
          if (!matches.length) continue;
          if (group) list.append(node('div', 'rp-group', group));
          for (const row of matches) {
            list.append(this.option(row.value, row.label, row.detail, row.value === selected, () => this.choose('modelRef', row.value), row.disabled));
          }
        }
        if (selected && !models.some(row => row.value === selected) && !this.query) list.append(this.option(selected, selected, '当前选择 · 目录暂不可用', true, () => {}, true));
        if (!list.children.length) list.append(node('p', 'rp-note', '没有匹配的模型'));
      };
      if (models.length > 8) {
        const search = node('input', 'rp-search'); search.type = 'search'; search.placeholder = '搜索模型或连接'; search.setAttribute('aria-label', search.placeholder); search.dataset.key = 'search'; search.value = this.query || '';
        search.oninput = () => { this.query = search.value.trim(); renderList(); this.position(); }; this.popup.append(search);
      }
      renderList(); this.popup.append(list);
    }
    renderModes() {
      const list = node('div', 'rp-options'); list.setAttribute('role', 'listbox'); list.setAttribute('aria-label', '操作权限');
      const selected = this.state.config?.permissionMode || '';
      list.append(this.option('', '跟随 Agent', modes[this.state.defaults?.permissionMode]?.[0] || '使用当前 Agent 的默认权限', !selected, () => this.choose('permissionMode', '')));
      for (const [value, [label, detail]] of Object.entries(modes)) {
        const option = this.option(value, label, detail, value === selected, () => this.choose('permissionMode', value));
        if (value === 'bypassPermissions') option.dataset.risk = 'high'; list.append(option);
      }
      this.popup.append(list);
    }
    position() {
      if (!this.view || !this.host.isConnected) return;
      const bound = this.boundary?.getBoundingClientRect() || { left: 0, right: innerWidth, top: 0, bottom: innerHeight };
      const a = this.anchor.getBoundingClientRect(), margin = 8;
      // A host may wrap its triggers onto two rows. Keep the popup clear of
      // that complete rail so changing from model to permissions remains clickable.
      const rail = this.anchorRegion?.getBoundingClientRect() || a;
      const left = Math.max(margin, bound.left + margin), right = Math.min(innerWidth - margin, bound.right - margin);
      const top = Math.max(margin, bound.top + margin), bottom = Math.min(innerHeight - margin, bound.bottom - margin);
      const width = Math.min(this.view === 'effort' ? 310 : 358, right - left);
      this.popup.style.width = `${Math.max(0, width)}px`;
      const above = rail.top - top - 8, below = bottom - rail.bottom - 8;
      const available = Math.max(above, below);
      const maxHeight = Math.max(0, this.anchorRegion && available >= 96 ? available : bottom - top);
      this.popup.style.maxHeight = `${maxHeight}px`;
      const height = this.popup.getBoundingClientRect().height;
      const y = above >= height ? rail.top - height - 8 : below >= height ? rail.bottom + 8 : Math.max(top, bottom - height);
      this.popup.style.left = `${Math.max(left, Math.min(right - width, a.right - width))}px`;
      this.popup.style.top = `${Math.max(top, Math.min(bottom - height, y))}px`;
    }
    focusInitial() {
      const target = this.popup.querySelector('[aria-selected="true"]:not(:disabled), .rp-range:not(:disabled), .rp-search, .rp-model-link, .rp-icon');
      (target || this.popup).focus({ preventScroll: true });
      target?.scrollIntoView?.({ block: 'nearest' });
    }
    keydown(event) {
      if (!this.view) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); this.close(); return; }
      if (!this.popup.contains(event.target)) return;
      const options = [...this.popup.querySelectorAll('.rp-option:not(:disabled)')];
      if (options.includes(event.target) && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault(); event.stopPropagation(); const index = options.indexOf(event.target);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
        options[next]?.focus(); return;
      }
      if (event.key === 'Tab') {
        const targets = [...this.popup.querySelectorAll('button:not(:disabled),input:not(:disabled)')];
        const edge = event.shiftKey ? targets[0] : targets.at(-1);
        if (event.target === edge) { event.preventDefault(); (event.shiftKey ? targets.at(-1) : targets[0])?.focus(); }
      }
    }
    destroy() { this.close(false); this.abort.abort(); this.popup.remove(); this.host.replaceChildren(); }
  }
  window.HarbourRunPicker = RunPicker;
})();
