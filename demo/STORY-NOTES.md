# Harbour 双语介绍片（HarbourStory · 放映室版）

成片：[harbour-story.mp4](../docs/media/harbour-story.mp4)。这是在 30 秒短版 `HarbourIntro` 之外新增的长版合成，用于 Bilibili / GitHub 介绍 Harbour 是什么；短版源码与成片不变。

- 78 秒，1920×1080，30 fps，2340 帧，H.264 / yuv420p / BT.709，CRF 18。
- 立体声配乐 + 音效（AAC，48 kHz，-16 LUFS）：全部由 [scripts/make-score.mjs](scripts/make-score.mjs) 在本地用代码合成，不含采样、下载素材或 TTS，见下文「配乐与音效」。
- 中文主标题 + 英文副标题，同一条片子兼顾中文与英文观众。
- 视觉沿用公开版 `premium-champagne`「放映室 · 香槟」配色：暖黑 #070606、香槟金 #E2C285、米白 #F3EEE3；字标沿用 `web/fonts/wordmark/caveat-harbour.woff2`，中文 Noto Sans SC。
- 源码：[src/Story.tsx](src/Story.tsx)，在 Studio 的 `HarbourStory` 下预览，各场景也在 `StoryScenes` 文件夹单独注册。

## 剪辑：踩在 100 BPM 上

- 整片按 100 BPM 剪：一拍 0.6 秒（18 帧）。源码里的时间都写成「拍格秒」，一拍记作 0.5；`TEMPO = 1.2` 把拍格秒换算成真实秒数（`useSeconds()`、`storyFrames()`），所以改速度只动这一个常量，场景里各元素的先后节奏不变。
- 每次换场是一道灯塔光束从左往右扫过画面，新场景从光束后面露出来；光束扫过画面中线的一刻（场景起点后 0.25 拍格秒，即 0.3 秒）正好落在拍点上，配乐在这一刻换和弦、落鼓。
- 每场时长扣掉 0.5 拍格秒的转场重叠后都是偶数拍，所以每次换场都落在强拍上；这也是「05 执行进度」「08 音乐」取 6.5 拍格秒而不是 6 的原因。
- 场景里的入场时刻都落在八分音符上（0.25 拍格秒的整数倍），卡片、能力行、主题切换跟着节拍一个接一个出现，没有空等的停顿；内容到齐后整页仍在缓慢推近，画面不停住。
- 标题逐字浮现（每个字由模糊到清晰）；开场和片尾的手写字标由灯塔光束扫过时写出，光束扫到哪里字就亮到哪里。
- 画面底部一条「航线」标出 01–12 十二个章节，金色光点随播放前进、每拍轻跳一下，最后停在片尾的圆环上。

## 分镜

场间 0.6 秒光束转场，时间为成片真实秒数，含重叠。

