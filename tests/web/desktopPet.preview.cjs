// Real pet renderer + isolated desktop IPC fixture. No Electron windows, model calls,
// user character/config files, production backend, or persistent writes.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../../web');
const bootstrap = `<script>
const fixtureQuery = new URLSearchParams(location.search);
const fixturePet = fixtureQuery.get('pet') || 'aemeath';
const fixtureScenario = fixtureQuery.get('scenario') || 'missing';
const fixtureName = fixturePet === 'elaina' ? 'Elaina' : 'Aemeath';
const fixtureHost = document.getElementById('desktopPet');
window.harbourDesktop = {
  serverUrl: location.origin, isElectron: true, usesSharedCompanionBridge: true,
  petContext: { id: fixturePet, agentName: 'main-' + fixturePet, displayName: fixtureName },
  setPetInputRegions(regions, id) { fixtureHost.dataset.testRegions = JSON.stringify(regions); fixtureHost.dataset.testRegionPet = id; },
  getCompanionCharacter() {
    fixtureHost.dataset.testInputBeforeLoad = String(!!fixtureHost.dataset.testRegions);
    return fixtureScenario === 'pending' ? new Promise(() => {}) : Promise.resolve({ manifest: { displayName: fixtureName, visual: { live2d: { enabled: false } } }, assetBase: location.origin + '/' });
  },
  async getCompanionState() { return { characters: {}, activities: [], appearance: {} }; },
  onCompanionState() { return () => {}; }, onCompanionEvent() { return () => {}; },
  async openDashboard() { fixtureHost.dataset.testDashboard = 'opened'; return true; },
  async hidePet(id) { fixtureHost.dataset.testClosed = id; return true; },
};
if (fixtureScenario === 'live2d-error') window.HarbourLive2D.createHost = async () => { throw new Error('Synthetic Live2D failure'); };
</script>`;
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (req.method !== 'GET') { res.writeHead(405).end(); return; }
  if (url.pathname === '/api/asks') { res.setHeader('Content-Type', 'application/json'); res.end('{"asks":[]}'); return; }
  if (url.pathname === '/assets/pets/broken/pet.json') {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ displayName: 'Aemeath', spritesheetPath: 'missing.webp', cellWidth: 192, cellHeight: 208 })); return;
  }
  const file = path.resolve(root, '.' + (url.pathname === '/' ? '/desktop-pet.html' : url.pathname));
  if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404).end(); return; }
  let body = fs.readFileSync(file);
  if (file.endsWith('desktop-pet.html')) body = body.toString().replace('<script src="./desktop-pet.js"></script>', bootstrap + '<script src="./desktop-pet.js"></script>');
  res.setHeader('Content-Type', ({ '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.webp': 'image/webp' })[path.extname(file)] || 'application/octet-stream');
  res.end(body);
});
server.listen(0, '127.0.0.1', () => console.log('Desktop pet fixture: http://127.0.0.1:' + server.address().port));
