# Agent 完整对话审计 v1

[English protocol and examples](AGENT_CONVERSATION_AUDIT.en.md)

> 本页保留既有 v1 协议，并记录**尚未发布的跨系统成员绑定候选增量**。
> v2 仅是显式创建请求的 schema，不改变现有 v1 创建、事件、会话头或管理员响应 schema，
> 也不表示已发布版本已经支持跨系统会话。

本接口归档本地智能体与用户之间的**可见对话**，将每轮沟通关联到各授权独立的 run。
它不合并 Agent Session、业务身份、thread、记忆、工具授权、审批或 invocation，也不上传隐藏推理。
正文单独写入 `bz_agent_conversation_events`，不写入各门店的 `bz_messages` 或模型记忆。

部署方需要按自己的 Core 升级流程显式应用新增迁移 `sql/057_agent_conversation_audit.sql`；
运行时启动不会自动迁移。旧宿主可以不提供可选的 `ConfigStore.agentConversationAudit`，此时写入和管理员读取接口明确返回不可用。

## v1 创建与逐成员确认

所有写接口继续使用现有 Agent access bearer 鉴权，Token 不进入归档 DTO。
v1 成员仍限定在同一个 Client App 和同一个 route；不能用 v1 请求取得跨系统或跨路由范围。

`POST /agent-api/v1/conversation-audits` 请求字段：

| 字段 | 约定 |
| --- | --- |
| `client_archive_id` | 宿主持久保存的随机 UUID。 |
| `client_conversation_id` | 与原 startTurn 相同的客户端稳定会话 ID。 |
| `route` | 当前已授权的工作区路由。 |
| `member_session_ids` | 冻结的 1–64 个 Agent Session UUID，创建者必须在内。 |
| `member_labels` | 可选的 session UUID → 显示名称映射，每个名称最多 128 字符；不能用于身份或权限判断。 |

创建幂等键为 `creator_session_id + route + client_archive_id`，重试时完整冻结输入必须相同；
成员、标签或原会话 ID 改变均返回 `409`，不能修改原归档。
客户端会话 ID 本身不是归属证明，不同创建者不会因为它相同而自动合并。

创建者通过创建请求确认本人。其他成员分别用**自己的 bearer**调用
`POST /agent-api/v1/conversation-audits/:id/confirm`，请求体为 `{}`，不能在 body 中代填另一个身份。
创建和确认均返回 `schema: bailing.agent-conversation-audit.v1` 及下文会话头。
全部成员确认前 `state=enrolling`，完成后为 `ready`；每次写入仍会重新校验授权有效性。
`ready` 只表示成员确认完成，不表示授权永久有效，也不表示全部可见历史已经上传或完整性已核验。

只有创建者可以追加正文。只知道归档 UUID 或客户端会话字符串的人无法确认成员、写入或读取正文，
因此无需另发 enrollment secret。正文写事务会锁定归档、client、route 和成员 Session，
复核所有成员未撤销、refresh 生命周期有效、原主体快照未改变，且 client/session 的路由白名单交集、
路由启用和 audience 仍允许访问。access token 刷新可以沿用同一 Session，替换身份不能替换旧成员。

## 未发布候选：跨系统成员绑定

### 先探测能力

`GET /agent-api/v1/conversation-audits/capabilities` 使用现有
`Authorization: Bearer <Agent access token>` 鉴权，响应带 `Cache-Control: no-store`：

```json
{
  "schema": "bailing.agent-conversation-audit-capabilities.v1",
  "cross_binding_members": true,
  "member_bindings": "session-client-route.v1"
}
```

这只是能力元数据，不返回会话正文、成员列表、账户名称、Session 标识、凭据或工具数据。
未提供归档仓储、旧 Host 未实现可选的 `createCrossBinding` / `supportsCrossBindingMembers` 方法，
或 Core 状态库缺少 058 的任一新增列时，`cross_binding_members` 为 `false`。
探测失败不是支持证明；旧 Core 对此 GET 返回 `404` 时，客户端必须拒绝跨绑定使用，
不能试发正文，也不能把跨绑定请求降级成 v1。已有同绑定 v1 功能仍按原协议判断和使用。
`false` 响应中的 `member_bindings` 字符串本身不表示功能已启用。

### 显式 v2 创建

SDK 在发送前先验证全部所选连接来自**同一 Hub**，并逐一核对各自的授权状态、App 与 route。
不同系统通过该 Hub 中各自独立的 Agent Session 接入；Hub 相同不意味着可以跨 Host 租户数据域拼接仓储或查询。
确认能力后，向同一个 `POST /agent-api/v1/conversation-audits` 发送：

