/* User-invoked attachments and secondary views. All network operations stay in the
 * exact-window IPC bridge; this renderer never receives a backend token or file path. */
window.OrbExtras = class OrbExtras {
  constructor({ invoke, getState, notice, changed }) {
    Object.assign(this, { invoke, getState, notice, changed });
    this.drafts = new Map(); this.revision = 0;
    this.$ = id => document.getElementById(id);
    this.$("attach").onclick = () => { this.pin(); this.$("filePicker").click(); };
    this.$("filePicker").onchange = e => { this.addFiles(e.target.files); e.target.value = ""; };
    this.$("input").addEventListener("paste", e => {
      if (e.clipboardData.files.length) { e.preventDefault(); this.addFiles(e.clipboardData.files); }
    });
    this.$("panel").addEventListener("dragover", e => { if ([...e.dataTransfer.types].includes("Files")) { e.preventDefault(); this.$("composer").classList.add("drop-target"); } });
    this.$("panel").addEventListener("dragleave", () => this.$("composer").classList.remove("drop-target"));
    this.$("panel").addEventListener("drop", e => { e.preventDefault(); this.$("composer").classList.remove("drop-target"); this.addFiles(e.dataTransfer.files); });
    this.$("history").onclick = () => this.history();
    this.$("currentSession").onclick = () => this.history();
    this.$("more").onclick = () => this.menu();
    this.$("capture").onclick = () => this.capture();
    this.$("drawerClose").onclick = () => this.close();
  }
  files(agent = this.getState().agent) { if (!this.drafts.has(agent)) this.drafts.set(agent, []); return this.drafts.get(agent); }
  readyIds(agent) { return this.files(agent).filter(f => f.status === "ready").map(f => f.id); }
  blocked(agent) { return this.files(agent).some(f => f.status !== "ready"); }
  pin() { void this.invoke("expand", { expanded: true, pinned: true }).catch(e => this.notice(e.message)); }
  close() {
    this.revision++; this.$("drawer").hidden = true;
    this.$("runSettings").setAttribute("aria-expanded", "false");
    const cleanup = this.viewCleanup; this.viewCleanup = null; cleanup?.();
  }
  button(label, onClick, className = "drawer-item") {
    const button = document.createElement("button"); button.type = "button"; button.className = className; button.textContent = label;
    button.onclick = async () => { try { await onClick(); } catch (e) { this.notice(e.message); } }; return button;
  }
  async view(title, getContent, onClose, kind = "default") {
    this.closeRunSettings?.();
    this.close(); this.viewCleanup = onClose;
    this.pin(); const revision = ++this.revision, agent = this.getState().agent;
    this.$("drawer").dataset.view = kind;
    this.$("drawer").setAttribute("role", "dialog");
    this.$("drawer").setAttribute("aria-labelledby", "drawerTitle");
    this.$("runSettings").setAttribute("aria-expanded", String(kind === "settings"));
    this.$("drawerTitle").textContent = title; this.$("drawerBody").textContent = "正在读取…"; this.$("drawer").hidden = false;
    try {
      const nodes = await getContent(agent);
      if (revision === this.revision && agent === this.getState().agent) {
        this.$("drawerBody").replaceChildren(...nodes);
      }
    } catch (e) { if (revision === this.revision) this.$("drawerBody").textContent = e.message; }
  }
  render(state) {
    if (this.agent && this.agent !== state.agent) this.close(); this.agent = state.agent;
    const area = this.$("attachments"), files = this.files(state.agent);
    const signature = JSON.stringify(files.map(f => [f.key, f.status, f.error]));
    if (signature === this.signature) return; this.signature = signature;
    area.replaceChildren(); area.hidden = !files.length;
    for (const file of files) {
      const chip = document.createElement("div"); chip.className = "attachment-chip"; chip.dataset.status = file.status;
      if (file.preview) { const image = document.createElement("img"); image.src = file.preview; image.alt = ""; chip.append(image); }
      const label = document.createElement("span"); label.textContent = file.status === "uploading" ? `上传中 · ${file.name}` : file.name;
      label.title = file.error || file.name; chip.append(label);
      chip.append(this.button("×", () => this.remove(state.agent, file), "remove-file")); area.append(chip);
    }
  }
  remove(agent, file) {
    file.removed = true;
    if (file.preview) URL.revokeObjectURL(file.preview);
    if (file.id) void this.invoke("remove-upload", { agent, id: file.id }).catch(() => {});
    this.drafts.set(agent, this.files(agent).filter(f => f !== file)); this.changed();
  }
  consumed(agent, ids) { for (const file of [...this.files(agent)]) if (ids.includes(file.id)) this.remove(agent, file); }
  async addFiles(fileList) {
    if (this.getState().chat.readOnly) { this.notice("这段历史只读，请先新建 Web 对话再添加附件"); return; }
    this.pin(); const agent = this.getState().agent;
    for (const file of [...fileList]) {
      if (file.size > 32 * 1024 * 1024 || !file.size) { this.notice("附件不能为空，单文件最多 32 MB"); continue; }
      if (this.files(agent).length >= 10) { this.notice("每条消息最多 10 个附件"); break; }
      const item = { key: crypto.randomUUID(), name: file.name, status: "uploading", preview: file.type.startsWith("image/") ? URL.createObjectURL(file) : "" };
      this.files(agent).push(item); this.changed();
      try {
        const encoded = await new Promise((resolve, reject) => {
          const reader = new FileReader(); reader.onload = () => resolve(reader.result.split(",")[1]); reader.onerror = () => reject(new Error("文件读取失败")); reader.readAsDataURL(file);
        });
        if (item.removed) continue;
        const result = await this.invoke("upload", { agent, file: { name: file.name, mime: file.type, dataBase64: encoded } });
        Object.assign(item, result, { status: "ready" });
        if (item.removed) await this.invoke("remove-upload", { agent, id: item.id });
      } catch (e) { item.status = "error"; item.error = e.message; this.notice(e.message); }
      this.changed();
    }
  }
  async addEncoded(data) {
    const bytes = Uint8Array.from(atob(data.dataBase64), c => c.charCodeAt(0));
    return this.addFiles([new File([bytes], data.name, { type: data.mime })]);
  }
  async clipboard(translate = false) {
    const agent = this.getState().agent;
    const value = await this.invoke("clipboard", { textOnly: translate });
    if (agent !== this.getState().agent) return;
    this.close();
    if (value.file) { await this.addEncoded(value.file); return; }
    if (!value.text?.trim()) throw new Error("请先复制文字或图片，再使用此功能");
    const input = this.$("input");
    input.value = (input.value + (input.value ? "\n" : "") + (translate ? `请翻译以下文字：\n${value.text}` : value.text)).slice(0, 24000);
    input.dispatchEvent(new Event("input", { bubbles: true })); input.focus();
  }
  menu() {
    return this.view("快捷操作", async () => [
      this.button("运行设置", () => this.settings()),
      this.button("历史对话", () => this.history()),
      this.button("粘贴剪贴板中的图片或文字", () => this.clipboard()),
      this.button("翻译已复制的文字", () => this.clipboard(true)),
      this.button("用浏览器搜索已复制的文字", () => this.invoke("search")),
      this.button("桌面陪伴设置", () => this.invoke("settings")),
    ]);
  }
  history() {
    return this.view("全部对话", async agent => {
      const rows = await this.invoke("history", { agent });
      if (!rows.length) { const p = document.createElement("p"); p.textContent = "还没有历史对话。"; return [p]; }
      const search = document.createElement("input"), list = document.createElement("div");
      search.className = "history-search"; search.type = "search"; search.placeholder = "搜索对话或来源"; search.setAttribute("aria-label", "搜索全部对话");
      list.className = "history-list";
      const render = () => {
        const query = search.value.trim().toLocaleLowerCase();
        const visible = rows.filter(row => `${row.title} ${row.source?.label || ""}`.toLocaleLowerCase().includes(query));
        list.replaceChildren(...visible.map(row => {
          const button = this.button("", async () => {
            button.disabled = true;
            try { await this.invoke("select", { agent, id: row.id }); this.close(); }
            finally { button.disabled = false; }
          }, "drawer-item history-item");
          button.dataset.active = String(row.active); button.dataset.unread = String(row.unread); button.title = row.title;
          button.dataset.sessionId = row.id;
          button.disabled = !!this.getState().chat.runId || this.getState().chat.preparing || this.getState().chat.loading;
          const line = document.createElement("span"), badge = document.createElement("span"), title = document.createElement("span"), small = document.createElement("small");
          line.className = "history-title"; badge.className = "session-source"; badge.dataset.source = row.source?.kind || "web";
          badge.textContent = row.source?.label || "Web"; title.className = "history-title-text"; title.textContent = row.title;
          line.append(badge, title);
          small.textContent = [row.active ? "当前对话" : row.updatedAt ? new Date(row.updatedAt).toLocaleString() : "", row.readOnly ? "只读 · 原渠道继续" : "可继续对话"].filter(Boolean).join(" · ");
          button.append(line, small); return button;
        }));
        if (!visible.length) { const p = document.createElement("p"); p.className = "drawer-hint"; p.textContent = "没有找到匹配的对话"; list.append(p); }
      };
      search.oninput = render; render();
      const hint = document.createElement("p"); hint.className = "drawer-hint"; hint.textContent = "与 Main Chat 共用历史，按角色隔离。QQ、Discord 与 Cowork 可查看，在原入口继续。";
      return [search, hint, list];
    });
  }
  settings() { return this.openRunSettings?.(); }
  capture() {
    return this.view("选择截图 · 点击后加入附件", async agent => {
      const sources = await this.invoke("capture-sources");
      if (!sources.length) { const p = document.createElement("p"); p.textContent = "没有可用窗口，请直接粘贴截图。"; return [p]; }
      return sources.map(source => {
        const button = this.button(source.name, async () => {
          button.disabled = true;
          try {
            const file = await this.invoke("capture", { id: source.id });
            if (agent !== this.getState().agent) return;
            this.close(); await this.addEncoded(file); this.notice("截图已加入附件，确认后再发送");
          } finally { button.disabled = false; }
        }, "capture-source");
        const preview = document.createElement("img"); preview.src = source.preview; preview.alt = ""; button.prepend(preview); return button;
      });
    });
  }
};
