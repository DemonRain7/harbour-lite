// One small, local activity state machine. No model calls, wall-clock timers,
// invented dialogue or relationship scores. Hidden worlds stop advancing it.
export const HANDS = Object.freeze({ rock: '石头', scissors: '剪刀', paper: '布' });
export const roundResult = (player, resident) => player === resident ? 'draw'
  : ({ rock: 'scissors', scissors: 'paper', paper: 'rock' }[player] === resident ? 'win' : 'lose');
const RESULTS = Object.freeze({ win: '你赢了', lose: '她赢了', draw: '平局' });
const ACTIONS = new Set(['wave', 'pat', 'follow', 'wait', 'resume', 'end', 'rps']);

export class TownSocial {
  constructor(residents, random = Math.random) {
    this.ids = new Set(residents.map(r => r.id)); this.random = random;
    this.time = 0; this.companion = null; this.gesture = null; this.events = [];
    this.revision = 0;
  }
  record(id, action, extra = {}) {
    this.events.push({ id, action, at: this.time, ...extra });
    this.events = this.events.filter(e => this.time - e.at < 600).slice(-12);
    this.revision++;
  }
  act(id, action, choice) {
    if (!this.ids.has(id) || !ACTIONS.has(action)) return false;
    if (action === 'end' || action === 'wait' || action === 'resume') {
      if (this.companion?.id !== id) return false;
      this.companion = action === 'end' ? null : { id, mode: action === 'wait' ? 'wait' : 'follow' };
      this.record(id, action); return true;
    }
    if (this.gesture && this.gesture.elapsed < this.duration()) return false;
    if (action === 'follow') {
      if (this.companion?.id === id && this.companion.mode === 'follow') return false;
      if (this.companion && this.companion.id !== id) this.record(this.companion.id, 'end');
      this.companion = { id, mode: 'follow' }; this.record(id, action); return true;
    }
    if (action === 'rps' && !Object.hasOwn(HANDS, choice)) return false;
    const roll = Math.max(0, Math.min(.999999, Number(this.random()) || 0));
    this.gesture = { id, type: action, elapsed: 0,
      ...(action === 'rps' ? { player: choice, resident: Object.keys(HANDS)[Math.floor(roll * 3)], revealed: false } : {}) };
    if (action !== 'rps') this.record(id, action);
    this.revision++; return true;
  }
  duration() { return this.gesture?.type === 'rps' ? 6.1 : this.gesture?.type === 'pat' ? 3 : 2.4; }
  tick(dt) {
    const step = Math.min(.05, Math.max(0, dt)); this.time += step;
    const g = this.gesture;
    if (!g) return;
    const before = Math.floor(g.elapsed / .7);
    g.elapsed += step;
    if (g.type === 'rps' && g.elapsed >= 2.1 && !g.revealed) {
      g.revealed = true;
      this.record(g.id, 'rps', { player: g.player, resident: g.resident });
    }
    if (Math.floor(g.elapsed / .7) !== before) this.revision++;
    if (g.elapsed >= this.duration()) { this.gesture = null; this.revision++; }
  }
  pose(id) {
    const g = this.gesture;
    if (g?.id !== id) return null;
    return { type: g.type, elapsed: g.elapsed, choice: g.type === 'rps' ? (g.revealed ? g.resident : 'rock') : null,
      countdown: g.type === 'rps' && !g.revealed };
  }
  view(id) {
    const g = this.gesture?.id === id ? this.gesture : null;
    const last = this.events.filter(e => e.id === id && this.time - e.at < 600).at(-1);
    let text = '';
    if (g?.type === 'rps' && !g.revealed) text = ['石头…', '剪刀…', '出！'][Math.min(2, Math.floor(g.elapsed / .7))];
    else if (g?.type === 'pat') text = '她轻轻偏过头，眯起眼睛。';
    else if (g?.type === 'wave') text = '她抬起手，向你挥了挥。';
    else if (last?.action === 'rps') text = `你出${HANDS[last.player]}，她出${HANDS[last.resident]} · ${RESULTS[roundResult(last.player, last.resident)]}`;
    return { text, busy: !!this.gesture, companion: this.companion?.id === id ? this.companion.mode : null };
  }
  context(id, locomotion) {
    if (!this.ids.has(id)) return '';
    const actions = { wave: '互相挥手', pat: '用户摸了摸你的头', follow: '用户邀请你一起散步', wait: '用户请你在原地等候', resume: '你们继续同行', end: '结束了同行' };
    const recent = this.events.filter(e => e.id === id && this.time - e.at < 600).slice(-3).map(e => e.action === 'rps'
      ? `刚才猜拳：用户出${HANDS[e.player]}，你出${HANDS[e.resident]}，${{ win: '用户赢', lose: '你赢', draw: '平局' }[roundResult(e.player, e.resident)]}` : actions[e.action]);
    if (this.companion?.id === id) recent.push(this.companion.mode === 'wait' ? '当前：在原地等候用户'
      : ['blocked', 'too-far'].includes(locomotion) ? '当前：同行途中暂时受阻，在原地等待用户靠近' : '当前：与你同行中');
    return recent.filter(Boolean).join('；');
  }
  snapshot() {
    return structuredClone({ version: 1, time: this.time, companion: this.companion, gesture: this.gesture, events: this.events });
  }
  restore(value) {
    if (value?.version !== 1) return;
    this.time = Number.isFinite(value.time) && value.time >= 0 ? value.time : 0;
    this.companion = this.ids.has(value.companion?.id) && ['follow', 'wait'].includes(value.companion.mode)
      ? { id: value.companion.id, mode: value.companion.mode } : null;
    this.events = (Array.isArray(value.events) ? value.events : []).slice(-12).filter(e => this.ids.has(e?.id)
      && ACTIONS.has(e.action) && Number.isFinite(e.at) && e.at <= this.time && this.time - e.at < 600
      && (e.action !== 'rps' || (Object.hasOwn(HANDS, e.player) && Object.hasOwn(HANDS, e.resident))))
      .map(e => ({ id: e.id, action: e.action, at: e.at, ...(e.action === 'rps' ? { player: e.player, resident: e.resident } : {}) }));
    const g = value.gesture;
    this.gesture = this.ids.has(g?.id) && ['wave', 'pat', 'rps'].includes(g.type) && Number.isFinite(g.elapsed) && g.elapsed >= 0 && g.elapsed < 6.1
      && (g.type !== 'rps' || (Object.hasOwn(HANDS, g.player) && Object.hasOwn(HANDS, g.resident)))
      ? { id: g.id, type: g.type, elapsed: g.elapsed, ...(g.type === 'rps' ? { player: g.player, resident: g.resident, revealed: g.elapsed >= 2.1 } : {}) } : null;
    if (this.gesture && this.gesture.elapsed >= this.duration()) this.gesture = null;
    this.revision++;
  }
}
