// Only the output of the static batcher is immutable. Other station groups can
// contain doors/clocks even when they were added under staticRoot.
export function freezeBatchedTransforms(root) {
  root.updateMatrixWorld(true);
  let count = 0;
  root.traverse(object => {
    if (object.name !== 'static-batched') return;
    object.traverse(part => { part.matrixAutoUpdate = false; part.matrixWorldAutoUpdate = false; count++; });
  });
  return count;
}

// Keep shadow resolution/materials; amortize the costly extra scene pass while
// standing still. A fast camera move invalidates immediately, not next tick.
export function createShadowSchedule(hz) {
  let last = -Infinity, x = 0, z = 0, yaw = 0, pitch = 0;
  return (time, camera, force = false) => {
    const dyaw = Math.atan2(Math.sin(camera.rotation.y - yaw), Math.cos(camera.rotation.y - yaw));
    if (!force && time - last < 1 / hz - 1e-6 && Math.hypot(camera.position.x - x, camera.position.z - z) < .18
      && Math.abs(dyaw) < .07 && Math.abs(camera.rotation.x - pitch) < .07) return false;
    last = time; x = camera.position.x; z = camera.position.z; yaw = camera.rotation.y; pitch = camera.rotation.x;
    return true;
  };
}
