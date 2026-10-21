const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const vm = require('node:vm');
const trace = require('../../web/trace-progress.js');
const app = fs.readFileSync(require('node:path').join(__dirname, '../../web/app.js'), 'utf8');
const event = (msg, data = {}) => ({ msg, agent: 'main-test', traceId: 'root', tag: msg, text: msg, ...data });
const plan = (id = 'global', scope = 'task', revision = 1) => ({ id, scope, revision, title: '<script>不能执行</script>', owner: 'main-test',
  steps: [{ n: 1, title: '调查', status: 'completed' }, { n: 2, title: '实现', status: 'in_progress' }, { n: 3, title: '验收', status: 'pending' }] });

test('parallel and repeated same-name agents get separate rings; no guessed percentage', () => {
  const events = [event('loop:start'), event('spawn_subagent', { to: 'worker' }),
    event('loop:start', { agent: 'worker', traceId: 'c1', parentTraceId: 'root', depth: 1 }),
    event('loop:start', { agent: 'worker', traceId: 'c2', parentTraceId: 'root', depth: 1 }),
    event('loop:end', { agent: 'worker', traceId: 'c1', parentTraceId: 'root', status: 'failed', depth: 1 })];
  const model = trace.buildModel(events, { agent: 'main-test' });
  assert.equal(model.lanes.length, 3);
  assert.equal(model.lanes[1].state, 'failed');
  assert.equal(model.lanes[2].state, 'active');
  assert.equal(model.lanes[0].total, 0);
  assert.match(trace.render(model), /is-indeterminate/);
  assert.doesNotMatch(trace.render(model), /\d+%/);
});

test('overall and local checklists remain isolated; stale reconnect cannot roll back a revision', () => {
  const updated = plan('global', 'task', 3), stale = plan('global', 'task', 1);
  updated.steps[1].title = '<script>不能执行</script>';
  stale.steps[0].status = 'pending';
  const model = trace.buildModel([event('progress:updated', { progress: updated }), event('progress:updated', { progress: stale }),
    event('progress:updated', { progress: plan('local', 'workflow') })], { agent: 'main-test' });
  assert.equal(model.plans.get('global').revision, 3);
  assert.equal(model.lanes[0].done, 1);
  assert.equal(model.lanes[0].plans.length, 2);
  assert.equal(model.lanes[0].primary.id, 'global');
  const html = trace.render(model);
  assert.match(html, /总计划/); assert.match(html, /Workflow · 局部/);
  assert.doesNotMatch(html, /<script>/); assert.match(html, /&lt;script&gt;/);
});

test('planner termination and spawn never mark a task done; final answer is not execution evidence', () => {
  const p = { goal: '做事', id: 'p', steps: [{ n: 1, title: '研究', agent: 'worker' }] };
  const model = trace.buildModel([event('plan:submitted', { agent: 'orchestrator', traceId: 'planner', parentTraceId: 'root', plan: p }),
    event('loop:end', { agent: 'orchestrator', traceId: 'planner', parentTraceId: 'root', status: 'completed' }),
    event('spawn_subagent', { to: 'worker' }), event('loop:final')], { agent: 'main-test' });
  assert.equal(model.lanes[0].done, 0);
  assert.equal(model.lanes[0].total, 1);
  assert.equal(model.lanes[0].state, 'active');
  assert.doesNotMatch(app, /planDone \|\|= \{\}\)\[hit.n\] = true/);
});

test('historical or incomplete runs stop animating without claiming unfinished todos completed', () => {
  const model = trace.buildModel([event('progress:updated', { progress: plan() })], { agent: 'main-test', live: false });
  assert.equal(model.lanes[0].state, 'ended');
  assert.match(model.lanes[0].stage, /未全部完成/);
  assert.doesNotMatch(trace.render(model), /is-indeterminate/);
  const old = trace.buildModel([{ cls: 'call', tag: 'STEP 1', text: 'legacy', agent: 'main-test', depth: 0 }, { cls: 'result', tag: 'bash', text: 'old worker', agent: 'worker', depth: 1 }], { agent: 'main-test', live: false });
  assert.equal(old.lanes.length, 2);
  assert.equal(old.lanes[0].title, '本轮执行');
  assert.equal(old.lanes[1].title, ''); // no duplicate agent-name headline
});

test('completed stages enter wrap-up; scope controls do not move on progress updates', () => {
  const p = plan(); p.steps.forEach(step => { step.status = 'completed'; });
  const events = [event('progress:updated', { progress: plan('local', 'workflow') }), event('progress:updated', { progress: p })];
  const model = trace.buildModel(events, { agent: 'main-test' });
  assert.match(model.lanes[0].stage, /收尾中/);
  assert.deepEqual(model.lanes[0].plans.map(p => p.scope), ['task', 'workflow']);
});

