# Harbour 公开版工作约定

本分支是现有 Harbour 的脱敏副本，不是另写一个精简客户端。

- 保留原 Electron / Web 的界面、主题、布局、动效和通用能力框架。
- 只在本目录修改，不改原项目，不读取或迁移它的运行数据与凭据。
- `.env`、data、个人 MASTER / PREFERENCE / MEMORY、聊天、上传、报表、私人能力包不得入库。
- 普通素材按清单保留；第三方资源不得因为在本机可用就宣称可重新授权。
- 用户配置的 Agent、Skill、Workflow、MCP 与框架分离；新 clone 不附带私人任务与能力挂载。
- 本地预览使用独立端口和独立数据目录，不调用付费模型，不连接私人 QQ / Discord。
- 发布前必须审核实际 staged 文件和 Git 历史，不得直接推送来源仓库历史。
- `.claude/` 必须忽略；提交不得添加 Co-Authored-By 或 AI 作者归属。
