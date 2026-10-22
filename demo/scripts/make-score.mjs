// HarbourStory 的配乐与音效：全部在本地用代码合成（加法合成 + 滤波噪声 + 混响），
// 不下载素材、不调用模型或任何外部服务；固定随机种子，每次输出相同的音频。
// 时间轴照抄 src/Story.tsx 的 STORY_SCENES 与各场景里的入场时刻，同样按「拍格秒」书写（一拍 = 0.5），
// 落到采样上时再乘 TEMPO：剪辑踩在 100 BPM 上，一拍 0.6 秒。每次换场，灯塔光束扫过画面中线
// （场景起点 + 0.25 拍格秒）正好是一拍，鼓、和弦、旋律都对着这些拍点写。
// 那边改了时长或延迟，要同步这里的 SCENES / 事件表，再重新生成。
//
//   npm --prefix demo run score                 写入 public/story/score.m4a（用 Remotion 自带的 ffmpeg 编码 AAC）
//   node scripts/make-score.mjs --wav a.wav     只写 WAV，加 --stems <目录> 另存分轨，供检查电平
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const demoRoot = fileURLToPath(new URL('..', import.meta.url));
const arg = name => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : undefined; };
const SR = 48000;
const TARGET_LUFS = -16;
const CEILING = 10 ** (-1.8 / 20);

/* ── 时间轴（拍格秒）：与 src/Story.tsx 一致 ───────────────────────── */
// 开场、01–12 十二章、片尾；03 陪伴角色，05 执行进度，07 悬浮助手，08 Folia 音乐。
const SCENES = [4.5, 4.5, 5.5, 5.5, 4.5, 6.5, 4.5, 5.5, 6.5, 4.5, 4.5, 4.5, 5.5, 5];
const FADE = 0.5;
const S = SCENES.map((_, i) => SCENES.slice(0, i).reduce((sum, sec) => sum + sec - FADE, 0)); // 各场景在成片里的起点
const DURATION = S.at(-1) + SCENES.at(-1);
assert.equal(DURATION, 65);
const TEMPO = 1.2; // 一拍格秒 = 1.2 秒（100 BPM）
const BEAT = 0.5; // 拍点 = 0.25 + k × 0.5
const HIT = S.slice(1).map(s => s + FADE / 2); // 光束扫过画面中线的一刻：换和弦、落鼓
const END = HIT.at(-1); // 片尾的那一拍
const on8th = t => Math.abs((t - 0.25) / (BEAT / 2) - Math.round((t - 0.25) / (BEAT / 2))) < 1e-9;
assert.ok(HIT.every(on8th), '换场时刻要落在拍点上');
assert.ok(HIT.every(t => Number.isInteger(t - HIT[0])), '换场时刻要落在强拍（1、3 拍）上');
const N = Math.round(DURATION * TEMPO * SR);

