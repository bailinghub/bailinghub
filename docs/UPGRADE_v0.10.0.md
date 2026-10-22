# Core v0.10.0 升级指南

[English](UPGRADE_v0.10.0.en.md)

本指南从公开 Core 0.9.4 升级到 0.10.0。配套 MCP / Agent Client SDK 0.8.0、DSH 0.8.0 独立发行；普通业务 HTTP 接入、自带聊天和旧 Agent 客户端不必为使用原功能重建授权。新功能及具体消费者是否采用，按各自配置和版本决定。

## 备份、排空与存储

固定源/目标 Tag、完整提交、npm 或镜像摘要。保留配置、密钥管理材料、附件、JSONL、实际状态库和配置库的一致备份、完整迁移账本、原 operation/invocation、审批、通知与旧制品。协调全部共库写入方，停止新接单并排空已接受工作。关闭超时不证明工作已经结束；不要让新旧 JSONL writer 并行写入。

**相对 0.9.4 无新增 SQL，也未修改既有 SQL 或迁移器。** 已完整应用 0.9.4 的实例不应为本版手动补写账本。更早版本仍须使用官方显式迁移器应用缺失迁移，包括 0.9.3→0.9.4 的 068；分别核对 state/configuration 实际拓扑，共库只执行一次。`npm run db:init` 仅处理当前 `state.mysql`；独立配置库通过 `migrateBailingHubCoreSchema()` 明确迁移，启动不执行 DDL。

可先用 [只读升级计划](UPGRADE_PLAN.md)检查制品及脱敏账本，不能用离线 `reviewable` 代替现场数据库、备份恢复或上线批准。

## Readiness 和自定义 Host

新 readiness 检查实际 state/configuration 池、制品迁移清单和完整 SHA-256。缺迁移、未知迁移或摘要冲突保持 not-ready。它不自动修复，也不以外部模型或工具源故障把整个实例摘除。

自定义 MySQL `RuntimeStateStore` 应提供可选类型扩展 `schemaReadinessDb`，指向实际使用的只读查询资源；缺少时现在失败关闭。默认 `MysqlStore` 已提供，无须额外建池。JSONL 搭配 MySQL 配置库仍检查配置库，纯 JSONL 且无 SQL 配置库才跳过数据库。

嵌入式 Host 保持既有 `tick()` 与 `close(drainMs)`，等待启动恢复的目标刷新、查询、审计和重新排队全部完成后再释放资源。不要把部署健康、API 签名不变或一次 typecheck 当作完整 Fleet 升级证明。

## Agent 客户端配套

1. 先升级 Core 并核对原协议可用；仅准备新调用时刷新目录。保留所有已准备请求的原内容、摘要、operation、invocation 和授权关联。
2. 宿主采用 MCP / Agent Client SDK 0.8.0、DSH 0.8.0 后，核对自己的实际依赖树、构建产物与已加载版本。Core、通用 SDK 和完整宿主产品的依赖审计范围不同。
3. 大参数需要链路各层都支持新上限；旧客户端的 4/16 KiB 检查不会被 Core 自动覆盖。不要压缩业务语义、改对象为字符串或绕过鉴权来回避限制。
4. 先调用知识 capabilities，确认协议后在新 turn 显式选择 `on_demand`。404/405/501 可按协议降级为 inline；401/403/5xx 或未知 schema 不能当作成功。提示、引用和分页都受当前授权/修订/预算约束。自带 chat/embed/widget 无需采用这一选项。
5. 指导文字和执行摘要只作参考。业务机器约束和原结果核对不能因为去重、摘要或省略正文而丢失。

## 模型预算按需配置

默认不修改旧服务。采用新策略时，一起显式设置 `defaultOutputTokens`、`outputTokenParameter`、`outputBudgetScope`，并核对默认值不超过 `maxOutputTokens`。供应商实际能力未知时不编造 `modelMaxOutputTokens`。更换模型或凭据后重新核实，图片服务不填这些对话字段。

旧客户端可能把旧 `max_output_tokens` 同时当默认和上限；在它们适配之前可保留旧策略，或在明确核实参数兼容后先用相等的默认/上限过渡，不把这种过渡当作新契约永久语义。参数冲突或超限是明确的派发前错误，不自动重试。已经准备但尚未受理的旧 intent 可能因新策略被拒绝，需要显式准备新 operation；已经受理的原 operation 仍按原 ID 恢复，不改历史快照。

输出截断由宿主适配器判断。只收到流片段或终帧丢失时先查原 operation；明确截断且原回执完整时，宿主才可在原任务授权内建立新续段。中枢不会为升级或验收自动调用模型，也不会重做已完成工具。详见[预算契约](MODEL_OUTPUT_BUDGET.md)和[宿主续段](MODEL_CONTINUATION.md)。

## 验收与回退

- 核对精确制品身份、完整迁移账本与 `/health/ready`；检查真实存储而非只看配置文件名。
- 用独立数据核对调用示例、未保存保护、审批原参数、只读回执、诊断过滤/返回路径；大参数验证可使用只读 validate 或模拟业务系统，不修改客户页面。
- 新知识和预算只对采用它们的宿主验收；保留旧 inline、旧策略和原 operation 恢复用例。核对真实供应商参数及费用前，不把合成输出当作真实长答案验收。

回退前先停新写入、排空并保存新产生的原调用与配置修订。没有新 DDL 不代表仅换旧 Tag 就安全：旧 Core 不理解新知识端点或显式预算策略，可能重新采用旧默认参数。应在隔离副本验证旧消费者的 inline 降级、旧服务策略与实际持久记录组合，必要时按一致集合恢复代码与配置。不要删除审批、unknown、账本或原 operation 来绕过检查；恢复数据库不能撤销已经发生的外部业务动作。

[版本说明](RELEASE_NOTES_v0.10.0.md) · [兼容策略](兼容性与升级.md) · [运维](OPERATIONS.md)
