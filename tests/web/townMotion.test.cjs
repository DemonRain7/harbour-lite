const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), http = require('node:http'), os = require('node:os');
const { chromium } = require('../../vendor/folia/node_modules/playwright');
const web = path.resolve(__dirname, '../../web');

for (const imported of [false, true]) test(`actual resident rigs: ${imported ? 'downloaded CC0 clips' : 'procedural fallback'} without palette drift`, { timeout: 120000, skip: !fs.existsSync(path.join(web, 'town/models/local/manifest.json')) }, async t => {
  const server = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://local').pathname;
    if (pathname === '/') { res.setHeader('Content-Type', 'text/html'); res.end('<style>body{margin:0;background:#e4e4ea}</style><script type="importmap">{"imports":{"three":"/town/lib/three/build/three.module.js"}}</script>'); return; }
    const file = path.resolve(web, `.${decodeURIComponent(pathname)}`);
    if (!file.startsWith(web + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
    res.setHeader('Content-Type', file.endsWith('.js') ? 'application/javascript' : 'application/octet-stream'); fs.createReadStream(file).pipe(res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  const browser = await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || (process.platform === 'win32' ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' : undefined) });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 640, height: 760 } });
  const errors = []; page.on('pageerror', e => errors.push(e.message));
  await page.route('**/api/**', route => { errors.push('Unexpected API request'); return route.abort(); });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  const output = process.env.TOWN_SCREENSHOT_DIR || path.join(os.tmpdir(), 'harbour-town-motion'); fs.mkdirSync(output, { recursive: true });
  const catalogue = JSON.parse(fs.readFileSync(path.join(web, 'town/models/local/manifest.json'))).residents;
  for (const id of Object.keys(catalogue)) {
    const stats = await page.evaluate(async ({ id, imported }) => {
      const THREE = await import('three');
      const { loadAvatar, residentCatalogue, disposeAvatar } = await import('/town/model-residents.js');
      const { createAvatarMotion } = await import('/town/resident-motion.js');
      const { loadMotionClips } = await import('/town/motion-clips.js');
      const signal = new AbortController().signal, catalog = await residentCatalogue(signal);
      const mesh = await loadAvatar(id, catalog[id].variants.find(v => v.id === catalog[id].defaultVariant), signal);
      const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true }); renderer.setSize(640, 760); document.body.append(renderer.domElement);
      const scene = new THREE.Scene(); scene.background = new THREE.Color('#e4e4ea');
      const grid = new THREE.GridHelper(40, 80, 0xb8b8c8, 0xd1d1dc); grid.position.y = -.012; scene.add(grid);
      const root = new THREE.Group(); root.add(mesh); scene.add(root);
      scene.add(new THREE.HemisphereLight(0xffffff, 0x777788, 2));
      const light = new THREE.DirectionalLight(0xffffff, 2); light.position.set(-1, 3, 4); scene.add(light);
      const camera = new THREE.PerspectiveCamera(36, 640 / 760, .01, 100); camera.position.set(.6, 1, 3.6); camera.lookAt(0, .9, 0);
      let paletteCalls = 0; const palette = mesh.skeleton.update.bind(mesh.skeleton); mesh.skeleton.update = () => { paletteCalls++; palette(); };
      const ctx = { player: { position: camera.position }, camera, frameId: 0 };
      const resident = { id, motion: { x: 0, z: 0, ground: 0, yaw: 0, mode: 'idle', speed: .68, motionTime: .16 } };
      const library = imported ? await loadMotionClips(signal) : null;
      const update = createAvatarMotion(mesh, ctx, resident, library);
      const renderPose = mode => {
        resident.motion.mode = mode.startsWith('rps-') ? 'rps' : mode === 'foldArms' ? 'idle' : mode;
        resident.motion.social = mode.startsWith('rps-') ? { type: 'rps', elapsed: 3, choice: mode.slice(4), countdown: false } : mode === 'pat' ? { type: 'pat', elapsed: 1 } : null;
        resident.motion.idleGesture = mode === 'foldArms' ? 'foldArms' : 'idle';
        resident.motion.x = 0; resident.motion.z = 0; resident.motion.distance = 0;
        resident.motion.yaw = 0; resident.motion.speed = mode === 'walk' ? .72 : 0;
        for (let i = 0; i < 90; i++) {
          ctx.frameId++; resident.motion.phase = i / 30;
          if (mode === 'walk') { resident.motion.z += .72 / 30; resident.motion.distance += .72 / 30; }
          if (mode === 'turn') resident.motion.yaw += .5 / 30;
          root.position.z = resident.motion.z; root.rotation.y = resident.motion.yaw;
          camera.position.set(.6, 1, resident.motion.z + 3.6); camera.lookAt(0, .9, resident.motion.z);
          update(1 / 30, ctx.frameId / 30);
        }
        const before = paletteCalls; renderer.render(scene, camera); renderer.render(scene, camera);
        const position = name => mesh.skeleton.bones.find(b => b.name === name).getWorldPosition(new THREE.Vector3());
        const forward = position('右中指１').sub(position('右手首')).normalize();
        const palm = position('右人指１').sub(position('右小指１')).cross(forward).normalize();
        const forearm = position('右手首').sub(position('右ひじ')).normalize();
        return { palettes: paletteCalls - before, elbow: mesh.skeleton.bones.find(b => b.name === '右ひじ').quaternion.toArray(),
          leg: mesh.skeleton.bones.find(b => b.name === '左足').quaternion.toArray(), mouth: mesh.morphTargetInfluences[mesh.morphTargetDictionary['あ']], clip: mesh.userData.townModel.activeClip,
          palmFacing: palm.dot(new THREE.Vector3(0, 0, 1).applyQuaternion(root.quaternion)), wristAlignment: forward.dot(forearm),
          fingers: ['人指', '中指', '薬指', '小指'].map(f => mesh.skeleton.bones.find(b => b.name === '右' + f + '２').quaternion.toArray()) };
      };
      const checkGait = (fps = 60) => {
        const pose = resident.motion, legs = ['左', '右'].map(side => ({
          foot: mesh.skeleton.bones.find(b => b.name === side + '足首D') || mesh.skeleton.bones.find(b => b.name === side + '足首'),
          hip: mesh.skeleton.bones.find(b => b.name === side + '足'),
          knee: mesh.skeleton.bones.find(b => b.name === side + 'ひざ'), last: new THREE.Vector3(), planted: false,
        }));
        const actual = new THREE.Vector3(), desired = new THREE.Vector3(), hip = new THREE.Vector3(), knee = new THREE.Vector3(), axis = new THREE.Vector3(), bend = new THREE.Vector3();
        const metrics = { maxContactError: 0, maxPlantSlide: 0, minKneeForward: Infinity, contacts: 0, maxFootJump: 0, maxFootVerticalJump: 0, maxPhaseJump: 0, motionMs:0 };
        let previousCycle;
        Object.assign(pose, { x: 10, z: 0, yaw: 0, distance: 0 });
        for (let frame = 0; frame < fps * 10; frame++) {
          const time = frame / fps;
          pose.mode = time < .8 || time >= 8 ? 'idle' : time >= 4 && time < 5 ? 'turn' : 'walk';
          pose.speed = pose.mode === 'walk' ? .72 : 0; pose.phase = time;
          if (pose.mode === 'turn') pose.yaw += Math.PI / 2 / fps;
          pose.x += Math.sin(pose.yaw) * pose.speed / fps; pose.z += Math.cos(pose.yaw) * pose.speed / fps; pose.distance += pose.speed / fps;
          root.position.set(pose.x, 0, pose.z); root.rotation.y = pose.yaw;
          camera.position.set(pose.x + .6, 1.1, pose.z + 3.2); camera.lookAt(pose.x, 1.05, pose.z);
          ctx.frameId++; const start = performance.now(); update(1 / fps, time); metrics.motionMs += performance.now() - start; root.updateMatrixWorld(true);
          const gait = mesh.userData.townModel.gait;
          if (frame > fps) metrics.maxPhaseJump = Math.max(metrics.maxPhaseJump, Math.abs(gait.cycle - previousCycle));
          previousCycle = gait.cycle;
          for (const [i, leg] of legs.entries()) {
            leg.foot.getWorldPosition(actual); desired.fromArray(gait.feet[i]);
            if (frame > fps) {
              leg.hip.getWorldPosition(hip); leg.knee.getWorldPosition(knee);
              axis.copy(actual).sub(hip).normalize(); bend.copy(knee).sub(hip); bend.addScaledVector(axis,-bend.dot(axis));
              metrics.minKneeForward = Math.min(metrics.minKneeForward, bend.x * Math.sin(pose.yaw) + bend.z * Math.cos(pose.yaw));
              if (gait.planted[i]) { const error = actual.distanceTo(desired); if (error > metrics.maxContactError) { metrics.maxContactError = error; metrics.contactFrame = {frame, mode:pose.mode, side:i, desired:desired.toArray(), actual:actual.toArray(), cycle:gait.cycle}; } metrics.contacts++; }
              if (pose.mode === 'walk' && gait.planted[i] && leg.planted) metrics.maxPlantSlide = Math.max(metrics.maxPlantSlide, actual.distanceTo(leg.last));
              const jump = actual.distanceTo(leg.last); if (jump > metrics.maxFootJump) { metrics.maxFootJump = jump; metrics.jumpFrame = {frame, mode:pose.mode, side:i, previous:leg.last.toArray(), actual:actual.toArray(), cycle:gait.cycle}; }
              metrics.maxFootVerticalJump = Math.max(metrics.maxFootVerticalJump, Math.abs(actual.y - leg.last.y));
            }
            leg.last.copy(actual); leg.planted = gait.planted[i];
          }
        }
        return metrics;
      };
      const record = async () => {
        const stream = renderer.domElement.captureStream(30), chunks = [];
        const recorder = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp9', videoBitsPerSecond: 2200000 });
        recorder.ondataavailable = event => chunks.push(event.data);
        const stopped = new Promise(resolve => { recorder.onstop = resolve; });
        const pose = resident.motion;
        Object.assign(pose, { x: 0, z: 0, ground: 0, yaw: 0, distance: 0, speed: 0, phase: 0, mode: 'idle' });
        root.position.set(0, 0, 0); root.rotation.y = 0;
        camera.position.set(3.4, 1, 1.2); camera.lookAt(0, .9, 0);
        for (let i = 0; i < 60; i++) { ctx.frameId++; update(1 / 30, i / 30); }
        recorder.start(); let lastMode = 'idle';
        const cameraOffset = new THREE.Vector3(), focus = new THREE.Vector3();
        for (let i = 0; i < 288; i++) {
          const t = i / 30;
          pose.mode = t < .6 || (t >= 5.6 && t < 6.4) || t >= 8.8 ? 'idle' : t >= 3 && t < 4 ? 'turn' : t < 5.6 ? 'walk' : 'greet';
          pose.phase = lastMode === pose.mode ? pose.phase + 1 / 30 : 0; lastMode = pose.mode;
          pose.speed = pose.mode === 'walk' ? .72 : 0;
          if (pose.mode === 'turn') pose.yaw += Math.PI / 2 / 30;
          pose.x += Math.sin(pose.yaw) * pose.speed / 30; pose.z += Math.cos(pose.yaw) * pose.speed / 30; pose.distance += pose.speed / 30;
          root.position.set(pose.x, 0, pose.z); root.rotation.y = pose.yaw;
          cameraOffset.set(t < 6 ? 3.4 : .4, 1, t < 6 ? 1.2 : 3.6);
          if (t >= 6) cameraOffset.applyAxisAngle(new THREE.Vector3(0, 1, 0), pose.yaw);
          camera.position.lerp(cameraOffset.add(root.position), .25); focus.set(pose.x, .9, pose.z); camera.lookAt(focus);
          ctx.frameId++; update(1 / 30, t); renderer.render(scene, camera);
          await new Promise(resolve => setTimeout(resolve, 1000 / 30));
        }
        recorder.stop(); await stopped; stream.getTracks().forEach(track => track.stop());
        return [...new Uint8Array(await new Blob(chunks).arrayBuffer())];
      };
      const closeupHand = () => {
        renderPose('greet');
        const hand = mesh.skeleton.bones.find(b => b.name === '右中指１').getWorldPosition(new THREE.Vector3());
        camera.position.copy(hand).add(new THREE.Vector3(.08, .015, .60)); camera.lookAt(hand); renderer.render(scene, camera);
      };
      const checkGreeting = () => {
        renderPose('idle');
        const elbow = mesh.skeleton.bones.find(b => b.name === '右ひじ'), wrist = mesh.skeleton.bones.find(b => b.name === '右手首');
        const a = new THREE.Vector3(), b = new THREE.Vector3(); let maxLateral = 0;
        for (let i = 0; i < 120; i++) {
          resident.motion.mode = i < 60 ? 'greet' : 'idle'; resident.motion.phase = i / 60;
          ctx.frameId++; update(1 / 60, i / 60); root.updateMatrixWorld(true);
          elbow.getWorldPosition(a); wrist.getWorldPosition(b);
          maxLateral = Math.max(maxLateral, Math.abs(a.x - b.x));
        }
        return maxLateral;
      };
      window.motionPreview = { renderPose, checkGait, checkGreeting, record, closeupHand, dispose() { grid.geometry.dispose(); grid.material.dispose(); disposeAvatar(mesh); renderer.domElement.remove(); renderer.dispose(); renderer.forceContextLoss(); } };
      return { bones: mesh.skeleton.bones.length, animatedBones: mesh.userData.townModel.animatedBones };
    }, { id, imported });
    assert.ok(stats.animatedBones < stats.bones / 2, JSON.stringify(stats));
    const poses = {};
    for (const mode of ['idle', 'walk', 'turn', 'greet', 'think', 'reply', 'pat', 'rps-rock', 'rps-scissors', 'rps-paper', ...(imported ? ['listen'] : [])]) {
      poses[mode] = await page.evaluate(mode => motionPreview.renderPose(mode), mode);
      assert.equal(poses[mode].palettes, 1, 'all passes share one palette calculation per display frame');
      await page.screenshot({ path: path.join(output, `${id}-${imported ? 'clip-' : ''}${mode}.png`) });
    }
    assert.notDeepEqual(poses.walk.leg, poses.idle.leg); assert.notDeepEqual(poses.greet.elbow, poses.idle.elbow);
    assert.ok(poses.reply.mouth > .08);
    assert.notDeepEqual(poses['rps-rock'].fingers[0], poses['rps-paper'].fingers[0], 'rock visibly curls fingers, paper extends them');
    for (const i of [0, 1]) assert.ok(poses['rps-scissors'].fingers[i].every((v, j) => Math.abs(v - poses['rps-paper'].fingers[i][j]) < .001), 'scissors extends index and middle');
    for (const i of [2, 3]) assert.ok(poses['rps-scissors'].fingers[i].every((v, j) => Math.abs(v - poses['rps-rock'].fingers[i][j]) < .001), 'scissors keeps ring and pinky curled');
    assert.ok(poses['rps-paper'].wristAlignment > .85, 'game hand is not bent back at the wrist');
    assert.ok(poses.greet.palmFacing > .9, `${id}: greeting palm must face the other person, not show its edge (${poses.greet.palmFacing})`);
    assert.ok(poses.greet.wristAlignment > .90, `${id}: fingers follow the forearm without a bent-back wrist (${poses.greet.wristAlignment})`);
    assert.ok(await page.evaluate(() => motionPreview.checkGreeting()) < .09, 'raising/lowering the hand bends forward at the elbow, not sideways');
    await page.evaluate(() => motionPreview.closeupHand());
    await page.screenshot({ path: path.join(output, `${id}-${imported ? 'clip-' : ''}hand.png`) });
    const reset = await page.evaluate(() => motionPreview.renderPose('idle'));
    assert.ok(reset.elbow.every((q, i) => Math.abs(q - poses.idle.elbow[i]) < (imported ? .001 : 1e-5)), 'grants do not accumulate across animation frames');
    if (imported) { assert.equal(poses.reply.clip, 'talk'); assert.equal(poses.walk.clip, '', 'walk must not overlay an independently timed upper-body clip'); assert.equal(poses.turn.clip, 'idle'); assert.equal(poses.listen.clip, 'nod'); }
    for (const fps of [30, 60, 120]) {
      const gait = await page.evaluate(fps => motionPreview.checkGait(fps), fps);
      console.log(id, `${fps} Hz foot contacts`, JSON.stringify({ ...gait, contactFrame: undefined, jumpFrame: undefined }));
      assert.ok(gait.contacts > fps * 6);
      assert.ok(gait.minKneeForward > -.001, 'knees bend towards the front, never reverse');
      assert.ok(gait.maxContactError < .015, 'actual deformation-chain ankles reach contact targets');
      assert.ok(gait.maxPlantSlide < .012, 'support foot stays planted as the root advances');
      assert.ok(gait.maxFootJump * fps < 3.3, 'swing foot stays within 3 m/s (with numerical tolerance), no single-frame teleport');
      assert.ok(gait.maxFootVerticalJump * fps < 1.32, 'walk/turn transitions do not abruptly drop or raise an airborne foot');
      assert.ok(gait.maxPhaseJump * fps < 1.2, 'turning into walking preserves the shared leg/arm phase instead of restarting it');
    }
    if (imported && process.env.TOWN_MOTION_RECORD === '1') {
      const video = await page.evaluate(() => motionPreview.record());
      fs.writeFileSync(path.join(output, `${id}-motion.webm`), Buffer.from(video));
    }
    await page.evaluate(() => motionPreview.dispose()); console.log(id, JSON.stringify(stats));
  }
  assert.deepEqual(errors, []); console.log('Town motion previews:', output);
});
