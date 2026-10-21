import { TownMotion, motionDelta } from './player-motion.js';
import { edgeLookVelocity } from './look-input.js';

// Both maps share Harbour's movement and input lifetime. Imported map physics
// remains untouched; chatting and hidden scenes cannot consume input events.
export class TownPlayer extends TownMotion {
  _bind() {}
  constructor(camera, canvas, physics, bounds, signal, onLookState = () => {}) {
    super(camera, canvas, physics, bounds);
    this.hoverLook = true;
    let pointer = null;
    let edgeVelocity = 0, edgeCurrent = 0, requesting = false;
    this.pointerLocked = false;
    this.cursorReleased = false;
    const touches = new Map();
    const reset = () => { pointer = null; edgeVelocity = edgeCurrent = 0; touches.clear(); this.keys.clear(); this.stopMotion(); this.touchMove.set(0, 0); };
    const publishLook = () => onLookState({ locked: this.pointerLocked, released: this.cursorReleased });
    this.resetInput = reset;
    this.releaseLook = ({ freeCursor = false } = {}) => {
      reset();
      if (freeCursor || requesting) this.cursorReleased = true;
      if (document.pointerLockElement === canvas) document.exitPointerLock();
      publishLook();
    };
    this.applyEdgeLook = elapsed => {
      if (!this.enabled || !this.hoverLook || this.pointerLocked || this.cursorReleased || !edgeVelocity) { edgeCurrent = 0; return; }
      if (edgeCurrent * edgeVelocity < 0) edgeCurrent = 0;
      const dt = motionDelta(elapsed), blend = -Math.expm1(-12 * dt);
      this.look.dx += edgeVelocity * dt + (edgeCurrent - edgeVelocity) * blend / 12;
      edgeCurrent += (edgeVelocity - edgeCurrent) * blend;
    };
    canvas.addEventListener('pointerenter', () => { pointer = null; }, { signal });
    canvas.addEventListener('pointerleave', () => { if (!this.pointerLocked) reset(); }, { signal });
    canvas.addEventListener('pointermove', event => {
      if (this.pointerLocked) return; // Locked mouse uses relative mousemove only.
      if (event.pointerType !== 'mouse' || !this.enabled || !this.hoverLook || this.cursorReleased) { pointer = null; return; }
      if (pointer) { this.look.dx += event.clientX - pointer.x; this.look.dy += event.clientY - pointer.y; }
      pointer = { x: event.clientX, y: event.clientY };
      const rect = canvas.getBoundingClientRect();
      edgeVelocity = edgeLookVelocity(event.clientX - rect.left, rect.width);
    }, { signal });
    document.addEventListener('mousemove', event => {
      if (document.pointerLockElement !== canvas || !this.enabled || !this.hoverLook || this.cursorReleased) return;
      this.look.dx += event.movementX; this.look.dy += event.movementY;
    }, { signal });
    document.addEventListener('pointerlockchange', () => {
      const wasLocked = this.pointerLocked;
      reset(); this.pointerLocked = document.pointerLockElement === canvas;
      if (this.pointerLocked && (!this.enabled || !this.hoverLook || this.cursorReleased || signal.aborted)) { this.releaseLook(); return; }
      if (wasLocked && !this.pointerLocked) this.cursorReleased = true;
      publishLook();
    }, { signal });
    const failed = () => { requesting = false; onLookState({ locked: false, released: this.cursorReleased, unavailable: true }); };
    document.addEventListener('pointerlockerror', failed, { signal });
    canvas.addEventListener('click', async event => {
      if (!this.enabled || !this.hoverLook || this.pointerLocked || requesting || (event.pointerType && event.pointerType !== 'mouse')) return;
      canvas.focus({ preventScroll: true }); reset(); this.cursorReleased = false; requesting = true; publishLook();
      try {
        if (!canvas.requestPointerLock) { failed(); return; }
        await canvas.requestPointerLock();
        if (signal.aborted || !this.enabled || !this.hoverLook || this.cursorReleased) this.releaseLook();
      } catch { failed(); }
      finally { requesting = false; }
    }, { signal });
    window.addEventListener('keydown', event => {
      const ownCanvas = document.pointerLockElement === canvas;
      const bareAlt = ['AltLeft', 'AltRight'].includes(event.code) && !event.ctrlKey && !event.metaKey && !event.shiftKey;
      if (bareAlt && (ownCanvas || (this.enabled && this.hoverLook && (event.target === canvas || event.target === document.body)))) {
        event.preventDefault(); this.releaseLook({ freeCursor: true }); return;
      }
      if (event.code === 'Escape' && ownCanvas) { this.releaseLook({ freeCursor: true }); return; }
      if (!this.enabled || (event.target !== canvas && event.target !== document.body)) return;
      if (this.cursorReleased || event.altKey || event.ctrlKey || event.metaKey) return;
      if (!['KeyW', 'KeyA', 'KeyS', 'KeyD', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'ShiftLeft', 'ShiftRight', 'Space'].includes(event.code)) return;
      this.keys.add(event.code);
      if (event.code === 'Space' && !event.repeat) this.jump();
      event.preventDefault();
    }, { signal });
    window.addEventListener('keyup', event => this.keys.delete(event.code), { signal });
    window.addEventListener('blur', this.releaseLook, { signal });
    canvas.addEventListener('touchstart', event => {
      if (!this.enabled) return;
      for (const touch of event.changedTouches) touches.set(touch.identifier, { x0: touch.clientX, y0: touch.clientY, x: touch.clientX, y: touch.clientY, left: touch.clientX < innerWidth * .45 });
      event.preventDefault();
    }, { signal, passive: false });
    canvas.addEventListener('touchmove', event => {
      if (!this.enabled) { reset(); return; }
      for (const touch of event.changedTouches) {
        const start = touches.get(touch.identifier); if (!start) continue;
        if (start.left) this.touchMove.set((touch.clientX - start.x0) / 60, (touch.clientY - start.y0) / 60).clampLength(0, 1);
        else { this.look.dx += (touch.clientX - start.x) * 2.2; this.look.dy += (touch.clientY - start.y) * 2.2; }
        start.x = touch.clientX; start.y = touch.clientY;
      }
      event.preventDefault();
    }, { signal, passive: false });
    const end = event => { for (const touch of event.changedTouches) { if (touches.get(touch.identifier)?.left) this.touchMove.set(0, 0); touches.delete(touch.identifier); } };
    canvas.addEventListener('touchend', end, { signal });
    canvas.addEventListener('touchcancel', end, { signal });
    signal.addEventListener('abort', this.releaseLook, { once: true });
  }
  update(dt) { this.applyEdgeLook(dt); super.update(dt); }
}
