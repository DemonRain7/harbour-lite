const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const web = path.resolve(__dirname, '../../web');
const pet = fs.readFileSync(path.join(web, 'desktop-pet.js'), 'utf8');
const html = fs.readFileSync(path.join(web, 'desktop-pet.html'), 'utf8');
const css = fs.readFileSync(path.join(web, 'desktop-pet.css'), 'utf8');
const app = fs.readFileSync(path.join(web, 'app.js'), 'utf8');
function petFunction(name) {
  return pet.match(new RegExp(`^  function ${name}\\([^\\n]*\\) \\{[\\s\\S]*?^  }`, 'm'))[0];
}

test('input registration and correct identity precede asynchronous startup, even with missing assets', () => {
  const start = pet.lastIndexOf('  start().catch(');
  assert.ok(start > pet.lastIndexOf('  syncInputRegions();'));
  assert.ok(start > pet.lastIndexOf('  setPetIdentity(displayName);'));
  assert.ok(start > pet.lastIndexOf('const regionObserver = new ResizeObserver'));
  assert.match(pet, /start\(\)\.catch\([\s\S]*showVisualUnavailable\(\)/);
  assert.doesNotMatch(css, /--pet-sheet:\s*url\([^\n]*elaina/);
  assert.doesNotMatch(html, /id="petName">Elaina|title="轻触 Elaina"/);
  assert.match(html, /id="petSprite" hidden/);
  assert.match(css, /data-visual-status="unavailable"\] \.desktop-pet-controls/);
  assert.match(css, /\.desktop-pet-stage\s*\{[^}]*-webkit-app-region:\s*drag/);
});

test('failure view retains the requested character, hides broken visuals and refreshes hit regions', () => {
  const node = () => ({ textContent: '', hidden: false, style: {}, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; } });
  let syncs = 0, released = 0;
  const c = vm.createContext({ document: { title: '', documentElement: { style: { setProperty() {} } } },
    host: { ...node(), dataset: {} }, nameText: node(), placeholderName: node(), interactionZone: node(),
    sprite: node(), live2dCanvas: node(), placeholder: node(), placeholderMessage: node(), stage: node(),
    stateText: node(), sourceText: node(), scheduleInputRegionSync() { syncs++; },
    live2dHost: { destroy() { released++; } }, animator: { destroy() { released++; } } });
  vm.runInContext(`${petFunction('setPetIdentity')}\n${petFunction('showVisualUnavailable')}`, c);
  c.setPetIdentity('Aemeath');
  c.showVisualUnavailable('尚未安装桌宠外观');
  assert.equal(c.nameText.textContent, 'Aemeath');
  assert.equal(c.document.title, 'Aemeath · Harbour Pet');
  assert.equal(c.placeholderName.textContent, 'Aemeath');
  assert.equal(c.placeholder.hidden, false);
  assert.equal(c.placeholderMessage.textContent, '尚未安装桌宠外观');
  assert.equal(c.host.dataset.visualStatus, 'unavailable');
  assert.equal(c.sprite.hidden, true);
  assert.equal(c.live2dCanvas.hidden, true);
  assert.equal(syncs, 1);
  assert.equal(released, 2);
});

test('sprite availability requires image success, with bounded failure and cleanup', async () => {
  let image, timeout, cleared = 0;
  const c = vm.createContext({ Image: class { constructor() { image = this; } },
    setTimeout(fn, ms) { assert.equal(ms, 10000); timeout = fn; return 1; }, clearTimeout() { cleared++; } });
  vm.runInContext(petFunction('loadPixelImage'), c);
  const good = c.loadPixelImage('/aemeath.webp');
  assert.equal(image.src, '/aemeath.webp'); image.onload(); await good;
  assert.equal(image.onload, null); assert.equal(image.onerror, null);
  const broken = c.loadPixelImage('/missing.webp'); image.onerror();
  await assert.rejects(broken, /无法读取/);
  const stalled = c.loadPixelImage('/slow.webp'); timeout();
  await assert.rejects(stalled, /超时/);
  assert.equal(cleared, 3);
});

for (const visible of [false, true]) test(`sidebar ${visible ? 'closes' : 'opens'} only the selected pet and re-enables the control`, async () => {
  let click;
  const calls = [], notices = [];
  const button = { disabled: false, addEventListener(_event, fn) { click = fn; } };
  const desktop = { isElectron: true,
    async petVisible(id) { calls.push(['visible', id]); return visible; },
    async showPet(id) { calls.push(['show', id]); return true; },
    async hidePet(id) { calls.push(['hide', id]); return true; } };
  const c = vm.createContext({ window: { harbourDesktop: desktop }, $: () => button,
    syncDesktopPetQuick: () => ({ petId: 'aemeath', label: 'Aemeath' }), toast: (...args) => notices.push(args) });
  vm.runInContext(app.match(/^function initDesktopPetQuick\(\) \{[\s\S]*?^}/m)[0], c);
  c.initDesktopPetQuick(); await click();
  assert.deepEqual(calls, [['visible', 'aemeath'], [visible ? 'hide' : 'show', 'aemeath']]);
  assert.equal(button.disabled, false);
  assert.match(notices[0][0], visible ? /已关闭/ : /窗口已打开/);
  desktop.petVisible = async () => { throw new Error('IPC unavailable'); };
  await click();
  assert.equal(button.disabled, false);
  assert.deepEqual(notices.at(-1), ['IPC unavailable', true]);
});
