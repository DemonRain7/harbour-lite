"use strict";
// Helpers for the isolated hidden Electron fixture. No live service or desktop input.
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");

async function checkBlinkRegistration({ win, js, sleep, edge, persona = "aemeath" }) {
  const selector = edge === "orb" ? "#orbBlink" : "#dockBlink";
  const geometry = await js(`(() => {
    document.getAnimations().forEach(a=>{a.pause();a.currentTime=a.effect.getTiming().delay||0});
    document.querySelector('#hairMotionClock').pauseAnimations();
    const el=document.querySelector(${JSON.stringify(selector)}), s=getComputedStyle(el), blink=el.getAnimations()[0];
    blink.currentTime=blink.effect.getTiming().delay;
    return {rect:el.getBoundingClientRect().toJSON(),mask:s.maskImage};
  })()`);
  assert.match(geometry.mask, /radial-gradient/, "blink replaces eyes only");
  await sleep(60); const open = await win.webContents.capturePage();
  await js(`(() => {const blink=document.querySelector(${JSON.stringify(selector)}).getAnimations()[0];
    blink.currentTime=blink.effect.getTiming().delay+blink.effect.getTiming().duration*.97})()`);
  await sleep(60); const closed = await win.webContents.capturePage();
  const a = open.toBitmap(), b = closed.toBitmap(), size = open.getSize(), r = geometry.rect;
  const centers = (persona === "elaina" ? {
    left: [[34, 51], [53, 62]], right: [[49, 62], [68, 51]], top: [[40, 28], [64, 35]], bottom: [[39, 69], [61, 67]],
  } : { orb: [[38, 45], [57, 48]], left: [[29, 47], [47, 59]],
    right: [[51, 60], [76, 49]], top: [[44, 28], [66, 29]], bottom: [[37, 65], [61, 61]] })[edge];
  let changed = 0, outsideEyes = 0;
  for (let y = Math.max(0, Math.ceil(r.y)); y < Math.min(size.height, r.bottom); y++) {
    for (let x = Math.max(0, Math.ceil(r.x)); x < Math.min(size.width, r.right); x++) {
      const i = (y * size.width + x) * 4;
      if (![0, 1, 2, 3].some(k => Math.abs(a[i + k] - b[i + k]) > 5)) continue;
      changed++;
      const px = (x - r.x) / r.width * 100, py = (y - r.y) / r.height * 100;
      // The mask includes a small feather; allow a few rasterized edge pixels,
      // but the mouth, hands and outer hair must not flip to the blink drawing.
      if (!centers.some(([cx, cy]) => Math.abs(px - cx) < 16 && Math.abs(py - cy) < 13)) outsideEyes++;
    }
  }
  assert.ok(changed > 4, `${persona}/${edge}: blink actually changes visible eye pixels (${changed})`);
  assert.ok(outsideEyes <= 3, `${persona}/${edge}: blink must not replace mouth/hair/pose (${outsideEyes})`);
  console.log(JSON.stringify({ blinkRegistration: `${persona}/${edge}`, changed, outsideEyes }));
  await js("if(document.body.dataset.freeMotion==='true')document.querySelector('#hairMotionClock').unpauseAnimations(); document.getAnimations().forEach(a=>a.play())");
}

