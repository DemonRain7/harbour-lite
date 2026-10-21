(() => {
  const el = (tag, className, text) => {
    const node = document.createElement(tag); node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  // Text nodes only: model output never becomes HTML or an executable URL.
  function appendText(parent, text) {
    const paragraph = el("p", "reply-text");
    for (const piece of text.split(/(```[\s\S]*?(?:```|$)|`[^`\n]+`|\*\*[^*\n]+\*\*)/g)) {
      if (piece.startsWith("```")) paragraph.append(el("code", "reply-code", piece.replace(/^```[^\n]*\n?/, "").replace(/```$/, "")));
      else if (piece.startsWith("`")) paragraph.append(el("code", "", piece.slice(1, -1)));
      else if (piece.startsWith("**")) paragraph.append(el("strong", "", piece.slice(2, -2)));
      else paragraph.append(document.createTextNode(piece));
    }
    if (paragraph.textContent.trim()) parent.append(paragraph);
  }

  class OrbMessages {
    constructor({ root, scroller, invoke, notice }) {
      Object.assign(this, { root, scroller, invoke, notice });
      this.cache = new Map(); this.cards = new Map(); this.queue = [];
      this.epoch = 0; this.active = 0; this.scope = ""; this.followBottom = true;
      scroller.addEventListener("scroll", () => {
        this.followBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
      }, { passive: true });
      this.observer = new IntersectionObserver(entries => {
        for (const { target, isIntersecting } of entries) {
          target.visible = isIntersecting;
          if (isIntersecting && target.media.id) this.load(target);
        }
        this.trim();
      }, { root: scroller, rootMargin: "160px 0px" });
      this.viewer = document.getElementById("imageViewer");
      document.getElementById("imageClose").onclick = () => this.closePreview();
      document.getElementById("imageZoom").onclick = () => {
        const zoomed = this.viewer.dataset.zoomed !== "true";
        this.viewer.dataset.zoomed = String(zoomed);
        document.getElementById("imageZoom").textContent = zoomed ? "适应窗口" : "原尺寸";
        document.getElementById("imageZoom").setAttribute("aria-pressed", String(zoomed));
      };
      document.getElementById("imageFull").onclick = () => this.openFull();
      this.viewer.addEventListener("close", () => {
        document.getElementById("imageOriginal").removeAttribute("src");
        this.previewId = null; this.trim();
      });
      window.addEventListener("pagehide", () => this.clear());
    }
    openFull() { this.invoke("open", { agent: this.agent }).catch(error => this.notice(error.message)); }
    visibility(expanded) {
      if (expanded && !this.visible) requestAnimationFrame(() => {
        if (this.visible && this.followBottom) this.scroller.scrollTop = this.scroller.scrollHeight;
      });
      this.visible = expanded;
      if (!expanded) this.closePreview();
    }
    closePreview() { if (!this.viewer.open) return false; this.viewer.close(); return true; }
    clear() {
      ++this.epoch; this.closePreview(); this.observer.disconnect(); this.queue = [];
      for (const record of this.cache.values()) if (record.url) URL.revokeObjectURL(record.url);
      this.cache.clear(); this.cards.clear();
    }
    render(next, active) {
      const scope = `${next.agent}:${next.chat.sessionId || ""}`, changed = scope !== this.scope;
      const userSent = next.chat.runId && next.chat.runId !== this.lastRunId && next.chat.messages.at(-1)?.role === "user";
      const follow = changed || userSent || this.followBottom;
      if (changed) { this.clear(); this.scope = scope; this.visibleCount = 40; }
      else if (!follow && this.current) this.visibleCount += Math.max(0, next.chat.messages.length - this.current.next.chat.messages.length);
      this.current = { next, active };
      this.agent = next.agent;
      this.lastRunId = next.chat.runId;
      this.observer.disconnect(); this.cards.clear(); this.root.replaceChildren();
      if (!next.chat.messages.length) {
        const welcome = el("div", "welcome");
        welcome.append(el("span", "welcome-mark", "~"), el("h2", "", "随时，靠岸。"), el("p", "", "聊一会儿，或把想做的事交给我。"));
        this.root.append(welcome);
      }
      const start = Math.max(0, next.chat.messages.length - this.visibleCount);
      if (start > 0) {
        const more = el("button", "history-more", `查看更早的消息 · 还有 ${start} 条`);
        more.type = "button";
        more.onclick = () => {
          const oldHeight = this.scroller.scrollHeight, oldTop = this.scroller.scrollTop;
          this.visibleCount += 40; this.followBottom = false;
          this.render(this.current.next, this.current.active);
          this.scroller.scrollTop = oldTop + this.scroller.scrollHeight - oldHeight;
        };
        this.root.append(more);
      } else if (next.chat.summary) {
        const summary = el("details", "history-summary");
        summary.append(el("summary", "", "较早内容已由后端压缩 · 查看摘要"), el("p", "", next.chat.summary));
        this.root.append(summary);
      }
      for (const [index, message] of next.chat.messages.slice(start).entries()) {
        const row = el("article", `turn ${message.role}`), header = el("header", "turn-header");
        row.dataset.messageIndex = String(start + index);
        if (message.role === "assistant" && active?.avatar) {
          const avatar = el("img", "turn-avatar"); avatar.src = active.avatar; avatar.alt = ""; avatar.draggable = false;
          header.append(avatar);
        }
        header.append(el("small", "", message.role === "user" ? "你" : active?.displayName || "Harbour"));
        const bubble = el("div", "reply-bubble");
        for (const part of message.parts || [{ type: "text", text: message.content }]) {
          if (part.type === "image") bubble.append(this.image(part));
          else appendText(bubble, part.text);
        }
        for (const file of message.attachments || []) {
          const chip = el("button", "message-file", `↗ ${file.name || "附件"}`);
          chip.title = "在完整会话查看附件"; chip.onclick = () => this.openFull(); bubble.append(chip);
        }
        row.append(header, bubble);
        if (message.role === "assistant") {
          const copy = el("button", "copy-reply quiet", "复制回复");
          copy.onclick = () => this.invoke("copy", { text: message.content }).catch(error => this.notice(error.message));
          row.append(copy);
        }
        this.root.append(row);
      }
      for (const cards of this.cards.values()) for (const card of cards) this.observer.observe(card);
      if (follow) { this.scroller.scrollTop = this.scroller.scrollHeight; this.followBottom = true; }
      this.trim();
    }
    image(media) {
      const card = el("figure", "reply-image"), button = el("button", "image-open"), image = el("img", "reply-picture");
      card.media = media; card.visible = false; card.dataset.state = media.expired ? "error" : "loading";
      image.alt = media.name; image.draggable = false; image.hidden = true; image.decoding = "async";
      const status = el("span", "image-status", media.expired ? "图片已过期" : "正在加载图片…");
      button.setAttribute("aria-label", `查看图片：${media.name}`); button.append(image, status);
      const caption = el("figcaption", "image-caption"), label = el("span", "", media.name);
      const full = el("button", "quiet", "完整会话 ↗"); full.onclick = () => this.openFull(); caption.append(label, full);
      card.append(button, caption);
      image.onerror = () => {
        card.dataset.state = "error"; image.hidden = true; status.textContent = "图片无法显示 · 点击重试";
      };
      image.onload = () => {
        if (this.followBottom) this.scroller.scrollTop = this.scroller.scrollHeight;
      };
      button.onclick = () => {
        const record = this.cache.get(media.id);
        if (record?.url && card.dataset.state === "ready") this.preview(media, record.url);
        else if (media.id) {
          if (record?.url) URL.revokeObjectURL(record.url);
          this.cache.delete(media.id); this.load(card);
        } else this.openFull();
      };
      if (media.id) {
        const cards = this.cards.get(media.id) || []; cards.push(card); this.cards.set(media.id, cards);
        this.paint(card);
      }
      return card;
    }
    paint(card) {
      const record = this.cache.get(card.media.id), image = card.querySelector("img"), status = card.querySelector(".image-status");
      card.dataset.state = record?.url ? "ready" : record?.error ? "error" : "loading";
      image.hidden = !record?.url;
      if (record?.url) { if (image.src !== record.url) image.src = record.url; }
      else image.removeAttribute("src");
      status.textContent = record?.error ? `${record.error} · 点击重试` : "正在加载图片…";
    }
    load(card) {
      if (!card.media.id || !card.isConnected) return;
      let record = this.cache.get(card.media.id);
      if (!record) {
        record = { id: card.media.id, epoch: this.epoch, agent: this.agent, used: Date.now() };
        this.cache.set(record.id, record); this.queue.push(record);
      }
      record.used = Date.now(); this.paint(card); this.drain();
    }
    drain() {
      while (this.active < 2 && this.queue.length) {
        const record = this.queue.shift();
        if (record.epoch !== this.epoch || this.cache.get(record.id) !== record) continue;
        ++this.active;
        this.invoke("image", { agent: record.agent, id: record.id }).then(({ bytes, mime }) => {
          if (record.epoch !== this.epoch || this.cache.get(record.id) !== record) return;
          record.size = bytes.byteLength; record.url = URL.createObjectURL(new Blob([bytes], { type: mime }));
        }, error => { record.error = (error.message || "图片加载失败").replace(/^Error invoking remote method '[^']+': (?:Error: )?/, ""); }).finally(() => {
          --this.active;
          if (record.epoch === this.epoch) {
            for (const card of this.cards.get(record.id) || []) this.paint(card);
            this.trim();
          }
          this.drain();
        });
      }
    }
    trim() {
      const loaded = [...this.cache.values()].filter(r => r.url).sort((a, b) => a.used - b.used);
      let size = loaded.reduce((total, r) => total + r.size, 0), count = loaded.length;
      for (const record of loaded) {
        if (count <= 6 && size <= 32 * 1024 * 1024 && this.cards.has(record.id)) continue;
        if (record.id === this.previewId || this.cards.get(record.id)?.some(card => card.visible)) continue;
        URL.revokeObjectURL(record.url); this.cache.delete(record.id); count--; size -= record.size;
        for (const card of this.cards.get(record.id) || []) this.paint(card);
      }
    }
    preview(media, url) {
      const rect = document.getElementById("panel").getBoundingClientRect();
      Object.assign(this.viewer.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
      document.getElementById("imageTitle").textContent = media.name;
      const original = document.getElementById("imageOriginal"); original.src = url; original.alt = media.name;
      this.viewer.dataset.zoomed = "false"; document.getElementById("imageZoom").textContent = "原尺寸";
      document.getElementById("imageZoom").setAttribute("aria-pressed", "false"); this.previewId = media.id;
      this.invoke("expand", { expanded: true, pinned: true }).catch(error => this.notice(error.message));
      this.viewer.showModal();
    }
  }
  window.OrbMessages = OrbMessages;
})();
