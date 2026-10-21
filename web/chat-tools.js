/* Chat utility surfaces share positioning and dismissal, never chat/playback state. */
window.HarbourChatTools = (() => {
  function popover({ trigger, panel, container = trigger.parentElement, details, onChange = () => {} }) {
    const events = new AbortController(), options = { signal: events.signal };
    let open = false, disposed = false;
    panel.setAttribute('popover', 'manual');
    panel.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    trigger.setAttribute('aria-controls', panel.id);

    function reposition() {
      if (!open || !panel.isConnected || !trigger.isConnected) return;
      const anchor = trigger.getBoundingClientRect();
      const width = Math.min(panel.offsetWidth || 360, Math.max(0, innerWidth - 24));
      const above = Math.max(0, anchor.top - 20), below = Math.max(0, innerHeight - anchor.bottom - 20);
      const upwards = above >= Math.min(420, panel.scrollHeight) || above > below;
      const available = Math.max(80, upwards ? above : below);
      panel.style.setProperty('--chat-tool-height', `${available}px`);
      panel.style.left = `${Math.max(12, Math.min(anchor.left, innerWidth - width - 12))}px`;
      panel.style.top = `${upwards ? Math.max(12, anchor.top - Math.min(panel.offsetHeight, available) - 8) : anchor.bottom + 8}px`;
      panel.dataset.side = upwards ? 'above' : 'below';
    }
    function setOpen(next, focus = false) {
      if (disposed || next === open) return;
      open = next;
      if (open) window.dispatchEvent(new CustomEvent('harbour:chat-tool-open', { detail: panel }));
      if (details) details.open = open;
      trigger.setAttribute('aria-expanded', String(open));
      panel.hidden = !open;
      if (open) {
        // Top layer escapes the scrollable session rail, including scaled/narrow windows.
        try { panel.showPopover?.(); } catch { /* Fixed-position fallback for older browsers. */ }
        reposition();
      } else {
        try { panel.hidePopover?.(); } catch { /* Already dismissed or detached. */ }
        if (focus) trigger.focus({ preventScroll: true });
      }
      onChange(open);
    }
    if (details) details.addEventListener('toggle', () => setOpen(details.open), options);
    else trigger.addEventListener('click', () => setOpen(!open), options);
    panel.addEventListener('click', event => {
      if (event.target.closest('[data-chat-tool-close]')) setOpen(false, true);
    }, options);
    document.addEventListener('pointerdown', event => {
      if (open && !container.contains(event.target) && !panel.contains(event.target)) setOpen(false);
    }, options);
    document.addEventListener('keydown', event => {
      if (open && event.key === 'Escape') { setOpen(false, true); event.preventDefault(); event.stopPropagation(); }
    }, options);
    document.addEventListener('focusin', event => {
      if (open && !container.contains(event.target) && !panel.contains(event.target)) setOpen(false);
    }, options);
    window.addEventListener('harbour:chat-tool-open', event => { if (event.detail !== panel) setOpen(false); }, options);
    window.addEventListener('resize', reposition, options);
    document.addEventListener('scroll', reposition, { ...options, capture: true, passive: true });
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(reposition) : null;
    observer?.observe(panel);
    observer?.observe(document.getElementById('content') || container);
    return {
      setOpen, reposition,
      destroy() { setOpen(false); disposed = true; events.abort(); observer?.disconnect(); },
    };
  }
  return { popover };
})();
