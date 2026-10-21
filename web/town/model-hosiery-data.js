// Runtime-only appearance. The licensed PMX and its textures stay byte-for-byte intact.
export const HOSIERY_OPTIONS = Object.freeze([
  Object.freeze({ id: 'white', name: '白丝 · 柔白' }),
  Object.freeze({ id: 'original', name: '原装 · 不加丝袜' }),
]);
export const validHosiery = value => HOSIERY_OPTIONS.some(option => option.id === value);

export function elainaLegMask(source) {
  const legBones = new Set();
  source.bones.forEach((bone, index) => {
    if (/^[左右](?:足|ひざ|足首|足先EX)D?$/.test(bone.name)) legBones.add(index);
  });
  const hip = source.bones.find(bone => bone.name === '左足')?.position[1];
  if (!legBones.size || !(hip > 0)) return null;
  const mask = new Uint8Array(source.vertices.length);
  let start = 0;
  for (const material of source.materials) {
    if (material.name === '身体') {
      for (let face = start; face < start + material.faceCount; face++) {
        for (const index of source.faces[face].indices) {
          const vertex = source.vertices[index];
          const weight = vertex.skinIndices.reduce((sum, bone, i) => sum + (legBones.has(bone) ? vertex.skinWeights[i] : 0), 0);
          if (weight < .05) continue;
          // Rest-pose leg membership follows the skinning through every animation.
          // The soft top edge is hidden under the existing skirt, not at the knee.
          const t = Math.max(0, Math.min(1, (vertex.position[1] - hip * .94) / (hip * .08)));
          mask[index] = Math.round(255 * (1 - t * t * (3 - 2 * t)));
        }
      }
    }
    start += material.faceCount;
  }
  return mask.some(value => value > 0) ? mask : null;
}
