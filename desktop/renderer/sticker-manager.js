(() => {
  const desktop = window.harbourDesktop;
  const grid = document.getElementById("stickerGrid");
  const dialog = document.getElementById("stickerDialog");
  let pendingPath = "";
  const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);

  async function render() {
    const stickers = await desktop.listStickers("elaina");
    grid.innerHTML = stickers.length ? stickers.map((sticker) => `<article class="sticker-card${sticker.enabled === false ? " is-disabled" : ""}"><img src="${esc(sticker.url)}" alt=""><strong>${esc(sticker.label || sticker.id)}</strong><small>${esc((sticker.phrases || sticker.tags || []).join(" · ") || sticker.mood || "未写关键词")}</small><div class="row"><span class="pill">${sticker.builtIn ? "内置" : "本地"}</span><input class="toggle" type="checkbox" data-toggle="${esc(sticker.id)}" ${sticker.enabled === false ? "" : "checked"} aria-label="启用"><button class="btn icon danger" data-remove="${esc(sticker.id)}" ${sticker.builtIn ? "disabled title=\"内置贴纸只能停用\"" : "title=\"删除\""}>×</button></div></article>`).join("") : '<div class="empty">还没有表情包</div>';
  }

  document.getElementById("chooseSticker").addEventListener("click", async () => {
    const chosen = await desktop.chooseSticker();
    if (!chosen) return;
    pendingPath = chosen.path;
    document.getElementById("stickerPreview").src = chosen.previewUrl;
    document.getElementById("stickerLabel").value = chosen.label || "";
    document.getElementById("stickerPhrases").value = "";
    dialog.showModal();
  });
  document.getElementById("saveSticker").addEventListener("click", async (event) => {
    event.preventDefault();
    await desktop.addSticker({
      path: pendingPath,
      label: document.getElementById("stickerLabel").value,
      phrases: document.getElementById("stickerPhrases").value,
      mood: document.getElementById("stickerMood").value,
    });
    dialog.close(); pendingPath = ""; await render();
  });
  grid.addEventListener("change", async (event) => {
    const toggle = event.target.closest("[data-toggle]");
    if (!toggle) return;
    await desktop.setStickerEnabled(toggle.dataset.toggle, toggle.checked); await render();
  });
  grid.addEventListener("click", async (event) => {
    const remove = event.target.closest("[data-remove]");
    if (!remove || remove.disabled) return;
    if (await desktop.removeSticker(remove.dataset.remove)) await render();
  });
  render().catch((error) => { grid.innerHTML = `<div class="empty">${esc(error.message)}</div>`; });
})();
