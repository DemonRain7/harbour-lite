# Harbour 公开版介绍视频

30 秒中文介绍，主题是「熟悉的工作台，你自己的 Agent」。视频保留 Harbour 原 Web / Electron 的设计语言，不另造精简客户端。

## 交付与参数

- `docs/media/intro.mp4`：1920 × 1080，30 fps，900 帧，H.264 / yuv420p / BT.709 limited range，CRF 18。
- `docs/media/poster.png`：最终 MP4 第 28 秒的解码帧。
- `docs/media/contact-sheet.png`：最终 MP4 第 2、7、12、17、22、28 秒，按从左至右、从上至下排列。
- `demo/src/`：可编辑 React / TypeScript 场景。
- `demo/scripts/verify-video.mjs`：编码、全片解码及抽帧验证。
- `demo/package-lock.json`：固定依赖版本。

无音乐、无 TTS、无音轨；制作与验证不调用模型、不访问应用服务、不使用外部素材服务。

## 设计依据

只参考当前公开副本的 `web/themes.css`、`web/shell.css`、`web/chat-composer.css` 及相关 `web/styles.css` / 静态结构，不读取任何私有项目或运行记录。

沿用 `anime-wisteria` 的奶油纸 `#FAF3E6`、紫藤墨 `#4A3F5C`、薰衣草 `#8A70E0`、樱粉 `#F08FB0`；保留点阵纸、页边线、手写字标、和纸胶带、缎带页头、不规则卡片圆角。聊天示意采用 216 px 会话列、独立工作区、900 px 上限输入栏及 22 px 输入框圆角。角色位置保留白边拍立得的轻微倾斜漂浮，动画全部由帧数驱动。场景以 0.5 秒纸色过渡衔接，避免相邻标题重影。

Harbour 字标直接使用本仓库 `web/fonts/wordmark/caveat-harbour.woff2`，因此需保留此相对路径。原版权与 SIL OFL 1.1 许可在同目录 `Caveat-OFL.txt`；该字形子集只用于 Harbour 字标。中文由固定版本 `@fontsource/noto-sans-sc` 提供，其字体许可在依赖包 `LICENSE` 中。没有远程字体导入。

没有第三方角色图；角色位置使用源码绘制的中性占位图。没有复制或再分发 Remotion Skill，仅按此前已读的官方指导制作。

## 分镜与表达边界

| 起始时间 | 内容 |
| --- | --- |
| 0 秒 | 保留熟悉的界面，接入自己的 Agent |
| 4 秒 | 自己选择模型，后端配置密钥 |
| 9 秒 | 自己的 Agent / Skill / MCP |
| 14 秒 | 自定义开屏角色图片 |
| 19 秒 | 本地数据与密钥不入 Git |
| 25 秒 | Harbour 字标与品牌收尾 |

所有产品画面均明确标为「界面示意」，不是录屏。模型地址和模型名是占位内容，不表示服务已经连接。角色图只是位置示意，不代表预装角色。所有会话列表均为空，不展示个人历史、账户或真实连接配置。

本片展示产品设计与配置方式，不是端到端功能验收，也不证明公开分支已经完成隐私审计。Git 边界的实际实施与发布前检查由主项目单独验证。画面同时说明模型请求仍会发送给所选服务商；本地保存和 Git 隔离不等于离线推理。

## 复现命令

需要 Node.js 22 或更新的兼容版本，以及 PATH 中的 `ffmpeg` / `ffprobe`。固定 Remotion 4.0.537、React 19.2.0、Noto Sans SC 5.2.9。首次 `npm ci` 和首次渲染可能下载依赖、Chrome Headless Shell；已有依赖与浏览器缓存时不需要远程素材。

在仓库根目录运行：

```sh
cd demo
npm ci
npm run typecheck
npm run studio -- --port=3321
```

Studio 使用 `--no-open`，不会主动打开窗口或抢焦点。访问实际输出的本地 URL，合成名为 `HarbourIntro`，六个场景可在 `Scenes` 单独编辑。如果端口被占用，选择新的空闲端口，不重启其他服务。

另一个终端中：

```sh
cd demo
npm run render
npm run verify
```

渲染并发固定 2。验证以最多 2 个线程顺序执行 FFprobe / FFmpeg，检查编码、尺寸、帧率、BT.709、900 帧、30 秒和无音轨，再以 `-xerror` 全片解码。发布 PNG 从最终 MP4 提取，不使用独立静帧渲染替代。过渡检查帧位于已忽略的 `demo/qa/decoded/`。可用 `FFMPEG` / `FFPROBE` 环境变量指定工具，不需改源码。

## 验收记录

- TypeScript 检查通过。
- 六段关键帧、成片解码联系表、封面、十张过渡两侧解码帧及末帧已查看：字标字体正常，主要文字、输入栏和角色位置无溢出或相互遮挡，纸色过渡没有标题重影。
- 本次内置浏览器不可用；Studio 服务启动成功，但没有声称完成 Studio 可视验收。视觉验收使用实际渲染帧与成片解码帧。
- `npm run verify` 通过：H.264、1920 × 1080、30 fps、yuv420p、BT.709 limited range、30 秒、900 个解码帧、无音轨；`ffmpeg -xerror` 全片解码通过。封面与联系表均已从这份 MP4 解码生成。
