/* Copy is user-initiated only. No clipboard reads, popups, or background polling. */
(() => {
  const timers = new WeakMap();

  function legacyCopy(text) {
    const active = document.activeElement;
    const selection = document.getSelection();
    const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, i) => selection.getRangeAt(i).cloneRange()) : [];
    const inputSelection = active && typeof active.selectionStart === "number"
      ? [active.selectionStart, active.selectionEnd, active.selectionDirection] : null;
    const input = document.createElement("textarea");
    input.value = text;
    input.readOnly = true;
    input.tabIndex = -1;
    input.setAttribute("aria-hidden", "true");
    input.style.cssText = "position:fixed;top:0;left:-9999px;opacity:0;pointer-events:none";
    document.body.appendChild(input);
    try {
      input.focus({ preventScroll: true });
      input.select();
      if (!document.execCommand("copy")) throw new Error("Clipboard unavailable");
    } finally {
      input.remove();
      if (active?.isConnected) {
        active.focus({ preventScroll: true });
      }
      if (selection) {
        selection.removeAllRanges();
        for (const range of ranges) selection.addRange(range);
      }
      // Restoring a document Range can reset a focused input's own selection.
      if (inputSelection && active?.isConnected) active.setSelectionRange(...inputSelection);
    }
  }

  document.addEventListener("click", async event => {
    const button = event.target.closest?.("button[data-code-copy]");
    if (!button || button.dataset.copyBusy === "true") return;
    const code = button.closest(".md-code-block")?.querySelector("pre.md-code > code");
    if (!code) return;
    event.preventDefault();
    event.stopPropagation();
    clearTimeout(timers.get(button));
    button.dataset.copyBusy = "true";
    const label = button.querySelector("[data-code-copy-label]");
    let copied = false;
    try {
      // textContent preserves indentation and blank lines without copying UI labels.
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(code.textContent);
      else legacyCopy(code.textContent); // LAN HTTP / older embedded webviews.
      copied = true;
    } catch {
      // A denied native write is not silently retried through another clipboard API.
    } finally {
      delete button.dataset.copyBusy;
    }
    button.dataset.copyState = copied ? "copied" : "error";
    if (label) label.textContent = copied ? "已复制" : "重试";
    button.title = copied ? "已复制完整内容" : "复制失败，请重试或手动选择文本";
    button.setAttribute("aria-label", button.title);
    timers.set(button, setTimeout(() => {
      delete button.dataset.copyState;
      if (label) label.textContent = "复制";
      button.title = "复制完整内容";
      button.setAttribute("aria-label", button.title);
      timers.delete(button);
    }, 2000));
  });
})();
