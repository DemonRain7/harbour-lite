const fs = require('node:fs');
const path = require('node:path');

// desktop/folia/renderer-health.js
// Reuse the existing one-second playback heartbeat; no extra polling or command replay.
class FoliaRendererHealth {
  constructor(dataDir, now = Date.now) {
    this.dataDir = dataDir;
    this.now = now;
    this.phase = 'closed';
    this.lastSeenAt = 0;
    this.lastFailure = null;
  }
  start() { this.phase = 'starting'; this.lastSeenAt = 0; }
  ready() { this.phase = 'ready'; this.lastSeenAt = this.now(); }
  seen() { if (this.phase !== 'failed') this.ready(); }
  close() { this.phase = 'closed'; this.lastSeenAt = 0; }
  report(reason, mode, fatal = false) {
    if (!['react-root', 'visualizer', 'visualizer-cleanup', 'crashed', 'oom', 'killed', 'abnormal-exit', 'unresponsive'].includes(reason)) return;
    this.lastFailure = { reason, at: new Date(this.now()).toISOString(),
      ...(typeof mode === 'string' && /^[\w:-]{1,80}$/.test(mode) ? { mode } : {}) };
    if (fatal) this.phase = 'failed';
    // One bounded local diagnostic, never song names, paths, request bodies or account data.
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      fs.writeFileSync(path.join(this.dataDir, 'renderer-health.json'), JSON.stringify(this.lastFailure));
    } catch (error) { console.warn('[folia] could not save renderer health:', error.code); }
  }
  snapshot() {
    const phase = this.phase === 'ready' && this.now() - this.lastSeenAt > 15_000 ? 'unresponsive' : this.phase;
    return { phase, lastSeenAt: this.lastSeenAt || null, lastFailure: this.lastFailure };
  }
}

module.exports = { FoliaRendererHealth };