/* ── 基础工具 ─────────────────────────────────────────────────── */
let seed = 0x48b0a7;
const rand = () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const noise = () => rand() * 2 - 1;
const PITCH = {C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11};
const hz = name => {
  const [, letter, acc, oct] = /^([A-G])(#|b)?(\d)$/.exec(name);
  const midi = PITCH[letter] + (acc === '#' ? 1 : acc === 'b' ? -1 : 0) + (Number(oct) + 1) * 12;
  return 440 * 2 ** ((midi - 69) / 12);
};
const smooth = x => x <= 0 ? 0 : x >= 1 ? 1 : 0.5 - 0.5 * Math.cos(Math.PI * x);
const clampPan = p => Math.max(-1, Math.min(1, p));
const ramp = points => t => { // 分段平滑插值：[[秒, 值], ...]
  if (t <= points[0][0]) return points[0][1];
  for (let k = 1; k < points.length; k++) {
    if (t <= points[k][0]) { const [t0, v0] = points[k - 1], [t1, v1] = points[k]; return v0 + (v1 - v0) * smooth((t - t0) / (t1 - t0)); }
  }
  return points.at(-1)[1];
};
// 与 Remotion 的 Easing.bezier 相同的三次贝塞尔：at(x) 正向取值，timeAt(y) 反求「进度到 y 时的时间比例」。
const bezier = (x1, y1, x2, y2) => {
  const at = (s, a, b) => 3 * (1 - s) ** 2 * s * a + 3 * (1 - s) * s ** 2 * b + s ** 3;
  const solve = (target, a, b) => { let lo = 0, hi = 1; for (let k = 0; k < 40; k++) { const m = (lo + hi) / 2; if (at(m, a, b) < target) lo = m; else hi = m; } return lo; };
  return {at: x => at(solve(x, x1, x2), y1, y2), timeAt: y => at(solve(y, y1, y2), x1, x2)};
};
// 照搬 Remotion interpolate（分段、每段各自缓动、两端截断）。
const keyframes = (t, ts, vs, curve) => {
  if (t <= ts[0]) return vs[0];
  for (let k = 1; k < ts.length; k++) if (t <= ts[k]) return vs[k - 1] + (vs[k] - vs[k - 1]) * curve.at((t - ts[k - 1]) / (ts[k] - ts[k - 1]));
  return vs.at(-1);
};
// 单调函数 f 在 [lo, hi] 内到达 target 的时刻。
const timeWhen = (f, lo, hi, target) => { for (let k = 0; k < 50; k++) { const m = (lo + hi) / 2; if (f(m) < target) lo = m; else hi = m; } return lo; };
const SWING = bezier(0.65, 0, 0.35, 1);
const beamReveal = (deg, rise, width) => Math.min(1, Math.max(0, 0.5 + rise * Math.tan(deg * Math.PI / 180) / width));

// 每条分轨：干声 + 混响送出 + 回声送出；分开是为了能单独检查配乐、节奏、音效、环境声的电平。
const bus = () => [new Float32Array(N), new Float32Array(N)];
const stem = () => ({dry: bus(), verb: bus(), echo: bus()});
const stems = {pad: stem(), bass: stem(), drums: stem(), pulse: stem(), music: stem(), sfx: stem(), ambience: stem()};

// t0 是拍格秒；声音本身的长度（mono）是真实采样，不随拍速伸缩。
function place(target, t0, mono, {gain = 1, pan = 0, verb = 0.3, echo = 0} = {}) {
  const i0 = Math.round(t0 * TEMPO * SR);
  const panAt = typeof pan === 'function' ? pan : () => pan;
  for (let k = 0; k < mono.length; k++) {
    const i = i0 + k;
    if (i < 0 || i >= N) continue;
    const p = (clampPan(panAt(k / mono.length)) + 1) * Math.PI / 4;
    const v = mono[k] * gain, l = v * Math.cos(p), r = v * Math.sin(p);
    target.dry[0][i] += l; target.dry[1][i] += r;
    target.verb[0][i] += l * verb; target.verb[1][i] += r * verb;
    if (echo) { target.echo[0][i] += l * echo; target.echo[1][i] += r * echo; }
  }
}

// 零延迟反馈的状态变量滤波器（TPT SVF），截止频率可逐采样变化。
function svf(input, cutoff, q = 0.707, mode = 'bp') {
  const out = new Float32Array(input.length), k = 1 / q;
  let ic1 = 0, ic2 = 0;
  for (let i = 0; i < input.length; i++) {
    const fc = typeof cutoff === 'function' ? cutoff(i) : cutoff;
    const g = Math.tan(Math.PI * Math.min(fc, SR * 0.45) / SR);
    const a1 = 1 / (1 + g * (g + k)), a2 = g * a1, a3 = g * a2;
    const v3 = input[i] - ic2, v1 = a1 * ic1 + a2 * v3, v2 = ic2 + a2 * ic1 + a3 * v3;
    ic1 = 2 * v1 - ic1; ic2 = 2 * v2 - ic2;
    out[i] = mode === 'lp' ? v2 : mode === 'hp' ? input[i] - k * v1 - v2 : k * v1;
  }
  return out;
}

/* ── 乐器 ─────────────────────────────────────────────────────── */
// 声音都压在 4 kHz 以下：只用整数倍谐波、起音不短于 3 ms、噪声类声音的滤波上限不超过 2 kHz，避免刺耳。
// 一组按指数衰减的分音：[频率倍数, 幅度, 衰减时间常数(秒)]。
function partials(f, list, {dur, attack = 0.004}) {
  const n = Math.round(dur * SR), out = new Float32Array(n);
  for (const [ratio, amp, tau] of list) {
    if (f * ratio > 16000) continue;
    const w = 2 * Math.PI * f * ratio / SR, ph = rand() * 2 * Math.PI, decay = Math.exp(-1 / (tau * SR));
    let env = amp;
    for (let i = 0; i < n; i++) { out[i] += env * Math.sin(ph + w * i); env *= decay; }
  }
  const na = Math.max(1, Math.round(attack * SR)), nr = Math.min(n, Math.round(0.04 * SR));
  for (let i = 0; i < na && i < n; i++) out[i] *= i / na;
  for (let i = 0; i < nr; i++) out[n - 1 - i] *= i / nr;
  return out;
}

// 电钢：只留 1–3 次谐波，标题、卡片、步骤出现时落一个和弦内音。
const keys = (t, note, vel, pan = 0) => {
  const f = hz(note), damp = (523 / f) ** 0.35;
  place(stems.music, t, partials(f, [[1, 1, 1.1 * damp], [2, 0.22, 0.5 * damp], [3, 0.06, 0.25 * damp]], {dur: 2.8, attack: 0.006}),
    {gain: 0.26 * vel, pan, verb: 0.42, echo: 0.2});
};
// 软钟：整数倍分音，音区不高过 D6；灯塔、主题切换、曲线扫过。
const bell = (t, note, vel, pan = 0) =>
  place(stems.music, t, partials(hz(note), [[1, 1, 1.8], [2, 0.26, 0.8], [3, 0.08, 0.4], [4, 0.025, 0.2]], {dur: 4, attack: 0.005}),
    {gain: 0.17 * vel, pan, verb: 0.65, echo: 0.25});
// 界面提示：木琴式的短音。
const pip = (t, note, vel, pan = 0) =>
  place(stems.sfx, t, partials(hz(note), [[1, 1, 0.16], [3, 0.05, 0.04]], {dur: 0.5, attack: 0.004}), {gain: 0.3 * vel, pan, verb: 0.3});
// 挂载：一声往下滑的纯音，像东西落进槽里。
function drop(t, {from = 820, to = 470, gain = 1, pan = 0}) {
  const n = Math.round(0.24 * SR), out = new Float32Array(n);
  for (let i = 0, ph = 0; i < n; i++) {
    const s = i / SR;
    ph += 2 * Math.PI * (to + (from - to) * Math.exp(-s / 0.03)) / SR;
    out[i] = Math.sin(ph) * Math.min(1, s / 0.003) * Math.exp(-s / 0.06);
  }
  place(stems.sfx, t, out, {gain: 0.22 * gain, pan, verb: 0.25});
}
// 低频落地：灯亮、片尾主和弦。
const thump = t => place(stems.sfx, t - 0.02, partials(52, [[1, 1, 0.3], [2.01, 0.2, 0.1]], {dur: 1, attack: 0.02}), {gain: 0.2, verb: 0.15});

// 底鼓：音高从 110 Hz 滑到 46 Hz 的正弦，3 ms 起音、没有“哒”的瞬态，再轻微饱和。
const kicks = [];
function kick(t, vel = 1) {
  const n = Math.round(0.6 * SR), out = new Float32Array(n);
  for (let i = 0, ph = 0; i < n; i++) {
    const s = i / SR;
    ph += 2 * Math.PI * (46 + 64 * Math.exp(-s / 0.035)) / SR;
    out[i] = Math.tanh(1.6 * Math.sin(ph) * Math.min(1, s / 0.003) * Math.exp(-s / 0.22)) / Math.tanh(1.6);
  }
  place(stems.drums, t, out, {gain: 0.22 * vel, verb: 0.04});
  kicks.push([t, vel]);
}
// 刷子：带通在 1.1 kHz 的噪声，落在 2、4 拍，代替偏亮的军鼓和镲片。
function brush(t, vel = 1, pan = 0) {
  const n = Math.round(0.2 * SR), out = svf(Float32Array.from({length: n}, noise), 1100, 0.7, 'bp');
  for (let i = 0; i < n; i++) { const s = i / SR; out[i] *= Math.min(1, s / 0.004) * Math.exp(-s / 0.05); }
  place(stems.drums, t, out, {gain: 0.16 * vel, pan, verb: 0.2});
}
// 拨弦琶音：谐波按 1/h 叠加，高次谐波衰减更快；bright 是谐波频率上限，随段落慢慢打开。
function pluck(t, note, vel, pan, bright) {
  const f = hz(note), list = [];
  for (let h = 1; h <= 10 && f * h < bright; h++) list.push([h, 1 / h ** 1.15, 0.38 / h ** 0.8]);
  place(stems.pulse, t, partials(f, list, {dur: 0.7, attack: 0.003}), {gain: 0.1 * vel, pan, verb: 0.28, echo: 0.32});
}
// 打字：带通噪声（1.4–2 kHz）+ 一点 150 Hz 的键身。
function tap(t, {gain = 1, pan = 0, tone = 1600}) {
  const n = Math.round(0.05 * SR), hi = svf(Float32Array.from({length: n}, noise), tone, 1, 'bp'), out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const s = i / SR;
    out[i] = (hi[i] * Math.exp(-s / 0.006) + 0.5 * Math.sin(2 * Math.PI * 150 * s) * Math.exp(-s / 0.012)) * Math.min(1, s / 0.0015);
  }
  place(stems.sfx, t, out, {gain: 0.4 * gain, pan, verb: 0.15});
}

