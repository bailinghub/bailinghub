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

## v0.4.0 - 原生对话表单与聊天入口控制

发布日期：2026-08-25。

- **Origin 白名单防误配**：聊天入口保存时仅接受 `scheme://host[:port]`，统一规范化、去重并在控制台回显实际限制数；非白名单浏览器 Origin 在进入对话任务前返回 403。
- **聊天入口默认展开**：外观配置新增默认关闭的 `default_open`；开启后已嵌入的官方 Widget 加载即展开，业务页面无需改脚本。既有 `data-open="1"` 强制展开行为保持兼容。
- **原生对话表单**：官方零依赖 Widget 新增受限 `bailing-form` v1，支持文本、多行文本、数字、日期、布尔、单选和多选，含客户端/服务端双校验、只读回执与历史恢复。
- **非阻塞续聊契约**：`POST /chat/:entry` 兼容新增 `interaction_response`，把表单提交/取消规范化为同 thread 的新用户消息和新 job；源 job 仍正常 `done`，不新增 `input_required` 或 SSE 状态。
- **关联、幂等与安全**：服务端按源 job/入口/身份/thread 重读权威表单验值，以 `submission_id` 去重；表单不能要求凭据或支付秘密，不替代工具审批、业务授权或副作用闸门。
- **展示能力协商**：只在客户端明确声明 `bailing-form` 时向 LLM 注入受约束输出提示；无能力客户端继续使用文字提问，`bailing-chart` 能力保持独立兼容。
- **生态文档发现**：README 增加独立维护的 DeepSeek Harness 社区插件链接；它不进入 BailingHub Core，也不代表 DeepSeek 官方开发、认证、背书或采用。
- **契约与对接影响**：公开边界增量到 `bailing.contract.v2.14`；`WIDGET_API` / `rendererApiVersion` 仍为 1，无数据库迁移。Client API v1、Kernel Host API v1、ACC、SDK、工具签名、审批语义和最终业务授权不变。
- **验证方式**：`npm run typecheck`、对话表单契约/路由测试、`npm run widget:renderer:test`、`npm run web-admin:check`、`npm run docs:check`、`npm test` 与本地真实浏览器表单交互检查。
- **相关文档**：[RELEASE_NOTES_v0.4.0.md](RELEASE_NOTES_v0.4.0.md)、[公开运行时契约](CONTRACT.md)、[Widget 渲染与表单契约](WIDGET_RENDERERS.md)、[流式协议](STREAMING.md) 与[兼容性与升级](兼容性与升级.md)。

## v0.3.4 - 匿名预览与可信业务身份引导

发布日期：2026-08-14。

- **入口语义纠偏**：控制台和独立页将原“试聊”明确标识为“匿名预览”，说明它不继承中枢管理员登录态，也没有独立业务登录入口。
- **无主体引导**：未收到业务后端签发的可信票据时，Agent 会引导用户返回真实业务系统登录并重新打开或刷新助手，不索要账号、密码、Token 或用户 ID。
- **演示验证分流**：导入演示配置后，上手向导以手动“运行演示主体 Smoke”验证真实 job 和 trace；导入不自动运行任务，中枢管理员不会被提升为业务主体。
- **安全边界不变**：无验签主体时，所有 `subject.required:true` 工具（包括只读查询和写操作）仍对 Agent 不可见；业务系统仍做最终授权。
- **数据库与契约**：没有新增迁移、Schema 或 API/协议变化；最新迁移仍为 `054_demo_dataset_state.sql`。
- **验证方式**：完整 `npm run release:check`、无主体工具装配测试、匿名预览页契约、控制台真实浏览器 E2E 与 npm 制品核对。
- **相关文档**：[RELEASE_NOTES_v0.3.4.md](RELEASE_NOTES_v0.3.4.md)、[快速开始](QUICKSTART.md)、[聊天入口与身份契约](CONTRACT.md) 与 [Docker Demo](DEMO.md)。

## v0.3.3 - npm 发布元数据纠偏

