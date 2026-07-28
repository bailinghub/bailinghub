# BailingHub v0.1.11：副作用执行日志与不确定结果冻结

`v0.1.11` 收紧了 Agent 执行真实业务副作用时的恢复边界：请求外发前必须先写持久化执行日志；当超时、断连、重启或审计失败使业务结果无法确认时，中枢不自动重放，而是冻结为需要人工对账的明确状态。

## 主要变化

### 外发前持久化副作用执行日志

对于非只读、非声明幂等的业务工具，中枢按以下顺序推进：

1. 外发前写入 `dispatching`；
2. 收到 HTTP 响应后写入 `response_recorded`；
3. 结果审计和任务终态账本都成功后写入 `completed`。

持久化执行日志不可用或外发前占位失败时，请求不会发送。运行时不会退回“先执行，成功后再记账”的旧模式。

### 不确定业务结果禁止自动重放

以下场景会收敛到 `reconciliation_required`，并返回 `auto_retry_allowed=false`：

- 请求超时或网络断连；
- 进程重启后遗留未决执行；
- 已收到业务响应，但结果审计失败；
- 响应已记录，但任务终态提交失败；
- 内置消息发送出现文本、卡片或附件部分送达。

恢复任务会在模型再次运行前扫描未决执行日志。同一任务不会依赖模型再次选择相同工具，也不会在无法确认业务后果时自动发出第二次请求。

### 稳定业务幂等键

副作用业务请求新增：

```http
X-Bailing-Idempotency-Key: <stable side-effect key>
```

该键稳定绑定任务、行动主体、工具和规范化参数，便于业务系统去重与人工对账。它不替代：

- `X-Bailing-Signature` 验签；
- 业务系统的最终授权判断；
- 领域自身的幂等规则。

### 内置消息发送纳入同一边界

`send_message` 不再被视为普通内部动作。它使用同一持久化执行日志。只要文本分片、卡片或附件可能已经部分送达，后续失败就会冻结整次发送，不自动重发，避免重复通知。

## 数据库迁移

本版本新增：

```text
sql/052_tool_execution_journal.sql
```

官方 Docker 入口会自动执行迁移。直接从源码运行、使用自定义启动入口或跳过官方 entrypoint 的部署，升级后必须执行：

```bash
npm run db:init
```

迁移把既有工具调用去重账本扩展为可恢复的执行日志，不修改业务系统数据库。

## 兼容性边界

- 只读工具和显式声明幂等的工具行为保持不变；
- Client API、执行器协议、ACC 语义和业务侧最终授权边界不变；
- 副作用工具要求可用的持久化执行日志，缺失时按 fail-closed 拒绝外发；
- BailingHub 不宣称 exactly-once。保守冻结可能包含实际上未到达业务系统的请求，运维仍需结合业务日志和幂等键完成对账；
- 业务系统若尚未消费 `X-Bailing-Idempotency-Key`，现有验签仍可工作，但建议尽快将该键或更强的领域键用于副作用去重。

## 验证

发布前执行：

```bash
npm run typecheck
npm test
npm run web-admin:check
npm run docs:check
npm run examples:check
npm run security:scan
npm run release:check
```

升级后建议确认：

1. `npm run db:init` 完成，迁移账本包含 `052_tool_execution_journal.sql`；
2. `/health/ready` 返回就绪；
3. 副作用调用在外发前产生 `dispatching` 记录；
4. 业务响应、结果审计和任务终态完成后记录进入 `completed`；
5. 模拟超时、重启或审计失败时返回 `reconciliation_required`，且不会自动再次外发；
6. 业务系统可以记录并按 `X-Bailing-Idempotency-Key` 去重。

## 相关文档

- [工具治理设计](TOOLS_DESIGN.md)
- [公开运行时契约](CONTRACT.md)
- [兼容性与升级](兼容性与升级.md)
- [发布记录](CHANGELOG.md)
