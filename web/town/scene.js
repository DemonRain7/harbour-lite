import * as THREE from 'three';
import { TownPlayer } from './player.js';
import { buildResidents } from './residents.js';
import { separateFromResidents } from './resident-behavior.js';
import { createShadowSchedule } from './scene-performance.js';
import { mapFor } from './maps.js';
import { selectNearbyResident } from './resident-interaction.js';
import { resolveQuality, frameRateFor, createFrameGate } from './graphics-settings.js';

export async function createTownScene({ canvas, mapId = 'station', qualityName, frameRate, activity, progress, onNear, onInteract, onSocial, onError, onModelState, onLookState, signal, visibility: activityVisibility }) {
  await activityVisibility.whenVisible();
  const map = mapFor(mapId);
  const { createMap } = await (map.id === 'suibo' ? import('./maps/suibo.js') : import('./maps/station.js'));
  await activityVisibility.whenVisible();
  signal.throwIfAborted();
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', stencil: false });
  const quality = resolveQuality(qualityName, devicePixelRatio, renderer.capabilities);
  let fps = frameRateFor(frameRate, ['high', 'ultra'].includes(quality.name) ? 60 : 30);
  const frameGate = createFrameGate(fps);
  // The final canvas must match the post-processing buffers too. Previously
  // Station rendered high-res intermediates back into a 1x CSS-pixel canvas.
  renderer.setPixelRatio(quality.pixelRatio);
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace; renderer.toneMapping = THREE.NoToneMapping;
  renderer.info.autoReset = false;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(58, 1, .1, 2500);
  let environment;
  try { environment = createMap({ scene, camera, renderer, quality }); }
  catch (error) { renderer.dispose(); renderer.forceContextLoss(); throw error; }
  const { ctx, audio, light } = environment;
  ctx.townBounds = environment.bounds;
  let updateShadow = createShadowSchedule(fps / 2);
  light.shadow.autoUpdate = false;
  const player = new TownPlayer(camera, canvas, ctx.physics, environment.bounds, signal, onLookState); ctx.playerObj = player; ctx.frameId = 0;
  let destroyed = false, raf = 0, simT = 14, paused = false, talking = false, closest = null, nearId = '';
  let frames = 0, residents = [];
  let focused = null;
  let lastHud = 0, frameCpuMs = 0, frozenTransforms = 0, shadowUpdates = 0;
  let fpsSampleStart = null, fpsSampleFrames = 0, actualFps = 0;
  // A native view can be visible in the Dashboard while its owning shell is
  // hidden. Use host visibility there; browser tabs still use Page Visibility.
  const hidden = activityVisibility.hidden;
  let resizePending = true, renderWidth = 0, renderHeight = 0, resizeCount = 0, ready = false, audioObserved = false;
  const lookDirection = new THREE.Vector3();
  function resize() {
    if (destroyed) return;
    const w = innerWidth, h = innerHeight;
    if (hidden() || paused || w < 1 || h < 1) return;
    resizePending = false;
    const requested = resolveQuality(quality.name, devicePixelRatio, renderer.capabilities).pixelRatio;
    // Native resolution unless the physical GPU cannot allocate that size.
    const ratio = Math.min(requested, renderer.capabilities.maxTextureSize / Math.max(w, h));
    if (w === renderWidth && h === renderHeight && ratio === quality.pixelRatio) return;
    quality.pixelRatio = ratio;
    renderer.setPixelRatio(ratio);
    renderer.setSize(w, h); camera.aspect = w / h; camera.updateProjectionMatrix();
    environment.resize(w, h);
    renderWidth = w; renderHeight = h; resizeCount++;
  }
  function markResize() { resizePending = true; }
  function syncAudio() {
    if (hidden() || paused || audio.muted) {
      audio.pauseMedia?.();
      if (audio.context?.state === 'running') void audio.context.suspend().catch(() => {});
    } else {
      audio.resumeMedia?.();
      if (audio.context?.state === 'suspended') void audio.context.resume().catch(() => {});
    }
  }
  function clearMovement() { player.resetInput(); }
  function focus(id) {
    const resident = residents.find(r => r.id === id); if (!resident) return false;
    let arrived = false;
    player.releaseLook(); clearMovement(); player.fly = false;
    const candidates = [2.2, 1.65, 1.35].flatMap(radius => Array.from({ length: 16 }, (_, i) => ({ radius, yaw: i * Math.PI / 8 })));
    for (const { yaw, radius } of candidates) {
      const x = resident.x + Math.sin(yaw) * radius, z = resident.z + Math.cos(yaw) * radius;
      const area = environment.bounds;
      if (area && (x < area.x0 || x > area.x1 || z < area.z0 || z > area.z1)) continue;
      const ground = ctx.physics.groundHeight(x, z, resident.ground), probe = { x, z };
      ctx.physics.resolve(probe, player.radius, ground, player.height);
      if (Math.hypot(probe.x - x, probe.z - z) > .01 || Math.abs(ground - resident.ground) > .4) continue;
      if (residents.some(other => other.id !== id && Math.hypot(x - other.x, z - other.z) < .9)) continue;
      let clearSight = true;
      for (let i = 1; i < 12; i++) {
        const sx = resident.x + (x - resident.x) * i / 12, sz = resident.z + (z - resident.z) * i / 12;
        probe.x = sx; probe.z = sz; ctx.physics.resolve(probe, .05, ground + .9, .5);
        if (Math.hypot(probe.x - sx, probe.z - sz) > .01) { clearSight = false; break; }
      }
      if (!clearSight) continue;
      player.setPose(x, z, yaw * 180 / Math.PI, -8, ground + player.eye); player.fly = false;
      focused = { id, x, z, yaw: player.yaw, pitch: player.pitch };
      activity.greetings ??= Object.create(null);
      activity.greetings[id] = (activity.greetings[id] || 0) + 1;
      closest = resident; nearId = resident.id; onNear(resident); arrived = true; break;
    }
    canvas.focus({ preventScroll: true });
    return arrived;
  }
  function freeze(value) { talking = value; player.enabled = !value && !paused && !hidden(); if (value) player.releaseLook(); clearMovement(); }
  function schedule() { if (ready && !destroyed && !paused && !hidden() && !raf) raf = requestAnimationFrame(frame); }
  function visibility() {
    cancelAnimationFrame(raf); raf = 0; frameGate.reset(); fpsSampleStart = null; fpsSampleFrames = 0; actualFps = 0; player.releaseLook(); clearMovement();
    player.enabled = !paused && !talking && !hidden();
    syncAudio();
    if (ready && hidden()) environment.suspendGraphics?.();
    if (!hidden() && !paused) { markResize(); schedule(); }
  }
  function frame(now) {
    raf = 0;
    if (destroyed || paused || hidden()) return;
    const dt = frameGate.tick(now);
    if (dt === null) { schedule(); return; }
    simT += dt;
    try {
      const startCpu = performance.now(); ctx.frameId++; renderer.info.reset();
      if (resizePending) resize();
      if (!talking) player.update(dt);
      ctx.physics.refreshDynamic(); ctx.time = simT; ctx.shared.uTime.value = simT;
      ctx.shared.uGust.value = .5 + .28 * Math.sin(simT * .37);
      ctx.player.position.copy(player.pos);
      activity.social?.tick(dt);
      for (const update of ctx._updates) update(dt, simT);
      if (separateFromResidents(player.pos, residents, player.radius)) {
        ctx.physics.resolve(player.pos, player.radius, player.pos.y, player.height);
        player.applyCamera(0); ctx.player.position.copy(player.pos);
      }
      environment.update(dt, simT);
      light.shadow.needsUpdate = updateShadow(simT, camera, frames === 0 || !light.shadow.map);
      if (light.shadow.needsUpdate) shadowUpdates++;
      // Depth/colour/shadow passes share a single world-matrix preparation.
      scene.updateMatrixWorld(); environment.render(simT, dt); frames++;
      if (fpsSampleStart === null) { fpsSampleStart = now; fpsSampleFrames = 0; }
      else {
        fpsSampleFrames++;
        if (now - fpsSampleStart >= 1000) {
          actualFps = Math.round(fpsSampleFrames * 1000 / (now - fpsSampleStart)); fpsSampleStart = now; fpsSampleFrames = 0;
        }
      }
      frameCpuMs += (performance.now() - startCpu - frameCpuMs) * .1;
      // Resolve nearby interaction at HUD frequency, not once per render pass.
      // Prefer the resident being looked at, not someone slightly closer behind us.
      const updateHud = simT - lastHud >= .1;
      let nearest = closest;
      if (updateHud) {
        camera.getWorldDirection(lookDirection);
        if (focused && (Math.hypot(player.pos.x - focused.x, player.pos.z - focused.z) > .2
          || Math.abs(player.yaw - focused.yaw) > .2 || Math.abs(player.pitch - focused.pitch) > .2)) focused = null;
        nearest = selectNearbyResident(residents, player.pos, lookDirection, focused?.id);
        if (focused && nearest?.id !== focused.id) focused = null;
      }
      if (updateHud) { lastHud = simT; onSocial?.(); }
      closest = nearest;
      const id = nearest?.id || '';
      if (id !== nearId) { nearId = id; onNear(nearest); }
    } catch (error) { paused = true; visibility(); onError(error); }
    schedule();
  }
  // The imported walker listens on window. Text/control key events must never reach it.
  function keys(event) {
    if (event.target !== canvas && event.target !== document.body) { clearMovement(); event.stopImmediatePropagation(); return; }
    if (event.code === 'KeyF') { event.preventDefault(); event.stopImmediatePropagation(); return; }
    if (event.code === 'KeyE' && !talking && closest && !event.repeat) {
      event.preventDefault(); event.stopImmediatePropagation(); onInteract(closest.id);
    }
  }
  document.addEventListener('keydown', keys, { signal });
  window.addEventListener('resize', markResize, { signal });
  // Moving to a monitor with another scale factor may keep the same CSS size.
  let dprMedia, dprChanged;
  function watchDpr() {
    dprMedia?.removeEventListener('change', dprChanged);
    dprMedia = matchMedia(`(resolution: ${devicePixelRatio}dppx)`);
    dprChanged = () => { markResize(); watchDpr(); };
    dprMedia.addEventListener('change', dprChanged, { once: true });
  }
  watchDpr();
  const unsubscribeVisibility = activityVisibility.subscribe(visibility);
  canvas.addEventListener('pointerdown', () => canvas.focus({ preventScroll: true }), { signal });
  function destroy() {
    if (destroyed) return; destroyed = true;
    unsubscribeVisibility();
    dprMedia?.removeEventListener('change', dprChanged);
    cancelAnimationFrame(raf); raf = 0; player.enabled = false; player.releaseLook(); clearMovement();
    audio.pauseMedia?.(); audio.muted = true; audio.disposeMedia?.(); void audio.context?.close().catch(() => {});
    residents.forEach(resident => resident.dispose?.());
    environment.dispose?.();
    const textures = new Set();
    scene.traverse(object => {
      // Instance transforms/colors are owned by the mesh, not its geometry.
      if (object.isInstancedMesh) object.dispose();
      object.geometry?.dispose(); for (const m of [object.material, object.customDepthMaterial].flat()) {
      if (!m) continue;
      for (const value of Object.values(m)) if (value?.isTexture) textures.add(value);
      for (const uniform of Object.values(m.uniforms || {})) if (uniform.value?.isTexture) textures.add(uniform.value);
      m.dispose?.();
    } });
    textures.forEach(texture => texture.dispose()); light.shadow.map?.dispose();
    renderer.dispose(); renderer.forceContextLoss();
  }
  signal.addEventListener('abort', destroy, { once: true });
  try {
    resize();
    await environment.build(progress, signal, activityVisibility.whenVisible);
    await activityVisibility.whenVisible();
    progress(16, '载入本机角色模型与贴图…');
    residents = await buildResidents(ctx, activity, { signal, onModelState, definitions: map.residents, whenVisible: activityVisibility.whenVisible });
    await activityVisibility.whenVisible();
    progress(16, '整理光影…');
    await new Promise(resolve => setTimeout(resolve, 0));
    await activityVisibility.whenVisible();
    frozenTransforms = environment.finish();
    scene.updateMatrixWorld(true); scene.matrixWorldAutoUpdate = false;
    const spawn = environment.spawn;
    if (Number.isFinite(spawn.groundHint)) {
      const ground = ctx.physics.groundHeight(spawn.x, spawn.z, spawn.groundHint);
      player.setPose(spawn.x, spawn.z, spawn.yaw, spawn.pitch, ground + player.eye); player.fly = false;
    } else player.setPose(spawn.x, spawn.z, spawn.yaw, spawn.pitch);
    player.enabled = true;
    progress(17, '她们已经在这里。');
    await environment.compile();
    if (signal.aborted) throw new DOMException('已离开小镇', 'AbortError');
    ready = true; visibility();
  } catch (error) { destroy(); throw error; }
  return {
    focus, freeze, destroy, cycleTime: environment.cycleTime,
    companionStatus(id) { return residents.find(r => r.id === id)?.motion; },
    residentPlace(id) {
      const r = residents.find(r => r.id === id), b = r?.patrol;
      return r && b && r.x >= b.x0 && r.x <= b.x1 && r.z >= b.z0 && r.z <= b.z1
        && Math.abs(r.ground - (r.groundHint ?? r.ground)) < .8 ? r.place : map.name;
    },
    canInteract(id) {
      const r = residents.find(r => r.id === id);
      return !!r && !destroyed && !paused && !hidden() && Math.hypot(r.x - player.pos.x, r.z - player.pos.z) < 3.6
        && Math.abs(r.ground - player.pos.y) < 1.5 && r.canSee(player.pos);
    },
    restoreResidents(poses) {
      if (!Array.isArray(poses)) return false;
      const b = environment.bounds, candidates = residents.map(r => ({ r, p: poses.find(pose => pose?.id === r.id)?.behavior || r.motion }));
      // Validate the final arrangement together; sequential validation against
      // old spawn positions would reject two residents whose positions swapped.
      for (const { r, p } of candidates) {
        if (!r.behavior.validPose(p) || p.x < b.x0 || p.x > b.x1 || p.z < b.z0 || p.z > b.z1) return false;
        if (Math.abs(p.ground - player.pos.y) < 1.7 && Math.hypot(p.x - player.pos.x, p.z - player.pos.z) < .619) return false;
        if (candidates.some(other => other.r !== r && Math.abs(p.ground - other.p.ground) < 1.7 && Math.hypot(p.x - other.p.x, p.z - other.p.z) < .899)) return false;
      }
      for (const { r, p } of candidates) { r.behavior.restore(p); r.x = p.x; r.z = p.z; r.ground = r.motion.ground; }
      return true;
    },
    setFrameRate(value) { fps = frameGate.setRate(value); updateShadow = createShadowSchedule(fps / 2); fpsSampleStart = null; fpsSampleFrames = 0; actualFps = 0; return fps; },
    setHoverLook(value) { player.hoverLook = value; if (!value) player.releaseLook(); clearMovement(); },
    restorePose(pose) {
      if (!Array.isArray(pose?.position) || pose.position.length !== 3 || ![...pose.position, pose.yaw, pose.pitch].every(Number.isFinite)) return;
      clearMovement();
      const b = environment.bounds, x = THREE.MathUtils.clamp(pose.position[0], b.x0, b.x1), z = THREE.MathUtils.clamp(pose.position[2], b.z0, b.z1);
      const ground = ctx.physics.groundHeight(x, z, pose.position[1]);
      const probe = { x, z }; ctx.physics.resolve(probe, player.radius, ground, player.height);
      player.setPose(probe.x, probe.z, pose.yaw * 180 / Math.PI, THREE.MathUtils.clamp(pose.pitch * 180 / Math.PI, -85, 85), ground + player.eye);
      ctx.player.position.copy(player.pos);
      player.fly = false; environment.restoreTime?.(pose.timeOfDay);
    },
    async setOutfit(id, variant) {
      const resident = residents.find(r => r.id === id);
      if (!resident?.setVariant) throw new Error('此居民尚未载入可切换的模型');
      await resident.setVariant(variant);
    },
    setHosiery(id, value) {
      const resident = residents.find(r => r.id === id);
      if (!resident?.setHosiery) throw new Error('此居民尚未载入可切换的模型');
      resident.setHosiery(value);
    },
    pause(value) { paused = value; player.enabled = !paused && !talking; visibility(); },
    async sound(value) {
      if (value) {
        await audio.start();
        // Imported audio may also listen to Page Visibility. Reassert host
        // visibility if that listener resumes a still-background native view.
        if (audio.context && !audioObserved) { audioObserved = true; audio.context.addEventListener('statechange', syncAudio, { signal }); }
      }
      audio.muted = !value; syncAudio();
    },
    status: () => ({ mapId: map.id, ...environment.extraStatus?.(), frames, paused, hidden: hidden(), destroyed, position: player.pos.toArray(), yaw: player.yaw, pitch: player.pitch, hoverLook: player.hoverLook, pointerLocked: player.pointerLocked, cursorReleased: player.cursorReleased, residents: residents.length, quality: quality.name,
      movement: { speed: player.vel.length(), grounded: player.onGround, cameraPosition: camera.position.toArray(), roll: camera.rotation.z, fov: camera.fov },
      models: residents.map(r => r.state()), graphics: { geometries: renderer.info.memory.geometries, textures: renderer.info.memory.textures,
        drawCalls: renderer.info.render.calls, triangles: renderer.info.render.triangles, frameCpuMs: Math.round(frameCpuMs * 10) / 10, frozenTransforms, shadowUpdates, resizeCount, renderWidth, renderHeight,
        targetFps: fps, actualFps, pixelRatio: quality.pixelRatio, bufferWidth: canvas.width, bufferHeight: canvas.height, msaa: quality.msaa, shadowMap: quality.shadowMap, ...environment.renderSize?.() },
      audio: { state: audio.context?.state || 'not-started', muted: audio.muted, ...audio.mediaStatus?.() } }),
  };
}