async function checkHairPixels({ win, js, sleep, report, persona, edge }) {
  const selector = edge === "orb" ? "#orbArt" : "#dockLiving";
  const geometry = await js(`(() => {
    const el=document.querySelector(${JSON.stringify(selector)}), clock=document.querySelector('#hairMotionClock');
    document.getAnimations().forEach(a=>{a.pause();a.currentTime=a.effect.getTiming().delay||0});
    clock.pauseAnimations(); clock.setCurrentTime(0);
    return {rect:el.getBoundingClientRect().toJSON(),filter:getComputedStyle(el).filter,
      hit:document.querySelector(${JSON.stringify(edge === "orb" ? "#orb" : "#dock")}).getBoundingClientRect().toJSON()};
  })()`);
  assert.match(geometry.filter, new RegExp(`hair-${edge}`));
  await sleep(70);
  const rest = await win.webContents.capturePage();
  await js("document.querySelector('#hairMotionClock').setCurrentTime(2.688)");
  win.webContents.invalidate();
  await sleep(70);
  const breeze = await win.webContents.capturePage(), a = rest.toBitmap(), b = breeze.toBitmap(), size = rest.getSize();
  assert.equal(a.length, b.length);
  const r = geometry.rect, faces = { orb: [50, 47], left: [41, 50], right: [59, 50], top: [50, 27], bottom: [50, 66] };
  const [cx, cy] = faces[edge]; let changed = 0, faceChanged = 0, facePixels = 0;
  for (let y = Math.max(0, Math.ceil(r.y)); y < Math.min(size.height, r.bottom); y++) {
    for (let x = Math.max(0, Math.ceil(r.x)); x < Math.min(size.width, r.right); x++) {
      const i = (y * size.width + x) * 4;
      const different = Math.max(...[0, 1, 2, 3].map(k => Math.abs(a[i + k] - b[i + k]))) > 3;
      if (different) changed++;
      // The central eyes/nose/mouth area must not swim with the loose hair.
      if (Math.abs((x - r.x) / r.width * 100 - cx) < 13 && Math.abs((y - r.y) / r.height * 100 - cy) < 10) {
        facePixels++; if (different) faceChanged++;
      }
    }
  }
  fs.mkdirSync(report, { recursive: true });
  fs.writeFileSync(path.join(report, `living-${persona}-${edge}-rest.png`), rest.toPNG());
  fs.writeFileSync(path.join(report, `living-${persona}-${edge}-breeze.png`), breeze.toPNG());
  assert.ok(changed > 8, `${persona}/${edge}: actual hair pixels must move (${changed})`);
  assert.ok(faceChanged <= Math.max(3, facePixels * .08), `${persona}/${edge}: face stays anchored (${faceChanged}/${facePixels})`);
  const hit = await js(`document.querySelector(${JSON.stringify(edge === "orb" ? "#orb" : "#dock")}).getBoundingClientRect().toJSON()`);
  assert.deepEqual(hit, geometry.hit, "hair motion never moves the hit target");
  console.log(JSON.stringify({ motion: `${persona}/${edge}`, changed, faceChanged, facePixels }));
  await js("document.querySelector('#hairMotionClock').unpauseAnimations(); document.getAnimations().forEach(a=>a.play())");
}

