/* Message delivery UX. No model selection, prompt injection or workflow logic here. */
(function () {
  let dispose, current;
  const labels = { collecting: '收集中', waiting: '等待处理', sending: '正在投递', accepted: '已送达当前运行', running: '处理中', paused: '已暂停', unknown: '待核对', completed: '已处理' };
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const icons = {
    queue: '<path d="M4 3v9a2 2 0 0 0 2 2h9m-3-3 3 3-3 3M8 4h9M8 8h6"/>',
    steer: '<path d="M4 4v5a3 3 0 0 0 3 3h9m-4-4 4 4-4 4"/>',
    edit: '<path d="m12 4 4 4M4 16l4-1L17 6a2 2 0 0 0-3-3L5 12l-1 4Z"/>',
    trash: '<path d="M3 5h14M8 5V3h4v2M5 5l1 12h8l1-12M8 8v6m4-6v6"/>',
    more: '<circle cx="4" cy="10" r=".8"/><circle cx="10" cy="10" r=".8"/><circle cx="16" cy="10" r=".8"/>',
    file: '<path d="M6 2h6l4 4v12H4V2h2Zm6 0v5h4M7 11h6m-6 3h4"/>',
  };
  const icon = name => `<svg viewBox="0 0 20 20" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || icons.file}</svg>`;
  // Save only explicit editing recoveries, never credentials or file bytes. A lost
  // withdrawal response can be checked with the same CAS request after refresh.
  const recoveryKey = 'harbour-input-edit-recovery-v1';
  const editing = new Set(); // survives component remounts, prevents two draft restorations
  const editKey = (sessionId, recordId) => `${sessionId}:${recordId}`;
  function readRecoveries() {
    try { const value = JSON.parse(localStorage.getItem(recoveryKey) || '[]'); return Array.isArray(value) ? value.filter(r => r && typeof r.sessionId === 'string' && r.record?.id && ['confirming', 'ready'].includes(r.phase)).slice(0, 20) : []; }
    catch { return []; }
  }
  function storeRecovery(entry, remove = false) {
    const records = readRecoveries().filter(r => r.sessionId !== entry.sessionId || r.record.id !== entry.record.id);
    if (!remove) records.push(entry);
    if (records.length > 20) throw new Error('尚有撤回草稿待处理，请先恢复已有草稿。');
    localStorage.setItem(recoveryKey, JSON.stringify(records));
  }
  function queuedDraft(record) {
    const messages = record.messages || [];
    return { text: `/${record.mode === 'queue' ? 'queue' : 'steer'} ${messages.map(m => m.input || '').join('\n\n')}`.trimEnd(),
      attachments: messages.flatMap(m => m.attachments || []) };
  }
  function recordStatus(record) {
    if (record.delivery === 'unknown') return { group: '待核对', label: '答复送达待核对', tone: 'attention' };
    if (record.state === 'unknown') return { group: '待核对', label: '执行结果待核对', tone: 'attention' };
    if (record.state === 'paused') return { group: '已暂停', label: '已暂停', tone: 'attention' };
    if (record.state === 'completed') return record.delivery === 'sending'
      ? { group: '发送中', label: '任务已完成 · 答复发送中', tone: 'active' }
      : { group: '待发送', label: '任务已完成 · 答复待发送', tone: 'waiting' };
    if (['collecting', 'waiting'].includes(record.state)) return { group: '等待', label: labels[record.state], tone: 'waiting' };
    return { group: '处理中', label: labels[record.state] || '状态待核对', tone: 'active' };
  }
  function mount({ api, session, localRunning, changed, reload, toast, mediaUrl = url => url, canEdit = () => true, restoreDraft }) {
    dispose?.(); const control = document.getElementById('chatInputMode'), status = document.getElementById('chatInputStatus');
    if (!control || !status) return;
    let stopped = false, timer, loading = false, modeSaving = false, stamp = '', binding = '', mode = 'steer', snapshot = {}, positionFrame = 0;
    status.innerHTML = `<button type="button" class="intake-status-trigger" aria-expanded="false" aria-controls="chatIntakePopover" aria-haspopup="dialog" title="查看消息处理和答复送达状态；不会重新执行任务"><span class="intake-status-title"><span class="intake-dot" aria-hidden="true"></span><b>消息状态</b><span data-intake-count></span></span><span class="intake-status-counts"></span><span class="intake-status-toggle"><span>查看</span><svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="m4 6 4 4 4-4"/></svg></span></button>`;
    const trigger = status.querySelector('button');
    const rows = document.createElement('div'); rows.className = 'intake-queue'; rows.setAttribute('aria-label', '待处理消息');
    const recovery = document.createElement('div'); recovery.className = 'intake-recovery'; recovery.hidden = true;
    status.append(rows, recovery);
    const operations = new Map();
    // A body-level, non-modal surface: opening details must not resize the composer
    // or be clipped by its container-query / overflow ancestors.
    const popover = document.createElement('section');
    popover.id = 'chatIntakePopover'; popover.className = 'intake-popover'; popover.hidden = true;
    popover.setAttribute('role', 'dialog'); popover.setAttribute('aria-modal', 'false');
    popover.setAttribute('aria-labelledby', 'chatIntakeHeading');
    popover.innerHTML = `<header class="intake-popover-head"><div><h3 id="chatIntakeHeading">消息状态</h3><p>查看不会重发消息，也不会重新执行任务。</p></div><button type="button" data-intake-close aria-label="关闭消息状态" title="关闭（Esc）">×</button></header><div class="intake-items"></div><footer class="intake-popover-footer"></footer>`;
    document.body.append(popover);
    const items = popover.querySelector('.intake-items'), footer = popover.querySelector('footer');
    const positionPopover = () => {
      if (popover.hidden) return;
      const viewport = window.visualViewport, left = viewport?.offsetLeft || 0, top = viewport?.offsetTop || 0;
      const width = viewport?.width || innerWidth, height = viewport?.height || innerHeight;
      const anchor = trigger.getBoundingClientRect();
      const composerTop = (status.closest('.chat-compose') || status).getBoundingClientRect().top;
      const bottom = Math.min(top + height - 12, composerTop - 16);
      const above = bottom - top - 12;
      const below = top + height - anchor.bottom - 24;
      const useAbove = above >= 180 || above >= below;
      popover.style.width = `${Math.min(440, width - 24)}px`;
      popover.style.maxHeight = `${Math.max(80, useAbove ? above : below)}px`;
      const bounds = popover.getBoundingClientRect();
      popover.style.left = `${Math.max(left + 12, Math.min(anchor.right - bounds.width, left + width - bounds.width - 12))}px`;
      popover.style.top = `${Math.max(top + 12, useAbove ? bottom - bounds.height : anchor.bottom + 12)}px`;
    };
    const schedulePosition = () => {
      if (!stopped && !popover.hidden && !positionFrame) positionFrame = requestAnimationFrame(() => { positionFrame = 0; positionPopover(); });
    };
    const observer = window.ResizeObserver ? new ResizeObserver(schedulePosition) : null;
    const setPopover = (open, restoreFocus = false) => {
      open = !stopped && !!open && !status.hidden && !trigger.hidden && binding === session();
      popover.hidden = !open; trigger.setAttribute('aria-expanded', String(open));
      trigger.querySelector('.intake-status-toggle span').textContent = open ? '收起' : '查看';
      observer?.disconnect();
      if (open) {
        setMenu(false);
        observer?.observe(status.closest('.chat-compose') || status);
        observer?.observe(popover);
        positionPopover(); popover.querySelector('[data-intake-close]').focus({ preventScroll: true });
      } else {
        if (positionFrame) cancelAnimationFrame(positionFrame); positionFrame = 0;
        if (restoreFocus && !status.hidden && trigger.isConnected) trigger.focus({ preventScroll: true });
      }
    };
    trigger.addEventListener('click', () => setPopover(popover.hidden));
    popover.querySelector('[data-intake-close]').addEventListener('click', () => setPopover(false, true));
    const dismissPopover = event => {
      if (popover.hidden) return;
      if (event.type === 'keydown') {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setPopover(false, true); }
      } else if (!popover.contains(event.target) && !trigger.contains(event.target)) setPopover(false);
    };
    document.addEventListener('pointerdown', dismissPopover);
    document.addEventListener('keydown', dismissPopover);
    window.addEventListener('resize', schedulePosition);
    document.addEventListener('scroll', schedulePosition, true);
    window.visualViewport?.addEventListener('resize', schedulePosition);
    window.visualViewport?.addEventListener('scroll', schedulePosition);
    control.innerHTML = `<details class="input-mode-menu"><summary aria-label="消息处理方式" aria-expanded="false" aria-controls="chatInputModePopover">${icon('steer')}<span>引导</span><i aria-hidden="true">⌄</i></summary><div id="chatInputModePopover" class="input-mode-options" role="group" aria-label="消息处理方式" hidden><button type="button" data-input-mode="steer">${icon('steer')}<span><b>引导当前任务</b><small>补充当前运行；暂不能接收时等待</small></span><span class="input-mode-check" aria-hidden="true">✓</span></button><button type="button" data-input-mode="queue">${icon('queue')}<span><b>排队发送</b><small>等当前任务结束，再开始下一轮</small></span><span class="input-mode-check" aria-hidden="true">✓</span></button><p>点击发送遵循此选项；Enter 排队，Ctrl / ⌘ + Enter 补充，Shift + Enter 换行。</p><p>仅这条：输入 /steer 正文 或 /queue 正文，不改变默认。</p><p>与工具权限 MODE 无关 · /goal 开始目标</p></div></details>`;
    const modeDetails = control.querySelector('details'), modeTrigger = control.querySelector('summary'), menu = control.querySelector('.input-mode-options');
    // Fixed descendants still inherit transformed/contained ancestors as their
    // containing block. Keep both composer popups outside that clipping tree.
    document.body.append(menu);
    const modeButtons = [...menu.querySelectorAll('[data-input-mode]')];
    let menuPositionFrame = 0;
    const modeLabel = () => { modeTrigger.querySelector('span').textContent = mode === 'queue' ? '排队' : '引导';
      const label = `发送方式：${mode === 'queue' ? '排队发送' : '引导当前任务'}`;
      modeTrigger.setAttribute('aria-label', label); modeTrigger.title = label;
      modeTrigger.querySelector('svg').innerHTML = icons[mode === 'queue' ? 'queue' : 'steer'];
      modeButtons.forEach(b => b.setAttribute('aria-pressed', String(b.dataset.inputMode === mode))); };
    const positionMenu = () => {
      if (stopped || menu.hidden) return;
      const viewport = window.visualViewport, left = viewport?.offsetLeft || 0, top = viewport?.offsetTop || 0;
      const width = viewport?.width || innerWidth, height = viewport?.height || innerHeight, margin = 12, gap = 8;
      const anchor = modeTrigger.getBoundingClientRect();
      if (control.hidden || !control.isConnected || anchor.bottom <= top || anchor.top >= top + height) { setMenu(false); return; }
      const viewportSpace = Math.max(0, height - margin * 2);
      menu.style.width = `${Math.max(0, Math.min(320, width - margin * 2))}px`;
      const above = Math.max(0, anchor.top - gap - top - margin), below = Math.max(0, top + height - margin - anchor.bottom - gap);
      // Measure the unscrolled content without temporarily expanding max-height:
      // that would reset scrollTop every time a scroll event re-anchors the menu.
      const contentHeight = menu.scrollHeight + menu.getBoundingClientRect().height - menu.clientHeight;
      const useAbove = above >= contentHeight || above >= below;
      const available = useAbove ? above : below;
      // Very short viewports may need to overlap the trigger; content remains
      // scrollable rather than being cut off beyond the visible viewport.
      menu.style.maxHeight = `${Math.min(viewportSpace, available >= 120 ? available : viewportSpace)}px`;
      const bounds = menu.getBoundingClientRect();
      menu.style.left = `${Math.max(left + margin, Math.min(anchor.right - bounds.width, left + width - bounds.width - margin))}px`;
      menu.style.top = `${Math.max(top + margin, Math.min(useAbove ? anchor.top - gap - bounds.height : anchor.bottom + gap, top + height - bounds.height - margin))}px`;
    };
    const scheduleMenuPosition = () => {
      if (!stopped && !menu.hidden && !menuPositionFrame) menuPositionFrame = requestAnimationFrame(() => { menuPositionFrame = 0; positionMenu(); });
    };
    const menuObserver = window.ResizeObserver ? new ResizeObserver(scheduleMenuPosition) : null;
    function setMenu(open, restoreFocus = false) {
      open = !stopped && !!open && !control.hidden && control.isConnected;
      modeDetails.open = open; menu.hidden = !open; modeTrigger.setAttribute('aria-expanded', String(open));
      menuObserver?.disconnect();
      if (open) {
        setPopover(false); positionMenu();
        menuObserver?.observe(control.closest('.chat-compose') || control); menuObserver?.observe(menu);
      } else {
        if (menuPositionFrame) cancelAnimationFrame(menuPositionFrame); menuPositionFrame = 0;
        if (restoreFocus && !control.hidden && modeTrigger.isConnected) modeTrigger.focus({ preventScroll: true });
      }
    }
    const toggleMenu = () => { if (!stopped && modeDetails.open === menu.hidden) setMenu(modeDetails.open); };
    modeDetails.addEventListener('toggle', toggleMenu);
    const closeMenu = event => {
      if (menu.hidden) return;
      const inside = menu.contains(event.target), atTrigger = modeTrigger.contains(event.target);
      if (event.type === 'keydown') {
        if (event.key === 'Escape') { event.preventDefault(); setMenu(false, true); }
        else if (inside || atTrigger) {
          const index = modeButtons.indexOf(document.activeElement);
          if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
            event.preventDefault();
            const next = event.key === 'Home' ? 0 : event.key === 'End' ? modeButtons.length - 1
              : index < 0 ? (event.key === 'ArrowDown' ? 0 : modeButtons.length - 1)
              : (index + (event.key === 'ArrowDown' ? 1 : modeButtons.length - 1)) % modeButtons.length;
            modeButtons[next].focus({ preventScroll: true }); modeButtons[next].scrollIntoView({ block: 'nearest' });
          } else if (event.key === 'Tab') {
            if (atTrigger && !event.shiftKey) { event.preventDefault(); modeButtons[0].focus({ preventScroll: true }); }
            else if (index === 0 && event.shiftKey) { event.preventDefault(); setMenu(false, true); }
            else if (atTrigger || (index === modeButtons.length - 1 && !event.shiftKey)) setMenu(false, true);
          }
        }
      } else if (!inside && !atTrigger) setMenu(false);
    };
    window.addEventListener('resize', scheduleMenuPosition);
    document.addEventListener('scroll', scheduleMenuPosition, true);
    window.visualViewport?.addEventListener('resize', scheduleMenuPosition);
    window.visualViewport?.addEventListener('scroll', scheduleMenuPosition);
    document.addEventListener('pointerdown', closeMenu);
    document.addEventListener('focusin', closeMenu);
    document.addEventListener('keydown', closeMenu);
    modeButtons.forEach(button => button.addEventListener('click', async () => {
      if (stopped || modeSaving) return;
      const id = session(); if (!id) return toast('请先进入会话', true);
      if (binding !== id) { setMenu(false); return; }
      modeSaving = true; current = { ...current, modeSaving: true }; modeButtons.forEach(b => { b.disabled = true; });
      try { await api(`/api/conversations/${encodeURIComponent(id)}/inputs`, { method: 'PATCH', body: JSON.stringify({ mode: button.dataset.inputMode }) });
        if (stopped || id !== session()) return; mode = button.dataset.inputMode; current = { ...current, mode }; modeLabel(); setMenu(false, true);
      } catch (error) { toast(error.message, true); }
      finally { modeSaving = false; if (!stopped) { current = { ...current, modeSaving: false }; modeButtons.forEach(b => { b.disabled = false; }); } }
    }));
    function clearStatus() {
      setPopover(false); status.hidden = true; rows.replaceChildren(); items.replaceChildren(); footer.replaceChildren(); recovery.replaceChildren(); recovery.hidden = true;
    }
    function showRecoveries() {
      const saved = readRecoveries().filter(r => r.sessionId === binding);
      const html = saved.map(entry => `<div><span>${entry.phase === 'ready' ? '有一条已撤回的消息待编辑' : '撤回结果待核对，原文已保留'}</span><button type="button" data-recover-id="${escape(entry.record.id)}" ${editing.has(editKey(entry.sessionId, entry.record.id)) ? 'disabled' : ''}>${entry.phase === 'ready' ? '继续编辑' : '核对撤回'}</button></div>`).join('');
      if (recovery.innerHTML !== html) recovery.innerHTML = html;
      recovery.hidden = !saved.length;
      if (saved.length) status.hidden = false;
    }
    function renderRows(pending, result) {
      const existing = new Map([...rows.children].map(el => [el.dataset.id, el]));
      for (const record of pending) {
        const display = recordStatus(record), editable = !result.readOnly && record.canWithdraw === true;
        const text = record.messages.map(m => m.input || '[附件]').join(' · ');
        const attachments = record.messages.flatMap(m => m.attachments || []), firstImage = attachments.find(a => a.kind === 'image' && /^\/uploads\//.test(a.url || ''));
        const preview = firstImage ? `<img class="intake-thumb" src="${escape(mediaUrl(firstImage.url))}" alt="${escape(firstImage.name || '图片附件')}" loading="lazy" decoding="async" draggable="false">`
          : attachments.length ? `<span class="intake-file" title="${escape(attachments.map(a => a.name || a.kind).join('、'))}">${icon('file')}</span>` : '';
        const busy = operations.has(record.id) || editing.has(editKey(binding, record.id)), disabled = busy ? 'disabled' : '';
        const rowLabel = busy ? '处理中' : record.state === 'waiting' || record.state === 'collecting'
          ? record.hold ? '收集中' : record.mode === 'queue' ? '排队' : editable ? '待引导' : '等候接收'
          : record.state === 'accepted' ? '已接收' : display.label;
        const button = (action, label, glyph, extra = '') => `<button type="button" class="intake-row-action ${extra}" data-queue-action="${action}" data-id="${escape(record.id)}" aria-label="${label}" title="${label}" ${disabled}>${icon(glyph)}${action === 'steer' ? '<span>引导</span>' : ''}</button>`;
        const html = `<span class="intake-kind" data-mode="${record.mode === 'queue' ? 'queue' : 'steer'}" title="${record.mode === 'queue' ? '排队：下一轮处理' : '引导：补充当前任务'}">${icon(record.mode === 'queue' ? 'queue' : 'steer')}</span>${preview}<button type="button" class="intake-row-text" data-queue-action="detail" data-id="${escape(record.id)}" title="${escape(text)}">${escape(text)}</button><span class="intake-row-state" data-tone="${display.tone}" title="${escape(display.label)}">${escape(rowLabel)}</span><span class="intake-row-tools">${!result.readOnly && record.canSteer ? button('steer', '改为引导当前任务', 'steer', 'intake-steer') : ''}${editable && restoreDraft ? button('edit', '撤回到输入框编辑', 'edit') : ''}${editable ? button('delete', '从待处理队列删除', 'trash') : ''}${button('detail', '查看完整消息与状态', 'more')}</span>`;
        let row = existing.get(record.id);
        if (!row) { row = document.createElement('div'); row.className = 'intake-row'; row.dataset.id = record.id; rows.append(row); }
        existing.delete(record.id);
        if (row._html !== html) {
          const focus = row.contains(document.activeElement) ? document.activeElement.dataset.queueAction : null;
          row.innerHTML = html; row._html = html;
          if (focus) (row.querySelector(`[data-queue-action="${focus}"]`) || row.querySelector('.intake-row-text')).focus({ preventScroll: true });
        }
      }
      for (const row of existing.values()) row.remove();
    }
    async function editQueued(entry) {
      const id = entry.sessionId, record = entry.record;
      const key = editKey(id, record.id);
      if (editing.has(key) || operations.has(record.id)) return;
      editing.add(key); operations.set(record.id, true); showRecoveries(); renderRows(snapshot.records || [], snapshot);
      try {
        if (entry.phase !== 'ready') {
          const result = await api(`/api/conversations/${encodeURIComponent(id)}/inputs`, { method: 'PATCH', body: JSON.stringify({ action: 'withdraw', id: record.id, revision: record.revision }) });
          entry = { ...entry, record: { ...record, ...result }, phase: 'ready' }; storeRecovery(entry);
        }
        // Always deliver to the captured session, including after a view switch/unmount.
        if (restoreDraft?.(queuedDraft(entry.record), id)) {
          storeRecovery(entry, true); toast(id === session() ? '已撤回到输入框，修改后可重新发送' : '已撤回，草稿保存在原会话');
        } else toast('消息已撤回；现有草稿未覆盖，可稍后点“继续编辑”。');
      } catch (error) {
        if ([400, 403, 404, 409].includes(error.status)) storeRecovery(entry, true);
        toast(error.message || '未能确认撤回；原文已保留，请核对后继续。', true);
      } finally {
        editing.delete(key); operations.delete(record.id);
        if (!stopped && id === session()) { snapshot.revision = ''; stamp = ''; await sync(); showRecoveries(); }
      }
    }
    recovery.addEventListener('click', event => {
      const button = event.target.closest('[data-recover-id]');
      if (stopped || !button || binding !== session()) return;
      const entry = readRecoveries().find(r => r.sessionId === binding && r.record.id === button.dataset.recoverId);
      if (entry) void editQueued(entry);
    });
    rows.addEventListener('click', async event => {
      const button = event.target.closest('[data-queue-action]');
      if (stopped || !button || button.disabled || binding !== session()) return;
      const id = binding, record = snapshot.records?.find(r => r.id === button.dataset.id), action = button.dataset.queueAction;
      if (!record) return;
      if (action === 'detail') {
        setPopover(true); [...items.children].find(el => el.dataset.id === record.id)?.scrollIntoView({ block: 'nearest' }); return;
      }
      if (operations.has(record.id)) return;
      if (action === 'edit') {
        if (!canEdit(id)) return;
        const entry = { sessionId: id, record: { id: record.id, revision: record.revision, mode: record.mode, messages: record.messages }, phase: 'confirming' };
        try { storeRecovery(entry); } catch { return toast('无法保存撤回草稿，请检查本地存储；排队消息未改变。', true); }
        return editQueued(entry);
      }
      operations.set(record.id, true); renderRows(snapshot.records, snapshot);
      try {
        await api(`/api/conversations/${encodeURIComponent(id)}/inputs`, { method: 'PATCH', body: JSON.stringify({ action: action === 'delete' ? 'withdraw' : 'steer', id: record.id, revision: record.revision }) });
        toast(action === 'delete' ? '已从待处理队列移除' : '已改为引导；当前任务可接收时送达');
      } catch (error) { toast(error.message, true); }
      finally { operations.delete(record.id); if (!stopped && id === session()) { snapshot.revision = ''; stamp = ''; await sync(); } }
    });
    function renderStatus(pending, result) {
      if (!pending.length) { clearStatus(); trigger.hidden = true; showRecoveries(); return; }
      trigger.hidden = false;
      status.hidden = false;
      renderRows(pending, result); showRecoveries();
      const messages = pending.flatMap(r => r.messages), groups = new Map();
      for (const record of pending) {
        const { group } = recordStatus(record); groups.set(group, (groups.get(group) || 0) + record.messages.length);
      }
      trigger.querySelector('[data-intake-count]').textContent = `· ${messages.length} 条`;
      trigger.querySelector('.intake-status-counts').innerHTML = [...groups].map(([label, count]) => `<span>${escape(label)} ${count}</span>`).join('');
      const attention = pending.some(r => recordStatus(r).tone === 'attention');
      trigger.dataset.tone = attention ? 'attention' : 'active';
      const existing = new Map([...items.children].map(el => [el.dataset.id, el]));
      for (const record of pending) {
        const display = recordStatus(record), images = record.messages.reduce((n, m) => n + (m.attachments || []).filter(a => a.kind === 'image').length, 0);
        const html = `<header><b data-tone="${display.tone}">${escape(display.label)}</b><small>${record.messages.length} 条${images ? ` · ${images} 张图片` : ''} · ${record.mode === 'queue' ? '排队' : '补充'}${record.isolated ? '（仅本条）' : ''}</small></header><p>${escape(record.messages.map(m => m.input || '[附件]').join(' / '))}</p>${record.error ? `<small class="intake-error">${escape(record.error)}</small>` : ''}${record.output ? `<details data-intake-section="reply"><summary>查看已保存的答复</summary><pre>${escape(record.output)}</pre></details>` : ''}${['unknown','paused','completed'].includes(record.state) ? `<details data-intake-section="actions"><summary>核对与处理</summary><p>请先核对原会话。归档只收起此回执，保留原文；不会重新执行，也不代表任务成功。</p><button class="btn ghost" type="button" data-input-action="acknowledge" data-id="${escape(record.id)}">已核对，归档此回执</button>${record.output && record.state === 'completed' ? `<p>只补发保存的答复，不重做任务；平台未确认的片段可能重复发送。</p><button class="btn ghost" type="button" data-input-action="resend" data-id="${escape(record.id)}">确认可能重复，补发答复</button>` : ''}</details>` : ''}`;
        let article = existing.get(record.id);
        if (!article) { article = document.createElement('article'); article.dataset.id = record.id; items.append(article); }
        existing.delete(record.id);
        if (article._intakeHtml !== html) {
          const openSections = [...article.querySelectorAll('details[open]')].map(el => el.dataset.intakeSection);
          const active = article.contains(document.activeElement) ? document.activeElement : null;
          const focusAction = active?.dataset.inputAction, focusSection = active?.closest('details')?.dataset.intakeSection;
          article.innerHTML = html; article._intakeHtml = html;
          article.querySelectorAll('details').forEach(el => { el.open = openSections.includes(el.dataset.intakeSection); });
          if (active) ([...article.querySelectorAll('[data-input-action]')].find(el => el.dataset.inputAction === focusAction)
            || [...article.querySelectorAll('details')].find(el => el.dataset.intakeSection === focusSection)?.querySelector('summary')
            || popover.querySelector('[data-intake-close]')).focus({ preventScroll: true });
        }
      }
      for (const article of existing.values()) {
        if (article.contains(document.activeElement)) popover.querySelector('[data-intake-close]').focus({ preventScroll: true });
        article.remove();
      }
      const footerHtml = result.readOnly ? '<span>此处为渠道会话镜像。在原渠道发送 /pending resume，可恢复尚未执行的待办。</span>'
        : pending.some(r => r.state === 'paused') ? '<button type="button" class="btn ghost" data-input-resume>恢复尚未执行的待办</button>' : '<span>仅展示处理与送达状态，不代表新建了这些数量的任务。</span>';
      if (footer.innerHTML !== footerHtml) footer.innerHTML = footerHtml;
      schedulePosition();
    }
    popover.addEventListener('click', async event => {
      const button = event.target.closest('[data-input-action], [data-input-resume]');
      if (stopped || !button || button.disabled || binding !== session()) return;
      const id = binding; button.disabled = true;
      const payload = button.hasAttribute('data-input-resume') ? { action: 'resume' }
        : { action: button.dataset.inputAction, id: button.dataset.id, confirmUnknown: true };
      try { await api(`/api/conversations/${encodeURIComponent(id)}/inputs`, { method: 'PATCH', body: JSON.stringify(payload) }); if (!stopped && id === session()) await sync(); }
      catch (error) { if (!stopped && id === session()) toast(error.message, true); }
      finally { button.disabled = false; }
    });
    async function sync() {
      if (stopped || loading || !control.isConnected) return;
      const id = session();
      if (!id) { current = { busy: false, mode }; clearStatus(); setMenu(false); binding = ''; stamp = ''; snapshot = {}; changed(false);
        timer = setTimeout(sync, 1800); return; }
      if (binding !== id) { clearStatus(); setMenu(false); binding = id; stamp = ''; snapshot = {}; }
      loading = true;
      try {
        const result = await api(`/api/conversations/${encodeURIComponent(id)}/inputs${binding === id && snapshot.revision ? `?revision=${encodeURIComponent(snapshot.revision)}` : ''}`);
        if (stopped || id !== session()) return;
        if (result.recoveryError) {
          const errorStamp = `error:${result.recoveryError}`;
          if (stamp !== errorStamp) {
            clearStatus(); status.hidden = false; trigger.hidden = false; stamp = errorStamp;
            trigger.querySelector('[data-intake-count]').textContent = '· 读取异常';
            trigger.querySelector('.intake-status-counts').textContent = '待核对'; trigger.dataset.tone = 'attention';
            const error = document.createElement('p'); error.className = 'intake-error'; error.textContent = result.recoveryError; items.append(error);
          }
          changed(false); return;
        }
        if (result.unchanged) result.records = snapshot.records;
        mode = result.mode; snapshot = result; modeLabel(); control.hidden = result.readOnly === true;
        if (control.hidden) setMenu(false);
        const records = result.records || [];
        const pending = records.filter(r => !r.archived && (r.state !== 'completed' || r.delivery !== 'delivered'));
        const busy = result.busy || pending.some(r => ['running', 'accepted', 'sending', 'waiting', 'collecting'].includes(r.state));
        current = { busy, mode, modeSaving, records, sessionId: id };
        const nextStamp = `${result.readOnly}|` + records.map(r => `${r.id}:${r.revision}:${r.updatedAt}:${r.state}:${r.archived}:${r.delivery}:${r.canWithdraw}:${r.canSteer}`).join('|');
        if (stamp !== nextStamp) {
          stamp = nextStamp; status.hidden = pending.length === 0;
          renderStatus(pending, result);
          if (!localRunning()) await reload(id);
        }
        showRecoveries();
        if (!stopped && id === session()) changed(busy);
      } catch { /* Old/offline backend must not erase drafts or claim delivery. */ }
      finally { loading = false; if (!stopped && control.isConnected) { clearTimeout(timer); timer = setTimeout(sync, snapshot.busy ? 750 : 1800); } }
    }
    current = { mode, busy: false }; void sync();
    dispose = () => { if (stopped) return; stopped = true; clearTimeout(timer); setPopover(false); popover.remove(); setMenu(false); menu.remove();
      modeDetails.removeEventListener('toggle', toggleMenu);
      window.removeEventListener('resize', scheduleMenuPosition); document.removeEventListener('scroll', scheduleMenuPosition, true);
      window.visualViewport?.removeEventListener('resize', scheduleMenuPosition); window.visualViewport?.removeEventListener('scroll', scheduleMenuPosition);
      document.removeEventListener('pointerdown', dismissPopover); document.removeEventListener('keydown', dismissPopover);
      window.removeEventListener('resize', schedulePosition); document.removeEventListener('scroll', schedulePosition, true);
      window.visualViewport?.removeEventListener('resize', schedulePosition); window.visualViewport?.removeEventListener('scroll', schedulePosition);
      document.removeEventListener('pointerdown', closeMenu); document.removeEventListener('focusin', closeMenu); document.removeEventListener('keydown', closeMenu); current = undefined; };
    return dispose;
  }
  window.HarbourChatIntake = { mount, get: () => current,
    queuedDraft,
    // First-message display helper only. Authority and all active-run routing stay server-side.
    oneShotText(text, hasAttachments = false) {
      const match = /^\/(steer|queue)(?:\s+([\s\S]*))?$/i.exec(text.trim());
      return match && ((match[2] || '').trim() || hasAttachments) ? (match[2] || '').trim() : null;
    },
    goalCommand(text) {
      const match = /^\/goal(?:\s+([\s\S]*))?$/i.exec(text.trim());
      if (!match) return null;
      const arg = (match[1] || '').trim();
      return { action: /^(pause|resume|complete|cancel)$/i.test(arg) ? arg.toLowerCase() : arg ? 'start' : 'show', objective: arg };
    },
    async settings(pane, api, toast) {
      pane.innerHTML = `<header class="settings-section-head"><div><h3>消息与连发合并</h3><p>QQ／Discord 自动收齐连发图文；Web 手动发送不增加等待。设置只控制收件和调度，不调用模型。</p></div></header><div class="settings-card intake-settings">正在读取…</div>`;
      try {
        const data = await api('/api/message-intake/settings'); if (!pane.isConnected) return;
        const host = pane.querySelector('.intake-settings');
        host.innerHTML = `<form><label>默认处理方式<select name="defaultMode"><option value="steer">补充当前任务（不可用时排队）</option><option value="queue">排队处理</option></select></label>${[['textDelayMs','文字停顿等待（秒）',0,30],['mediaDelayMs','含附件停顿等待（秒）',0,60],['maxWaitMs','普通批次最长等待（秒）',1,120]].map(([key,label,min,max]) => `<label>${label}<input type="number" name="${key}" min="${min}" max="${max}" step="0.5" value="${data[key]/1000}" required></label>`).join('')}<p>发图较慢时使用 /收集、/发完。停止会暂停待办；发送回执未知时不自动重复执行。每批最多 ${data.maxMessages} 条／10 个附件，超出会保留顺序分批处理。</p><button class="btn primary" type="submit">保存消息设置</button><span role="status"></span></form>`;
        host.querySelector('select').value = data.defaultMode;
        host.querySelector('form').addEventListener('submit', async event => {
          event.preventDefault(); const values = new FormData(event.target), button = host.querySelector('button'); button.disabled = true;
          try { await api('/api/message-intake/settings', { method: 'PATCH', body: JSON.stringify({ defaultMode: values.get('defaultMode'), textDelayMs: Number(values.get('textDelayMs')) * 1000, mediaDelayMs: Number(values.get('mediaDelayMs')) * 1000, maxWaitMs: Number(values.get('maxWaitMs')) * 1000 }) }); host.querySelector('[role=status]').textContent = '已保存，即时生效'; }
          catch (error) { toast(error.message, true); } finally { button.disabled = false; }
        });
      } catch (error) { pane.querySelector('.intake-settings').textContent = `暂不可用：${error.message}`; }
    },
  };
})();
