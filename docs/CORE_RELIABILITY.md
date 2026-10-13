# 安装凭据、结算维护与审批补续

[English](CORE_RELIABILITY.en.md)

本页描述 Core 0.9.2 的修复及检查范围。历史 v0.9.1 Tag、npm 包和安装镜像不包含这些后续修改；具体部署需核对其源码与迁移账本。

## 安装凭据

新建 `.env` 时，安装器为六项凭据分别调用 `openssl rand -base64 24`。每次输出必须是 32 个合法 Base64 字符，生产者必须成功退出。缺少安全随机源、执行失败或输出不合法时停止安装，不生成半份 `.env`，不启动服务。不以时间戳或摘要替代随机源。

已有 `.env` 继续保留，重启和升级不因此覆盖运营者修改的管理员密码。生成失败时不回显生产者输出；运营者需安装可用的 OpenSSL 后重试。

运行 `npm run installer:secrets:test` 可检查正常生成、故障退出、错误输出、后续凭据生成失败和已有配置保留。这些测试使用合成命令与临时目录，不安装真实服务。

## 异步结算自动推进

standalone 启动后即安排一次维护，以后每分钟安排一次；managed Kernel 在新实例的首个既有 `tick` 上启动，以后由同一 tick 推进周期维护。managed 模式仍由 Host 调用 tick，不新建每个 Kernel 的独立定时器。HTTP 请求保留同一维护入口作为补充，恢复结算不依赖新流量。

维护只读取原请求已保存的计量、参考价格和统一倍率，不读取生成结果正文，不调用供应商，不重新派发模型。每页最多 50 条，以 `(updated_at, id)` 游标前进并在末尾回绕；无法计价或单条损坏的记录不会一直占据首批而阻塞后面的记录。缺少可靠计量的记录继续保留 pending/unknown，不猜测为零费用。

同一 usage owner 的维护合并为一次进行中的工作，不同 owner 独立。数据库故障采用一分钟起、最多五分钟的退避；成功后恢复正常周期。`getReconciliationProgress()` 只提供最近一页的 scanned、settled、deferred、failed、hasMore，不是全库待结算总数，也不包含请求结果、标识或凭据。

维护纳入既有后台工作登记器和 Kernel 关闭等待。standalone 先停止新的维护，再排空已开始的写账；超时保留同实例的待完成工作以供重试，不能将超时当作关库许可。

## 审批决策与补续

外部回调和控制台将审批决策及不可变的补续坐标放在同一事务中保存。补续绑定原 approval、job、request、args hash 与决策标识。审计或排队失败后，使用原 `decision_id` 重试可以补续；后台维护也会检查尚未完成的补续，按审批标识分页推进并回绕，避免在途或异常记录阻塞后续审批。已保存决策但补续失败时返回 `503` 与 `decision_recorded=true / continuation_pending=true`，不得另造一条审批。

原任务入队与独立的审批决策标记由状态仓储原子写入，并在入队临界区重新核对审批是否已消费。入队成功但确认丢失时，重试、进程重开和新一轮任务完成都不会再因同一决策入队。普通任务更新不能清掉此标记。原任务仍在途时等待后续维护，实际执行沿用既有暂停、路由和工具治理。

拒绝的审批只补审计。Agent 直调保持手动模式：批准不启动中枢模型循环，仍由原本地 Agent 使用原 `invocation_id` 显式续执行。已经消费的审批和没有新补续记录的历史决策不被自动回填或重排。

审计追加成功后确认丢失，可能再次出现同一观察，`detail.continuation_id` 可识别这类重复。入队去重不等于跨业务系统恰好执行一次；业务方仍需保持自己的幂等和最终授权。JSONL 的顺序写入适用于一个 writer，不支持多个进程共同写同一文件。

## 迁移与适配边界

- `065_usage_reconciliation_scan.sql`：新增待结算分页索引，不重算历史费用。
- `066_approval_continuations.sql`：新增补续表及 `bz_jobs.approval_continuation_keys`，不改变旧决策或客户业务数据。

沿用 `npm run db:init` 或 Kernel 的显式官方迁移入口，运行时不自动迁移。使用新审批决策入口前必须应用 066；事务写入补续失败会回滚决策，不能留下仅决策成功的孤立记录。升级时协调旧写入，保留备份，并在启用新入口前确认迁移和配套 state/config 仓储就绪。

自定义仓储需配套实现可选的 continuation ledger 方法与 `RuntimeStateStore.requeueApprovedJobOnce`。未实现时新决策明确 unavailable，不退回不能恢复的旧排队方式。这些接口属于 Core；独立 Host 的平台身份、租户升级编排，以及客户端的模型循环和长期记忆均由各自项目维护。

新增结构是增量迁移，回退代码不应删除补续表或标记。回退到旧代码后，本页的补续保证不再适用；先协调停止决策和任务写入，核对已保存的决策、队列与标记，不能清标记后重投来代替恢复。

## 回归入口与限制

默认 `npm test` 包含结算分页、维护、审批补续、状态更新和关闭单测。真实 MySQL 专项使用独立随机 schema 与合成供应商：

```bash
BAILING_USAGE_TEST_MYSQL=1 BAILING_APPROVAL_CONTINUATION_TEST_MYSQL=1 \
node --import tsx --test --test-concurrency=4 \
  'src/modules/usage/*.test.ts' src/app/kernel-usage-lifecycle.mysql.test.ts \
  src/app/approval-continuations.mysql.test.ts
```

数据库 fixture 需要本机 `127.0.0.1:16307` 的专用 MySQL、root 空密码及创建/删除测试库权限，禁止指向共享或生产数据库。审批专项含实际子进程 SIGKILL、不同 PID 恢复、COMMIT 确认丢失、并发补续和缺迁移回滚。测试证明给定 fixture 的机制；不证明真实供应商、物理断电持久性或生产业务已验收。跳过的数据库测试不计为通过。

公开实现和测试入口见[能力与证据索引](IMPLEMENTATION_STATUS.md)。
