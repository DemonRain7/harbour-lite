# Harbour 双语介绍片（HarbourStory · 放映室版）

成片：[harbour-story.mp4](../docs/media/harbour-story.mp4)。这是在 30 秒短版 `HarbourIntro` 之外新增的长版合成，用于 Bilibili / GitHub 介绍 Harbour 是什么；短版源码与成片不变。

- 49.5 秒，1920×1080，30 fps，1485 帧，H.264 / yuv420p / BT.709，CRF 18。
- 无音轨（无音乐、无 TTS）；上传 Bilibili 时可自行配乐。
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
npm --prefix demo run render:story
```

写入 `docs/media/harbour-story.mp4`（覆盖同名文件）。首次渲染会由 Remotion 下载 Chrome Headless Shell。

## 本轮验收

- `npm --prefix demo run typecheck` 通过；渲染前逐场景出静帧查看，修正了能力页副标题被截图遮挡、三张局部截图过小、主题扇形布局失衡等问题。
- 最终 MP4 经 ffprobe 确认：h264、1920×1080、30/1、yuv420p、bt709 / tv range、1485 帧、49.5 秒、无音轨，约 10 MB；`ffmpeg -xerror` 全片解码通过。
- 从最终 MP4 抽取 10 张关键帧与 3 张转场帧查看：文字未溢出或重叠，转场无标题叠影。
- [海报](../docs/media/harbour-story-poster.png)（第 3.6 秒）与[关键帧联系表](../docs/media/harbour-story-contact-sheet.png)均从最终 MP4 解码生成。
- 本片由 Claude Code 按 `remotion-best-practices` Skill 的约定直接编写源码与渲染，不是 Harbour 内的 Agent 运行；渲染本身不调用任何语言模型。
