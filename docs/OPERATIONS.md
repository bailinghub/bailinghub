# 生产运维指南

本文面向自托管百灵中枢的运维与平台团队，说明单实例、多副本、健康检查、容量、备份和故障恢复的稳定做法。快速体验请先看 [DEMO.md](DEMO.md)，首次部署请看 [QUICKSTART.md](QUICKSTART.md)。

## 1. 推荐拓扑

### 单实例

适合开发、试点和低流量内部场景：

```text
业务系统 / 渠道
       |
  HTTPS 反向代理
       |
  BailingHub x 1
       |
     MySQL
```

任务、租约、审批、限流和审计均落 MySQL。进程内 `Queue` 只限制当前实例的并发数，不承担持久化排队。

### 多副本

适合需要滚动发布或实例故障自动接管的部署：

```text
业务系统 / 渠道
       |
  负载均衡 / Ingress
       |
  +----+----+
  |         |
 Hub A     Hub B
  |         |
  +----+----+
       |
   共享 MySQL
       |
  共享对象存储（推荐）
```

所有副本必须：

- 使用同一套 MySQL 数据库和服务端安全配置。
- 使用一致的构建版本和数据库迁移版本。
- 通过数据库 claim/lease 认领任务；同一任务只会被一个副本成功认领。
- 多副本时使用共享对象存储。服务器本地媒体存储只适合单实例，因为另一个副本无法读取本机文件。
- 网页聊天的增量事件默认使用进程内短期回放窗口。多副本时应让同一 `job_id` 的创建请求和 SSE 连接命中同一副本，或注入共享 `JobStreamBroker`；否则最终 `done` 仍可从 MySQL 返回，但可能看不到逐段文本。
- 由负载均衡检查 `/health/ready`，滚动发布前先摘流量，再等待优雅停机完成。

## 2. 健康检查

| 端点 | 用途 | 失败意味着什么 |
|---|---|---|
| `GET /health` | liveness，确认进程仍在响应 | 进程应重启 |
| `GET /health/ready` | readiness，确认 MySQL 可达且迁移齐全 | 暂时不要把新流量发给该实例 |

readiness 不检查模型、工具源、渠道等外部业务依赖。某个模型服务波动不应导致整个中枢实例被负载均衡摘除；这些依赖由控制台“系统体检”和告警规则持续检查。

`/health` 的 `observability.audit_write_failures` 是当前进程累计的审计写入失败数，`last_audit_failure_at` 是最后失败时间。数值大于 0 时应立即检索运行日志中的结构化事件 `audit_write_failed` 并检查数据库；该计数随进程重启归零，不替代外部监控。安全关键审计仍然 fail-closed，允许 best-effort 的运行事件即使被调用方降级，也会先经过该统一观测层。

Kubernetes 建议：

```yaml
livenessProbe:
  httpGet: { path: /health, port: 18900 }
readinessProbe:
  httpGet: { path: /health/ready, port: 18900 }
```

## 3. OpenMetrics 运维指标

`GET /metrics` 提供适合 Prometheus 等监控系统抓取的低基数 OpenMetrics 文本。该端点默认关闭；关闭时返回 404，避免未配置的部署意外暴露运行状态。

启用方式：

```bash
BAILING_METRICS_ENABLED=true
BAILING_METRICS_TOKEN="$(openssl rand -hex 32)"
BAILING_METRICS_SCRAPE_TIMEOUT_MS=5000
```

`BAILING_METRICS_TOKEN` 必须是至少 24 个字符的独立强随机 Token，不能与 `BAILING_TOKEN` 相同。Token 只通过 `Authorization: Bearer ...` 请求头传递，不支持 query 参数。建议只允许监控网络访问 `/metrics`，并继续使用 HTTPS 或集群内受控网络。

验证抓取：

```bash
curl -fsS \
  -H "Authorization: Bearer ${BAILING_METRICS_TOKEN}" \
  https://hub.example.com/metrics
```

Prometheus 示例：

```yaml
scrape_configs:
  - job_name: bailinghub
    metrics_path: /metrics
    authorization:
      type: Bearer
      credentials_file: /etc/prometheus/secrets/bailinghub_metrics_token
    static_configs:
      - targets: ["bailinghub:18900"]
```

主要指标：

