"use strict";

// User-triggered desktop affordances only. No clipboard polling, global selection hook,
// automatic screenshots, input automation, or extra model/permission engine.
function createOrbDesktop({ clipboard, desktopCapturer, shell, getWindow }) {
  let sources = new Set(), captureBusy = false;
  const text = () => clipboard.readText().slice(0, 24_000);
  return {
    copy: value => clipboard.writeText(value),
    clipboard: ({ textOnly } = {}) => {
      if (textOnly) return { text: text() };
      const picture = clipboard.readImage();
      if (!picture.isEmpty()) {
        const bytes = picture.toPNG();
        if (bytes.length > 32 * 1024 * 1024) throw new Error("剪贴板图片超过 32 MB");
        return { file: { name: "clipboard.png", mime: "image/png", dataBase64: bytes.toString("base64") } };
      }
      return { text: text() };
    },
    search: async ({ text: input }) => {
      const query = typeof input === "string" ? input.trim() : text().trim();
      if (!query || query.length > 4000) throw new Error("请先复制或输入要搜索的文字（最多 4000 字）");
      await shell.openExternal(`https://www.bing.com/search?q=${encodeURIComponent(query)}`); return true;
    },
    "capture-sources": async () => {
      const items = (await desktopCapturer.getSources({ types: ["screen", "window"], thumbnailSize: { width: 320, height: 180 } }))
        .filter(s => s.name !== "Harbour · 悬浮助手").slice(0, 40);
      sources = new Set(items.map(s => s.id));
      return items.map(s => ({ id: s.id, name: s.name, preview: s.thumbnail.toDataURL() }));
    },
    capture: async ({ id }) => {
      if (!sources.has(id) || captureBusy) throw new Error("请重新选择截图窗口，或等待当前截图完成");
      captureBusy = true;
      try {
        const own = getWindow();
        // Do not hide the user's windows or change focus to produce a screenshot.
        // Window capture excludes the orb; whole-screen capture may include visible UI.
        if (!own || own.isDestroyed()) throw new Error("悬浮助手已关闭");
        const item = (await desktopCapturer.getSources({ types: [id.startsWith("screen:") ? "screen" : "window"],
          thumbnailSize: { width: 1920, height: 1080 } })).find(s => s.id === id);
        if (!item || item.thumbnail.isEmpty()) throw new Error("窗口不可截图，请换一个窗口或直接粘贴截图");
        return { name: `screenshot-${Date.now()}.png`, mime: "image/png", dataBase64: item.thumbnail.toPNG().toString("base64") };
      } finally { captureBusy = false; sources.clear(); }
    },
  };
}

module.exports = { createOrbDesktop };
