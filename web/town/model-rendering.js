import * as THREE from 'three';

export function configureModelMaterial(material) {
  // PMX diffuse alpha is only one factor. The r170 loader detects texture
  // transparency asynchronously and records it on map, not on the material.
  // Highlight layers can have opacity=1 while their texture is almost clear.
  const blended = material.opacity < 1 || material.map?.transparent === true;
  material.blending = THREE.NormalBlending;
  material.transparent = blended;
  material.depthWrite = !blended;
  material.alphaTest = blended ? 1 / 255 : .45;
  // MMDToonMaterial is a ShaderMaterial: Three does NOT refresh its common
  // uniforms. Setting alphaTest alone enables the define but leaves cutoff=0.
  if (material.uniforms?.alphaTest) material.uniforms.alphaTest.value = material.alphaTest;
  material.needsUpdate = true;
}

// Extend the imported station's prepass without changing its original files.
// Avatars must write depth here: excluding them lets background outlines show
// through their faces. The same skinning, morphs and cut-out alpha are needed.
export function extendModelPrepass(material) {
  material.vertexShader = material.vertexShader
    .replace('#include <common>', '#include <common>\n#include <morphtarget_pars_vertex>\nvarying vec2 vTownUv;')
    .replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\n#include <morphinstance_vertex>\n#include <morphnormal_vertex>')
    .replace('#include <begin_vertex>', '#include <begin_vertex>\n#include <morphtarget_vertex>\nvTownUv = uv;');
  material.fragmentShader = material.fragmentShader.replace('void main(){', `
    varying vec2 vTownUv;
    uniform sampler2D uTownMap;
    uniform mat3 uTownMapTransform;
    uniform float uTownUseMap, uTownOpacity, uTownCutoff;
    void main(){
      float alpha = uTownOpacity;
      if (uTownUseMap > .5) alpha *= texture2D(uTownMap, (uTownMapTransform * vec3(vTownUv, 1.)).xy).a;
      if (alpha < uTownCutoff) discard;`);
  Object.assign(material.uniforms, {
    uTownMap: { value: null }, uTownMapTransform: { value: new THREE.Matrix3() },
    uTownUseMap: { value: 0 }, uTownOpacity: { value: 1 }, uTownCutoff: { value: 0 },
  });
  material.needsUpdate = true;
}

export function bindModelPrepass(mesh) {
  mesh.onBeforeRender = (_renderer, _scene, _camera, _geometry, material, group) => {
    if (!material.uniforms?.uTownUseMap) return;
    const source = Array.isArray(mesh.material) ? mesh.material[group.materialIndex] : mesh.material;
    const u = material.uniforms;
    u.uTownMap.value = source.map;
    u.uTownUseMap.value = source.map ? 1 : 0;
    if (source.map) u.uTownMapTransform.value.copy(source.map.matrix);
    u.uTownOpacity.value = source.opacity;
    u.uTownCutoff.value = Math.max(.45, source.alphaTest);
    material.uniformsNeedUpdate = true;
  };
  mesh.onAfterRender = (_renderer, _scene, _camera, _geometry, material) => {
    if (!material.uniforms?.uTownUseMap) return;
    material.uniforms.uTownMap.value = null;
    material.uniforms.uTownUseMap.value = 0;
    material.uniforms.uTownOpacity.value = 1;
    material.uniforms.uTownCutoff.value = 0;
    material.uniformsNeedUpdate = true;
  };
}
