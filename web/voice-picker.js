/* One lazy voice picker for Dashboard, orb and call. No browser persistence or polling. */
(() => {
  const speaker = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M11 4 5 9H2v6h3l6 5ZM15 8a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14"/></svg>';
  function node(tag, cls, text) {
    const el = document.createElement(tag); el.className = cls;
    if (text != null) el.textContent = text;
    return el;
  }
  class HarbourVoicePicker {
    constructor({ host, getCompanionId, request, boundary, onOpen, onManage }) {
      Object.assign(this, { host, getCompanionId, request, boundary, onOpen, onManage });
      this.revision = 0;
      this.button = node('button', 'voice-picker-trigger');
      this.button.type = 'button'; this.button.innerHTML = speaker;
      this.button.setAttribute('aria-label', '选择音色'); this.button.title = '选择音色';
      this.button.setAttribute('aria-haspopup', 'dialog'); this.button.setAttribute('aria-expanded', 'false');
      host.replaceChildren(this.button);
      this.button.onclick = () => this.popup ? this.close() : void this.open();
      this.outside = event => { if (!this.popup?.contains(event.target) && !this.host.contains(event.target)) this.close(); };
      this.key = event => { if (event.key === 'Escape' && this.popup) { event.preventDefault(); event.stopPropagation(); this.close(); this.button.focus(); } };
      this.reposition = () => this.position();
      this.visibility = () => { if (document.hidden) this.close(); };
      document.addEventListener('pointerdown', this.outside);
      document.addEventListener('keydown', this.key, true);
      document.addEventListener('visibilitychange', this.visibility);
      window.addEventListener('resize', this.reposition);
      this.sync();
    }
    sync() {
      const id = this.getCompanionId();
      if (id !== this.companionId) { this.close(); this.companionId = id; this.button.title = '选择音色'; }
      this.host.hidden = !id;
    }
    async open() {
      this.sync(); if (!this.companionId) return;
      this.onOpen?.();
      const revision = ++this.revision;
      this.popup = node('section', 'voice-picker-popup');
      this.popup.setAttribute('role', 'dialog'); this.popup.setAttribute('aria-label', '选择发声音色');
      this.popup.append(node('p', 'voice-picker-status', '正在读取音色…'));
      document.body.append(this.popup); this.button.setAttribute('aria-expanded', 'true'); this.position();
      try {
        const catalogue = await this.request('list', {});
        if (revision !== this.revision) return;
        this.catalogue = catalogue; this.render();
        this.popup.querySelector('[aria-pressed="true"]')?.focus({ preventScroll: true });
      } catch (error) { if (revision === this.revision) this.popup.firstChild.textContent = `读取失败：${error.message}`; }
    }
    render() {
      const popup = this.popup; if (!popup) return;
      popup.replaceChildren();
      const header = node('header', 'voice-picker-head');
      header.append(node('strong', '', `${this.companionId === 'aemeath' ? 'Aemeath' : this.companionId === 'elaina' ? 'Elaina' : this.companionId} 的音色`));
      const done = node('button', 'voice-picker-close', '×'); done.type = 'button'; done.setAttribute('aria-label', '关闭音色选择');
      done.onclick = () => { this.close(); this.button.focus(); }; header.append(done); popup.append(header);
      popup.append(node('p', 'voice-picker-note', '同角色在各界面共用 · 后续语音生效'));
      const list = node('div', 'voice-picker-list');
      const selected = this.catalogue.selections?.[this.companionId] || 'auto';
      let group;
      for (const voice of this.catalogue.voices || []) {
        if (group !== voice.group) { group = voice.group; list.append(node('h4', 'voice-picker-group', group)); }
        const row = node('div', 'voice-picker-row');
        const choose = node('button', 'voice-picker-choice'); choose.type = 'button'; choose.disabled = !voice.available;
        choose.setAttribute('aria-pressed', String(selected === voice.id)); choose.dataset.voiceId = voice.id;
        choose.append(node('span', 'voice-picker-check', selected === voice.id ? '✓' : ''), node('span', 'voice-picker-label', voice.label));
        choose.append(node('small', '', voice.available ? voice.description : '未配置 · 到音色库连接服务'));
        choose.onclick = () => void this.select(voice.id); row.append(choose);
        if (voice.available && voice.id !== 'auto') {
          const preview = node('button', 'voice-picker-preview', '▷'); preview.type = 'button';
          preview.title = `试听 ${voice.label}（按所选音色计费）`; preview.setAttribute('aria-label', `试听 ${voice.label}`);
          preview.onclick = () => void this.preview(voice.id); row.append(preview);
        }
        list.append(row);
        if (selected === voice.id) this.button.title = `音色：${voice.label}`;
      }
      popup.append(list);
      this.status = node('p', 'voice-picker-status', this.catalogue.enabled === false ? 'TTS 总开关已关闭；保存选择不会自动开启。' : '试听按所选档位扣额度；自动备用始终为智瑜。');
      this.status.setAttribute('role', 'status'); popup.append(this.status);
      if (this.onManage) {
        const manage = node('button', 'voice-picker-manage', '管理音色库 ↗'); manage.type = 'button';
        manage.onclick = () => { this.close(); this.onManage(); }; popup.append(manage);
      }
      this.position();
    }
    position() {
      if (!this.popup) return;
      const bounds = this.boundary?.getBoundingClientRect() || { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
      const anchor = this.button.getBoundingClientRect(), margin = 10;
      const width = Math.min(340, bounds.right - bounds.left - 2 * margin);
      this.popup.style.width = `${Math.max(180, width)}px`;
      this.popup.style.maxHeight = `${Math.min(560, Math.max(120, bounds.bottom - bounds.top - 2 * margin))}px`;
      const height = this.popup.getBoundingClientRect().height;
      const left = Math.max(bounds.left + margin, Math.min(anchor.right - width, bounds.right - width - margin));
      const top = Math.max(bounds.top + margin, Math.min(anchor.top - height - 8, bounds.bottom - height - margin));
      this.popup.style.left = `${left}px`; this.popup.style.top = `${top}px`;
    }
    async select(voiceId) {
      if (this.saving) return;
      const revision = this.revision, companionId = this.companionId;
      this.saving = true; this.status.textContent = '正在保存…';
      try {
        const catalogue = await this.request('select', { companionId, voiceId });
        if (revision !== this.revision) return;
        this.catalogue = catalogue; this.render(); this.status.textContent = '已保存；下一次发声使用这个音色。';
      } catch (error) { if (revision === this.revision) this.status.textContent = `保存失败：${error.message}`; }
      finally { this.saving = false; }
    }
    stopPreview() {
      this.previewController?.abort(); this.previewController = null;
      this.audio?.pause(); this.audio = null;
      if (this.audioUrl) URL.revokeObjectURL(this.audioUrl); this.audioUrl = null;
    }
    async preview(voiceId) {
      if (this.previewController) { this.stopPreview(); this.status.textContent = '已停止试听'; return; }
      this.stopPreview(); const controller = new AbortController(); this.previewController = controller;
      const revision = this.revision;
      this.status.textContent = '正在合成试听…再次点试听可停止';
      try {
        const result = await this.request('preview', { companionId: this.companionId, voiceId }, controller.signal);
        if (controller.signal.aborted || revision !== this.revision) return;
        const blob = result instanceof Blob ? result : new Blob([Uint8Array.from(atob(result.data), c => c.charCodeAt(0))], { type: result.mime });
        this.audioUrl = URL.createObjectURL(blob); this.audio = new Audio(this.audioUrl);
        this.audio.onended = () => { this.stopPreview(); if (revision === this.revision) this.status.textContent = '试听结束'; };
        await this.audio.play(); this.status.textContent = '正在试听 · 再点试听可停止';
      } catch (error) {
        if (!controller.signal.aborted && revision === this.revision) { this.stopPreview(); this.status.textContent = `试听失败：${error.message}`; }
      }
    }
    close() {
      ++this.revision; this.stopPreview(); this.popup?.remove(); this.popup = null;
      this.button.setAttribute('aria-expanded', 'false');
    }
    destroy() {
      this.close(); document.removeEventListener('pointerdown', this.outside); document.removeEventListener('keydown', this.key, true);
      document.removeEventListener('visibilitychange', this.visibility); window.removeEventListener('resize', this.reposition); this.host.replaceChildren();
    }
  }
  window.HarbourVoicePicker = HarbourVoicePicker;
})();