| 时间 | 场景 | 中文 / English | 画面 |
| --- | --- | --- | --- |
| 0–5.4s | 开场 | 给你的 AI 伙伴们，一个可以停靠的港湾。/ A home port for your AI agents | 海平线、灯塔亮起，光束扫过写出手写字标 |
| 4.8–10.2s | 01 是什么 | 你自己的 Agent 工作台 / Your own agent workbench | 主聊天界面（香槟主题） |
| 9.6–16.2s | 02 伙伴 | 每位伙伴，各司其职 / Each agent gets its own role, model and toolset | Agent 卡片按拍连线到各自模型；自带 API Key 支持的服务商 |
| 15.6–22.2s | 03 专属伙伴 | 把喜欢的角色请进港湾 / Write who they are, how they talk and what they remember | Agent 页「人设与能力」：示例角色「汐」的 CLAUDE.md、SOUL.md、MEMORY.md、HEARTBEAT.md 按拍切换，左侧文件标签同步点亮 |
| 21.6–27s | 04 能力 | 能力，按需挂载 / Skills, workflows and MCP, mounted per agent | 能力中心 |
| 26.4–34.2s | 05 执行进度 | 每一步，都看得见 / Plans, subagents and tool receipts, unfolding live | 聊天页「执行进度」卡片的逐帧录屏：计划更新、派出子 Agent、工具调用与回执踩着拍子一步步展开，左侧「计划 / 子任务 / 工具」标签随事件闪亮 |
| 33.6–39s | 06 不止聊天 | 不止聊天 / Calendar, scheduled jobs and message channels | 日历、定时任务、消息渠道三张局部 |
| 38.4–45s | 07 悬浮助手 | 随叫随到，就在手边 / A floating orb on your desktop | 桌面上的小球：待机 → 有任务在跑、正在放歌（外圈轨道 + 音乐角标）→ 指针悬停，快捷对话面板弹开 → 收起后桌面歌词滑出 |
| 44.4–52.2s | 08 音乐 | 听着歌，慢慢聊 / Folia is built in: word-by-word lyrics and visualizers | Folia 播放页按拍切换 Monet、Sonnet、Tempera、Partita 四种可视化，左侧模式标签同步点亮；最后聊天页的「音乐陪伴」小窗浮上来 |
| 51.6–57s | 09 空间 | 做出来的，都有处安放 / Images, comics and documents your agents make, kept in one place | 作品空间，八张作品卡一个八分音符落一张 |
| 56.4–61.8s | 10 用量 | 每一次调用，都有账可查 / Tokens, cache hits and cost | 用量面板，曲线由金线扫出 |
| 61.2–66.6s | 11 外观 | 换一身装扮，还是那个港湾 / Switch themes freely | 香槟、钨丝、薰衣草、雪绒四套主题按切分节奏划过 |
| 66–72.6s | 12 上手 | 交给你的编码 Agent 来安装 / Hand the setup to your coding agent | README 交接 Prompt 打字机节选（链接与文件名打完变金色）+ 三步 |
| 72–78s | 片尾 | 让每一位 Agent，都有处停靠。/ A harbour for your agents | 字标、仓库地址、「公开版准备中 · 尚未正式发布」 |

## 配乐与音效

