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
| [user-guide/README.md](user-guide/README.md) | 使用者/产品经理视角：从业务需求出发，理解为什么需要中枢、后台菜单怎么配、配完交给开发者什么。 |
| [CONTRACT.md](CONTRACT.md) | 业务系统和中枢之间的稳定网络契约，接入前应先读。 |
| [CONTRACT.en.md](CONTRACT.en.md) | English HTTP and wire contract summary. |
| [第三方对接指南.md](第三方对接指南.md) | 业务侧如何暴露工具、验签、授权与返回结果。 |
| [INTEGRATION.en.md](INTEGRATION.en.md) | English third-party integration guide. |

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

## 发布与维护

| 文档 | 用途 |
|---|---|
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
