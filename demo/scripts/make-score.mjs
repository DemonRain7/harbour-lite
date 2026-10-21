// HarbourStory 的配乐与音效：全部在本地用代码合成（加法合成 + 滤波噪声 + 混响），
// 不下载素材、不调用模型或任何外部服务；固定随机种子，每次输出相同的音频。
// 时间轴照抄 src/Story.tsx 的 STORY_SCENES 与各场景里的 Rise 延迟。那边改了时长或延迟，
// 要同步这里的 SCENES / 事件表，再重新生成。
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

/* ── 时间轴（秒）：与 src/Story.tsx 一致 ─────────────────────────── */
const SCENES = [5, 6, 6.5, 5.5, 6.5, 5.5, 6.5, 6.5, 5.5];
const FADE = 0.5;
const S = SCENES.map((_, i) => SCENES.slice(0, i).reduce((sum, sec) => sum + sec - FADE, 0)); // 各场景在成片里的起点
const DURATION = S.at(-1) + SCENES.at(-1);
assert.equal(DURATION, 49.5);
const DIP = S.slice(1).map(s => s + FADE / 2); // 转场压到最暗的一刻
const N = Math.round(DURATION * SR);

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
  for (let k = 1; k < points.length; k++) {
    if (t <= points[k][0]) { const [t0, v0] = points[k - 1], [t1, v1] = points[k]; return v0 + (v1 - v0) * smooth((t - t0) / (t1 - t0)); }
  }
  return points.at(-1)[1];
};
// 与 Remotion 的 Easing.bezier 相同的三次贝塞尔；timeAt 反求「进度到 y 时的时间比例」。
const bezier = (x1, y1, x2, y2) => {
  const at = (s, a, b) => 3 * (1 - s) ** 2 * s * a + 3 * (1 - s) * s ** 2 * b + s ** 3;
  return {timeAt: y => { let lo = 0, hi = 1; for (let k = 0; k < 40; k++) { const m = (lo + hi) / 2; if (at(m, y1, y2) < y) lo = m; else hi = m; } return at(lo, x1, x2); }};
};

// 每条分轨：干声 + 混响送出 + 回声送出；分开是为了能单独检查配乐、音效、环境声的电平。
const bus = () => [new Float32Array(N), new Float32Array(N)];
const stem = () => ({dry: bus(), verb: bus(), echo: bus()});
const stems = {pad: stem(), bass: stem(), music: stem(), sfx: stem(), ambience: stem()};