发布日期：2026-08-09。

- **发布来源核对**：从精确 Tag 的独立完整 Git clone 发布 npm 包，使 Registry `gitHead`、Tag 提交与公开源码可以一致核对；`v0.3.2` 保留为不可变历史，不覆盖、不移动、不重发。
- **运行时不变**：`src/`、`sql/`、`web/`、`web-admin/`、`demo/` 与 `sdk/` 相对 `v0.3.2` 无变化，受管演示数据能力保持不变。
- **数据库结构**：没有新增迁移，最新迁移仍为 `054_demo_dataset_state.sql`。
- **对接影响**：Client API、Kernel Host API v1、聊天协议、Executor Protocol、ACC、工具签名、审批语义与最终业务授权均不变。
- **相关文档**：[RELEASE_NOTES_v0.3.3.md](RELEASE_NOTES_v0.3.3.md) 与 [v0.3.2 受管演示数据说明](RELEASE_NOTES_v0.3.2.md)。

## v0.3.2 - 受管演示数据引导

发布日期：2026-08-08。

- **Core 原生上手能力**：新增演示数据状态、导入与清理 Admin API，并恢复空实例的控制台引导；演示目标、工具源、路由和接入方由当前租户 Core 自己管理，不依赖外部私有数据层。
- **所有权与冲突保护**：新增持久 ownership manifest、固定资源指纹和事务级并发保护；同名占用、用户修改或外部引用均返回 `409`，清理不删除任务、消息、Trace 和审计历史。
- **双运行 profile**：保留 Docker `full-local` 完整演示，并增加只允许 loopback、无状态、只读工具的 `stateless-readonly` profile，供共享或宿主式体验环境安全复用。
- **数据库结构**：新增 `054_demo_dataset_state.sql` 和 `bz_demo_datasets`，只记录 Core 明确拥有的演示配置清单与指纹；升级先执行官方迁移器，再重启服务。
- **对接影响**：Client API、Kernel Host API v1、聊天协议、Executor Protocol、ACC、工具签名、审批语义和业务系统最终授权保持兼容；未配置 Demo Business 的实例不会显示可导入入口。
- **验证方式**：完整 `npm run release:check`、Docker demo、npm 制品检查，以及从空实例执行导入、浏览和清理的人工候选验证。
- **相关文档**：[RELEASE_NOTES_v0.3.2.md](RELEASE_NOTES_v0.3.2.md)、[Docker Demo](DEMO.md)、[SQL 迁移纪律](../sql/README.md) 与 [兼容性与升级](兼容性与升级.md)。

## v0.3.1 - PDF 解析安全更新

发布日期：2026-08-07。

- 将上传 PDF 文本抽取所使用的 `pdfjs-dist` 从 `5.7.284` 升级到 `6.2.108`，修复 GHSA-hq66-cqwq-w95j 所述的任意 JavaScript 执行风险。
- 适配 PDF.js 6 的生命周期接口，在成功和失败路径都销毁加载任务并释放解析资源。
- 没有数据库迁移或配置变化；Client API、Kernel Host API v1、聊天协议、Executor Protocol、ACC、工具签名、审批语义和业务最终授权不变。
- **验证方式**：`npm audit --audit-level=low`、真实 PDF 抽取测试与完整 `npm run release:check`。
- **相关文档**：[RELEASE_NOTES_v0.3.1.md](RELEASE_NOTES_v0.3.1.md)、[安全策略](../SECURITY.md) 与 [兼容性与升级](兼容性与升级.md)。

## v0.3.0 - 可组合 Core 与 Kernel Host API v1

发布日期：2026-08-06。

