"use strict";

/**
 * Electron's native `-webkit-app-region: drag` does not expose a dependable mouse-up event on
 * every Windows build.  Keep the visual drag state separate from the native window move and
 * release it after move events settle, otherwise the last left/right animation can stay latched.
 */
function createPetDragState({
  settleMs = 280,
  directionThreshold = 3,
  onDirection = () => {},
  onActiveChange = () => {},
  onSettled = () => {},
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  let active = false;
  let last = null;
  let directionAnchorX = null;
  let settleTimer = null;

  function setActive(next) {
    if (active === next) return;
    active = next;
    onActiveChange(active);
  }

  function armSettle() {
    if (settleTimer) clearTimer(settleTimer);
    settleTimer = setTimer(() => {
      settleTimer = null;
      finish();
    }, Math.max(40, Number(settleMs) || 280));
  }

  function begin(point) {
    const x = Number(point?.x);
    const y = Number(point?.y);
    last = Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
    directionAnchorX = last?.x ?? null;
    onDirection(null);
    setActive(true);
    armSettle();
  }

  function move(point) {
    const x = Number(point?.x);
    const y = Number(point?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
    if (!last) {
      begin({ x, y });
      return false;
    }
    if (x === last.x && y === last.y) return false;
    if (!active) {
      setActive(true);
      directionAnchorX = last.x;
    }
    last = { x, y };
    const anchor = directionAnchorX ?? x;
    const deltaX = x - anchor;
    if (Math.abs(deltaX) >= Math.max(1, Number(directionThreshold) || 3)) {
      onDirection(deltaX < 0 ? "left" : "right");
      directionAnchorX = x;
    }
    armSettle();
    return true;
  }

  function finish() {
    const wasActive = active || !!settleTimer;
    if (settleTimer) clearTimer(settleTimer);
    settleTimer = null;
    last = null;
    directionAnchorX = null;
    onDirection(null);
    setActive(false);
    if (wasActive) onSettled();
  }

  return {
    begin,
    move,
    finish,
    dispose: finish,
    get active() { return active; },
  };
}

module.exports = { createPetDragState };
