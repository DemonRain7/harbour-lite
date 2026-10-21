"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path");
const { frame } = require("../renderer/orb-peek-frames");

function sourceClearance(nativeImage, file) {
  const image = nativeImage.createFromPath(file), size = image.getSize(), bytes = image.toBitmap();
  assert.equal(bytes.length, size.width * size.height * 4);
  const results = [];
  for (const edge of ["left", "right", "top", "bottom"]) {
    const r = frame(file, edge, size.width, size.height);
    let worst = 0;
    // Source cuts must be in transparent gutters, not through hair.
    // Isolated alpha noise is not a silhouette; a solid run is.
    for (const side of ["left", "right", "top", "bottom"]) {
      if (edge === "top" && side === "top") continue; // collar continues offscreen
      const vertical = side === "left" || side === "right", length = vertical ? r.height : r.width;
      for (let depth = 0; depth < 3; depth++) {
        let run = 0;
        for (let k = 0; k < length; k++) {
          const x = r.x + (vertical ? side === "left" ? depth : r.width - 1 - depth : k);
          const y = r.y + (vertical ? k : side === "top" ? depth : r.height - 1 - depth);
          run = bytes[(y * size.width + x) * 4 + 3] > 192 ? run + 1 : 0;
          worst = Math.max(worst, run);
        }
      }
    }
    assert.ok(worst < 8, path.basename(file) + "/" + edge + ": hair touches source cut line (" + worst + "px solid run)");
    results.push({ edge, rect: r, maxBorderRun: worst });
  }
  return results;
}

// Serialized into the isolated renderer; it has no access to any live window.
function samplePose({ hover, fraction, closed }) {
  const tab = document.querySelector("#dock"), peek = document.querySelector(".dock-peek"), living = document.querySelector("#dockLiving");
  const style = getComputedStyle(tab), life = living.getAnimations()[0];
  life.currentTime = life.effect.getTiming().duration * fraction;
  const blink = document.querySelector("#dockBlink").getAnimations()[0];
  blink.currentTime = blink.effect.getTiming().delay + blink.effect.getTiming().duration * (closed ? .97 : 0);
  peek.style.transform = hover ? "translate(" + style.getPropertyValue("--peek-x") + "," + style.getPropertyValue("--peek-y") + ")" : "none";
  return { r: living.getBoundingClientRect().toJSON(), width: innerWidth, height: innerHeight, overflow: style.overflow,
    hit: tab.getBoundingClientRect().toJSON(), dpr: devicePixelRatio };
}

async function auditClipping({ win, js, sleep, persona, edge, report, scale }) {
  await js("document.getAnimations().forEach(a=>a.pause());document.querySelector('#hairMotionClock').pauseAnimations();document.querySelector('.dock-peek').style.transition='none'");
  let minimum = Infinity, checks = 0;
  for (const hover of [false, true]) for (const fraction of [0, .125, .25, .375, .5, .625, .75, .875]) for (const closed of [false, true]) {
    const g = await js("(" + samplePose.toString() + ")(" + JSON.stringify({ hover, fraction, closed }) + ")");
    const label = persona + "/" + edge + "/" + scale + "x";
    assert.equal(g.overflow, "visible", "the hit target must not become another clipping surface");
    const clear = { left: g.r.left, right: g.width - g.r.right, top: g.r.top, bottom: g.height - g.r.bottom };
    delete clear[edge]; // only the actual monitor edge may conceal the other half
    const margin = Math.min(...Object.values(clear)); minimum = Math.min(minimum, margin);
    assert.ok(margin >= 5, label + ": missing breathing/shadow margin (" + JSON.stringify(clear) + ")");
    win.webContents.invalidate(); await sleep(24);
    const screenshot = await win.webContents.capturePage(), size = screenshot.getSize(), pixels = screenshot.toBitmap();
    assert.equal(pixels.length, size.width * size.height * 4);
    let clipped = 0;
    // Real capture, not just DOM boxes: the three non-wall borders stay
    // transparent throughout the breathing cycle, with or without hover/blinking.
    for (let y = 0; y < size.height; y++) for (let x = 0; x < size.width; x++) {
      const border = edge !== "left" && x < 2 || edge !== "right" && x >= size.width - 2
        || edge !== "top" && y < 2 || edge !== "bottom" && y >= size.height - 2;
      if (border && pixels[(y * size.width + x) * 4 + 3] > 8) clipped++;
    }
    assert.equal(clipped, 0, label + ": visible pixels reach a non-wall viewport edge");
    if (fraction === .5) {
      fs.mkdirSync(report, { recursive: true });
      fs.writeFileSync(path.join(report, persona + "-" + edge + "-" + (hover ? "hover" : "rest") + "-inhale" + (closed ? "-blink" : "") + ".png"), screenshot.toPNG());
    }
    checks++;
  }
  await js("document.querySelector('.dock-peek').style.transform='';document.querySelector('.dock-peek').style.transition='';document.getAnimations().forEach(a=>a.play())");
  return { persona, edge, scale, samples: checks, minimumClearance: +minimum.toFixed(2) };
}

module.exports = { sourceClearance, auditClipping };
