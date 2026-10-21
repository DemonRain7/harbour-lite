// Use the same visible entry points as a person; do not click hidden DOM controls.
async function openTownMenu(surface, tab = 'scene') {
  if (!(await surface.locator('#settings-panel').isVisible())) await surface.locator('#settings-toggle').click();
  await surface.locator(`#tab-${tab}`).click();
}
async function visitTownResident(surface, id) {
  await openTownMenu(surface, 'residents');
  await surface.locator(`[data-resident="${id}"]`).click();
  await surface.locator('#settings-panel').waitFor({ state: 'hidden' });
}
async function openTownChat(surface) {
  if (!(await surface.locator('#social-panel').isVisible())) await surface.locator('#interact').click();
  await surface.locator('[data-social="chat"]').click();
}
async function exerciseTownSocial(surface, keyboard, screenshot) {
  const assert = require('node:assert/strict');
  await visitTownResident(surface, 'chisa');
  await surface.locator('#interact').click();
  assert.equal(await surface.locator('[data-social="chat"]').isVisible(), false, 'visitor never impersonates a Main');
  const position = await surface.evaluate(() => HarbourTown.status().position);
  await surface.locator('[data-social="wave"]').click();
  await surface.waitForFunction(() => HarbourTown.status().models.find(m => m.id === 'chisa').behavior.mode === 'greet');
  await surface.waitForFunction(() => !HarbourTown.status().social.gesture);
  await surface.locator('[data-social="pat"]').click();
  await surface.waitForFunction(() => HarbourTown.status().models.find(m => m.id === 'chisa').behavior.mode === 'pat');
  await surface.waitForFunction(() => HarbourTown.status().social.gesture?.elapsed > .5);
  if (screenshot) await screenshot('social-headpat');
  assert.deepEqual(await surface.evaluate(() => HarbourTown.status().position), position);
  await surface.waitForFunction(() => !HarbourTown.status().social.gesture);
  await surface.locator('[data-hand="paper"]').click();
  assert.equal(await surface.locator('[data-hand="rock"]').isDisabled(), true, 'one round at a time');
  await surface.evaluate(() => HarbourTown.setVisible(false));
  const frozen = await surface.evaluate(() => HarbourTown.status().social);
  await new Promise(resolve => setTimeout(resolve, 160));
  assert.deepEqual(await surface.evaluate(() => HarbourTown.status().social), frozen, 'hidden round does not expire');
  await surface.evaluate(() => HarbourTown.setVisible(true));
  await surface.locator('#interact').click();
  await surface.waitForFunction(() => HarbourTown.status().social.gesture?.revealed);
  await surface.waitForFunction(() => document.getElementById('social-feedback').textContent.includes('你出布'));
  if (screenshot) await screenshot('social-rps');
  await surface.waitForFunction(() => !HarbourTown.status().social.gesture);
  await surface.locator('[data-social="follow"]').click();
  assert.equal(await surface.locator('#social-panel').isHidden(), true, 'invitation returns directly to walking');
  assert.deepEqual(await surface.evaluate(() => HarbourTown.status().social.companion), { id: 'chisa', mode: 'follow' });
  await surface.locator('#company-toggle').click();
  await surface.locator('#company-wait').click();
  await surface.waitForFunction(() => HarbourTown.status().models.find(m => m.id === 'chisa').behavior.company === 'waiting');
  await surface.locator('#company-wait').click();
  assert.equal(await surface.evaluate(() => HarbourTown.status().social.companion.mode), 'follow');
  await surface.locator('#company-end').click();
  assert.equal(await surface.evaluate(() => HarbourTown.status().social.companion), null);
  await surface.locator('#settings-close').click();
  await visitTownResident(surface, 'chisa');
  await surface.locator('#scene').focus(); await keyboard.press('e');
  await surface.locator('#social-panel').waitFor({ state: 'visible' });
  await keyboard.press('Escape');
  assert.equal(await surface.locator('#social-panel').isHidden(), true);
  assert.equal(await surface.evaluate(() => HarbourTown.status().pointerLocked), false);
}
// Real renderer + real keyboard/Pointer Lock. Restore the map view afterwards
// so this doesn't change later resident/appearance/chat acceptance fixtures.
async function exerciseTownMovement(surface, keyboard) {
  const assert = require('node:assert/strict');
  const saved = await surface.evaluate(() => HarbourTown.snapshot());
  await surface.locator('#scene').click({ position: { x: 500, y: 350 } });
  await surface.waitForFunction(() => HarbourTown.status().pointerLocked);
  await surface.evaluate(() => {
    window.movementSamples = [];
    window.movementTimer = setInterval(() => {
      const { movement, position } = HarbourTown.status();
      movementSamples.push({ ...movement, position });
    }, 30);
  });
  try {
    const start = await surface.evaluate(() => HarbourTown.status());
    await keyboard.down('Shift'); await keyboard.down('w');
    await surface.waitForFunction(n => HarbourTown.status().frames > n + 18, start.frames);
    await keyboard.up('w'); await keyboard.up('Shift');
    await surface.waitForFunction(() => HarbourTown.status().movement.speed === 0);
    const settled = await surface.evaluate(() => HarbourTown.status());
    assert.ok(Math.hypot(settled.position[0] - start.position[0], settled.position[2] - start.position[2]) > .1, 'real scene actually moves');
    assert.equal(settled.movement.roll, 0);
    await keyboard.down('w');
    await surface.waitForFunction(() => HarbourTown.status().movement.speed > .1);
    await keyboard.press('m'); await keyboard.up('w');
    await surface.locator('#settings-panel').waitFor({ state: 'visible' });
    const menu = await surface.evaluate(() => HarbourTown.status());
    assert.equal(menu.movement.speed, 0, 'opening the menu cancels motion immediately');
    await surface.waitForFunction(n => HarbourTown.status().frames > n + 4, menu.frames);
    const afterMenu = await surface.evaluate(() => HarbourTown.status());
    assert.ok(Math.hypot(...afterMenu.position.map((v, i) => v - menu.position[i])) < .01, 'no camera travel while the menu is open');
    const samples = await surface.evaluate(() => movementSamples);
    assert.ok(samples.length > 2);
    assert.ok(samples.every(s => s.roll === 0 && s.fov === start.movement.fov && s.cameraPosition.every(Number.isFinite)));
    console.log('Actual map movement:', JSON.stringify({ map: start.mapId, samples: samples.length, start: start.position, stop: settled.position, maxSpeed: Math.max(...samples.map(s => s.speed)), roll: settled.movement.roll, fov: settled.movement.fov }));
    await keyboard.press('m');
  } finally {
    await keyboard.up('w'); await keyboard.up('Shift');
    await surface.evaluate(() => { clearInterval(movementTimer); delete window.movementTimer; delete window.movementSamples; document.exitPointerLock?.(); });
    await surface.evaluate(saved => HarbourTown.restore(saved), saved);
  }
}
module.exports = { openTownMenu, visitTownResident, openTownChat, exerciseTownMovement, exerciseTownSocial };
