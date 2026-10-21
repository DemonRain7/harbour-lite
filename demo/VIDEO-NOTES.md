# Harbour Lite 介绍视频

30 秒中文产品介绍，定位为「轻量 Agent 启动器」。视频工程与主应用依赖完全隔离。

## 交付文件

- `docs/media/intro.mp4`：1920 × 1080，30 fps，900 帧，H.264，yuv420p，BT.709，CRF 18。
- `docs/media/poster.png`：从成片第 28 秒解码得到的海报。
- `docs/media/contact-sheet.png`：从成片第 2、7、12、17、22、28 秒解码得到的六宫格，按从左至右、从上至下排列。
- `demo/src/`：可编辑的 React / TypeScript 场景源码。
- `demo/package-lock.json`：固定依赖版本的锁文件。

成片刻意保持无声，不含 TTS、音乐或音轨。无外部模型调用，无收费生成服务。

## 视觉与内容边界

米白 `#f6f5ef`、墨青 `#153e40`、薄荷 `#c7e8d4`，留白、帧驱动淡入、轻微平移与 0.5 秒纸色过渡。相邻标题依次淡出与淡入，避免文字重影。

| 时间 | 内容 |
| --- | --- |
| 0–4 秒 | 给 AI 一个自己的工作台 |
| 4–9 秒 | OpenAI-compatible API；后端密钥；离线演示 |
| 9–14 秒 | Agent 文件夹、Markdown 人设、按需技能 |
| 14–19 秒 | 自定义开屏角色图片，默认不含第三方角色 |
| 19–25 秒 | 本地会话与配置；模型请求仍发送所选服务商 |
| 25–30 秒 | Harbour Lite / 轻量 Agent 启动器 |

表中时间是各场景开始时间，纸色过渡延续 0.5 秒。全部产品面板都是标注「界面示意」的原创图形，不是真实录屏。模型地址和模型 ID 仅为占位示例。人设示例路径对应公开模板 `agents/assistant/CLAUDE.md`，正文是视频示意，不承诺应用界面逐像素一致。

片中没有宣称完整桌宠、语音、浏览器 Agent 或私人工作流能力。「数据留在自己这里」明确限定本地保存；画面同时提示模型请求会发送到配置的服务商，本地保存不代表离线推理。

几何标记与植物插图为本项目源码绘制，无第三方角色、照片或个人内容。字体通过固定版本 `@fontsource/noto-sans-sc` 提供；其字体许可为 SIL Open Font License 1.1，详见安装包内 `LICENSE`。依赖各自保留发布者许可。官方 Remotion Skill 仅作为制作指导，没有复制、打包或重新发布到本仓库。

## 复现

需要 Node.js 22 或更新的兼容版本，以及 PATH 中可用的 `ffmpeg` / `ffprobe`。首次安装与首次渲染会下载 npm 依赖及 Remotion 的 Chrome Headless Shell；后续渲染不依赖远程素材。

在仓库根目录执行：

```sh
cd demo
npm ci
npm run typecheck
npm run studio -- --port=3321
```

Studio 使用 `--no-open`，不会主动打开或抢占浏览器窗口。访问命令实际输出的本地 URL；如指定端口被占用，换一个空闲端口，不重启其他服务。主合成名为 `HarbourLiteIntro`，`Scenes` 分组可分别预览六段镜头。

另一个终端中执行：

```sh
cd demo
npm run render
npm run verify
```

渲染固定并发为 2；验证顺序执行 FFmpeg。`verify` 会检查编码、尺寸、帧率、900 帧与 30 秒时长，完整解码全部视频，并重新生成两个发布用 PNG 和 `demo/qa/decoded/` 中的过渡检查帧。`qa/` 为本地检查产物，已忽略。可通过 `FFMPEG` 与 `FFPROBE` 环境变量指定工具位置，无需改源码。

## 本次验收

- 固定版本 Remotion 4.0.537；React 19.2.0；Noto Sans SC 5.2.9。
- `npm run typecheck` 通过。
- `npm audit --omit=dev --audit-level=high`：0 vulnerabilities。
- 关键帧渲染已人工查看：六段标题、字体、示意标签与服务商提示无缺字、溢出或重叠。
- Studio 在独立端口启动成功，但内置浏览器连接超时，未声称完成 Studio 可视预览。验收以导出视频的实际解码帧为准。
- `npm run verify` 通过：H.264 / yuv420p / BT.709（limited range），1920 × 1080，30 fps，30 秒，900 帧，无音轨；FFmpeg `-xerror` 全片解码成功。
- 最终六宫格、海报、开场与收尾、五次过渡的两侧抽帧均已查看。大标题无重叠、无缺字，局部面板无溢出。发布 PNG 均来自最终 MP4 解码。
- 后续修改后应重新运行 `npm run verify`，任一步失败都会以非零状态退出；程序化检查不代替人工看图。
