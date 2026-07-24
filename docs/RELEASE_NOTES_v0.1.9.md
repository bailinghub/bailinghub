# BailingHub v0.1.9：可选 OpenMetrics 运维指标

`v0.1.9` 为自托管部署增加一个默认关闭、可独立鉴权的 OpenMetrics 端点。它把任务积压、执行器存活、审批等待、租约过期和审计写失败等关键运行状态转成稳定、低基数的机器指标，让部署方能够接入 Prometheus 或兼容采集器，而不必解析日志或读取业务载荷。

## 为什么需要它

日志适合调查单次事件，Trace 适合追踪一条调用链，但生产运维还需要持续回答另一类问题：

- 当前有多少任务排队、运行、等待审批或失败；
- 最老的排队任务已经等待多久；
- 是否存在过期租约、延迟任务或阻塞线程；
- 执行器是否在线；
- 审计写入是否失败；
- 中枢是否暂停，以及指标采集器自身是否健康。

这些信息应当来自状态库和控制面的有界聚合，而不是从日志正文、任务参数或业务数据中推断。

## 主要变化

### 默认关闭并独立鉴权

启用时配置：

```text
BAILING_METRICS_ENABLED=true
BAILING_METRICS_TOKEN=<至少 24 字符的独立随机令牌>
BAILING_METRICS_SCRAPE_TIMEOUT_MS=5000
```

安全语义如下：

- 默认不暴露 `/metrics`；
- 启用后必须使用 `Authorization: Bearer <token>`；
- 不接受 query-string Token；
- 指标 Token 不能与管理根 Token 复用；
- 缺少、过短或复用的 Token 会使配置拒绝启动。

建议生成独立令牌：

```bash
openssl rand -hex 32
```

### 稳定、低基数的指标面

指标只暴露固定状态和有界分类，包括：

- 当前任务状态计数；
- 最近时间窗口内的终态结果；
- 最老排队任务年龄；
- 延迟任务、过期租约和阻塞线程；
- 待审批任务；
- 执行器在线、离线和过期心跳状态；
- 审计写失败；
- 运行时暂停状态；
- 状态库与控制面采集器健康。

指标不会包含任务 ID、租户、主体、路由、参数、提示词、响应正文或业务载荷等高基数或敏感标签。

### 采集故障隔离

状态库和控制面分别在有界超时内采集。任一采集器失败时：

- 其他可用指标继续返回；
- 对应 collector health 指标变为不健康；
- `/metrics` 不伪造缺失业务状态为零；
- 采集失败不会改变任务执行、审批或审计主链路。

### 数据库索引

新增迁移：

```text
sql/050_operational_metrics_indexes.sql
```

迁移只增加任务终态时间窗口和执行器心跳聚合所需索引，不改变现有表字段或业务语义。

官方 Docker 镜像启动时会自动执行 `npm run db:init`。直接从源码运行、使用自定义启动入口或跳过官方 entrypoint 的既有部署，升级后必须先执行：

```bash
npm run db:init
```

## 抓取示例

```bash
curl -fsS \
  -H "Authorization: Bearer $BAILING_METRICS_TOKEN" \
  http://127.0.0.1:18900/metrics
```

不要把指标 Token 写入 URL、公开配置、截图或日志。

## 兼容性边界

- `/metrics` 默认关闭，未启用部署的公开行为不变；
- 不修改 Client API、执行器协议、工具签名、聊天协议或 ACC 语义；
- 新增状态聚合与控制面指标方法均为可选扩展，既有第三方实现可以继续省略；
- 指标用于观测，不构成授权、审批证据或业务系统最终裁决。

## 验证

发布前执行：

```bash
npm run typecheck
npm test
npm run docs:check
npm run security:scan
npm run release:check
```

部署后建议验证：

1. `npm run db:init` 完成且迁移账本包含 `050_operational_metrics_indexes.sql`；
2. `/health/ready` 返回就绪；
3. 未启用时 `/metrics` 不可用；
4. 启用后缺少或使用错误 Token 会被拒绝；
5. 正确 Token 能得到 OpenMetrics 文本；
6. 输出不包含任务 ID、主体、参数或业务载荷。

## 相关文档

- [生产运维](OPERATIONS.md)
- [兼容性与升级](兼容性与升级.md)
- [发布记录](CHANGELOG.md)