- **正式组合入口**：新增稳定导出 `bailinghub/kernel-api/v1`，宿主可以从精确 npm 制品创建、挂载、排空和停止 Kernel；独立服务也改为装配同一 Kernel 路径，不维护第二套运行内核。
- **多实例边界**：同一进程可托管多个隔离 Kernel，但每个实例必须拥有独立状态库、运行目录、配置和请求前缀。平台身份、租户目录、注册、套餐、计费及跨租户授权仍由宿主控制面负责，不进入开源 Core。
- **官方迁移器**：Schema 迁移从启动副作用收敛为宿主显式步骤；账本增加 SHA-256，旧记录只补摘要、不重放 SQL。三条早期退役迁移作为 `replay: never` 证据保留，fresh Schema 永不执行；摘要漂移和未知迁移失败关闭。
- **精确制品**：npm tarball 包含 Kernel API、官方 SQL、控制台静态资源及制品描述；`BAILINGHUB_CORE_ARTIFACT_V1` 固定版本、活动迁移、退役证据与整体摘要，供开通和升级编排校验。
- **镜像发布安全**：预发布标签即使被手工请求也不能更新 `latest`；稳定标签才可按发布配置更新稳定通道。
- **对接影响**：普通自托管启动方式、公开 Client API、聊天协议、Executor Protocol、ACC、工具签名、审批语义和业务系统最终授权不变；生态适配器无需因本次组合 API 升级版本。
- **数据库结构**：只为 `bz_schema_migrations` 增加可空 `checksum_sha256` 元数据列，不新增业务表或业务字段。升级先运行 `npm run db:init`，成功后再重启。
- **验证方式**：`npm run release:check` 和真实 npm `.tgz` 安装检查，覆盖 515 项核心测试、迁移兼容、组合生命周期、多实例隔离、OSS 边界和镜像策略。
- **相关文档**：[RELEASE_NOTES_v0.3.0.md](RELEASE_NOTES_v0.3.0.md)、[Kernel Host API v1](KERNEL_HOST_API.md)、[SQL 迁移纪律](../sql/README.md) 与 [架构说明](ARCHITECTURE.md)。

## v0.2.0 - 工具清单访问保护与主动核验

发布日期：2026-08-06。

