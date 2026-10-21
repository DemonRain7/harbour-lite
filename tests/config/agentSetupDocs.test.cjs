const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const readme = read('README.md');
const guide = read('docs/AGENT-SETUP.md');

test('README exposes a one-line copyable Agent setup prompt', () => {
  const prompt = readme.match(/```text\r?\n([^\n]+)\r?\n```/);
  assert.ok(prompt, 'the primary prompt must be one line in a copyable code block');
  for (const required of ['docs/AGENT-SETUP.md', 'AGENTS.md', '独立目录', '不重写 UI', '密钥', '版本不匹配']) {
    assert.ok(prompt[1].includes(required), required);
  }
  assert.ok(readme.indexOf('## 让你的 Agent 帮你装好') < readme.indexOf('## 启动'));
});

test('handoff references shipped files and existing commands', () => {
  for (const file of ['AGENTS.md', 'README.md', '.env.example', '.npmrc', 'scripts/desktop-launch.js',
    'desktop/startup.config.example.json', 'agents/main-assistant/CLAUDE.md', 'demo/VIDEO-NOTES.md']) {
    assert.ok(fs.existsSync(path.join(root, file)), file);
    assert.ok(guide.includes(file) || file === 'README.md', `guide references ${file}`);
  }
  const pkg = JSON.parse(read('package.json'));
  for (const script of ['serve', 'desktop', 'typecheck', 'test:public', 'test:public-ui']) {
    assert.ok(pkg.scripts[script], script);
  }
});

test('setup distinguishes mock, cloud requests, credentials and display assets', () => {
  for (const text of ['MOCK_LLM=true', 'MOCK_LLM=false', 'HARBOUR_MIGRATE_LEGACY=false',
    '不要自动公开任何本机配置', '图片、Agent 人设、TTS 音色、Live2D 是独立配置',
    '请求会发给用户所选服务商', '真实模型的首次测试先说明']) assert.ok(guide.includes(text), text);
  assert.match(guide, /if \(!\(Test-Path \.env\)\)/);
  assert.doesNotMatch(guide, /Co-Authored-By|Users[\\/]\d{4,}|sk-[A-Za-z0-9]{20}/i);
});
