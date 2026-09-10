# 让智能体先理解业务系统

[English](AGENT_SYSTEM_INFO.en.md) | 简体中文

同一会话连接多个系统时，智能体需要先知道每个系统通常负责什么，才能决定向哪个目标查找工具。例如 Helpdesk 处理客服工单，Inventory 管理库存；两个系统都可以有“查询记录”，但用途不同。

系统说明由中枢管理员在“智能体客户端 → 接入配置”中点击应用行的“配置接入”，进入“系统说明”步骤维护，仍保存在对应业务路由上。用户自己的授权名称或门店名称只是展示标签，不能替代系统身份。读取说明只需要当前 Agent Session 与已选业务路由，不需要先创建业务运行或发送对话正文。

需要从开启接入一路配置到工具范围时，先看[本地智能体集中配置指南](LOCAL_AGENT_SETUP.md)。同一 workspace 的接入方共享这里的说明；同系统多账户无需各写一份产品介绍。

## 管理员填写什么

先在面板中选择工作空间，再填写系统名称、一句话介绍、典型业务方向和系统边界，然后保存工作空间。不配置说明时继续使用既有授权与工具流程。配置对应路由的 `agent_client.system_info`：

```json
{
  "name": "Helpdesk",
  "summary": "管理客服工单，协助查询处理进度并准备回复。",
  "domains": ["工单查询", "客服回复准备"],
  "boundaries": ["库存调整由库存系统处理。"]
}
```

| 字段 | 约束 |
| --- | --- |
| `name` | 非空，最多 120 字符 |
| `summary` | 非空，最多 400 字符 |
| `domains` | 数组，最多 6 项，每项非空且最多 120 字符；可为空数组 |
| `boundaries` | 数组，最多 6 项，每项非空且最多 160 字符；可为空数组 |

这四项是产品定位数据，不是额外的模型系统指令。文本字段和每个列表项均使用单行，不包含控制字符。不要填入凭据、业务原文、内部接口地址或权限绕过要求。服务端拒绝未声明字段与超长内容，读取时不会从 `target_config.system_prompt`、路由名称、授权名称或业务工具结果猜补说明。

配置沿用已有 `agent_client` JSON 存储，不需要增加数据库表或迁移。

## 宿主读取契约

```http
GET /agent-api/v1/workspaces/helpdesk/system-info
Authorization: Bearer <Agent access token>
```

接口仅返回请求中这个路由的说明。服务端重新检查当前 Client、原 Agent Session、双方的路由授权以及路由 audience；撤销或越权仍返回 401/403。已停用或不存在的路由返回 404 `route_unavailable`。不遍历其他路由，也不加载工具目录、知识、记忆或业务上下文，不创建 run，不执行业务工具，不读取请求正文。

```json
{
  "schema_version": "bailing.agent-system-info.v1",
  "binding": {
    "client_app_id": "helpdesk-client",
    "session_id": "123e4567-e89b-42d3-a456-426614174000",
    "workspace": "helpdesk"
  },
  "metadata_status": "configured",
  "revision": "<sha256>",
  "system": {
    "name": "Helpdesk",
    "summary": "管理客服工单，协助查询处理进度并准备回复。",
    "domains": ["工单查询", "客服回复准备"],
    "boundaries": ["库存调整由库存系统处理。"]
  },
  "tool_status": "not_loaded",
  "availability": "unknown"
}
```

`revision` 是规范化说明内容和 schema 的 SHA-256；它标识说明的变化，不替代固定授权身份或工具能力修订。响应使用 `Cache-Control: no-store`。

以下状态必须分开理解：

- `system` 说明产品通常做什么，不证明当前授权可以调用所有相关能力。
- `metadata_status=missing` 表示没有有效说明，`system` 与 `revision` 均为 `null`，不表示没有业务工具。
- `tool_status=not_loaded` 表示尚未加载工具，不表示工具数量为零。
- `availability=unknown` 表示本接口没有验证业务服务是否可用。关闭 Runtime 或工具直调时返回 `unavailable`，并使用 `unavailable_reason=agent_client_disabled` 或 `agent_direct_disabled` 表明配置状态。说明仍可读取；工具调用继续服从原开关和权限。

客户端只为本会话明确选定的目标读取说明，并核验返回的 `binding` 与原 Agent Session / Client / workspace 一致，再关联到本地原 `authorization_ref` 和 `system_ref`。单授权、同系统多授权、跨系统授权使用相同的数据结构。不可把未选目标的说明注入模型，也不可因说明更新扩大固定会话范围。

旧 Core 对未知此端点返回 404 `not_found`，宿主可报告说明功能不支持；缺失说明也可显示“系统用途未知”，或使用按受控原绑定关联的本地词典。401/403、`route_unavailable` 与暂时网络故障不能伪装为旧版本不支持。说明功能的降级不替代原授权校验，也不触发默认授权切换。

## 控制台集中配置接口

控制台可使用 `GET /admin/api/routes/:route_key/agent-setup` 读取路由的授权客户端设置、说明、工具源与直调设置。返回仅包含 `route_key`、`name`、`enabled`、`permission`、`revision`、`agent_client`、`tool_sources`、`agent_direct`，不返回路由 `target_config` 或工具源凭据。`permission` 只读；例如 `readonly` 提醒管理员原路由仍不允许写入，不能在此 PUT 中改动。

`PUT` 同一路径只接收四个字段：

```json
{
  "expected_revision": "<GET 返回的 revision>",
  "agent_client": { "enabled": true, "system_info": { "name": "Helpdesk", "summary": "客服工单管理", "domains": [], "boundaries": [] } },
  "tool_sources": [{ "provider": "helpdesk", "allow": ["ticket.read"], "subject_field": "operator_id" }],
  "agent_direct": { "enabled": true }
}
```

`agent_client` 与 `agent_direct` 可以显式设为 `null` 来清除；空 `tool_sources` 数组清除工具源选择。编辑界面应保留已有的 `instructions`、`active_tool_limit` 和工具源配置，避免因只填写说明而意外删掉它们。

GET 需要 `routes:read`；PUT 需要 `routes:write`，接入方管理权限不能替代路由权限。保存时仍使用既有路由、工具、精确写操作与审批配置校验。数据库事务锁定并比较当前完整路由修订，冲突返回 409 `agent_setup_conflict`；成功只更新 `agent_client`、`tools` 与更新时间，其他配置保持原值。

旧宿主仓储没有实现可选的 `compareAndSetAgentSetup` 时，读取仍可使用，保存返回 503 `agent_setup_unsupported`，不会退回整行覆盖。成功保存返回与 GET 相同的投影及新修订。该配置接口不改变业务 API、审批规则、会话固定范围或归档行为。
