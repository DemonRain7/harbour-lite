/* A local, owner-only home for finished work. No model calls or background polling. */
(function () {
  const glyphs = {
    all: 'M4 4h6v6H4z M14 4h6v6h-6z M4 14h6v6H4z M14 14h6v6h-6z',
    image: 'M4 4h16v16H4z M4 16l5-5 4 4 3-3 4 4 M15 8h.01',
    comic: 'M3 5h8v15H3z M13 5h8v7h-8z M13 14h8v6h-8z',
    document: 'M6 3h8l4 4v14H6z M14 3v5h4 M9 12h6 M9 16h6',
    file: 'M6 3h8l4 4v14H6z M14 3v5h4',
    folder: 'M3 6h7l2 3h9v11H3z', favorite: 'm12 3 2.8 5.8 6.4.9-4.6 4.5 1.1 6.3-5.7-3-5.7 3 1.1-6.3-4.6-4.5 6.4-.9Z',
    search: 'M16 16l5 5 M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
    refresh: 'M20 7v5h-5 M20 12a8 8 0 1 0-2 5',
    add: 'M12 5v14 M5 12h14', back: 'm14 5-7 7 7 7', close: 'm6 6 12 12 M18 6 6 18',
    download: 'M12 3v12 m-5-5 5 5 5-5 M4 16v5h16v-5',
    zoom: 'M16 16l5 5 M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0 M10 6v8 M6 10h8',
  };
  const icon = (name) => `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${glyphs[name] || glyphs.file}"/></svg>`;
  const labels = { all: '全部作品', favorite: '星标收藏', image: '图片', comic: '漫画', document: '文档', file: '其他文件' };
  const sizes = n => n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`;
  const statuses = { planned: '创作中', running: '创作中', paused: '待续', blocked: '待续', aborted: '已停止', ready: '已归档', incomplete: '部分文件缺失' };
  const selection = { kind: 'all', collection: '', q: '' };
  function mount(root, { api, esc, withToken, renderMarkdown, toast, openMediaViewer, closeMediaViewer }) {
    let disposed = false, request = 0, timer, data, entry, readerRequest = 0, busy = false;
    const alive = () => !disposed && root.isConnected;
    const fileUrl = (f, suffix = '') => withToken(`/api/spaces/files/${encodeURIComponent(f.id)}${suffix}`);
    root.innerHTML = `<section class="studio-shell space-shell">
      <aside class="studio-sidebar"><div class="studio-sidebar-heading"><span class="studio-kicker">YOUR HARBOUR</span><h2>空间</h2></div>
        <nav class="studio-nav" aria-label="作品分类">${Object.entries(labels).map(([k, label]) => `<button type="button" data-space-kind="${k}">${icon(k)}<span>${label}</span><small data-space-count="${k}">—</small></button>`).join('')}</nav>
        <div class="studio-sidebar-label"><span>收藏夹</span><button type="button" class="studio-icon-button" data-space-new-folder aria-label="新建收藏夹">${icon('add')}</button></div>
        <nav class="studio-nav space-folders" aria-label="收藏夹"></nav>
        <p class="studio-sidebar-note">让值得留下的作品，<br>在这里有一个位置。</p>
      </aside>
      <div class="studio-main"><header class="studio-page-heading"><div><span class="studio-kicker">COLLECTED, NOT LOST</span><h1 data-space-title>全部作品</h1><p>故事、灵感与她们，一起留在 Harbour。</p></div>
        <div class="studio-toolbar"><label class="studio-search">${icon('search')}<input type="search" data-space-search placeholder="搜索作品…" aria-label="搜索空间作品" value="${esc(selection.q)}"></label>
          <button class="studio-icon-button" type="button" data-space-refresh title="同步已生成作品" aria-label="同步已生成作品">${icon('refresh')}</button>
          <button class="studio-primary" type="button" data-space-import>${icon('add')}<span>保存文件</span></button>
          <input type="file" data-space-files multiple hidden accept=".png,.jpg,.jpeg,.webp,.gif,.pdf,.md,.txt,.csv,.html,.docx,.xlsx,.pptx,.zip,.mp4,.mp3,.wav"></div></header>
        <div class="space-section-label"><span data-space-subtitle>正在整理作品…</span><span>PRIVATE COLLECTION</span></div>
        <div data-space-status class="space-status" role="status" aria-live="polite"></div>
        <div class="space-grid" data-space-grid></div><button class="studio-secondary space-more" data-space-more type="button" hidden>载入更多</button>
      </div></section>`;
    const $ = s => root.querySelector(s);
    const setStatus = (text, error = false) => { if (alive()) { $('[data-space-status]').textContent = text; $('[data-space-status]').classList.toggle('is-error', error); } };
    function syncNav() {
      root.querySelectorAll('[data-space-kind]').forEach(b => b.setAttribute('aria-current', String(!selection.collection && b.dataset.spaceKind === selection.kind)));
      root.querySelectorAll('[data-space-folder]').forEach(b => b.setAttribute('aria-current', String(b.dataset.spaceFolder === selection.collection)));
      $('[data-space-title]').textContent = selection.collection ? data?.collections.find(c => c.id === selection.collection)?.name || '收藏夹' : labels[selection.kind];
    }
    function card(item) {
      const image = item.cover?.mime.startsWith('image/');
      return `<article class="space-card ${esc(item.kind)}"><button class="space-card-open" data-space-open="${esc(item.id)}" type="button" aria-label="打开 ${esc(item.title)}">
        <div class="space-card-cover">${image ? `<img src="${esc(fileUrl(item.cover, '?thumb=1'))}" alt="" loading="lazy" decoding="async">` : `<div class="space-document-art">${icon(item.kind)}<span>${esc(item.cover?.name.split('.').pop()?.toUpperCase() || 'FILE')}</span><i></i><i></i><i></i></div>`}
          ${item.kind === 'comic' || item.fileCount > 1 ? `<span class="space-cover-count">${icon(item.kind)} ${item.fileCount} ${item.kind === 'comic' ? '页' : '张'}</span>` : ''}
          ${item.favorite ? `<span class="space-card-star" aria-label="已星标">${icon('favorite')}</span>` : ''}</div>
        <div class="space-card-copy"><h3>${esc(item.title)}</h3><p><span>${labels[item.kind]}${statuses[item.status] ? ` · ${statuses[item.status]}` : ''}</span><time>${new Date(item.createdAt).toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })}</time></p></div>
      </button></article>`;
    }
    async function load(append = false) {
      const token = ++request, grid = $('[data-space-grid]');
      const params = new URLSearchParams({ q: selection.q, offset: String(append ? data?.entries.length || 0 : 0) });
      if (selection.kind === 'favorite') params.set('favorite', '1');
      else if (selection.kind !== 'all') params.set('kind', selection.kind);
      if (selection.collection) params.set('collection', selection.collection);
      grid.setAttribute('aria-busy', 'true'); syncNav();
      try {
        const result = await api(`/api/spaces?${params}`);
        if (!alive() || token !== request) return;
        if (append) result.entries = [...data.entries, ...result.entries]; data = result;
        for (const [k, count] of Object.entries(result.counts || {})) { const el = $(`[data-space-count="${k}"]`); if (el) el.textContent = count; }
        $('.space-folders').innerHTML = result.collections.length ? result.collections.map(c => `<button type="button" data-space-folder="${esc(c.id)}">${icon('folder')}<span>${esc(c.name)}</span><small>${c.count}</small></button>`).join('') : '<p class="studio-empty-note">用收藏夹整理一个系列。</p>';
        grid.innerHTML = result.entries.length ? result.entries.map(card).join('') : `<div class="studio-empty">${icon(selection.kind)}<h3>${selection.q ? '没有找到这件作品' : '故事会在这里留下来'}</h3><p>${selection.q ? '换个关键词，或查看其他分类。' : '生成的图片与漫画会自动归档。也可以保存已有的文档、图片和文件。'}</p>${!selection.q ? '<button type="button" class="studio-secondary" data-space-empty-import>保存第一份作品</button>' : ''}</div>`;
        $('[data-space-subtitle]').textContent = `${result.total} 件作品${selection.q ? ' · 搜索结果' : ''}`;
        $('[data-space-more]').hidden = !result.hasMore;
        setStatus(result.sync?.unavailable ? `${result.sync.unavailable} 个历史文件暂不可读取；已保存的作品不受影响。` : ''); syncNav();
      } catch (error) { if (alive() && token === request) { setStatus(error.message, true); if (!data) grid.innerHTML = '<div class="studio-empty"><h3>暂时无法读取空间</h3><p>请点击右上角同步重试。首次更新需要重启 Harbour 后端。</p></div>'; } }
      finally { if (alive() && token === request) grid.removeAttribute('aria-busy'); }
    }
    function askName(title, current, action) {
      const dialog = document.createElement('dialog'); dialog.className = 'studio-dialog';
      dialog.innerHTML = `<form><h2>${esc(title)}</h2><input class="inp" name="name" aria-label="${esc(title)}" maxlength="${entry ? '180' : '60'}" required value="${esc(current)}"><p role="status"></p><footer><button type="button" class="studio-secondary" data-cancel>取消</button><button class="studio-primary" type="submit">保存</button></footer></form>`;
      root.append(dialog); dialog.showModal(); dialog.querySelector('input').select();
      dialog.querySelector('[data-cancel]').onclick = () => dialog.close(); dialog.onclose = () => dialog.remove();
      dialog.querySelector('form').onsubmit = async e => { e.preventDefault(); const b = dialog.querySelector('[type="submit"]'); b.disabled = true;
        try { await action(dialog.querySelector('input').value); dialog.close(); } catch (err) { dialog.querySelector('[role="status"]').textContent = err.message; } finally { b.disabled = false; } };
    }
    function closeReader() {
      closeMediaViewer();
      readerRequest++; const last = entry?.id; entry = null; const reader = $('.space-reader'); reader?.close(); reader?.remove();
      $('.studio-shell').inert = false; root.querySelector(`[data-space-open="${last}"]`)?.focus();
    }
    async function updateEntry(patch) {
      if (!entry || busy) return; busy = true;
      const current = entry, token = readerRequest;
      try {
        const value = await api(`/api/spaces/entries/${current.id}`, { method: 'PATCH', body: JSON.stringify({ ...patch, revision: current.revision }) });
        if (alive() && token === readerRequest) { entry = value; readerHeader(); } await load();
      } catch (error) { toast(error.message, true); throw error; } finally { busy = false; }
    }
    function readerHeader() {
      const r = $('.space-reader'); if (!r || !entry) return;
      r.querySelector('[data-reader-title]').textContent = entry.title;
      const star = r.querySelector('[data-reader-star]'); star.setAttribute('aria-pressed', String(entry.favorite)); star.title = entry.favorite ? '取消星标' : '加入星标';
      r.querySelector('[data-reader-collection]').value = entry.collectionId || '';
    }
    async function open(id) {
      const token = ++readerRequest;
      try {
        const value = await api(`/api/spaces/entries/${id}`); if (!alive() || token !== readerRequest) return; entry = value;
        const reader = document.createElement('dialog'); reader.className = `space-reader ${entry.kind === 'comic' ? 'is-comic' : ''}`;
        reader.setAttribute('role', 'dialog'); reader.setAttribute('aria-modal', 'true'); reader.setAttribute('aria-label', '作品阅读器');
        reader.innerHTML = `<header class="space-reader-header"><button class="studio-icon-button" data-reader-close type="button" aria-label="返回空间">${icon('back')}</button><div class="space-reader-heading"><span class="studio-kicker">${entry.kind === 'comic' ? 'SCROLL TO READ' : 'IN YOUR HARBOUR'}</span><h2 data-reader-title></h2></div>
          <div class="space-reader-actions"><button class="studio-icon-button" data-reader-star type="button" aria-label="星标作品">${icon('favorite')}</button><button class="studio-secondary" data-reader-rename type="button">重命名</button>
          <select class="inp" data-reader-collection aria-label="移至收藏夹"><option value="">未分类</option>${(data?.collections || []).map(c => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('')}</select></div></header>
          <div class="space-reader-scroll" tabindex="0"><div class="space-reader-intro"><span>${labels[entry.kind]} · ${entry.files.length} ${entry.kind === 'comic' ? '页' : '个文件'}</span><span>${entry.kind === 'comic' ? '向下阅读 · 点击图片放大查看' : entry.files.some(f => f.mime.startsWith('image/')) ? '点击图片放大查看 · 原文件保留' : '原文件保留 · 可随时下载'}</span></div>
          <div class="space-reader-pages">${entry.files.map((f, i) => `<figure class="space-reader-page" data-page="${i}">
            ${f.mime.startsWith('image/') ? `<button type="button" class="space-image-frame${f.presentation === 'comic-page' ? ' is-legacy-page' : ''}" data-space-zoom="${i}" aria-label="放大查看：${esc(entry.title)} · 第 ${i + 1} 张"><img src="${esc(fileUrl(f))}" alt="${esc(entry.title)} · ${i + 1}" loading="${i ? 'lazy' : 'eager'}" decoding="async"><span class="space-image-zoom" aria-hidden="true">${icon('zoom')}<span>放大查看</span></span></button>${f.presentation === 'comic-page' ? '<p class="space-page-caption">单格原图暂不可读取，保留已有拼版存档。</p>' : ''}` : f.mime === 'application/pdf' ? `<iframe src="${esc(fileUrl(f))}" title="${esc(f.name)}" referrerpolicy="no-referrer"></iframe>` : f.mime.startsWith('text/') ? '<div class="space-text-preview md-body">正在读取文档…</div>' : `<div class="space-file-preview">${icon(entry.kind)}<h3>${esc(f.name)}</h3><p>原文件已保存 · ${sizes(f.size)}</p><p>下载后用对应应用打开。</p></div>`}
            ${f.caption ? `<p class="space-page-caption">${esc(f.caption)}</p>` : ''}
            <figcaption><span>${String(i + 1).padStart(2, '0')} <span>${esc(f.name)}</span></span><a class="studio-download" href="${esc(fileUrl(f, '?download=1'))}" download="${esc(f.name)}">${icon('download')}<span>下载原文件</span></a></figcaption></figure>`).join('')}</div>
          <p class="space-reader-end">${['planned', 'running', 'paused', 'blocked'].includes(entry.status) ? `${statuses[entry.status]} · 新生成的页面会继续归入这部作品` : '你已经读到这里的最后一页。'}</p></div>`;
        closeMediaViewer(); $('.space-reader')?.remove(); root.append(reader); reader.showModal(); $('.studio-shell').inert = true; readerHeader(); reader.querySelector('[data-reader-close]').focus();
        reader.addEventListener('cancel', e => { e.preventDefault(); closeReader(); });
        reader.querySelector('[data-reader-close]').onclick = closeReader;
        reader.querySelector('[data-reader-star]').onclick = () => updateEntry({ favorite: !entry.favorite }).catch(() => {});
        reader.querySelector('[data-reader-rename]').onclick = () => askName('重命名作品', entry.title, name => updateEntry({ title: name }));
        reader.querySelector('[data-reader-collection]').onchange = e => updateEntry({ collectionId: e.target.value || null }).catch(() => readerHeader());
        for (const [i, f] of entry.files.entries()) if (f.mime.startsWith('text/')) {
          try { const result = await api(`/api/spaces/files/${f.id}?text=1`); if (!alive() || token !== readerRequest) return;
            const preview = reader.querySelector(`[data-page="${i}"] .space-text-preview`);
            if (f.mime === 'text/markdown') {
              // Parse in an inert template: removing images after insertion would already fetch them.
              const template = document.createElement('template'); template.innerHTML = renderMarkdown(result.text);
              template.content.querySelectorAll('img,iframe,video,audio,source,object,embed,link,script').forEach(el => {
                const note = document.createElement('span'); note.textContent = el.alt ? `[图片：${el.alt}]` : '[嵌入资源]'; el.replaceWith(note);
              });
              preview.replaceChildren(template.content);
            } else { const pre = document.createElement('pre'); pre.textContent = result.text; preview.replaceChildren(pre); }
            if (result.truncated) preview.insertAdjacentHTML('beforeend', '<p class="muted">文档较长，预览前 128 KB；下载可查看完整内容。</p>');
          } catch (error) { if (alive() && token === readerRequest) reader.querySelector(`[data-page="${i}"] .space-text-preview`).textContent = error.message; }
        }
      } catch (error) { if (alive()) toast(error.message, true); }
    }
    root.addEventListener('click', onClick);
    function onClick(e) {
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.spaceKind) { selection.kind = b.dataset.spaceKind; selection.collection = ''; void load(); }
      if (b.dataset.spaceFolder) { selection.collection = b.dataset.spaceFolder; selection.kind = 'all'; void load(); }
      if (b.dataset.spaceOpen) void open(b.dataset.spaceOpen);
      if (b.hasAttribute('data-space-zoom')) {
        const image = b.querySelector('img');
        if (image) openMediaViewer({ kind: 'image', url: image.getAttribute('src'), title: image.alt, origin: b });
      }
      if (b.matches('[data-space-import], [data-space-empty-import]')) $('[data-space-files]').click();
      if (b.hasAttribute('data-space-new-folder')) askName('新建收藏夹', '', async name => { const c = await api('/api/spaces/collections', { method: 'POST', body: JSON.stringify({ name }) }); selection.collection = c.id; selection.kind = 'all'; await load(); });
    }
    $('[data-space-search]').oninput = e => { selection.q = e.target.value; clearTimeout(timer); timer = setTimeout(() => load(), 200); };
    $('[data-space-more]').onclick = () => load(true);
    $('[data-space-refresh]').onclick = async e => { const b = e.currentTarget; b.disabled = true; setStatus('正在核对已生成作品…');
      try { const result = await api('/api/spaces/refresh', { method: 'POST', body: '{}' }); await load(); setStatus(result.unavailable ? `同步完成，${result.unavailable} 个历史文件不可读取。` : `同步完成 · 新归档 ${result.imported} 件作品`); } catch (error) { setStatus(error.message, true); } finally { if (alive()) b.disabled = false; } };
    $('[data-space-files]').onchange = async e => {
      const files = [...e.target.files]; e.target.value = ''; const b = $('[data-space-import]'); b.disabled = true;
      let saved = 0;
      try { for (const f of files) {
        if (!alive()) break; if (f.size > 40 * 1024 * 1024) throw new Error(`${f.name} 超过 40 MB`);
        setStatus(`正在保存 ${f.name}…`);
        const base64 = await new Promise((resolve, reject) => { const r = new FileReader(); r.onload = () => resolve(String(r.result).split(',')[1]); r.onerror = reject; r.readAsDataURL(f); });
        await api('/api/spaces/import', { method: 'POST', body: JSON.stringify({ name: f.name, base64, collectionId: selection.collection || null }) }); saved++;
      } await load(); setStatus(`已保存 ${saved} 个文件`); } catch (error) { await load(); setStatus(`已保存 ${saved} 个文件；${error.message}`, true); } finally { if (alive()) b.disabled = false; }
    };
    function keyboard(e) {
      if (!alive() || !entry || e.defaultPrevented || e.target.closest?.('.media-viewer') || root.querySelector('.studio-dialog[open]')) return;
      if (e.key === 'Escape') { e.preventDefault(); closeReader(); }
      if (e.key === 'Tab') {
        const focusable = [...$('.space-reader').querySelectorAll('button, a, select, [tabindex="0"]')];
        const first = focusable[0], last = focusable.at(-1);
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
      }
    }
    document.addEventListener('keydown', keyboard);
    const dispose = () => { closeMediaViewer(); disposed = true; request++; readerRequest++; clearTimeout(timer); document.removeEventListener('keydown', keyboard); root.removeEventListener('click', onClick); };
    dispose.ready = load(); return dispose;
  }
  window.HarbourSpaces = { mount, icon };
})();
