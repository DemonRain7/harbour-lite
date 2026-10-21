"use strict";

const REVEAL_MS = 250, RETRACT_MS = 700, REARM_MS = 160;
// No extra timer or global hook. Reuse the native click-through cursor sample;
// renderer resize events cannot forge a mouse departure or re-entry.
class OrbHover {
  constructor() { this.reset(); }
  reset(blocked = false) { this.blocked = blocked; this.entered = null; this.left = null; }
  step({ now, inside, trigger, expanded, pinned, held }) {
    if (held) { this.entered = this.left = null; return null; }
    if (this.blocked) {
      if (inside) this.left = null;
      else if (this.left === null) this.left = now;
      else if (now - this.left >= REARM_MS) this.reset();
      return null;
    }
    if (expanded) {
      this.entered = null;
      if (inside || pinned) this.left = null;
      else if (this.left === null) this.left = now;
      else if (now - this.left >= RETRACT_MS) { this.reset(); return "close"; }
    } else {
      this.left = null;
      if (!trigger) this.entered = null;
      else if (this.entered === null) this.entered = now;
      else if (now - this.entered >= REVEAL_MS) { this.reset(); return "open"; }
    }
    return null;
  }
}
module.exports = { OrbHover, REVEAL_MS, RETRACT_MS, REARM_MS };