// 气流声：两路独立白噪声过带通，中心频率按指数从 f0 扫到 f1，包络在 peak 处最大。dur 是拍格秒，跟着画面动作伸缩。
function whoosh(target, t0, dur, {f0, f1, q = 0.9, peak = 0.5, curve = 1, gain = 1, pan = [0, 0], width = 0.5, verb = 0.35}) {
  const n = Math.round(dur * TEMPO * SR), freq = i => f0 * (f1 / f0) ** (i / n);
  for (const side of [-1, 1]) {
    const out = svf(Float32Array.from({length: n}, noise), freq, q, 'bp');
    for (let i = 0; i < n; i++) {
      const u = i / n, env = u < peak ? smooth(u / peak) : smooth((1 - u) / (1 - peak));
      out[i] *= env ** curve * Math.sqrt(1000 / freq(i));
    }
    place(target, t0, out, {gain: gain * 0.7, pan: u => pan[0] + (pan[1] - pan[0]) * u + side * width / 2, verb});
  }
}

// 海浪：棕噪声低通随浪涌开合，再叠一点浪尖的沙沙声；左右声道相位错开。
function ocean(t0, t1, {gain, fadeIn, fadeOut}) {
  const len = (t1 - t0) * TEMPO, n = Math.round(len * SR);
  for (const [pan, offset] of [[-0.65, 0], [0.65, 0.41]]) {
    const swell = i => { const x = (i / SR / 6.2 + offset) % 1; return x < 0.62 ? smooth(x / 0.62) : smooth((1 - x) / 0.38); };
    const brown = new Float32Array(n);
    for (let i = 0, b = 0; i < n; i++) { b = 0.996 * b + 0.06 * noise(); brown[i] = b; }
    const low = svf(brown, i => 220 + 800 * swell(i), 0.6, 'lp');
    const foam = svf(Float32Array.from({length: n}, noise), i => 900 + 1000 * swell(i), 0.5, 'bp');
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const s = swell(i), t = i / SR;
      out[i] = (low[i] * (0.35 + 0.65 * s) + foam[i] * 0.18 * s ** 3) * smooth(t / fadeIn) * smooth((len - t) / fadeOut);
    }
    place(stems.ambience, t0, out, {gain, pan, verb: 0.2});
  }
}

// 持续音（铺底和低音）：带限波表 + 轻微失谐的几路振荡器 + 缓慢起伏。t0 / t1 是拍格秒，attack / release 是真实秒数。
function sustain(target, t0, t1, f, {attack, release, gain, voices = [[-6, -0.45], [0, 0], [6, 0.45]], tilt = 1.7, maxHarmonic = 24, verb = 0.6}) {
  const SIZE = 4096, table = new Float32Array(SIZE + 1);
  for (let h = 1; h <= maxHarmonic && h * f < 9000; h++) for (let i = 0; i <= SIZE; i++) table[i] += Math.sin(2 * Math.PI * h * i / SIZE) / h ** tilt;
  const peak = table.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  const hold = (t1 - t0) * TEMPO, n = Math.round((hold + release) * SR);
  for (const [cents, pan] of voices) {
    const inc = f * 2 ** (cents / 1200) * SIZE / SR, lfo = 0.06 + 0.08 * rand(), lfoPhase = rand() * 2 * Math.PI;
    const out = new Float32Array(n);
    let ph = rand() * SIZE;
    for (let i = 0; i < n; i++) {
      const t = i / SR, idx = ph | 0;
      const env = smooth(t / attack) * (t < hold ? 1 : smooth(1 - (t - hold) / release));
      out[i] = (table[idx] + (table[idx + 1] - table[idx]) * (ph - idx)) / peak * env * (0.91 + 0.09 * Math.sin(lfoPhase + 2 * Math.PI * lfo * t));
      ph += inc; if (ph >= SIZE) ph -= SIZE;
    }
    place(target, t0, out, {gain, pan, verb});
  }
}

