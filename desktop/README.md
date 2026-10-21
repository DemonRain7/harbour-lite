# Harbour 桌面端

这里保留原 Electron 客户端与原 Web 界面，不另做 Lite 设计。界面、主题、布局、悬浮助手和动画代码均沿用原实现；账号、人物设定和私人资源不附送。

## 源码启动

先按根 README 启动后端，再执行：

```powershell
npm --prefix desktop ci
node desktop/node_modules/electron/install.js
npm run desktop
```

默认连接 `http://127.0.0.1:7799/`。可复制 `config.example.json` 为本机 `config.json` 配置服务地址和令牌。远程客户端不需要复制服务端密钥。

公开版使用独立的 `HarbourPublic` 用户目录，不自动导入旧 Harbour 配置。启动时默认不开 Live2D；模型不随仓库附送，也不自动下载。

## 自定义开屏角色

复制 `startup.config.example.json` 为 `startup.config.json`，将左右 `file` 改成自己的 PNG / JPEG / WebP 文件，`label` 改为显示名。文件可相对配置目录，也可使用绝对路径。某一侧设为 `false` 可隐藏；图片无效时保留默认图，不阻塞启动。

动画沿用原来的淡入、呼吸和界面衔接。图片配置不修改 Agent 的提示词、记忆和权限。私人的配置文件被 Git 忽略。

## 可选模块与验收范围

音乐保留 Folia 源码与原界面。完整构建需要 Node.js 24+，执行 `npm run folia:prepare` 准备资源；账号与曲库由用户自行连接。当前公开副本未完成 Folia 打包及跨平台安装包验收。

本机已检查原 Web 聊天 / 设置布局和隐藏窗口开屏动画；不代表真实云服务、TTS、音乐账号、Live2D 或全部桌面功能已接通。

第三方许可见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)；公开分发前仍需审核保留的角色装饰图。
