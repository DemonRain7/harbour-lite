# Harbour 宣传介绍片：实际 Harbour 制作版

本轮交付是 [intro-harbour.mp4](../docs/media/intro-harbour.mp4)，不是此前的 intro.mp4。主旨是「把熟悉的外壳，交给你自己的 Agent」，保留原版奶油紫藤手账视觉，同时加入公开 UI 实景与 README 的 Agent 安装入口。

## 谁做的，怎样做的

按用户指定，实际运行链路为：

`Harbour createRuntime → runAgent → codex-app-server/gpt-6-astra（max）→ read_skill → Remotion 源码 → 构建 / 导出 / 看图`

- 运行前由 Harbour 的 Codex 模型目录确认 GPT-6 Astra 可用且支持 max；实际请求日志记录的也是该模型与强度，没有替换模型、自动 fallback 或 Mock。
- 使用公开副本中独立的临时 Harbour 实例与中性宣传片导演；不启动私人 Main，不加载其人设、记忆、偏好、凭据或聊天，不修改原 Harbour。常用 7799 预览仍是 Mock。
- 导演通过真正的 `read_skill` 加载 `remotion-best-practices` 入口及所需官方参考；官方 Skill 本机使用，没有未经许可将整份 Skill 复制进公开仓库。
- 导演拥有受限文件读取、Skill 和看图工具，以及只允许指定 demo 文件写入 / 固定 Remotion 构建动作的临时工具。没有原生 shell、浏览器、外部 MCP 或子 Agent 权限。
- 导演自行写分镜、重写六段场景、类型检查、渲染预览、看图修正、导出 MP4、全片解码并查看最终抽帧。外层 Codex 完成 README / 交接文档整合，并再次独立验证成片。
- 这是实际 Harbour Agent 执行，不是用 Codex 子 Agent 冒充；但它**不证明普通 Main Chat 的自动 Skill 路由或用户安装接入流程已经端到端验证**。

白名单运行摘要和文件哈希见 [HARBOUR-RUN.json](HARBOUR-RUN.json)。原始 Trace、主机信息、绝对路径与账号信息不公开。分镜及导演记录见 [STORYBOARD.md](STORYBOARD.md)。

## 成片与素材

- 30 秒，1920×1080，30 fps，900 帧，H.264 / yuv420p / BT.709 limited range，CRF 18。
- 无音乐、无 TTS、无音轨；没有使用用户私人音色或音乐库。
- [海报](../docs/media/intro-harbour-poster.png)：最终 MP4 第 28 秒解码帧。
- [六张关键帧](../docs/media/intro-harbour-contact-sheet.png)：最终 MP4 第 2、7、12、17、22、28 秒。
- `demo/src/`：可编辑 React / TypeScript 源码，六个场景单独注册。
- `demo/public/original-main-chat.png`：本仓库已核对的空会话公开 UI 截图，与 `docs/media/original-main-chat.png` 相同，不是私人聊天或实时录屏。
- 字标沿用 `web/fonts/wordmark/caveat-harbour.woff2`，其许可在同目录 `Caveat-OFL.txt`；中文使用固定版本 `@fontsource/noto-sans-sc`，许可见依赖包 LICENSE。
- 动画由帧数驱动，无额外远程素材或外部字体请求。Remotion 4.0.537 / React 19.2.0 / TypeScript 5.9.3 已由锁文件固定。

角色装饰局部来自公开 UI 截图，并在画面中注明「非开屏录屏」。没有伪造开屏功能录屏、安装成功界面或真实模型回答。角色图公开分发权与第三方许可仍随整个公开版另行审核；视觉检查不能证明授权。

## 叙事

| 时间 | 内容 |
| --- | --- |
| 0–4 秒 | 熟悉的外壳，你的 Agent |
| 4–9 秒 | 保留原 Electron / Web 界面、主题、聊天布局 |
| 9–14 秒 | 自接模型、定义 Agent、按需挂载能力 |
| 14–19 秒 | 自定义开屏图片；图片与助手身份分开配置 |
| 19–25 秒 | 复制 README 的交接 Prompt，发给自己的编码 Agent |
| 25–30 秒 | 品牌收尾与安装入口 |

视频中的对话仅是缩写示意，实际安装用 README 完整 Prompt。模型请求会发给用户所选服务商；本地保存不等于离线推理。本片是发布前预览，画面已注明审核状态，不能当作功能全通过或正式发布的证明。

## 预览与重新导出

视频工程是可选项，安装 Harbour 外壳不需要装这些依赖。建议 Node.js 24+；在仓库根目录执行：

```powershell
npm --prefix demo ci
npm --prefix demo run typecheck
npm --prefix demo run studio -- --port=3321
```

Studio 使用 `--no-open`，打开其实际打印的本地 URL，选择 `HarbourIntro`。端口占用时使用新的空闲端口，不停止其它服务。

另一个终端导出：

```powershell
npm --prefix demo run render
npm --prefix demo run verify
```

`render` 固定并发 2，写入 `docs/media/intro-harbour.mp4`；重渲染会覆盖该文件，保留自定义成片时先另存。首次依赖安装和浏览器下载需要网络。验证需 PATH 中存在 FFmpeg / FFprobe，也可设置 `FFMPEG` / `FFPROBE` 指向自己的工具。不要复制制作电脑的绝对路径。

`verify` 会校验视频编码、尺寸、帧率、颜色信息、900 帧、30 秒和无音轨，随后用 `ffmpeg -xerror` 全片解码，并从这份最终 MP4 生成海报、联系表与被忽略的 `demo/qa/decoded/` 检查帧。渲染和验证命令本身不调用语言模型；本轮导演创作是真实模型调用，两者不能混为一谈。

## 本轮实际验收

- 导演 TypeScript 检查通过；已实际查看源截图与六张预览帧，修正了全景 UI 底部偏紧的问题。
- 导演成功导出新 MP4，全片解码通过，并实际查看最终第 7、22 秒抽帧。
- 外层再次执行 TypeScript 和完整 verify 通过；实际查看六张最终解码关键帧及转场前后帧，主要文字、截图、示例对话和结尾未见溢出或重叠。
- 外层已打开 Studio、确认新合成预览可见；导演自身未持有浏览器能力，不能将外层观察记为它的操作。
- 本次只验收视频与交接文档，不代替产品完整安装 / 云服务 / 第三方授权验收。

旧 `docs/media/intro.mp4`、`poster.png`、`contact-sheet.png` 暂留作上一版对照。当前默认渲染与 README 均指向新的 Harbour 制作版。