| 指标 | 含义 |
|---|---|
| `bailinghub_info` | 当前版本与构建提交 |
| `bailinghub_up` | 指标端点本次是否正常响应 |
| `bailinghub_runtime_paused` | 全局暂停开关是否生效 |
| `bailinghub_runtime_queue` | 当前进程内 running / waiting 数 |
| `bailinghub_job_records` | 按固定生命周期状态统计的任务存量 |
| `bailinghub_jobs_terminal_15m` | 最近 15 分钟进入终态的任务数 |
| `bailinghub_queue_oldest_queued_age_seconds` | 最老非 monitor 排队任务的等待秒数 |
| `bailinghub_queue_delayed_jobs` | `run_after` 尚未到期的延迟任务数 |
| `bailinghub_jobs_expired_leases` | 已明确过期的运行/派发租约数 |
| `bailinghub_threads_blocked` | 被同线程在途任务阻塞的会话线程数 |
| `bailinghub_approvals_pending` | 待决策的工具审批数 |
| `bailinghub_executors` | 按 online / offline 统计的执行器数 |
| `bailinghub_audit_write_failures_total` | 当前进程累计审计写入失败数 |
| `bailinghub_background_work_in_flight` / `bailinghub_background_work_oldest_pending_age_seconds` | 按固定 source / kind 统计已接纳的后台工作及最老在途年龄 |
| `bailinghub_background_work_finished_total` | 当前 owner 的 continuation 完成/失败数，按固定 outcome 区分 |
| `bailinghub_background_work_last_run_timestamp_seconds` / `bailinghub_background_work_last_run_age_seconds` | 最近 started / completed / failed 时间及距今秒数；从未观察到时 timestamp=0，age 不输出 |
| `bailinghub_background_draining` / `bailinghub_background_drain_timeouts_total` | Usage/通知 tracker 的关闭排空状态及耗尽预算的 drain 调用次数 |
| `bailinghub_maintenance_last_page_records` / `bailinghub_maintenance_last_page_has_more` | 当前/最近一页 usage、审批续执行处理进度；usage 达到固定扫描页大小时 has_more=1 |
| `bailinghub_usage_maintenance_consecutive_failures` / `bailinghub_usage_maintenance_retry_after_seconds` | Usage 核对的有界连续失败数和退避剩余秒数 |
| `bailinghub_metrics_collector_available` | 状态库/控制面采集器是否实现 |
| `bailinghub_metrics_collector_success` | 对应采集器在本次抓取中是否成功 |
| `bailinghub_metrics_scrape_duration_seconds` | 本次聚合和渲染耗时 |

指标标签是固定、低基数集合，不包含 `job_id`、租户、主体、路由参数或业务载荷。单个可选采集器超时或失败时，端点仍返回其余指标，并把对应 `bailinghub_metrics_collector_success` 置为 0；日志只记录采集器类别和失败类型，不记录异常正文或业务数据。JSONL 状态后端可提供任务指标，但没有 MySQL 控制面聚合时，`control_plane` 会标记为不可用。

`maintenance` 采集器读取当前 owner 的维护内存快照，并对通知 outbox 读取只读聚合；不返回通知正文、不触发核对或模型请求。固定 source 为 `usage`、`notification`、`approval`；kind 只包含现有模型完成、结算、响应清理、usage 核对、价格刷新、回调、通知送达、审批通知、告警、送达 DLQ 和审批续执行。工作完成数统计 Promise/continuation 的终态，不等于接收方确认送达次数；一轮审批核对可完成但保留失败记录，应同时看 last_page 的 `failed`。进程/owner 重建会重置这些计数。last_page 不是数据库里 pending/unknown 的总数或最老年龄，`has_more=1` 也不是精确积压量；不可用的可选模块不输出伪造零数据。

建议至少告警：

- 任一已启用采集器的 `bailinghub_metrics_collector_success == 0`。
- `bailinghub_jobs_expired_leases > 0`。
- `bailinghub_queue_oldest_queued_age_seconds` 持续超过本业务的最大等待目标。
- `bailinghub_audit_write_failures_total` 增长。
- `bailinghub_background_work_finished_total{outcome="failed"}` 或 drain timeout 增长，后台在途年龄持续超出关闭/任务目标；使用最近运行 age 和 last_page 失败数判断维护是否持续推进。
- 预期在线的执行器进入 `offline`，或近期错误/拒绝终态占比异常升高。

指标是外部监控输入，不替代 `/health/ready`、业务系统最终授权、审计账本或控制台诊断。

## 4. 并发与连接池

