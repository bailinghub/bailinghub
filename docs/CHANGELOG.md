# 百灵中枢 · 发布记录

> 这份文档从首个公开版本开始记录对外可见的版本变化。
> 当前版本的完整能力与对接方式，以 `README.md`、`docs/CONTRACT.md`、`docs/第三方对接指南.md` 为准。

## 记录规则

每个公开版本至少说明：

- **新增能力**：新增的端点、控制台能力、工具注解、SDK 能力；
- **对接影响**：业务侧是否需要调整请求、回调、验签、OpenAPI 注解或控制台配置；
- **数据库结构**：是否新增表、字段、索引；
- **验证方式**：部署方如何确认该版本运行正常；
- **相关文档**：对应的契约、指南或示例。

## Unreleased

当前暂无已承诺但未发布的公开变更。

## v0.1.4 - 网页聊天真实流式输出与可重连 SSE

发布日期：2026-07-20。

- **网页聊天真实增量输出**：`llm` 目标可通过 OpenAI-compatible `stream:true` 持续输出文本增量，网页组件在任务完成前就能展示回答。
- **可重连 SSE 协议**：新增 `bailing.chat.stream.v1` 的 `phase/reset/delta` 事件、单任务单调序号、`Last-Event-ID` 回放和有界短期缓冲。
- **权威结果边界**：增量文本只是临时传输数据，不逐片写入会话、回调或审计正文；`done` 始终从任务库最终结果生成。
- **提供商降级与观测**：仅当提供商明确表示不支持 streaming 时重试一次非流式请求；trace 只记录分片数、字符数和首段延迟等元数据，不记录逐片正文。
- **对接影响**：旧客户端可忽略新事件并继续仅消费 `done`；路由可在 `target_config` 设置 `streaming:false` 关闭模型流式请求。不需要数据库迁移。
- **验证方式**：`npm run typecheck`、`npm test`、`npm --prefix web-admin run build`、`npm run docs:check`。
- **相关文档**：[RELEASE_NOTES_v0.1.4.md](RELEASE_NOTES_v0.1.4.md)、[STREAMING.md](STREAMING.md)、[CONTRACT.md](CONTRACT.md)、[OPERATIONS.md](OPERATIONS.md)。

## v0.1.3 - 便携式执行器接入与 OpenClaw 适配

发布日期：2026-07-17。

- **便携式接入 Skill**：新增 `connect-bailinghub-executor`，把安装判断、令牌安全、通用命令包装、OpenClaw 配方、直连协议和成功验收条件收敛成可下载、可复用的 Agent Skill。
- **控制台短引导**：路由页复制内容改为最小启动信息，只传中枢地址、目标名、路由上下文和 Skill 地址；执行器读取 Skill 后自行完成环境确认，避免在聊天中复制长篇协议或泄露令牌。
- **OpenClaw stdio 适配**：新增零依赖 `openclaw-stdio.mjs`，将百灵任务映射为 OpenClaw 本地 agent 调用，保持会话关联，并只把最终文本写入 stdout。
- **执行器安全与存活语义**：通用执行器优先从 `BAILING_EXECUTOR_TOKEN` 读取令牌，保留 `--token` 兼容；独立心跳覆盖长任务执行期；结果回报携带 `claim_token`，供中枢拒绝重排后的迟到结果。
- **对接影响**：不新增数据库迁移，不改变 `/run`、SDK、签名格式或现有执行器 HTTP 端点。既有 `--token` 命令继续可用，推荐迁移到本地环境变量或密钥管理器。
- **验证方式**：`npm run typecheck`、`npm test`、`npm --prefix web-admin run build`、`npm run release:check`，并完成 OpenClaw 代表性端到端验证。
- **相关文档**：[RELEASE_NOTES_v0.1.3.md](RELEASE_NOTES_v0.1.3.md)、[QUICKSTART.md](QUICKSTART.md)、[第三方对接指南.md](第三方对接指南.md)、[INTEGRATION.en.md](INTEGRATION.en.md)。

## v0.1.2 - 服务端根 token 与派生凭证安全加固

发布日期：2026-07-17。

