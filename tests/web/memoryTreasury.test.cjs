const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const app = fs.readFileSync(path.join(__dirname, '../../web/app.js'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '../../web/collections.css'), 'utf8');
const context = vm.createContext({});
vm.runInContext(app.match(/^const MEM_TYPE_LABELS = .*;$/m)[0], context);
for (const name of ['memoryDirectoryOptions', 'memoryPageMatches', 'memoryDocumentBody', 'memoryLocation', 'memoryDisplayTitle']) {
  const match = app.match(new RegExp(`^function ${name}\\([^\\n]*\\) \\{[\\s\\S]*?^}`, 'm'));
  assert.ok(match, name);
  vm.runInContext(match[0], context);
}
const pages = [
  { path: 'treasury/index.md', dir: 'treasury', name: 'index.md', title: '宝库', type: 'Treasure' },
  { path: 'treasury/prompts/index.md', dir: 'treasury/prompts', name: 'index.md', title: '提示词与模板', type: 'Treasure' },
  { path: 'treasury/prompts/sakura.md', dir: 'treasury/prompts', name: 'sakura.md', title: '三渲二樱花车站', description: 'Three.js Web 场景提示词', type: 'Treasure' },
  { path: 'treasury/resources/index.md', dir: 'treasury/resources', name: 'index.md', title: '资料与工具', type: 'Treasure' },
  { path: 'entities/prompts/index.md', dir: 'entities/prompts', name: 'index.md', title: 'index', type: 'Entity' },
];
test('directory picker uses index labels and includes empty categories without copying another tree', () => {
  const options = Array.from(context.memoryDirectoryOptions(pages), item => ({ ...item }));
  assert.ok(options.some(item => item.path === 'treasury/prompts' && item.label === '宝库 / 提示词与模板'));
  assert.ok(options.some(item => item.path === 'treasury/resources' && item.label === '宝库 / 资料与工具'));
  assert.ok(options.some(item => item.path === 'entities/prompts' && item.label === 'entities / prompts'));
  assert.equal(new Set(options.map(item => item.path)).size, options.length);
});
test('directory menu requests its own reading width and keeps the native filter contract', () => {
  assert.match(app, /id="memDirectory"[^>]*aria-label="记忆目录"[^>]*data-hs-menu-width="460"/);
  assert.match(app, /data-hs-menu-title="选择目录"/);
  assert.ok(app.includes("data-hs-description=\"${esc('Memory / ' + dir.path.split('/').join(' / '))}\""), 'full paths remain escaped visible descriptions, not shortened labels');
  const menu = css.match(/\.collection-studio\.memory-studio \.memory-directory-filter \.hs-menu \{([^}]+)\}/)[1];
  assert.match(menu, /scrollbar-width:\s*thin/);
  for (const target of ['hs-value', 'hs-option-text']) {
    const rule = css.match(new RegExp(`\\.collection-studio\\.memory-studio \\.memory-directory-filter \\.${target} \\{([^}]+)\\}`))[1];
    assert.match(rule, /white-space:\s*normal/);
    assert.match(rule, /overflow-wrap:\s*anywhere/);
    assert.match(rule, /text-overflow:\s*clip/);
  }
});
test('deep directory paths keep every ancestor and do not mutate the catalog', () => {
  const dir = 'treasury/prompts/web-scenes/autumn-station/lighting-and-environment-guides';
  const catalog = [...pages, { path: `${dir}/reference.md`, dir, name: 'reference.md', type: 'Treasure' }];
  const before = JSON.stringify(catalog);
  const options = Array.from(context.memoryDirectoryOptions(catalog));
  const parts = dir.split('/');
  for (let depth = 1; depth <= parts.length; depth++) assert.ok(options.some(option => option.path === parts.slice(0, depth).join('/')));
  assert.equal(options.find(option => option.path === dir).label, '宝库 / 提示词与模板 / web-scenes / autumn-station / lighting-and-environment-guides');
  assert.equal(JSON.stringify(catalog), before);
});
test('treasury and child directory filters compose with title, type and case-insensitive search', () => {
  const matches = (query, type, dir) => pages.filter(p => context.memoryPageMatches(p, query, type, dir)).map(p => p.path);
  assert.deepEqual(matches('樱花', 'Treasure', 'treasury'), ['treasury/prompts/sakura.md']);
  assert.deepEqual(matches('three.JS', '', 'treasury/prompts'), ['treasury/prompts/sakura.md']);
  assert.equal(matches('宝库', '', '').length, 4);
  assert.equal(matches('', '', 'treas').length, 0, 'directory prefix must be a complete path component');
  assert.equal(matches('', 'Entity', 'treasury').length, 0);
  assert.equal(matches('', '', 'treasury/resources').length, 1);
  assert.equal(matches('', '', '').length, 5);
});
test('preview hides only leading frontmatter while original input remains intact', () => {
  const raw = '\uFEFF---\r\ntitle: Saved prompt\r\noriginal_sha256: 1234\r\n---\r\n# Body\r\n---\r\nTail';
  assert.equal(context.memoryDocumentBody(raw), '# Body\r\n---\r\nTail');
  assert.match(raw, /original_sha256/);
  assert.equal(context.memoryDocumentBody('# No metadata\n---\nEnd'), '# No metadata\n---\nEnd');
});

test('cards distinguish root, subdirectories, nested directories, and routing files by actual path', () => {
  const location = file => JSON.parse(JSON.stringify(context.memoryLocation({ path: file, title: 'index.md', type: 'Entity' })));
  assert.deepEqual(location('index.md'), { parts: [], filename: 'index.md', directory: '', depth: 0, isIndex: true, level: '根目录' });
  assert.equal(location('entities/index.md').depth, 1);
  assert.equal(location('entities/people/index.md').depth, 2);
  assert.equal(location('entities/places/cafes/harbour.md').depth, 3);
  assert.equal(location('entities/places/cafes/harbour.md').isIndex, false, 'a display title must not turn a normal file into an index');
  assert.deepEqual(location('entities\\people\\INDEX.md').parts, ['entities', 'people']);
  assert.equal(location('entities/people/INDEX.md').isIndex, true);
  assert.equal(location('./note.md').level, '根目录');
  assert.notEqual(location('entities/people/index.md').directory, location('sources/people/index.md').directory);
});

test('untitled generated indexes show their containing directory without rewriting authored titles', () => {
  assert.equal(context.memoryDisplayTitle({ path: 'entities/projects/index.md', title: 'index' }), 'projects');
  assert.equal(context.memoryDisplayTitle({ path: 'index.md' }), '记忆库导航');
  assert.equal(context.memoryDisplayTitle({ path: 'treasury/index.md', title: '宝库' }), '宝库');
  assert.equal(context.memoryDisplayTitle({ path: 'notes.md', title: 'index' }), 'index', 'ordinary authored titles are unchanged');
});
