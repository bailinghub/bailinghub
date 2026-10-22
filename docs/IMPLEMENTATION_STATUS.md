# Core 能力与公开证据索引

[English](IMPLEMENTATION_STATUS.en.md)

本页把 **BailingHub Core 的能力归属、发行状态、公开证据和限制分别列出**，便于评估和复现。源码实现、测试覆盖、正式发行和真实业务采用是不同事实；它们不构成一套从低到高的等级，也不互相替代。本页不是第三方认证、完整安全保证或生产采用证明。

## 版本与阅读口径

- 正式发行基线：[v0.10.0](https://github.com/bailinghub/bailinghub/releases/tag/v0.10.0)，对应 [v0.10.0 源码 Tag](https://github.com/bailinghub/bailinghub/tree/v0.10.0)。下表机制均包含在该版本中，各次修复仍标注首次发行版本；不代表默认安装后已启用所有可选功能。
- 历史基线：[v0.9.0](https://github.com/bailinghub/bailinghub/releases/tag/v0.9.0)，对应提交 [`dae5260ede6565080d21e94ae63d52f3a7d23556`](https://github.com/bailinghub/bailinghub/tree/dae5260ede6565080d21e94ae63d52f3a7d23556)。原 Tag 的异步关闭缺口在后文保留；源码、npm、镜像和具体部署应分别核验，不能从新版文档推导旧制品已修复。
- 表中的测试链接是**公开测试代码及其检查范围**，不是本页重新执行所得的通过记录。单元测试、模拟供应商响应、MySQL 集成测试和完整 demo 验证分别说明各自覆盖的条件。未执行或跳过的测试不能写成已通过，也不能据此把已有机制写成“计划实现”。
- 版本发行内容与升级前提以 [v0.10.0 说明](RELEASE_NOTES_v0.10.0.md) 和 [升级指南](UPGRADE_v0.10.0.md) 为准。适配客户端、应用迁移、模型凭据、存储和具体业务授权仍需各自配置、验证。

## 能力归属与发行状态

Core 默认是一个组织的管理与审计域。不同 Client、route 或工具源不是组织隔离边界。ACC 是独立的能力声明规范；业务系统保留最终身份、权限和业务规则判断。参见 [架构](ARCHITECTURE.md)、[网络契约](CONTRACT.md) 和 [ACC 规范仓库](https://github.com/agent-capability/agent-capability-contract)。

| 能力与责任方 | 发行状态 | 公开实现与证据入口 | 范围与限制 |
|---|---|---|---|
| 能力声明、工具发现、受控调用：Core 解析和治理，业务系统执行 | Core v0.10.0 已包含 | [工具模型](TOOLS_MODEL.md)；[工具索引源码](../src/services/tools-index.ts) / [测试](../src/services/tools-index.test.ts)；[执行治理测试](../src/core/runtime/execution-runtime.test.ts) | 工具可发现不等于当前调用获准。业务接口还需验签，并重新检查主体、租户、权限和业务状态；声明不能赋予调用方原本没有的权力。 |
| Agent Auth：Core 绑定客户端会话，业务授权页提供可信身份 | Core v0.10.0 已包含 | [Agent Auth 契约](AGENT_AUTH_API.md)；[路由源码](../src/routes/agent-auth.ts)；[生命周期 HTTP 测试](../src/routes/agent-auth-lifecycle-http.test.ts) / [竞态测试](../src/infrastructure/config/config-agent-auth-lifecycle-race.test.ts) | PKCE、授权绑定、刷新和撤销有公开实现；不接管业务系统的登录、角色管理或最终授权，也不允许模型从文本指定可信主体。 |
| Agent Client Runtime：Core 提供工作区、turn、搜索和工具调用接口 | Core v0.10.0 已包含 | [Runtime API](AGENT_CLIENT_RUNTIME_API.md)；[运行面源码](../src/app/agent-client-runtime.ts) / [测试](../src/app/agent-client-runtime.test.ts)；[调用测试](../src/app/agent-tool-invocations.test.ts) | 本地 Agent 的模型选择、推理循环和工具编排由客户端宿主负责。Core 的原有 `/run` 管线是另一种公开接入路径，不能把两者混为同一客户端执行模式。 |
| 审批、原调用快照和只读回执：Core 治理，业务系统保留执行结果 | Core v0.10.0 已包含 | [只读回执与恢复](INVOCATION_RECEIPTS.md)；[调用源码](../src/app/agent-tool-invocations.ts) / [测试](../src/app/agent-tool-invocations.test.ts)；[审批账本测试](../src/infrastructure/config/config-approval-ledger.test.ts) | 原调用回执读取与可能继续业务的 resume 分开。未知结果不构成重发写操作的许可；没有历史参数时不能补造。审批本身不证明业务已成功，也不是分布式业务事务的回滚保证。 |
| 跨轮任务控制：Core 持久化原成员、写调用预算与并发占用 | Core v0.10.0 已包含（v0.8.0 引入） | [任务控制契约](AGENT_TASK_CONTROL.md)；[运行面源码](../src/core/runtime/agent-task-control.ts) / [测试](../src/core/runtime/agent-task-control.test.ts)；[MySQL 日志集成测试](../src/infrastructure/config/config-agent-task-control-journal-mysql.test.ts) | 这是受治理业务调用的控制，不是模型轮次套餐。写调用次数不等于退款金额、成功业务数或 Token 数；暂停/取消不能撤回已放行或已完成的业务效果。 |
| 可见对话审计：客户端显式上传，Core 校验成员和保存事件 | Core v0.10.0 已包含 | [对话审计契约](AGENT_CONVERSATION_AUDIT.md)；[运行面测试](../src/core/runtime/agent-conversation-audit.test.ts) | 不采集隐藏推理。确认成员和具备写接口不证明宿主已上传全部历史；审计归档不合并业务授权、会话或运行时记忆。跨绑定仍受同一中枢及各自身份边界约束。 |
| 当前线程上下文和可选滚动摘要：Core 的路由/线程机制 | Core v0.10.0 已包含 | [记忆配置与渲染](../src/core/runtime/memory.ts)；[线程注入源码](../src/core/runtime/memory-runtime.ts) / [测试](../src/core/runtime/memory-runtime.test.ts)；[摘要测试](../src/core/runtime/summary-runtime.test.ts) | 摘要默认关闭，启用后仍按原线程读取。它不是完整的用户级跨新会话长期记忆模块；公开的可见对话审计也不会自动变成模型上下文。 |
| 附件空间：宿主提供获准图片，Core 上传并返回可用 URL | Core v0.10.0 已包含（v0.8.0 引入） | [图片附件契约](GENERATED_ARTIFACTS.md)；[附件源码](../src/app/agent-artifacts.ts) / [测试](../src/app/agent-artifacts.test.ts) | 首期 PNG/JPEG/WebP，不接受文档或视频。存储和保留策略需运营者配置；Core 不能读取客户端文件系统。上传图片与使用 URL 改变业务是两个独立动作。 |
| 可选模型网关与美元额度结算：Core 接入、计量，客户端宿主编排 | Core v0.10.0 已包含 | [模型计费契约](MODEL_BILLING.md)；[网关源码](../src/modules/usage/model-gateway.ts)；[模型网关 MySQL 测试](../src/modules/usage/model-gateway.mysql.test.ts)；[账本单元测试](../src/modules/usage/billing-ledger.test.ts) | 共享 USD 额度、统一倍率、周期售价与额度分离；不恢复按轮次/任务步数收费。参考价格不是供应商实际账单，原始 Token 不是额度分母。未取得权威 usage 的结果不能编造 Token 或费用。 |
| 模型工具目录、文生图和原请求核对：Core 的可选网关扩展 | Core v0.10.0 已包含 | [工具描述源码](../src/modules/usage/model-tools.ts) / [测试](../src/modules/usage/model-tools.test.ts)；[供应商适配测试](../src/modules/usage/model-tool-provider.test.ts)；[异步图片 MySQL 测试](../src/modules/usage/model-tool-gateway.mysql.test.ts) | 公开可执行适配器包括阿里云兼容 Images、原生 DashScope 与 OpenRouter Images。视频、语音或自定义服务的目录声明不等于存在可执行适配器；异步完成与关闭边界见下文。 |
| Kernel Host API、显式迁移和托管生命周期：Core 提供稳定嵌入入口，Host 管理进程与隔离 | Core v0.10.0 已包含 | [Kernel Host API](KERNEL_HOST_API.md)；[Kernel 源码](../src/app/kernel.ts) / [测试](../src/app/kernel.test.ts)；[制品清单测试](../src/kernel-api/v1/artifact.test.ts)；[迁移测试](../src/infrastructure/schema/core-schema-migrator.test.ts) | 独立 MySQL schema 与 runtimeRoot、可信 instanceKey、显式迁移和 Host 的 tick/close 都是前提。此 API 不提供租户注册、平台套餐、集群目录或多副本升级编排；可选 usage 网关也不等于 Host 的平台计费产品。 |
| 安装、体检与可选运维指标：Core 提供入口，部署者配置和验收 | Core v0.10.0 已包含 | [快速开始](QUICKSTART.md)；[安装脚本](../scripts/install.sh)；[体检脚本](../scripts/smoke.ts)；[OpenMetrics 测试](../src/core/observability/openmetrics.test.ts)；[独立复现任务卡](INDEPENDENT_VALIDATION.md) | 健康响应不证明全部业务或供应商可用。指标端点需显式启用并保护访问；有安装/诊断入口不等于已建立持续监控、告警值守或完成特定部署验收。 |

## 公开验证能说明什么

### 单元、模拟与数据库测试

上述测试可用于检查授权、冻结参数、幂等、未知结果、配额和生命周期等机制。带数据库的集成测试需要其公开 fixture 要求的专用测试配置；例如 usage MySQL 测试由 `BAILING_USAGE_TEST_MYSQL=1` 显式启用。只运行默认测试命令而出现 skip，不能据此声称已完成数据库验证。

模拟供应商响应证明适配和协议处理在给定输入下的行为，不证明真实供应商的可用性、价格、模型质量或生产服务表现。包含真实 MySQL 的测试也不自动变成真实业务接入验收。

### 公开 demo 与独立复现任务卡

[Docker Demo](DEMO.md) 与 [独立验证任务卡](INDEPENDENT_VALIDATION.md) 提供从 v0.10.0 安装、基础体检到 `npm run demo:e2e` 的公开路径。其订单、工单、退款和故障工具均为仓库 demo 数据；不需要真实模型 Key、客户接口或生产凭据。

任务卡要求记录服务、控制台、匿名预览边界、基础体检和完整业务闭环的具体结果。README 的 demo 图像与动画展示同一公开样例，不能当作客户采用证据。任务卡存在也不意味着已有外部开发者完成验证；报告结果应保留验证者实际版本、环境、检查项和失败范围。

### 正式 v0.9.0 的异步模型工具关闭限制

v0.9.0 的 [模型工具网关源码](https://github.com/bailinghub/bailinghub/blob/dae5260ede6565080d21e94ae63d52f3a7d23556/src/modules/usage/model-gateway.ts) 先持久化 provider 派发记录，再通过 `void complete().then(...)` 启动后台完成与结算，立即返回原请求状态。[Kernel 的关闭源码](https://github.com/bailinghub/bailinghub/blob/dae5260ede6565080d21e94ae63d52f3a7d23556/src/app/kernel.ts) 显式等待初始化、托管维护、HTTP、InHub、执行队列及资源关闭，但没有把这段 usage 模型工具 continuation 显式登记为独立的 drain 对象。

因此，v0.9.0 中的异步图片请求/原标识恢复测试不能被扩展为“所有 provider 完成都已经纳入 Kernel 关闭验收”。修复之前的公开主分支 [`728899e`](https://github.com/bailinghub/bailinghub/tree/728899e88d89f0ec333684a56640c12154970327) 也有同一源码边界。本页不据此断言已发生数据丢失或重复业务效果。

### Core v0.9.1 的关闭修复与证据范围

Core v0.9.1 增加了每个 `UsageRepository` 独立拥有的 [后台工作登记器](../src/modules/usage/background-work.ts)，并在 [Kernel 关闭路径](../src/app/kernel.ts) 的资源关闭前排空。模型工具完成及其晚登记的结算子工作、普通模型响应后的结算、按流量触发的响应清理/usage 核对，以及参考价格刷新到持久化结束，均有实际登记接线。停止新工作、共享关闭时限和超时后同实例重试语义见 [Kernel Host API](KERNEL_HOST_API.md)。原请求的 HTTP 202 与恢复标识不变；关闭等待不发起新的供应商请求，也不改变业务审批权限。

新增 [登记器单元测试](../src/modules/usage/background-work.test.ts) 检查先登记后启动、动态子工作、维护停止、超时重试、owner 隔离和失败诊断边界；owner 单测不等于实际多 Kernel 验证。[Kernel + MySQL 生命周期测试](../src/app/kernel-usage-lifecycle.mysql.test.ts) 使用实际 Kernel、独立测试 schema 和合成供应商，公开断言覆盖延迟完成/晚登记结算、SQL 锁等待、超时保留资源与同实例重试、两个 Kernel 的原标识/资源隔离、普通文本结果交付后结算仍阻挡关闭，以及 standalone shutdown 排空后退出。响应清理与 usage 核对分别有单独阻挡关闭的用例，参考价格刷新覆盖到持久化及新维护停止；结算失败保留原结果/durable pending、后续核对不重派、诊断不带原错误，以及原请求单次派发/单条结算记录也有断言。数据库入口显式依赖 `BAILING_USAGE_TEST_MYSQL=1`；源码与断言不能代替实际测试结果，也不证明真实供应商、进程崩溃恢复或生产部署已验收。

这项修复从 **Core v0.9.1** 提供，不回写 v0.9.0 Tag 的历史保证，也不证明某个宿主已升级或部署。后台工作失败后可能留下 durable pending/unknown 证据；排空完成不等于每条计费记录必然 settled，更不是完整故障恢复或安全保证。

## v0.9.1 纳入的通用安全治理

与 v0.9.0 相比，v0.9.1 纳入此前主分支新增或调整的 [安全自评](https://github.com/bailinghub/bailinghub/blob/v0.9.1/SECURITY_SELF_ASSESSMENT.md)、[中文安全自评](https://github.com/bailinghub/bailinghub/blob/v0.9.1/SECURITY_SELF_ASSESSMENT.zh-CN.md)、[Security Insights 元数据](https://github.com/bailinghub/bailinghub/blob/v0.9.1/security-insights.yml)、[依赖审计脚本](../scripts/dependency-audit.mjs) 及其 [测试](../scripts/dependency-audit.test.mjs)，以及 CI、依赖更新和包/镜像排除配置。这些是公开仓治理证据，不是新的业务运行面功能，也不是对全部控制通过的声明。自评与安全元数据不进入 npm 运行包和 Docker 构建内容；自评所注明的评估基线保持原样。

版本字段和本页不能替代具体制品校验。评价 npm、镜像或源码 Tag 时，应核验各自提交、制品和验证结果；从 Core 版本也不能推导独立适配层或宿主的发布状态。

## 独立组件与非 Core 范围

- [MCP Server 与 Agent Client SDK](https://github.com/bailinghub/bailinghub-mcp-server)、[DeepSeek Harness 社区插件](https://github.com/bailinghub/bailinghub-dsh-plugin)、[n8n 社区节点](https://github.com/bailinghub/bailinghub-n8n-node) 和 [执行器/OpenClaw 适配](https://github.com/bailinghub/bailinghub-openclaw-skill) 是独立项目或适配层，消费 Core 公共接口。它们有自己的版本、配置和验证，不进入 Core 发行包，也不代表上游认证、背书或采用。
- 本地宿主负责模型循环、客户端凭据保存、界面与获准文件来源；业务系统负责真实执行、权限与业务不变量；独立 Host 负责其平台身份、租户目录、隔离和进程/升级编排。只按 [Agent Client 接入指南](AGENT_CLIENT_QUICKSTART.md) 和 [Kernel Host API](KERNEL_HOST_API.md) 判断接口责任，不从 Core 的测试推导这些外部实现已完成或已部署。
- 完整用户级长期记忆、未具备执行适配器的媒体工具、未经本页所列公开路径验证的真实供应商/业务系统，均不能写成这里的已验证能力。本索引没有为这些范围建立新的产品时间表。

后续修改应同步本页与英文版，保留正式 Tag 与主分支的区别；只有对应的公开证据改变后，才更新具体能力的发行状态或验证范围。

## Core v0.9.2 新增的进程恢复回归

[进程崩溃与确认丢失专项](MODEL_PROCESS_RECOVERY.md)使用实际SIGKILL、不同PID恢复和MySQL COMMIT回包扣留，核原请求、供应商调用次数、结果与美元账本。此为Core v0.9.2中的独立opt-in测试，历史正式v0.9.1 Tag不含新增专项；链接是测试范围，不代表本页重跑、真实供应商或生产崩溃验收。

## Core v0.9.2 的可靠性修复

[安装凭据、结算维护与审批补续](CORE_RELIABILITY.md)记录新安装安全随机源失败关闭、无新流量的结算维护及审批决策的持久补续。配套新增 065/066 增量迁移。公开测试包括[安装器故障回归](../scripts/install-secrets.test.mjs)、[结算 MySQL 回归](../src/modules/usage/billing-reconciliation.mysql.test.ts)、[审批补续回归](../src/app/approval-continuations.test.ts)与[审批 MySQL/进程回归](../src/app/approval-continuations.mysql.test.ts)。这些是Core v0.9.2的实现与检查范围；不扩展历史v0.9.1制品的保证。

## Core v0.9.3 的收包与通知修复

[HTTP 与通知修复](CORE_RELIABILITY.md#core-v093-的-http-与通知修复)汇聚有限收包、UTF-8 视图预算、正常关闭通知排空、原执行器通知死信防重复入队与 067 迁移的公开源码和合成回归入口；[运维指标](OPERATIONS.md)记录只读维护快照边界。这些修改从 Core v0.9.3 提供，历史 v0.9.2 制品不包含；正常关闭和仓储断点测试不证明全部通知意图的崩溃补投或生产送达。Tag、npm、镜像与具体部署仍需分别核验。

## Core v0.9.4 的依赖与通知修复

Core v0.9.4 新增 [DOCX 依赖处置](DOCX_DEPENDENCY.md)与[通知持久化](NOTIFICATION_DURABILITY.md)，包含自带控制台管理入口和增量迁移 068。公开源码和合成测试覆盖内置持久化与恢复，不证明各部署的真实收件；Webhook 接收方按稳定事件 ID 去重，原生未知送达须人工核对。不改变 v0.9.3 的历史证据，独立消费者仍需各自升级。见[升级指南](UPGRADE_v0.9.4.md)。

## Core v0.10.0 的兼容新增与修复

本版新增[Agent 知识按需协议](AGENT_KNOWLEDGE_API.md)、[工具按名指导](AGENT_CLIENT_RUNTIME_API.md)和[显式模型预算](MODEL_OUTPUT_BUDGET.md)，并改善后台首次接入、草稿保护与排障。旧客户端保持 inline、旧模型配置不自动改变，自带聊天装配保持。大参数仍有界、完整审批与原调用防重保留；[宿主续段](MODEL_CONTINUATION.md)由客户端实现，不是中枢新增自动模型循环。只读升级计划与真实资源 readiness 见[升级指南](UPGRADE_v0.10.0.md)，相对 0.9.4 无新增 SQL。
