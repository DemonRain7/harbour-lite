#!/usr/bin/env node
// Offline three-way vendor updates. Fetch the public upstream separately; never
// pull into Harbour, touch its index, or discard its host/localization patches.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createHash, randomUUID } = require('node:crypto');

const DEFAULT_ROOT = path.resolve(__dirname, '..');
const digest = (bytes) => bytes === null ? null : createHash('sha256').update(bytes).digest('hex');
const exists = (file) => { try { return fs.lstatSync(file); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
function canonicalRoot(root) {
  const absolute = path.resolve(root);
  if (exists(absolute)?.isSymbolicLink()) throw new Error(`Symlink/junction is not allowed as workspace root: ${absolute}`);
  // macOS /var and /tmp may themselves be OS aliases. Resolve the explicitly
  // selected workspace once; reject links inside that bounded real workspace.
  return fs.realpathSync(absolute);
}
function git(repo, args, allowed = [0]) {
  const result = spawnSync('git', ['-C', repo, ...args], { windowsHide: true, maxBuffer: 128 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (!allowed.includes(result.status)) throw new Error(`git ${args[0]} failed: ${result.stderr.toString().trim()}`);
  return result;
}
function relativeName(name) {
  if (typeof name !== 'string' || !name || name.includes('\\') || name.includes(':') || name.includes('\0') || path.posix.isAbsolute(name)) throw new Error(`Unsafe path: ${name}`);
  const parts = name.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..' || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) throw new Error(`Unsafe path: ${name}`);
  return name;
}
function safePath(root, name) {
  relativeName(name);
  const base = path.resolve(root);
  let current = base;
  // Also reject junctions/symlinks in the root's existing ancestor chain.
  const ancestors = [];
  for (let p = base; ; p = path.dirname(p)) { ancestors.push(p); if (path.dirname(p) === p) break; }
  for (const p of ancestors.reverse()) if (exists(p)?.isSymbolicLink()) throw new Error(`Symlink/junction is not allowed: ${p}`);
  for (const part of name.split('/')) {
    current = path.join(current, part);
    if (exists(current)?.isSymbolicLink()) throw new Error(`Symlink/junction is not allowed: ${current}`);
  }
  if (!current.startsWith(base + path.sep)) throw new Error(`Path escapes root: ${name}`);
  return current;
}
function protectedName(name) {
  return name === 'UPSTREAM.json' || name.split('/').some((part) => ['.git', 'node_modules'].includes(part) || /^\.env(?:$|\.)/.test(part) && !/\.example$/.test(part)) || /^data(?:\/|$)/.test(name);
}
function readLocal(root, name) {
  const file = safePath(root, name);
  const info = exists(file);
  if (!info) return null;
  if (!info.isFile()) throw new Error(`Expected ordinary file: ${file}`);
  return fs.readFileSync(file);
}
function writeWithin(root, name, bytes) {
  const file = safePath(root, name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, bytes);
}
function tree(repo, ref) {
  const entries = new Map();
  const insensitive = new Set();
  for (const raw of git(repo, ['ls-tree', '-rz', ref]).stdout.toString('utf8').split('\0').filter(Boolean)) {
    const match = /^(\d+) (\w+) ([a-f0-9]+)\t([\s\S]+)$/.exec(raw);
    if (!match) throw new Error('Malformed git tree');
    const [, mode, type, object, name] = match;
    relativeName(name);
    const key = name.toLowerCase();
    if (insensitive.has(key)) throw new Error(`Case-colliding upstream path: ${name}`);
    insensitive.add(key);
    entries.set(name, { mode, type, object });
  }
  return entries;
}
function commit(repo, ref) {
  if (typeof ref !== 'string' || !/^[a-f0-9]{7,40}$/i.test(ref)) throw new Error('Use an explicit upstream commit hash (not a branch or option).');
  return git(repo, ['rev-parse', '--verify', `${ref}^{commit}`]).stdout.toString().trim();
}
function blob(repo, entry) {
  if (!entry) return null;
  if (entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode)) throw new Error('Upstream symlinks/submodules are not automatically imported.');
  return git(repo, ['cat-file', 'blob', entry.object]).stdout;
}
function textBytes(bytes) {
  if (bytes === null || bytes.includes(0)) return false;
  try { new TextDecoder('utf-8', { fatal: true }).decode(bytes); return true; } catch { return false; }
}
function conflictMarkers(bytes) {
  // A standalone ======= is also a valid Markdown/README heading underline.
  // Git conflicts always have outer markers (and diff3 may have a base marker);
  // keep rejecting those even if an incomplete manual edit removed one side.
  return textBytes(bytes) && /^(?:<{7,}|>{7,}|\|{7,})(?: .*)?\r?$/m.test(bytes.toString('utf8'));
}
function normalized(bytes) { return textBytes(bytes) ? Buffer.from(bytes.toString('utf8').replace(/\r\n/g, '\n')) : bytes; }
function same(a, b) { return a === null ? b === null : b !== null && normalized(a).equals(normalized(b)); }
function writeManifest(directory, manifest) {
  writeWithin(directory, 'plan.json', JSON.stringify(manifest, null, 2) + '\n');
}
function loadPlan(root, plan) {
  root = canonicalRoot(root);
  const absolutePlan = path.resolve(plan || '');
  if (exists(absolutePlan)?.isSymbolicLink()) throw new Error('Plan directory cannot be a symlink/junction.');
  const directory = fs.realpathSync(absolutePlan);
  const rel = path.relative(root, directory).split(path.sep).join('/');
  if (!/^tmp\/folia-upstream-update-[^/]+$/.test(rel)) throw new Error('Plan must be an update directory inside this workspace tmp/.');
  safePath(root, rel);
  const manifest = JSON.parse(readLocal(directory, 'plan.json')?.toString('utf8') || 'null');
  if (!manifest || manifest.version !== 1 || manifest.root !== root || manifest.vendor !== safePath(root, 'vendor/folia') || !Array.isArray(manifest.entries) || manifest.error) throw new Error('Invalid or incomplete plan.');
  return { directory, manifest, root };
}

function planUpdate({ root = DEFAULT_ROOT, upstream, target }) {
  root = canonicalRoot(root);
  upstream = path.resolve(upstream || '');
  const vendor = safePath(root, 'vendor/folia');
  const metadata = readLocal(vendor, 'UPSTREAM.json');
  if (!metadata) throw new Error('Missing vendor/folia/UPSTREAM.json');
  const base = commit(upstream, JSON.parse(metadata.toString('utf8')).commit);
  target = commit(upstream, target);
  const before = tree(upstream, base);
  const after = tree(upstream, target);
  const temporary = safePath(root, 'tmp');
  fs.mkdirSync(temporary, { recursive: true });
  // Staged source/conflict reports must not accidentally be published.
  git(root, ['check-ignore', '--quiet', 'tmp/folia-upstream-update-check']);
  const directory = fs.mkdtempSync(path.join(temporary, 'folia-upstream-update-'));
  const manifest = { version: 1, root, vendor, upstream, base, target, metadataHash: digest(metadata), createdAt: new Date().toISOString(), entries: [] };
  const names = [...new Set([...before.keys(), ...after.keys()])].sort();
  try {
    for (const name of names) {
      const oldEntry = before.get(name);
      const newEntry = after.get(name);
      if (oldEntry?.object === newEntry?.object && oldEntry?.mode === newEntry?.mode) continue;
      if (protectedName(name)) throw new Error(`Protected runtime/local path in upstream delta: ${name}`);
      const previous = blob(upstream, oldEntry);
      const incoming = blob(upstream, newEntry);
      const local = readLocal(vendor, name);
      let candidate = incoming;
      let status = 'upstream';
      if (same(local, incoming)) { candidate = local; status = 'already-current'; }
      else if (!same(local, previous)) {
        status = 'conflict';
        candidate = local === null ? incoming : local;
        if (local !== null && previous !== null && incoming !== null && [local, previous, incoming].every(textBytes)) {
          writeWithin(directory, `merge-local/${name}`, normalized(local));
          writeWithin(directory, `merge-base/${name}`, normalized(previous));
          writeWithin(directory, `merge-upstream/${name}`, normalized(incoming));
          const merged = git(upstream, ['merge-file', '-p', '-L', 'HARBOUR', '-L', 'PINNED-UPSTREAM', '-L', 'NEW-UPSTREAM', safePath(directory, `merge-local/${name}`), safePath(directory, `merge-base/${name}`), safePath(directory, `merge-upstream/${name}`)], Array.from({ length: 128 }, (_, i) => i));
          candidate = merged.stdout;
          if (merged.status === 0) status = 'merged';
        }
      }
      if (local !== null) writeWithin(directory, `original/${name}`, local);
      if (previous !== null) writeWithin(directory, `base/${name}`, previous);
      if (incoming !== null) writeWithin(directory, `upstream/${name}`, incoming);
      if (candidate !== null) writeWithin(directory, `candidate/${name}`, candidate);
      manifest.entries.push({ path: name, status, originalHash: digest(local), candidateHash: digest(candidate), upstreamHash: digest(incoming), targetMode: newEntry?.mode || null, action: candidate === null ? 'delete' : 'write' });
    }
    writeManifest(directory, manifest);
    return { directory, base, target, files: manifest.entries.length, conflicts: manifest.entries.filter((e) => e.status === 'conflict').map((e) => e.path) };
  } catch (error) {
    manifest.error = error.message;
    writeManifest(directory, manifest);
    throw new Error(`${error.message}\nIncomplete plan retained at ${directory}`);
  }
}

function applyUpdate({ root = DEFAULT_ROOT, plan, resolved = [], deleted = [] }) {
  const { directory, manifest } = loadPlan(root, plan);
  if (manifest.appliedAt) throw new Error('This plan is already applied.');
  if (digest(readLocal(manifest.vendor, 'UPSTREAM.json')) !== manifest.metadataHash) throw new Error('UPSTREAM.json changed since planning; create a fresh plan.');
  const resolvedSet = new Set(resolved.map(relativeName));
  const deletedSet = new Set(deleted.map(relativeName));
  const names = new Set();
  const writes = [];
  // Validate every action before the first vendor write. Never infer deletion
  // merely because a candidate is missing after a manual edit.
  for (const entry of manifest.entries) {
    const name = relativeName(entry.path);
    if (protectedName(name) || names.has(name.toLowerCase())) throw new Error(`Invalid/protected duplicate path: ${name}`);
    names.add(name.toLowerCase());
    if (!['upstream', 'merged', 'conflict', 'already-current'].includes(entry.status) || !['write', 'delete'].includes(entry.action) || ![null, '100644', '100755'].includes(entry.targetMode)) throw new Error(`Invalid action: ${name}`);
    if (digest(readLocal(manifest.vendor, name)) !== entry.originalHash) throw new Error(`Vendor changed since planning: ${name}. Create a fresh plan; no files were applied.`);
    if (entry.status === 'conflict' && !resolvedSet.has(name)) throw new Error(`Unresolved conflict: ${name}. Edit candidate, then explicitly pass --resolved "${name}".`);
    if (deletedSet.has(name) && (entry.status !== 'conflict' || (entry.targetMode !== null && entry.originalHash !== null))) throw new Error(`--delete only resolves an upstream/local deletion conflict: ${name}`);
    const deleting = deletedSet.has(name) || entry.action === 'delete';
    const candidate = deleting ? null : readLocal(directory, `candidate/${name}`);
    if (!deleting && candidate === null) throw new Error(`Missing candidate: ${name}`);
    if (candidate !== null && conflictMarkers(candidate)) throw new Error(`Conflict markers remain: ${name}`);
    if (entry.status !== 'conflict' && !resolvedSet.has(name) && digest(candidate) !== entry.candidateHash) throw new Error(`Candidate edited without acknowledgement: ${name}; pass --resolved to review this change.`);
    writes.push({ entry, candidate });
  }
  for (const name of [...resolvedSet, ...deletedSet]) if (!names.has(name.toLowerCase())) throw new Error(`Unknown resolution path: ${name}`);
  manifest.applyingAt = new Date().toISOString();
  manifest.appliedPaths = [];
  writeManifest(directory, manifest);
  for (const { entry, candidate } of writes) {
    const destination = safePath(manifest.vendor, entry.path);
    if (digest(readLocal(manifest.vendor, entry.path)) !== entry.originalHash) throw new Error(`Vendor changed during apply: ${entry.path}; completed paths and originals are retained in the plan.`);
    if (candidate === null) {
      if (exists(destination)) fs.unlinkSync(destination); // Exact file; original retained in plan/original.
    } else {
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      const temp = `${destination}.folia-update-${randomUUID()}`;
      fs.writeFileSync(temp, candidate);
      fs.renameSync(temp, destination);
      if (process.platform !== 'win32' && entry.targetMode) fs.chmodSync(destination, entry.targetMode === '100755' ? 0o755 : 0o644);
    }
    manifest.appliedPaths.push(entry.path);
    writeManifest(directory, manifest);
  }
  manifest.appliedAt = new Date().toISOString();
  writeManifest(directory, manifest);
  return { directory, files: writes.length, target: manifest.target, message: 'Applied reviewed candidates. Update UPSTREAM.json only after review/tests; original files remain in plan/original.' };
}

function blobDigest(bytes) {
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
}
function recordUpdate({ root = DEFAULT_ROOT, plan }) {
  const { directory, manifest } = loadPlan(root, plan);
  if (!manifest.appliedAt) throw new Error('Apply the reviewed update and run tests before recording its upstream pin.');
  const metadata = JSON.parse(readLocal(manifest.vendor, 'UPSTREAM.json').toString('utf8'));
  if (![manifest.base, manifest.target].includes(metadata.commit)) throw new Error('Upstream pin changed to another update; cannot record this plan.');
  const target = commit(manifest.upstream, manifest.target);
  const latest = tree(manifest.upstream, target);
  const localNames = git(manifest.root, ['ls-files', '-co', '--exclude-standard', '-z', '--', 'vendor/folia']).stdout.toString('utf8').split('\0').filter(Boolean).map((name) => name.slice('vendor/folia/'.length));
  const hostPatches = [];
  const hostDeletedPaths = [];
  for (const name of [...new Set([...latest.keys(), ...localNames])].sort()) {
    relativeName(name);
    if (protectedName(name) || name === '.gitignore') continue;
    const entry = latest.get(name);
    const local = readLocal(manifest.vendor, name);
    if (local === null) { if (entry) hostDeletedPaths.push(name); continue; }
    if (conflictMarkers(local)) throw new Error(`Conflict markers remain in vendor: ${name}`);
    if (!entry) { hostPatches.push(name); continue; }
    if (entry.type !== 'blob' || !['100644', '100755'].includes(entry.mode)) throw new Error(`Cannot record unsupported upstream symlink/submodule: ${name}`);
    // Avoid one Git process per unchanged source/asset. Only real host deltas
    // and upstream CRLF files need the slower normalized byte comparison.
    if (blobDigest(local) === entry.object || blobDigest(normalized(local)) === entry.object) continue;
    if (!same(local, blob(manifest.upstream, entry))) hostPatches.push(name);
  }
  const upstreamPackage = JSON.parse(blob(manifest.upstream, latest.get('package.json')).toString('utf8'));
  if (typeof upstreamPackage.version !== 'string') throw new Error('Upstream package has no version.');
  const updated = {
    ...metadata, commit: target, version: upstreamPackage.version, hostPatches, hostDeletedPaths,
    updatePolicy: 'Pinned three-way update via scripts/folia-upstream.cjs plan/apply/record; review conflicts and run tests before record. Folia installers must never update Harbour.',
  };
  writeWithin(manifest.vendor, 'UPSTREAM.json', JSON.stringify(updated, null, 2) + '\n');
  manifest.recordedAt = new Date().toISOString();
  writeManifest(directory, manifest);
  return { target, version: upstreamPackage.version, hostPatches: hostPatches.length, hostDeletedPaths: hostDeletedPaths.length, message: 'Recorded current vendor deltas. This command does not run or certify tests.' };
}

function cli(argv) {
  const command = argv.shift();
  const options = { resolved: [], deleted: [] };
  while (argv.length) {
    const flag = argv.shift();
    const value = argv.shift();
    if (!value || value.startsWith('--')) throw new Error(`Missing value for ${flag}`);
    if (flag === '--resolved') options.resolved.push(value);
    else if (flag === '--delete') options.deleted.push(value);
    else if (['--root', '--upstream', '--target', '--plan'].includes(flag)) options[flag.slice(2)] = value;
    else throw new Error(`Unknown argument: ${flag}`);
  }
  if (command === 'plan') return planUpdate(options);
  if (command === 'apply') return applyUpdate(options);
  if (command === 'record') return recordUpdate(options);
  throw new Error('Usage: folia-upstream.cjs plan --upstream <git-repo> --target <commit> | apply --plan <staged-directory> [--resolved <path>] [--delete <path>] | record --plan <staged-directory>');
}
if (require.main === module) { try { console.log(JSON.stringify(cli(process.argv.slice(2)), null, 2)); } catch (error) { console.error(error.message); process.exitCode = 1; } }
module.exports = { planUpdate, applyUpdate, recordUpdate, relativeName, safePath, conflictMarkers, cli };
