# BailingHub v0.5.0：可撤销本地 Agent 授权与受治理本地编排

`v0.5.0` 新增 Agent Auth v1 与 Agent Client Runtime v1，让本地智能体可以承担理解、规划和多步工具选择，同时继续由 BailingHub 负责可撤销业务身份、route 与能力裁剪、审批、幂等、业务调用、恢复、审计和可见会话总账。这是新增的可选接入面，不替代现有 `/run`、聊天入口或执行器协议。

## 主要变化

- **Agent Auth v1**：本地 SDK 使用浏览器、PKCE S256 和锁定的 loopback callback 发起授权；业务系统继续使用自己的登录态、用户/租户/角色与权限表决定是否批准。
- **可撤销 Agent Session**：access token 短期有效，refresh token 逐次轮换，旧 token 重放失败关闭；Core 只持久化 token 的 SHA-256 摘要，并支持用户拒绝、本地撤销和业务后端按 session 撤销。
- **Agent Client Runtime v1**：提供 workspace 发现、受限 bootstrap、turn 快照、授权能力搜索、治理工具调用和可见结果回传。提示词、记忆、知识库与能力配置仍由 Core 统一管理，规划在本地完成。
- **精确能力和审批语义**：有效工作区取接入方、Agent Session、route 受众与 `tools.agent_direct` 的交集。`write_tools` 只精确开放可写 operationId；是否需审批默认继承业务侧 ACC，`force_approval_tools` 只能额外收紧。
- **可见会话与治理轨迹**：本地编排的用户消息、可见最终回复、工具申请与治理结果进入 Core 总账；不接收、不同步、不持久化 hidden reasoning。
- **业务侧 SDK**：PHP 8.1+ 与 PHP 7.3 兼容 SDK 都提供同语义的服务端 `AgentAuth` 薄客户端，用于 context、approve、deny 和 session revoke。非 PHP 系统可直接实现同一 HTTP 契约。
- **控制台配置**：路由页可结构化配置 `tools.agent_direct`，并从选定工具源读取 operationId、scope、只读与 ACC 审批元数据；不允许用 `*` 代替可写工具白名单。

## 安全与责任边界

- 业务授权页属于业务系统。BailingHub SDK 只提供服务端方法，不自动注入通用 UI，也不代替业务登录和最终权限判定。
- Client Token 只交给业务后端；不进入浏览器 JavaScript、URL、本地插件配置、日志或截图。本地 Agent 也不获取 Tool Provider Secret、业务密码、Cookie、业务 API 地址或模型 Key。
- Agent Auth 只绑定可撤销业务身份、设备和 route，不承载套餐、付费、权益或用量语义。
- 工具调用仍由 BailingHub 重验会话和权限面，并经过现有幂等、审批、不确定结果冻结与审计路径；业务工具端点每次仍须验签并查当前权限。
- 本地宿主插件、通用 Agent SDK/MCP 包和模型提供方不包含在 BailingHub Core 制品中，应按各自公开兼容矩阵独立安装。

## 兼容性与升级

- 新增 `055_agent_auth.sql` 和 `056_agent_client_runtime.sql`。升级前备份状态库，升级代码或镜像后运行 `npm run db:init`，确认所有未应用 migration 成功后再启动或切流。不得修改已应用 migration 或从其他实例复制状态库。
- Agent Auth v1 和 Agent Client Runtime v1 是增量接口。原有 `/run`、聊天入口、Client API v1、Kernel Host API v1、Executor Protocol、ACC、票据、工具签名和业务最终授权语义保持兼容。
- 不使用 Agent Client 的部署无需配置授权页或 `tools.agent_direct`；现有聊天入口和执行器继续按原路径运行。
- 早期私有候选的 `unattended_write_tools` 仅保留兼容读取。新配置使用 `force_approval_tools`，迁移时按公开 Runtime 文档的差集规则处理。

## 验证

稳定发布门禁要求完整 `npm run release:check`、类型检查、Core 与 Agent Auth/Runtime 定向测试、控制台构建、数据库迁移、双语文档、OSS 边界、安全扫描、npm 制品一致性，以及从干净宿主安装公开依赖后完成浏览器授权、只读调用、可回滚写入、会话与轨迹回查。发布前还必须检查源码与实际包制品不包含私有域名、本机路径、凭据或本地依赖。

## 相关文档

- [Agent Client v1 接入指南](AGENT_CLIENT_QUICKSTART.md)
- [Agent Auth v1](AGENT_AUTH_API.md)
- [Agent Client Runtime v1](AGENT_CLIENT_RUNTIME_API.md)
- [业务侧 PHP SDK](../sdk/php/README.md) / [PHP 7.3 SDK](../sdk/php7/README.md)
- [兼容性与升级](兼容性与升级.md)
- [English release notes](RELEASE_NOTES_v0.5.0.en.md)
