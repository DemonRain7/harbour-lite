const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { removeWindowMenu } = require('../companion/window-menu');

test('Windows/Linux remove the native menu, while macOS retains its application menu', () => {
  for (const platform of ['win32', 'linux', 'darwin']) {
    let removed = 0;
    removeWindowMenu({ removeMenu: () => removed++ }, platform);
    assert.equal(removed, platform === 'darwin' ? 0 : 1);
  }
});

test('Dashboard, auxiliary surfaces and the native Town shell all apply the policy', () => {
  const main = fs.readFileSync(path.resolve(__dirname, '../main.js'), 'utf8');
  for (const name of ['createDashboardWindow', 'createAuxiliaryWindow', 'createDashboardSurface']) {
    const fn = main.slice(main.indexOf(`async function ${name}(`)).split('\nasync function ')[0];
    assert.match(fn, /removeWindowMenu\(win\)/);
  }
  assert.match(fs.readFileSync(path.resolve(__dirname, '../town/controller.js'), 'utf8'), /removeWindowMenu\(win\)/);
});