function place(target, t0, mono, {gain = 1, pan = 0, verb = 0.3, echo = 0} = {}) {
  const i0 = Math.round(t0 * SR);
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
// 一组按指数衰减的分音：[频率倍数, 幅度, 衰减时间常数(秒)]。
function partials(f, list, {dur, attack = 0.004}) {
  const n = Math.round(dur * SR), out = new Float32Array(n);
  for (const [ratio, amp, tau] of list) {
    if (f * ratio > 18000) continue;
    const w = 2 * Math.PI * f * ratio / SR, ph = rand() * 2 * Math.PI, decay = Math.exp(-1 / (tau * SR));
    let env = amp;
    for (let i = 0; i < n; i++) { out[i] += env * Math.sin(ph + w * i); env *= decay; }
  }
  const na = Math.max(1, Math.round(attack * SR)), nr = Math.min(n, Math.round(0.04 * SR));
  for (let i = 0; i < na && i < n; i++) out[i] *= i / na;
  for (let i = 0; i < nr; i++) out[n - 1 - i] *= i / nr;
  return out;
}

// 键音（钢片琴 / 电钢的中间）：标题、卡片、步骤出现时落一个和弦内音。
const keys = (t, note, vel, pan = 0) => {
  const f = hz(note), damp = (523 / f) ** 0.35;
  place(stems.music, t, partials(f, [[1, 1, 1.15 * damp], [2, 0.3, 0.55 * damp], [3, 0.08, 0.3 * damp], [5.93, 0.1, 0.035]], {dur: 3.2}),
    {gain: 0.24 * vel, pan, verb: 0.45, echo: 0.22});
};
// 玻璃风铃（自由振动棒的分音比）：灯塔、主题切换、曲线扫过。
const glass = (t, note, vel, pan = 0) =>
  place(stems.music, t, partials(hz(note), [[1, 1, 2.4], [2.756, 0.4, 1.0], [5.404, 0.18, 0.42], [8.933, 0.07, 0.2]], {dur: 5, attack: 0.002}),
    {gain: 0.14 * vel, pan, verb: 0.7, echo: 0.3});
// 界面提示音：极短的定音“嘀”。
const pip = (t, note, vel, pan = 0) =>
  place(stems.sfx, t, partials(hz(note), [[1, 1, 0.05], [2, 0.22, 0.022]], {dur: 0.3, attack: 0.0015}), {gain: 0.28 * vel, pan, verb: 0.3});
// 转场最暗处一点低频的“落地”感。
const thump = t => place(stems.sfx, t - 0.03, partials(55, [[1, 1, 0.22], [2.01, 0.25, 0.09]], {dur: 0.9, attack: 0.025}), {gain: 0.16, verb: 0.15});

// 气流声：两路独立白噪声过带通，中心频率按指数从 f0 扫到 f1，包络在 peak 处最大。
function whoosh(target, t0, dur, {f0, f1, q = 1.1, peak = 0.5, curve = 1, gain = 1, pan = [0, 0], width = 0.5, verb = 0.35}) {
  const n = Math.round(dur * SR), freq = i => f0 * (f1 / f0) ** (i / n);
  for (const side of [-1, 1]) {
    const out = svf(Float32Array.from({length: n}, noise), freq, q, 'bp');
    for (let i = 0; i < n; i++) {
      const u = i / n, env = u < peak ? smooth(u / peak) : smooth((1 - u) / (1 - peak));
      out[i] *= env ** curve * Math.sqrt(1000 / freq(i));
    }
    place(target, t0, out, {gain: gain * 0.7, pan: u => pan[0] + (pan[1] - pan[0]) * u + side * width / 2, verb});
  }
}

// 键盘轻敲：极短的带通噪声 + 一点落键的低频。
function click(t, {gain = 1, pan = 0, tone = 3200}) {
  const n = Math.round(0.035 * SR), hi = svf(Float32Array.from({length: n}, noise), tone, 1.4, 'bp'), out = new Float32Array(n);
  for (let i = 0; i < n; i++) { const s = i / SR; out[i] = hi[i] * Math.exp(-s / 0.004) + 0.45 * Math.sin(2 * Math.PI * 190 * s) * Math.exp(-s / 0.008); }
  place(stems.sfx, t, out, {gain: 0.55 * gain, pan, verb: 0.12});
}

// 海浪：棕噪声低通随浪涌开合，再叠一点浪尖的沙沙声；左右声道相位错开。
function ocean(t0, t1, {gain, fadeIn, fadeOut}) {
  const n = Math.round((t1 - t0) * SR), len = t1 - t0;
  for (const [pan, offset] of [[-0.65, 0], [0.65, 0.41]]) {
    const swell = i => { const x = (i / SR / 6.2 + offset) % 1; return x < 0.62 ? smooth(x / 0.62) : smooth((1 - x) / 0.38); };
    const brown = new Float32Array(n);
    for (let i = 0, b = 0; i < n; i++) { b = 0.996 * b + 0.06 * noise(); brown[i] = b; }
    const low = svf(brown, i => 220 + 900 * swell(i), 0.6, 'lp');
    const foam = svf(Float32Array.from({length: n}, noise), i => 1700 + 1900 * swell(i), 0.5, 'bp');
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const s = swell(i), t = i / SR;
      out[i] = (low[i] * (0.35 + 0.65 * s) + foam[i] * 0.22 * s ** 3) * smooth(t / fadeIn) * smooth((len - t) / fadeOut);
    }
    place(stems.ambience, t0, out, {gain, pan, verb: 0.2});
  }
}