- 100 BPM，D 大调。光束扫过画面中线的一刻换和弦（I–vi–IV–ii–iii–I⁶–IV–V–vi–IV–Vsus–iii–vi–ii–IV–vi–IV–Vsus–V–I，场内的几次换和弦跟着文件切换、计划更新、桌面歌词出现），「12 上手」停在属和弦，片尾回到主和弦 Dmaj9。
- 节奏：开场只有铺底和海浪，最后一小节琶音淡入；01 起加入柔和的底鼓（没有起音的“哒”声），「03 专属伙伴」仍是半拍子、留给人设这一场安静一点，04 起每拍一下、2、4 拍加刷子；铺底与低音随底鼓轻微让开（侧链），形成呼吸感。片尾前两拍鼓抽掉、琶音变成十六分音符，把片尾推出来。
- 声音全部是合成的：铺底与低音用带限波表 + 轻微失谐；电钢、软钟、拨弦、提示音用衰减分音；海浪、气流、刷子、键盘敲击用滤波噪声；再过 Freeverb 混响与附点八分音符的左右回声。固定随机种子，每次生成结果相同。
- 为了不刺耳：音色只用整数倍谐波，钟声音区不高于 D6，所有起音不短于 3 ms，气流与敲击声的滤波上限压在 2 kHz 左右，混响阻尼加大，母带再把 5.5 kHz 以上压低约 3 dB。这一轮放慢后音色不变：事件时刻按 `TEMPO` 拉长，跟画面走的长度（气流、海浪、铺底保持）一起拉长，乐器自身的衰减仍按真实时间，所以不会变闷、变拖。
- 与画面对位（时间取自 `src/Story.tsx` 里的 `STORY_SCENES`、`CREW_AT`、`PERSONA_CUT`、`TRACE_EVENTS`、`ORB_AT`、`MUSIC_CUT`、`MUSIC_POP`、`CARD_AT`、`USAGE_SWEEP`、`LOOK_HIT`、`PROMPT_TYPING`、`STEP_AT` 等常量）：
  - 开场：海浪起，灯在第一拍亮起（低频落地 + 软钟）；按同一条缓动曲线反算光束扫过每个字母的时刻，字标逐个落音。
  - 每次换场：一道气流从左声道扫到右声道跟着光束走，最亮处落在拍点上；各场标题与英文副标题在这一拍和后半拍各落一音，逐场往上走。
  - 02 伙伴：四张模型卡片一个八分音符落一张，声像跟着卡片的横向位置。
  - 03 专属伙伴：四枚文件标签浮上时一串上行提示音；每次切到下一份文件，一道短气流 + 一声电钢，声像在右侧截图上。
  - 04 能力、06 不止聊天：每行挂载、每张截图上浮各配一声。
  - 05 执行进度：录屏里的运行事件本来就踩在拍点上。计划更新一声软钟，派出子 Agent 一声「落槽」，调用工具一声轻的提示音，拿到回执两声，声像在右侧卡片上；第二次更新计划时和弦推到属和弦。
  - 07 悬浮助手：小球弹出一声，变忙时随那圈金光一声软钟，面板弹开一道上行气流 + 两声提示音，收起一道下行气流，桌面歌词滑出时两声软钟；声像在右下角的小球上。
  - 08 音乐：模式标签亮起时一串上行提示音；三次切换可视化各配一道短气流和一声软钟，音高逐次往上；「音乐陪伴」小窗浮上来时一道下行气流和两声提示音。
  - 09 空间：八张作品卡各落一音，电钢沿 Em7 分解和弦往上走两个八度，声像跟着卡片所在的列从左到右。
  - 10 用量：金线扫曲线时，五声音阶跟着金线从左往右向上走。
  - 11 外观：三次主题划入落在附点四分音符的切分上，各一道气流 + 一声软钟。
  - 12 上手：Prompt 打字落在十六分音符上，三步出现各落一音。
  - 片尾：主和弦落地，灯塔再亮，字标写出，仓库地址一声软钟，最后 1.4 拍格秒（约 1.7 秒）淡出。
- 母带：按 ITU-R BS.1770 积分响度归一到 -16 LUFS，前瞻限制器把采样峰值压在 -1.8 dBFS 以下。
- 改了场景时长或入场时刻，要同步 `make-score.mjs` 里的 `SCENES` 和事件表（时间同样写拍格秒），再运行 `npm --prefix demo run score` 重新生成 `public/story/score.m4a`（用 `@remotion/cli` 自带的 ffmpeg 编码，不需要另装）。脚本会断言总长与每次换场落在强拍上。要单独检查各分轨电平：`node demo/scripts/make-score.mjs --wav <输出.wav> --stems <目录>`。

## 素材与事实边界