/* ── 和声：光束扫过的一刻换和弦，D 大调，中段在 ii–iii–IV–V 之间推进，片尾回到主和弦 ── */
const CHORDS = [
  {at: 0, bass: 'D2', pad: ['D3', 'A3', 'E4', 'F#4'], arp: ['D5', 'E5', 'F#5', 'A5']},              // 开场 D add9
  {at: HIT[0], bass: 'B1', pad: ['D3', 'F#3', 'A3', 'C#4'], arp: ['B4', 'D5', 'F#5', 'C#6']},        // 01 Bm9
  {at: HIT[1], bass: 'G1', pad: ['D3', 'G3', 'B3', 'F#4'], arp: ['G4', 'B4', 'D5', 'F#5']},          // 02 Gmaj7
  {at: HIT[2], bass: 'E2', pad: ['D3', 'G3', 'B3', 'F#4'], arp: ['E4', 'G4', 'B4', 'F#5']},          // 03 Em9，陪伴角色这一场放轻
  {at: S[3] + 2.75, bass: 'F#2', pad: ['E3', 'A3', 'C#4', 'F#4'], arp: ['F#4', 'A4', 'C#5', 'E5']},  // 03 切到 MEMORY.md：F#m7
  {at: HIT[3], bass: 'F#2', pad: ['D3', 'A3', 'D4', 'E4'], arp: ['F#4', 'A4', 'D5', 'E5']},          // 04 D/F#
  {at: HIT[4], bass: 'G1', pad: ['D3', 'B3', 'E4', 'A4'], arp: ['G4', 'B4', 'E5', 'A5']},            // 05 G6/9
  {at: S[5] + 2.75, bass: 'A1', pad: ['C#3', 'E3', 'A3', 'B3'], arp: ['A4', 'B4', 'C#5', 'E5']},     // 05 第二次更新计划：A add9，往前推
  {at: HIT[5], bass: 'B1', pad: ['D3', 'F#3', 'A3', 'E4'], arp: ['B4', 'D5', 'E5', 'F#5']},          // 06 Bm11
  {at: HIT[6], bass: 'G1', pad: ['D3', 'G3', 'B3', 'F#4'], arp: ['G4', 'B4', 'D5', 'F#5']},          // 07 Gmaj7
  {at: S[7] + 3.25, bass: 'A1', pad: ['D3', 'E3', 'A3', 'B3'], arp: ['A4', 'B4', 'D5', 'E5']},       // 07 面板收起、桌面歌词：Asus4 add9
  {at: HIT[7], bass: 'F#2', pad: ['E3', 'A3', 'C#4', 'F#4'], arp: ['F#4', 'A4', 'C#5', 'E5']},       // 08 F#m7，听歌这一场换个更柔的颜色
  {at: S[8] + 3.75, bass: 'B1', pad: ['D3', 'F#3', 'A3', 'C#4'], arp: ['B4', 'D5', 'F#5', 'C#6']},   // 08 切到 Partita：Bm9
  {at: HIT[8], bass: 'E2', pad: ['D3', 'G3', 'B3', 'E4'], arp: ['E4', 'G4', 'B4', 'D5']},            // 09 Em7
  {at: HIT[9], bass: 'G1', pad: ['D3', 'B3', 'E4', 'A4'], arp: ['G4', 'B4', 'E5', 'A5']},            // 10 G6/9
  {at: HIT[10], bass: 'B1', pad: ['D3', 'F#3', 'A3', 'E4'], arp: ['B4', 'D5', 'E5', 'F#5']},         // 11 Bm11
  {at: HIT[10] + 2, bass: 'G1', pad: ['D3', 'G3', 'B3', 'F#4'], arp: ['G4', 'B4', 'D5', 'F#5']},     // 11 第二套主题之后：Gmaj7
  {at: HIT[11], bass: 'A1', pad: ['D3', 'E3', 'A3', 'B3'], arp: ['A4', 'B4', 'D5', 'E5']},           // 12 Asus4 add9
  {at: S[12] + 1.75, bass: 'A1', pad: ['C#3', 'E3', 'A3', 'B3'], arp: ['A4', 'B4', 'C#5', 'E5']},    // 12 三步出现：A add9
  {at: END, bass: 'D2', pad: ['D3', 'A3', 'C#4', 'E4', 'F#4'], arp: null},                          // 片尾 Dmaj9，回到主和弦
];
assert.ok(CHORDS.slice(1).every(chord => on8th(chord.at)));
const chordAt = t => CHORDS.findLast(chord => chord.at <= t + 1e-9);
for (const [k, chord] of CHORDS.entries()) {
  const t0 = chord.at, t1 = CHORDS[k + 1]?.at ?? DURATION, attack = k ? 0.6 : 2.6;
  for (const note of chord.pad) sustain(stems.pad, t0, t1, hz(note), {attack, release: 1.4, gain: 0.034});
  for (const note of chord.pad.slice(-2)) sustain(stems.pad, t0, t1, hz(note) * 2, {attack: attack * 1.4, release: 1.6, gain: 0.009});
  sustain(stems.bass, t0, t1, hz(chord.bass), {attack: k ? 0.15 : 2.6, release: 1.2, gain: 0.1, voices: [[0, 0]], tilt: 2.4, maxHarmonic: 4, verb: 0.12});
}
// 铺底的“天色”：开场由暗转亮，越往后越亮一点，片尾收暗。
const padCutoff = ramp([[0, 260], [3.6, 1700], [HIT[0], 2000], [HIT[11], 2500], [END + 1.2, 2900], [DURATION - 1.4, 2200], [DURATION, 700]]);
for (const b of [stems.pad.dry, stems.pad.verb]) for (let ch = 0; ch < 2; ch++) b[ch] = svf(b[ch], i => padCutoff(i / SR / TEMPO) * (1 + 0.1 * Math.sin(2 * Math.PI * i / SR / 9)), 0.75, 'lp');

