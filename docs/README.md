# 文档地图

本目录只放开源项目需要公开维护的文档。官网内容、内部运维记录、临时调研报告不放进开源仓。

英文文档地图见 [README.en.md](README.en.md)。公开仓库中的中文主文档都应有英文 companion；内部说明和不进入开源包的运营材料不在此约束内。

## 开始使用

| 文档 | 用途 |
|---|---|
| [QUICKSTART.md](QUICKSTART.md) | 从零部署百灵中枢，适合准备接入真实业务系统的开发者。 |
| [QUICKSTART.en.md](QUICKSTART.en.md) | English quickstart for Docker demo, first route, and first business tool. |
| [DEMO.md](DEMO.md) | Docker demo 闭环：中枢、MySQL、demo 业务系统、工具源、审计与 trace。 |
| [DEMO.en.md](DEMO.en.md) | English Docker demo walkthrough. |
| [INDEPENDENT_VALIDATION.md](INDEPENDENT_VALIDATION.md) | 陌生开发者仅凭公开资料验证 Docker demo 的任务卡、通过标准与反馈方式。 |
| [INDEPENDENT_VALIDATION.en.md](INDEPENDENT_VALIDATION.en.md) | English independent validation task, pass criteria, and report path. |
| [user-guide/README.md](user-guide/README.md) | 使用者/产品经理视角：从业务需求出发，理解为什么需要中枢、后台菜单怎么配、配完交给开发者什么。 |
| [CONTRACT.md](CONTRACT.md) | 业务系统和中枢之间的稳定网络契约，接入前应先读。 |
| [CONTRACT.en.md](CONTRACT.en.md) | English HTTP and wire contract summary. |
| [第三方对接指南.md](第三方对接指南.md) | 业务侧如何暴露工具、验签、授权与返回结果。 |
| [INTEGRATION.en.md](INTEGRATION.en.md) | English third-party integration guide. |
| [integrations/dify/README.md](integrations/dify/README.md) | Dify 通过 BailingHub `/run` 与 `/jobs/{job_id}` 发起受治理任务的最小接入配方。 |
| [integrations/dify/README.en.md](integrations/dify/README.en.md) | English Dify + BailingHub minimal integration recipe. |

## 架构与模型

| 文档 | 职责边界 |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | 当前架构的主说明：分层、核心运行链路、解耦边界和扩展方向。 |
| [ARCHITECTURE.en.md](ARCHITECTURE.en.md) | English architecture overview. |
| [PIPELINE.md](PIPELINE.md) | 一次任务从入口到执行、审计、送达的流水线。 |
| [PIPELINE.en.md](PIPELINE.en.md) | English runtime pipeline. |

## 运行面能力

| 文档 | 用途 |
|---|---|
| [TOOLS_MODEL.md](TOOLS_MODEL.md) | 工具抽象模型：不同来源如何归一成中枢可治理的 ToolDefinition。 |
| [TOOLS_MODEL.en.md](TOOLS_MODEL.en.md) | English tool model. |
| [TOOLS_DESIGN.md](TOOLS_DESIGN.md) | 工具治理实现：白名单、风险、限流、审批、审计、签名。 |
| [TOOLS_DESIGN.en.md](TOOLS_DESIGN.en.md) | English tool governance design. |
| [AI友好工具设计指南.md](AI友好工具设计指南.md) | 业务接口如何设计成 AI 容易正确调用的工具。 |
| [AI_FRIENDLY_TOOLS.en.md](AI_FRIENDLY_TOOLS.en.md) | English AI-friendly tool design guide. |
| [TOOLS.en.md](TOOLS.en.md) | English business tool and governance guide. |
| [SDK.en.md](SDK.en.md) | English SDK guide for PHP, Node, Python, Java, Go, .NET, and any-language integration. |
| [CHANNELS.md](CHANNELS.md) | 入站渠道模型，当前包含企微接入。 |
| [CHANNELS.en.md](CHANNELS.en.md) | English inbound channel model. |
| [OPERATIONS.md](OPERATIONS.md) | 生产部署、多副本、健康检查、容量、备份与恢复。 |
| [OPERATIONS.en.md](OPERATIONS.en.md) | English production operations guide. |
| [STREAMING.md](STREAMING.md) | 网页聊天的真实增量输出协议：SSE 事件、断线重放、权威结果和多副本边界。 |
| [STREAMING.en.md](STREAMING.en.md) | English chat streaming protocol and operations boundary. |

