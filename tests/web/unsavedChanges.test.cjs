const { test } = require('node:test');
const assert = require('node:assert/strict');
const { create, normalize } = require('../../web/unsaved-changes.js');

function fixture(action = 'stay') {
  const state = { value: 'draft', saved: '', active: true, busy: false, asks: 0, discards: 0, saves: 0, notices: [] };
  const guard = create({ ask: async () => { state.asks++; return typeof action === 'function' ? action() : action; }, notify: async text => state.notices.push(text) });
  guard.register('file', {
    label: 'agents/example/CLAUDE.md', isActive: () => state.active,
    isDirty: () => normalize(state.value) !== normalize(state.saved), isBusy: () => state.busy,
    version: () => state.value,
    save: async () => { state.saves++; if (state.fail) return false; state.saved = state.value; return true; },
    discard: () => { state.discards++; state.value = state.saved; return true; },
  });
  return { guard, state };
}

test('persistent Town survives sidebar routing but still blocks reload/close/quit; other editors stay guarded', async () => {
  const labels = [];
  const guard = create({ ask: async list => { labels.push(list); return 'stay'; } });
  guard.register('town', { label: 'Town', preserveOnPageChange: true, isActive: () => true, isDirty: () => true });
  assert.equal(await guard.requestLeave({ reason: 'page' }), true);
  assert.equal(guard.hasChanges(), true);
  for (const reason of ['reload', 'close', 'quit', 'navigate']) assert.equal(await guard.requestLeave({ reason }), false);
  assert.deepEqual(labels, [['Town'], ['Town'], ['Town'], ['Town']]);
  guard.register('editor', { label: 'Editor', isActive: () => true, isDirty: () => true });
  assert.equal(await guard.requestLeave({ reason: 'page' }), false);
  assert.deepEqual(labels.at(-1), ['Editor']);
});

test('CRLF and undo are clean; inactive editors do not block', async () => {
  const { guard, state } = fixture();
  state.saved = 'a\r\nb\r\n'; state.value = 'a\nb\n';
  assert.equal(guard.hasChanges(), false); assert.equal(await guard.requestLeave(), true);
  state.value = 'edited'; state.active = false;
  assert.equal(await guard.requestLeave(), true); assert.equal(state.asks, 0);
});
test('stay and failed save retain exact draft', async () => {
  const staying = fixture(); assert.equal(await staying.guard.requestLeave(), false); assert.equal(staying.state.value, 'draft');
  const saving = fixture('save'); saving.state.fail = true;
  assert.equal(await saving.guard.requestLeave(), false); assert.equal(saving.state.value, 'draft');
});
test('discard cleans state and successful save settles before navigation', async () => {
  for (const action of ['discard', 'save']) {
    const { guard, state } = fixture(action);
    assert.equal(await guard.requestLeave(), true); assert.equal(guard.hasChanges(), false);
    assert.equal(state[action === 'save' ? 'saves' : 'discards'], 1);
  }
});
test('parallel leave intents cannot open competing dialogs or perform duplicate saves', async () => {
  let decide; const { guard, state } = fixture(() => new Promise(resolve => { decide = resolve; }));
  const first = guard.requestLeave();
  assert.equal(await guard.requestLeave(), false); assert.equal(state.asks, 1);
  decide('save'); assert.equal(await first, true); assert.equal(state.saves, 1);
});
test('saving editor blocks another leave without opening a second decision', async () => {
  const { guard, state } = fixture('discard'); state.busy = true;
  assert.equal(await guard.requestLeave(), false); assert.equal(state.asks, 0); assert.equal(state.discards, 0);
});
test('newer edits invalidate a decision instead of silently discarding them', async () => {
  let decide; const { guard, state } = fixture(() => new Promise(resolve => { decide = resolve; }));
  const leaving = guard.requestLeave(); state.value = 'newer draft'; decide('discard');
  assert.equal(await leaving, false); assert.equal(state.value, 'newer draft');
});
test('quit preflight and cancellation are non-destructive', async () => {
  const { guard, state } = fixture('discard');
  assert.equal(await guard.requestLeave({ reason: 'quit', phase: 'check' }), true);
  assert.equal(state.discards, 0);
  assert.equal(await guard.requestLeave({ reason: 'quit', phase: 'cancel' }), true);
  assert.equal(state.value, 'draft');
  assert.equal(await guard.requestLeave({ reason: 'quit', phase: 'commit' }), false);
});
test('quit discard commit retains draft if a different window later fails', async () => {
  const { guard, state } = fixture('discard');
  await guard.requestLeave({ reason: 'quit', phase: 'check' });
  assert.equal(await guard.requestLeave({ reason: 'quit', phase: 'commit' }), true);
  await guard.requestLeave({ reason: 'quit', phase: 'cancel' });
  assert.equal(state.discards, 0); assert.equal(state.value, 'draft');
});
test('quit commit requires the same draft version; save failure cancels', async () => {
  const changing = fixture('discard'); await changing.guard.requestLeave({ reason: 'quit', phase: 'check' }); changing.state.value += '!';
  assert.equal(await changing.guard.requestLeave({ reason: 'quit', phase: 'commit' }), false);
  const saving = fixture('save'); saving.state.fail = true; await saving.guard.requestLeave({ reason: 'quit', phase: 'check' });
  assert.equal(await saving.guard.requestLeave({ reason: 'quit', phase: 'commit' }), false);
});
test('quit rejects an additional editor that became dirty after preflight', async () => {
  const { guard } = fixture('discard'); let second = '';
  guard.register('second', { isActive: () => true, isDirty: () => !!second, version: () => second, discard: () => { second = ''; return true; } });
  await guard.requestLeave({ reason: 'quit', phase: 'check' }); second = 'late edit';
  assert.equal(await guard.requestLeave({ reason: 'quit', phase: 'commit' }), false);
  assert.equal(second, 'late edit');
});
test('successful quit preflight suspends input, cancellation restores it even for a clean editor', async () => {
  const suspensions = []; const guard = create({ ask: async () => 'stay', setSuspended: value => suspensions.push(value) });
  assert.equal(await guard.requestLeave({ reason: 'quit', phase: 'check' }), true);
  await guard.requestLeave({ reason: 'quit', phase: 'cancel' });
  assert.deepEqual(suspensions, [true, false]);
});
test('unregistering an old editor cannot unregister its replacement', () => {
  const guard = create({ ask: async () => 'stay' });
  const dispose = guard.register('file', { isActive: () => true, isDirty: () => false });
  guard.register('file', { isActive: () => true, isDirty: () => true }); dispose();
  assert.equal(guard.hasChanges(), true);
});
