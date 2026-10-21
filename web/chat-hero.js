/* Local-only chat decoration. Images stay in IndexedDB, never become attachments
 * or enter a model request. One visibility preference, independent image per skin. */
(() => {
  "use strict";
  const KEY = "harbour-chat-hero-v1";
  const MAX_BYTES = 10 * 1024 * 1024;
  const sources = Object.create(null);
  let hidden = false, context = null, revision = 0, dbPromise, fade, popupController;
  const uploads = new Map(), cached = new Map();
  const escape = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const icon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${{
    picture: '<rect x="3.5" y="3.5" width="17" height="17" rx="4"/><circle cx="9" cy="9" r="1.5"/><path d="m4 17 5-5 4 4 3-3 4 4"/>',
    eye: '<path d="M2.5 12s3.5-6 9.5-6 9.5 6 9.5 6-3.5 6-9.5 6-9.5-6-9.5-6Z"/><circle cx="12" cy="12" r="2.5"/>',
    eyeOff: '<path d="m3 3 18 18M9.8 6.2A11 11 0 0 1 12 6c6 0 9.5 6 9.5 6a18 18 0 0 1-2.6 3.2M6.1 7.5A18 18 0 0 0 2.5 12s3.5 6 9.5 6a12 12 0 0 0 4.3-.8"/>',
    chevron: '<path d="m8 10 4 4 4-4"/>',
    close: '<path d="m6 6 12 12M18 6 6 18"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    upload: '<path d="M12 16V4m-4 4 4-4 4 4M4 15v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4"/>',
    follow: '<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5Z"/>',
  }[name] || ""}</svg>`;
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) || "null");
    hidden = saved?.hidden === true;
    for (const [id, value] of Object.entries(saved?.sources || {})) {
      if (/^[a-z0-9_-]+$/.test(id) && value && typeof value.selection === "string") {
        sources[id] = { selection: value.selection, customName: typeof value.customName === "string" ? value.customName.slice(0, 120) : "" };
      }
    }
  } catch { /* Invalid or unavailable local storage uses the built-in image. */ }
  document.body.dataset.chatHeroHidden = String(hidden);

  function message(text, error = false) {
    const el = document.querySelector("[data-hero-message]");
    if (el) { el.textContent = text; el.classList.toggle("is-error", error); }
  }
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify({ hidden, sources })); return true; }
    catch { message("本机存储不可用；这次修改只在当前窗口生效。", true); return false; }
  }
  function database() {
    if (!dbPromise) dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open("harbour-appearance", 1);
      let settled = false;
      const fail = () => { if (!settled) { settled = true; dbPromise = null; reject(new Error("无法打开本机图片存储；请关闭其它旧窗口后重试")); } };
      request.onupgradeneeded = () => request.result.createObjectStore("portraits");
      request.onsuccess = () => {
        const db = request.result;
        if (settled) { db.close(); return; }
        settled = true;
        db.onversionchange = () => { db.close(); dbPromise = null; };
        resolve(db);
      };
      request.onerror = request.onblocked = fail;
    });
    return dbPromise;
  }
  async function imageStore(id, file, ticket) {
    const db = await database();
    if (ticket && uploads.get(id) !== ticket) throw new Error("图片选择已更新");
    return new Promise((resolve, reject) => {
      const tx = db.transaction("portraits", file ? "readwrite" : "readonly");
      if (ticket) ticket.cancel = () => { try { tx.abort(); } catch { /* Already committed. */ } };
      const request = file ? tx.objectStore("portraits").put(file, id) : tx.objectStore("portraits").get(id);
      tx.oncomplete = () => { if (ticket) ticket.cancel = null; resolve(request.result); };
      tx.onerror = tx.onabort = () => { if (ticket) ticket.cancel = null; reject(new Error("图片未能保存，请检查本机存储空间")); };
    });
  }
  async function decode(src) {
    const image = new Image();
    image.src = src;
    let timer;
    try {
      await Promise.race([image.decode(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("图片读取超时")), 15000); })]);
      return image;
    } finally { clearTimeout(timer); }
  }
  async function customSource(id) {
    if (cached.has(id)) return cached.get(id);
    const file = await imageStore(id);
    if (!(file instanceof Blob)) throw new Error("自定义图片已不在本机存储中，请重新上传");
    if (!cached.has(id)) cached.set(id, URL.createObjectURL(file));
    return cached.get(id);
  }

  async function apply() {
    const current = context, request = ++revision;
    document.body.dataset.chatHeroHidden = String(hidden);
    fade?.cancel(); fade = null;
    render();
    const img = document.querySelector(".harbour-hero");
    if (!img || !current) return;
    img.setAttribute("aria-hidden", String(hidden || current.category !== "anime"));
    const choice = sources[current.id]?.selection || "auto";
    let src = current.defaultSrc;
    try {
      src = choice === "custom" ? await customSource(current.id)
        : current.variants.find(item => item.id === choice)?.src || current.defaultSrc;
      if (request !== revision) return;
      if (img.getAttribute("src") === src) { render(); return; }
      await decode(src);
    } catch (error) {
      if (request !== revision) return;
      src = current.defaultSrc || current.fallback;
      message(`${error.message}；暂时显示默认立绘。`, true);
    }
    if (request !== revision) return;
    const changed = img.getAttribute("src") !== src;
    img.onerror = () => { img.onerror = null; img.src = current.fallback; };
    img.src = src;
    img.alt = `${current.label} · 聊天立绘`;
    render();
    const preview = document.querySelector("[data-hero-preview]");
    if (preview) preview.src = src;
    if (changed && !hidden && current.category === "anime" && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
      fade = img.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 240, easing: "ease-out" });
    }
  }
  function render() {
    const host = document.getElementById("chatHeroControls");
    if (!host || !context) return;
    host.hidden = context.category !== "anime";
    const choice = sources[context.id] || { selection: "auto" };
    host.dataset.hidden = String(hidden);
    if (context.category !== "anime") closePicker();
    const quick = host.querySelector("[data-hero-quick]");
    if (quick) {
      quick.setAttribute("aria-pressed", String(!hidden));
      quick.setAttribute("aria-label", hidden ? "显示聊天立绘" : "收起聊天立绘，展开阅读空间");
      quick.innerHTML = `${icon(hidden ? "eyeOff" : "eye")}<span class="chat-tool-label">${hidden ? "显示立绘" : "收起立绘"}</span>`;
    }
    const toggle = host.querySelector("[data-hero-visible]");
    if (toggle) toggle.checked = !hidden;
    const name = host.querySelector("[data-hero-persona]");
    if (name) name.textContent = context.label;
    const variant = context.variants.find(item => item.id === choice.selection);
    const follows = choice.selection !== "custom" && !variant;
    const title = host.querySelector("[data-hero-title]");
    const titleText = choice.selection === "custom" ? choice.customName || "我的立绘" : (variant || context.variants.find(item => item.src === context.defaultSrc))?.label || "默认立绘";
    if (title) { title.textContent = titleText; title.title = titleText; }
    const mode = host.querySelector("[data-hero-mode]");
    if (mode) mode.textContent = follows ? "随主题配色自动切换" : "固定这张图片 · 不改变配色";
    const follow = host.querySelector("[data-hero-reset]");
    if (follow) { follow.setAttribute("aria-pressed", String(follows)); follow.title = follows ? "当前跟随主题配色" : "恢复默认，跟随主题配色"; }
    const gallery = host.querySelector("[data-hero-gallery]");
    if (gallery) {
      const entries = [...context.variants, ...(choice.customName || choice.selection === "custom"
        ? [{ id: "custom", label: "我的图片", src: cached.get(context.id) || context.defaultSrc }] : [])];
      const signature = JSON.stringify([context.id, entries]);
      // Toggling visibility or selection must not replace the focused tile.
      if (gallery.dataset.signature !== signature) {
        gallery.dataset.signature = signature;
        gallery.style.setProperty("--hero-columns", Math.min(3, entries.length) || 1);
        gallery.innerHTML = entries.map(item => `<button type="button" class="hero-thumbnail" data-hero-choice="${escape(item.id)}" aria-label="使用${escape(item.label)}立绘" title="${escape(item.label)}">
          <span class="hero-thumbnail-image"><img src="${escape(item.src)}" alt="" loading="lazy"><span class="hero-thumbnail-check">${icon("check")}</span></span>
          <span class="hero-thumbnail-label">${escape(item.label)}</span></button>`).join("");
      }
      gallery.querySelectorAll("[data-hero-choice]").forEach(button => button.setAttribute("aria-pressed", String(button.dataset.heroChoice === choice.selection)));
    }
    const preview = host.querySelector("[data-hero-preview]");
    const src = (choice.selection === "custom" ? cached.get(context.id) : context.variants.find(item => item.id === choice.selection)?.src) || context.defaultSrc;
    if (preview && preview.getAttribute("src") !== src) preview.src = src;
    const busy = uploads.has(context.id);
    const upload = host.querySelector("[data-hero-upload]");
    if (upload) { upload.disabled = busy; upload.querySelector("b").textContent = busy ? "正在保存到本机…" : "上传自己的图片"; }
    positionPicker();
  }
  function setHidden(value) {
    hidden = value === true;
    // Only change presentation; do not rebuild the chat DOM or disturb its draft/scroll.
    void apply();
    message(hidden ? "立绘已收起，聊天空间已展开。" : "立绘已显示。所有二次元主题共用此开关。");
    save();
  }
  function choose(selection) {
    if (!context || (selection !== "auto" && selection !== "custom" && !context.variants.some(item => item.id === selection))) return;
    const pending = uploads.get(context.id);
    uploads.delete(context.id); // A later explicit choice wins, including the pending disk write.
    pending?.cancel?.();
    sources[context.id] = { ...sources[context.id], selection };
    void apply(); message(selection === "auto" ? "已恢复随当前角色配色显示。" : "已更换立绘，不改变主题配色。"); save();
  }
  async function upload(file, id) {
    if (!file || !id) return;
    if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) { message("请选择 PNG、JPG 或 WebP 图片。", true); return; }
    if (file.size > MAX_BYTES) { message("图片请控制在 10 MB 以内。", true); return; }
    const ticket = {}, url = URL.createObjectURL(file);
    uploads.get(id)?.cancel?.();
    uploads.set(id, ticket); render(); message("正在检查并保存到本机…");
    let accepted = false;
    try {
      const image = await decode(url);
      if (!image.naturalWidth || image.naturalWidth * image.naturalHeight > 24_000_000) throw new Error("图片尺寸过大，请选择不超过 2400 万像素的图片");
      if (uploads.get(id) !== ticket) return;
      await imageStore(id, file, ticket);
      if (uploads.get(id) !== ticket) return;
      const previous = cached.get(id);
      cached.set(id, url); accepted = true;
      sources[id] = { selection: "custom", customName: file.name.slice(0, 120) };
      const saved = save();
      await apply();
      if (previous) URL.revokeObjectURL(previous);
      if (context?.id === id) message(saved ? "已保存到本机；仅替换这个角色的聊天立绘。不会作为附件发送。" : "图片已保存，但本机偏好存储不可用；下次可能需要重新选择。", !saved);
    } catch (error) { if (context?.id === id && uploads.get(id) === ticket) message(error.message || "图片保存失败", true); }
    finally {
      if (!accepted) URL.revokeObjectURL(url);
      if (uploads.get(id) === ticket) uploads.delete(id);
      render();
    }
  }
  function mount() {
    popupController?.destroy();
    const host = document.getElementById("chatHeroControls");
    if (!host) return;
    host.innerHTML = `<div class="hero-toolbar-group"><details class="chat-hero-picker">
      <summary class="chat-tool-button" aria-label="聊天外观 · 立绘与背景" aria-expanded="false" aria-controls="chatHeroPopover">${icon("picture")}<span class="chat-tool-label">立绘与背景</span></summary>
      <section class="chat-hero-popover chat-tool-popover" id="chatHeroPopover" aria-label="聊天立绘与背景设置" hidden>
        <header class="hero-picker-heading"><span class="hero-heading-icon">${icon("picture")}</span><div><span>CHAT APPEARANCE</span><h3>立绘与背景</h3></div><button type="button" class="hero-close" data-hero-close aria-label="关闭立绘设置" title="关闭">${icon("close")}</button></header>
        <div class="hero-picker-body">
        <div class="hero-current-picture"><div class="hero-current-frame"><img data-hero-preview alt="当前立绘预览"></div><div class="hero-current-info"><span data-hero-persona></span><b data-hero-title></b><small data-hero-mode></small></div></div>
        <label class="hero-visibility"><span><b>显示右侧立绘</b><small>关闭后，聊天区平滑展开</small><small class="hero-compact-hint">窄窗口自动收起，宽屏沿用此设置</small></span><input type="checkbox" role="switch" data-hero-visible aria-label="显示右侧立绘"></label>
        <div class="hero-gallery-heading"><b>选择画面</b><button type="button" class="hero-follow" data-hero-reset aria-label="恢复默认，跟随配色">${icon("follow")}<span>跟随配色</span></button></div>
        <div class="hero-gallery" data-hero-gallery aria-label="可选立绘"></div>
        <button type="button" class="hero-upload" data-hero-upload>${icon("upload")}<span><b>上传自己的图片</b><small>PNG / JPG / WebP · 最多 10 MB</small></span><span aria-hidden="true">＋</span></button>
        <input type="file" data-hero-file accept="image/png,image/jpeg,image/webp" hidden>
        <section class="hero-background"><h4>对话背景</h4><div class="bg-picker" id="chatBgPicker">
          <button type="button" class="bgp-btn" data-bg="paper">纸</button>
          <button type="button" class="bgp-btn" data-bg="grid">方格</button>
          <button type="button" class="bgp-btn" data-bg="stars">星屑</button>
          <button type="button" class="bgp-btn bgp-up" id="chatBgUploadButton" aria-label="上传对话背景图片">＋图</button><input type="file" id="chatBgUpload" accept="image/*" hidden>
          <button type="button" class="bgp-btn bgp-reset" id="chatBgReset" title="清除自定义背景（回到纸）" aria-label="清除自定义背景" style="display:none">↺</button>
        </div></section>
        </div><footer class="hero-picker-footer"><p data-hero-message role="status">即时生效 · 仅保存在本机，不影响头像和桌宠</p></footer>
      </section>
    </details><button type="button" class="chat-tool-button hero-quick-toggle" data-hero-quick></button></div>`;
    popupController = window.HarbourChatTools.popover({
      details: host.querySelector('details'), trigger: host.querySelector('summary'), panel: host.querySelector('.chat-hero-popover'),
      container: host.querySelector('details'),
      onChange(open) { if (open) host.querySelector('.hero-picker-body').scrollTop = 0; },
    });
    host.querySelector('#chatBgUploadButton').addEventListener('click', () => host.querySelector('#chatBgUpload').click());
    host.querySelector("[data-hero-quick]").addEventListener("click", () => setHidden(!hidden));
    host.querySelector("[data-hero-close]").addEventListener("click", () => closePicker(true));
    host.querySelector("[data-hero-visible]").addEventListener("change", event => setHidden(!event.target.checked));
    host.querySelector("[data-hero-gallery]").addEventListener("click", event => {
      const choice = event.target.closest("[data-hero-choice]");
      if (choice) choose(choice.dataset.heroChoice);
    });
    host.querySelector("[data-hero-reset]").addEventListener("click", () => choose("auto"));
    const input = host.querySelector("[data-hero-file]");
    host.querySelector("[data-hero-upload]").addEventListener("click", () => { input.dataset.persona = context.id; input.click(); });
    input.addEventListener("change", () => { const file = input.files[0], id = input.dataset.persona || context.id; input.value = ""; void upload(file, id); });
    render();
  }
  function closePicker(focus = false) {
    popupController?.setOpen(false, focus);
  }
  function positionPicker() {
    popupController?.reposition();
  }
  window.HarbourChatHero = { mount, unmount() { popupController?.destroy(); popupController = null; }, update(value) { context = value; return apply(); } };
})();