- **移除固定密钥回退**：任务级 `tool_token`、任务回调和告警 webhook 不再回退到公开字面量；缺少根 token 时相关签名路径 fail-closed。
- **收紧启动边界**：只有 `development` 且监听回环地址时允许无 token 本地开发；生产模式或非回环监听必须提供至少 24 字符、非公开占位值的 `BAILING_TOKEN`。
- **收紧 Compose 默认值**：源码与镜像 Compose 文件不再内置可预测的管理 token；文档要求首次启动生成随机值，一键安装脚本继续自动生成并保存随机密钥。
- **纵深防御**：无 token 的开发管理员回退同样限制在本机回环模式；安全扫描新增固定 fallback 与 Compose 可预测 token 检查。
- **对接影响**：公开 HTTP、SDK、签名格式和数据库结构不变。升级生产或对外监听部署前必须设置强 `BAILING_TOKEN`；本机回环开发保持零配置兼容。
- **验证方式**：`npm run typecheck`、`npm test`、`npm run security:scan`、`npm run release:check`。
- **相关文档**：[RELEASE_NOTES_v0.1.2.md](RELEASE_NOTES_v0.1.2.md)、[SECURITY.md](../SECURITY.md)、[QUICKSTART.md](QUICKSTART.md)。

## v0.1.1 - 聊天组件运营控制与接入边界修复

发布日期：2026-07-13。

- **聊天组件运营控制**：聊天入口列表支持一键暂停/恢复；停用后已嵌入脚本静默隐藏整个组件，公开配置返回结构化停用状态，消息、历史、上传和评价端点继续服务端拒绝。
- **品牌文案控制**：外观配置新增底部品牌标识显示开关与自定义文案；老入口默认继续显示当前中枢品牌，不改变既有页面效果。
- **OpenAPI 编译 fail-closed**：`parameters[].in` 仅支持 `query`、`path`、`header`；`cookie`、未知或缺失位置会产生稳定 error diagnostic 并跳过整个 operation。ACC `timeout_ms` 保持严格整数类型，字符串数字会明确报错并提示去掉引号。
- **分发与社区入口**：应用镜像同步发布到阿里云 ACR 和 GHCR；GitHub 主线与 release tag 自动镜像到 Gitee；README 图片兼容 GitHub/Gitee；新增社区衍生与生态合作原则。
- **对接影响**：现有聊天入口与品牌标识默认行为不变；品牌配置复用 `appearance` JSON，不新增数据库迁移；其余公开 HTTP 契约、SDK 与签名格式保持兼容。
- **验证方式**：`npm run typecheck`、`npm test`、`npm --prefix web-admin run build`、`npm run release:check`。
- **相关文档**：[RELEASE_NOTES_v0.1.1.md](RELEASE_NOTES_v0.1.1.md)、[CHANNELS.md](CHANNELS.md)、[CONTRACT.md](CONTRACT.md)。

## v0.1.0 - 首个公开版本候选

首个公开版本采用 `v0.1.0`。该版本定位为公开预览：核心架构、接入契约、工具治理、审计追溯、Docker demo 和多语言 SDK 已形成可验证闭环，适合开发者评估、自托管试用和接入真实业务系统做小范围试点；后续版本会继续补齐生态适配、MCP 双向能力、更多语言 SDK 和生产运维模板。

该版本不是完整托管平台承诺。生产使用前，部署方仍需完成凭证轮换、域名/证书、备份、监控、密钥管理、数据库容量规划和内部审批流程接入。

当前首版能力包含：