// 持续音（铺底和低音）：带限波表 + 轻微失谐的几路振荡器 + 缓慢起伏。
function sustain(target, t0, t1, f, {attack, release, gain, voices = [[-6, -0.45], [0, 0], [6, 0.45]], tilt = 1.7, maxHarmonic = 24, verb = 0.6}) {
  const SIZE = 4096, table = new Float32Array(SIZE + 1);
  for (let h = 1; h <= maxHarmonic && h * f < 9000; h++) for (let i = 0; i <= SIZE; i++) table[i] += Math.sin(2 * Math.PI * h * i / SIZE) / h ** tilt;
  const peak = table.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  const n = Math.round((t1 + release - t0) * SR), hold = t1 - t0;
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

/* ── 和声：每次转场最暗处换和弦，D 大调 I–vi–IV–I6–ii–IV–vi–IV–V–I ── */
const CHORDS = [
  {at: 0, bass: 'D2', pad: ['D3', 'A3', 'E4', 'F#4']},               // 开场 D add9
  {at: DIP[0], bass: 'B1', pad: ['D3', 'F#3', 'A3', 'C#4']},         // 01 Bm9
  {at: DIP[1], bass: 'G1', pad: ['D3', 'G3', 'B3', 'F#4']},          // 02 Gmaj7
  {at: DIP[2], bass: 'F#2', pad: ['D3', 'A3', 'D4', 'E4']},          // 03 D/F#
  {at: DIP[3], bass: 'E2', pad: ['D3', 'G3', 'B3', 'F#4']},          // 04 Em9
  {at: DIP[4], bass: 'G1', pad: ['D3', 'B3', 'E4', 'A4']},           // 05 G6/9
  {at: DIP[5], bass: 'B1', pad: ['D3', 'F#3', 'A3', 'E4']},          // 06 Bm11
  {at: S[6] + 3.5, bass: 'G1', pad: ['D3', 'G3', 'B3', 'F#4']},      // 06 第三套主题划入：Gmaj7
  {at: DIP[6], bass: 'A1', pad: ['D3', 'E3', 'A3', 'B3']},           // 07 Asus4 add9
  {at: S[7] + 2.2, bass: 'A1', pad: ['C#3', 'E3', 'A3', 'B3']},      // 07 三步出现：A add9
  {at: DIP[7], bass: 'D2', pad: ['D3', 'A3', 'C#4', 'E4', 'F#4']},   // 片尾 Dmaj9，回到主和弦
];
for (const [k, chord] of CHORDS.entries()) {
  const t0 = chord.at, t1 = CHORDS[k + 1]?.at ?? DURATION, attack = k ? 1.3 : 3.2;
  for (const note of chord.pad) sustain(stems.pad, t0, t1, hz(note), {attack, release: 1.8, gain: 0.036});
  for (const note of chord.pad.slice(-2)) sustain(stems.pad, t0, t1, hz(note) * 2, {attack: attack * 1.4, release: 2, gain: 0.01});
  sustain(stems.bass, t0, t1, hz(chord.bass), {attack, release: 1.4, gain: 0.1, voices: [[0, 0]], tilt: 2.4, maxHarmonic: 4, verb: 0.12});
}
// 铺底的“天色”：开场由暗转亮，片尾字标出现时再亮一点，最后收暗。
const padCutoff = ramp([[0, 260], [4.2, 2100], [S[8] - 0.2, 2100], [S[8] + 1.4, 3200], [47.6, 2200], [DURATION, 700]]);
for (const b of [stems.pad.dry, stems.pad.verb]) for (let ch = 0; ch < 2; ch++) b[ch] = svf(b[ch], i => padCutoff(i / SR) * (1 + 0.1 * Math.sin(2 * Math.PI * i / SR / 9)), 0.75, 'lp');

/* ── 事件表：对应每个场景里的画面动作 ─────────────────────────── */
// 开场 0–5s：海平线、灯塔光束扫过、手写字标
ocean(0, 7.2, {gain: 0.36, fadeIn: 1.6, fadeOut: 2.6});
whoosh(stems.sfx, 0.1, 1.5, {f0: 380, f1: 1400, peak: 0.55, gain: 0.32, width: 1.2});              // 海平线从中间向两侧画开
whoosh(stems.ambience, 0.4, 4.4, {f0: 260, f1: 760, q: 0.8, gain: 0.22, pan: [-0.7, 0.7]});         // 光束从左扫到右
glass(0.4, 'A5', 0.6);                                                                              // 灯塔亮起
['D5', 'F#5', 'A5', 'E6'].forEach((note, i) => keys(1.05 + i * 0.3, note, 0.42 - i * 0.04, -0.35 + i * 0.23)); // 字标从左往右写出
whoosh(stems.sfx, 1.0, 1.3, {f0: 2600, f1: 7000, q: 1.6, peak: 0.7, gain: 0.1, pan: [-0.4, 0.4]});
whoosh(stems.sfx, 1.7, 0.95, {f0: 1100, f1: 4200, q: 1.3, peak: 0.42, gain: 0.26, pan: [-0.45, 0.5]}); // 金色下划线
keys(2.5, 'F#4', 0.3, -0.1); keys(2.5, 'D5', 0.32, 0.1);                                           // 中文标语
glass(2.9, 'E6', 0.28, 0.15);                                                                       // 英文副标

// 每次转场：吸进暗处的一口气 + 落地
DIP.forEach((t, i) => {
  whoosh(stems.sfx, t - 0.55, 1.0, {f0: 420, f1: 2600, q: 0.9, peak: 0.55, curve: 2, gain: 0.42, pan: i % 2 ? [0.25, -0.25] : [-0.25, 0.25]});
  thump(t);
});

// 各场景标题（主标题 + 英文副标题）各落一个音，逐场向上走
const TITLE = [null, ['F#4', 'C#5'], ['G4', 'D5'], ['A4', 'E5'], ['B4', 'F#5'], ['D5', 'A5'], ['E5', 'B5'], ['E5', 'A5']];
TITLE.forEach((pair, i) => {
  if (!pair) return;
  const [zh, en] = i === 1 ? [0.35, 0.6] : [0.4, 0.65];
  keys(S[i] + zh, pair[0], 0.34, -0.35); keys(S[i] + en, pair[1], 0.24, -0.2);
});

// 01 是什么：三枚标签
['F#5', 'A5', 'B5'].forEach((note, i) => pip(S[1] + 1.12 + i * 0.07, note, 0.55, -0.55 + i * 0.1));

// 02 伙伴：四条连线依次画下，四张模型卡片依次落下；声像跟着卡片的横向位置
[346, 755, 1165, 1574].forEach((x, i) => {
  const pan = (x - 960) / 1200;
  pip(S[2] + 1.3 + i * 0.15, 'A5', 0.5, pan);
  keys(S[2] + 1.62 + i * 0.15, ['G4', 'B4', 'D5', 'F#5'][i], 0.34, pan);
});

// 03 能力：Skill / Workflow / MCP 三行依次挂载
['D5', 'E5', 'A5'].forEach((note, i) => { click(S[3] + 0.92 + i * 0.2, {gain: 1.4, pan: -0.5, tone: 2400}); keys(S[3] + 0.95 + i * 0.2, note, 0.3, -0.45); });

// 04 不止聊天：三张局部截图依次上浮
[[0.7, 'E5', -0.47], [0.9, 'G5', 0], [1.1, 'B5', 0.47]].forEach(([d, note, pan]) => {
  whoosh(stems.sfx, S[4] + d - 0.05, 0.5, {f0: 1500, f1: 500, q: 0.8, peak: 0.35, gain: 0.3, pan: [pan, pan], width: 0.3});
  keys(S[4] + d + 0.12, note, 0.3, pan);
});

// 05 用量：金线扫出曲线。按 soft 缓动反算金线经过每个音的时刻，D 大调五声音阶向上，声像跟着金线走
const softEase = bezier(0.45, 0, 0.2, 1);
const SHIMMER = ['D5', 'E5', 'F#5', 'A5', 'B5', 'D6', 'E6', 'F#6', 'A6', 'B6'];
SHIMMER.forEach((note, j) => {
  const x = j / (SHIMMER.length - 1);
  glass(S[5] + 1.0 + 2.2 * softEase.timeAt(x), note, 0.24 + 0.1 * Math.sin(Math.PI * x), -0.68 + 1.36 * x);
});
whoosh(stems.sfx, S[5] + 1.0, 2.4, {f0: 1400, f1: 6500, q: 1.4, peak: 0.75, gain: 0.2, pan: [-0.65, 0.65]});

// 06 外观：三次主题划入（金线从左到右），每次划完落一声风铃
[[2.2, 'F#5'], [3.5, 'B5'], [4.8, 'D6']].forEach(([d, note]) => {
  whoosh(stems.sfx, S[6] + d - 0.08, 0.75, {f0: 900, f1: 5200, q: 1.2, peak: 0.55, gain: 0.38, pan: [-0.1, 0.75]});
  glass(S[6] + d + 0.5, note, 0.36, 0.55);
});

// 07 上手：Prompt 打字（两行，声像随行从左到右），然后三步依次出现
for (let t = S[7] + 0.9; t < S[7] + 3.6; t += (0.6 + 0.8 * rand()) / 18) {
  const u = (t - S[7] - 0.9) / 2.7;
  click(t, {gain: 0.45 + 0.55 * rand(), pan: -0.5 + ((u * 2) % 1), tone: 2800 + 1600 * rand()});
}
[[2.2, 'C#5', -0.49], [2.45, 'E5', 0], [2.7, 'A5', 0.5]].forEach(([d, note, pan]) => keys(S[7] + d + 0.05, note, 0.32, pan));

// 片尾：海浪回来，灯塔再亮，字标写出，最后仓库地址一声风铃
ocean(S[8] + 0.2, DURATION, {gain: 0.28, fadeIn: 2, fadeOut: 0.1});
whoosh(stems.sfx, S[8] + 0.2, 1.3, {f0: 380, f1: 1400, peak: 0.55, gain: 0.28, width: 1.2});
whoosh(stems.ambience, S[8] + 0.2, 4.8, {f0: 260, f1: 700, q: 0.8, gain: 0.2, pan: [-0.5, 0.5]});
glass(S[8] + 0.3, 'A5', 0.5);
['D5', 'F#5', 'A5', 'E6'].forEach((note, i) => keys(S[8] + 0.35 + i * 0.25, note, 0.4 - i * 0.03, -0.3 + i * 0.2));
glass(S[8] + 1.5, 'D6', 0.45); glass(S[8] + 1.52, 'A5', 0.3);

/* ── 效果与母带 ───────────────────────────────────────────────── */
// Freeverb（Schroeder–Moorer 结构）：8 路梳状 + 4 路全通，左右声道错开 23 个采样。
function freeverb([inL, inR], {room = 0.88, damp = 0.32, predelay = 0.02} = {}) {
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

// 左右交替的回声，回授路径里带一点低通。
function pingPong([inL, inR], {time = [0.36, 0.54], feedback = 0.33, tone = 3000} = {}) {
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
const fadeOut = i => 1 - smooth((i / SR - 47.2) / 2.25);
for (const out of Object.values(rendered)) for (let ch = 0; ch < 2; ch++) {
  out[ch] = svf(out[ch], 28, 0.707, 'hp');
  for (let i = 0; i < N; i++) { out[ch][i] *= fadeOut(i); master[ch][i] += out[ch][i]; }
}
const before = loudness(master), gain = 10 ** ((TARGET_LUFS - before) / 20);
for (const out of [master, ...Object.values(rendered)]) for (const x of out) for (let i = 0; i < N; i++) x[i] *= gain;
const minGain = limit(master, CEILING);
const report = {seconds: DURATION, sampleRate: SR, lufs: Number(loudness(master).toFixed(2)), limiterMaxReductionDb: Number((20 * Math.log10(minGain)).toFixed(2))};

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
