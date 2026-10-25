"use strict";
const film = document.querySelector("#film");
const status = document.querySelector("#player-status");
const error = document.querySelector("#player-error");
const play = document.querySelector("#play-film");
function failed() {
  play.hidden = true;
  error.hidden = false;
  status.textContent = "无法播放不影响安装；下方有完整产品说明与安装入口。";
}
film.addEventListener("error", failed);
film.querySelector("source").addEventListener("error", failed);
play.addEventListener("click", () => { film.play().catch(failed); });
film.addEventListener("play", () => { play.hidden = true; });
film.addEventListener("emptied", () => { play.hidden = false; });
film.addEventListener("loadeddata", () => { error.hidden = true; status.textContent = "视频已就绪，点击播放。配乐无旁白，说明文字在画面中。"; });
film.addEventListener("playing", () => { error.hidden = true; status.textContent = "可使用播放器调整音量、拖动进度或全屏观看。"; });
film.addEventListener("waiting", () => { status.textContent = "正在缓冲；若网络不稳定，可下载视频在本地观看。"; });
document.querySelector("#retry").addEventListener("click", () => {
  error.hidden = true;
  status.textContent = "正在重新加载…";
  film.load();
});
document.querySelector("#copy-prompt").addEventListener("click", async () => {
  const prompt = document.querySelector("#install-prompt");
  const feedback = document.querySelector("#copy-status");
  try {
    await navigator.clipboard.writeText(prompt.textContent.trim());
    feedback.textContent = "已复制，发给你的编码 Agent 即可。";
  } catch {
    document.querySelector("#prompt-details").open = true;
    const range = document.createRange(); range.selectNodeContents(prompt);
    const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
    feedback.textContent = "已展开并选中，请手动复制。";
  }
});