- `concurrency` 控制单实例同时执行的任务数。
- `BAILING_MYSQL_CONNECTION_LIMIT` 控制每个实例的 MySQL 连接池上限，默认 15。
- 总连接预算约为：`中枢副本数 × 每副本连接池上限 + 运维/迁移连接`。
- 不要直接用“HTTP QPS”估算容量。任务时长、模型延迟、工具调用次数和 SSE 连接时长都会改变容量。
- 反向代理必须禁止 SSE 响应缓冲，并将读取超时设为大于单次聊天最长等待时间。中枢会返回 `X-Accel-Buffering: no`，但 CDN/Ingress 仍需独立核对。

扩容前先记录：

- 排队任务数和最老任务等待时间。
- 任务成功率、P95/P99 总耗时。
- 工具调用失败率和耗时。
- MySQL 活跃连接、慢查询和锁等待。
- CPU、内存和事件循环延迟。

当 CPU 仍有余量但任务持续排队，可增加副本或并发；当 MySQL 已成为瓶颈，应先处理索引、慢查询和连接预算，盲目加副本会让数据库更慢。

项目不会宣称未经目标机器、模型和业务接口实测的固定 QPS。发布容量承诺前，应使用自己的任务分布进行压测。

### 工具语义检索运行保护

工具语义检索是一项可选的上下文增强。索引存储或查询向量服务超时时，本轮会改用渐进式工具发现，而不是让会话无限等待召回结果。可通过部署环境变量调整两个独立时限：

进程启动后会在后台按工具源顺序预热已持久化索引，HTTP 就绪不等待预热。内存缓存过期时仍继续服务旧快照，并在后台单飞刷新；只有真正的冷缓存才会在下述索引时限内等待。

| 变量 | 默认值 | 允许范围 | 用途 |
|---|---:|---:|---|
| `BAILING_TOOL_INDEX_LOAD_TIMEOUT_MS` | 5000 ms | 100–60000 ms | 限制读取工具向量及其 embedding 凭证元数据的单次数据库等待时间 |
| `BAILING_TOOL_QUERY_EMBEDDING_TIMEOUT_MS` | 15000 ms | 250–120000 ms | 限制为当前查询生成向量的等待时间 |

这些是单个中枢部署的基础设施保护，不是路由或工具提供方的业务策略，因此对当前进程的所有工具语义检索生效。改小前应根据本部署的正常延迟分布验证；改大会延长外部依赖异常时的会话等待。

新增的分阶段诊断事件会记录缓存状态、索引/凭证/查询向量耗时及稳定原因码，但不携带用户查询、服务地址或凭证。诊断写入是 best-effort，不会反过来阻塞检索降级。

## 5. 发布与升级

1. 按[兼容性与升级](兼容性与升级.md)及目标版本指南核对源/目标制品和 state/configuration 存储；可先生成[只读升级计划](UPGRADE_PLAN.md)。
2. 在一个非生产环境运行 `npm run release:check`，验证升级及一致性备份恢复。
3. 停止所有共享存储的实例和其他写入者接收新工作，完成排空并保存一致性备份，再对每个不同的数据库运行一次目标版本迁移；账本位于 `bz_schema_migrations`。未经单独验证，不假定在线迁移或新旧版本混跑安全。
4. 启动新实例并等待 `/health/ready` 返回 200。
5. 逐个替换旧实例，观察队列、错误率和租约恢复。
6. 确认无异常后再清理旧镜像。

不要在多副本上同时并发运行迁移。数据库迁移应由一个部署步骤负责，应用副本只负责启动和 readiness 检查。

## 6. 备份与恢复

至少备份：

- MySQL 全库，包括配置、任务、审批、审计和迁移账本。
- 对象存储中的聊天媒体和知识库原文件。
- 部署环境变量和外部密钥的安全副本。

推荐使用 MySQL 一致性快照或 `mysqldump --single-transaction`，并定期做恢复演练。没有验证过恢复流程的备份不能视为可用备份。

恢复顺序：

1. 停止所有中枢副本和其他共享存储写入者接收新工作，确认后台 SQL、审批及通知等工作已经排空；仅摘除入口流量不等于停止写入。
2. 恢复 MySQL 与共享对象存储。
3. 使用与备份迁移版本兼容的中枢镜像启动一个实例。
4. 检查 `/health/ready`、系统体检和关键任务 trace。
5. 再逐步恢复其余副本和流量。

## 7. 故障语义

