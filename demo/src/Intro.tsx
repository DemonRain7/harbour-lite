import type {CSSProperties, ReactNode} from 'react';
import {AbsoluteFill, Easing, Interactive, interpolate, useCurrentFrame, useVideoConfig} from 'remotion';
import {TransitionSeries, linearTiming, type TransitionPresentationComponentProps} from '@remotion/transitions';
import '@fontsource/noto-sans-sc/400.css';
import '@fontsource/noto-sans-sc/500.css';
import '@fontsource/noto-sans-sc/700.css';
import {cardRadius, fontFamily, palette as p} from './theme';
import './global.css';

const clamp = {extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.bezier(0.16, 1, 0.3, 1)} as const;
const shadow = '0 16px 44px -18px rgba(120,95,60,0.26)';

const PaperTransition = ({children, presentationDirection, presentationProgress}: TransitionPresentationComponentProps<Record<string, never>>) => (
  <AbsoluteFill style={{opacity: presentationDirection === 'exiting'
    ? interpolate(presentationProgress, [0, 0.48], [1, 0], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'})
    : interpolate(presentationProgress, [0.52, 1], [0, 1], {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'})}}>{children}</AbsoluteFill>
);

const Reveal = ({children, delay = 0, style}: {children: ReactNode; delay?: number; style?: CSSProperties}) => {
  const frame = useCurrentFrame(); const {fps} = useVideoConfig();
  return <div style={{...style,
    opacity: interpolate(frame, [delay * fps, (delay + 0.7) * fps], [0, 1], clamp),
    translate: `0 ${interpolate(frame, [delay * fps, (delay + 0.9) * fps], [24, 0], clamp)}px`,
  }}>{children}</div>;
};

const Star = ({size = 32, color = p.accent, outline = false}: {size?: number; color?: string; outline?: boolean}) => (
  <svg width={size} height={size} viewBox="0 0 64 64" fill={outline ? 'none' : color}>
    <path d="M32 4c3 19 9 25 28 28-19 3-25 9-28 28C29 41 23 35 4 32 23 29 29 23 32 4Z" stroke={color} strokeWidth={outline ? 2 : 0} strokeLinejoin="round" />
  </svg>
);

const Sparkles = () => {
  const frame = useCurrentFrame(); const {fps} = useVideoConfig();
  const points = [[94,260,32],[1805,212,43],[1690,88,22],[1779,904,26],[97,871,18],[1514,246,20],[400,104,16],[1620,972,15]];
  return <>{points.map(([x,y,size], i) => <div key={i} style={{position: 'absolute', left: x, top: y, opacity: 0.35 + Math.sin(frame / fps + i) * 0.09, translate: `0 ${Math.sin(frame / (fps * 1.8) + i) * 4}px`, rotate: `${i * 13}deg`}}><Star size={size} color={i % 3 === 0 ? p.pink : p.accent} outline={i % 2 === 0} /></div>)}</>;
};

const Brand = ({size = 56}: {size?: number}) => (
  <div style={{position: 'relative', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: size * 3.6, height: size * 1.2, paddingBottom: size * 0.13}}>
    <span style={{fontFamily: '"Harbour Hand", cursive', fontSize: size, lineHeight: 1.1, fontWeight: 600, letterSpacing: '-0.035em', color: p.ink}}>Harbour</span>
    <svg viewBox="0 0 132 44" style={{position: 'absolute', inset: 0, width: '100%', height: '100%', color: p.accent, overflow: 'visible'}}><path d="M9 36c29-5 60 8 108-2m-28 6c9 0 16-1 23-3" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" opacity="0.55" /></svg>
  </div>
);

const Shell = ({children, chapter, closing = false}: {children: ReactNode; chapter: string; closing?: boolean}) => (
  <AbsoluteFill style={{background: closing ? p.mist : p.paper, color: p.ink, fontFamily, overflow: 'hidden'}}>
    <AbsoluteFill style={{backgroundImage: 'radial-gradient(rgba(74,63,92,0.12) 1px, transparent 1.4px)', backgroundSize: '26px 26px', opacity: 0.55}} />
    <div style={{position: 'absolute', top: 0, bottom: 0, left: 76, width: 1, background: 'rgba(240,143,176,0.28)'}} />
    <Sparkles />
    <div style={{position: 'absolute', top: 35, left: 117}}><Brand size={53} /></div>
    <div style={{position: 'absolute', top: 67, right: 130, fontSize: 19, letterSpacing: 3, color: p.muted}}>PUBLIC BUILD</div>
    {children}
    <div style={{position: 'absolute', bottom: 34, left: 130, fontSize: 19, color: p.muted}}>{chapter}</div>
    <div style={{position: 'absolute', bottom: 34, right: 130, fontSize: 18, color: p.muted}}>你的 Agent，你的 Harbour</div>
  </AbsoluteFill>
);

const Heading = ({children, sub}: {children: ReactNode; sub?: string}) => <Reveal style={{position: 'absolute', left: 132, top: 139}}>
  <Interactive.Div name="Scene headline" style={{fontSize: 86, fontWeight: 700, lineHeight: 1.25, letterSpacing: -2}}>{children}</Interactive.Div>
  {sub && <div style={{marginTop: 17, fontSize: 33, color: p.muted, lineHeight: 1.5}}>{sub}</div>}
</Reveal>;

const Tape = ({pink = false}: {pink?: boolean}) => <div style={{position: 'absolute', top: -13, left: 34, width: 115, height: 28, background: pink ? '#F8D1DF' : '#DCD0F6', opacity: 0.85, rotate: '-4deg', borderLeft: '1px dashed white', borderRight: '1px dashed white'}} />;

const Icon = ({type, size = 20}: {type: 'menu' | 'back' | 'forward' | 'plus' | 'agent' | 'skill' | 'send' | 'mic' | 'model' | 'lock'; size?: number}) => {
  const paths = {
    menu: 'M4 6h16M4 12h16M4 18h16', back: 'm14 5-7 7 7 7', forward: 'm10 5 7 7-7 7', plus: 'M12 4v16M4 12h16',
    agent: 'M16 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0ZM4 21v-2a7 7 0 0 1 14 0v2', skill: 'M12 2c1 7 3 9 10 10-7 1-9 3-10 10-1-7-3-9-10-10 7-1 9-3 10-10Z',
    send: 'M12 20V4m-6 6 6-6 6 6', mic: 'M9 5a3 3 0 0 1 6 0v7a3 3 0 0 1-6 0V5ZM5 11v1a7 7 0 0 0 14 0v-1M12 19v3',
    model: 'm12 2 9 5v10l-9 5-9-5V7l9-5Zm0 0v20M3 7l9 5 9-5', lock: 'M7 10V7a5 5 0 0 1 10 0v3M5 10h14v11H5V10Zm7 4v3',
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d={paths[type]} /></svg>;
};

const Sailboat = ({size = 60}: {size?: number}) => <svg width={size} height={size} viewBox="0 0 64 64" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"><path d="m12 37 19-21 15 21H12l9 11h22l9-11H31V16m-12 8 12 13 15-12M16 54c6-3 10 3 16 0s10 3 16 0M49 10v8m-4-4h8" /></svg>;

// Proportions/materials follow the public web shell and composer, never a live session.
const Screen = ({children}: {children: ReactNode}) => <div style={{width: 1440, height: 640, border: `1.5px solid ${p.line}`, borderRadius: 19, overflow: 'hidden', background: p.paper, boxShadow: '0 24px 65px -24px rgba(84,66,116,0.3)', position: 'relative'}}>
  <div style={{height: 64, padding: '0 20px', gap: 22, display: 'flex', alignItems: 'center', borderBottom: `1px solid ${p.line}`, background: p.paper2}}>
    <span style={{color: p.muted}}><Icon type="menu" /></span>
    <div style={{display: 'flex', gap: 13, color: p.faint}}><Icon type="back" size={18} /><Icon type="forward" size={18} /></div>
    <div style={{marginLeft: -9}}><Brand size={37} /></div>
    <div style={{display: 'flex', alignItems: 'center', gap: 10, marginLeft: 'auto', color: p.muted, fontSize: 13}}>
      <div style={{padding: '9px 16px', border: `1px solid ${p.line}`, borderRadius: 10, background: p.panel}}>手账 · 薰衣草 <span style={{marginLeft: 14}}>⌄</span></div>
      <div style={{padding: '9px 16px', border: `1px solid ${p.line}`, borderRadius: 10, background: p.panel}}>星光 <span style={{marginLeft: 14}}>⌄</span></div>
      <span style={{marginLeft: 12, padding: '5px 10px', border: `1px dashed ${p.accent}`, color: p.accent, borderRadius: 20}}>界面示意</span>
    </div>
  </div>
  <div style={{position: 'absolute', inset: '64px 0 0', backgroundImage: 'radial-gradient(rgba(74,63,92,0.11) 1px, transparent 1.4px)', backgroundSize: '22px 22px'}} />
  <div style={{position: 'relative', height: 576}}>{children}</div>
</div>;

const Card = ({children, style}: {children: ReactNode; style?: CSSProperties}) => <div style={{border: `1.5px solid ${p.line}`, borderRadius: cardRadius, background: 'rgba(255,255,255,0.8)', boxShadow: shadow, ...style}}>{children}</div>;

const Composer = () => <div style={{position: 'absolute', left: 24, right: 24, bottom: 24, maxWidth: 900, height: 132, marginInline: 'auto', border: `1px solid ${p.line}`, borderRadius: 22, background: p.panel, padding: '18px 20px 13px', boxShadow: '0 4px 18px rgba(74,63,92,0.05)'}}>
  <div style={{fontSize: 15, height: 56, color: p.faint}}>写下你的想法…</div>
  <div style={{display: 'flex', alignItems: 'center', gap: 16, color: p.muted}}>
    <Icon type="plus" /><Icon type="agent" /><Icon type="skill" />
    <span style={{marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 9, fontSize: 13}}><Icon type="model" size={16} />自己的模型 <span style={{marginLeft: 8}}>⌄</span></span>
    <div style={{height: 21, width: 21, border: `2px solid ${p.faint}`, borderRadius: '50%', marginLeft: 9}} /><Icon type="mic" size={19} />
    <span style={{background: p.accent, color: 'white', borderRadius: '50%', width: 36, height: 36, display: 'grid', placeItems: 'center'}}><Icon type="send" /></span>
  </div>
</div>;

const CharacterPlaceholder = () => <div style={{position: 'relative', width: '100%', height: '100%', background: 'linear-gradient(155deg,#EDE5FD,#F9E5ED 75%,#FFFBF2)', overflow: 'hidden', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center'}}>
  <div style={{position: 'absolute', top: 30, right: 27}}><Star size={32} color={p.pink} /></div>
  <div style={{position: 'absolute', left: 22, bottom: 53}}><Star size={18} outline /></div>
  <svg width="136" height="175" viewBox="0 0 136 175" fill="none"><circle cx="68" cy="47" r="31" fill="#FFFEFA" stroke={p.accent} strokeWidth="2" strokeDasharray="5 5" /><path d="M18 153v-26c0-29 22-47 50-47s50 18 50 47v26" fill="#FFFEFA" stroke={p.accent} strokeWidth="2" strokeDasharray="5 5" /><path d="M61 46h14m-7-7v14" stroke={p.accent} strokeWidth="2" strokeLinecap="round" /></svg>
  <span style={{fontSize: 16, color: p.muted, letterSpacing: 2, marginTop: 15}}>你的角色图片</span>
</div>;

const NativeChat = ({hero = false}: {hero?: boolean}) => {
  const frame = useCurrentFrame(); const {fps} = useVideoConfig();
  return <Screen>
    <div style={{position: 'absolute', inset: '30px 36px 40px', display: 'grid', gridTemplateColumns: `216px minmax(0,1fr)${hero ? ' 280px' : ''}`, gap: 16}}>
      <Card style={{padding: 12, position: 'relative'}}>
        <div style={{display: 'flex', gap: 4, fontSize: 11, paddingBottom: 22, fontWeight: 700}}><span style={{color: p.accent, borderBottom: `2px solid ${p.accent}`, padding: '5px 8px'}}>MAIN CHAT</span><span style={{color: p.faint, padding: '5px 8px'}}>COWORK</span></div>
        <div style={{display: 'flex', color: p.accent, fontSize: 14, alignItems: 'center', marginBottom: 13, fontWeight: 700}}>会话 <span style={{marginLeft: 'auto'}}><Icon type="plus" size={18} /></span></div>
        <div style={{border: `1px solid ${p.line}`, borderRadius: 10, padding: '10px 12px', fontSize: 12, color: p.muted}}>全部来源 <span style={{float: 'right'}}>0 ⌄</span></div>
        <div style={{fontSize: 13, color: p.faint, marginTop: 49, textAlign: 'center'}}>还没有会话</div>
        <div style={{position: 'absolute', left: 15, right: 15, bottom: 15, paddingTop: 14, borderTop: `1px solid ${p.line}`, fontSize: 12, color: p.muted, display: 'flex', justifyContent: 'space-between'}}><span>日历</span><span>执行环境</span></div>
      </Card>
      <Card style={{position: 'relative', overflow: 'hidden'}}>
        <div style={{position: 'absolute', left: 0, right: 0, top: 73, textAlign: 'center', color: p.accent}}><Sailboat size={59} /><div style={{fontSize: 29, fontWeight: 500, color: p.ink, marginTop: 18}}>选择一个 Agent，开始对话</div></div>
        <Composer />
      </Card>
      {hero && <div style={{width: 260, height: 370, background: '#FFF', border: '9px solid white', borderBottomWidth: 44, boxShadow: shadow, margin: '58px 0 0 9px', position: 'relative', rotate: `${2.5 + Math.sin(frame / (fps * 1.8)) * 0.5}deg`, translate: `0 ${Math.sin(frame / (fps * 1.8)) * -5}px`}}><CharacterPlaceholder /><span style={{position: 'absolute', width: '100%', bottom: -31, textAlign: 'center', color: p.muted, fontSize: 15}}>由你定义的开屏</span></div>}
    </div>
  </Screen>;
};

const ScreenPlacement = ({children, delay = 0.2}: {children: ReactNode; delay?: number}) => <Reveal delay={delay} style={{position: 'absolute', top: 314, left: 211, scale: 1.04, transformOrigin: 'top left'}}>{children}</Reveal>;
const Ribbon = ({children}: {children: ReactNode}) => <div style={{display: 'inline-flex', padding: '10px 30px', color: 'white', background: p.accent, fontSize: 18, fontWeight: 700, clipPath: 'polygon(0 0,100% 0,calc(100% - 10px) 50%,100% 100%,0 100%,10px 50%)'}}>{children}</div>;

const SettingsNav = ({active}: {active: string}) => <Card style={{position: 'absolute', left: 30, top: 30, width: 218, padding: 15, height: 504}}>
  {['Main Chat','Agents','Skill · MCP','Settings'].map((label, i) => <div key={label} style={{display: 'flex', alignItems: 'center', gap: 13, padding: '13px 14px', marginBottom: 6, borderRadius: 10, fontSize: 15, background: label === active ? '#EEE6FC' : 'transparent', border: label === active ? '1px solid #D5C5F6' : '1px solid transparent', color: label === active ? p.ink : p.muted}}><Icon type={(['agent','agent','skill','model'] as const)[i]} size={19} />{label}</div>)}
  <div style={{borderTop: `1px solid ${p.line}`, color: p.muted, padding: '24px 14px 0', marginTop: 13, fontSize: 13}}>···　更多功能</div>
</Card>;

const ModelScreen = () => <Screen>
  <SettingsNav active="Settings" />
  <div style={{position: 'absolute', left: 281, top: 30, right: 36}}>
    <Ribbon>模型连接</Ribbon><span style={{fontSize: 15, color: p.muted, marginLeft: 23}}>自己的服务商，自己的模型目录</span>
    <Card style={{position: 'relative', marginTop: 32, padding: '31px 32px 28px'}}><Tape />
      <div style={{fontSize: 21, color: p.accent, fontWeight: 700, marginBottom: 25}}>添加你的模型连接</div>
      <div style={{display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 26}}>
        <div><div style={{fontSize: 14, color: p.muted, marginBottom: 10}}>服务地址</div><div style={{padding: '17px 18px', fontSize: 18, border: `1.5px solid ${p.line}`, borderRadius: cardRadius, background: 'white'}}>https://example.invalid/v1</div></div>
        <div><div style={{fontSize: 14, color: p.muted, marginBottom: 10}}>模型</div><div style={{padding: '17px 18px', fontSize: 18, border: `1.5px solid ${p.line}`, borderRadius: cardRadius, background: 'white'}}>your-model</div></div>
      </div>
      <Reveal delay={1}><div style={{marginTop: 27, border: `1px dashed ${p.accent}`, borderRadius: 14, padding: '20px 22px', display: 'flex', alignItems: 'center', gap: 15, color: p.accent, background: '#F4EEFD'}}><Icon type="lock" size={25} /><span style={{fontSize: 20}}>密钥从后端环境变量读取</span><span style={{marginLeft: 'auto', fontSize: 14}}>不写入前端</span></div></Reveal>
      <div style={{marginTop: 23, fontSize: 13, color: p.muted}}>地址与模型名为占位示例，不表示已连接服务。</div>
    </Card>
  </div>
</Screen>;

const CapabilityScreen = () => <Screen>
  <SettingsNav active="Agents" />
  <div style={{position: 'absolute', left: 281, top: 30, right: 36}}>
    <Ribbon>Agent 与能力</Ribbon><span style={{fontSize: 15, color: p.muted, marginLeft: 23}}>把自己的规则和能力接进来</span>
    <div style={{display: 'grid', gridTemplateColumns: '1.15fr 1fr', gap: 22, marginTop: 29}}>
      <Card style={{padding: 26, minHeight: 368, position: 'relative'}}><Tape />
        <div style={{display: 'flex', gap: 14, alignItems: 'center', color: p.accent, fontSize: 21, fontWeight: 700}}><Icon type="agent" size={25} />自己的 Agent</div>
        <div style={{fontSize: 15, color: p.muted, marginTop: 23, paddingBottom: 12, borderBottom: `1px solid ${p.line}`}}>CLAUDE.md</div>
        <div style={{fontSize: 21, lineHeight: 1.9, marginTop: 18}}><span style={{color: p.faint}}># </span>你的角色与工作方式<br /><span style={{color: p.faint}}>· </span>人设、规则与边界<br /><span style={{color: p.faint}}>· </span>按需挂载自己的能力</div>
      </Card>
      <div style={{display: 'flex', flexDirection: 'column', gap: 20}}>
        <Reveal delay={0.7}><Card style={{padding: '25px 27px', minHeight: 174, position: 'relative'}}><Tape pink /><div style={{fontSize: 27, color: p.accent, fontWeight: 700}}>Skill</div><div style={{fontSize: 19, marginTop: 14}}>你的方法、资料与任务规则</div><div style={{fontSize: 14, color: p.muted, marginTop: 17}}>SKILL.md · 按需读取</div></Card></Reveal>
        <Reveal delay={1.2}><Card style={{padding: '25px 27px', minHeight: 174}}><div style={{fontSize: 27, color: p.accent, fontWeight: 700}}>MCP</div><div style={{fontSize: 19, marginTop: 14}}>你选择的外部工具与服务</div><div style={{fontSize: 14, color: p.muted, marginTop: 17}}>独立配置 · 明确权限</div></Card></Reveal>
      </div>
    </div>
  </div>
</Screen>;

export const WelcomeScene = () => <Shell chapter="01 / 熟悉的界面"><Heading sub="接入自己的 Agent，让熟悉的工作台继续属于你。">保留熟悉的界面。</Heading><ScreenPlacement><NativeChat /></ScreenPlacement></Shell>;
export const ModelScene = () => <Shell chapter="02 / 自己的模型"><Heading sub="模型、服务地址与后端凭据，由你配置。">你来选择模型。</Heading><ScreenPlacement><ModelScreen /></ScreenPlacement></Shell>;
export const AgentScene = () => <Shell chapter="03 / 自己的能力"><Heading sub="Agent / Skill / MCP，按自己的需要组织。">把你的能力，接进来。</Heading><ScreenPlacement><CapabilityScreen /></ScreenPlacement></Shell>;
export const CharacterScene = () => <Shell chapter="04 / 自定义开屏">
  <Heading sub="上传自己的角色图片，保留手账里的熟悉位置。">开屏角色，由你来定。</Heading>
  <ScreenPlacement><NativeChat hero /></ScreenPlacement>
  <Reveal delay={1.3} style={{position: 'absolute', right: 237, top: 275, color: p.accent, fontSize: 22, rotate: '-3deg', display: 'flex', gap: 9, alignItems: 'center'}}><Star size={21} />仅为图片位置示意</Reveal>
</Shell>;

const PrivacyCard = ({title, items, privateCard = false}: {title: string; items: string[]; privateCard?: boolean}) => <Card style={{position: 'relative', height: 300, padding: '39px 43px'}}><Tape pink={privateCard} />
  <div style={{display: 'flex', alignItems: 'center', gap: 18, color: p.accent, fontSize: 33, fontWeight: 700}}>{privateCard ? <Icon type="lock" size={32} /> : <Star size={33} outline />}{title}</div>
  <div style={{display: 'flex', flexWrap: 'wrap', gap: 14, marginTop: 37}}>{items.map(item => <div key={item} style={{fontSize: 26, padding: '14px 19px', border: `1px solid ${p.line}`, borderRadius: cardRadius, background: privateCard ? '#FBEAF1' : '#F1EBFC'}}>{item}</div>)}</div>
  <div style={{fontSize: 23, color: p.muted, marginTop: 32}}>{privateCard ? '只在本机，自己保管' : '可以分享的框架与起点'}</div>
</Card>;

export const DataScene = () => <Shell chapter="05 / 清楚的隐私边界">
  <Heading sub="分享代码，不附带你的私人工作台。">本地数据与密钥，不入 Git。</Heading>
  <Reveal delay={0.3} style={{position: 'absolute', left: 132, top: 419, width: 735}}><PrivacyCard title="Git 仓库" items={['界面与框架','公开文档','中性示例']} /></Reveal>
  <div style={{position: 'absolute', left: 960, top: 422, bottom: 273, borderLeft: '2px dashed rgba(138,112,224,0.3)'}} />
  <Reveal delay={0.7} style={{position: 'absolute', right: 132, top: 419, width: 735}}><PrivacyCard title="本机私有" privateCard items={['.env 密钥','本地会话','个人数据']} /></Reveal>
  <Reveal delay={1.3} style={{position: 'absolute', left: 132, top: 811, fontSize: 28, lineHeight: 1.8, color: p.muted}}>模型请求仍会发送给所选服务商。<br />本地保存与 Git 隔离，不代表离线推理。</Reveal>
</Shell>;

export const ClosingScene = () => {
  const frame = useCurrentFrame(); const {fps} = useVideoConfig();
  return <Shell chapter="06 / Harbour" closing>
    <div style={{position: 'absolute', width: 1010, height: 690, left: 455, top: 205, border: '1px dashed rgba(138,112,224,0.22)', borderRadius: '50%', rotate: '-8deg', scale: interpolate(frame, [0, 4.5 * fps], [0.94, 1], clamp)}} />
    <Reveal delay={0.1} style={{position: 'absolute', top: 246, width: '100%', display: 'flex', justifyContent: 'center'}}><Brand size={270} /></Reveal>
    <Reveal delay={0.5} style={{position: 'absolute', top: 652, width: '100%', textAlign: 'center', fontSize: 54, fontWeight: 500, letterSpacing: 3}}>熟悉的工作台，你自己的 Agent。</Reveal>
    <Reveal delay={1} style={{position: 'absolute', top: 765, width: '100%', textAlign: 'center', fontSize: 29, color: p.accent, letterSpacing: 5}}>MODEL　 /　 SKILL　 /　 MCP</Reveal>
    <div style={{position: 'absolute', left: 408, top: 448}}><Star size={64} color={p.pink} /></div>
    <div style={{position: 'absolute', right: 383, top: 311, rotate: '15deg'}}><Star size={85} outline /></div>
    <div style={{position: 'absolute', right: 489, top: 778}}><Star size={30} color={p.gold} /></div>
  </Shell>;
};

export const HarbourIntro = () => {
  const frame = useCurrentFrame(); const {fps, durationInFrames} = useVideoConfig();
  return <AbsoluteFill style={{background: p.paper}}>
    <TransitionSeries>
      <TransitionSeries.Sequence name="熟悉的界面" durationInFrames={4.5 * fps}><WelcomeScene /></TransitionSeries.Sequence>
      <TransitionSeries.Transition presentation={{component: PaperTransition, props: {}}} timing={linearTiming({durationInFrames: 0.5 * fps})} />
      <TransitionSeries.Sequence name="自己的模型" durationInFrames={5.5 * fps}><ModelScene /></TransitionSeries.Sequence>
      <TransitionSeries.Transition presentation={{component: PaperTransition, props: {}}} timing={linearTiming({durationInFrames: 0.5 * fps})} />
      <TransitionSeries.Sequence name="Agent Skill MCP" durationInFrames={5.5 * fps}><AgentScene /></TransitionSeries.Sequence>
      <TransitionSeries.Transition presentation={{component: PaperTransition, props: {}}} timing={linearTiming({durationInFrames: 0.5 * fps})} />
      <TransitionSeries.Sequence name="自定义角色图片" durationInFrames={5.5 * fps}><CharacterScene /></TransitionSeries.Sequence>
      <TransitionSeries.Transition presentation={{component: PaperTransition, props: {}}} timing={linearTiming({durationInFrames: 0.5 * fps})} />
      <TransitionSeries.Sequence name="本地数据与 Git 边界" durationInFrames={6.5 * fps}><DataScene /></TransitionSeries.Sequence>
      <TransitionSeries.Transition presentation={{component: PaperTransition, props: {}}} timing={linearTiming({durationInFrames: 0.5 * fps})} />
      <TransitionSeries.Sequence name="Harbour" durationInFrames={5 * fps}><ClosingScene /></TransitionSeries.Sequence>
    </TransitionSeries>
    <div style={{position: 'absolute', height: 3, bottom: 0, left: 0, background: p.accent, opacity: 0.55, width: `${interpolate(frame, [0, durationInFrames - 1], [0, 100], {extrapolateRight: 'clamp'})}%`}} />
  </AbsoluteFill>;
};
