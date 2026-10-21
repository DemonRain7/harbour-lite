const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const app = fs.readFileSync(require('node:path').join(__dirname, '../../web/app.js'), 'utf8');
function source(name) {
  const found = app.match(new RegExp(`^(?:async )?function ${name}\\([^\\n]*\\) \\{[\\s\\S]*?^}`, 'm'));
  assert.ok(found, name); return found[0];
}
function fixture(kind) {
  const nodes = new Map(), calls = [];
  const state = { raw: '', file: null, filePath: null, editing: false };
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { isConnected: true, textContent: '', innerHTML: '', hidden: false, open: false, dataset: {}, querySelector: () => node(id + '-child') });
    return nodes.get(id);
  };
  const context = vm.createContext({
    $: node, capView: state, memView: state, esc: String,
    MEM_TYPE_COLORS: { Page: '#aaa' }, MEM_TYPE_LABELS: {}, collectionIcon: () => '', memoryPathHtml: page => page.path,
    editorText: value => String(value ?? '').replace(/\r\n?/g, '\n'), docViewMode: () => 'raw',
    applyCapabilityDocView() {}, applyMemDocView() {},
    setCapabilityEditing: value => { state.editing = value; }, setMemEditing: value => { state.editing = value; },
    api: () => new Promise((resolve, reject) => calls.push({ resolve, reject })),
  });
  vm.runInContext(source('memoryLocation'), context);
  vm.runInContext(source('memoryDisplayTitle'), context);
  vm.runInContext(source(kind === 'memory' ? 'viewMemFile' : 'loadCapabilityFile'), context);
  return { state, calls, node, open: path => {
    if (kind === 'memory') return context.viewMemFile(path);
    state.file = path; return context.loadCapabilityFile();
  } };
}

test('memory: returning to catalog invalidates an in-flight file read', async () => {
  const f = fixture('memory'), pending = f.open('A.md');
  f.state.request = null; f.state.filePath = null; f.state.raw = '';
  f.calls[0].resolve({ content: 'stale content' }); await pending;
  assert.equal(f.state.raw, '');
});

test('memory: read failure settles loading with an explicit error, not editable blank content', async () => {
  const f = fixture('memory'), pending = f.open('missing.md');
  f.calls[0].reject(new Error('unavailable')); await pending;
  assert.equal(f.state.loading, false);
  assert.equal(f.state.error, 'unavailable');
  assert.equal(f.state.editing, false);
});
for (const kind of ['memory', 'capability']) for (const lateResult of ['success', 'failure']) {
  test(`${kind}: late ${lateResult} from A cannot replace B baseline or create phantom changes`, async () => {
    const f = fixture(kind); const old = f.open('A.md'), current = f.open('B.md');
    f.calls[1].resolve({ content: 'B\r\nbody\r\n' }); await current;
    f.state.editing = true;
    if (lateResult === 'success') f.calls[0].resolve({ content: 'A old content' });
    else f.calls[0].reject(new Error('late failed request'));
    await old;
    assert.equal(f.state.raw, 'B\nbody\n'); assert.equal(f.state.editing, true);
    assert.equal(f.node(kind === 'memory' ? '#memViewerBody' : '#capViewerBody').textContent, 'B\nbody\n');
  });
}
