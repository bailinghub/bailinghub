# 一个任务，跨轮次累计额度与暂停控制

**状态：未发布的配套联调候选。** 必须同时使用任务控制候选 Core、Agent Client SDK 和 DSH；不能仅凭相同包版本号判断支持，也不能把本文理解为现有线上部署已启用。业务后端的 API、ACC 声明、授权和审批规则不需要为此修改。

例如，用户请助手“整理商城商品，再核对库存”。对话可能持续多轮、切换多个工具、涉及两个系统。管理员可以给这个任务指定原授权集合、精确工具范围、累计最多 20 次写调用、最多 2 个在途派发许可。后续消息、重新搜索工具、重开客户端都不能把任务额度归零。普通聊天不为了恢复任务而创建业务运行。

## 怎么用

1. 客户端先显式固定会话授权范围，并提供每个成员原 Agent Session、接入方、工作区和本地会话 ID。
2. 管理员在 **智能体客户端 → 任务控制** 创建任务，选择相同成员和精确工具名单，设置累计写额度、并发许可数和可选截止时间。
3. 客户端通过 SDK 对全部原成员读取任务，核对 `task_id`、`scope_hash`、成员总数和自己的绑定。宿主把任务关联持久保存，再允许这段会话发起业务操作。任务 ID 不作为模型工具参数。
4. 首次真正使用某个系统时，`startTurn` 携带可信 `task_binding`，Core 在创建业务 run 或装配正文上下文之前核验整个原范围，并将真实 run 固定到该任务。
5. 管理员在同一页面查看累计用量、原调用与运行关联，按需暂停、继续或取消。页面刷新只读，不继续审批后的业务操作。

**启用范围的重要影响：** 创建任务会为每个原 Agent Session 保存持续有效的任务强制标记。之后该授权的其他会话及旧调用入口也不能省略任务绑定。取消任务不删除此标记。第一次联调请使用专门的合成测试授权，先核对全部客户端版本；没有兼容客户端的授权不应提前加入任务。管理员可以明确创建后续任务，但模型和客户端不能为绕开旧额度自动创建新任务。

## 额度到底数什么

| 项目 | 含义 |
|---|---|
| 累计写额度 | 按可信声明中 `readonly=false` 的原工具调用计数；声明幂等的写操作也计入。`null` 不限；`0` 只读。 |
| 已预留 | 等待审批或派发的写调用。结果不明的写操作继续保留预留，不能先释放给下一笔。 |
| 已消耗 | 原调用已经获得可信 HTTP 回执。业务拒绝也计入；它不是业务成功次数。 |
| 在途许可 | 已获得派发许可、尚未结清的读写调用。结果不明时不自动释放。 |
| 并发上限 | 同任务同时在途许可的上限，至少 1；读操作也占在途许可。 |

这不是共享工具频率限流，也不按消息、商品数量、金额或 Token 计数。一次批量接口可能影响多个商品，仍只算一次写调用；业务侧需继续按自身规则确认批量影响。已有工具源、单工具限流及审批仍独立生效，不被任务额度替代。

本批计量范围是经中枢派发的受治理业务工具调用，不包含宿主本地工具、模型推理、附件上传或聊天归档。它不是这些资源的通用配额系统。

## 暂停、继续与不确定结果

- **暂停**：阻止后续派发许可。已获得许可的请求可能完成；暂停不等于撤回请求。
- **继续**：恢复原任务可派发状态，不增加额度、不变更成员，也不会自动执行任何业务调用。审批已通过的操作仍需显式继续原 `invocation_id`。
- **取消**：终止后续派发，不能重新开启，也不会回滚已经发生的业务变化。
- **原成员失效**：任一成员撤销、身份变化或绑定变化，整组阻断；不缩成剩余子集，不换默认授权。
- **结果不明**：只核对原调用。不能换 ID、换授权、重建任务或改用另一个工具重新发出同一写操作。当前候选不会自动向业务系统查询补证，也不自动释放未知许可。

审批单消费、原调用派发标记、任务许可和执行 journal 在同一 MySQL 事务提交；之后才发出 HTTP。可信响应与额度结算也同事务保存。审计降级或传输不确定会保留明确的不确定状态，不能当成业务成功。

## Agent / 宿主接口

全部 Agent 端点仅接受原 Agent Bearer，响应 `Cache-Control: no-store`。

| 接口 | 用途 |
|---|---|
| `GET /agent-api/v1/task-control/capabilities` | 协商 `supported`、`mode=optional/required`、`same_hub_only`、`metering=write_invocation` 和只读核对能力。 |
| `GET /agent-api/v1/tasks/{task_id}?workspace=...&client_conversation_id=...` | 核验整组选定身份，返回当前请求成员和任务共享计数；不返回其他成员身份、凭据、正文或工具结果。 |
| `POST /agent-api/v1/workspaces/{workspace}/turns` | 增量接受下述可信绑定，并在上下文响应顶层原样回显。 |
| `GET /agent-api/v1/tool-invocations/{invocation_id}/receipt` | 只读原记录；管理任务还会重新验证整个原成员集合。 |
| `POST /agent-api/v1/tool-invocations/{invocation_id}/resume` | 可能真正派发原操作，只能作为显式继续，不能当轮询。 |

