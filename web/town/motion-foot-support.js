// A tiny sole footprint, calibrated once from the original rig's weighted shoe
// vertices. Query the existing walkable-height field, never raycast the city.
export function createFootSupport(mesh, side, rest, groundHeight) {
  if (!groundHeight) return null;
  const scale = mesh.scale.x, { position, skinIndex, skinWeight } = mesh.geometry.attributes;
  const footBones = new Set(mesh.skeleton.bones.flatMap((bone, index) =>
    bone.name.startsWith(side) && /足首|足先|つま先/.test(bone.name) ? [index] : []));
  const vertices = [], components = ['X', 'Y', 'Z', 'W'];
  let bottom = Infinity;
  if (position && skinIndex && skinWeight) for (let i = 0; i < position.count; i++) {
    let weight = 0;
    for (const axis of components) if (footBones.has(skinIndex['get' + axis](i))) weight += skinWeight['get' + axis](i);
    if (weight < .5) continue;
    const x = position.getX(i) * scale - rest.x, y = position.getY(i) * scale - rest.y, z = position.getZ(i) * scale - rest.z;
    vertices.push({ x, y, z }); bottom = Math.min(bottom, y);
  }
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const v of vertices) if (v.y < bottom + .035) {
    x0 = Math.min(x0, v.x); x1 = Math.max(x1, v.x); z0 = Math.min(z0, v.z); z1 = Math.max(z1, v.z);
  }
  if (!Number.isFinite(x0)) {
    x0 = -.055; x1 = .055; z0 = -.07; z1 = .16; bottom = -rest.y - mesh.position.y;
  }
  const samples = [];
  for (const x of [x0, (x0 + x1) / 2, x1]) for (const z of [z0, (z0 + z1) / 2, z1]) samples.push({ x, z });
  return (position, yaw, pitch, ground) => {
    const s = Math.sin(yaw), c = Math.cos(yaw), sp = Math.sin(pitch), cp = Math.cos(pitch);
    let height = -Infinity;
    for (const point of samples) {
      const y = bottom * cp - point.z * sp, z = bottom * sp + point.z * cp;
      const floor = groundHeight(position.x + point.x * c + z * s, position.z + z * c - point.x * s, ground);
      height = Math.max(height, (Number.isFinite(floor) ? floor : ground) - y + .003);
    }
    return height;
  };
}
