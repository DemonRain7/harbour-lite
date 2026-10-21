import * as THREE from 'three';
import { createMap } from '/town/maps/suibo.js';
import { resolveQuality } from '/town/graphics-settings.js';
import { movingResident } from '/town/residents.js';
import { buildModelResident, residentCatalogue } from '/town/model-residents.js';
import { TownPlayer } from '/town/player.js';
import { TownSocial } from '/town/social-state.js';
import { MAPS } from '/town/maps.js';
import { loadMotionClips } from '/town/motion-clips.js';
const output = document.querySelector('output'), run = document.getElementById('run'), play = document.getElementById('play'), save = document.getElementById('save');
try {
  const signal = new AbortController().signal, canvas = document.querySelector('canvas');
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  const quality = resolveQuality('ultra', Math.min(devicePixelRatio, 1.5), renderer.capabilities);
  quality.shadowMap = 1024;
  renderer.setSize(innerWidth, innerHeight); renderer.shadowMap.enabled = true;
  const scene = new THREE.Scene(), camera = new THREE.PerspectiveCamera(42, innerWidth / innerHeight, .1, 2500);
  const env = createMap({ scene, camera, renderer, quality }), { ctx } = env;
  ctx.playerObj = new TownPlayer(camera, canvas, ctx.physics, env.bounds, signal);
  ctx.townBounds = env.bounds; ctx.frameId = 0;
  await env.build((i, text) => { output.textContent = text; }, signal);
  env.resize(innerWidth, innerHeight);
  const catalog = await residentCatalogue(signal);
  const motionLibrary = await loadMotionClips(signal);
  let resident, activity, time = 0, raf = 0, sole = [], errors = [], visited = new Set(), sample = new THREE.Vector3(), mesh;
  async function select(id) {
    cancelAnimationFrame(raf); resident?.dispose(); ctx._updates.length = 0;
    run.disabled = true; play.disabled = true; save.disabled = true;
    const def = { ...MAPS.suibo.residents.find(r => r.id === id), x: 35, z: 55.5, groundHint: .35 };
    activity = { social: new TownSocial([def]) };
    resident = movingResident(ctx, def, activity, []);
    await buildModelResident(ctx, activity, resident, catalog[id], { signal, motionLibrary });
    mesh = resident.group.children[0];
    const positions = mesh.geometry.attributes.position;
    sole = [];
    for (let i = 0; i < positions.count; i++) {
      sample.fromBufferAttribute(positions, i).multiplyScalar(mesh.scale.x).add(mesh.position);
      if (sample.y < .035 && Math.abs(sample.x) < .4) sole.push(i);
    }
    time = 0; errors = []; visited = new Set(); activity.social.act(id, 'follow');
    run.disabled = false; play.disabled = false; save.disabled = false; output.textContent = '已就绪：真实地图碰撞、导航、PMX 与鞋底蒙皮。';
    draw();
  }
  function tick(dt) {
    time += dt;
    const targetZ = time < 15 || time >= 30 ? 48.5 : 57;
    ctx.player.position.set(35, ctx.physics.groundHeight(35, targetZ, resident.ground), targetZ);
    ctx.playerObj.pos.copy(ctx.player.position);
    activity.social.tick(dt); ctx.frameId++;
    for (const update of ctx._updates) update(dt, time);
    resident.group.updateMatrixWorld(true); mesh.skeleton.update();
    visited.add(resident.ground.toFixed(3));
    let penetration = 0;
    for (const i of sole) {
      sample.fromBufferAttribute(mesh.geometry.attributes.position, i); mesh.applyBoneTransform(i, sample); mesh.localToWorld(sample);
      penetration = Math.max(penetration, ctx.physics.groundHeight(sample.x, sample.z, resident.ground) - sample.y);
    }
    if (penetration > .02) errors.push({ t: +time.toFixed(2), penetration, x: resident.x, z: resident.z });
  }
  function draw() {
    const yaw = resident.motion.yaw;
    camera.position.set(resident.x + Math.sin(yaw) * 3.8 + .55, resident.ground + 1.2, resident.z + Math.cos(yaw) * 3.8);
    camera.lookAt(resident.x, resident.ground + .90, resident.z);
    env.update(0, time + 14); scene.updateMatrixWorld(); env.render(time + 14, 1 / 60);
  }
  function report() {
    output.textContent = `${resident.id} · ${time.toFixed(1)} 秒\n地面高度：${[...visited].join(' / ')}\n脚底穿地 >2cm：${errors.length} 帧\n当前位置：${resident.x.toFixed(2)}, ${resident.z.toFixed(2)} · ${resident.motion.mode}\n${errors.length ? JSON.stringify(errors.slice(0, 2)) : '模型 / 导航正常；未调用 LLM、未写入用户存档。'}`;
  }
  run.onclick = () => {
    cancelAnimationFrame(raf);
    for (let i = 0; i < 46 * 60; i++) tick(1 / 60);
    draw(); report();
  };
  play.onclick = () => {
    cancelAnimationFrame(raf);
    const frame = () => { tick(1 / 60); draw(); report(); if (time < 46) raf = requestAnimationFrame(frame); };
    frame();
  };
  save.onclick = () => {
    draw();
    const link = document.createElement('a');
    link.download = `harbour-${resident.id}-grounding.png`; link.href = canvas.toDataURL('image/png'); link.click();
  };
  document.querySelector('select').onchange = event => { void select(event.target.value).catch(error => { output.textContent = error.stack; }); };
  await select('main-aemeath');
} catch (error) { output.textContent = error.stack; }
