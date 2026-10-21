// Pure, shared by runtime and tests. Never mutate a source PMX or its author data.
export const MODEL_ROOT = '/town/models/local/';
export const EXPRESSIONS = Object.freeze(['まばたき', 'にこり', '笑い', 'あ']);
export function rotationGrants(grants, boneCount) {
  // PMX permits an unbound (-1) parent. The supplied Elaina rig has two such
  // helper bones; these are not a rotation source and must not stop the scene.
  return grants.filter(g => g.affectRotation && !g.isLocal && Number.isInteger(g.index) && g.index >= 0 && g.index < boneCount
    && Number.isInteger(g.parentIndex) && g.parentIndex >= 0 && g.parentIndex < boneCount && Number.isFinite(g.ratio));
}
export function modelFile(id, file) {
  if (!['main-elaina', 'main-aemeath', 'chisa'].includes(id) || !/^[a-z0-9][a-z0-9.-]*\.(pmx|webp|bmp|png|jpg|jpeg|txt)$/i.test(file) || file.includes('..')) {
    throw new Error('Invalid local model asset');
  }
  return `${MODEL_ROOT}${id}/${file}`;
}
export function validateCatalogue(value) {
  if (value?.version !== 1 || value.localOnly !== true || !value.residents) throw new Error('不支持的本机模型目录');
  for (const [id, entry] of Object.entries(value.residents)) {
    if (!entry.variants?.length || entry.variants.length > 8 || !entry.variants.some(v => v.id === entry.defaultVariant)) throw new Error('模型版本配置不完整');
    const ids = new Set();
    for (const variant of entry.variants) {
      modelFile(id, variant.pmx);
      if (!/^[a-z0-9-]+$/.test(variant.id) || ids.has(variant.id) || !/^[a-f0-9]{64}$/.test(variant.sha256)
        || !Number.isSafeInteger(variant.bytes) || variant.bytes <= 0 || variant.bytes > 40 * 1024 * 1024
        || !Array.isArray(variant.textures) || variant.textures.length > 128) throw new Error('模型版本校验失败');
      ids.add(variant.id);
      for (const texture of variant.textures) {
        modelFile(id, texture.file);
        if (!/^[a-f0-9]{64}$/.test(texture.sha256) || !Number.isSafeInteger(texture.bytes) || texture.bytes <= 0 || texture.bytes > 16 * 1024 * 1024) throw new Error('模型贴图校验失败');
        if (texture.original) {
          const original = texture.original;
          modelFile(id, original.file);
          if (!/\.(webp|bmp|png|jpe?g)$/i.test(original.file) || !/^[a-f0-9]{64}$/.test(original.sha256)
            || !Number.isSafeInteger(original.bytes) || original.bytes <= 0 || original.bytes > 64 * 1024 * 1024
            || (original.width !== undefined && (!Number.isInteger(original.width) || original.width <= 0 || original.width > 8192))
            || (original.height !== undefined && (!Number.isInteger(original.height) || original.height <= 0 || original.height > 8192))) throw new Error('原尺寸贴图校验失败');
        }
      }
    }
  }
  return value.residents;
}
export function selectModelTextures(variant, { sourceTextures = false, maxTextureSize = Infinity } = {}) {
  let fallback = 0;
  const textures = variant.textures.map(texture => {
    const original = sourceTextures && texture.original;
    if (original && (original.width || 0) <= maxTextureSize && (original.height || 0) <= maxTextureSize) return original;
    if (sourceTextures && original !== texture) fallback++;
    return texture;
  });
  return { textures, fallback };
}
export function prepareMmdData(source, textureUrls) {
  if (source.metadata.format !== 'pmx' || source.metadata.vertexCount > 250000 || source.metadata.boneCount > 2000) throw new Error('模型规格超出小镇当前支持范围');
  if (source.textures.length !== textureUrls.length) throw new Error('模型贴图映射不一致');
  // The upstream builder allocates a dense position array for EVERY morph,
  // including unsupported material/UV morphs. Only four used vertex expressions
  // reach the GPU; original PMX retains every expression for later editing.
  const morphs = source.morphs.filter(m => m.type === 1 && EXPRESSIONS.includes(m.name));
  return { ...source, textures: textureUrls, morphs, rigidBodies: [], constraints: [],
    metadata: { ...source.metadata, morphCount: morphs.length, rigidBodyCount: 0, constraintCount: 0 } };
}
