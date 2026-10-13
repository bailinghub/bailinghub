# Core v0.9.2 补丁升级指南

[English](UPGRADE_v0.9.2.en.md)

从公开 Core 0.9.1 升级到 0.9.2，修复安装凭据、异步结算维护与审批补续，并取得只读部署诊断和进程恢复回归。MCP / Agent Client SDK 与 DSH 继续使用 0.7.0。升级仅涉及 Core；其他组件按各自项目核对和发布。

## 先保留数据，协调写入

备份目标数据库，保留配置与凭据、附件存储、原请求及审批记录、旧制品和宿主持久记录。停止新工作并协调所有共用状态库的写入方；核对原在途请求与已经保存的决策，再排空和关闭实例。保留原 `operation_id`、`invocation_id` 与审批 `decision_id`，不以新请求代替恢复。

0.9.1 的 usage 关闭等待继续有效。0.9.2 新增维护写账也纳入关闭等待；超时后在同一实例等待和重试，不据此强行关库或重新派发。

## 选择制品并显式迁移

使用正式 `v0.9.2` 源码、npm 包或镜像，核对版本、来源 Tag/提交与制品摘要。安装器和预构建镜像 Compose 默认版本同步为 0.9.2；已有 `.env` 不覆盖。新建配置需要可用的 OpenSSL，随机生成失败时先修复环境再重试。

通过官方迁移器应用全部未执行文件，源码安装入口为：

```bash
npm run db:init
```

嵌入式宿主使用官方 `migrateBailingHubCoreSchema` 显式入口，并重新核对 `BAILINGHUB_CORE_ARTIFACT_V1` 完整制品 manifest。运行时启动不自动迁移。已记账的迁移由迁移器跳过，不手工改写历史 SQL 或迁移账本。

| 相对 0.9.1 新增迁移 | 作用 |
| --- | --- |
| `065_usage_reconciliation_scan.sql` | 添加 `(billing_state, updated_at, id)` 分页索引，不重算历史费用 |
| `066_approval_continuations.sql` | 添加补续表和 `bz_jobs.approval_continuation_keys`，保存原决策补续及持久入队标记，不回填历史决策 |

启用新审批入口前必须应用 066。补续事务写入失败会回滚决策，不能留下仅决策成功的孤立记录。更早版本还须应用全部缺少的前序迁移，模型计费升级另见 [0.9.0 指南](UPGRADE_v0.9.0.md)。

## 仓储和调用方配套

官方 MySQL/JSONL state 仓储与配置审批 ledger 一起升级。JSONL 的顺序写入仅支持一个 writer；不能用多个进程共同写同一文件。自定义配置仓储需提供 `decideWithContinuation`、`getContinuation`、`pendingContinuations`、`markContinuationAuditRecorded`、`completeContinuation`，自定义状态仓储需提供 `RuntimeStateStore.requeueApprovedJobOnce` 及配套原子语义。缺少支持时新决策返回 `approval_continuations_unavailable`，不回退旧入队路径。

外部审批同一决策重试使用原 `decision_id`；`503` 的 `decision_recorded=true / continuation_pending=true` 表示决策已保存，补续待恢复。控制台重试原审批单。历史决策没有新补续记录时不自动回填；已消费审批不重排。Agent 直调仍由本地 Agent 使用原 `invocation_id` 显式 resume，批准不启动 Core 模型循环。

managed 宿主继续公平调用既有 `tick()`，首个 tick 和后续每分钟维护推进待结算与审批补续；standalone 自行安排这些维护。无需为每个 Kernel 增加独立定时器。暂停、路由、工具权限与业务最终授权仍由原契约控制。

## 升级后如何确认

1. 核对新制品身份、目标库的迁移账本和 065/066 实际结构；检查 `/health`、控制台与既有业务 smoke。
2. 使用只读部署诊断核对公开身份和 readiness；退出码与未检查范围须一起读取：

   ```bash
   npm run --silent doctor -- --deployment --url http://127.0.0.1:18900 --readiness --json
   ```

   默认诊断只读取健康与版本；`--readiness` 会让服务端只读访问数据库及迁移账本。诊断不会确认镜像 digest、完整数据库身份或执行升级，详见[诊断文档](DEPLOYMENT_DIAGNOSTICS.md)。
3. 在专用测试环境保留一笔可计价的原 pending 请求，停止新流量，确认维护后原账本结算且没有第二次供应商派发；无法可靠计价的原记录仍为 pending/unknown。核对统一美元额度与倍率，不把结果 complete 等同于已 settled。
4. 在专用测试环境核对批准后审计或入队暂时失败，重试原决策或等待维护能继续原任务；入队确认丢失、重开或审批已消费后不会重复入队。Agent 直调仍等待显式续执行。审计确认丢失可产生同 `detail.continuation_id` 的重复观察，不等于第二次队列准入。
5. 停止时确认维护被排空。超时保留同实例的工作与依赖，等待后重试；不删账本、不清标记、不换调用 ID。

隔离回归命令见 [Core 可靠性修复](CORE_RELIABILITY.md#回归入口与限制)；实际 `SIGKILL` 与 COMMIT 确认丢失专项见 [模型进程恢复](MODEL_PROCESS_RECOVERY.md)。这些用例使用专用测试库和合成供应商，跳过不计为通过，也不替代目标部署或真实业务验收。

## 回退边界

065/066 是增量结构。代码回退保留补续表、`approval_continuation_keys`、原请求与账本；不要删除标记后重投审批。回退到 0.9.1 会失去本版自动维护、持久补续与入队去重保证。先停止决策和任务写入，核对已保存决策、队列、标记及在途工作，再评估兼容性和回退。

恢复旧备份仍需核对备份之后的请求、扣费和外部业务效果。队列去重不保证外部业务恰好一次，备份恢复不撤销已经发生的业务动作。业务方继续维护幂等与最终权限。

[版本说明](RELEASE_NOTES_v0.9.2.md) · [可靠性契约](CORE_RELIABILITY.md) · [兼容策略](兼容性与升级.md)