- **生产配置安全线**：`BAILING_ENV=production` 下，服务 token、MySQL 口令、模型 API key、执行器 token、告警 webhook 等敏感项必须通过环境变量或密钥管理器注入。
- **集中限速账本**：MySQL 后端下，接入方限速、聊天入口 IP 限速、后台登录防爆破、工具源/工具级限速统一使用 `bz_rate_limits`。
- **DB 调度队列**：executor 与 inhub/llm 都从 `bz_jobs` 队列原子认领；`run_after` 固化重试退避与延迟认领语义，`claimed_at/lease_until` 固化 job 租约，claim 层保证同 thread 串行和队头顺序。
- **配置契约**：`schemas/config/*.schema.json` 提供 route、target、tool provider、credential、channel、alert rule、storage bucket、client、executor token、chat entry、page context 的机器可读配置模型，并通过 `GET /schemas/config/<name>.schema.json` 对外提供；后台保存链路通过 `route-config` 与 `config-models` 统一执行保存前校验和规范化。
- **配置仓储与运行期账本边界**：路由、接入方、凭证、渠道、工具源、管理员、项目、执行器令牌、执行目标、存储桶、告警规则和聊天入口均有独立 repository；限速、审批、对话总账、执行器心跳、工具幂等、送达死信和可观测查询均有独立 ledger，运行时模块通过显式依赖访问各自边界，`configstore` 只作为组合根与共享连接池入口。
- **HTTP 与运行期边界**：`server.ts` 只负责 URL 构造、公开入口分发、受控入口分发和进程监听；`routes/public` 承接 health/version/schema、官网/控制台壳、SDK 下载、widget 和网页聊天入口；`routes/private` 承接平台签名入口、审批回调、登录态、工具 token、admin/executor/client API 网关；`runtime.ts` 创建共享单例；`runtime-lifecycle` 负责启动初始化、配置巡检、目标注册表刷新、调度器、自监控、知识库同步、reaper、幂等账本清理和 boot 崩溃恢复。
- **核心/应用/基础设施/适配器目录边界**：`src/core/*` 承接标准契约、配置模型、纯运行时流水线、平台原语、状态接口和 target 插座；`src/app/*` 承接进程组合、HTTP 原语、调度、送达、工具运行面和生命周期；`src/infrastructure/*` 承接配置仓储、运行期 ledger、MySQL/JSONL 状态库实现；`src/services/*` 承接知识库、数据源同步和工具语义索引；`src/adapters/*` 承接 llm、执行器、企业微信、对象存储和视觉感知等具体适配。`architecture-boundary` 测试锁定 `core` 不反向依赖外层、`adapters` 不反向依赖 app/routes/services/infrastructure。
- **工具治理运行面边界**：`src/app/tools-runtime.ts` 只保留对外门面；主体解析与路由工具配置在 `tool-context`，运行时装配在 `tool-assembly`，审批意图和业务侧决策契约在 `tool-approvals`，spec 刷新、索引、authorize 探针在 `tool-specs`，执行器 defs/invoke 代理在 `tool-proxy`。
- **后台 API 边界**：后台组合入口、调度配置入口、接入密钥入口、基础设施入口、运行面入口、工具源治理入口、聊天运营入口和知识库管理入口拆分，`admin` 承接权限闸门、系统信息和管理员账号，`admin-dispatch-config` 承接项目、触发路由和执行目标注册表，`admin-access` 承接接入方、执行器令牌和密钥 reveal 审计，`admin-infra` 承接模型凭证、对象存储、渠道和告警规则，`admin-runtime` 承接任务、会话、审批意图、执行器在线状态、送达死信、成本和审计查询，`admin-tool-providers` 承接工具源注册、OpenAPI 对账、工具检索索引、召回预演和真实签名调试调用，`admin-chat` 承接网页聊天入口、页面上下文和聊天评价，`admin-kb` 承接知识库、文档、数据源同步和命中测试。
- **单 Job 全链路追溯**：`GET /admin/api/runs/:job/trace` 聚合 job、trace events、审批意图和会话总账；控制台「任务 → 追溯」可按 `job_id` 直查一次任务的触发、上下文、工具、审批、送达与结果。
- **身份归一与 Audience 策略**：`/run` 支持标准主体 `metadata.principal={id,tenant,roles,audience}`，中枢落单后写回标准主体并用于总账主体、路由受众闸和自动分诊；路由新增 `audience` 一等配置字段，支持接入方、渠道、租户、角色、主体、受众类型、匿名、关键词和优先级。
- **route=auto 规则分诊**：业务侧可传 `route:"auto"`，中枢在接入方白名单和路由 Audience 内按关键词/优先级可解释选择路由；无候选返回 400，同分候选返回 409，避免随机路由。后台提供 `POST /admin/api/routes/auto-preview` 分诊预演，返回每条路由的得分、命中原因和过滤原因。
- **追溯查询增强**：`GET /admin/api/runs/trace` 支持按 `job_id`、`request_id`、`client_id`、`thread_id`、`principal_id` 查询；唯一命中直接返回 `{job, trace, approvals, messages, lookup, debug_bundle, debug_report}`，多命中返回 matches；`debug_bundle` 包含调度租约、route 快照、审批、送达死信、消息预览、trace events 和规则化 diagnosis，并默认脱敏凭证、令牌、常见个人信息和 token-like 字符串；`debug_report` 基于脱敏包生成 Markdown 排障报告；控制台支持点选、打开详情、下载和复制脱敏排障包/排障报告，并展示脱敏规则摘要。
- **工具源治理调试台**：工具源注册、手动刷新和自动刷新后执行只读 authorize 探针；最近一次结论持久化到工具源配置并在控制台展示，支持手动重新探测。状态含 `pass`、`suspect`、`inconclusive`、`skipped`；控制台展示探针模式、路径、HTTP、原因和修复建议。工具清单支持真实签名调试调用，可按工具参数 schema 自动生成表单，也可切换 JSON 高级模式；结果展示请求摘要、签名字段、HTTP 状态、业务响应和常见排障提示；最近 5 个调试样例保存在浏览器本地；高风险/需确认工具默认阻止，必须显式放行。
- **配置体检与调度可观测**：配置体检纳入工具源授权探针结果、Audience 引用、route=auto 过宽/同分歧义、`allowed_routes` 误配，以及过期租约、同 thread 阻塞、延迟队列、执行器离线、目标无在线执行器覆盖、送达死信和任务积压等运行时风险；控制台「系统体检」按检查项卡片展示配置结构、运行期调度、route=auto、送达死信、E2E Smoke 和 Demo 闭环，支持一键运行 `POST /admin/api/smoke` 并跳转到 smoke 任务；控制台「执行器 → 调度租约」展示 queued/running/dispatched、延迟队列、过期租约、按 target 队列占用、当前租约 TTL 和同 thread 队头阻塞。
- **追溯闭环、专用探针与 schema 表单**：控制台租约面板可直跳单 job 追溯；工具源 spec 可声明 `x-bailing-authz-probe` 专用授权探针，PHP/PHP7/Node/Python SDK 与多语言参考实现提供探针 helper；Node SDK 采用 `@bailinghub/connect` 包结构，Python SDK 采用 `bailing-connect` 包结构；后台提供配置 schema 读取接口，工具源、执行器令牌、触发路由、接入方、模型凭证和渠道表单首批从 schema 读取标题、说明和必填。
- **官网开发者文档中心**：官网提供 `/docs` 总览，以及 `/docs/api`、`/docs/tools`、`/docs/sdk`、`/docs/knowledge`、`/docs/approvals`、`/docs/operations` 分页；控制台“开发文档”入口统一跳转到官网对应页面。
- **开源体验闭环**：提供 `Dockerfile`、`docker-compose.yml`、`demo/business` 示例业务系统、`demo-agent` 本地体验目标、`scripts/seed-demo.ts` 幂等初始化脚本和 `docs/DEMO.md`；开发者可一条 `docker compose up --build` 跑起中枢、MySQL、demo 业务工具源和预置路由，零模型 key 体验「业务系统暴露工具 → 中枢治理 → agent 调工具 → 审计」；`npm run smoke` 在 demo 环境会自动识别 `demo_support`，完整验证 `/run + trace + debug_bundle 脱敏声明`。
- **开源仓库门面**：根目录提供标准 `LICENSE`、`NOTICE`、`SECURITY.md`、`CONTRIBUTING.md`；`package.json` 标注 Apache-2.0；`LICENSING.md` 收敛为当前许可证说明；示例配置和流水线文档不含本机绝对路径、真实域名或内部人员标识。
- **配置巡检**：启动时自动检查 route、target、client、channel、chat entry、alert rule、tool provider、storage bucket、executor token、知识库等配置的结构和跨表引用；后台可通过 `GET /admin/api/config-diagnostics` 手动查看。
- **契约与运行期收口**：ACC `execution.timeout_ms` 在 `1..600000` 毫秒范围内原值生效，超界声明在工具编译期明确拒绝；审计写失败统一产生脱敏结构化日志并在 `/health` 暴露进程级计数；模型凭证同名来源进入配置体检，模型请求 trace 仅记录 `config` / `db` 来源而不记录密钥。
- **数据库结构**：首版结构包含 `043_rate_limits.sql`、`044_job_run_after.sql`、`045_job_claim_lease.sql`、`046_tool_authz_probe.sql`、`047_route_audience.sql`。
- **验证方式**：`npm run typecheck`、`npm run test`、`npm run smoke`、`npm run sdk:test`、`npm run sdk:test7`、`npm run sdk:test-node`、`npm run sdk:test-python`、`npm run db:init`。