/* ── 节奏：01 起底鼓走半拍子（1、3 拍），04 起改为每拍一下 + 2、4 拍的刷子；片尾前两拍抽掉 ── */
for (let t = HIT[0]; t < END - 1 - 1e-9; t += BEAT) {
  const strong = Math.abs((t - HIT[0]) - Math.round(t - HIT[0])) < 1e-9;
  if (strong) kick(t, 1);
  else if (t > HIT[3]) { kick(t, 0.5); brush(t, 0.85 + 0.3 * rand(), 0.2); }
}
// 琶音：八分音符，从开场的最后一小节淡入；片尾前一小节变成十六分，推进片尾。
const ARP_STEPS = [0, 1, 2, 3, 2, 1, 2, 3];
const arpBright = ramp([[2.25, 1300], [HIT[0], 2200], [HIT[7], 3000], [END, 3400]]);
const arpLevel = ramp([[2.25, 0.2], [HIT[0] - 0.05, 0.75], [HIT[0], 0.85], [END - 2, 0.95], [END, 0.8]]);
for (let k = 0, t = 2.25; t < END - 1e-9; k++) {
  const sixteenth = t >= END - 2 - 1e-9, chord = chordAt(t);
  const onBeat = Math.abs((t - 0.25) / BEAT - Math.round((t - 0.25) / BEAT)) < 1e-9;
  pluck(t, chord.arp[ARP_STEPS[k % 8]], arpLevel(t) * (onBeat ? 1 : sixteenth ? 0.55 : 0.72) * (0.92 + 0.16 * rand()), k % 2 ? 0.28 : -0.28, arpBright(t));
  t += sixteenth ? BEAT / 4 : BEAT / 2;
}
// 侧链：铺底和低音在每个底鼓处让开一点，形成随拍子的呼吸。
function duck(target, depth) {
  const g = new Float32Array(N).fill(1);
  for (const [t, vel] of kicks) {
    const i0 = Math.round(t * TEMPO * SR);
    for (let k = 0; k < 0.6 * SR && i0 + k < N; k++) {
      const s = k / SR;
      g[i0 + k] = Math.min(g[i0 + k], 1 - depth * vel * Math.min(1, s / 0.01) * Math.exp(-s / 0.16));
    }
  }
  for (const b of [target.dry, target.verb, target.echo]) for (const x of b) for (let i = 0; i < N; i++) x[i] *= g[i];
}
duck(stems.pad, 0.4);
duck(stems.bass, 0.6);

/* ── 事件表：对应每个场景里的画面动作 ─────────────────────────── */
// 开场：海平线画开，灯在第一拍亮起，光束从左扫到右把字标写出来
ocean(0, 6, {gain: 0.32, fadeIn: 1.2, fadeOut: 2.2});
whoosh(stems.sfx, 0.05, 1, {f0: 300, f1: 1000, peak: 0.5, gain: 0.26, width: 1.2});
thump(0.25); bell(0.25, 'A4', 0.7); bell(0.26, 'D5', 0.45);
whoosh(stems.ambience, 0.2, 1.6, {f0: 280, f1: 1100, q: 0.8, peak: 0.6, gain: 0.3, pan: [-0.75, 0.75], width: 0.6});
const openReveal = t => beamReveal(keyframes(t, [0.2, 1.5, 4.5], [-72, 60, 70], SWING), 184, 620); // 同 StoryOpen
['D5', 'F#5', 'A5', 'D6'].forEach((note, i) => keys(timeWhen(openReveal, 0.2, 1.5, 0.1 + i * 0.27), note, 0.4 - i * 0.04, -0.4 + i * 0.27));
whoosh(stems.sfx, 1.25, 0.6, {f0: 700, f1: 1900, q: 1, peak: 0.45, gain: 0.18, pan: [-0.4, 0.45]}); // 金色下划线
keys(1.5, 'F#4', 0.3, -0.1); keys(1.5, 'D5', 0.3, 0.1);                                           // 中文标语
bell(2, 'E5', 0.3, 0.15);                                                                         // 英文副标
whoosh(stems.sfx, 3.25, 1.05, {f0: 250, f1: 1700, q: 0.8, peak: 0.95, curve: 2, gain: 0.3, width: 0.8}); // 进第一拍前的一口气

// 每次换场：光束从左扫到右，气流声的声像跟着光束走，最亮处落在拍点上
for (const t of HIT) whoosh(stems.sfx, t - 0.3, 0.65, {f0: 450, f1: 1900, q: 0.8, peak: 0.46, curve: 1.6, gain: 0.32, pan: [-0.8, 0.8], width: 0.4});

// 各场景标题（主标题 + 英文副标题）落在换场那一拍和后半拍，大致逐场向上走
const TITLE = [['F#4', 'C#5'], ['G4', 'D5'], ['B4', 'F#5'], ['A4', 'E5'], ['B4', 'E5'], ['B4', 'F#5'], ['D5', 'F#5'], ['C#5', 'A5'], ['D5', 'B5'], ['D5', 'A5'], ['E5', 'B5'], ['E5', 'A5']];
assert.equal(TITLE.length, HIT.length - 1);
TITLE.forEach(([zh, en], i) => { keys(HIT[i], zh, 0.36, -0.35); keys(HIT[i] + 0.25, en, 0.26, -0.2); });

// 01 是什么：三枚标签
['D5', 'F#5', 'A5'].forEach((note, i) => pip(S[1] + 1 + i * 0.08, note, 0.55, -0.6 + i * 0.1));

// 02 伙伴：四张模型卡片一个八分音符落一张，声像跟着卡片的横向位置；服务商一行出现时一声软钟
[346, 755, 1165, 1574].forEach((x, i) => keys(S[2] + 1 + i * 0.25, ['G4', 'B4', 'D5', 'F#5'][i], 0.36, (x - 960) / 1200));
bell(S[2] + 2.25, 'D5', 0.25);

// 03 陪伴角色：四份文件的标签依次浮上；每次切到下一份文件（隔一个二分音符），一口短气 + 一声电钢，声像在右边的截图上
['E5', 'G5', 'B5', 'D6'].forEach((note, i) => pip(S[3] + 0.95 + i * 0.08, note, 0.36, -0.66 + i * 0.12));
[[1.75, 'B4'], [2.75, 'C#5'], [3.75, 'E5']].forEach(([d, note], i) => {
  whoosh(stems.sfx, S[3] + d - 0.18, 0.3, {f0: 800, f1: 1600, q: 1, peak: 0.8, curve: 1.5, gain: 0.13, pan: [0.15, 0.45], width: 0.5});
  keys(S[3] + d, note, 0.34 + 0.04 * i, 0.35);
});

