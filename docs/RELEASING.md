# 发布与隐私检查

这份公开项目使用独立目录和全新 Git 历史。不要把私人仓库的历史、远程配置、旧分支或完整备份推到这个仓库；删除工作区中的文件不能删除旧提交里的内容。

## 发布前

```sh
npm ci
npm run typecheck
npm test
npm run test:ui
npm run build
npm run audit:public
npm audit --audit-level=high
git diff --cached --stat
git diff --cached
```

检查 `git ls-files`，确认没有 `.env`、`data/`、聊天、凭据、本机用户目录、私人人设、私人能力包或未知二进制。不要使用强制添加绕过忽略规则。公开版仅允许仓库明确列出的示例和媒体；增加文件需要同步审查。

截图必须来自空白或合成测试数据；视频、图片还要肉眼检查，文本扫描无法识别像素里的人名或秘密。扫描器不是安全认证，第三方审计仍有价值。

## 视频检查

```sh
npm ci --prefix demo
npm run typecheck --prefix demo
npm run verify --prefix demo
```

`verify` 需要本机 FFmpeg / ffprobe，检查全片可解码并更新来自实际 MP4 的海报与联系表。修改场景后先重新渲染，不要只替换截图。

## 与其他部署互不影响

- 使用独立目录、独立 Git 仓库、独立 `.env` / `data/`。
- 默认端口 7799；桌面端也只使用该端口。浏览器版可用 `HARBOUR_LITE_PORT` 调整。
- 不扫描、导入或迁移其他部署的账号、配置、数据库或浏览器资料。
- 保留 `.claude/`、`.codex/` 等本机工具配置的忽略规则。
- 开发时所有文件操作明确指定当前仓库，不对父目录递归删除或覆盖。

发布标签应在测试和隐私检查全部通过后创建。不要为规避扫描失败而删掉检查规则。
