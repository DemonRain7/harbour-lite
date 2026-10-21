import type {CSSProperties, ReactNode} from 'react';
import {AbsoluteFill, CanvasImage, Easing, Interactive, interpolate, staticFile, useCurrentFrame, useVideoConfig} from 'remotion';
import {TransitionSeries, linearTiming, type TransitionPresentationComponentProps} from '@remotion/transitions';
import '@fontsource/noto-sans-sc/400.css';
import '@fontsource/noto-sans-sc/500.css';
import '@fontsource/noto-sans-sc/700.css';
import {fontFamily, palette as p} from './theme';
import './global.css';

const clamp = {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'} as const;
const ease = {...clamp, easing: Easing.bezier(0.16, 1, 0.3, 1)} as const;
const photoShadow = '0 28px 70px -28px rgba(83,61,100,0.28)';
const imageSrc = () => staticFile('original-main-chat.png');

// No audio, remote assets, live UI requests or private content.
const PaperTransition = ({children, presentationDirection, presentationProgress}: TransitionPresentationComponentProps<Record<string, never>>) => (
  <AbsoluteFill style={{opacity: presentationDirection === 'exiting'
    ? interpolate(presentationProgress, [0, 0.46], [1, 0], clamp)
    : interpolate(presentationProgress, [0.54, 1], [0, 1], clamp)}}>{children}</AbsoluteFill>
);

const Reveal = ({children, delay = 0, style}: {children: ReactNode; delay?: number; style?: CSSProperties}) => {
  const frame = useCurrentFrame(); const {fps} = useVideoConfig();
  return <div style={{...style,
    opacity: interpolate(frame, [delay * fps, (delay + 0.55) * fps], [0, 1], ease),
    translate: `0 ${interpolate(frame, [delay * fps, (delay + 0.8) * fps], [22, 0], ease)}px`,
  }}>{children}</div>;
};

const Star = ({size = 32, color = p.accent, outline = false}: {size?: number; color?: string; outline?: boolean}) => (
  <svg width={size} height={size} viewBox="0 0 64 64" fill={outline ? 'none' : color}>
    <path d="M32 4c3 19 9 25 28 28-19 3-25 9-28 28C29 41 23 35 4 32 23 29 29 23 32 4Z" stroke={color} strokeWidth={outline ? 1.7 : 0} strokeLinejoin="round" />
  </svg>
);

const Brand = ({size = 100}: {size?: number}) => <div style={{position: 'relative', width: size * 3.6, height: size * 1.25, display: 'flex', alignItems: 'center', justifyContent: 'center', paddingBottom: size * 0.13}}>
  <span style={{fontFamily: '"Harbour Hand", cursive', fontSize: size, fontWeight: 600, lineHeight: 1.1, letterSpacing: '-0.035em', color: p.ink}}>Harbour</span>
  <svg viewBox="0 0 360 125" style={{position: 'absolute', inset: 0, width: '100%', height: '100%', overflow: 'visible'}}>
    <path d="M23 104c70-14 168 18 307-6m-73 19c29-1 47-3 63-8" fill="none" stroke={p.accent} strokeWidth="2.3" strokeLinecap="round" opacity="0.55" />
  </svg>
</div>;

const Paper = ({children, chapter, lavender = false}: {children: ReactNode; chapter: string; lavender?: boolean}) => (
  <AbsoluteFill style={{background: lavender ? '#F5EFFA' : p.paper, fontFamily, color: p.ink, overflow: 'hidden'}}>
    <AbsoluteFill style={{backgroundImage: lavender
      ? 'radial-gradient(ellipse at 20% 75%, #FAF3E6 0%, transparent 70%)'
      : 'radial-gradient(ellipse at 84% 26%, rgba(237,229,253,0.6) 0%, transparent 64%)'}} />
    <div style={{position: 'absolute', left: 77, top: 0, bottom: 0, width: 1, background: 'rgba(240,143,176,0.26)'}} />
    <div style={{position: 'absolute', right: 0, top: 0, bottom: 0, width: 600, backgroundImage: 'radial-gradient(rgba(110,94,130,0.13) 1px, transparent 1.4px)', backgroundSize: '28px 28px', opacity: 0.6}} />
    <div style={{position: 'absolute', left: 130, top: 55, fontSize: 24, letterSpacing: 3, color: p.muted}}>{chapter}</div>
    {children}
  </AbsoluteFill>
);

const Tape = ({style, pink = false}: {style?: CSSProperties; pink?: boolean}) => <div style={{
  position: 'absolute', width: 170, height: 35, background: pink ? '#F4C9D7' : '#DACDF3',
  borderLeft: '2px dashed rgba(255,255,255,0.7)', borderRight: '2px dashed rgba(255,255,255,0.7)',
  opacity: 0.8, rotate: '-5deg', ...style,
}} />;

const Headline = ({children, style}: {children: ReactNode; style?: CSSProperties}) => (
  <Interactive.Div name="宣传主标题" style={{fontSize: 104, fontWeight: 700, letterSpacing: '-0.04em', lineHeight: 1.28, ...style}}>{children}</Interactive.Div>
);

const Underline = ({width = 520}: {width?: number}) => {
  const frame = useCurrentFrame(); const {fps} = useVideoConfig();
  return <svg width={width} height={24} viewBox="0 0 520 24" preserveAspectRatio="none">
    <path d="M4 12C117-1 267 24 513 7" pathLength={1} fill="none" stroke={p.accent} strokeWidth={4} strokeLinecap="round"
      strokeDasharray={1} strokeDashoffset={interpolate(frame, [0.5 * fps, 1.5 * fps], [1, 0], ease)} />
  </svg>;
};

export const WelcomeScene = () => {
  const frame = useCurrentFrame(); const {fps} = useVideoConfig();
  return <Paper chapter="HARBOUR / 公开版介绍">
    <div style={{position: 'absolute', left: 1022, top: 93, width: 710, height: 860, border: '1px solid rgba(138,112,224,0.22)', borderRadius: '49% 49% 47% 47%', rotate: '12deg'}} />
    <Reveal style={{position: 'absolute', left: 103, top: 167}}><Brand size={161} /></Reveal>
    <Reveal delay={0.15} style={{position: 'absolute', left: 132, top: 408}}>
      <Headline style={{fontSize: 99}}>熟悉的外壳，<br />你的 <span style={{color: p.accent}}>Agent。</span></Headline>
      <div style={{marginTop: 10}}><Underline width={600} /></div>
    </Reveal>
    <Reveal delay={0.45} style={{position: 'absolute', left: 138, top: 752, fontSize: 36, lineHeight: 1.65, color: p.muted}}>
      保留原版的精致日常。<br />把助手，换成你自己的。
    </Reveal>
    <Reveal delay={0.18} style={{position: 'absolute', left: 885, top: 205, width: 940, height: 710}}>
      <div style={{position: 'absolute', inset: 0, padding: 10, background: p.panel, border: '1px solid rgba(135,112,155,0.26)', borderRadius: 25, boxShadow: photoShadow, rotate: '-1.1deg',
        scale: interpolate(frame, [0, 4.5 * fps], [0.98, 1.015], clamp)}}>
        <div style={{width: '100%', height: '100%', position: 'relative', overflow: 'hidden', borderRadius: 16}}>
          <CanvasImage src={imageSrc()} style={{position: 'absolute', width: 1232, height: 1232 * 1371 / 2360, maxWidth: 'none', left: -302, top: -8}} />
        </div>
      </div>
      <Tape style={{top: -14, left: 54, rotate: '-7deg'}} />
      <div style={{position: 'absolute', left: 45, top: 744, fontSize: 25, letterSpacing: 1, color: p.muted}}>原版 UI 局部 / 公开截图</div>
    </Reveal>
    <div style={{position: 'absolute', left: 790, top: 220, rotate: '10deg'}}><Star size={57} outline /></div>
    <div style={{position: 'absolute', left: 1700, top: 110}}><Star size={30} color={p.pink} /></div>
    <div style={{position: 'absolute', left: 132, bottom: 43, fontSize: 23, color: p.muted}}>把熟悉的外壳，交给你自己的 Agent</div>
  </Paper>;
};

export const OriginalUIScene = () => {
  const frame = useCurrentFrame(); const {fps} = useVideoConfig();
  return <Paper chapter="01 / 熟悉的外观，不必告别">
    <div style={{position: 'absolute', right: 132, top: 58, fontSize: 24, color: p.muted}}>公开副本真实截图 · 非实时录屏</div>
    <Reveal style={{position: 'absolute', left: 130, top: 119}}>
      <Headline style={{fontSize: 96}}>原来的界面，完整保留。</Headline>
    </Reveal>
    <Reveal delay={0.25} style={{position: 'absolute', left: 315, top: 294}}>
      <div style={{position: 'relative', width: 1290, height: 1290 * 1371 / 2360, overflow: 'hidden', border: '1px solid rgba(123,100,145,0.3)', borderRadius: 20, boxShadow: photoShadow,
        scale: interpolate(frame, [0, 5.5 * fps], [0.97, 1.01], clamp), transformOrigin: '50% 30%'}}>
        <CanvasImage src={imageSrc()} style={{width: '100%', height: '100%'}} />
      </div>
    </Reveal>
    <Reveal delay={0.4} style={{position: 'absolute', left: 132, top: 244, fontSize: 31, color: p.muted}}>
      Electron / Web · 主题 · 聊天布局 · 开屏动画
    </Reveal>
    <div style={{position: 'absolute', left: 151, top: 550, rotate: '-14deg'}}><Star size={47} outline /></div>
    <div style={{position: 'absolute', right: 137, top: 825}}><Star size={35} color={p.pink} /></div>
  </Paper>;
};

const AgentGraph = () => {
  const frame = useCurrentFrame(); const {fps} = useVideoConfig();
  return <div style={{position: 'relative', width: 900, height: 690}}>
    <svg width={900} height={690} viewBox="0 0 900 690" style={{position: 'absolute', inset: 0}}>
      <ellipse cx="455" cy="360" rx="375" ry="273" stroke="rgba(138,112,224,0.18)" strokeWidth={1.5} strokeDasharray="4 11" fill="none" />
      <path d="M455 157C449 205 461 232 455 267M306 440C285 503 234 511 203 543M594 440C630 497 656 511 705 544"
        pathLength={1} stroke={p.accent} strokeWidth={2.7} fill="none" strokeLinecap="round"
        strokeDasharray={1} strokeDashoffset={interpolate(frame, [0.5 * fps, 1.7 * fps], [1, 0], ease)} />
      <circle cx="455" cy="267" r="5" fill={p.accent} />
      <circle cx="306" cy="440" r="5" fill={p.accent} />
      <circle cx="594" cy="440" r="5" fill={p.accent} />
    </svg>
    <Reveal delay={0.3} style={{position: 'absolute', left: 242, top: 63, width: 425, textAlign: 'center'}}>
      <div style={{fontSize: 46, fontWeight: 500}}>自己的模型</div>
      <div style={{fontSize: 25, color: p.muted, marginTop: 12}}>由你选择与接入</div>
    </Reveal>
    <Reveal delay={0.1} style={{position: 'absolute', left: 195, top: 268, width: 520, height: 177}}>
      <div style={{position: 'absolute', inset: 0, borderRadius: '49% 47% 48% 46%', background: p.mist, border: '1.7px solid rgba(138,112,224,0.42)', rotate: '-2deg'}} />
      <div style={{position: 'relative', textAlign: 'center', fontSize: 66, fontWeight: 500, paddingTop: 20}}>你的 Agent</div>
      <div style={{position: 'relative', textAlign: 'center', fontSize: 29, marginTop: 7, color: p.muted}}>你的规则与工作方式</div>
    </Reveal>
    <Reveal delay={0.7} style={{position: 'absolute', left: 87, top: 549, width: 260, textAlign: 'center'}}>
      <div style={{fontSize: 47, fontWeight: 500}}>工具</div><div style={{fontSize: 27, color: p.muted, marginTop: 11}}>按授权接入</div>
    </Reveal>
    <Reveal delay={0.9} style={{position: 'absolute', left: 530, top: 549, width: 350, textAlign: 'center'}}>
      <div style={{fontSize: 47, fontWeight: 500}}>Skill · MCP</div><div style={{fontSize: 27, color: p.muted, marginTop: 11}}>按需挂载</div>
    </Reveal>
  </div>;
};

export const AgentScene = () => <Paper chapter="02 / 自己的 Agent，自己的能力">
  <div style={{position: 'absolute', right: 132, top: 58, fontSize: 24, color: p.muted}}>能力关系示意 · 非连接状态</div>
  <Reveal style={{position: 'absolute', left: 132, top: 265}}>
    <Headline style={{fontSize: 112}}>内核，<br />由你定义。</Headline>
    <div style={{marginTop: 20}}><Underline width={500} /></div>
  </Reveal>
  <Reveal delay={0.4} style={{position: 'absolute', left: 139, top: 645, fontSize: 39, lineHeight: 1.65, color: p.muted}}>
    写下自己的规则，<br />接入需要的能力。
  </Reveal>
  <div style={{position: 'absolute', left: 859, top: 138}}><AgentGraph /></div>
  <Reveal delay={0.8} style={{position: 'absolute', left: 132, right: 132, top: 924, borderTop: '1px solid rgba(138,112,224,0.27)', paddingTop: 25, fontSize: 33, color: p.muted}}>
    模型由你接入，调用发往你所选的服务商。
  </Reveal>
</Paper>;

export const CharacterScene = () => {
  const frame = useCurrentFrame(); const {fps} = useVideoConfig();
  return <Paper chapter="03 / 让开场，也像你">
    <div style={{position: 'absolute', left: 1135, top: 160, width: 635, height: 764, border: '1px solid rgba(138,112,224,0.2)', borderRadius: '48% 48% 43% 43%', rotate: '-8deg'}} />
    <Reveal style={{position: 'absolute', left: 132, top: 238}}>
      <Headline style={{fontSize: 103}}>开屏角色，<br />也由你来定。</Headline>
      <div style={{marginTop: 16}}><Underline width={610} /></div>
    </Reveal>
    <Reveal delay={0.35} style={{position: 'absolute', left: 139, top: 586, fontSize: 39, color: p.muted, lineHeight: 1.7}}>
      换一张自己的图片。<br />展示图片与 Agent 身份，分开配置。
    </Reveal>
    <Reveal delay={0.65} style={{position: 'absolute', left: 139, top: 847, fontSize: 34, color: p.ink}}>
      <span style={{display: 'inline-block', width: 38, marginRight: 14, verticalAlign: 'middle'}}><Star size={28} color={p.pink} /></span>
      不附私人记忆、偏好与任务。
    </Reveal>
    <Reveal delay={0.2} style={{position: 'absolute', left: 1190, top: 149, width: 510, height: 812}}>
      <div style={{position: 'absolute', inset: 0, overflow: 'hidden', borderRadius: 12,
        scale: interpolate(frame, [0, 5.5 * fps], [0.99, 1.025], clamp)}}>
        {/* Crop from the authorised screenshot, not an invented startup recording. */}
        <CanvasImage src={imageSrc()} style={{position: 'absolute', width: 2360 * 510 / 540, height: 1371 * 510 / 540, maxWidth: 'none', left: -1820 * 510 / 540, top: -300 * 510 / 540}} />
      </div>
      <Tape pink style={{left: 47, top: 32, rotate: '-11deg', width: 135}} />
    </Reveal>
    <div style={{position: 'absolute', left: 1133, top: 986, fontSize: 24, color: p.muted}}>原版聊天装饰局部 · 非开屏录屏</div>
    <div style={{position: 'absolute', left: 1734, top: 323}}><Star size={52} outline /></div>
  </Paper>;
};

export const HandoffScene = () => {
  const frame = useCurrentFrame(); const {fps} = useVideoConfig();
  return <Paper chapter="04 / 把安装，交接给你的 Agent">
    <Reveal style={{position: 'absolute', left: 130, top: 139}}>
      <Headline style={{fontSize: 93}}>让你的 Agent 帮你安装。</Headline>
    </Reveal>
    <Reveal delay={0.25} style={{position: 'absolute', left: 136, top: 300, fontSize: 43, fontWeight: 500, whiteSpace: 'nowrap'}}>
      复制 README 的交接 Prompt <span style={{color: p.accent, margin: '0 18px'}}>→</span> 发给你的 Agent
    </Reveal>
    <Reveal delay={0.5} style={{position: 'absolute', left: 178, top: 444, width: 1564, height: 349}}>
      <div style={{position: 'absolute', inset: 0, borderRadius: '16px 23px 15px 21px', background: p.panel, border: '1.5px solid rgba(138,112,224,0.27)', boxShadow: photoShadow,
        rotate: `${interpolate(frame, [0.5 * fps, 2 * fps], [-1.4, -0.35], ease)}deg`,
        translate: `${interpolate(frame, [0.5 * fps, 1.5 * fps], [45, 0], ease)}px 0`}}>
        <div style={{position: 'absolute', left: 37, top: 60, fontFamily: 'Georgia, serif', fontSize: 122, color: '#DBCEF0', lineHeight: 1}}>“</div>
        <div style={{position: 'absolute', left: 105, top: 47, fontSize: 25, color: p.muted, letterSpacing: 1}}>对话缩写示意 / 安装请用 README 完整 Prompt</div>
        <div style={{position: 'absolute', left: 105, top: 114, fontSize: 56, fontWeight: 500, lineHeight: 1.6}}>
          帮我部署 Harbour，保留原界面，<br />接入我的 Agent。
        </div>
        <svg width={75} height={75} viewBox="0 0 75 75" style={{position: 'absolute', right: 54, bottom: 47}}>
          <circle cx="37.5" cy="37.5" r="34" fill={p.mist} />
          <path d="M24 49 50 23M28 23h22v22" stroke={p.accent} strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round" fill="none" />
        </svg>
      </div>
      <Tape style={{left: 73, top: -15}} /><Tape pink style={{right: 84, bottom: -16, rotate: '5deg', width: 122}} />
    </Reveal>
    <Reveal delay={0.9} style={{position: 'absolute', left: 138, top: 872, fontSize: 31, color: p.muted, lineHeight: 1.8}}>
      Agent 需具备本地文件与终端能力。<br />
      先验证 Mock 演示，再确认真实模型接入。
    </Reveal>
  </Paper>;
};

export const ClosingScene = () => {
  const frame = useCurrentFrame(); const {fps} = useVideoConfig();
  return <Paper chapter="HARBOUR / 由你定义的工作台" lavender>
    <div style={{position: 'absolute', left: 450, top: 125, width: 1020, height: 690, border: '1px solid rgba(138,112,224,0.21)', borderRadius: '50%', rotate: '-9deg',
      scale: interpolate(frame, [0, 5 * fps], [0.97, 1.02], clamp)}} />
    <Reveal style={{position: 'absolute', left: 546, top: 170}}><Brand size={230} /></Reveal>
    <Reveal delay={0.3} style={{position: 'absolute', left: 130, top: 519, width: 1660, textAlign: 'center'}}>
      <Headline style={{fontSize: 81, fontWeight: 500, lineHeight: 1.44}}>
        把熟悉的外壳，<br />交给你自己的 <span style={{color: p.accent}}>Agent。</span>
      </Headline>
    </Reveal>
    <Reveal delay={0.7} style={{position: 'absolute', top: 810, left: 420, width: 1080, textAlign: 'center', fontSize: 40, color: p.accent}}>
      从 README 的交接 Prompt 开始 <span style={{marginLeft: 12}}>→</span>
    </Reveal>
    <div style={{position: 'absolute', left: 130, right: 130, top: 977, fontSize: 28, textAlign: 'center', color: p.muted}}>
      公开版仍待审核 · 非已发布版本
    </div>
    <div style={{position: 'absolute', left: 399, top: 400, rotate: '-10deg'}}><Star size={57} color={p.pink} /></div>
    <div style={{position: 'absolute', right: 364, top: 261, rotate: '8deg'}}><Star size={75} outline /></div>
    <div style={{position: 'absolute', right: 482, top: 725}}><Star size={26} color={p.gold} /></div>
  </Paper>;
};

export const HarbourIntro = () => {
  const {fps} = useVideoConfig();
  return <AbsoluteFill style={{background: p.paper}}>
    <TransitionSeries>
      <TransitionSeries.Sequence name="熟悉的外壳，你的 Agent" durationInFrames={4.5 * fps}><WelcomeScene /></TransitionSeries.Sequence>
      <TransitionSeries.Transition presentation={{component: PaperTransition, props: {}}} timing={linearTiming({durationInFrames: 0.5 * fps})} />
      <TransitionSeries.Sequence name="原版公开 UI 实景" durationInFrames={5.5 * fps}><OriginalUIScene /></TransitionSeries.Sequence>
      <TransitionSeries.Transition presentation={{component: PaperTransition, props: {}}} timing={linearTiming({durationInFrames: 0.5 * fps})} />
      <TransitionSeries.Sequence name="自接模型与 Agent 能力" durationInFrames={5.5 * fps}><AgentScene /></TransitionSeries.Sequence>
      <TransitionSeries.Transition presentation={{component: PaperTransition, props: {}}} timing={linearTiming({durationInFrames: 0.5 * fps})} />
      <TransitionSeries.Sequence name="自己的开屏与干净起点" durationInFrames={5.5 * fps}><CharacterScene /></TransitionSeries.Sequence>
      <TransitionSeries.Transition presentation={{component: PaperTransition, props: {}}} timing={linearTiming({durationInFrames: 0.5 * fps})} />
      <TransitionSeries.Sequence name="README 一句交接给 Agent" durationInFrames={6.5 * fps}><HandoffScene /></TransitionSeries.Sequence>
      <TransitionSeries.Transition presentation={{component: PaperTransition, props: {}}} timing={linearTiming({durationInFrames: 0.5 * fps})} />
      <TransitionSeries.Sequence name="把熟悉的外壳，交给你自己的 Agent" durationInFrames={5 * fps}><ClosingScene /></TransitionSeries.Sequence>
    </TransitionSeries>
  </AbsoluteFill>;
};
