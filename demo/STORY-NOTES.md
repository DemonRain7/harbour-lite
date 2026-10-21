# Harbour 双语介绍片（HarbourStory · 放映室版）

成片：[harbour-story.mp4](../docs/media/harbour-story.mp4)。这是在 30 秒短版 `HarbourIntro` 之外新增的长版合成，用于 Bilibili / GitHub 介绍 Harbour 是什么；短版源码与成片不变。

- 58.8 秒，1920×1080，30 fps，1764 帧，H.264 / yuv420p / BT.709，CRF 18。
- 立体声配乐 + 音效（AAC，48 kHz，-16 LUFS）：全部由 [scripts/make-score.mjs](scripts/make-score.mjs) 在本地用代码合成，不含采样、下载素材或 TTS，见下文「配乐与音效」。
- 中文主标题 + 英文副标题，同一条片子兼顾中文与英文观众。
- 视觉沿用公开版 `premium-champagne`「放映室 · 香槟」配色：暖黑 #070606、香槟金 #E2C285、米白 #F3EEE3；字标沿用 `web/fonts/wordmark/caveat-harbour.woff2`，中文 Noto Sans SC。
- 源码：[src/Story.tsx](src/Story.tsx)，在 Studio 的 `HarbourStory` 下预览，各场景也在 `StoryScenes` 文件夹单独注册。

## 剪辑：踩在 100 BPM 上

- 整片按 100 BPM 剪：一拍 0.6 秒（18 帧）。源码里的时间都写成「拍格秒」，一拍记作 0.5；`TEMPO = 1.2` 把拍格秒换算成真实秒数（`useSeconds()`、`storyFrames()`），所以改速度只动这一个常量，场景里各元素的先后节奏不变。
- 每次换场是一道灯塔光束从左往右扫过画面，新场景从光束后面露出来；光束扫过画面中线的一刻（场景起点后 0.25 拍格秒，即 0.3 秒）正好落在拍点上，配乐在这一刻换和弦、落鼓。
- 每场时长扣掉 0.5 拍格秒的转场重叠后都是偶数拍，所以每次换场都落在强拍上；这也是「05 音乐」取 6.5 拍格秒而不是 6 的原因。
- 场景里的入场时刻都落在八分音符上（0.25 拍格秒的整数倍），卡片、能力行、主题切换跟着节拍一个接一个出现，没有空等的停顿；内容到齐后整页仍在缓慢推近，画面不停住。
- 标题逐字浮现（每个字由模糊到清晰）；开场和片尾的手写字标由灯塔光束扫过时写出，光束扫到哪里字就亮到哪里。
- 画面底部一条「航线」标出 01–09 九个章节，金色光点随播放前进、每拍轻跳一下，最后停在片尾的圆环上。

## 分镜

场间 0.6 秒光束转场，时间为成片真实秒数，含重叠。

| 时间 | 场景 | 中文 / English | 画面 |
| --- | --- | --- | --- |
| 0–5.4s | 开场 | 给你的 AI 伙伴们，一个可以停靠的港湾。/ A home port for your AI agents | 海平线、灯塔亮起，光束扫过写出手写字标 |
| 4.8–10.2s | 01 是什么 | 你自己的 Agent 工作台 / Your own agent workbench | 主聊天界面（香槟主题） |
| 9.6–16.2s | 02 伙伴 | 每位伙伴，各司其职 / Each agent gets its own role, model and toolset | Agent 卡片按拍连线到各自模型；自带 API Key 支持的服务商 |
| 15.6–21s | 03 能力 | 能力，按需挂载 / Skills, workflows and MCP, mounted per agent | 能力中心 |
| 20.4–25.8s | 04 不止聊天 | 不止聊天 / Calendar, scheduled jobs and message channels | 日历、定时任务、消息渠道三张局部 |
| 25.2–33s | 05 音乐 | 听着歌，慢慢聊 / Folia is built in: word-by-word lyrics and visualizers | Folia 播放页按拍切换 Monet、Sonnet、Tempera、Partita 四种可视化，左侧模式标签同步点亮；最后聊天页的「音乐陪伴」小窗浮上来 |
| 32.4–37.8s | 06 空间 | 做出来的，都有处安放 / Images, comics and documents your agents make, kept in one place | 作品空间，八张作品卡一个八分音符落一张 |
| 37.2–42.6s | 07 用量 | 每一次调用，都有账可查 / Tokens, cache hits and cost | 用量面板，曲线由金线扫出 |
| 42–47.4s | 08 外观 | 换一身装扮，还是那个港湾 / Switch themes freely | 香槟、钨丝、薰衣草、雪绒四套主题按切分节奏划过 |
| 46.8–53.4s | 09 上手 | 交给你的编码 Agent 来安装 / Hand the setup to your coding agent | README 交接 Prompt 打字机节选（链接与文件名打完变金色）+ 三步 |
| 52.8–58.8s | 片尾 | 让每一位 Agent，都有处停靠。/ A harbour for your agents | 字标、仓库地址、「公开版准备中 · 尚未正式发布」 |