```json
{
  "schema": "bailing.agent-conversation-audit-create.v2",
  "client_archive_id": "323e4567-e89b-42d3-a456-426614174001",
  "client_conversation_id": "conversation-stable-id",
  "members": [
    {"session_id":"123e4567-e89b-42d3-a456-426614174001","client_app_id":"crm-demo","route":"customers","label":"CRM 账户"},
    {"session_id":"123e4567-e89b-42d3-a456-426614174002","client_app_id":"erp-demo","route":"orders","label":"ERP 账户"}
  ]
}
```

`members` 为 1–64 项；每项必填 `session_id`、`client_app_id`、`route`，只有 `label` 可选。
App ID 和 route 均遵守小写资源 key 规则 `^[a-z0-9][a-z0-9_-]{1,63}$`；route 不能是 `auto`。
label 最多 128 字符，只作显示。每个 Session 只能出现一次并绑定一个 route；即使该 Session
获准访问多个 route，也不能在同一归档中重复声明。需要另一目标时使用独立授权 Session。
v2 不接受顶层 `route`、`member_session_ids` 或 `member_labels` 混搭。

创建 bearer 对应的成员就是 **writer（创建者）**，必须包含在 members 中并匹配其 App；
writer 不是排序后的首项。成员排序只用于确定性校验。幂等键仍为
`creator_session_id + writer route + client_archive_id`，完整冻结输入必须相同；不能通过重试修改成员绑定。
返回的会话头 `client_app_id` / `route_key` **只描述 writer**，不能当作全组唯一系统或公共授权。
例如，上例若由 ERP 成员的 bearer 创建，writer 就是 ERP 成员，会话头为 `erp-demo` / `orders`。

v2 创建时校验全部成员各自的 Session/App/route。创建请求只确认 writer；其他成员仍分别用
**自己的 bearer** 和 `{}` 调用原 confirm 接口，不能由 writer 代替确认。
确认及每批事件追加都会重新校验整组成员，各成员已确认的身份快照不能改变。
任何所选成员撤销、refresh 生命周期失效、主体变化或路由权限失效，整组写入被拒绝；
不得静默移除该成员、改用其他账户或只保存剩余组的正文。
只有 writer 可以追加事件；每条 run_link 按其 `member_session_id` 核对该成员自己的
App、route 和原 run 的 conversation/turn，不按 writer 的 App/route 推断归属。
成员之间的业务权限、审批、invocation 和原 trace 链保持独立。

### Host 与迁移

跨绑定候选另需显式应用 `sql/058_agent_conversation_member_bindings.sql`。
058 只增加归档 `membership_version` 和成员 `client_app_id` / `route_key` / `client_name` 列；
原 057 文件保持不变，不移动 Session、run、invocation 或正文，也不改写既有身份和正文内容。旧记录保持 v1，成员新增列为 NULL。
仅应用 057 的部署可继续使用 v1，不能宣告跨绑定支持。
Host 必须将官方 SQL 包含在自己的发行产物中，再按既有迁移流程显式执行 migrate；
升级运行时代码或启动服务不会自动迁移。各 Host 继续使用自己的状态库和租户边界，不得跨租户拼库。

## 追加可见事件

`POST /agent-api/v1/conversation-audits/:id/events` 接收 `{ "events": [...] }`。
所有事件都有 `event_id`、`sequence`、`client_turn_id`、`kind`：

| kind | 额外必填字段 | 含义 |
| --- | --- | --- |
| `turn_start` | 无 | 开始一轮宿主对话。 |
| `user_message` | `content` | 原始可见用户文本，可记录同轮追问。 |
| `assistant_message` | `content` | 原始可见助手文本，可记录同轮多条公开回复。 |
| `run_link` | `run_id`, `member_session_id` | 关联某个冻结授权的原始 run。 |
| `turn_end` | `status` | `completed`、`failed` 或 `cancelled`。 |

未声明字段和事件种类一律拒绝，不接受任意 metadata、隐藏推理、凭据或工具参数字段。
文本保留原始字符，不静默改写或截断；宿主负责只提交用户实际可见的文本，服务端无法凭正文判断是否真实展示过。

sequence 从 1 开始严格连续，每批有序、原子写入。
相同 sequence、event_id 和正文的重试成功；内容冲突、复用 ID、序号缺口或轮次冲突返回 `409`，整批不落库。
普通消息及 turn_end 必须属于当前正在进行的轮次。
异步返回的 run_link 可以追加到已经开始、完成或取消的原轮次，但不能重开它，也不能改变更新轮次的状态。

