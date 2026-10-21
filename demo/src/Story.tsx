import type {CSSProperties, ReactNode} from 'react';
import {AbsoluteFill, CanvasImage, Easing, Interactive, interpolate, staticFile, useCurrentFrame, useVideoConfig} from 'remotion';
import {TransitionSeries, linearTiming, type TransitionPresentationComponentProps} from '@remotion/transitions';
import {Audio} from '@remotion/media';
import '@fontsource/noto-sans-sc/400.css';
import '@fontsource/noto-sans-sc/500.css';
import '@fontsource/noto-sans-sc/700.css';
import {fontFamily} from './theme';
import './global.css';

// 「放映室 · Champagne」主题配色：与公开版 web/themes.css 的 premium-champagne 一致。
// 片中所有界面都是公开版实机截图 + 演示数据（demo/public/story/）；配乐与音效是 scripts/make-score.mjs 本地合成的音轨，无远程资源。
// 剪辑踩在 120 BPM 的拍子上：每次换场，灯塔光束扫过画面中线的一刻（场景起点 + 0.25 秒）正好是一拍，
// 场内的入场时刻也尽量落在八分音符（0.25 秒的整数倍）上。改了这里的时长或延迟，要同步 make-score.mjs。
const c = {
  bg: '#070606', bg2: '#0D0B09', panel: '#100F0D', elev: '#1C1915',
  fg: '#F3EEE3', dim: '#ABA495', faint: '#6F6A5E',
  gold: '#E2C285', steel: '#9FB0C4', border: '#3D362A', line: 'rgba(226,194,133,0.24)',
};
const clamp = {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'} as const;
const ease = {...clamp, easing: Easing.bezier(0.16, 1, 0.3, 1)} as const;
const soft = {...clamp, easing: Easing.bezier(0.45, 0, 0.2, 1)} as const;
const swing = {...clamp, easing: Easing.bezier(0.65, 0, 0.35, 1)} as const;
const SHOT = {w: 2880, h: 1800};
const shotSrc = (name: string) => staticFile(`story/${name}.jpg`);
const hand = '"Harbour Hand", cursive';

export const STORY_BEAT = 0.5;
const useSeconds = () => { const frame = useCurrentFrame(); const {fps} = useVideoConfig(); return frame / fps; };

// 一次性入场：透明度 + 短距离上浮；delay / dur 以秒计。
const Rise = ({children, delay = 0, dur = 0.7, y = 26, style}: {children: ReactNode; delay?: number; dur?: number; y?: number; style?: CSSProperties}) => {
  const t = useSeconds();
  return <div style={{...style,
    opacity: interpolate(t, [delay, delay + dur * 0.6], [0, 1], ease),
    translate: `0 ${interpolate(t, [delay, delay + dur], [y, 0], ease)}px`,
  }}>{children}</div>;
};

// 逐字入场：每个字从模糊、下沉处浮上来；\n 换行。
const Chars = ({text, delay = 0, stagger = 0.03, dur = 0.5}: {text: string; delay?: number; stagger?: number; dur?: number}) => {
  const t = useSeconds();
  let k = 0;
  return <>{text.split('\n').map((line, li) => <span key={li} style={{display: 'block'}}>{[...line].map((ch, ci) => {
    const t0 = delay + k++ * stagger, p = interpolate(t, [t0, t0 + dur], [0, 1], ease);
    return <span key={ci} style={{display: 'inline-block', whiteSpace: 'pre', opacity: interpolate(t, [t0, t0 + dur * 0.5], [0, 1], clamp),
      translate: `0 ${(1 - p) * 0.32}em`, filter: p < 1 ? `blur(${(1 - p) * 9}px)` : undefined}}>{ch}</span>;
  })}</span>)}</>;
};

// 场景底色：暖光晕 + 整场缓慢推近，画面不会停在原地。
const Stage = ({children, glow = '70% 38%'}: {children: ReactNode; glow?: string}) => {
  const t = useSeconds();
  return <AbsoluteFill style={{background: c.bg, fontFamily, color: c.fg, overflow: 'hidden'}}>
    <AbsoluteFill style={{background: `radial-gradient(70% 70% at ${glow}, rgba(226,194,133,0.075) 0%, rgba(226,194,133,0.02) 38%, transparent 70%)`}} />
    <AbsoluteFill style={{scale: interpolate(t, [0, 6], [1, 1.02], clamp), transformOrigin: '50% 45%'}}>{children}</AbsoluteFill>
  </AbsoluteFill>;
};

const Kicker = ({index, children, delay = 0}: {index: string; children: ReactNode; delay?: number}) => {
  const t = useSeconds(), p = interpolate(t, [delay, delay + 0.55], [0, 1], ease);
  return <div style={{display: 'flex', alignItems: 'center', gap: 18, fontSize: 22, fontWeight: 500, letterSpacing: `${0.6 - 0.26 * p}em`, color: c.gold,
    opacity: interpolate(t, [delay, delay + 0.3], [0, 1], clamp)}}>
    <span>{index}</span><span style={{width: 46 * p, height: 1, background: c.gold, opacity: 0.6}} /><span>{children}</span>
  </div>;
};

const Title = ({index, kicker, zh, en, size = 96, style}: {index: string; kicker: string; zh: string; en: string; size?: number; style?: CSSProperties}) => (
  <div style={{position: 'absolute', left: 140, top: 104, ...style}}>
    <Kicker index={index} delay={0.1}>{kicker}</Kicker>
    <Interactive.Div name="主标题" style={{marginTop: 26, fontSize: size, fontWeight: 700, letterSpacing: '-0.02em', lineHeight: 1.18}}>
      <Chars text={zh} delay={0.18} />
    </Interactive.Div>
    <Rise delay={0.5} y={18}><div style={{marginTop: 20, fontSize: 30, color: c.dim, letterSpacing: '0.01em'}}>{en}</div></Rise>
  </div>
);

const Note = ({children, style}: {children: ReactNode; style?: CSSProperties}) => (
  <div style={{position: 'absolute', fontSize: 21, letterSpacing: '0.06em', color: c.faint, ...style}}>{children}</div>
);

// 截图框：crop 用原图像素（2880×1800），width 为画面中的显示宽度。
type Crop = {x: number; y: number; w: number; h: number};
const Shot = ({name, width, crop, style, children}: {name: string; width: number; crop?: Crop; style?: CSSProperties; children?: ReactNode}) => {
  const r = crop ?? {x: 0, y: 0, w: SHOT.w, h: SHOT.h};
  const k = width / r.w;
  return <div style={{position: 'relative', width, height: r.h * k, overflow: 'hidden', borderRadius: 16, background: c.bg,
    border: `1px solid ${c.border}`, boxShadow: '0 40px 90px -30px rgba(0,0,0,0.9), 0 0 0 1px rgba(0,0,0,0.6), 0 0 120px -40px rgba(226,194,133,0.18)', ...style}}>
    <CanvasImage src={shotSrc(name)} style={{position: 'absolute', left: -r.x * k, top: -r.y * k, width: SHOT.w * k, height: SHOT.h * k, maxWidth: 'none'}} />
    {children}
  </div>;
};

// 手写字标；reveal 是从左往右写出的进度，写到哪里，哪里就有一团光。
const Wordmark = ({size, reveal = 1}: {size: number; reveal?: number}) => (
  <div style={{position: 'relative', fontFamily: hand, fontSize: size, fontWeight: 600, lineHeight: 1.1, letterSpacing: '-0.03em', color: c.fg}}>
    <div style={{clipPath: `inset(-20% ${(1 - reveal) * 100}% -40% -5%)`}}>Harbour</div>
    {reveal > 0 && reveal < 1 && <div style={{position: 'absolute', top: '-8%', bottom: '-8%', left: `${reveal * 100}%`, width: size * 0.55, translate: '-50% 0',
      background: 'radial-gradient(closest-side, rgba(255,236,196,0.6), rgba(226,194,133,0.2) 55%, transparent)', filter: 'blur(6px)'}} />}
  </div>
);

const Stroke = ({width, progress, color = c.gold, style}: {width: number; progress: number; color?: string; style?: CSSProperties}) => (
  <svg width={width} height={26} viewBox="0 0 520 26" preserveAspectRatio="none" style={{overflow: 'visible', ...style}}>
    <path d="M6 16C120 5 270 22 514 9" pathLength={1} fill="none" stroke={color} strokeWidth={3} strokeLinecap="round" strokeDasharray={1} strokeDashoffset={1 - progress} />
  </svg>
);

// 灯塔光束 + 海平线：开场与片尾共用。beam 是光束偏离竖直方向的角度，flare 是灯刚亮起时的一下闪光。
const Horizon = ({y, draw, beam, beacon, flare = 0}: {y: number; draw: number; beam: number; beacon: number; flare?: number}) => (
  <>
    <div style={{position: 'absolute', left: 960 - 760 * draw, width: 1520 * draw, top: y, height: 1,
      background: 'linear-gradient(90deg, transparent, rgba(226,194,133,0.75) 50%, transparent)'}} />
    <div style={{position: 'absolute', left: 960 - 1300, top: y - 1300, width: 2600, height: 1300, transformOrigin: '50% 100%', rotate: `${beam}deg`,
      clipPath: 'polygon(50% 100%, 45.5% 0, 54.5% 0)', background: 'linear-gradient(to top, rgba(226,194,133,0.3), rgba(226,194,133,0) 78%)',
      filter: 'blur(10px)', opacity: beacon}} />
    <div style={{position: 'absolute', left: 960 - 7, top: y - 7, width: 14, height: 14, borderRadius: 7, background: c.gold, opacity: beacon,
      boxShadow: `0 0 ${24 + 40 * flare}px ${8 + 14 * flare}px rgba(226,194,133,0.55), 0 0 ${90 + 160 * flare}px ${30 + 50 * flare}px rgba(226,194,133,0.18)`}} />
  </>
);
// 由光束角度推出它照到字标中线的位置（字标水平居中、宽 width，中线在灯上方 rise 像素处），字标跟着光束写出。
const beamReveal = (deg: number, rise: number, width: number) => Math.min(1, Math.max(0, 0.5 + rise * Math.tan(deg * Math.PI / 180) / width));

/* ── 00 开场：海平线、灯塔光扫过、字标被光写出 ──────────────────── */
export const StoryOpen = () => {
  const t = useSeconds();
  const beam = interpolate(t, [0.2, 1.5, 4.5], [-72, 60, 70], swing);
  const reveal = beamReveal(beam, 184, 620);
  return <Stage glow="50% 58%">
    <Horizon y={640} beam={beam}
      draw={interpolate(t, [0.05, 0.8], [0, 1], ease)}
      beacon={interpolate(t, [0.15, 0.3], [0, 1], clamp)}
      flare={interpolate(t, [0.2, 0.3, 1.1], [0, 1, 0.3], clamp)} />
    <div style={{position: 'absolute', left: 0, right: 0, top: 330, display: 'flex', justifyContent: 'center'}}>
      <Wordmark size={230} reveal={reveal} />
    </div>
    {/* 水面倒影 */}
    <div style={{position: 'absolute', left: 0, right: 0, top: 648, display: 'flex', justifyContent: 'center', scale: '1 -0.55', transformOrigin: '50% 0',
      opacity: 0.1, filter: 'blur(3px)', maskImage: 'linear-gradient(to top, black, transparent 70%)'}}>
      <Wordmark size={230} reveal={reveal} />
    </div>
    <div style={{position: 'absolute', left: 0, right: 0, top: 590, display: 'flex', justifyContent: 'center'}}>
      <Stroke width={560} progress={interpolate(t, [1.25, 1.8], [0, 1], ease)} style={{translate: '40px 0', opacity: 0.8}} />
    </div>
    <div style={{position: 'absolute', left: 0, right: 0, top: 742, textAlign: 'center', fontSize: 52, fontWeight: 500, letterSpacing: '0.04em'}}>
      <Chars text="给你的 AI 伙伴们，一个可以停靠的港湾。" delay={1.45} stagger={0.022} />
    </div>
    <Rise delay={1.9} style={{position: 'absolute', left: 0, right: 0, top: 830, textAlign: 'center'}}>
      <div style={{fontSize: 28, letterSpacing: '0.2em', color: c.dim}}>A HOME PORT FOR YOUR AI AGENTS</div>
    </Rise>
  </Stage>;
};

/* ── 01 是什么：本地 Agent 工作台 ─────────────────────────────── */
const Tag = ({children}: {children: ReactNode}) => (
  <span style={{display: 'inline-flex', alignItems: 'center', height: 54, padding: '0 24px', borderRadius: 27, border: `1px solid ${c.border}`,
    background: 'rgba(226,194,133,0.06)', fontSize: 25, color: c.fg, letterSpacing: '0.03em'}}>{children}</span>
);

export const StoryWhat = () => {
  const t = useSeconds();
  return <Stage glow="74% 46%">
    <div style={{position: 'absolute', left: 140, top: 236, width: 640}}>
      <Kicker index="01" delay={0.1}>WHAT IS HARBOUR</Kicker>
      <Interactive.Div name="主标题" style={{marginTop: 30, fontSize: 104, fontWeight: 700, letterSpacing: '-0.02em', lineHeight: 1.16}}>
        <Chars text={'你自己的\nAgent 工作台'} delay={0.18} />
      </Interactive.Div>
      <Rise delay={0.55}><div style={{marginTop: 34, fontSize: 40, lineHeight: 1.5, color: c.fg}}>角色、模型、工具，<br />都由你来配置。</div></Rise>
      <Rise delay={0.7}><div style={{marginTop: 18, fontSize: 27, lineHeight: 1.5, color: c.dim}}>Your own agent workbench —<br />roles, models and tools, set up your way.</div></Rise>
      <div style={{marginTop: 46, display: 'flex', gap: 14}}>
        {['Electron 桌面端', 'Web 面板', '本地运行'].map((tag, i) => <Rise key={tag} delay={0.95 + i * 0.08} y={16} dur={0.5}><Tag>{tag}</Tag></Rise>)}
      </div>
    </div>
    <Rise delay={0.2} y={40} style={{position: 'absolute', left: 820, top: 228, perspective: 2200}}>
      <div style={{transformOrigin: '0% 50%',
        transform: `rotateY(${interpolate(t, [0.2, 1.8, 4.5], [-18, -7, -4], ease)}deg) scale(${interpolate(t, [0, 4.5], [0.97, 1.01], clamp)})`}}>
        <Shot name="chat-champagne" width={1000} />
      </div>
    </Rise>
    <Note style={{left: 836, top: 896}}>Harbour-Lite 实机界面 · 演示数据</Note>
  </Stage>;
};

/* ── 02 伙伴：每个 Agent 一套角色 / 模型 / 工具 ───────────────── */
const Chip = ({title, sub}: {title: string; sub: string}) => (
  <div style={{width: 340, padding: '18px 0', borderRadius: 14, border: `1px solid ${c.border}`, background: c.panel, textAlign: 'center',
    boxShadow: '0 20px 50px -24px rgba(0,0,0,0.9)'}}>
    <div style={{fontSize: 30, fontWeight: 500}}>{title}</div>
    <div style={{marginTop: 6, fontSize: 20, letterSpacing: '0.14em', color: c.gold}}>{sub}</div>
  </div>
);
const CREW_AT = [1, 1.25, 1.5, 1.75]; // 四张模型卡片落下的时刻，一张一个八分音符

export const StoryCrew = () => {
  const t = useSeconds();
  const centers = [346, 755, 1165, 1574];
  const models: Array<[string, string]> = [['Claude Sonnet 5.5', 'ANTHROPIC'], ['DeepSeek V4', 'DEEPSEEK'], ['Kimi for Coding', 'KIMI'], ['OpenRouter Auto', 'OPENROUTER']];
  return <Stage glow="50% 55%">
    <Title index="02" kicker="YOUR CREW" zh="每位伙伴，各司其职" en="Each agent gets its own role, model and toolset." />
    <Rise delay={0.3} y={30} style={{position: 'absolute', left: 140, top: 392}}>
      <div style={{translate: `${interpolate(t, [0, 5.5], [10, -10], clamp)}px 0`}}>
        <Shot name="agents" width={1640} crop={{x: 80, y: 630, w: 2700, h: 500}} />
      </div>
    </Rise>
    <svg width={1920} height={1080} style={{position: 'absolute', inset: 0}}>
      {centers.map((x, i) => <path key={x} d={`M${x} 704 C${x} 744 ${x} 744 ${x} 782`} pathLength={1} stroke={c.gold} strokeWidth={2} fill="none" strokeLinecap="round"
        strokeDasharray={1} strokeDashoffset={interpolate(t, [CREW_AT[i] - 0.3, CREW_AT[i] - 0.05], [1, 0], ease)} />)}
    </svg>
    {centers.map((x, i) => <Rise key={x} delay={CREW_AT[i] - 0.08} y={16} dur={0.55} style={{position: 'absolute', left: x - 170, top: 790}}>
      <Chip title={models[i][0]} sub={models[i][1]} />
    </Rise>)}
    <Rise delay={2.2} style={{position: 'absolute', left: 140, right: 140, top: 952, textAlign: 'center'}}>
      <div style={{fontSize: 27, color: c.dim}}>
        自带 API Key <span style={{color: c.faint, margin: '0 14px'}}>·</span> Anthropic · OpenAI · DeepSeek · Kimi · OpenRouter · 自定义端点
      </div>
    </Rise>
  </Stage>;
};

/* ── 03 能力：Skill / Workflow / MCP 按需挂载 ─────────────────── */
const CapRow = ({mark, zh, en, delay}: {mark: string; zh: string; en: string; delay: number}) => (
  <Rise delay={delay} dur={0.55} style={{display: 'flex', alignItems: 'center', gap: 26, marginTop: 30}}>
    <div style={{width: 78, height: 78, borderRadius: 18, border: `1px solid ${c.border}`, background: c.elev, display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontFamily: 'Georgia, serif', fontSize: mark.length > 1 ? 24 : 38, color: c.gold, flex: 'none'}}>{mark}</div>
    <div>
      <div style={{fontSize: 36, fontWeight: 500}}>{zh}</div>
      <div style={{marginTop: 4, fontSize: 23, color: c.dim}}>{en}</div>
    </div>
  </Rise>
);

export const StorySkills = () => {
  const t = useSeconds();
  return <Stage glow="72% 52%">
    <Title index="03" kicker="CAPABILITIES" zh="能力，按需挂载" en="Skills, workflows and MCP, mounted per agent." />
    <div style={{position: 'absolute', left: 140, top: 430, width: 640}}>
      <CapRow mark="S" zh="技能 Skill" en="Reusable know-how" delay={0.7} />
      <CapRow mark="W" zh="工作流 Workflow" en="Multi-step routines" delay={0.95} />
      <CapRow mark="MCP" zh="插件 MCP" en="Connect outside tools" delay={1.2} />
      <Rise delay={1.7}><div style={{marginTop: 46, fontSize: 24, color: c.faint, lineHeight: 1.6}}>编辑能力需经 Governance 审批<br />Edits go through review</div></Rise>
    </div>
    <Rise delay={0.3} y={40} style={{position: 'absolute', left: 840, top: 392, perspective: 2200}}>
      <div style={{transformOrigin: '100% 50%', transform: `rotateY(${interpolate(t, [0.3, 1.8, 4.5], [16, 6, 3], ease)}deg)`}}>
        <Shot name="cap" width={940} crop={{x: 0, y: 120, w: 2880, h: 1680}} />
      </div>
    </Rise>
    <Note style={{left: 856, top: 964}}>界面实拍 · 能力条目为演示数据</Note>
  </Stage>;
};

/* ── 04 不止聊天：日程 / 定时任务 / 消息渠道 ──────────────────── */
const Panel = ({name, zh, en, delay, crop}: {name: string; zh: string; en: string; delay: number; crop: Crop}) => {
  const t = useSeconds();
  return <Rise delay={delay} y={56} dur={0.75}>
    <div style={{rotate: `${interpolate(t, [delay, delay + 0.9], [-3, 0], ease)}deg`}}>
      <Shot name={name} width={520} crop={crop} />
    </div>
    <div style={{marginTop: 26, fontSize: 36, fontWeight: 500}}>{zh}</div>
    <div style={{marginTop: 6, fontSize: 23, color: c.dim}}>{en}</div>
  </Rise>;
};

export const StoryDaily = () => (
  <Stage glow="50% 60%">
    <Title index="04" kicker="BEYOND CHAT" zh="不止聊天" en="Calendar, scheduled jobs and message channels, under one roof." />
    <div style={{position: 'absolute', left: 140, top: 420, display: 'flex', gap: 40}}>
      <Panel name="cal" zh="日程" en="Calendar · 接入你的日历" delay={0.45} crop={{x: 58, y: 605, w: 1382, h: 850}} />
      <Panel name="cron" zh="定时任务" en="Cron jobs · 让 Agent 按时开工" delay={0.7} crop={{x: 58, y: 554, w: 1382, h: 850}} />
      <Panel name="channels" zh="消息渠道" en="Discord · QQ 官方机器人" delay={0.95} crop={{x: 58, y: 170, w: 1505, h: 926}} />
    </div>
    <Rise delay={1.5}><Note style={{left: 140, top: 962}}>账号与机器人需自行连接 · 截图为演示数据</Note></Rise>
  </Stage>
);

/* ── 05 用量：每一次调用都有账可查 ────────────────────────────── */
export const USAGE_SWEEP = [0.75, 2.25] as const; // 金线扫过曲线的起止（秒）

export const StoryUsage = () => {
  const t = useSeconds();
  const k = 1500 / 2380;
  const chart = {left: (634 - 500) * k, right: (2729 - 500) * k, top: (677 - 300) * k, bottom: (1138 - 300) * k};
  const sweep = interpolate(t, USAGE_SWEEP, [chart.left, chart.right], soft);
  return <Stage glow="50% 62%">
    <Title index="05" kicker="USAGE & COST" zh="每一次调用，都有账可查" en="Tokens, cache hits and cost, broken down by model and agent." />
    <Rise delay={0.3} y={36} style={{position: 'absolute', left: 210, top: 376}}>
      <div style={{scale: interpolate(t, [0, 4.5], [1, 1.035], clamp), transformOrigin: '60% 60%'}}>
        <Shot name="dash" width={1500} crop={{x: 500, y: 300, w: 2380, h: 960}}>
          <div style={{position: 'absolute', left: sweep, width: Math.max(0, chart.right + 40 - sweep), top: chart.top, height: chart.bottom - chart.top, background: 'rgba(16,15,13,0.88)'}} />
          <div style={{position: 'absolute', left: sweep, width: 2, top: chart.top - 10, height: chart.bottom - chart.top + 20, background: c.gold,
            boxShadow: '0 0 18px 2px rgba(226,194,133,0.6)', opacity: interpolate(t, [USAGE_SWEEP[0] - 0.1, USAGE_SWEEP[0] + 0.05, USAGE_SWEEP[1] - 0.05, USAGE_SWEEP[1] + 0.2], [0, 1, 1, 0], clamp)}} />
        </Shot>
      </div>
    </Rise>
    <Note style={{left: 210, top: 984}}>演示数据 · 成本按各家公开价格估算，可自行维护价目表</Note>
  </Stage>;
};

/* ── 06 外观：多套主题，同一个港湾 ───────────────────────────── */
// 名称与公开版 web/app.js 的 THEME_CATEGORIES 一致。二次元主题的截图裁到聊天区为止，不带右侧的角色立绘。
const LOOKS = [
  {name: 'chat-champagne', zh: '放映室 · 香槟', en: 'Premium · Champagne', swatch: '#E2C285', glow: '226,194,133'},
  {name: 'chat-tungsten', zh: '放映室 · 钨丝', en: 'Premium · Tungsten', swatch: '#D9A45B', glow: '217,164,91'},
  {name: 'chat-wisteria', zh: '手账 · 薰衣草', en: 'Anime · Wisteria', swatch: '#8A70E0', glow: '170,150,230'},
  {name: 'chat-snowfleece', zh: '星光 · 雪绒', en: 'Anime · Snowfleece', swatch: '#F08FB0', glow: '240,143,176'},
];
export const LOOK_HIT = [1.25, 2, 2.75]; // 后三套主题划过画面中线的时刻：附点四分音符的切分节奏
const LOOK_WIPE = 0.4;
const LOOK_CROP = {x: 30, y: 176, w: 2200, h: 1520};
const LOOK_W = 880;

export const StoryLooks = () => {
  const t = useSeconds();
  const reveal = (i: number) => i === 0 ? 1 : interpolate(t, [LOOK_HIT[i - 1] - LOOK_WIPE / 2, LOOK_HIT[i - 1] + LOOK_WIPE / 2], [0, 1], soft);
  const weight = (i: number) => reveal(i) - (i + 1 < LOOKS.length ? reveal(i + 1) : 0);
  return <Stage glow="70% 60%">
    {LOOKS.map((look, i) => <AbsoluteFill key={look.name} style={{opacity: weight(i),
      background: `radial-gradient(50% 55% at 68% 62%, rgba(${look.glow},0.13), transparent 72%)`}} />)}
    <Title index="06" kicker="LOOKS" zh="换一身装扮，还是那个港湾" en="Switch themes freely. It's still your harbour." />
    <div style={{position: 'absolute', left: 140, top: 430, width: 600}}>
      {LOOKS.map((look, i) => {
        const w = weight(i);
        return <Rise key={look.name} delay={0.45 + i * 0.08}>
          <div style={{position: 'relative', height: 118, paddingLeft: 34, opacity: 0.36 + 0.64 * w, translate: `${12 * w}px 0`}}>
            <div style={{position: 'absolute', left: 0, top: 10, width: 3, height: 76, borderRadius: 2, background: c.gold, opacity: w}} />
            <div style={{display: 'flex', alignItems: 'center', gap: 16}}>
              <span style={{width: 16, height: 16, borderRadius: 8, background: look.swatch, boxShadow: `0 0 ${14 * w}px rgba(${look.glow},0.8)`}} />
              <span style={{fontSize: 36, fontWeight: 500}}>{look.zh}</span>
            </div>
            <div style={{marginTop: 8, marginLeft: 32, fontSize: 21, letterSpacing: '0.14em', color: c.dim}}>{look.en.toUpperCase()}</div>
          </div>
        </Rise>;
      })}
    </div>
    <Note style={{left: 140, top: 930}}>主题界面实拍 · 演示数据</Note>
    <Rise delay={0.25} y={40} style={{position: 'absolute', left: 1780 - LOOK_W, top: 376}}>
      <div style={{scale: interpolate(t, [0, 4.5], [0.985, 1.015], clamp)}}>
        <Shot name={LOOKS[0].name} width={LOOK_W} crop={LOOK_CROP}>
          {LOOKS.slice(1).map((look, j) => {
            const r = reveal(j + 1), k = LOOK_W / LOOK_CROP.w;
            return <div key={look.name} style={{position: 'absolute', inset: 0, clipPath: `inset(0 ${(1 - r) * 100}% 0 0)`}}>
              <CanvasImage src={shotSrc(look.name)} style={{position: 'absolute', left: -LOOK_CROP.x * k, top: -LOOK_CROP.y * k, width: SHOT.w * k, height: SHOT.h * k, maxWidth: 'none'}} />
              <div style={{position: 'absolute', top: 0, bottom: 0, left: r * LOOK_W - 2, width: 2, background: c.gold,
                boxShadow: '0 0 18px 3px rgba(226,194,133,0.55)', opacity: r > 0 && r < 1 ? 1 : 0}} />
            </div>;
          })}
        </Shot>
      </div>
    </Rise>
  </Stage>;
};

/* ── 07 上手：把安装交给编码 Agent ───────────────────────────── */
const PROMPT = '请帮我部署 Harbour 外壳：https://github.com/DemonRain7/harbour-lite 。先读取仓库的 AGENTS.md、README.md 和 docs/AGENT-SETUP.md，按交接说明在独立目录安装，保留原 Electron/Web 界面……';
export const PROMPT_TYPING = [0.55, 2.35] as const;
export const STEP_AT = [1.75, 2, 2.25];

const Step = ({n, zh, en, delay}: {n: string; zh: string; en: string; delay: number}) => (
  <Rise delay={delay} dur={0.55} style={{width: 460}}>
    <div style={{fontSize: 22, letterSpacing: '0.3em', color: c.gold}}>{n}</div>
    <div style={{marginTop: 12, fontSize: 34, fontWeight: 500}}>{zh}</div>
    <div style={{marginTop: 6, fontSize: 22, color: c.dim}}>{en}</div>
  </Rise>
);

export const StoryHandoff = () => {
  const t = useSeconds(), frame = useCurrentFrame(), {fps} = useVideoConfig();
  const typed = Math.round(interpolate(t, PROMPT_TYPING, [0, PROMPT.length], clamp));
  // 链接和文件名打完整之后变成金色，像编辑器认出了它们。
  const parts = PROMPT.slice(0, typed).split(/(https:\/\/[^\s。]+|[\w/-]+\.md)/);
  return <Stage glow="50% 48%">
    <Title index="07" kicker="GET STARTED" zh="交给你的编码 Agent 来安装" en="Hand the setup to your coding agent." />
    <Rise delay={0.3} y={30} style={{position: 'absolute', left: 140, top: 392, width: 1640}}>
      <div style={{position: 'relative', height: 250, borderRadius: 20, border: `1px solid ${c.border}`, background: c.panel, padding: '30px 44px',
        boxShadow: '0 40px 90px -36px rgba(0,0,0,0.95), 0 0 120px -50px rgba(226,194,133,0.25)'}}>
        <div style={{display: 'flex', alignItems: 'center', gap: 14, fontSize: 20, letterSpacing: '0.22em', color: c.faint}}>
          <span style={{width: 10, height: 10, borderRadius: 5, background: c.gold}} />PROMPT · 节选
        </div>
        <div style={{marginTop: 20, fontSize: 31, lineHeight: 1.62, color: c.fg}}>
          {parts.map((part, i) => i % 2 ? <span key={i} style={{color: c.gold}}>{part}</span> : part)}
          <span style={{display: 'inline-block', width: 3, height: 34, marginLeft: 4, verticalAlign: '-6px', background: c.gold,
            opacity: Math.floor(frame / (STORY_BEAT * fps)) % 2 === 0 ? 1 : 0.15}} />
        </div>
      </div>
    </Rise>
    <div style={{position: 'absolute', left: 140, top: 712, display: 'flex', gap: 130}}>
      <Step n="01" zh="复制 README 里的 Prompt" en="Copy the prompt from the README" delay={STEP_AT[0] - 0.08} />
      <Step n="02" zh="发给 Codex、Claude Code 等" en="Send it to a local coding agent" delay={STEP_AT[1] - 0.08} />
      <Step n="03" zh="先跑演示，再接自己的模型" en="Try the demo, then add your models" delay={STEP_AT[2] - 0.08} />
    </div>
    <Note style={{left: 140, top: 980}}>完整 Prompt 见 README · 需要具备本地文件与终端能力的 Agent</Note>
  </Stage>;
};

/* ── 08 片尾：光束再写一次字标，靠港 ────────────────────────────── */
export const StoryEnd = () => {
  const t = useSeconds();
  const beam = interpolate(t, [0.1, 1.2, 5], [-70, 60, 72], swing);
  return <Stage glow="50% 52%">
    <Horizon y={560} beam={beam}
      draw={interpolate(t, [0.1, 0.9], [0, 1], ease)}
      beacon={interpolate(t, [0.1, 0.25], [0, 0.95], clamp)}
      flare={interpolate(t, [0.15, 0.25, 1], [0, 1, 0.3], clamp)} />
    <div style={{position: 'absolute', left: 0, right: 0, top: 296, display: 'flex', justifyContent: 'center'}}>
      <Wordmark size={190} reveal={beamReveal(beam, 160, 512)} />
    </div>
    <div style={{position: 'absolute', left: 0, right: 0, top: 616, textAlign: 'center'}}>
      <div style={{fontSize: 54, fontWeight: 500, letterSpacing: '0.04em'}}><Chars text="让每一位 Agent，都有处停靠。" delay={0.95} stagger={0.025} /></div>
      <Rise delay={1.3}><div style={{marginTop: 16, fontSize: 28, letterSpacing: '0.2em', color: c.dim}}>A HARBOUR FOR YOUR AGENTS</div></Rise>
    </div>
    <Rise delay={1.45} style={{position: 'absolute', left: 0, right: 0, top: 812, display: 'flex', justifyContent: 'center'}}>
      <div style={{padding: '16px 34px', borderRadius: 40, border: `1px solid ${c.line}`, background: 'rgba(226,194,133,0.07)', fontSize: 32, color: c.gold, letterSpacing: '0.04em'}}>
        github.com/DemonRain7/harbour-lite
      </div>
    </Rise>
    <Rise delay={1.9}><Note style={{left: 0, right: 0, top: 978, textAlign: 'center'}}>公开版准备中 · 尚未正式发布 · 界面为演示数据</Note></Rise>
    <AbsoluteFill style={{background: '#000', opacity: interpolate(t, [4.2, 5], [0, 1], clamp)}} />
  </Stage>;
};

// 场间：一道斜着的灯塔光束从左扫到右，光束身后是新场景，身前的旧场景被推开、压暗；不过黑场，画面一直在动。
const BEAM_SLANT = 260; // 光束上端比下端偏右多少像素
const BeamWipe = ({children, presentationDirection, presentationProgress}: TransitionPresentationComponentProps<Record<string, never>>) => {
  const e = interpolate(presentationProgress, [0, 1], [0, 1], swing);
  const x = interpolate(e, [0, 1], [-BEAM_SLANT, 1920 + BEAM_SLANT]);
  if (presentationDirection === 'exiting') {
    return <AbsoluteFill style={{translate: `${-70 * e}px 0`}}>
      {children}
      <AbsoluteFill style={{background: '#000', opacity: 0.5 * e}} />
    </AbsoluteFill>;
  }
  const glow = Math.sin(Math.PI * presentationProgress);
  return <AbsoluteFill>
    <AbsoluteFill style={{clipPath: `polygon(-200px 0, ${x + BEAM_SLANT / 2}px 0, ${x - BEAM_SLANT / 2}px 1080px, -200px 1080px)`}}>
      <AbsoluteFill style={{translate: `${70 * (1 - e)}px 0`}}>{children}</AbsoluteFill>
    </AbsoluteFill>
    <div style={{position: 'absolute', left: x - 450, top: -260, width: 900, height: 1600, rotate: `${Math.atan(BEAM_SLANT / 1080) * 180 / Math.PI}deg`, opacity: glow,
      background: 'linear-gradient(90deg, transparent, rgba(226,194,133,0.07) 30%, rgba(226,194,133,0.2) 47%, transparent 62%)'}} />
    <div style={{position: 'absolute', left: x - 70, top: -260, width: 140, height: 1600, rotate: `${Math.atan(BEAM_SLANT / 1080) * 180 / Math.PI}deg`, opacity: glow,
      background: 'linear-gradient(90deg, transparent, rgba(226,194,133,0.45) 40%, rgba(255,241,214,0.95) 50%, rgba(226,194,133,0.3) 58%, transparent)', filter: 'blur(5px)'}} />
  </AbsoluteFill>;
};

// 底部航线：01–07 七个章节的刻度，光点从左驶向右，在片尾靠港；光点随拍子轻轻一亮。
const Voyage = () => {
  const t = useSeconds();
  const hits = STORY_STARTS.slice(1).map(s => s + STORY_TRANSITION_SECONDS / 2);
  const from = hits[0], to = hits[hits.length - 1], x = (u: number) => 140 + 1640 * u;
  const p = interpolate(t, [from, to], [0, 1], clamp);
  const sinceBeat = ((t - from) % STORY_BEAT + STORY_BEAT) % STORY_BEAT, pulse = Math.exp(-sinceBeat / 0.12);
  return <div style={{position: 'absolute', inset: 0, pointerEvents: 'none', opacity: interpolate(t, [from - 0.25, from + 0.25, to - 0.4, to], [0, 1, 1, 0], clamp)}}>
    <div style={{position: 'absolute', left: 140, width: 1640, top: 1048, height: 1, background: 'rgba(226,194,133,0.14)'}} />
    <div style={{position: 'absolute', left: 140, width: 1640 * p, top: 1048, height: 1, background: 'linear-gradient(90deg, rgba(226,194,133,0.06), rgba(226,194,133,0.55))'}} />
    {hits.map((h, i) => {
      const u = (h - from) / (to - from), last = i === hits.length - 1, on = !last && t >= h && t < hits[i + 1];
      return <div key={h}>
        <div style={{position: 'absolute', left: x(u), top: last ? 1044 : 1045, width: last ? 9 : 1, height: last ? 9 : 7, translate: last ? '-4px 0' : undefined,
          borderRadius: last ? 5 : 0, border: last ? `1px solid ${c.gold}` : undefined, background: last ? 'transparent' : 'rgba(226,194,133,0.4)'}} />
        {!last && <div style={{position: 'absolute', left: x(u) - 20, width: 40, top: 1018, textAlign: 'center', fontSize: 14, letterSpacing: '0.12em', color: on ? c.gold : c.faint}}>
          {String(i + 1).padStart(2, '0')}</div>}
      </div>;
    })}
    <div style={{position: 'absolute', left: x(p) - 4, top: 1044, width: 9, height: 9, borderRadius: 5, background: c.gold,
      boxShadow: `0 0 ${8 + 16 * pulse}px ${2 + 3 * pulse}px rgba(226,194,133,${0.35 + 0.4 * pulse})`}} />
  </div>;
};

// 胶片颗粒 + 暗角，覆盖整片。
const Finish = () => (
  <AbsoluteFill style={{pointerEvents: 'none'}}>
    <AbsoluteFill style={{background: 'radial-gradient(120% 100% at 50% 50%, transparent 55%, rgba(0,0,0,0.55) 100%)'}} />
    <svg width={1920} height={1080} style={{position: 'absolute', inset: 0, opacity: 0.07, mixBlendMode: 'screen'}}>
      <filter id="grain"><feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves={2} stitchTiles="stitch" /><feColorMatrix type="saturate" values="0" /></filter>
      <rect width="100%" height="100%" filter="url(#grain)" />
    </svg>
  </AbsoluteFill>
);

export const STORY_SCENES = [
  {name: '开场 · 港湾', seconds: 4.5, component: StoryOpen},
  {name: '01 本地 Agent 工作台', seconds: 4.5, component: StoryWhat},
  {name: '02 每位伙伴各司其职', seconds: 5.5, component: StoryCrew},
  {name: '03 能力按需挂载', seconds: 4.5, component: StorySkills},
  {name: '04 不止聊天', seconds: 4.5, component: StoryDaily},
  {name: '05 用量与成本', seconds: 4.5, component: StoryUsage},
  {name: '06 多套主题', seconds: 4.5, component: StoryLooks},
  {name: '07 交给编码 Agent 安装', seconds: 5.5, component: StoryHandoff},
  {name: '片尾', seconds: 5, component: StoryEnd},
] as const;
export const STORY_TRANSITION_SECONDS = 0.5;
// 各场景在成片里的起点（秒）：前一场起点 + 时长 - 转场重叠。
export const STORY_STARTS = STORY_SCENES.map((_, i) => STORY_SCENES.slice(0, i).reduce((sum, scene) => sum + scene.seconds - STORY_TRANSITION_SECONDS, 0));
export const storyDurationInFrames = (fps: number) =>
  Math.round(STORY_SCENES.reduce((sum, scene) => sum + scene.seconds, 0) * fps - (STORY_SCENES.length - 1) * STORY_TRANSITION_SECONDS * fps);

export const HarbourStory = () => {
  const {fps} = useVideoConfig();
  return <AbsoluteFill style={{background: c.bg}}>
    <TransitionSeries>
      {STORY_SCENES.flatMap(({name, seconds, component: Scene}, i) => [
        ...(i ? [<TransitionSeries.Transition key={`t${i}`} presentation={{component: BeamWipe, props: {}}} timing={linearTiming({durationInFrames: STORY_TRANSITION_SECONDS * fps})} />] : []),
        <TransitionSeries.Sequence key={name} name={name} durationInFrames={seconds * fps}><Scene /></TransitionSeries.Sequence>,
      ])}
    </TransitionSeries>
    <Voyage />
    <Finish />
    {/* 原创合成配乐 + 音效，时间轴与上面的场景一一对应；改了场景时长或入场时刻要重跑 npm run score。 */}
    <Audio src={staticFile('story/score.m4a')} />
  </AbsoluteFill>;
};