## 配乐与音效

- 100 BPM，D 大调。光束扫过画面中线的一刻换和弦（I–vi–IV–I⁶–ii–iii–vi–ii–IV–vi–IV–V–I），「09 上手」停在属和弦，片尾回到主和弦 Dmaj9。
- 节奏：开场只有铺底和海浪，最后一小节琶音淡入；01 起加入柔和的底鼓（没有起音的“哒”声），03 起每拍一下、2、4 拍加刷子；铺底与低音随底鼓轻微让开（侧链），形成呼吸感。片尾前两拍鼓抽掉、琶音变成十六分音符，把片尾推出来。
- 声音全部是合成的：铺底与低音用带限波表 + 轻微失谐；电钢、软钟、拨弦、提示音用衰减分音；海浪、气流、刷子、键盘敲击用滤波噪声；再过 Freeverb 混响与附点八分音符的左右回声。固定随机种子，每次生成结果相同。
- 为了不刺耳：音色只用整数倍谐波，钟声音区不高于 D6，所有起音不短于 3 ms，气流与敲击声的滤波上限压在 2 kHz 左右，混响阻尼加大，母带再把 5.5 kHz 以上压低约 3 dB。这一轮放慢后音色不变：事件时刻按 `TEMPO` 拉长，跟画面走的长度（气流、海浪、铺底保持）一起拉长，乐器自身的衰减仍按真实时间，所以不会变闷、变拖。
- 与画面对位（时间取自 `src/Story.tsx` 里的 `STORY_SCENES`、`CREW_AT`、`MUSIC_CUT`、`MUSIC_POP`、`CARD_AT`、`USAGE_SWEEP`、`LOOK_HIT`、`PROMPT_TYPING`、`STEP_AT` 等常量）：
  - 开场：海浪起，灯在第一拍亮起（低频落地 + 软钟）；按同一条缓动曲线反算光束扫过每个字母的时刻，字标逐个落音。
  - 每次换场：一道气流从左声道扫到右声道跟着光束走，最亮处落在拍点上；各场标题与英文副标题在这一拍和后半拍各落一音，逐场往上走。
  - 02 伙伴：四张模型卡片一个八分音符落一张，声像跟着卡片的横向位置。
  - 03 能力、04 不止聊天：每行挂载、每张截图上浮各配一声。
  - 05 音乐：模式标签亮起时一串上行提示音；三次切换可视化各配一道短气流和一声软钟，音高逐次往上；「音乐陪伴」小窗浮上来时一道下行气流和两声提示音。
  - 06 空间：八张作品卡各落一音，电钢沿 Em7 分解和弦往上走两个八度，声像跟着卡片所在的列从左到右。
  - 07 用量：金线扫曲线时，五声音阶跟着金线从左往右向上走。
  - 08 外观：三次主题划入落在附点四分音符的切分上，各一道气流 + 一声软钟。
  - 09 上手：Prompt 打字落在十六分音符上，三步出现各落一音。
  - 片尾：主和弦落地，灯塔再亮，字标写出，仓库地址一声软钟，最后 1.4 拍格秒（约 1.7 秒）淡出。
- 母带：按 ITU-R BS.1770 积分响度归一到 -16 LUFS，前瞻限制器把采样峰值压在 -1.8 dBFS 以下。
- 改了场景时长或入场时刻，要同步 `make-score.mjs` 里的 `SCENES` 和事件表（时间同样写拍格秒），再运行 `npm --prefix demo run score` 重新生成 `public/story/score.m4a`（用 `@remotion/cli` 自带的 ffmpeg 编码，不需要另装）。脚本会断言总长与每次换场落在强拍上。要单独检查各分轨电平：`node demo/scripts/make-score.mjs --wav <输出.wav> --stems <目录>`。

## 素材与事实边界

