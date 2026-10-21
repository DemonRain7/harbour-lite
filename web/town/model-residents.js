import * as THREE from 'three';
import { MODEL_ROOT, modelFile, prepareMmdData, validateCatalogue, selectModelTextures } from './model-data.js';
import { bindModelPrepass, configureModelMaterial } from './model-rendering.js';
import { createAvatarMotion } from './resident-motion.js';
import { HOSIERY_OPTIONS, validHosiery } from './model-hosiery-data.js';
import { prepareAvatarHosiery, setAvatarHosiery } from './model-hosiery.js';

function authHeaders() {
  try { const token = localStorage.getItem('harbour-token'); return token ? { 'x-harbour-token': token } : {}; }
  catch { return {}; }
}
async function get(url, signal) {
  const response = await fetch(url, { headers: authHeaders(), signal, cache: 'no-cache' });
  if (!response.ok) throw new Error(response.status === 401 ? '请先登录 Harbour，再加载本机模型' : `模型资源暂不可用（${response.status}）`);
  return response;
}
export async function residentCatalogue(signal) {
  const response = await get(`${MODEL_ROOT}manifest.json`, AbortSignal.any([signal, AbortSignal.timeout(5000)]));
  return validateCatalogue(await response.json());
}
async function verifiedFile(id, file, signal) {
  const response = await get(modelFile(id, file.file || file.pmx), signal);
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength !== file.bytes) throw new Error('模型资源不完整，请重新导入');
  const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', buffer))].map(b => b.toString(16).padStart(2, '0')).join('');
  if (hash !== file.sha256) throw new Error('模型资源校验失败，请重新导入');
  return buffer;
}
function materialsOf(mesh) { return [mesh.material].flat().filter(Boolean); }
export function disposeAvatar(mesh) {
  mesh.removeFromParent();
  const textures = new Set();
  for (const material of materialsOf(mesh)) {
    for (const value of Object.values(material)) if (value?.isTexture) textures.add(value);
    for (const uniform of Object.values(material.uniforms || {})) if (uniform?.value?.isTexture) textures.add(uniform.value);
    material.dispose();
  }
  textures.forEach(texture => texture.dispose()); mesh.geometry.dispose(); mesh.skeleton?.dispose();
}