test('loading capability does not imply running or completion', () => {
  const events = [event('skill:loaded', { skill: 'leader' }), event('workflow:loaded', { workflow: 'example' })];
  let model = trace.buildModel(events, { agent: 'main-test' });
  assert.deepEqual([...model.lanes[0].capabilities.values()].map(c => c.phase), ['已读取', '已读取']);
  events.push(event('workflow:result', { workflow: 'example', status: 'blocked' }));
  events.push(event('workflow:loaded', { workflow: 'example' }));
  model = trace.buildModel(events, { agent: 'main-test' });
  assert.equal(model.lanes[0].capabilities.get('workflow:example').phase, '受阻');
});

test('bounded log preserves current plan and loop anchors, replay remains idempotent', () => {
  const events = [];
  trace.append(events, event('loop:start'));
  trace.append(events, event('progress:updated', { progress: plan() }));
  trace.append(events, event('progress:updated', { progress: plan('global', 'task', 2) }));
  for (let i = 0; i < 450; i++) trace.append(events, event('loop:tool-result', { text: `bash ${i}` }));
  trace.append(events, event('progress:updated', { progress: plan() }));
  assert.equal(events.length, 400);
  assert.equal(events.filter(e => e.progress).length, 1);
  assert.equal(events.find(e => e.progress).progress.revision, 2);
  assert.ok(events.some(e => e.msg === 'loop:start'));
});

test('production normalizer preserves structured fields, timestamp and trace identity', () => {
  const source = name => app.match(new RegExp(`^function ${name}\\([^\\n]*\\) \\{[\\s\\S]*?^}`, 'm'))[0];
  const context = vm.createContext({ window: { HarbourTrace: trace }, formatRunDuration: String });
  vm.runInContext(['isCoworkTraceEvent', 'normalizeTraceEvent', 'appendRoutedTrace', 'normalizeStoredTrace'].map(source).join('\n'), context);
  const raw = [event('progress:updated', { progress: plan(), time: 100 }), event('loop:end', { parentTraceId: 'parent', status: 'interrupted', time: 200 }),
    event('workflow:result', { workflow: 'example', jobId: 'job-a', status: 'blocked', time: 300 }),
    event('loop:interrupted', { aborted: true, time: 400 })];
  const normalized = context.normalizeStoredTrace(raw, 'main-test');
  assert.equal(normalized[0].progress.id, 'global');
  assert.equal(normalized[0].at, 100);
  assert.equal(normalized[1].parentTraceId, 'parent');
  assert.equal(normalized[1].status, 'interrupted');
  assert.equal(normalized[2].workflow, 'example');
  assert.equal(normalized[2].jobId, 'job-a');
  assert.equal(normalized[3].aborted, true);
});

const snapshot = (status, at, extra = {}) => event('workflow:progress', {
  workflow: 'novelai-generation', jobId: 'job-a', status, completed: 0, total: 2,
  tag: 'WORKFLOW', text: `novelai-generation · 进度 · ${status} · 0/2`, at, ...extra,
});

test('workflow snapshots update one lane row, duplicate polls do not displace tool activity; audit is retained', () => {
  const events = [snapshot('planned', 1), snapshot('planned', 2), snapshot('running', 3),
    event('loop:tool-result', { at: 4, tag: 'bash', text: 'real tool result' }), snapshot('running', 5)];
  const model = trace.buildModel(events);
  assert.equal(model.lanes[0].feed.length, 2);
  assert.equal(model.lanes[0].feed[0].status, 'running');
  assert.equal(model.lanes[0].feed[0].at, 3, 'unchanged poll retains the original visual identity');
  assert.equal(model.lanes[0].feed[1].tag, 'bash');
  assert.equal(model.events.length, 5, 'never change raw audit records to tidy the display');
  assert.equal(model.lanes[0].capabilities.get('workflow:novelai-generation').phase, '执行中');
  events.push(snapshot('running', 6, { completed: 1 }));
  assert.equal(trace.buildModel(events).lanes[0].feed.at(-1).completed, 1);
});

test('different workflow jobs/actions/agents and real repeated commands remain distinct', () => {
  const events = [snapshot('running', 1), snapshot('running', 2, { jobId: 'job-b' }),
    snapshot('running', 3, { action: 'resume' }),
    snapshot('running', 4, { agent: 'worker', traceId: 'child', parentTraceId: 'root' }),
    event('loop:tool-result', { at: 5, text: 'same command' }), event('loop:tool-result', { at: 6, text: 'same command' })];
  const model = trace.buildModel(events, { agent: 'main-test' });
  assert.equal(model.lanes[0].feed.length, 5);
  assert.equal(model.lanes[1].feed.length, 1);
});

