# Harbour

**给自己的 AI 一个工作台。** 接入你的模型与 Agent，在同一套桌面界面里聊天、查看任务进度、管理工具与资料。

Harbour Lite 是 Harbour 的公开框架版：保留原来的 **Electron / Web 界面、主题、聊天布局和开屏动画**，不附带原用户的账号、记忆、私人角色或能力包。

[![Harbour 介绍片预览，点击打开播放器](docs/media/harbour-story-poster.png)](https://demonrain7.github.io/harbour-lite/)

[▶ 在线观看介绍片](https://demonrain7.github.io/harbour-lite/) · [下载 MP4](https://demonrain7.github.io/harbour-lite/media/harbour-story.mp4) · [制作说明与源码](demo/STORY-NOTES.md)

78 秒 · 1080p · 有声 · 中英双语。播放器在独立展示页打开，不需要登录；点击播放才会出声。视频包含公开界面与演示任务，不代表所有外部服务已经接通。

## 你可以用它做什么

- **聊天与任务**：多会话、独立窗口、附件、执行进度和可恢复的任务记录。
- **自己的助手**：自行配置 Agent 的规则、模型、权限，以及 Skill / Workflow / MCP。
- **自己的外观**：切换主题，更换聊天立绘、头像和开屏角色；展示图片与 Agent 人设分开。
- **按需连接**：模型、语音、音乐、日历等由你选择和配置，没有预装私人账号。

![Harbour 聊天界面](docs/media/original-main-chat.png)

## 让你的 Agent 帮你装好

**复制下面这一行，发给有本地文件和终端能力的编码 Agent**，例如 Codex 或 Claude Code。它会按仓库交接说明安装现有外壳，先运行演示，再协助配置你的模型与助手。

```text
请帮我部署 Harbour 外壳：https://github.com/DemonRain7/harbour-lite 。先读取仓库的 AGENTS.md、README.md 和 docs/AGENT-SETUP.md，按交接说明在独立目录安装，保留原 Electron/Web 界面与开屏动画，不重写 UI、不覆盖我已有的 Harbour 或配置；先验证演示模式，再让我选择自己的模型和 Agent，密钥只在本机配置，不能发进聊天或提交 Git。交接文件不存在时请停止并说明版本不匹配，不要按旧版猜着安装。
```

[查看完整的 Agent 交接 Prompt →](docs/AGENT-SETUP.md) · [自行安装 ↓](#启动)

这是给 Agent 的任务说明，**不是终端命令**。没有本地工具的网页聊天只能指导操作，不能替你安装。

## 启动

推荐 **Node.js 24+、Git**。仅核心 Web / Electron 最低为 Node.js 22.12；Folia 音乐子项目与完整回归需要 Node.js 24+。

以下为 Windows PowerShell 命令，请在新的独立目录安装：

```powershell
git clone https://github.com/DemonRain7/harbour-lite.git
cd harbour-lite
npm ci
if (!(Test-Path .env)) { Copy-Item .env.example .env }
npm run serve
```

打开 **http://127.0.0.1:7799/**。默认 `MOCK_LLM=true`，回答会明确标为演示，不调用付费模型。其他平台的安装与依赖说明见 [Agent 交接文档](docs/AGENT-SETUP.md)。

需要桌面窗口时，另开一个终端，在仓库目录运行：

```powershell
npm --prefix desktop ci
npm run desktop
```

公开版使用独立端口、数据目录和桌面应用标识，不自动迁移旧 Harbour 的数据。当前以源码启动为准，历史 Lite 安装包不代表此版本。

## 配置自己的助手

| 想改什么 | 在哪里改 |
| --- | --- |
| 模型与连接 | 设置页；真实密钥仅保存在本机 `.env`。配置完成后关闭演示模式 |
| Agent 的规则和权限 | Agent 页面，或 `agents/<名称>/CLAUDE.md`；默认只有通用 `main-assistant` |
| 技能、工作流与 MCP | 对应管理页与挂载索引；自行安装，不默认附送私人能力包 |
| 聊天外观 | 原界面的「聊天外观」：更换头像、立绘与背景 |
| 开屏角色 | 复制 `desktop/startup.config.example.json` 为 `desktop/startup.config.json` |

密钥只保存在本机 `.env`；聊天、上传、运行记录与模型配置不入 Git。公开服务需要认证及安全的反向代理，不应裸露管理端口。

## 界面与开屏

原来的手账、星光和放映室配色、字体、图标、侧栏、聊天框、设置页均保留。开屏继续使用原动画。展示图片与角色提示词分离，替换展示图片不会导入原用户的人设、记忆或偏好。

将 `desktop/startup.config.example.json` 复制为 `desktop/startup.config.json`，修改左右两侧的 `file`（PNG / JPEG / WebP，本机路径或相对配置文件的路径）和 `label`。某一侧设为 `false` 即隐藏。图片缺失时保留默认图，不阻塞启动；配置文件不会提交。重启公开版桌面端生效。聊天背景和立绘仍可用原界面的「聊天外观」上传更换。

## 脱敏范围

- 不复制原 `.env`、data、会话、Trace、上传、报表、全局记忆和 Git 历史。
- 不复制私人 Agent、人设、主人档案、偏好、定时任务和 Skill / Workflow 资料包。
- 保留通用代码、主题样式、字体与图标；模型、音乐和本机下载的资源不随仓库附送。
- 保留的角色装饰图只用于展示；不代表附带角色人设、音色或 Live2D 模型授权。

“本机工作台”不等于“完全离线”：连接云模型或第三方服务后，相应请求会发送给你选择的服务商。框架许可证不覆盖第三方素材；Folia、字体、图标、Remotion 与角色素材须分别遵守各自条款。详见 [公开版清单](docs/PUBLIC-EXPORT.md)。

<details>
<summary>开发与验证</summary>

```powershell
npm --prefix vendor/folia ci
npm run audit:public
npm run test:public
npm run test:chat-sessions-ui
npm run test:desktop-refresh
```

`audit:public` 检查导出路径、常见凭据特征与图片元数据，不能替代人工隐私或授权审核。`test:public` 包含类型、隔离配置、开屏、聊天和文档回归；两个桌面测试使用隐藏窗口和模拟服务，不调用真实模型。

启动演示后端后，可用 `npm run test:public-ui` 检查完整界面。介绍页与视频可运行 `npm run test:showcase` 验证。

[本轮同步范围](docs/SYNC-NOTES.md) · [Agent 安装交接](docs/AGENT-SETUP.md) · [介绍片制作说明](demo/STORY-NOTES.md)

</details>