// 04 能力：Skill / Workflow / MCP 三行依次挂载
[0.75, 1, 1.25].forEach((d, i) => { drop(S[4] + d, {pan: -0.5}); keys(S[4] + d, ['D5', 'E5', 'A5'][i], 0.3, -0.45); });

// 05 执行进度：录屏里的运行事件本来就踩在拍点上（同 Story.tsx 的 TRACE_EVENTS）。计划更新一声软钟，派出子 Agent 一声挂载，
// 调用工具一声轻的提示音，拿到回执两声；声像在右边的卡片上
const TRACE = [[0.75, 'plan', 'D5'], [1.25, 'sub', 'B4'], [1.75, 'call', 'D6'], [2.25, 'result', 'E5'], [2.75, 'plan', 'E5'],
  [3.25, 'sub', 'C#5'], [3.75, 'result', 'A5'], [4.25, 'plan', 'A5'], [4.75, 'result', 'C#6']];
['D5', 'G5', 'B5'].forEach((note, i) => pip(S[5] + 0.95 + i * 0.08, note, 0.34, -0.66 + i * 0.12));
for (const [d, kind, note] of TRACE) {
  const t = S[5] + d;
  if (kind === 'plan') bell(t, note, 0.34, 0.3);
  else if (kind === 'sub') { drop(t, {pan: 0.35, gain: 0.9}); keys(t, note, 0.28, 0.3); }
  else if (kind === 'call') pip(t, note, 0.32, 0.4);
  else { pip(t, note, 0.42, 0.25); pip(t + 0.125, hz(note) < hz('B5') ? 'B5' : 'E6', 0.32, 0.45); }
}

// 06 不止聊天：三张局部截图依次上浮
[[0.5, 'E5', -0.47], [0.75, 'G5', 0], [1, 'B5', 0.47]].forEach(([d, note, pan]) => {
  whoosh(stems.sfx, S[6] + d - 0.12, 0.4, {f0: 1200, f1: 450, q: 0.8, peak: 0.3, gain: 0.22, pan: [pan, pan], width: 0.3});
  keys(S[6] + d, note, 0.3, pan);
});

// 07 悬浮助手：小球弹出一声，变忙时一声软钟（随着那圈金光），悬停展开一口往上的气 + 两声提示音，收起一口往下的气，
// 桌面歌词滑出时两声软钟；声像在右下角的小球上（同 Story.tsx 的 ORB_AT）
const ORB = {in: 0.75, busy: 1.25, open: 1.75, close: 3.25, lyric: 3.5};
['G5', 'B5', 'D6'].forEach((note, i) => pip(S[7] + 0.95 + i * 0.08, note, 0.32, -0.66 + i * 0.12));
keys(S[7] + ORB.in, 'D5', 0.3, 0.6); pip(S[7] + ORB.in, 'G5', 0.3, 0.65);
bell(S[7] + ORB.busy, 'D5', 0.36, 0.6);
whoosh(stems.sfx, S[7] + ORB.open - 0.1, 0.45, {f0: 500, f1: 1600, q: 1, peak: 0.35, gain: 0.2, pan: [0.65, 0.35], width: 0.4});
pip(S[7] + ORB.open, 'F#5', 0.4, 0.45); pip(S[7] + ORB.open + 0.125, 'B5', 0.34, 0.4);
whoosh(stems.sfx, S[7] + ORB.close - 0.05, 0.3, {f0: 1400, f1: 500, q: 0.9, peak: 0.3, gain: 0.15, pan: [0.4, 0.65], width: 0.3});
bell(S[7] + ORB.lyric, 'E5', 0.34, 0.4); bell(S[7] + ORB.lyric + 0.25, 'A5', 0.3, 0.3);

// 08 音乐：四枚可视化标签依次浮上；每次切换可视化（隔一个二分音符）一口短气 + 一声软钟，切到 Partita 时和弦落到 Bm9；
// 聊天页的「音乐陪伴」小窗浮上来时，两声提示音
['F#5', 'A5', 'C#6', 'E6'].forEach((note, i) => pip(S[8] + 1 + i * 0.08, note, 0.4, -0.66 + i * 0.12));
[[1.75, 'C#5'], [2.75, 'E5'], [3.75, 'F#5']].forEach(([d, note], i) => {
  whoosh(stems.sfx, S[8] + d - 0.2, 0.3, {f0: 600, f1: 1700, q: 1, peak: 0.85, curve: 1.5, gain: 0.16, pan: [0.1, 0.45], width: 0.5});
  bell(S[8] + d, note, 0.4 + 0.06 * i, 0.3);
});
whoosh(stems.sfx, S[8] + 4.1, 0.4, {f0: 1100, f1: 500, q: 0.8, peak: 0.3, gain: 0.18, pan: [-0.2, -0.2], width: 0.3});
pip(S[8] + 4.25, 'B5', 0.5, -0.2); pip(S[8] + 4.375, 'F#5', 0.42, -0.15);

// 09 空间：八张作品卡片一个八分音符落一张，Em7 琶音向上；声像跟着卡片所在的列
const CARD_PAN = [-0.45, -0.28, -0.1, 0.07];
['E4', 'G4', 'B4', 'D5', 'E5', 'G5', 'B5', 'D6'].forEach((note, i) => keys(S[9] + 0.75 + i * 0.25, note, 0.3 - 0.012 * i, CARD_PAN[i % 4]));

// 10 用量：金线扫出曲线。按 soft 缓动反算金线经过每个音的时刻，D 大调五声音阶向上，声像跟着金线走
const softEase = bezier(0.45, 0, 0.2, 1);
const SHIMMER = ['D5', 'E5', 'F#5', 'A5', 'B5', 'D6'];
SHIMMER.forEach((note, j) => {
  const x = j / (SHIMMER.length - 1);
  bell(S[10] + 0.75 + 1.5 * softEase.timeAt(x), note, 0.3 + 0.1 * Math.sin(Math.PI * x), -0.68 + 1.36 * x);
});
whoosh(stems.sfx, S[10] + 0.75, 1.6, {f0: 500, f1: 1700, q: 1, peak: 0.7, gain: 0.16, pan: [-0.65, 0.65]});

