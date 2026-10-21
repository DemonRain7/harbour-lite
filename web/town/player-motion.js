import { Player } from './station/src/core/player.js';
import { STEP_HEIGHT } from './station/src/core/physics.js';

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const DEG = Math.PI / 180;
export const motionDelta = dt => Number.isFinite(dt) ? clamp(dt, 0, .05) : 0;

// Harbour's shared walker, independent of either imported map. Keep their
// collision geometry intact; camera comfort must not edit source map assets.
export class TownMotion extends Player {
  _bind() {}

  constructor(...args) {
    super(...args);
    this.walk = 2.7;
    this.run = 4.5;
    this.stepOffset = 0;
    this.stepVelocity = 0;
    this.probe = { x: 0, z: 0 };
  }

  stopMotion() {
    this.vel.set(0, 0, 0);
    this.look.dx = this.look.dy = 0;
  }

  jump() {
    if (!this.enabled || !this.onGround || this.fly) return;
    this.vy = 4.2; this.onGround = false;
  }

  setPose(...args) {
    this.stopMotion(); this.stepOffset = this.stepVelocity = 0; this.bob = 0;
    super.setPose(...args);
    this.onGround = !this.fly;
  }

  update(elapsed) {
    const dt = motionDelta(elapsed);
    if (!this.enabled) { this.stopMotion(); return; }
    // Mouse deltas are already time-integrated. No camera spring, input queue,
    // running sensitivity multiplier or post-input drift.
    this.yaw -= (Number.isFinite(this.look.dx) ? this.look.dx : 0) * .0022;
    this.pitch = clamp(this.pitch - (Number.isFinite(this.look.dy) ? this.look.dy : 0) * .0022, -85 * DEG, 85 * DEG);
    this.look.dx = this.look.dy = 0;
    if (!dt) { this.applyCamera(); return; }

    const k = this.keys;
    let f = Number(k.has('KeyW') || k.has('ArrowUp')) - Number(k.has('KeyS') || k.has('ArrowDown')) - this.touchMove.y;
    let s = Number(k.has('KeyD') || k.has('ArrowRight')) - Number(k.has('KeyA') || k.has('ArrowLeft')) + this.touchMove.x;
    const magnitude = Math.hypot(f, s);
    if (magnitude > 1) { f /= magnitude; s /= magnitude; }
    // The outer touch-stick range ramps into running, not a sudden 0.95 switch.
    const touchRun = clamp((this.touchMove.length() - .75) / .25, 0, 1);
    const sprint = k.has('ShiftLeft') || k.has('ShiftRight') ? 1 : touchRun * touchRun * (3 - 2 * touchRun);
    const speed = (this.walk + (this.run - this.walk) * sprint) * (this.fly ? 2.6 : 1);
    const tx = (-Math.sin(this.yaw) * f + Math.cos(this.yaw) * s) * speed;
    const tz = (-Math.cos(this.yaw) * f - Math.sin(this.yaw) * s) * speed;
    const u = Number(k.has('Space') || k.has('KeyE')) - Number(k.has('ControlLeft') || k.has('KeyQ'));
    // At most six collision steps after a stall; a settled player needs only
    // one ground/contact check, not 120 idle physics checks every second.
    const moving = magnitude > 1e-6 || this.vel.lengthSq() > 0 || !this.onGround || this.fly;
    const count = moving ? Math.ceil(dt / (1 / 120)) : 1, h = dt / count;
    for (let i = 0; i < count; i++) {
      const rate = magnitude < 1e-6 ? 22 : this.onGround || this.fly ? 10 : 4;
      const blend = -Math.expm1(-rate * h);
      // Integrate the response as well as velocity: 30/60/120 Hz travel agrees.
      const dx = tx * h + (this.vel.x - tx) * blend / rate;
      const dz = tz * h + (this.vel.z - tz) * blend / rate;
      this.vel.x += (tx - this.vel.x) * blend;
      this.vel.z += (tz - this.vel.z) * blend;
      const x = this.pos.x, z = this.pos.z;
      if (this.fly) {
        this.pos.x += dx; this.pos.z += dz; this.pos.y += u * speed * h;
        this.onGround = false; this.stepOffset = this.stepVelocity = 0;
      } else {
        const p = this.probe, b = this.bounds;
        p.x = x + dx; p.z = z + dz;
        this.physics.resolve(p, this.radius, this.pos.y, this.height);
        p.x = clamp(p.x, b.x0, b.x1); p.z = clamp(p.z, b.z0, b.z1);
        let ground = this.physics.groundHeight(p.x, p.z, this.pos.y);
        if (ground - this.pos.y > STEP_HEIGHT + 1e-6) {
          p.x = x; p.z = z; this.vel.x = this.vel.z = 0;
          ground = this.physics.groundHeight(x, z, this.pos.y);
        } else {
          // Remove velocity into the contact normal, retaining wall sliding.
          // A blocked runner cannot bank momentum and lurch after turning away.
          const nx = p.x - x - dx, nz = p.z - z - dz, n2 = nx * nx + nz * nz;
          const inward = this.vel.x * nx + this.vel.z * nz;
          if (n2 > 1e-12 && inward < 0) {
            this.vel.x -= nx * inward / n2; this.vel.z -= nz * inward / n2;
          }
        }
        this.pos.x = p.x; this.pos.z = p.z;
        if (this.onGround && this.vy <= 0 && Math.abs(ground - this.pos.y) <= STEP_HEIGHT + 1e-6) {
          // Follow small descending steps too, rather than repeatedly free-fall
          // and land. Only this ground discontinuity is eased, not mouse look.
          this.stepOffset += this.pos.y - ground;
          this.pos.y = ground; this.vy = 0;
        } else {
          this.pos.y += this.vy * h - 6 * h * h;
          this.vy -= 12 * h; this.onGround = false;
          if (this.pos.y <= ground) { this.pos.y = ground; this.vy = 0; this.onGround = true; }
        }
        // Bounded offset prevents the camera lagging below stairs or floating
        // far above them. No visual sway or extra landing kick is introduced.
        const offset = clamp(this.stepOffset, -STEP_HEIGHT, STEP_HEIGHT);
        const j = this.stepVelocity + 20 * offset, decay = Math.exp(-20 * h);
        this.stepOffset = (offset + j * h) * decay;
        this.stepVelocity = (this.stepVelocity - 20 * j * h) * decay;
      }
      const travelled = Math.hypot(this.pos.x - x, this.pos.z - z);
      this.distance += travelled;
      if (this.onGround && !this.fly) this.bob += travelled * 2.1; // footsteps only, never camera motion
      if (magnitude < 1e-6 && this.vel.lengthSq() < 1e-6) this.vel.set(0, 0, 0);
    }
    this.applyCamera();
  }

  applyCamera() {
    this.smoothY = this.pos.y + this.eye + (this.stepOffset || 0);
    this.camera.position.set(this.pos.x, this.smoothY, this.pos.z);
    // Stable horizon and fixed FOV while walking, sprinting, jumping or stopping.
    this.camera.rotation.set(this.pitch, this.yaw, 0, 'YXZ');
  }
}
