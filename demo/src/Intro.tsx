import type {CSSProperties, ReactNode} from 'react';
import {AbsoluteFill, Easing, Interactive, interpolate, useCurrentFrame, useVideoConfig} from 'remotion';
import {TransitionSeries, linearTiming, type TransitionPresentationComponentProps} from '@remotion/transitions';
import '@fontsource/noto-sans-sc/400.css';
import '@fontsource/noto-sans-sc/500.css';
import '@fontsource/noto-sans-sc/700.css';
import {fontFamily, palette as p} from './theme';
import './global.css';

const ease = Easing.bezier(0.16, 1, 0.3, 1);
const clamp = {extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: ease} as const;

// Fade through the paper background so successive headlines never double-expose.
const PaperTransition = ({children, presentationDirection, presentationProgress}: TransitionPresentationComponentProps<Record<string, never>>) => (
  <AbsoluteFill style={{opacity: presentationDirection === 'exiting'
    ? interpolate(presentationProgress, [0, 0.48], [1, 0], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'})
    : interpolate(presentationProgress, [0.52, 1], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'})}}>
    {children}
  </AbsoluteFill>
);

// All imagery is original code-native geometry. This is not a screen recording.
const HarbourMark = ({size = 46, light = false}: {size?: number; light?: boolean}) => (
  <svg width={size} height={size} viewBox="0 0 64 64" fill="none" aria-hidden="true">
    <path d="M14 11v30c0 9 7 14 18 14s18-5 18-14V11" stroke={light ? p.mint : p.ink} strokeWidth="8" strokeLinecap="round" />
    <path d="M14 30h36" stroke={light ? p.mint : p.ink} strokeWidth="8" strokeLinecap="round" />
    <circle cx="32" cy="12" r="4" fill={light ? p.paper : p.ink} />
  </svg>
);

const Arrow = ({size = 36, color = p.ink}: {size?: number; color?: string}) => (
  <svg width={size} height={size} viewBox="0 0 48 48" fill="none">
    <path d="M8 24h30M27 12l12 12-12 12" stroke={color} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const Check = ({size = 27}: {size?: number}) => (
  <svg width={size} height={size} viewBox="0 0 28 28" fill="none">
    <path d="m6 14 5 5L22 8" stroke={p.ink} strokeWidth="2.8" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

const FolderIcon = ({size = 42}: {size?: number}) => (
  <svg width={size} height={size} viewBox="0 0 52 44" fill="none">
    <path d="M4 13V8a4 4 0 0 1 4-4h13l6 7h17a4 4 0 0 1 4 4v21a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4V13Z" fill={p.mint} stroke={p.ink} strokeWidth="2.5" />
    <path d="M5 15h42" stroke={p.ink} strokeWidth="2.5" />
  </svg>
);

const Reveal = ({children, delay = 0, style}: {children: ReactNode; delay?: number; style?: CSSProperties}) => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  return <div style={{
    ...style,
    opacity: interpolate(frame, [delay * fps, (delay + 0.7) * fps], [0, 1], clamp),
    translate: `0 ${interpolate(frame, [delay * fps, (delay + 0.9) * fps], [28, 0], clamp)}px`,
  }}>{children}</div>;
};

const Shell = ({children, number, dark = false}: {children: ReactNode; number: string; dark?: boolean}) => (
  <AbsoluteFill style={{background: dark ? p.ink : p.paper, color: dark ? p.paper : p.ink, fontFamily, overflow: 'hidden'}}>
    <div style={{position: 'absolute', top: 64, left: 132, display: 'flex', alignItems: 'center', gap: 16}}>
      <HarbourMark light={dark} size={40} />
      <div style={{fontSize: 25, letterSpacing: 2.2, fontWeight: 500}}>HARBOUR LITE</div>
    </div>
    <div style={{position: 'absolute', top: 69, right: 132, fontSize: 21, letterSpacing: 3, opacity: 0.55}}>{number} / 06</div>
    {children}
    <div style={{position: 'absolute', bottom: 64, left: 132, fontSize: 23, opacity: 0.7}}>轻量 Agent 启动器</div>
    <div style={{position: 'absolute', bottom: 64, right: 132, fontSize: 21, letterSpacing: 1, opacity: 0.55}}>PUBLIC EDITION</div>
  </AbsoluteFill>
);

const Eyebrow = ({children}: {children: ReactNode}) => (
  <div style={{fontSize: 22, letterSpacing: 4, color: p.muted, marginBottom: 30, fontWeight: 500}}>{children}</div>
);

const Headline = ({children, size = 108}: {children: ReactNode; size?: number}) => (
  <Interactive.Div name="Headline" style={{fontSize: size, fontWeight: 700, lineHeight: 1.25, letterSpacing: -3}}>{children}</Interactive.Div>
);

const Supporting = ({children, style}: {children: ReactNode; style?: CSSProperties}) => (
  <div style={{fontSize: 35, lineHeight: 1.8, color: p.muted, ...style}}>{children}</div>
);

const Panel = ({children, title, style}: {children: ReactNode; title: string; style?: CSSProperties}) => (
  <div style={{border: `1.5px solid ${p.line}`, borderRadius: 28, background: p.white, boxShadow: '0 26px 70px rgba(21,62,64,0.06)', overflow: 'hidden', ...style}}>
    <div style={{height: 74, display: 'flex', alignItems: 'center', padding: '0 30px', gap: 12, borderBottom: `1px solid ${p.line}`, fontSize: 23, color: p.muted}}>
      <div style={{display: 'flex', gap: 7, marginRight: 9}}>{[0, 1, 2].map(i => <div key={i} style={{width: 8, height: 8, background: p.line, borderRadius: 9}} />)}</div>
      <span>{title}</span>
      <span style={{marginLeft: 'auto', fontSize: 17, border: `1px solid ${p.line}`, borderRadius: 30, padding: '5px 12px', color: p.muted}}>界面示意</span>
    </div>
    {children}
  </div>
);

const Tag = ({children, pale = false}: {children: ReactNode; pale?: boolean}) => (
  <div style={{display: 'inline-flex', alignItems: 'center', gap: 10, fontSize: 24, padding: '12px 19px', borderRadius: 13, background: pale ? p.paper : p.mint, color: p.ink}}>{children}</div>
);

export const WelcomeScene = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  return <Shell number="01">
    <Reveal style={{position: 'absolute', left: 132, top: 247}}>
      <Eyebrow>MAKE ROOM FOR YOUR AI</Eyebrow>
      <Headline size={118}>给 AI 一个<br />自己的工作台。</Headline>
      <Supporting style={{marginTop: 37}}>从一个简单、可控的起点开始。</Supporting>
    </Reveal>
    <div style={{position: 'absolute', left: 1170, top: 175, width: 580, height: 660, borderRadius: '48% 48% 40% 40%', background: p.mint, opacity: 0.5, scale: interpolate(frame, [0, 3 * fps], [0.92, 1], clamp)}} />
    <Reveal delay={0.25} style={{position: 'absolute', top: 262, right: 132, width: 650, rotate: `${interpolate(frame, [0, 1.2 * fps], [2, 0], clamp)}deg`}}>
      <Panel title="你的工作台">
        <div style={{padding: '42px 38px 32px'}}>
          <div style={{display: 'flex', alignItems: 'center', gap: 17}}>
            <div style={{background: p.pale, padding: 15, borderRadius: 22}}><HarbourMark size={47} /></div>
            <div><div style={{fontSize: 31, fontWeight: 500}}>Main</div><div style={{fontSize: 20, color: p.muted, marginTop: 4}}>你的中性 AI 助手</div></div>
          </div>
          <Reveal delay={0.65}><div style={{fontSize: 35, marginTop: 36, lineHeight: 1.6}}>今天，从哪里开始？</div></Reveal>
          <Reveal delay={1.05}><div style={{display: 'flex', gap: 11, marginTop: 27}}><Tag>模型</Tag><Tag pale>Agent</Tag><Tag pale>角色图片</Tag></div></Reveal>
          <div style={{height: 66, border: `1px solid ${p.line}`, borderRadius: 14, marginTop: 37, padding: '0 20px', display: 'flex', alignItems: 'center', color: p.muted, fontSize: 22}}>
            写下你的第一个问题<span style={{marginLeft: 'auto'}}><Arrow size={29} /></span>
          </div>
        </div>
      </Panel>
    </Reveal>
  </Shell>;
};

const Field = ({label, children}: {label: string; children: ReactNode}) => (
  <div style={{marginBottom: 24}}>
    <div style={{fontSize: 21, color: p.muted, marginBottom: 10}}>{label}</div>
    <div style={{height: 65, display: 'flex', alignItems: 'center', padding: '0 19px', border: `1px solid ${p.line}`, borderRadius: 13, background: p.paper, fontSize: 23}}>{children}</div>
  </div>
);

export const ModelScene = () => (
  <Shell number="02">
    <Reveal style={{position: 'absolute', left: 132, top: 253}}>
      <Eyebrow>01 — CONNECT</Eyebrow>
      <Headline>接入你<br />选择的模型。</Headline>
      <Supporting style={{marginTop: 37}}>OpenAI-compatible API<br />密钥只在后端配置。</Supporting>
      <Reveal delay={1.5}><div style={{marginTop: 42}}><Tag><Check />也可先用离线演示</Tag></div></Reveal>
    </Reveal>
    <Reveal delay={0.2} style={{position: 'absolute', top: 210, right: 132, width: 770}}>
      <Panel title="模型连接">
        <div style={{padding: '32px 36px'}}>
          <Field label="连接类型">OpenAI-compatible API</Field>
          <Field label="服务地址">https://example.invalid/v1</Field>
          <Field label="模型 ID">your-model</Field>
          <Reveal delay={1}><div style={{display: 'flex', alignItems: 'center', gap: 13, fontSize: 25, padding: '19px 22px', borderRadius: 14, background: p.mint}}><Check />API Key · 后端环境变量</div></Reveal>
        </div>
      </Panel>
      <div style={{marginTop: 19, paddingLeft: 9, fontSize: 20, color: p.muted}}>地址与模型名均为占位示例</div>
    </Reveal>
  </Shell>
);

export const AgentScene = () => (
  <Shell number="03">
    <Reveal style={{position: 'absolute', left: 132, top: 253}}>
      <Eyebrow>02 — DEFINE</Eyebrow>
      <Headline>一个文件夹。<br />一个 Agent。</Headline>
      <Supporting style={{marginTop: 37}}>用 Markdown 写下人设与规则，<br />让技能按需进入上下文。</Supporting>
    </Reveal>
    <Reveal delay={0.2} style={{position: 'absolute', top: 210, right: 132, width: 770}}>
      <Panel title="Agent 配置">
        <div style={{padding: 35}}>
          <div style={{display: 'flex', alignItems: 'center', gap: 18, fontSize: 28, marginBottom: 25}}><FolderIcon />agents/assistant/</div>
          <div style={{border: `1px solid ${p.line}`, background: p.paper, borderRadius: 17, overflow: 'hidden'}}>
            <div style={{height: 55, display: 'flex', alignItems: 'center', padding: '0 22px', fontSize: 21, borderBottom: `1px solid ${p.line}`, color: p.muted}}>CLAUDE.md</div>
            <div style={{padding: '22px 25px 29px', fontSize: 27, lineHeight: 1.9}}>
              <Reveal delay={0.55}><div><span style={{color: p.muted}}># </span>中性、清晰、可靠的助手</div></Reveal>
              <Reveal delay={0.9}><div><span style={{color: p.muted}}>· </span>先理解目标，再给出行动</div></Reveal>
              <Reveal delay={1.25}><div><span style={{color: p.muted}}>· </span>需要时，读取已挂载技能</div></Reveal>
            </div>
          </div>
          <Reveal delay={1.7}><div style={{display: 'flex', alignItems: 'center', gap: 16, marginTop: 25}}><Tag>skills/</Tag><div style={{fontSize: 23, color: p.muted}}>按需加载 · 保持轻量</div></div></Reveal>
        </div>
      </Panel>
    </Reveal>
  </Shell>
);

// A neutral geometric plant illustration: no existing character or third-party asset.
const OriginalArtwork = () => (
  <svg viewBox="0 0 500 410" style={{width: '100%', height: '100%'}}>
    <circle cx="255" cy="202" r="139" fill={p.mint} />
    <ellipse cx="259" cy="352" rx="106" ry="13" fill={p.ink} opacity="0.08" />
    <path d="M244 302c-12-64-10-129 25-198" fill="none" stroke={p.ink} strokeWidth="8" strokeLinecap="round" />
    <path d="M249 208c-59 3-100-25-105-77 63-8 100 27 105 77Z" fill={p.ink} />
    <path d="M249 172c60-1 94-32 95-80-58-2-91 29-95 80Z" fill="#7aa88d" />
    <path d="M240 253c52 6 89-15 103-58-54-11-92 11-103 58Z" fill="#7aa88d" />
    <path d="M193 286h110l-14 56a13 13 0 0 1-13 10h-55a13 13 0 0 1-13-10Z" fill={p.white} stroke={p.ink} strokeWidth="3" />
    <path d="M194 295h107" stroke={p.ink} strokeWidth="3" />
    <circle cx="372" cy="263" r="8" fill={p.amber} />
    <circle cx="134" cy="271" r="4" fill={p.ink} opacity="0.5" />
  </svg>
);

export const CharacterScene = () => (
  <Shell number="04">
    <Reveal style={{position: 'absolute', left: 132, top: 253}}>
      <Eyebrow>03 — MAKE IT YOURS</Eyebrow>
      <Headline>让开屏，<br />有你的样子。</Headline>
      <Supporting style={{marginTop: 37}}>换上自己的角色图片，<br />从熟悉的画面开始对话。</Supporting>
      <Reveal delay={1.3}><div style={{marginTop: 37, fontSize: 25, color: p.muted}}>默认不含任何第三方角色</div></Reveal>
    </Reveal>
    <Reveal delay={0.2} style={{position: 'absolute', top: 198, right: 132, width: 770}}>
      <Panel title="自定义开屏图片">
        <div style={{height: 360, padding: '5px 60px 0', background: '#f0f3e9'}}><OriginalArtwork /></div>
        <div style={{padding: '26px 33px 30px'}}>
          <div style={{display: 'flex', alignItems: 'center', fontSize: 29, gap: 14}}><div style={{width: 9, height: 9, background: p.ink, borderRadius: 9}} />你的图片，你的工作台。</div>
          <div style={{display: 'flex', alignItems: 'center', gap: 17, marginTop: 22}}><Tag>选择图片</Tag><span style={{fontSize: 22, color: p.muted}}>支持自定义开屏角色</span></div>
        </div>
      </Panel>
      <div style={{marginTop: 18, paddingLeft: 8, fontSize: 20, color: p.muted}}>原创几何插图，仅作图片位置示意</div>
    </Reveal>
  </Shell>
);

export const DataScene = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  return <Shell number="05">
    <Reveal style={{position: 'absolute', left: 132, top: 206}}>
      <Eyebrow>04 — KEEP IT LOCAL</Eyebrow>
      <Headline size={108}>数据，留在自己这里。</Headline>
      <Supporting style={{marginTop: 26}}>本地会话 · 自己的配置 · 后端密钥</Supporting>
    </Reveal>
    <Reveal delay={0.4} style={{position: 'absolute', left: 132, top: 514, width: 773, height: 276, border: `1.5px solid ${p.line}`, borderRadius: 24, background: p.white, padding: 34}}>
      <div style={{display: 'flex', alignItems: 'center', gap: 16, fontSize: 30, fontWeight: 500}}><HarbourMark size={38} />你的本地工作台</div>
      <div style={{display: 'flex', gap: 15, marginTop: 32}}><Tag>会话</Tag><Tag>Agent 文件</Tag><Tag>技能</Tag></div>
      <div style={{marginTop: 25, fontSize: 22, color: p.muted}}>由你保存与管理</div>
    </Reveal>
    <Reveal delay={1.2} style={{position: 'absolute', left: 942, top: 568, width: 272, height: 180, display: 'flex', flexDirection: 'column', alignItems: 'center'}}>
      <div style={{fontSize: 24, marginBottom: 18, color: p.muted}}>模型请求</div>
      <svg width="260" height="44" viewBox="0 0 260 44" fill="none"><path d="M10 22h234m-13-13 14 13-14 13" stroke={p.ink} strokeWidth="2" strokeLinecap="round" /><circle cx={interpolate(frame, [1.5 * fps, 3.1 * fps], [10, 237], clamp)} cy="22" r="7" fill={p.ink} /></svg>
    </Reveal>
    <Reveal delay={0.8} style={{position: 'absolute', right: 132, top: 514, width: 536, height: 276, border: `1.5px solid ${p.line}`, borderRadius: 24, background: p.pale, padding: 34, display: 'flex', flexDirection: 'column', justifyContent: 'center'}}>
      <div style={{fontSize: 36, fontWeight: 500}}>你选择的模型服务商</div>
      <div style={{fontSize: 25, color: p.muted, marginTop: 22}}>按你的连接配置处理请求</div>
    </Reveal>
    <Reveal delay={1.6} style={{position: 'absolute', top: 827, left: 132, fontSize: 29, color: p.muted}}>模型请求仍会发送给所选服务商；本地保存不代表离线推理。</Reveal>
  </Shell>;
};

export const ClosingScene = () => {
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  return <Shell number="06" dark>
    <div style={{position: 'absolute', width: 880, height: 880, left: 520, top: 90, border: '1px solid rgba(199,232,212,0.12)', borderRadius: '50%', scale: interpolate(frame, [0, 4.5 * fps], [0.93, 1], clamp)}} />
    <div style={{position: 'absolute', width: 630, height: 630, left: 645, top: 215, border: '1px solid rgba(199,232,212,0.09)', borderRadius: '50%'}} />
    <Reveal delay={0.1} style={{position: 'absolute', top: 229, width: '100%', display: 'flex', justifyContent: 'center'}}><HarbourMark size={100} light /></Reveal>
    <Reveal delay={0.2} style={{position: 'absolute', top: 365, width: '100%', textAlign: 'center'}}>
      <Interactive.Div name="Project name" style={{fontSize: 145, letterSpacing: -5, fontWeight: 500}}>Harbour <span style={{color: p.mint}}>Lite</span></Interactive.Div>
      <div style={{fontSize: 45, marginTop: 19, letterSpacing: 6, color: p.mint}}>轻量 Agent 启动器</div>
    </Reveal>
    <Reveal delay={0.9} style={{position: 'absolute', top: 686, width: '100%', textAlign: 'center', fontSize: 31, letterSpacing: 3, opacity: 0.7}}>你的模型 · 你的 Agent · 你的工作台</Reveal>
    <Reveal delay={1.6} style={{position: 'absolute', top: 780, width: '100%', display: 'flex', justifyContent: 'center'}}><div style={{display: 'flex', alignItems: 'center', gap: 14, fontSize: 25, padding: '14px 25px', borderRadius: 40, border: '1px solid rgba(199,232,212,0.4)', color: p.mint}}>从离线演示开始 <Arrow size={27} color={p.mint} /></div></Reveal>
  </Shell>;
};

export const HarbourLiteIntro = () => {
  const frame = useCurrentFrame();
  const {fps, durationInFrames} = useVideoConfig();
  return <AbsoluteFill style={{background: p.paper}}>
    <TransitionSeries>
      <TransitionSeries.Sequence name="给 AI 一个工作台" durationInFrames={4.5 * fps}><WelcomeScene /></TransitionSeries.Sequence>
      <TransitionSeries.Transition presentation={{component: PaperTransition, props: {}}} timing={linearTiming({durationInFrames: 0.5 * fps})} />
      <TransitionSeries.Sequence name="接入模型" durationInFrames={5.5 * fps}><ModelScene /></TransitionSeries.Sequence>
      <TransitionSeries.Transition presentation={{component: PaperTransition, props: {}}} timing={linearTiming({durationInFrames: 0.5 * fps})} />
      <TransitionSeries.Sequence name="配置 Agent" durationInFrames={5.5 * fps}><AgentScene /></TransitionSeries.Sequence>
      <TransitionSeries.Transition presentation={{component: PaperTransition, props: {}}} timing={linearTiming({durationInFrames: 0.5 * fps})} />
      <TransitionSeries.Sequence name="自定义角色图片" durationInFrames={5.5 * fps}><CharacterScene /></TransitionSeries.Sequence>
      <TransitionSeries.Transition presentation={{component: PaperTransition, props: {}}} timing={linearTiming({durationInFrames: 0.5 * fps})} />
      <TransitionSeries.Sequence name="本地数据与模型请求" durationInFrames={6.5 * fps}><DataScene /></TransitionSeries.Sequence>
      <TransitionSeries.Transition presentation={{component: PaperTransition, props: {}}} timing={linearTiming({durationInFrames: 0.5 * fps})} />
      <TransitionSeries.Sequence name="Harbour Lite" durationInFrames={5 * fps}><ClosingScene /></TransitionSeries.Sequence>
    </TransitionSeries>
    <div style={{position: 'absolute', height: 3, bottom: 0, left: 0, background: p.mint, width: `${interpolate(frame, [0, durationInFrames - 1], [0, 100], {extrapolateRight: 'clamp'})}%`}} />
  </AbsoluteFill>;
};