async function checkLivingPortrait({ c, win, js, sleep, until, capture, report }) {
  const openEyes = () => js("(() => {const eye=document.querySelector('#orbBlink').getAnimations()[0]; if(eye){eye.pause();eye.currentTime=eye.effect.getTiming().delay}})()");
  for (const persona of ["elaina", "aemeath"]) {
    c.agent = `main-${persona}`; c.dock = null; c.expanded = c.pinned = false; c.reflow();
    const row = c.chat.row(c.agent); row.phase = "idle"; row.runId = null; c.publish();
    await until(`document.querySelector('#orbExpression').dataset.source?.includes('${persona}-expressions-${persona === "aemeath" ? "v4" : "v2"}') && document.querySelector('#orbExpression').dataset.frame==='idle'`);
    await until("document.body.dataset.freeMotion==='true' && document.querySelector('#orbBlink').getAnimations().length===1");
    await checkHairPixels({ win, js, sleep, report, persona, edge: "orb" });
    if (persona === "aemeath") await checkBlinkRegistration({ win, js, sleep, edge: "orb" });
    await openEyes(); await capture(`living-${persona}-idle`);
    const source = await js("document.querySelector('#orbExpression').style.backgroundImage");
    row.runId = "motion-fixture"; row.phase = "running"; c.publish();
    await until("document.querySelector('#orbExpression').dataset.frame==='thinking'");
    assert.equal(await js("document.querySelector('#orbExpression').style.backgroundImage"), source, "thinking uses the same registered atlas");
    assert.equal(await js("getComputedStyle(document.querySelector('#orbExpression')).backgroundPosition"), "50% 0%");
    assert.equal(await js("getComputedStyle(document.querySelector('#orbExpression')).backgroundSize"), "300% 200%");
    const fade = await js(`(() => {
      const old=document.querySelector('#orbExpressionPrevious'), current=document.querySelector('#orbExpression');
      window.fixtureFade=old.getAnimations()[0];
      if(!fixtureFade) return null;
      fixtureFade.pause(); fixtureFade.currentTime=90;
      return {opacity:getComputedStyle(old).opacity,sameFrame:JSON.stringify(old.getBoundingClientRect())===JSON.stringify(current.getBoundingClientRect()),
        oldPosition:old.style.backgroundPosition,duration:fixtureFade.effect.getTiming().duration};
    })()`);
    assert.ok(fade, "idle → task crossfades, never jumps to an independently framed portrait");
    assert.ok(+fade.opacity > 0 && +fade.opacity < 1); assert.equal(fade.duration, 180);
    assert.equal(fade.sameFrame, true); assert.equal(fade.oldPosition, "0% 0%");
    for (let i = 0; i < 10; i++) c.publish();
    await sleep(35);
    assert.equal(await js("fixtureFade===document.querySelector('#orbExpressionPrevious').getAnimations()[0]"), true, "progress does not restart the face transition");
    await js("fixtureFade.finish()"); await until("document.querySelector('#orbExpressionPrevious').hidden");
    await openEyes(); await capture(`living-${persona}-thinking`);
    await js("document.getAnimations().forEach(a=>a.pause()); document.querySelector('#hairMotionClock').pauseAnimations()");
    const eyesOpen = await win.webContents.capturePage();
    const blink = await js(`(() => {
      const el=document.querySelector('#orbBlink'), a=el.getAnimations()[0];
      a.pause(); a.currentTime=a.effect.getTiming().delay+a.effect.getTiming().duration*.97;
      return getComputedStyle(el).opacity;
    })()`);
    assert.equal(blink, "1", "working face blinks too"); await capture(`living-${persona}-blink`);
    const eyesClosed = await win.webContents.capturePage();
    const first = eyesOpen.toBitmap(), second = eyesClosed.toBitmap(), width = eyesOpen.getSize().width;
    let eyePixels = 0;
    for (let y = 32; y < 47; y++) for (let x = 26; x < 60; x++) {
      const i = (y * width + x) * 4;
      if ([0, 1, 2].some(k => Math.abs(first[i + k] - second[i + k]) > 8)) eyePixels++;
    }
    assert.ok(eyePixels > 20, `${persona}: blinking changes visible eyes, not only computed opacity (${eyePixels})`);
    await js("window.fixtureVisible=false; document.dispatchEvent(new Event('visibilitychange'))");
    assert.equal(await js("document.querySelector('#orbArt').getAnimations({subtree:true}).length"), 0);
    assert.equal(await js("document.querySelector('#hairMotionClock').animationsPaused()"), true);
    assert.equal(await js("getComputedStyle(document.querySelector('#orbBlink')).opacity"), "0");
    row.runId = null; row.phase = "idle"; c.publish();
    await until("document.querySelector('#orbExpression').dataset.frame==='idle'");
    assert.equal(await js("document.querySelector('#orbExpressionPrevious').hidden"), true, "no deferred hidden-page transition");
    await js("window.fixtureVisible=true; document.dispatchEvent(new Event('visibilitychange'))");
  }
  c.agent = "main-elaina"; c.publish();
}
module.exports = { checkHairPixels, checkLivingPortrait, checkBlinkRegistration };