run 关联必须匹配数据库中的原 Session、client、route、client_conversation_id、client_turn_id；
thread_id 由服务端获取。一个 run 最多属于一个完整对话归档，避免旧执行记录的返回链接产生歧义。
关联关系不赋予执行、重试、审批或跨授权记忆读取权限。

成功响应为 `{ "schema": "bailing.agent-conversation-audit-ack.v1", "conversation_id": "<UUID>", "last_sequence": 5 }`。
宿主应先持久保存归档 UUID、创建者及成员绑定、事件 ID、事件顺序和确认游标，再宣称归档成功。
ACK 丢失可原样重试。恢复归档队列不等于恢复 invocation 执行状态，也不能续执行未知调用 ID。
补传不会重执行业务操作；同步 ACK 仅确认已接收的事件游标，不能掩盖本地未保存事件或旧历史缺口。

## 管理员分页读取

没有 Agent 正文读取接口；除上述仅返回元数据的 capabilities GET 外，其他 Agent 归档 GET 请求均返回 `404`。
以下接口仅供已有 `runs:read` 权限的管理员，响应设置 `Cache-Control: no-store`。
宿主继续负责其租户数据域隔离，不能因为字符串相同而跨租户合并数据库查询。

`GET /admin/api/conversation-audits?limit=50&offset=0` 返回 schema
`bailing.agent-conversation-audit-list.v1`、`items`、`has_more`、`next_offset`。
会话头字段为 conversation_id、client_archive_id、client_conversation_id、client_app_id、route_key、
state、member_count、confirmed_count、last_sequence、message_count、turn_count、last_turn_status、created_at、updated_at。
末轮状态初始为 null，之后是 running/completed/failed/cancelled。sequence 统计所有事件，不能当成消息数。

`GET /admin/api/conversation-audits/:id?after_sequence=0&limit=100` 返回 schema
`bailing.agent-conversation-audit-detail.v1`、`conversation`、`members`、`events`、has_more、next_after_sequence。
成员包含 session_id/display_label/confirmed；确认后有冻结的 principal/on_behalf_of。
跨绑定候选的成员视图可选增加 `client_app_id`、`client_name`、`route_key`，管理员响应仍为 v1。
client_name 是显示快照，不能作身份依据。旧 v1 响应可缺少这些字段，旧数据库 NULL 也不是成员系统的证明；
界面如回退会话头，必须标注“旧记录：仅有归档头部信息”，不能冒充逐成员绑定证据。
事件包含提交的可见字段、服务端 created_at，run_link 还有数值 thread_id。
按 next_after_sequence 继续读后页，不受原 thread 前 1000 条消息限制。

旧管理员 agent-run trace 的 run、通过归属复核的工具 job trace 的 job，可选增加
conversation_audit_id 和 client_turn_id，用于返回完整对话。
原 thread/run/client/session/route 轨迹校验继续保留。

## 限额与失败语义

成员上限 64；每批 1–50 个事件；单条文本最多 64,000 个 UTF-16 code units；
每批 UTF-8 正文最多 256 KiB，HTTP JSON 最多 2 MiB；
每个归档最多 20,000 个事件、16 MiB 正文。列表每页上限 100，事件每页上限 200。
达到上限明确拒绝，不能把截断文本宣称为完整归档。

| HTTP | error | 含义 |
| --- | --- | --- |
| 400 | `invalid_request` | DTO 字段无效或未声明。 |
| 401 | `unauthorized` | 原 Agent bearer 鉴权失败。 |
| 403 | `conversation_audit_authorization_invalid` | 冻结授权或路由已失效。 |
| 404 | `conversation_audit_not_found` | 不存在或不属于当前身份，统一隐藏成员枚举信息。 |
| 409 | `conversation_audit_not_ready` | 成员未全部确认，不接收正文。 |
| 409 | `conversation_audit_conflict` | 成员、幂等内容、序号、轮次或 run 关联冲突。 |
| 413 | `conversation_audit_limit` | 超限，整批未落库。 |
| 503 | `conversation_audit_unavailable` | 可选归档仓储未提供。 |
| 503 | `conversation_audit_cross_binding_unavailable` | 未发布 v2 创建候选所需方法或迁移未就绪。 |
| 500 | `conversation_audit_internal_error` | 内部失败，不返回原始数据库或异常详情。 |

旧 Core 未提供接口时也可能返回 `404`，适配器必须显示不支持归档。
业务执行成功与归档成功分别报告，不能因为前者成功而掩盖正文上传失败。