- `public/story/*.jpg` 全部是**本仓库 `web/` 的实机截图**：用只读本地静态服务加载公开版前端，接口返回固定的演示数据（示例 Agent、示例能力、30 天模拟用量、示例日程与定时任务、示例音乐状态与作品），再用无头 Chrome 以 2880×1800 截取。没有连接任何真实模型、账号或机器人，不含私人会话、记忆或密钥。
- 画面中每处截图都标了「演示数据」。聊天界面展示的是真实的空会话，没有伪造模型回复；示例 Agent / 能力在界面里本身标有「示例」。
- 截图时**隐藏了聊天页顶部的滚动引言条**（`.hb-marquee`），因为里面是第三方作品台词；其余界面未做修改。
- 「08 音乐」：播放页外框是公开版 `web/` 的实机截图（`music.jpg`），舞台里合成的是仓库内置 Folia（`vendor/folia`，上游 [chthollyphile/folia-major](https://github.com/chthollyphile/folia-major) v0.7.7，AGPL-3.0）自己的可视化渲染器画面。为了逐帧确定，用一个临时开发探针（未提交）挂载 Folia 的 `VisualizerRenderer`，Playwright 假时钟每次前进 1/30 秒、CDP 截一帧，再编码成 `public/story/folia-*.mp4`（1408×716，H.264，四段共约 3.6 MB）。这四段在片中按真实速度播放，不随 `TEMPO` 缩放。
- 「08 音乐」里的歌名「Harbour Theme」和中英歌词是为本片写的原创演示内容，不是真实曲目；片中听到的只有上面合成的配乐，没有播放任何现成歌曲。聊天页「音乐陪伴」小窗（`chat-music.jpg`）同样是演示状态下的实机截图。
- 「09 空间」里的作品都是演示数据：缩略图取自本片海报与上面的 Folia 画面，标题是原创示例，没有真实用户作品；画面注明「只保存在本机」。
- 「03 专属伙伴」：Agent 页「人设与能力」的实机截图。「汐」（`main-shio`）是为本片原创的示例角色，不对应任何真实用户、真人或已有作品；它的 CLAUDE.md / SOUL.md / MASTER.md / PREFERENCE.md / MEMORY.md / HEARTBEAT.md 和五个能力索引都是截图时由临时演示接口返回的演示内容（截图脚本未提交），仓库里没有新增这个 Agent。画面注明「示例角色 · 人设文件为演示内容」。人设里写明了「不假装是真人，不编造和用户的共同经历」。
- 「05 执行进度」：聊天页「执行进度」卡片是公开版 `web/` 前端的实机录屏。录制时用一个临时脚本（未提交）替换掉页面的 WebSocket，把一段演示任务的运行事件（`progress:updated`、`spawn_subagent`、`loop:tool-calls` / `loop:tool-result` 等，格式与后端推送的一致）按拍点推给前端；Playwright 假时钟每次前进 1/30 秒，并把页面上所有 CSS 动画对齐到同一个虚拟时间，再用 CDP 以 2 倍像素截帧，编码成 `public/story/trace-progress.mp4`（1850×1248，234 帧，约 0.5 MB）。没有运行任何模型或工具：计划步骤、子 Agent 名称和回执摘要（「已读取 6 份会议纪要」等）都是演示数据，画面注明「运行事件为演示数据」，也没有出现任何模型回复正文。
- 「07 悬浮助手」：小球、快捷对话面板和桌面歌词是公开版 `desktop/` 的实机截图：用 Electron 加载真实的 `OrbController`、渲染器与 preload（2 倍像素、透明窗口），音乐状态经由 `main.js` 里生产用的 `publishMusicState` 推给小球；没有连接后端、模型或播放器（相关调用在截图脚本里直接报错返回）。正在进行的任务「整理本周周报」、正在播放的「Harbour Theme」与歌词、输入框里的「六点提醒我去取快递」都是演示内容。忙碌状态的外圈轨道与音乐角标是同一渲染器逐帧截下的 `orb-busy.webm`（VP9 带透明通道）；面板截图里被冻结的那颗小球已抹掉，片中只叠一颗动态的。桌面壁纸、指针、面板弹开的缩放动画是片子自己画的示意。
- 小球用的是公开版没有角色头像时的默认样子（字形「h」），**片中不出现任何角色立绘或表情**。依赖角色立绘的「桌面伙伴」和需要地图与角色模型的「小镇」仍没有放进来：公开版仓库里没有这些资源，等能实机演示后再补。
- 「11 外观」只取四套主题截图左侧的界面部分（`LOOK_CROP`），**成片里不出现薰衣草 / 雪绒主题自带的角色立绘**。原始截图 `chat-wisteria.jpg` / `chat-snowfleece.jpg` 仍是完整画面，立绘本身也随公开版 `web/` 主题资源一起，属于公开版整体的第三方授权审核范围。
- 「06 不止聊天」只写了 Discord 与 QQ 官方机器人：企业微信在界面里仍是「未实现」，所以不出现在文案里；账号与机器人需用户自行连接，画面已注明。
- 「10 用量」里的金额是演示用量按示例账本算出的估算值，不是真实账单。
- 服务商列表与 `src/core/providerCatalog.ts` 一致：Anthropic、OpenAI、DeepSeek、Kimi、OpenRouter、自定义端点，全部是自带 API Key。
- 「12 上手」的 Prompt 是 README 交接 Prompt 的开头节选，画面注明「完整 Prompt 见 README」。
- 片尾写的是「公开版准备中 · 尚未正式发布」，不宣传已上线、已开源或全功能验收。

## 预览与重新导出

```powershell
npm --prefix demo ci
npm --prefix demo run typecheck
npm --prefix demo run studio -- --port=3321
```

在 Studio 里选择 `HarbourStory`。导出：

```powershell
npm --prefix demo run score   # 可选：重新生成配乐，仓库里已附带 public/story/score.m4a
npm --prefix demo run render:story
```

写入 `docs/media/harbour-story.mp4`（覆盖同名文件），配乐经 `@remotion/media` 的 `<Audio>` 混进成片。首次渲染会由 Remotion 下载 Chrome Headless Shell。

## 本轮验收

这一轮把 58.8 秒版扩到 78 秒，新加三场：「03 专属伙伴」（用几份 Markdown 定义自己的陪伴角色）、「05 执行进度」（聊天页执行进度卡片的实机录屏）、「07 悬浮助手」（桌面小球）。章节从九个变成十二个，配乐按新时间线重排和弦与节奏，并为三场新戏写了对位音效。

- `npm --prefix demo run typecheck` 通过；先用 Remotion 逐场出静帧检查三场新戏（截图是否落在框内、文件标签与切换是否同步、执行进度的事件是否踩拍、小球与面板 / 歌词是否对位、航线是否为 01–12），修掉了「HEARTBEAT.md 会主动问候」标签折行，并给小球场景补了灯塔桌面。
- 最终 MP4 经 ffprobe 确认：h264 High、1920×1080、30/1、yuv420p、bt709 / tv range、2340 帧、78 秒；音轨 AAC LC、48 kHz 立体声；约 37 MB（多了一段录屏和几张 2880×1800 截图）；`ffmpeg -xerror` 全片解码通过。再从成片里抽帧复查三场新戏，确认忙碌小球的外圈轨道与音乐角标（透明 webm）正常叠在桌面上。
- 音轨实测（ffmpeg ebur128）：积分响度 -16.0 LUFS、响度范围 1.8 LU、真峰值 -2.1 dBTP；折叠成单声道为 -19.5 LUFS，没有明显的相位抵消。成片音轨与 `score.m4a` 互相关 0.99995、零偏移、增益差 0.02 dB。
- 分轨电平（归一化后的积分响度）：铺底 -20.0、电钢与软钟 -22.7、海浪 -22.8、琶音 -24.1、鼓 -24.6、低音 -25.1、音效 -26.7 LUFS，鼓不压过旋律。
- 声音只做了客观检查（逐段响度、分轨电平、事件对位），发布前请再人工试听一遍。
- [海报](../docs/media/harbour-story-poster.png)（第 3.84 秒，开场未改，与上一版相同）与[关键帧联系表](../docs/media/harbour-story-contact-sheet.png)（20 帧，覆盖全部十二章与开场、片尾，含一张转场中点）均从最终 MP4 解码生成。
- 本片由 Claude Code 按 `remotion-best-practices` Skill 的约定直接编写源码与渲染，不是 Harbour 内的 Agent 运行；渲染和配乐生成都不调用任何语言模型。