// 11 外观：三次主题划过（附点四分音符的切分），金线过中线时落一声软钟
[[1.25, 'D5'], [2, 'F#5'], [2.75, 'A5']].forEach(([d, note]) => {
  whoosh(stems.sfx, S[11] + d - 0.22, 0.48, {f0: 600, f1: 1800, q: 1, peak: 0.45, gain: 0.26, pan: [0, 0.85]});
  bell(S[11] + d, note, 0.42, 0.45);
});

// 12 上手：Prompt 打字落在十六分音符上（声像随行从左到右），然后三步依次出现
for (let t = S[12] + 0.625; t < S[12] + 2.35; t += BEAT / 4) {
  if (rand() < 0.15) continue;
  const u = (t - S[12] - 0.55) / 1.8;
  tap(t + 0.006 * rand(), {gain: 0.5 + 0.5 * rand(), pan: -0.5 + ((u * 2.3) % 1), tone: 1400 + 600 * rand()});
}
[[1.75, 'C#5', -0.49], [2, 'E5', 0], [2.25, 'A5', 0.5]].forEach(([d, note, pan]) => keys(S[12] + d, note, 0.34, pan));

// 片尾：前两拍鼓抽掉、琶音变密，一口长气推进来；光束扫过的一刻落主和弦，灯再亮，字标再写一次，仓库地址一声软钟
whoosh(stems.sfx, END - 1, 1.1, {f0: 250, f1: 2000, q: 0.8, peak: 0.92, curve: 2.2, gain: 0.34, width: 1});
thump(END); bell(END, 'A4', 0.6, -0.15); bell(END + 0.01, 'D5', 0.5, 0.15);
ocean(END, DURATION, {gain: 0.26, fadeIn: 1.25, fadeOut: 0.1});
whoosh(stems.ambience, S[13] + 0.1, 1.3, {f0: 280, f1: 1000, q: 0.8, peak: 0.6, gain: 0.26, pan: [-0.7, 0.7], width: 0.6});
const endReveal = t => beamReveal(keyframes(t, [0.1, 1.2, 5], [-70, 60, 72], SWING), 160, 512); // 同 StoryEnd
['D5', 'F#5', 'A5', 'D6'].forEach((note, i) => keys(S[13] + timeWhen(endReveal, 0.1, 1.2, 0.1 + i * 0.27), note, 0.36 - i * 0.03, -0.35 + i * 0.23));
keys(S[13] + 1, 'F#4', 0.28, -0.1); keys(S[13] + 1, 'A4', 0.24, 0.1);
bell(S[13] + 1.5, 'D6', 0.36); bell(S[13] + 1.52, 'A5', 0.24, 0.1);

/* ── 效果与母带 ───────────────────────────────────────────────── */
// Freeverb（Schroeder–Moorer 结构）：8 路梳状 + 4 路全通，左右声道错开 23 个采样。
function freeverb([inL, inR], {room = 0.86, damp = 0.45, predelay = 0.02} = {}) {
  const scale = SR / 44100, make = (lens, off) => lens.map(len => ({buf: new Float32Array(Math.round((len + off) * scale)), i: 0, store: 0}));
  const COMB = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617], ALLPASS = [556, 441, 341, 225];
  const nets = [0, 23].map(off => ({combs: make(COMB, off), aps: make(ALLPASS, off)}));
  const pre = Math.round(predelay * SR), out = bus();
  for (let n = 0; n < N; n++) {
    const x = n >= pre ? (inL[n - pre] + inR[n - pre]) * 0.015 : 0;
    for (let ch = 0; ch < 2; ch++) {
      let acc = 0;
      for (const c of nets[ch].combs) {
        const o = c.buf[c.i];
        c.store = o * (1 - damp) + c.store * damp;
        c.buf[c.i] = x + c.store * room;
        if (++c.i === c.buf.length) c.i = 0;
        acc += o;
      }
      for (const a of nets[ch].aps) {
        const b = a.buf[a.i];
        a.buf[a.i] = acc + b * 0.5;
        acc = b - acc;
        if (++a.i === a.buf.length) a.i = 0;
      }
      out[ch][n] = acc;
    }
  }
  return out;
}

// 左右交替的回声（附点八分音符，100 BPM 下 0.45 秒），回授路径里带一点低通。
function pingPong([inL, inR], {time = [0.375 * TEMPO, 0.375 * TEMPO], feedback = 0.35, tone = 2200} = {}) {
  const dl = Math.round(time[0] * SR), dr = Math.round(time[1] * SR), a = Math.exp(-2 * Math.PI * tone / SR), [yL, yR] = bus();
  let lpL = 0, lpR = 0;
  for (let i = 0; i < N; i++) {
    if (i >= dl) { lpR = lpR * a + (1 - a) * yR[i - dl]; yL[i] = inL[i - dl] + feedback * lpR; }
    if (i >= dr) { lpL = lpL * a + (1 - a) * yL[i - dr]; yR[i] = inR[i - dr] + feedback * lpL; }
  }
  return [yL, yR];
}

function render({dry, verb, echo}) {
  const e = pingPong(echo), r = freeverb([0, 1].map(ch => verb[ch].map((v, i) => v + 0.35 * e[ch][i])));
  return [0, 1].map(ch => dry[ch].map((v, i) => v + 0.5 * e[ch][i] + 1.1 * r[ch][i]));
}

