// Quality and refresh rate are independent. A 120 Hz choice must not silently
// lower resolution, textures or shadows; RAF/display/GPU still bound actual FPS.
export const QUALITY_NAMES = Object.freeze(['low', 'medium', 'high', 'ultra']);
export const FRAME_RATES = Object.freeze([30, 60, 120]);
export const frameRateFor = (value, fallback = 60) => FRAME_RATES.includes(Number(value)) ? Number(value) : fallback;
export function readGraphicsSettings(storage) {
  let qualityName = 'medium', savedFps;
  try {
    const saved = storage?.getItem('harbour-town-quality');
    if (QUALITY_NAMES.includes(saved)) qualityName = saved;
    savedFps = storage?.getItem('harbour-town-fps');
  } catch { /* storage disabled: usable defaults */ }
  return { qualityName, frameRate: frameRateFor(savedFps, ['high', 'ultra'].includes(qualityName) ? 60 : 30) };
}
export function resolveQuality(name, dpr = 1, capabilities = {}) {
  const nameSafe = QUALITY_NAMES.includes(name) ? name : 'medium';
  const native = Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
  const presets = {
    low: { pixelRatio: .75, msaa: 0, shadowMap: 1024, shadowSize: 45, petals: .3, anisotropy: 2 },
    medium: { pixelRatio: 1, msaa: 2, shadowMap: 2048, shadowSize: 60, petals: .6, anisotropy: 4 },
    high: { pixelRatio: Math.min(native, 1.5), msaa: 4, shadowMap: 2048, shadowSize: 65, petals: 1, anisotropy: 8 },
    ultra: { pixelRatio: native, msaa: 4, shadowMap: 4096, shadowSize: 75, petals: 1, anisotropy: 16 },
  };
  const quality = { name: nameSafe, ...presets[nameSafe], sourceTextures: nameSafe === 'ultra' };
  quality.msaa = Math.min(quality.msaa, capabilities.maxSamples ?? 4);
  quality.shadowMap = Math.min(quality.shadowMap, capabilities.maxTextureSize ?? 4096);
  quality.anisotropy = Math.min(quality.anisotropy, capabilities.getMaxAnisotropy?.() ?? 1);
  return quality;
}
export function createFrameGate(initialFps) {
  let fps = frameRateFor(initialFps), next = null, last = null;
  return {
    setRate(value) { fps = frameRateFor(value, fps); this.reset(); return fps; },
    reset() { next = last = null; },
    tick(now) {
      if (next !== null && now < next - .25) return null;
      const interval = 1000 / fps;
      const dt = last === null ? 1 / fps : Math.min(.05, Math.max(0, (now - last) / 1000));
      next = next === null ? now + interval : next + interval * Math.max(1, Math.floor((now - next + .25) / interval) + 1);
      last = now;
      return dt;
    },
  };
}
