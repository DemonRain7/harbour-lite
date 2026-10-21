import * as THREE from 'three';
import { elainaLegMask, validHosiery } from './model-hosiery-data.js';

export function prepareAvatarHosiery(mesh, id, source) {
  if (id !== 'main-elaina' || mesh.userData.townHosiery) return;
  const body = mesh.material.find(material => material.name === '身体');
  if (!body?.isMMDToonMaterial || !body.vertexShader.includes('#include <begin_vertex>')
    || !body.fragmentShader.includes('#include <map_fragment>')
    || !body.fragmentShader.includes('#include <lights_phong_fragment>')) return;
  const mask = elainaLegMask(source);
  if (!mask) return;
  mesh.geometry.setAttribute('townHosiery', new THREE.Uint8BufferAttribute(mask, 1, true));
  const enabled = { value: 0 };
  body.uniforms.uTownWhiteHosiery = enabled;
  body.vertexShader = 'attribute float townHosiery;\nvarying float vTownHosiery;\n' + body.vertexShader;
  body.vertexShader = body.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nvTownHosiery = townHosiery;');
  body.fragmentShader = 'uniform float uTownWhiteHosiery;\nvarying float vTownHosiery;\n' + body.fragmentShader;
  body.fragmentShader = body.fragmentShader.replace('#include <map_fragment>', `#include <map_fragment>
    float townStocking = clamp(vTownHosiery * uTownWhiteHosiery, 0.0, 1.0);
    float townSkinShade = clamp(dot(diffuseColor.rgb, vec3(0.2126, 0.7152, 0.0722)), 0.0, 1.0);
    vec3 townWhiteCloth = vec3(0.82, 0.84, 0.88) * (0.87 + 0.13 * townSkinShade);
    diffuseColor.rgb = mix(diffuseColor.rgb, townWhiteCloth, townStocking * 0.96);`);
  body.fragmentShader = body.fragmentShader.replace('#include <lights_phong_fragment>', `#include <lights_phong_fragment>
    material.specularColor = mix(material.specularColor, vec3(0.10), townStocking);
    material.specularShininess = mix(material.specularShininess, 32.0, townStocking);`);
  body.needsUpdate = true;
  // No second shell/transparent surface: retain the model's alpha, depth, shadows
  // and room lighting. A single normalized byte per vertex; no extra texture or draw.
  mesh.userData.townHosiery = { value: 'original', enabled, maskBytes: mask.byteLength };
}

export function setAvatarHosiery(mesh, value) {
  if (!validHosiery(value)) throw new Error('不支持的丝袜款式');
  const appearance = mesh.userData.townHosiery;
  if (!appearance) throw new Error('此模型尚未适配丝袜材质');
  appearance.value = value; appearance.enabled.value = value === 'white' ? 1 : 0;
}