- **工具清单访问策略显式化**：URL 工具源只提供 `signed_required`（默认、推荐）和 `public_allowed`（明确接受公开）两项可配置策略。控制台分别显示管理员期望与最近一次实测证据，不再把“配置了签名”当作“已经验证受保护”。
- **受保护清单主动核验**：正确签名请求成功后，中枢还会验证未签名与错误签名请求均被业务侧拒绝；不满足时失败关闭并保留旧缓存。公开模式只发未签名请求，不会偷偷回退签名。
- **业务侧对接影响**：推荐业务系统使用与工具调用相同的工具源密钥保护 spec GET，并对未签名/错误签名返回 401、403 或 404；受保护响应必须发送 `Cache-Control: private, no-store`。确需公开时必须在代码和控制台两侧显式选择，工具调用仍然继续验签和执行最终业务授权。
- **SDK**：PHP / PHP7 `SpecServer` 新增 `handlePublic()`、`respondPublic()` 和 `responseHeaders()`；受保护的裸 PHP 响应自动禁止缓存，旧 `null` 公开调用保持兼容。
- **数据库结构**：新增 `053_tool_spec_access_policy.sql`，为 `bz_tool_providers` 增加访问策略和最近探针字段。历史 URL 工具源继续沿用旧式签名拉取，不会因升级中断；停用或修改说明、治理、检索等非清单字段不强迫选择策略，只有修改清单地址、密钥、自动刷新或重新启用等清单敏感动作才须先从两项访问策略中确认一项。内部迁移状态只在[兼容性与升级](兼容性与升级.md#十url-工具清单访问策略升级)说明。
- **验证方式**：`npm run release:check`；升级后确认迁移无待执行、历史来源缓存未变化，并按 [兼容性与升级](兼容性与升级.md#十url-工具清单访问策略升级) 的状态矩阵验证业务端点。
- **相关文档**：[RELEASE_NOTES_v0.2.0.md](RELEASE_NOTES_v0.2.0.md)、[公开运行时契约](CONTRACT.md)、[第三方对接指南](第三方对接指南.md#63-发布接口清单--后台注册)、[工具治理设计](TOOLS_DESIGN.md)、[PHP SDK](../sdk/php/README.md) 与 [PHP7 SDK](../sdk/php7/README.md)。

## v0.1.16 - 工具运行时收敛与语义检索韧性

发布日期：2026-08-05。

- **路由预算真正收敛**：运行时按每条路由既有的 `tools.max_calls` 推导有界模型轮次，并在每轮业务工具执行后告知模型已用和剩余次数；接近上限时优先形成答案，耗尽后移除工具并强制进入最终回答。
- **内部协议输出闸**：流式和非流式回答都会拦截 DSML 等内部工具协议标记；临时文本通过 `reset` 清除，只允许一次不带工具的安全重写，连续违规失败关闭，文本协议永不解析执行。
- **语义检索韧性**：启动后后台预热，过期缓存继续服务并单飞刷新；索引/凭证读取和查询向量请求使用独立时限，异常时退回渐进式工具发现。
- **索引一致性与诊断**：同源重建串行执行并在锁内重读权威配置；embedding 坐标变化时原子替换整源索引；新增不含查询正文、服务地址或凭证的分阶段耗时诊断。
- **Widget 最小化语义**：右上角原关闭图标改为最小化图标和无障碍标签，隐藏与重新打开面板的既有功能不变。
- **社区接入配方**：新增 RuoYi-Vue-Pro 售后查询/退款与 JeecgBoot 用户查询/冻结解冻的独立社区治理配方，包含 Agent-facing OpenAPI、适配契约和验证脚本；不代表上游官方集成或认可。
- **数据库结构**：无迁移。
- **对接影响**：ACC、Client API 版本、执行器协议、工具签名、审批语义和业务最终授权不变；既有路由无需修改。自建聊天客户端继续把任何 `reset` 视为清空临时文本，并以 `done.reply` 为权威最终回答。
- **验证方式**：`npm run release:check`，并执行两项社区配方验证脚本，覆盖预算收敛、协议拦截、检索超时降级、缓存刷新、原子重建及 Widget 最小化。
- **相关文档**：[RELEASE_NOTES_v0.1.16.md](RELEASE_NOTES_v0.1.16.md)、[TOOLS_DESIGN.md](TOOLS_DESIGN.md)、[OPERATIONS.md](OPERATIONS.md)、[RuoYi-Vue-Pro 配方](integrations/ruoyi-vue-pro/README.md)、[JeecgBoot 配方](integrations/jeecgboot/README.md)。

## v0.1.15 - 可信富内容渲染与聊天可靠性

发布日期：2026-08-01。

- **可信富内容扩展**：官方 Widget 新增版本化渲染器注册、白名单分发、资源清理和失败回退；核心继续零依赖，不执行模型生成的 HTML 或脚本。
- **展示能力协商**：聊天客户端可声明本地实际支持的渲染类型；该信息只影响可选呈现提示，不改变身份、路由、工具、审批或业务授权。
- **流式等待体验**：`delta` 显示临时进度，`reset` 清空，`done.reply` 替换临时气泡并成为唯一最终文本。
- **运行时收敛**：追加工具检索设置独立上限且无新增时提前停止；工具错误页向模型压缩、向审计保留完整证据；LLM trace 补充低敏耗时与规模指标。
- **数据库结构**：无迁移。
- **对接影响**：旧客户端行为不变；自建客户端如启用富内容，需要显式能力自报并实现完整 SSE 生命周期和安全渲染边界。
- **验证方式**：`npm run release:check`，并覆盖渲染器注册/降级/清理、能力协商、临时消息替换和自建客户端范例。
- **相关文档**：[RELEASE_NOTES_v0.1.15.md](RELEASE_NOTES_v0.1.15.md)、[WIDGET_RENDERERS.md](WIDGET_RENDERERS.md)、[STREAMING.md](STREAMING.md)、[第三方对接指南.md](第三方对接指南.md)。

## v0.1.14 - 流式对话阶段性进度提示

发布日期：2026-07-30。

- **展示阶段性反馈**：官方网页组件会把模型在调用工具前给出的简短确认语临时提升为进度气泡，并在工具调用、模型整理、重试或回退阶段展示明确状态。
- **正式回答开始即收口**：一旦最终回答开始流式输出，临时进度气泡立即移除；聊天记录只保留正式答案，不把阶段性提示当作第二条助手消息持久化。
- **明确认知边界**：该能力只展示模型主动输出的短暂确认语和运行阶段，不暴露内部推理过程；进度文本会规范空白并限制长度。
- **可访问性**：进度动画遵循 `prefers-reduced-motion`，失败与后台处理中状态使用确定性文案。
- **数据库结构**：无迁移。
- **对接影响**：Client API、流式事件协议、执行器协议、工具签名、审批语义和 ACC 均不变。官方组件自动获得新行为；自定义聊天界面需自行消费既有 `delta`、`reset`、`phase` 与 `done` 事件。
- **验证方式**：`node --check web/widget/widget.js`、公开路由组件测试、`npm run typecheck` 与 `npm run release:check`。
- **相关文档**：[RELEASE_NOTES_v0.1.14.md](RELEASE_NOTES_v0.1.14.md)、[独立验证任务卡](INDEPENDENT_VALIDATION.md)、[公开运行时契约](CONTRACT.md)。

## v0.1.13 - 语音转写与分发版本一致性

发布日期：2026-07-30。

- **承接 v0.1.12 语音修复**：保留显式 `transcribe`、`inline`、`off` 策略、专用语音模型转写和失败关闭边界，不改变已发布协议语义。
- **统一安装版本来源**：一键安装脚本、镜像 Compose、镜像发布脚本、镜像检查脚本、独立验证基线和 Issue 模板统一指向 `v0.1.13`。
- **阻止入口版本漂移**：正式分发校验会同时核对包版本、安装脚本兜底值、Compose 默认镜像和公开验证文档，避免某个入口仍拉取旧镜像。
- **数据库结构**：无迁移。
- **对接影响**：Client API、执行器协议、工具签名、审批语义、语音策略和 ACC 均不变；`v0.1.12` 使用者无需配置迁移。
- **验证方式**：`npm run release:check`、正式分发同步 dry-run、官方镜像标签检查和一键安装入口复核。
- **相关文档**：[RELEASE_NOTES_v0.1.13.md](RELEASE_NOTES_v0.1.13.md)、[独立验证任务卡](INDEPENDENT_VALIDATION.md)、[兼容性与升级.md](兼容性与升级.md)。

## v0.1.12 - 语音转写策略与失败关闭

发布日期：2026-07-30。

- **音频处理改为显式策略**：LLM 路由支持 `transcribe`、`inline` 和 `off`；缺少配置时默认关闭，不再猜测主模型是否支持音频。
- **转写链路失败关闭**：转写凭证、模型或端点缺失、禁用或无法解析时，任务返回确定性提示，不会把音频退回给主模型，也不会猜测音频内容。
- **双协议转写适配**：支持 `/audio/transcriptions` multipart 请求，以及 `/chat/completions` 的 Data URL `input_audio` 请求。
- **控制台与 Schema 对齐**：路由页新增语音协议选择，配置 Schema 同步约束协议枚举和默认值。
- **审计边界**：记录模式、协议、模型、MIME 类型、字节数和结果，不记录音频正文、Data URL 或凭证。
- **数据库结构**：无迁移。
- **对接影响**：文本聊天、Client API、执行器协议、工具签名、审批语义和 ACC 不变；依赖隐式音频直传的路由需显式选择 `inline` 或配置 `transcribe`。
- **验证方式**：`npm run typecheck`、`npm test`、`npm run web-admin:check`、`npm run release:check`，并完成真实 MP3 到专用语音模型、主模型流式回复和任务终态的端到端验证。
- **相关文档**：[RELEASE_NOTES_v0.1.12.md](RELEASE_NOTES_v0.1.12.md)、[工具治理设计](TOOLS_DESIGN.md)、[兼容性与升级.md](兼容性与升级.md)。

## v0.1.11 - 副作用执行日志与不确定结果冻结

发布日期：2026-07-28。

- **副作用执行日志改为外发前占位**：非只读、非声明幂等的业务工具在请求外发前持久化 `dispatching`，收到响应后记录 `response_recorded`，结果审计与终态落账完成后才进入 `completed`。
- **不确定结果禁止自动重放**：超时、断连、重启遗留、结果审计失败和终态提交失败会收敛到 `reconciliation_required`，并明确 `auto_retry_allowed=false`；任务恢复在模型运行前扫描未决记录。
- **稳定业务幂等键**：副作用业务请求新增 `X-Bailing-Idempotency-Key`，稳定绑定任务、主体、工具与规范化参数，供业务侧去重和人工对账；该键不替代验签或业务授权。
- **内置消息发送纳入同一安全边界**：`send_message` 在外发前写执行日志；文本分片、卡片或附件部分送达后失败时冻结整次发送，不自动重发。
- **数据库结构**：新增 `052_tool_execution_journal.sql`，把原工具调用去重账本扩展为可恢复的执行日志。
- **对接影响**：只读和显式声明幂等的业务工具行为不变。副作用工具必须使用持久化执行日志；旧部署升级时需执行新增迁移。业务系统建议接收并使用稳定幂等键。
- **验证方式**：`npm run typecheck`、`npm test`、`npm run web-admin:check`、`npm run docs:check`、`npm run examples:check`、`npm run security:scan`、`npm run release:check`。
- **相关文档**：[RELEASE_NOTES_v0.1.11.md](RELEASE_NOTES_v0.1.11.md)、[工具治理设计](TOOLS_DESIGN.md)、[公开运行时契约](CONTRACT.md)、[兼容性与升级.md](兼容性与升级.md)。

## v0.1.10 - 实例品牌设置与生态接入完善

发布日期：2026-07-27。

- **新增实例品牌设置**：具有 `admins:manage` 权限的管理员可在控制台维护网站名称、浏览器标题、描述、关键词、登录页文案、Logo 与 favicon；设置持久化到 `bz_instance_branding`，升级与重启不会覆盖。
- **建立可替换管理边界**：控制台与公开展示只依赖 `InstanceBrandingProvider`。开源版使用本地 Provider；未来平台可单一接管并将实例内设置转为只读，不采用双写。
- **增加安全公开展示面**：新增 `GET /branding` 及 Logo/favicon 资源端点，仅返回展示数据；图片按实际文件头识别并限制格式和大小。
- **改善模型标识诊断**：模型验证失败且 ID 含空白时提示检查展示名称；新增腾讯云 TokenHub 预设与 `kimi-k3` 精确 ID，同时保留合法自定义别名。
- **补齐生态配方**：新增 DeepSeek V4 工具调用 E2E 与阿里云百炼远程 MCP 的中英文配置和验证脚本。
- **数据库结构**：新增 `051_instance_branding.sql`，只创建单例品牌设置表。
- **对接影响**：不修改 Client API、执行器协议、工具签名、审批语义或 ACC。既有部署升级后继续显示默认品牌。
- **验证方式**：`npm run typecheck`、`npm test`、`npm run web-admin:check`、`npm run docs:check`、`npm run security:scan`、`npm run release:check`。
- **相关文档**：[RELEASE_NOTES_v0.1.10.md](RELEASE_NOTES_v0.1.10.md)、[兼容性与升级.md](兼容性与升级.md)、[DeepSeek 接入配方](integrations/deepseek/README.md)、[阿里云百炼 MCP 配方](integrations/bailian/README.md)。

## v0.1.9 - 可选 OpenMetrics 运维指标

发布日期：2026-07-24。

- **新增可选 OpenMetrics 端点**：`GET /metrics` 默认关闭，启用后必须使用独立 Bearer Token；不接受 query Token，不与管理根密钥复用。
- **提供稳定低基数运维指标**：覆盖任务状态、最近终态、最老排队时间、延迟任务、过期租约、阻塞线程、待审批数、执行器在线状态、审计写失败、运行时暂停与采集器健康；不输出任务、租户、主体、参数或业务载荷标签。
- **故障隔离与扩展兼容**：状态库与控制面采集器分别限时、独立降级；单个采集失败不阻断其余指标。第三方状态/配置实现可继续忽略新增可选聚合方法。
- **数据库结构**：新增 `050_operational_metrics_indexes.sql`，只为任务终态时间窗口和执行器心跳聚合增加索引。
- **对接影响**：默认行为不变；不修改 Client API、执行器协议、工具签名或 ACC 语义。仅启用 `/metrics` 的部署需要配置三个 `BAILING_METRICS_*` 环境变量。
- **验证方式**：`npm run typecheck`、`npm test`、`npm run docs:check`、`npm run security:scan`、`npm run release:check`。
- **相关文档**：[RELEASE_NOTES_v0.1.9.md](RELEASE_NOTES_v0.1.9.md)、[OPERATIONS.md](OPERATIONS.md)、[兼容性与升级.md](兼容性与升级.md)。

## v0.1.8 - 首次管理员只创建一次

发布日期：2026-07-24。

- **首次管理员只创建一次**：新增成对环境变量 `BAILING_BOOTSTRAP_ADMIN_USERNAME` 与 `BAILING_BOOTSTRAP_ADMIN_PASSWORD`。仅当管理员表为空时创建首个账号；使用同一数据库的重启、升级和容器重建不会更新已有账号、密码、角色或启用状态。
- **并发冷启动安全**：MySQL 仓储以命名锁和事务收敛多副本并发初始化，只有一个副本能够创建首个管理员；无法取得初始化锁时启动失败，不以不确定状态继续运行。
- **保留显式管理入口**：`npm run admin:create` 继续承担人工创建和密码重置，不被自动启动流程调用。demo seed 改用同一 create-once 契约，不再在服务重启时重置管理员密码，也不在服务日志中打印密码。
- **对接影响**：没有数据库迁移，不改变 Client API、执行器协议、工具签名或 ACC 语义。两个 bootstrap 变量必须同时配置；只配置一个会拒绝启动。保留数据库的重装不会重置密码，删除数据库后的全新安装会重新创建首个账号。
- **验证方式**：`npm run typecheck`、`npm test`、`npm run security:scan`，并在真实 MySQL 上验证首次创建、密码修改后的重启保持、并发冷启动和日志脱敏。
- **持续回归**：Docker demo CI 会在真实 MySQL 中模拟管理员主动改密，重启容器后确认 bootstrap 配置没有覆盖已存密码。
- **改密兼容修复**：管理员仓储在仅更新密码、未传角色时，新账号使用 `admin` 缺省角色，已有账号保留原角色，避免 MySQL 在重复键更新前因非空角色列拒绝请求。
- **相关文档**：[RELEASE_NOTES_v0.1.8.md](RELEASE_NOTES_v0.1.8.md)、[QUICKSTART.md](QUICKSTART.md)、[OPERATIONS.md](OPERATIONS.md)。

## v0.1.7 - 版本化 Client API 与跨生态兼容门禁

发布日期：2026-07-23。

- **建立稳定 Client API**：新增 `bailing.client-api.v1`，以 manifest、JSON Schema 和行为向量定义 `/health`、`/run`、`/jobs/{job_id}`、认证、错误分类和任务状态。
- **增加双向兼容门禁**：核心 CI 验证 Dify 与 n8n 适配器，适配器 CI 反向验证目标核心分支，阻止任一仓库静默破坏另一方。
- **收紧公开请求边界**：Client API 严格校验顶层字段、route、metadata、callback URL、request id 和输入长度；调用来源由认证 client 身份决定，不能由请求自行覆盖。
- **保持协议分层**：OpenClaw 与便携执行器不被错误纳入 Client API，继续使用独立的 claim、heartbeat、lease 和结果回报协议。
- **对接影响**：无数据库迁移；按公开契约接入的客户端无需修改。依赖未声明顶层字段的非正式接入应删除这些字段。
- **验证方式**：`npm run client-api:contract`、`npm run client-api:ecosystem:local`、`npm run client-api:ecosystem:clone`、`npm run typecheck`、`npm test`、`npm run release:check`。
- **相关文档**：[RELEASE_NOTES_v0.1.7.md](RELEASE_NOTES_v0.1.7.md)、[CLIENT_API.md](CLIENT_API.md)。

## v0.1.6 - 独立验证路径与安装后权限提示

发布日期：2026-07-21。

- **降低独立验证门槛**：公开任务卡将全新 Ubuntu/Debian 一键安装设为推荐核心路径，同时保留本地源码复现，不再要求所有验证者先理解仓库构建流程。
- **修正安装后命令权限**：安装器根据当前会话真实 Docker 权限打印 `docker compose` 或 `sudo docker compose`，避免非 root 用户在 Docker 组权限生效前照抄命令得到 socket 权限错误。
- **收紧验证安全边界**：中英文任务卡明确禁止在生产主机、生产网络或含重要 Docker 数据的环境运行，并要求反馈时排除密码、Token、完整 `.env` 和生产数据。
- **改善反馈结构**：独立验证 Issue 模板区分一键安装、源码 Docker、Dify 与执行器路径；提交号只在源码复现时需要。
- **对接影响**：现有部署无需迁移。公开 HTTP 契约、SDK、签名格式、ACC 语义、数据库结构和业务镜像运行行为均无变化。
- **验证方式**：`sh -n scripts/install.sh`、`npm run docs:check`、`npm run release:check`；并在隔离 Ubuntu 24.04 实例验证权限提示、健康检查、10 项 smoke、完整 demo E2E 和清理边界。
- **相关文档**：[RELEASE_NOTES_v0.1.6.md](RELEASE_NOTES_v0.1.6.md)、[INDEPENDENT_VALIDATION.md](INDEPENDENT_VALIDATION.md)。

## v0.1.5 - 一键安装参数可靠性与全新服务器兼容性

发布日期：2026-07-21。

- **修复自定义安装参数传递**：安装模式、端口、公开地址、镜像仓库、安装目录和仓库引用等环境变量现在明确绑定到执行安装脚本的 `sh`，避免变量只传给 `curl` 后被静默忽略。
- **改善全新服务器依赖安装**：安装器先检查 apt 软件源实际提供 `docker-compose-plugin` 还是 `docker-compose-v2`，再安装可用包，不再先产生一次可避免的包安装错误。
- **收紧访问地址提示**：公网地址识别失败时不再回退并展示私网地址；安装结果改为明确提示远程访问者替换 `localhost`，也支持显式设置 `BAILING_PUBLIC_HOST`。
- **增加发布回归门禁**：GitHub 发布演练会扫描公开文档和脚本，阻止 `BAILING_* curl ... | sh` 这类把环境变量错误绑定到下载进程的命令再次进入版本。
- **对接影响**：默认一键安装命令保持不变。曾使用自定义变量的安装命令应改为 `curl ... | env BAILING_*=... sh`。公开 HTTP 契约、SDK、签名格式和数据库结构均无变化。
- **验证方式**：`sh -n scripts/install.sh`、`npm run docs:check`、`npm run release:check`；并在全新 Ubuntu 24.04 服务器上完成默认镜像安装、自定义模式/端口/公开地址安装、10 项 smoke、完整 demo E2E 与重启持久性验证。
- **相关文档**：[RELEASE_NOTES_v0.1.5.md](RELEASE_NOTES_v0.1.5.md)、[QUICKSTART.md](QUICKSTART.md)、[DEMO.md](DEMO.md)。

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