export async function loadAvatar(id, variant, signal, textureOptions = {}) {
  signal = AbortSignal.any([signal, AbortSignal.timeout(60000)]);
  const [{ MMDLoader }, { MMDParser }] = await Promise.all([
    import('./lib/three/examples/jsm/loaders/MMDLoader.js'),
    import('./lib/three/examples/jsm/libs/mmdparser.module.js'),
  ]);
  const buffer = await verifiedFile(id, variant, signal);
  signal.throwIfAborted();
  const source = new MMDParser.Parser().parsePmx(buffer, true);
  const urls = new Map();
  const selected = selectModelTextures(variant, textureOptions);
  let mesh;
  try {
    // Deliberately sequential: bounded memory/network on laptops. No token in image URLs.
    for (const texture of selected.textures) {
      if (urls.has(texture.file)) continue;
      const bytes = await verifiedFile(id, texture, signal);
      const suffix = texture.file.split('.').at(-1).toLowerCase();
      urls.set(texture.file, URL.createObjectURL(new Blob([bytes], { type: ({ bmp: 'image/bmp', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' })[suffix] })));
    }
    const data = prepareMmdData(source, selected.textures.map(t => urls.get(t.file)));
    let complete, fail;
    const loaded = new Promise((resolve, reject) => { complete = resolve; fail = reject; });
    const manager = new THREE.LoadingManager(complete, undefined, () => fail(new Error('模型贴图解码失败')));
    // Only verified local blobs and the vendor's built-in toon swatches may be loaded.
    const allowed = new Set(urls.values());
    manager.setURLModifier(url => {
      if (allowed.has(url) || url.startsWith('data:image/png;base64,')) return url;
      throw new Error('模型试图加载未登记的外部资源');
    });
    const abort = () => fail(signal.reason || new DOMException('已离开小镇', 'AbortError'));
    signal.addEventListener('abort', abort, { once: true });
    try {
      manager.itemStart('resident-build');
      // Pinned r170 builder; parsing separately lets us bound dense morph arrays first.
      mesh = new MMDLoader(manager).meshBuilder.build(data, '');
      manager.itemEnd('resident-build');
      await loaded;
      signal.throwIfAborted();
    } finally { signal.removeEventListener('abort', abort); }
    const hidden = new Set();
    materialsOf(mesh).forEach((material, index) => {
      if (material.opacity <= .001) { material.visible = false; hidden.add(index); }
      configureModelMaterial(material);
      if (material.map) { material.map.anisotropy = textureOptions.anisotropy || 1; material.map.needsUpdate = true; }
    });
    mesh.geometry.groups = mesh.geometry.groups.filter(group => !hidden.has(group.materialIndex));
    prepareAvatarHosiery(mesh, id, source);
    bindModelPrepass(mesh);
    mesh.castShadow = true; mesh.receiveShadow = true;
    mesh.geometry.computeBoundingBox();
    // Size by the head bone, not the hat/ribbons. An outfit swap keeps body height stable.
    const head = source.bones.find(b => b.name === '頭');
    const scale = head ? 1.48 / head.position[1] : 1.7 / mesh.geometry.boundingBox.max.y;
    mesh.scale.setScalar(scale); mesh.position.y = -mesh.geometry.boundingBox.min.y * scale;
    mesh.userData.townModel = { variant: variant.id, vertices: data.metadata.vertexCount,
      triangles: mesh.geometry.groups.reduce((n, g) => n + g.count / 3, 0),
      bones: data.metadata.boneCount, activeMorphs: data.metadata.morphCount,
      sourceMorphs: source.metadata.morphCount, physics: false,
      textures: { mode: textureOptions.sourceTextures ? 'source' : 'optimized', fallback: selected.fallback,
        maxSide: Math.max(0, ...selected.textures.map(t => Math.max(t.width || 0, t.height || 0))) } };
    return mesh;
  } catch (error) { if (mesh) disposeAvatar(mesh); throw error; }
  finally { urls.forEach(url => URL.revokeObjectURL(url)); }
}

export async function buildModelResident(ctx, activity, resident, entry, { signal, onModelState, motionLibrary }) {
  let selected = entry.defaultVariant;
  try { const saved = localStorage.getItem(`harbour-town-outfit:${resident.id}`); if (entry.variants.some(v => v.id === saved)) selected = saved; } catch { /* defaults */ }
  const textureOptions = { sourceTextures: ctx.quality.sourceTextures, anisotropy: ctx.quality.anisotropy, maxTextureSize: ctx.renderer.capabilities.maxTextureSize };
  let current = await loadAvatar(resident.id, entry.variants.find(v => v.id === selected), signal, textureOptions);
  let hosiery = 'white';
  try { const saved = localStorage.getItem(`harbour-town-hosiery:${resident.id}`); if (validHosiery(saved)) hosiery = saved; } catch { /* defaults */ }
  if (current.userData.townHosiery) setAvatarHosiery(current, hosiery);
  const ground = resident.ground;
  const group = new THREE.Group(); group.name = resident.id; group.position.set(resident.x, ground, resident.z);
  group.add(current); ctx.add(group);
  let update = createAvatarMotion(current, ctx, resident, motionLibrary), disposed = false, switching = false;
  ctx.onUpdate((dt, t) => {
    if (disposed) return;
    group.position.set(resident.x, resident.ground, resident.z); group.rotation.y = resident.motion.yaw;
    update(dt, t);
  });
  function state() { return { id: resident.id, type: 'mmd', credit: entry.credit, variant: current.userData.townModel.variant,
    variants: entry.variants.map(v => ({ id: v.id, name: v.name })), ...current.userData.townModel,
    ...(current.userData.townHosiery ? { hosiery: current.userData.townHosiery.value, hosieryOptions: HOSIERY_OPTIONS } : {}),
    behavior: resident.behavior.snapshot() }; }
  onModelState?.(state());
  return Object.assign(resident, { group, state,
    async setVariant(id) {
      const variant = entry.variants.find(v => v.id === id);
      if (!variant) throw new Error('此模型没有这套服装');
      if (disposed || switching || current.userData.townModel.variant === id) return;
      switching = true;
      try {
        const next = await loadAvatar(resident.id, variant, signal, textureOptions);
        if (disposed || signal.aborted) { disposeAvatar(next); return; }
        if (next.userData.townHosiery) setAvatarHosiery(next, hosiery);
        ctx.prepareResident?.(next); group.add(next);
        const old = current; current = next; update = createAvatarMotion(next, ctx, resident, motionLibrary);
        update(0, ctx.time || 0); disposeAvatar(old);
        try { localStorage.setItem(`harbour-town-outfit:${resident.id}`, id); } catch { /* still usable */ }
        onModelState?.(state());
      } finally { switching = false; }
    },
    setHosiery(value) {
      if (disposed) throw new Error('此模型已卸载');
      setAvatarHosiery(current, value); hosiery = value;
      try { localStorage.setItem(`harbour-town-hosiery:${resident.id}`, value); } catch { /* still usable */ }
      onModelState?.(state());
    },
    dispose() { if (disposed) return; disposed = true; disposeAvatar(current); group.removeFromParent(); },
  });
}
