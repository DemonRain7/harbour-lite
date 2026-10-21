# Harbour 双语介绍片（HarbourStory · 放映室版）

成片：[harbour-story.mp4](../docs/media/harbour-story.mp4)。这是在 30 秒短版 `HarbourIntro` 之外新增的长版合成，用于 Bilibili / GitHub 介绍 Harbour 是什么；短版源码与成片不变。

- 49.5 秒，1920×1080，30 fps，1485 帧，H.264 / yuv420p / BT.709，CRF 18。
- 立体声配乐 + 音效（AAC，48 kHz，-16 LUFS）：全部由 [scripts/make-score.mjs](scripts/make-score.mjs) 在本地用代码合成，不含采样、下载素材或 TTS，见下文「配乐与音效」。
- 中文主标题 + 英文副标题，同一条片子兼顾中文与英文观众。
- 视觉沿用公开版 `premium-champagne`「放映室 · 香槟」配色：暖黑 #070606、香槟金 #E2C285、米白 #F3EEE3；字标沿用 `web/fonts/wordmark/caveat-harbour.woff2`，中文 Noto Sans SC。
- 源码：[src/Story.tsx](src/Story.tsx)，在 Studio 的 `HarbourStory` 下预览，各场景也在 `StoryScenes` 文件夹单独注册。

## 分镜

场间 0.5 秒「压暗 → 浮现」转场，时间含重叠。

| 时间 | 场景 | 中文 / English | 画面 |
| --- | --- | --- | --- |
| 0–5s | 开场 | 给你的 AI 伙伴们，一个可以停靠的港湾。/ A home port for your AI agents | 海平线、灯塔光束扫过，手写字标划出 |
| 4.5–10.5s | 01 是什么 | 你自己的 Agent 工作台 / Your own agent workbench | 主聊天界面（香槟主题） |
| 10–16.5s | 02 伙伴 | 每位伙伴，各司其职 / Each agent gets its own role, model and toolset | Agent 卡片，连线到各自模型；自带 API Key 支持的服务商 |
| 16–21.5s | 03 能力 | 能力，按需挂载 / Skills, workflows and MCP, mounted per agent | 能力中心 |
| 21–27.5s | 04 不止聊天 | 不止聊天 / Calendar, scheduled jobs and message channels | 日历、定时任务、消息渠道三张局部 |
| 27–32.5s | 05 用量 | 每一次调用，都有账可查 / Tokens, cache hits and cost | 用量面板，曲线由金线扫出 |
| 32–38.5s | 06 外观 | 换一身装扮，还是那个港湾 / Switch themes freely | 香槟、钨丝、薰衣草、雪绒四套主题依次划过 |
| 38–44.5s | 07 上手 | 交给你的编码 Agent 来安装 / Hand the setup to your coding agent | README 交接 Prompt 打字机节选 + 三步 |
| 44–49.5s | 片尾 | 让每一位 Agent，都有处停靠。/ A harbour for your agents | 字标、仓库地址、「公开版准备中 · 尚未正式发布」 |

## 配乐与音效

- 和声：D 大调，每次转场压到最暗的那一刻换和弦（I–vi–IV–I⁶–ii–IV–vi–IV–V–I），「07 上手」停在属和弦，片尾字标出现时回到主和弦。
- 声音全部是合成的：铺底与低音用带限波表 + 轻微失谐；键音、玻璃风铃、界面提示音用衰减分音；海浪、气流、键盘敲击用滤波噪声；再过 Freeverb 混响与左右回声。固定随机种子，每次生成结果相同。
- 与画面对位（时间取自 `src/Story.tsx` 的场景时长和 `Rise` 延迟）：
  - 开场：海浪与灯塔光束从左扫到右，灯亮一声风铃，手写字标从左往右逐个落音，金色下划线一道气流。
  - 每次转场：吸进暗处的一口气 + 一点低频落地。各场标题与英文副标题各落一个音，逐场往上走。
  - 02 伙伴：四条连线各一声提示音，四张模型卡片依次落音，声像跟着卡片的横向位置。
  - 03 能力、04 不止聊天：每行挂载、每张截图上浮各配一声。
  - 05 用量：金线扫曲线时，按同一条缓动曲线反算时刻，五声音阶跟着金线从左往右向上走。
  - 06 外观：三次主题划入各一道气流，划完落一声风铃。
  - 07 上手：Prompt 打字时一串轻敲（两行，声像随行移动），三步出现各落一音。
  - 片尾：海浪回来，灯塔再亮，字标写出，仓库地址一声风铃，最后 2.3 秒淡出。