- `public/story/*.jpg` 全部是**本仓库 `web/` 的实机截图**：用只读本地静态服务加载公开版前端，接口返回固定的演示数据（示例 Agent、示例能力、30 天模拟用量、示例日程与定时任务、示例音乐状态与作品），再用无头 Chrome 以 2880×1800 截取。没有连接任何真实模型、账号或机器人，不含私人会话、记忆或密钥。
- 画面中每处截图都标了「演示数据」。聊天界面展示的是真实的空会话，没有伪造模型回复；示例 Agent / 能力在界面里本身标有「示例」。
- 截图时**隐藏了聊天页顶部的滚动引言条**（`.hb-marquee`），因为里面是第三方作品台词；其余界面未做修改。
- 「05 音乐」：播放页外框是公开版 `web/` 的实机截图（`music.jpg`），舞台里合成的是仓库内置 Folia（`vendor/folia`，上游 [chthollyphile/folia-major](https://github.com/chthollyphile/folia-major) v0.7.7，AGPL-3.0）自己的可视化渲染器画面。为了逐帧确定，用一个临时开发探针（未提交）挂载 Folia 的 `VisualizerRenderer`，Playwright 假时钟每次前进 1/30 秒、CDP 截一帧，再编码成 `public/story/folia-*.mp4`（1408×716，H.264，四段共约 3.6 MB）。这四段在片中按真实速度播放，不随 `TEMPO` 缩放。
- 「05 音乐」里的歌名「Harbour Theme」和中英歌词是为本片写的原创演示内容，不是真实曲目；片中听到的只有上面合成的配乐，没有播放任何现成歌曲。聊天页「音乐陪伴」小窗（`chat-music.jpg`）同样是演示状态下的实机截图。
- 「06 空间」里的作品都是演示数据：缩略图取自本片海报与上面的 Folia 画面，标题是原创示例，没有真实用户作品；画面注明「只保存在本机」。
- 这一版**没有放进「小镇」与「桌面伙伴」**：小镇页面需要的地图和角色模型不在公开版仓库里，公开版打开会出错；桌面伙伴依赖角色立绘。两者等公开版能实机演示后再补。
- 「08 外观」只取四套主题截图左侧的界面部分（`LOOK_CROP`），**成片里不出现薰衣草 / 雪绒主题自带的角色立绘**。原始截图 `chat-wisteria.jpg` / `chat-snowfleece.jpg` 仍是完整画面，立绘本身也随公开版 `web/` 主题资源一起，属于公开版整体的第三方授权审核范围。
- 「04 不止聊天」只写了 Discord 与 QQ 官方机器人：企业微信在界面里仍是「未实现」，所以不出现在文案里；账号与机器人需用户自行连接，画面已注明。
- 「07 用量」里的金额是演示用量按示例账本算出的估算值，不是真实账单。
- 服务商列表与 `src/core/providerCatalog.ts` 一致：Anthropic、OpenAI、DeepSeek、Kimi、OpenRouter、自定义端点，全部是自带 API Key。
- 「09 上手」的 Prompt 是 README 交接 Prompt 的开头节选，画面注明「完整 Prompt 见 README」。
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

这一轮把 39 秒版扩到 58.8 秒：补上「05 内置 Folia 音乐」与「06 作品空间」两场，整片从 120 BPM 放慢到 100 BPM，配乐按新时间线重排，并为两场新戏写了对位音效。

- `npm --prefix demo run typecheck` 通过；先逐场抽帧检查两场新戏（Folia 画面是否落在舞台内、模式标签是否与切换同步、作品卡是否与底图对齐、航线是否为 01–09），把「音乐陪伴」小窗从模式标签旁挪开。
- 最终 MP4 经 ffprobe 确认：h264、1920×1080、30/1、yuv420p、bt709 / tv range、1764 帧、58.8 秒；音轨 AAC LC、48 kHz 立体声；约 27.6 MB（Folia 可视化画面细节多，比上一版大）；`ffmpeg -xerror` 全片解码通过。
- 音轨实测（ffmpeg ebur128）：积分响度 -16.0 LUFS、响度范围 2.0 LU、真峰值 -1.8 dBTP；折叠成单声道为 -19.5 LUFS，没有明显的相位抵消。成片音轨与 `score.m4a` 互相关 0.99995、零偏移、增益差 0.02 dB。
- 分轨电平（归一化后的积分响度）：铺底 -20.0、电钢与软钟 -22.2、海浪 -22.7、琶音 -24.2、鼓 -24.6、低音 -25.2、音效 -26.6 LUFS，鼓不压过旋律。
- 声音只做了客观检查（逐段响度、分轨电平、事件对位），发布前请再人工试听一遍。
- [海报](../docs/media/harbour-story-poster.png)（第 3.84 秒）与[关键帧联系表](../docs/media/harbour-story-contact-sheet.png)（14 帧，含音乐场三种可视化与一张转场中点）均从最终 MP4 解码生成。
- 本片由 Claude Code 按 `remotion-best-practices` Skill 的约定直接编写源码与渲染，不是 Harbour 内的 Agent 运行；渲染和配乐生成都不调用任何语言模型。