// ITU-R BS.1770-4 积分响度：K 计权，400 ms 块 75% 重叠，-70 LUFS 绝对门限 + -10 LU 相对门限。
function loudness(channels) {
  const biquad = (x, [b0, b1, b2], [, a1, a2]) => {
    const y = new Float64Array(x.length);
    let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
    for (let i = 0; i < x.length; i++) { const v = b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2; x2 = x1; x1 = x[i]; y2 = y1; y1 = v; y[i] = v; }
    return y;
  };
  const sum = new Float64Array(N + 1);
  for (const x of channels) {
    const k = biquad(biquad(x, [1.53512485958697, -2.69169618940638, 1.19839281085285], [1, -1.69065929318241, 0.73248077421585]),
      [1, -2, 1], [1, -1.99004745483398, 0.99007225036621]);
    let acc = 0;
    for (let i = 0; i < N; i++) { acc += k[i] * k[i]; sum[i + 1] += acc; }
  }
  const block = 0.4 * SR, hop = 0.1 * SR, lufs = ms => -0.691 + 10 * Math.log10(ms), mean = xs => xs.reduce((a, b) => a + b, 0) / xs.length;
  const blocks = [];
  for (let s = 0; s + block <= N; s += hop) blocks.push((sum[s + block] - sum[s]) / block);
  const loud = blocks.filter(ms => lufs(ms) > -70), gate = lufs(mean(loud)) - 10;
  return lufs(mean(loud.filter(ms => lufs(ms) > gate)));
}

// 前瞻峰值限制器：增益 = 前瞻窗口内所需增益的最小值，再做一次窗口平均与缓慢释放，保证不过 ceiling。
function limit([L, R], ceiling) {
  const look = Math.round(0.004 * SR), release = 1 - Math.exp(-1 / (0.15 * SR)), need = new Float32Array(N).fill(1);
  for (let i = 0; i < N; i++) {
    const p = Math.max(Math.abs(L[i]), Math.abs(R[i]));
    if (p > ceiling) for (let k = Math.max(0, i - look); k <= i; k++) need[k] = Math.min(need[k], ceiling / p);
  }
  const prefix = new Float64Array(N + 1);
  for (let i = 0; i < N; i++) prefix[i + 1] = prefix[i] + need[i];
  let g = 1, minGain = 1;
  for (let i = 0; i < N; i++) {
    const from = Math.max(0, i - look), avg = (prefix[i + 1] - prefix[from]) / (i + 1 - from);
    g = Math.min(avg, g + (1 - g) * release);
    minGain = Math.min(minGain, g);
    L[i] *= g; R[i] *= g;
  }
  return minGain;
}

function writeWav(file, [L, R]) {
  const data = Buffer.alloc(N * 4), head = Buffer.alloc(44);
  for (let i = 0; i < N; i++) for (const [ch, x] of [[0, L], [1, R]]) {
    const v = Math.round(x[i] * 32767 + rand() - rand()); // TPDF 抖动
    data.writeInt16LE(Math.max(-32768, Math.min(32767, v)), i * 4 + ch * 2);
  }
  head.write('RIFF', 0); head.writeUInt32LE(36 + data.length, 4); head.write('WAVEfmt ', 8);
  head.writeUInt32LE(16, 16); head.writeUInt16LE(1, 20); head.writeUInt16LE(2, 22); head.writeUInt32LE(SR, 24);
  head.writeUInt32LE(SR * 4, 28); head.writeUInt16LE(4, 32); head.writeUInt16LE(16, 34); head.write('data', 36); head.writeUInt32LE(data.length, 40);
  writeFileSync(file, Buffer.concat([head, data]));
}

const rendered = Object.fromEntries(Object.entries(stems).map(([name, s]) => [name, render(s)]));
const master = bus();
const fadeOut = i => 1 - smooth((i / SR / TEMPO - (DURATION - 1.4)) / 1.4);
for (const out of Object.values(rendered)) for (let ch = 0; ch < 2; ch++) {
  out[ch] = svf(out[ch], 28, 0.707, 'hp');
  for (let i = 0; i < N; i++) { out[ch][i] *= fadeOut(i); master[ch][i] += out[ch][i]; }
}
// 母带高频搁架：5.5 kHz 以上压低约 3 dB，整体再柔和一点。
for (let ch = 0; ch < 2; ch++) { const hi = svf(master[ch], 5500, 0.707, 'hp'); for (let i = 0; i < N; i++) master[ch][i] -= 0.3 * hi[i]; }
const before = loudness(master), gain = 10 ** ((TARGET_LUFS - before) / 20);
for (const out of [master, ...Object.values(rendered)]) for (const x of out) for (let i = 0; i < N; i++) x[i] *= gain;
const minGain = limit(master, CEILING);
const report = {seconds: Number((DURATION * TEMPO).toFixed(3)), sampleRate: SR, lufs: Number(loudness(master).toFixed(2)), limiterMaxReductionDb: Number((20 * Math.log10(minGain)).toFixed(2))};

const stemsDir = arg('--stems');
if (stemsDir) {
  mkdirSync(stemsDir, {recursive: true});
  for (const [name, out] of Object.entries(rendered)) { writeWav(path.join(stemsDir, `${name}.wav`), out); report[`${name}Lufs`] = Number(loudness(out).toFixed(2)); }
}
const wavOut = arg('--wav');
if (wavOut) {
  writeWav(wavOut, master);
} else {
  // 编码成 AAC，写进 public/story/；用 @remotion/cli 自带的 ffmpeg，不需要另外安装。
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'harbour-score-')), wav = path.join(tmp, 'score.wav');
  writeWav(wav, master);
  const out = path.join(demoRoot, 'public', 'story', 'score.m4a');
  const result = spawnSync(process.execPath, [path.join(demoRoot, 'node_modules', '@remotion', 'cli', 'remotion-cli.js'), 'ffmpeg',
    '-v', 'error', '-y', '-i', wav, '-c:a', 'aac', '-b:a', '256k', '-movflags', '+faststart', '-f', 'mp4', out], {stdio: 'inherit', windowsHide: true});
  rmSync(tmp, {recursive: true, force: true});
  if (result.status !== 0) throw new Error('ffmpeg 编码失败');
  report.output = path.relative(demoRoot, out).split(path.sep).join('/');
}
console.log(JSON.stringify(report));
