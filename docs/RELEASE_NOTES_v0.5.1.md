# BailingHub v0.5.1：智能体客户端管理中心与批量写操作配置

`v0.5.1` 是 `v0.5.0` Agent Client v1 的兼容性管理增量。它让部署者能在 BailingHub 控制台集中查看客户端应用、已授权设备与 Agent Session、运行统计和工作区，并为路由批量选择当前工具源声明的可写操作。身份、审批、幂等、业务调用与最终授权仍沿用既有治理链路。

## 主要变化

- **独立管理中心**：控制台新增“智能体客户端”菜单，复用既有 Client App、触发路由、Agent Auth 与 Agent Client Runtime 账本，不新增第二套客户端或执行器资源。
- **应用与工作区概览**：展示客户端启停状态、是否配置统一业务授权入口、允许路由、最近使用时间，以及启用 Agent Client 的工作区。
- **会话列表与撤销**：支持按客户端和 active、expired、revoked 状态查看 Agent Session，并由具备客户端写权限的管理员逐个撤销。撤销操作进入审计记录。
- **运行统计**：按时间窗口聚合运行数、会话数、完成/失败、工具调用、Token 与审批状态。失败率按 Core 已记录的 Agent Run 计算。
- **批量写操作选择**：路由编辑页可选择或清除当前工具源中全部可写 operationId，避免逐项配置大量能力。保存结果仍是精确 operationId 白名单，不支持 `*`。
- **统一业务授权入口**：文档明确每个 Client App 只配置一个账号与租户中立的 `agent_authorize_url`。用户打开该入口后，由业务页面基于当前登录态完成换号、租户选择、批准或拒绝；业务后端负责派生可信身份。

## 安全与责任边界

- 管理 API 只向已有 Core 管理员权限开放。会话投影不选择或返回 access token hash、refresh token、授权码、提示词、工具参数和业务结果。
- 批量选择只减少控制台重复操作，不改变能力声明。未由工具源声明、未进入路由精确白名单或不在 Agent Session 允许范围内的操作仍不可见。
- 是否需要审批继续继承业务侧 ACC 与 Core 风险规则；`force_approval_tools` 只能额外收紧，不能通过批量选择放宽。
- 业务系统仍须在每次工具调用时验签并检查当前用户、租户、角色和权限；BailingHub 管理员不能替代业务最终授权。
- `connectionName` 是宿主本机的连接实例选择器，不是可信身份、业务 URL、账号或租户声明。

## 兼容性与升级

- 没有新增或修改 SQL migration；沿用 `v0.5.0` 已发布的 Agent Auth 与 Agent Client Runtime 表。
- Agent Client Runtime、Client API、Kernel API、业务侧 PHP SDK、Widget、Executor Protocol、工具签名和审批协议保持兼容。
- 新管理中心依赖 MySQL Agent Auth 与 Runtime 账本。没有这些账本的部署不会获得虚构的会话或统计数据。
- 不使用 Agent Client 的部署无需新增配置，既有 `/run`、聊天入口和执行器路径不变。

## 验证

发布候选应完成：

```bash
npm run release:check
```

重点覆盖 Core 类型检查与 612 项单测、管理 API 权限与脱敏投影、会话撤销、批量 operationId 选择、控制台构建和 E2E、Client API 生态消费者、全部 SDK 契约、Docker Demo、OSS 边界、安全扫描、依赖审计、版本一致性和 npm 制品检查。发布前还必须确认公开差异与制品不包含私有域名、凭据、本机路径或环境专属信息。

## 相关文档

- [Agent Client v1 接入指南](AGENT_CLIENT_QUICKSTART.md)
- [Agent Auth v1](AGENT_AUTH_API.md)
- [Agent Client Runtime v1](AGENT_CLIENT_RUNTIME_API.md)
- [兼容性与升级](兼容性与升级.md)
- [English release notes](RELEASE_NOTES_v0.5.1.en.md)
