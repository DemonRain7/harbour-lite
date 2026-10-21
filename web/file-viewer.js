/* One read-only attachment viewer for Dashboard / History. No HTML execution. */
(() => {
  const el = (tag, className, text) => {
    const node = document.createElement(tag); node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  let options, current;
  function localUrl(raw) {
    try {
      if (typeof raw !== "string" || /[\\\x00-\x1f\x7f]/.test(raw)) return "";
      const url = new URL(raw, location.href);
      if (url.origin !== location.origin || !url.pathname.startsWith("/uploads/") || url.username || url.password) return "";
      const original = raw.replace(/^https?:\/\/[^/]+/i, "").split(/[?#]/)[0];
      const decoded = decodeURIComponent(original);
      if (!decoded.startsWith("/uploads/") || /[%:\\?\x00-\x1f\x7f]/.test(decoded) || /%2f|%5c/i.test(original)
        || decoded.slice(9).split("/").some(part => !part || part === "." || part === ".." || /[. ]$/.test(part))) return "";
      return url.pathname;
    } catch { return ""; }
  }
  function close() {
    const selection = current;
    if (!selection) return;
    current = null;
    // Do not depend on the dialog's queued close event (background windows may
    // defer rendering). Invalidate requests before a new selection can be made.
    selection.controller.abort(); selection.dialog.close(); selection.dialog.remove();
    if (selection.origin?.isConnected) selection.origin.focus({ preventScroll: true });
  }
  async function external(raw, name, status) {
    const url = localUrl(raw);
    if (!url) { options.toast("只能通过此入口打开 Harbour 托管的附件", true); return; }
    if (!window.harbourDesktop?.openAttachment) { options.toast("浏览器请使用「下载」，再选择本机应用打开"); return; }
    try {
      if (status) status.textContent = "正在准备本机副本…";
      const result = await window.harbourDesktop.openAttachment({ url, name, token: options.token() });
      if (status?.isConnected) status.textContent = result.message;
      options.toast(result.message);
    } catch (error) {
      const message = String(error.message || "打开失败").replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "");
      if (status?.isConnected) status.textContent = message;
      options.toast(message, true);
    }
  }
  function bytesLabel(size) {
    return size < 1024 ? `${size} B` : size < 1024 ** 2 ? `${(size / 1024).toFixed(1)} KB` : `${(size / 1024 ** 2).toFixed(1)} MB`;
  }
  async function open({ url: raw, name, origin, autoExternal = true }) {
    const url = localUrl(raw);
    if (!url) return false;
    close();
    const controller = new AbortController(), dialog = el("dialog", "attachment-reader");
    const selection = { dialog, controller, origin }; current = selection;
    const title = name || decodeURIComponent(url.split("/").pop());
    const head = el("header", "attachment-reader-head"), identity = el("div", "attachment-reader-identity");
    identity.append(el("span", "attachment-reader-eyebrow", "文件预览"), el("h2", "", title));
    const meta = el("span", "attachment-reader-meta", "只读 · 正在读取…"); identity.append(meta);
    const actions = el("div", "attachment-reader-actions"), closeButton = el("button", "btn ghost icon", "×");
    closeButton.type = "button"; closeButton.setAttribute("aria-label", "关闭文件预览"); closeButton.onclick = close;
    const download = el("a", "btn ghost", "下载");
    download.href = options.withToken(url); download.download = title; download.dataset.fileDownload = "true";
    const native = el("button", "btn ghost", "默认应用 ↗"); native.type = "button";
    native.hidden = !window.harbourDesktop?.openAttachment;
    const status = el("footer", "attachment-reader-footer", "仅查看文件，不执行其中的代码。");
    native.onclick = async () => { native.disabled = true; try { await external(url, title, status); } finally { native.disabled = false; } };
    actions.append(download, native, closeButton); head.append(identity, actions);
    const body = el("div", "attachment-reader-body"), loading = el("div", "attachment-reader-state", "正在读取文件…");
    body.append(loading); dialog.append(head, body, status);
    dialog.setAttribute("aria-label", `文件预览：${title}`);
    dialog.addEventListener("close", () => {
      controller.abort(); dialog.remove();
      if (current === selection) {
        current = null;
        if (origin?.isConnected) origin.focus({ preventScroll: true });
      }
    }, { once: true });
    dialog.addEventListener("cancel", event => { event.preventDefault(); close(); });
    dialog.addEventListener("keydown", event => { if (event.key === "Escape") event.stopPropagation(); });
    dialog.addEventListener("click", event => { if (event.target === dialog) {
      const r = dialog.getBoundingClientRect();
      if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) close();
    } });
    document.body.append(dialog); dialog.showModal(); closeButton.focus();
    try {
      const result = await options.api(`/api/files/preview?url=${encodeURIComponent(url)}`, { signal: controller.signal });
      if (current !== selection) return true;
      meta.textContent = `${result.language || "文件"} · ${bytesLabel(Number(result.size) || 0)}${result.encoding ? ` · ${result.encoding.toUpperCase()}` : ""} · 只读`;
      body.replaceChildren();
      if (result.status === "text" && typeof result.content === "string" && result.content.length <= 1024 * 1024) {
        native.textContent = "文本应用 ↗";
        native.title = "打开 .txt 安全副本，不执行源文件";
        const lines = result.content.replace(/\r\n?/g, "\n").split("\n");
        if (lines.length > 20000) throw new Error("文本行数超过预览上限，请下载查看");
        const code = el("pre", "attachment-reader-code"); code.tabIndex = 0; code.setAttribute("aria-label", "文件内容，只读");
        const fragment = document.createDocumentFragment();
        for (const [index, line] of lines.entries()) {
          const row = el("span", "attachment-reader-line"), number = el("span", "attachment-reader-number", index + 1);
          number.setAttribute("aria-hidden", "true"); row.append(number, el("span", "attachment-reader-text", line || "\u200b")); fragment.append(row);
        }
        code.append(fragment); body.append(code);
        status.textContent = result.content ? "只读预览 · 可选择并复制文字 · Esc 关闭" : "这是一个空文件";
      } else {
        body.append(el("div", "attachment-reader-state", result.status === "too_large" ? "文件较大，建议使用本机应用查看" : "此格式交给你熟悉的应用查看"));
        status.textContent = window.harbourDesktop?.openAttachment ? "将在本机打开附件副本；修改不会同步回服务端。" : "点击「下载」，再用本机应用打开。";
        if (autoExternal && !native.hidden) { native.disabled = true; await external(url, title, status); native.disabled = false; }
      }
    } catch (error) {
      if (current !== selection || controller.signal.aborted) return true;
      body.replaceChildren(el("div", "attachment-reader-state", error.message || "文件暂时无法读取"));
      status.textContent = "没有启动外部应用；附件可能已过期，或需要重新连接服务。";
      const retry = el("button", "btn ghost", "重试"); retry.onclick = () => open({ url, name: title, origin, autoExternal }); body.append(retry);
    }
    return true;
  }
  function init(config) {
    options = config;
    document.addEventListener("click", event => {
      if (event.defaultPrevented || event.button !== 0) return;
      const system = event.target.closest?.("[data-file-external]");
      if (system) { event.preventDefault(); void external(system.dataset.fileExternal, system.dataset.fileName); return; }
      const link = event.target.closest?.("a[href]");
      if (!link || link.hasAttribute("download") || link.dataset.fileDownload || link.matches(".att-img-link, [data-media-kind]")) return;
      const url = localUrl(link.getAttribute("href"));
      if (!url) return;
      event.preventDefault();
      const name = link.dataset.fileName || link.textContent.trim();
      const ext = decodeURIComponent(url).toLowerCase();
      const kind = /\.(?:mp4|m4v|mov|mkv|avi|video\.webm)$/.test(ext) ? "video" : /\.(?:mp3|wav|m4a|ogg|webm|flac|amr)$/.test(ext) ? "audio" : null;
      if (kind) options.openMediaViewer({ kind, url: options.withToken(url), title: name, origin: link });
      else void open({ url, name, origin: link });
    });
    window.addEventListener("hashchange", close);
    window.addEventListener("pagehide", close);
  }
  window.HarbourFiles = { init, open, close, external, localUrl };
})();