test('reconnect with older events does not rewind the progress lane or animate old snapshots as new', () => {
  const events = [snapshot('running', 50, { completed: 1 }), snapshot('planned', 10), snapshot('running', 20)];
  const model = trace.buildModel(events);
  assert.equal(model.lanes[0].feed.length, 1);
  assert.equal(model.lanes[0].feed[0].completed, 1);
  assert.equal(model.lanes[0].capabilities.get('workflow:novelai-generation').phase, '执行中');
});

test('waiting uses parent trace identity and stops on parent activity, child completion, or history', () => {
  const child = (msg, data = {}) => event(msg, { agent: 'worker', traceId: 'child', parentTraceId: 'root', ...data });
  const events = [event('loop:start'), event('spawn_subagent', { to: 'worker' }), child('loop:start')];
  assert.equal(trace.buildModel(events).lanes[0].waiting, true);
  assert.equal(trace.buildModel(events, { live: false }).lanes[0].waiting, false);
  const working = trace.buildModel([...events, event('loop:thinking')]);
  assert.equal(working.lanes[0].waiting, false, 'do not call concurrent parent work stalled');
  const finished = trace.buildModel([...events, child('loop:end', { status: 'completed' })]);
  assert.equal(finished.lanes[0].waiting, false);
  assert.equal(finished.lanes[1].settled.label, '已完成');
  assert.match(trace.render(finished), /tp-settled is-success/);
  const unrelated = trace.buildModel([event('loop:start'), child('loop:start', { parentTraceId: 'other-parent' })]);
  assert.equal(unrelated.lanes[0].waiting, false);
});

test('repeat dispatch is not swallowed by an earlier invocation with the same name', () => {
  const events = [event('loop:start', { at: 1 }), event('spawn_subagent', { to: 'worker', at: 2 }),
    event('loop:start', { agent: 'worker', traceId: 'c1', parentTraceId: 'root', at: 3 }),
    event('loop:end', { agent: 'worker', traceId: 'c1', parentTraceId: 'root', status: 'completed', at: 4 }),
    event('spawn_subagent', { to: 'worker', at: 5 })];
  const model = trace.buildModel(events);
  assert.equal(model.lanes.length, 3);
  assert.equal(model.lanes[0].waiting, true);
  events.push(event('loop:start', { agent: 'worker', traceId: 'c2', parentTraceId: 'root', at: 6 }));
  const started = trace.buildModel(events);
  assert.equal(started.lanes.length, 3);
  assert.equal(started.lanes[2].id, 'c2');
});

test('nested workers breathe only on the correct parent, for either Main persona', () => {
  for (const main of ['main-elaina', 'main-aemeath']) {
    const model = trace.buildModel([
      event('loop:start', { agent: main }),
      event('loop:start', { agent: 'director', traceId: 'd', parentTraceId: 'root' }),
      event('spawn_subagent', { agent: 'director', traceId: 'd', parentTraceId: 'root', to: 'worker' }),
      event('loop:start', { agent: 'worker', traceId: 'w', parentTraceId: 'd' }),
      event('loop:thinking', { agent: main }),
    ], { agent: main });
    assert.equal(model.lanes[0].waiting, false);
    assert.equal(model.lanes[1].waiting, true);
    assert.equal(model.lanes[2].waiting, false);
    assert.equal(model.lanes.length, 3);
  }
});

test('completion badge never equates a final answer, error, cancellation or incomplete history with success', () => {
  for (const [status, label] of [['failed', '执行失败'], ['interrupted', '已中止'], ['incomplete', '已结束'], ['completed', '已完成']]) {
    const lane = trace.buildModel([event('loop:end', { status })]).lanes[0];
    assert.equal(lane.settled.label, label);
  }
  assert.equal(trace.buildModel([event('loop:final')]).lanes[0].settled, undefined);
  assert.equal(trace.buildModel([event('loop:interrupted', { aborted: true })]).lanes[0].settled.label, '已中止');
  assert.equal(trace.buildModel([event('loop:final')], { live: false }).lanes[0].settled.success, false);
  const blocked = trace.buildModel([event('workflow:result', { workflow: 'fixture', status: 'blocked' }), event('loop:end', { status: 'completed' })]);
  assert.equal(blocked.lanes[0].settled.label, '受阻');
});

test('compact wheel stays bounded without deleting the log; HTML is escaped', () => {
  const events = Array.from({ length: 100 }, (_, at) => event('loop:tool-result', { at, text: '<img src=x onerror=alert(1)>' }));
  const model = trace.buildModel(events);
  assert.equal(model.lanes[0].feed.length, 24);
  assert.equal(model.events.length, 100);
  const html = trace.render(model);
  assert.match(html, /tp-feed-window/);
  assert.doesNotMatch(html, /<img/);
});

