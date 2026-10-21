// Non-modal, scene-local settings. No duplicate settings/state or host IPC here.
export function bindTownSettings({ onOpenChange, signal }) {
  const toggle = document.getElementById('settings-toggle');
  const panel = document.getElementById('settings-panel');
  const dismiss = document.getElementById('settings-close');
  const canvas = document.getElementById('scene');
  const tabs = [...panel.querySelectorAll('[data-town-tab]')];
  const contains = target => panel.contains(target) || toggle.contains(target);
  function selectTab(tab, focus = false) {
    for (const item of tabs) {
      const active = item === tab;
      item.setAttribute('aria-selected', String(active)); item.tabIndex = active ? 0 : -1;
      document.getElementById(item.getAttribute('aria-controls')).hidden = !active;
    }
    if (focus) tab.focus({ preventScroll: true });
  }
  function setOpen(open, returnFocus = true) {
    if (open === !panel.hidden) return;
    panel.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
    document.body.classList.toggle('town-menu-open', open);
    onOpenChange(open);
    if (open) dismiss.focus({ preventScroll: true });
    else if (returnFocus && !document.hidden) toggle.focus({ preventScroll: true });
  }
  toggle.addEventListener('click', () => setOpen(panel.hidden), { signal });
  dismiss.addEventListener('click', () => setOpen(false), { signal });
  for (const [index, tab] of tabs.entries()) {
    tab.addEventListener('click', () => selectTab(tab), { signal });
    tab.addEventListener('keydown', event => {
      let next;
      if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
      if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length;
      if (event.key === 'Home') next = 0;
      if (event.key === 'End') next = tabs.length - 1;
      if (next === undefined) return;
      event.preventDefault(); event.stopPropagation(); selectTab(tabs[next], true);
    }, { signal });
  }
  document.addEventListener('pointerdown', event => {
    // Keep focus inside until the outside click is consumed below. Otherwise
    // canvas focusin could close first and let that same click lock the mouse.
    if (!panel.hidden && event.target === canvas) event.preventDefault();
  }, { capture: true, signal });
  document.addEventListener('click', event => {
    if (panel.hidden || contains(event.target)) return;
    setOpen(false, false);
    // The dismissal click is not also permission to lock the pointer.
    if (event.target === canvas) { event.preventDefault(); event.stopImmediatePropagation(); canvas.focus({ preventScroll: true }); }
  }, { capture: true, signal });
  document.addEventListener('keydown', event => {
    const typing = event.target.closest?.('input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="textbox"]');
    if (event.code === 'KeyM' && !event.repeat && !event.isComposing && !typing && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault(); event.stopImmediatePropagation();
      if (panel.hidden) document.exitPointerLock?.();
      setOpen(panel.hidden); return;
    }
    if (panel.hidden || event.key !== 'Escape') return;
    event.preventDefault(); event.stopImmediatePropagation(); setOpen(false);
  }, { capture: true, signal });
  document.addEventListener('focusin', event => {
    if (!panel.hidden && !contains(event.target)) setOpen(false, false);
  }, { signal });
  document.addEventListener('visibilitychange', () => { if (document.hidden) setOpen(false, false); }, { signal });
  return { isOpen: () => !panel.hidden, open: () => setOpen(true), close: ({ returnFocus = true } = {}) => setOpen(false, returnFocus) };
}
