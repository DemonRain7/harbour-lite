const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Exercise the exact presentation helper used by the plain-script dashboard.
// The Markdown renderer is a spy: this tests what is folded versus passed on,
// independently of Markdown syntax support or browser layout.
const app = fs.readFileSync(path.resolve(__dirname, '../../web/app.js'), 'utf8');
const start = app.indexOf('function renderCapabilityMarkdown(');
const end = app.indexOf('\nfunction setCapabilityEditing(', start);
assert.ok(start >= 0 && end > start);
const context = vm.createContext({
  esc: value => String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
  renderMarkdownLite: value => `RENDERED:${value}`,
});
vm.runInContext(app.slice(start, end), context);
const render = source => context.renderCapabilityMarkdown(source);

test('capability preview folds frontmatter without rewriting the original source or body', () => {
  const source = '---\nname: example\ndescription: >\n  Long description\n---\n\n# Body\n\nOriginal text';
  const before = Buffer.from(source);
  const output = render(source);
  assert.match(output, /^<details class="cap-frontmatter"><summary>文件元信息/);
  assert.match(output, /<pre>name: example\ndescription: &gt;\n  Long description<\/pre><\/details>RENDERED:\n# Body\n\nOriginal text$/);
  assert.deepEqual(Buffer.from(source), before);
  assert.ok(!output.includes('<details class="cap-frontmatter" open'), 'metadata is collapsed by default');
});

test('BOM and Windows newlines preserve the exact Markdown body', () => {
  const output = render('\uFEFF---\r\nname: windows\r\n---\r\n\r\n# Title\r\nText');
  assert.match(output, /<pre>name: windows<\/pre>/);
  assert.ok(output.endsWith('RENDERED:\r\n# Title\r\nText'));
});

test('YAML closing ellipsis and a metadata-only file are supported', () => {
  assert.ok(render('---\nname: example\n...\nBody').endsWith('RENDERED:Body'));
  assert.ok(render('---\nname: example\n---').endsWith('RENDERED:'));
});

test('plain Markdown, horizontal rules, incomplete frontmatter and later fences stay untouched', () => {
  for (const source of ['', '# Hello\n\nText', '---\nA paragraph\n---\nBody', '---\nname: incomplete', '# Hello\n---\nname: later\n---\nBody']) {
    assert.equal(render(source), `RENDERED:${source}`);
  }
});

test('metadata is escaped, never interpreted as HTML or active content', () => {
  const output = render('---\nname: "</pre><script>bad()</script>"\ndescription: <img src=x onerror=bad()>\n---\nBody');
  assert.ok(!output.includes('<script>'));
  assert.ok(!output.includes('<img'));
  assert.match(output, /&lt;script&gt;bad\(\)&lt;\/script&gt;/);
});