- 母带：按 ITU-R BS.1770 积分响度归一到 -16 LUFS，前瞻限制器把采样峰值压在 -1.8 dBFS 以下。
- 改了场景时长或 `Rise` 延迟，要同步 `make-score.mjs` 里的 `SCENES` 和事件表，再运行 `npm --prefix demo run score` 重新生成 `public/story/score.m4a`（用 `@remotion/cli` 自带的 ffmpeg 编码，不需要另装）。要单独检查各分轨电平：`node demo/scripts/make-score.mjs --wav <输出.wav> --stems <目录>`。

## 素材与事实边界

- `public/story/*.jpg` 全部是**本仓库 `web/` 的实机截图**：用只读本地静态服务加载公开版前端，接口返回固定的演示数据（示例 Agent、示例能力、30 天模拟用量、示例日程与定时任务），再用无头 Chrome 以 2880×1800 截取。没有连接任何真实模型、账号或机器人，不含私人会话、记忆或密钥。
- 画面中每处截图都标了「演示数据」。聊天界面展示的是真实的空会话，没有伪造模型回复；示例 Agent / 能力在界面里本身标有「示例」。
- 截图时**隐藏了聊天页顶部的滚动引言条**（`.hb-marquee`），因为里面是第三方作品台词；其余界面未做修改。
- 「04 不止聊天」只写了 Discord 与 QQ 官方机器人：企业微信在界面里仍是「未实现」，所以不出现在文案里；账号与机器人需用户自行连接，画面已注明。
- 「05 用量」里的金额是演示用量按示例账本算出的估算值，不是真实账单。
- 服务商列表与 `src/core/providerCatalog.ts` 一致：Anthropic、OpenAI、DeepSeek、Kimi、OpenRouter、自定义端点，全部是自带 API Key。
- 「07 上手」的 Prompt 是 README 交接 Prompt 的开头节选，画面注明「完整 Prompt 见 README」。
- 片尾写的是「公开版准备中 · 尚未正式发布」，不宣传已上线、已开源或全功能验收。

**发布前仍需确认授权**：「06 外观」里的薰衣草 / 雪绒主题截图带有角色立绘（同短版一样，属于公开版整体的第三方授权审核范围）。在授权确认前若要公开上传，可以把 `src/Story.tsx` 里的 `LOOKS` 只保留两套放映室主题（其余二次元主题同样带立绘）。

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

- `npm --prefix demo run typecheck` 通过；渲染前逐场景出静帧查看，修正了能力页副标题被截图遮挡、三张局部截图过小、主题扇形布局失衡等问题。
- 最终 MP4 经 ffprobe 确认：h264、1920×1080、30/1、yuv420p、bt709 / tv range、1485 帧、49.5 秒；音轨 AAC LC、48 kHz 立体声、49.5 秒；约 11.7 MB；`ffmpeg -xerror` 全片解码通过。
- 配乐是后加的：没有重新渲染画面，而是把 `score.m4a` 直接封装进已验收的无声版 MP4，前后视频流 SHA-256 一致。
- 音轨实测（ffmpeg ebur128）：积分响度 -16.0 LUFS、响度范围 3.4 LU、真峰值 -2.1 dBTP；折叠成单声道为 -19.7 LUFS，没有明显的相位抵消。
- 用 Remotion 局部渲染前 150 帧：输出音轨与 `score.m4a` 互相关 0.9998、零偏移、增益差 0.02 dB，说明 `render:story` 重新导出会带上同一条音轨。
- 声音只做了客观检查（频谱图、逐段响度、分轨电平、事件对位），发布前请再人工试听一遍。
- 从最终 MP4 抽取 10 张关键帧与 3 张转场帧查看：文字未溢出或重叠，转场无标题叠影。
- [海报](../docs/media/harbour-story-poster.png)（第 3.6 秒）与[关键帧联系表](../docs/media/harbour-story-contact-sheet.png)均从最终 MP4 解码生成。
- 本片由 Claude Code 按 `remotion-best-practices` Skill 的约定直接编写源码与渲染，不是 Harbour 内的 Agent 运行；渲染和配乐生成都不调用任何语言模型。