```json
{
  "task_binding": {
    "schema_version": "bailing.agent-task-binding.v1",
    "task_id": "11111111-1111-4111-8111-111111111111",
    "scope_hash": "<64位十六进制摘要>"
  }
}
```

任务快照 schema 为 `bailing.agent-task.v1`，包括 `state`、控制 `revision`、账本 `ledger_sequence`、`scope_hash`、`member_count`、当前 `member`、`policy`、`counters`。`snapshot_is_dispatch_permission=false`：读取成功不是下一笔派发的许可。SDK/DSH 必须对全部原成员验证，不能只读某一个成员就推断其他成员也可用。

能力搜索不消耗写额度。已加入任务的 Session 在 Runtime 搜索时须携带原 `run_id`；只带裸查询不能绕过任务范围。当前目录仍描述原授权下的能力，任务精确工具名单在执行前再次裁剪和校验；不能把目录存在理解成这项任务一定允许执行。

SDK 增量方法为 `getTaskControlCapabilities`、`getTask` 和 `startTurn(..., { taskBinding })`。DSH 提供宿主 `setSessionTaskBinding/getSessionTaskState/restoreSessionTaskBinding` 及 CAS 存储接缝；精确签名以配套 DSH 的 `docs/TASK_CONTROL.md` 为准。模型不获得管理员 Token、创建任务、改额度或解除暂停的工具。沿用已选授权、跨轮工具缓存和原调用持久 journal；新操作使用本轮真实 run，恢复操作使用原 run / invocation。

本候选限同一 Hub 和同一审计域。不同 Hub 的预算、正文转发和权限不能自动合并。

## 管理接口

仅管理员身份且具备 `clients:read` / `clients:write` 可使用，Agent Bearer 无权创建或控制任务。

| 接口 | 请求/返回 |
|---|---|
| `GET /admin/api/agent-tasks?limit=30&before=...` | `{items,next_cursor}`；按稳定 task ID 降序分页，不是创建时间排序。 |
| `POST /admin/api/agent-tasks` | `{request_id,members,policy}`，返回任务快照。 |
| `GET /admin/api/agent-tasks/{task_id}?limit=30&before=...` | `{task,invocations,next_cursor}`；原调用按稳定 job ID 分页。 |
| `POST /admin/api/agent-tasks/{task_id}/control` | `{request_id,expected_revision,action}`，`action=pause/resume/cancel`，返回快照。 |

`members` 每项为 `{session_id,client_app_id,workspace,client_conversation_id,allowed_tools}`；工具只允许精确名称。`policy` 为 `{max_write_calls,max_concurrent,expires_at}`，截止时间可为 `null`。成员与策略创建后冻结，本候选不支持直接编辑。

创建与控制必须保留同一逻辑请求的 `request_id`，丢失确认时重试原请求。控制使用 CAS；修订冲突先刷新并请操作者重新判断，不能自动换修订号重放操作。后台只展示原关联、状态和计数，任务接口不返回工具参数或业务正文。

## 错误与兼容

`TASK_PAUSED`、`TASK_CANCELLED`、`TASK_EXPIRED`、`TASK_WRITE_BUDGET_EXHAUSTED`、`TASK_CONCURRENCY_EXHAUSTED`、`TASK_TOOL_NOT_ALLOWED` 分别表达具体闸门；`TASK_REQUIRED` 表示不能省略任务。`TASK_SCOPE_BLOCKED` 不允许缩小原范围；绑定、成员和记录错误不能通过猜测坐标修复。

`TASK_DISPATCH_UNCERTAIN` 以及 invoke/resume 的 `TASK_UNAVAILABLE` 由配套 SDK 保守标成原调用结果未知，指导 `inspect_original`，不建议新写。旧 Core 404/405/501 能力协商为明确不支持；网络问题不能冒充“不支持”。旧 SDK/DSH 可继续使用**未加入任务**的授权，但不能执行已强制任务的 Session。

数据库需要既有 `062_agent_task_control.sql` 的六张表，本次接线不增加后续迁移。全未迁移时任务能力不支持；部分表缺失或数据库故障必须阻断，不降级绕过。正式部署需先备份并核对当前数据库、成套候选和宿主兼容性；本地测试通过不代表已经部署。启用任务后不要回退到不认识强制标记的旧 Core，也不要删除标记或任务表作为回滚手段。

Core 的可复现检查：`npm run typecheck`、`npm test`。真实事务/HTTP 验收通过显式 `BAILING_TASK_TEST_MYSQL_CONFIG` 指向专用 loopback 临时数据库，再运行 `src/routes/agent-task-control-http-mysql.test.ts` 与任务仓储的 MySQL 测试。禁止将该测试指向业务数据库。
