import { execFileSync } from 'node:child_process';
import { readFileSync, lstatSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const files = [
  ...new Set(
    execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
      cwd: root,
      encoding: 'utf8',
    })
      .split('\0')
      .filter(Boolean),
  ),
];
const rootFiles = new Set([
  '.env.example',
  '.gitattributes',
  '.gitignore',
  '.prettierrc.json',
  'AGENTS.md',
  'CONTRIBUTING.md',
  'LICENSE',
  'README.md',
  'SECURITY.md',
  'THIRD_PARTY_NOTICES.md',
  'package.json',
  'package-lock.json',
  'tsconfig.json',
]);
const allowed = [
  /^src\/[\w-]+\.ts$/,
  /^web\/(index\.html|styles\.css|app\.js|favicon\.svg)$/,
  /^tests\/[\w.-]+\.ts$/,
  /^scripts\/[\w.-]+\.(ts|mjs)$/,
  /^docs\/[A-Z-]+\.md$/,
  /^docs\/media\/(intro\.mp4|poster\.png|contact-sheet\.png|workbench\.png|appearance\.png)$/,
  /^agents\/(assistant|planner)\/CLAUDE\.md$/,
  /^skills\/(clear-writing|task-planning)\/SKILL\.md$/,
  /^desktop\/(main\.cjs|package(-lock)?\.json)$/,
  /^demo\/(\.gitignore|package(-lock)?\.json|tsconfig\.json|VIDEO-NOTES\.md)$/,
  /^demo\/(src|scripts)\/[\w/-]+\.(tsx?|mjs)$/,
  /^\.github\/(workflows\/ci\.yml|dependabot\.yml)$/,
];
const patterns = [
  [
    'personal home path',
    /(?:[a-z]:[\\/]Users[\\/](?!Public\b|Default\b)[^\s/\\]+|\/Users\/[^\s/]+|\/home\/[^\s/]+)/i,
  ],
  ['private key', /-----BEGIN (?:RSA |OPENSSH |EC )?PRIVATE KEY-----/],
  ['GitHub token', /\b(?:gh[pousr]_[A-Za-z0-9]{25,}|github_pat_[A-Za-z0-9_]{30,})\b/],
  ['provider secret', /\b(?:sk-(?:proj-|ant-)?[A-Za-z0-9_-]{24,}|AKID[A-Za-z0-9]{28,})\b/],
  [
    'private address',
    /\b(?:192\.168\.[0-9]{1,3}\.[0-9]{1,3}|10\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3})\b/,
  ],
];
const errors = [];
for (const file of files) {
  if (
    !rootFiles.has(file) &&
    file !== 'demo/src/global.css' &&
    !allowed.some((pattern) => pattern.test(file))
  ) {
    errors.push(`${file}: not in the reviewed public-file allowlist`);
    continue;
  }
  const absolute = path.join(root, file);
  const info = lstatSync(absolute);
  if (info.isSymbolicLink() || !info.isFile()) {
    errors.push(`${file}: non-regular file`);
    continue;
  }
  if (info.size > 8 * 1024 * 1024) errors.push(`${file}: unexpectedly large file`);
  if (/\.(png|mp4)$/.test(file)) continue;
  const text = readFileSync(absolute, 'utf8');
  for (const [label, pattern] of patterns) if (pattern.test(text)) errors.push(`${file}: ${label}`);
  if (/^\.env/.test(file) && file !== '.env.example')
    errors.push(`${file}: environment file must never be published`);
}
const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
  .split('\0')
  .filter(Boolean);
if (tracked.some((file) => /(?:^|\/)(?:data|node_modules|\.claude|\.codex)\//.test(file)))
  errors.push('Private or generated directory is tracked.');
if (!files.length) errors.push('No files found; run from a Git repository.');
if (errors.length) {
  console.error(errors.join('\n'));
  process.exitCode = 1;
} else
  console.log(
    `Public audit passed: ${files.length} reviewed paths; no configured secret/path patterns found. Manual review of content and media is still required.`,
  );
