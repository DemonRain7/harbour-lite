const assert = require('node:assert/strict');
const path = require('node:path');
const { app, session } = require('electron');

// Text-based UI fixtures select an explicit supported locale in their isolated
// profile. Do not depend on the Windows owner's language or the Mac runner OS.
module.exports = async function fixtureLocale(contents) {
  for (let i = 0; i < 150; i++) {
    if (await contents.executeJavaScript('document.documentElement.lang === "zh-CN" && !document.querySelector("#app-splash")')) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.fail('Folia did not apply the fixture language preference');
};

module.exports.prepare = function prepareFixtureLocale() {
  assert.ok(path.basename(app.getPath('userData')).startsWith('harbour-folia-'), 'locale fixture requires isolated userData');
  // Set only the test profile's existing language preference before its first
  // document runs. Do not race startup/GPU initialization with a locale reload.
  session.fromPartition('persist:harbour-folia').registerPreloadScript({
    type: 'frame', filePath: path.join(__dirname, 'folia-fixture-locale-preload.js'),
  });
};
