/* Bounded lyric surfaces. Text is plain text, not Markdown/HTML; timestamps and
 * source selection come from Folia, not a second network or audio owner. */
window.OrbLyrics = class {
  constructor({ invoke, open }) {
    this.root = document.getElementById("lyricOverlay");
    document.getElementById("lyricOpen").onclick = open;
    document.getElementById("lyricClose").onclick = () => void invoke("lyric-overlay", { value: false }).catch(() => {});
  }
  layout(box) {
    this.box = box;
    if (box) Object.assign(this.root.style, { left: `${box.x}px`, top: `${box.y}px`, width: `${box.width}px`, height: `${box.height}px` });
    this.root.hidden = !box;
  }
  paint(state, clock, enabled) {
    this.root.hidden = !this.box || !enabled || !state?.loaded || state.provider !== "folia";
    if (this.root.hidden) return;
    const title = state.tracks.find(t => t.id === state.currentTrackId)?.title || "音乐陪伴";
    const text = clock.current?.text || clock.message;
    const label = `${state.paused ? "已暂停 · " : clock.stale ? "同步中 · " : ""}${title}`;
    document.getElementById("lyricSong").textContent = label;
    this.root.dataset.paused = String(state.paused || clock.stale);
    const line = document.getElementById("lyricLine");
    if (line.textContent !== text) { line.textContent = text; this.arrive(line); }
    document.getElementById("lyricOpen").title = [label, text, clock.current?.translation, "打开音乐面板"].filter(Boolean).join("\n");
  }
  paintPanel(root, state, clock) {
    const $ = name => root.querySelector(`[data-lyric="${name}"]`);
    const content = [clock.previous?.text || "", clock.current?.text || clock.message, clock.current?.translation || "", clock.next?.text || ""];
    ["previous", "current", "translation", "next"].forEach((name, i) => {
      const node = $(name);
      if (node.textContent !== content[i]) { node.textContent = content[i]; if (name === "current") this.arrive(node); }
      node.title = content[i];
    });
    $("translation").hidden = !content[2];
    root.dataset.hasLyric = String(!!clock.current);
    root.title = clock.stale ? "等待 Folia 的最新播放时间，未继续猜测进度。" : "与 Folia 的歌词和时间校正同步";
  }
  arrive(node) {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    node.getAnimations().forEach(a => a.cancel());
    node.animate([{ opacity: .35, transform: "translateY(3px)" }, { opacity: 1, transform: "translateY(0)" }], { duration: 240, easing: "ease-out" });
  }
};
