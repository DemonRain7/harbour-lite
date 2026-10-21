const http = require('node:http');

// desktop/tests/folia-cover-fixture.cjs
// Deterministic local album-art server: original-resolution decodes versus real sized URLs,
// without reaching a provider or putting fixture generation on the measured renderer path.
const ORIGINAL_SIZE = 2048;
const SIZES = [256, 512, 1024, ORIGINAL_SIZE];

function createArtwork(nativeImage, index) {
  const pixels = Buffer.alloc(ORIGINAL_SIZE * ORIGINAL_SIZE * 4);
  for (let y = 0; y < ORIGINAL_SIZE; y++) {
    const color = Buffer.from([(index * 37 + y / 12) % 220, (index * 19 + y / 20) % 190, (index * 53 + y / 16) % 230, 255]);
    pixels.fill(color, y * ORIGINAL_SIZE * 4, (y + 1) * ORIGINAL_SIZE * 4);
  }
  for (let shape = 0; shape < 200; shape++) {
    const left = (shape * 137 + index * 83) % (ORIGINAL_SIZE - 160);
    const top = (shape * 251 + index * 109) % (ORIGINAL_SIZE - 100);
    const color = Buffer.from([(shape * 59) % 255, (index * 23 + shape * 17) % 255, 230, 255]);
    for (let row = top; row < top + 72; row++) {
      pixels.fill(color, (row * ORIGINAL_SIZE + left) * 4, (row * ORIGINAL_SIZE + left + 160) * 4);
    }
  }
  return nativeImage.createFromBitmap(pixels, { width: ORIGINAL_SIZE, height: ORIGINAL_SIZE });
}

async function createCoverFixture(nativeImage, count = 120) {
  const originals = new Map();
  const variants = new Map();
  // Pre-encode every variant before loading the workload, so server work cannot skew the trial.
  for (let index = 0; index < count; index++) {
    const original = createArtwork(nativeImage, index);
    originals.set(index, original.toJPEG(92));
    for (const size of SIZES) {
      variants.set(`${index}:${size}`, size === ORIGINAL_SIZE ? originals.get(index)
        : original.resize({ width: size, height: size, quality: 'best' }).toJPEG(92));
    }
  }
  const requests = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const index = Number(url.searchParams.get('cover'));
    const size = Number(url.searchParams.get('size') ?? ORIGINAL_SIZE);
    const data = variants.get(`${index}:${size}`);
    if (req.method !== 'GET' || url.pathname !== '/getCoverArt' || !data) {
      res.writeHead(404); res.end(); return;
    }
    requests.push({ index, size, bytes: data.length });
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=3600', 'Access-Control-Allow-Origin': '*' });
    res.end(data);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return {
    origin: `http://127.0.0.1:${server.address().port}`,
    report() {
      const unique = new Map(requests.map(item => [`${item.index}:${item.size}`, item]));
      const histogram = {};
      for (const item of unique.values()) histogram[item.size] = (histogram[item.size] ?? 0) + 1;
      return { originalSize: ORIGINAL_SIZE, uniqueVariants: unique.size, requestedSizes: histogram,
        // A workload estimate, NOT measured GPU residency: the browser may evict/cache surfaces.
        requestedDecodedRgbaMiB: [...unique.values()].reduce((total, item) => total + item.size ** 2 * 4, 0) / 1024 ** 2,
        encodedMiB: [...unique.values()].reduce((total, item) => total + item.bytes, 0) / 1024 ** 2 };
    },
    async close() {
      await new Promise(resolve => server.close(resolve));
      variants.clear(); originals.clear();
    },
  };
}

module.exports = { createCoverFixture };