- 实例在任务执行中崩溃：数据库 lease 到期后由 reaper 恢复，任务不会依赖进程内队列保存。
- executor 回报暂时失败：执行器重试；最终未回报的任务由 lease 恢复。
- 审批等待：审批意图在数据库中持久化，不依赖实例内存。
- 外部工具或模型失败：任务记录错误与 trace，是否重试由路由和错误类型决定。
- 审计写入失败：安全关键工具调用按 fail-closed 处理；非关键运行事件不阻塞业务，但应进入运维告警与指标。
- 正常关闭：Kernel 按同一关闭预算等待已接受的回调、送达派生、审批通知、告警和 DLQ 插入，再释放数据库/渠道资源；排空超时保留资源，宿主可在工作完成后重试 `close()`。后台失败日志只报告固定工作类别。
- 送达死信重投：内置渠道继续通过渠道凭证发送；自定义 `X-notify` 死信只重排原失败通知子任务，回复 `queued` 表示已进入执行器队列。永久 DLQ 重投标记与原子入队一起保存，重复请求或 resolve 回包丢失不会重复入队，业务父任务不会重跑。旧死信按原 Job 验证承接器，绑定不符返回 409，旧扩展缺少重投端口返回 503；人工可检查原通知子任务。
- 历史 v0.9.3 的排空不提供 SIGKILL 后的全量通知 outbox。Core v0.9.4 增加[通知持久化](NOTIFICATION_DURABILITY.md)和 068 迁移：新终态/审批创建与意图同事务，重启仅补通知；普通告警及旧扩展保留尽力发送边界。接收方仍需按事件 ID 去重，部分或未知送达不能盲目重发。

### Standalone 启动恢复关闭屏障（未发布候选）

本候选新增的关闭屏障尚不包含在已发布的 Core v0.9.4 中。启动恢复未触发时取消定时器；已经触发时，`kernel.close(drainMs)` 等待目标刷新、恢复查询、审计及重新排队完成。出现 `boot recovery drain timed out` 时，Kernel 保留资源并停止接收新工作；宿主应排查数据库锁等待等阻塞，随后在**同一个 Kernel 实例**重试 `close()`，不要强关连接池绕过屏障。

此重试能力属于 Kernel API。默认 CLI 的信号停机失败会以状态码 1 退出，不提供自动重试；重复调用 `server.shutdown()` 也不等于重试 Kernel 关闭。该屏障不承诺抵抗强制退出，也不替代持久恢复和业务结果核对。

## 8. 安全基线

- 仅通过 HTTPS 暴露公网入口。
- 管理端、接入方、执行器和工具源使用不同凭证，不复用密钥。
- 指标端点使用独立 `BAILING_METRICS_TOKEN`，不得与管理根密钥复用。
- MySQL 不直接暴露公网。
- 无人值守部署应成对设置 `BAILING_BOOTSTRAP_ADMIN_USERNAME` 与 `BAILING_BOOTSTRAP_ADMIN_PASSWORD`。它们只负责空管理员表的首次创建，不是持续同步配置；修改或轮换密码应走控制台或显式 `admin:create`，不要依赖重启。
- 定期轮换管理员、接入方、执行器和工具签名密钥。
- 生产关闭 demo 默认凭证，限制控制台来源和数据库账号权限。
- 日志、错误响应和监控标签不得包含 API key、数据库密码或完整业务敏感载荷。

## 9. 上线检查单

- `/health` 返回 200。
- `/health/ready` 返回 200，迁移 pending 为 0。
- 如启用运维指标，使用监控专用 Token 抓取 `/metrics` 成功，两个采集器状态符合部署后端预期。
- 控制台系统体检没有配置错误或过期租约。
- 至少跑通一次真实 `/run`、工具调用、trace 和结果回传。
- 已验证备份可恢复。
- 已设置队列积压、错误率、executor 离线和送达死信告警。

### Core v0.9.4 的持久通知指标

`bailinghub_notification_outbox_available{source}` 表示内置持久端口可用性；`bailinghub_notification_outbox_records{source,status}` 为各状态数量；`bailinghub_notification_outbox_oldest_pending_age_seconds{source}` 和 `bailinghub_notification_outbox_expired_leases{source}` 为最老待处理年龄及过期领取数。source 固定为 `jobs` / `approvals`。这些聚合从持久仓储读取，区别于重启后归零的后台 Promise 计数；旧扩展缺少能力时只输出 available=0，不捏造 backlog=0。查询失败沿用采集失败/超时状态，不触发补发。