## 发布与维护

| 文档 | 用途 |
|---|---|
| [ECOSYSTEM.md](ECOSYSTEM.md) | 社区发行版、独立实现、生态组件和未来官方展示的原则。 |
| [ECOSYSTEM.en.md](ECOSYSTEM.en.md) | English policy for derivatives, independent implementations, and ecosystem listings. |
| [RELEASE_NOTES_v0.1.1.md](RELEASE_NOTES_v0.1.1.md) | `v0.1.1` 聊天组件运营控制与接入边界修复说明。 |
| [RELEASE_NOTES_v0.1.1.en.md](RELEASE_NOTES_v0.1.1.en.md) | English `v0.1.1` release notes. |
| [RELEASE_NOTES_v0.1.2.md](RELEASE_NOTES_v0.1.2.md) | `v0.1.2` 服务端根 token 与派生凭证安全加固说明。 |
| [RELEASE_NOTES_v0.1.2.en.md](RELEASE_NOTES_v0.1.2.en.md) | English `v0.1.2` security hardening release notes. |
| [RELEASE_NOTES_v0.1.3.md](RELEASE_NOTES_v0.1.3.md) | `v0.1.3` 便携式执行器接入与 OpenClaw 适配说明。 |
| [RELEASE_NOTES_v0.1.3.en.md](RELEASE_NOTES_v0.1.3.en.md) | English `v0.1.3` portable executor onboarding and OpenClaw adapter release notes. |
| [RELEASE_NOTES_v0.1.4.md](RELEASE_NOTES_v0.1.4.md) | `v0.1.4` 网页聊天真实流式输出与可重连 SSE 说明。 |
| [RELEASE_NOTES_v0.1.4.en.md](RELEASE_NOTES_v0.1.4.en.md) | English `v0.1.4` real web chat streaming and reconnectable SSE release notes. |
| [RELEASE_NOTES_v0.1.5.md](RELEASE_NOTES_v0.1.5.md) | `v0.1.5` 一键安装参数可靠性与全新服务器兼容性说明。 |
| [RELEASE_NOTES_v0.1.5.en.md](RELEASE_NOTES_v0.1.5.en.md) | English `v0.1.5` installer reliability and clean-server compatibility release notes. |
| [RELEASE_NOTES_v0.1.6.md](RELEASE_NOTES_v0.1.6.md) | `v0.1.6` 独立验证路径与安装后权限提示说明。 |
| [RELEASE_NOTES_v0.1.6.en.md](RELEASE_NOTES_v0.1.6.en.md) | English `v0.1.6` independent-validation and post-install privilege-hint release notes. |
| [RELEASE_NOTES_v0.1.7.md](RELEASE_NOTES_v0.1.7.md) | `v0.1.7` 版本化 Client API 与跨生态兼容门禁说明。 |
| [RELEASE_NOTES_v0.1.7.en.md](RELEASE_NOTES_v0.1.7.en.md) | English `v0.1.7` versioned Client API and cross-ecosystem compatibility-gate release notes. |
| [RELEASE_NOTES_v0.1.0.md](RELEASE_NOTES_v0.1.0.md) | 首个公开版本的 GitHub Release 草稿。 |
| [RELEASE_NOTES_v0.1.0.en.md](RELEASE_NOTES_v0.1.0.en.md) | English release notes. |
| [CHANGELOG.md](CHANGELOG.md) | 公开发布后的对外变更记录。 |
| [CHANGELOG.en.md](CHANGELOG.en.md) | English changelog. |
| [兼容性与升级.md](兼容性与升级.md) | SemVer、数据库迁移、契约稳定性和升级纪律。 |
| [COMPATIBILITY.en.md](COMPATIBILITY.en.md) | English compatibility and upgrade policy. |

## 维护纪律

- 新文档必须能归入上面某一类；如果归不进去，先判断是否只是临时讨论材料。
- 同一主题只保留一个主文档，其余文档必须说明自己是架构、契约、运行能力还是接入指南。
- 内部决策记录、发布演练、官网/控制台 UX 规范放 `internal/`，不进入公开分发物。
- 对外契约变更必须同步 [CONTRACT.md](CONTRACT.md)、SDK 示例和 [CHANGELOG.md](CHANGELOG.md)。