test('review uses a compact outcome and readable disclosure instead of a stopped live wheel', () => {
  const events = [event('loop:start', { at: 1_000 }),
    event('loop:tool-result', { tool: 'opencli_browser', tag: 'opencli_browser', cls: 'result', text: '← {"session":"fixture"}', at: 2_000 }),
    event('loop:thinking', { tag: 'THINK', text: 'Checking the result', at: 3_000 }),
    event('loop:final', { tag: 'FINAL', text: 'BROWSER_RESULT {"status":"completed","chargeState":"not_charged"}', at: 4_000 }),
    event('loop:end', { status: 'completed', at: 13_000 })];
  const html = trace.render(trace.buildModel(events, { live: false }));
  assert.match(html, /tp-review-summary">已返回结构化回执/);
  assert.match(html, /tp-review-status[^>]*>已完成/);
  assert.match(html, /12 秒/);
  assert.match(html, /<ol class="tp-timeline">/);
  assert.match(html, /查看思考记录/);
  assert.match(html, /结构化回执预览/);
  assert.match(html, /&quot;status&quot;: &quot;completed&quot;/, 'valid JSON is indented for reading');
  assert.doesNotMatch(html, /tp-feed-window|tp-settled|tp-orbit-column|tp-review-summary">BROWSER_RESULT/);
});

test('review preserves unknown, failed and unfinished states even when final JSON claims success', () => {
  const final = event('loop:final', { text: 'BROWSER_RESULT {"status":"completed"}' });
  const unknown = trace.render(trace.buildModel([final], { live: false }));
  assert.match(unknown, /tp-review-status[^>]*>已结束/);
  assert.doesNotMatch(unknown, /data-outcome="success"/);
  const failure = trace.render(trace.buildModel([final, event('loop:interrupted', { text: 'Gateway unavailable' }), event('loop:end', { status: 'failed' })], { live: false }));
  assert.match(failure, /tp-review-status[^>]*>执行失败/);
  assert.match(failure, /tp-review-summary">Gateway unavailable/);
  const incomplete = trace.render(trace.buildModel([event('progress:updated', { progress: plan() }), event('loop:end', { status: 'completed' })], { live: false }));
  assert.match(incomplete, /tp-review-status[^>]*>已结束/);
  assert.match(incomplete, /待办尚未全部完成/);
  assert.match(incomplete, /data-tp-plan="global"/);
});

test('review supports legacy and truncated previews, keeps safe text, and never parses protocol as HTML', () => {
  const events = [{ cls: 'result', tag: 'opencli_browser', agent: 'worker', depth: 1, text: '← {"session":"fixture…' },
    { cls: 'final', tag: 'FINAL', agent: 'worker', depth: 1, text: 'BROWSER_RESULT {"status":"completed","html":"</pre><img src=x onerror=alert(1)>"}' }];
  const html = trace.render(trace.buildModel(events, { agent: 'main-test', live: false }));
  assert.match(html, /tp-review-status[^>]*>已结束/);
  assert.match(html, /&quot;session&quot;:&quot;fixture…/);
  assert.match(html, /&lt;\/pre&gt;&lt;img/);
  assert.doesNotMatch(html, /<img|data-outcome="success"/);
  assert.doesNotMatch(html, /data-lane-id="main"/, 'do not pad a legacy child-only record with a fabricated Main summary');
  assert.match(html, /长返回可能仅保留预览/);
});

test('review keeps all meaningful saved steps beyond the live wheel limit and retains the raw renderer', () => {
  const events = Array.from({ length: 35 }, (_, at) => event('loop:tool-result', { at, cls: 'result', tag: 'bash', text: `← result ${at}` }));
  const model = trace.buildModel([...events, snapshot('planned', 36), snapshot('planned', 37), snapshot('running', 38)], { live: false });
  const html = trace.render(model, { rowsHtml: all => `<div class="audit-fixture">${all.length} raw events</div>` });
  assert.equal((html.match(/class="tp-event"/g) || []).length, 36);
  assert.match(html, /38 raw events/);
  assert.equal(model.events.length, 38);
});

test('normalization retains full tool identifiers for review without increasing saved result previews', () => {
  const source = app.match(/^function normalizeTraceEvent\([^\n]*\) \{[\s\S]*?^}/m)[0];
  const context = vm.createContext({ isCoworkTraceEvent: () => false });
  vm.runInContext(source, context);
  const name = 'a_very_long_but_complete_tool_identifier';
  const result = context.normalizeTraceEvent({ msg: 'loop:tool-result', tool: name, resultPreview: 'x'.repeat(500) });
  assert.equal(result.tool, name);
  assert.equal(result.tag.length, 29);
  assert.equal(result.text.length, 163);
  const html = trace.render(trace.buildModel([result], { live: false }));
  assert.match(html, new RegExp(`<code>${name}</code>`));
  assert.match(html, /查看返回内容/);
});
