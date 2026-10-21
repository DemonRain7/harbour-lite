const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { groups, selectGroups, runGroups, nodeMajor, assertNodeVersion } = require('../../scripts/desktop-preflight.cjs');

// desktop/tests/desktop-preflight.test.cjs — guards against local/CI drift and accidental cloud runs.
const root = path.resolve(__dirname, '../..');
const workflow = fs.readFileSync(path.join(root, '.github/workflows/desktop-macos.yml'), 'utf8');
const workflowData = require('gray-matter')(`---\n${workflow}\n---`).data;

test('default local preflight covers every shared CI group in order', () => {
  const inCi = [...workflow.matchAll(/run: node scripts\/desktop-preflight\.cjs --group ([\w-]+)/g)].map(m => m[1]);
  assert.deepEqual(selectGroups([]), inCi);
  assert.deepEqual(selectGroups(['--list']), inCi);
  assert.equal(new Set(inCi).size, inCi.length);
  for (const id of inCi) assert.deepEqual(selectGroups(['--group', id]), [id]);
});

test('manual Mac verification defaults to one architecture; expensive builds remain', () => {
  assert.deepEqual(Object.keys(workflowData.on), ['workflow_dispatch']);
  assert.deepEqual(workflowData.on.workflow_dispatch.inputs.architecture.options, ['arm64', 'x64', 'both']);
  assert.equal(workflowData.jobs.desktop.strategy['max-parallel'], 1);
  assert.match(workflow, /^  workflow_dispatch:/m);
  assert.doesNotMatch(workflow, /^  (push|pull_request|schedule|workflow_run|repository_dispatch):/m);
  assert.match(workflow, /default: arm64/);
  assert.match(workflow, /max-parallel: 1/);
  assert.match(workflow, /fail-fast: true/);
  assert.doesNotMatch(workflow, /continue-on-error/);
  assert.match(workflow, /electron-builder --mac zip/);
  assert.match(workflow, /test:packaged-client/);
});

test('preflight uses the same Node major as CI instead of certifying a different runtime', () => {
  const setup = workflowData.jobs.desktop.steps.find(step => step.uses?.startsWith('actions/setup-node@'));
  assert.equal(String(setup.with['node-version']), String(nodeMajor));
  assert.doesNotThrow(() => assertNodeVersion('v24.21.0'));
  assert.throws(() => assertNodeVersion('v22.20.0'), /match CI/);
  assert.throws(() => assertNodeVersion('v25.0.0'), /match CI/);
});

test('local preflight rejects unknown input and stops at the first failed check', () => {
  assert.throws(() => selectGroups(['--group', 'missing']), /Usage/);
  assert.throws(() => selectGroups(['--group', 'contracts', '--force']), /Usage/);
  assert.throws(() => selectGroups(['--push']), /Usage/);
  let calls = 0;
  assert.throws(() => runGroups(['contracts', 'startup'], () => { calls++; throw new Error('fixture failure'); }), /fixture failure/);
  assert.equal(calls, 1);
});

test('all npm scripts and file entrypoints resolve without inventing a second test suite', () => {
  for (const steps of Object.values(groups)) for (const step of steps) {
    const cwd = path.join(root, step.cwd);
    if (step.node) { assert.ok(fs.existsSync(path.join(cwd, step.node[0]))); continue; }
    if (step.args[0] === 'run') assert.ok(JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'))).scripts[step.args[1]], step.args[1]);
    assert.ok(step.args.every(arg => /^[\w/.:=-]+$/.test(arg)), 'only fixed shell-safe arguments');
  }
});
