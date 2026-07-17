# v0.1.0 Release Notes

百灵中枢 `v0.1.0` 是首个公开版本。它定位为可自托管、可验证、可二次开发的 Agent 控制面，采用 [ACC（Agent Capability Contract）](https://www.agentcapability.org) 的开放契约心智：业务系统通过 HTTP 契约触发任务或嵌入聊天入口，中枢负责路由大脑、装配上下文、治理工具调用、记录审计与追溯，并把结果送回业务侧。ACC 独立规范仓库见 [agent-capability/agent-capability-contract](https://github.com/agent-capability/agent-capability-contract)。

## 适合谁

- 已有传统业务系统，希望让 Agent 安全调用业务接口；
- 希望把 chatbot、agent、工具调用、审批、审计和送达统一治理的团队；
- 需要私有部署、保留业务系统边界、逐步接入 AI 能力的开发者和集成商。

## 快速体验

不想先部署，可以直接进入 [在线体验](https://trial.bailinghub.com/console/login)，注册后查看控制台、导入演示数据并运行系统体检。在线环境仅用于了解产品和验证配置心智，请勿上传生产凭据、敏感数据或接入真实业务。

需要在自己的环境跑通完整闭环时：

```bash
curl -fsSL https://www.bailinghub.com/install.sh | sh
```

或者在源码目录直接运行：

```bash
export BAILING_TOKEN="${BAILING_TOKEN:-$(openssl rand -hex 32)}"
docker compose up --build
```

打开 `http://localhost:18900/console/`，默认 demo 账号为 `admin / bailing-demo-admin`。一键安装脚本会生成随机密码，并在安装完成时打印。

## 这个版本包含什么

- 中枢运行时：触发路由、DB 调度队列、同 thread 串行、租约恢复、优雅停机；
- 控制台：路由、目标、工具源、接入方、渠道、凭证、知识库、任务追溯和系统体检；
- 工具治理：OpenAPI `x-agent-capability` 扩展、白名单、风险分级、集中限速、审批意图、审计追溯和签名调用；
- 知识与记忆：知识检索注入、页面上下文、会话总账和可选滚动摘要；
- 开源体验：Docker demo、示例业务系统、一键安装脚本、公开 schema、PHP/PHP7/Node/Python/Java/Go/.NET SDK 示例；
- 发布保障：`release:check`、OSS/GitHub 仓模拟、文档链接检查、示例配置校验、安全扫描和镜像 tag 检查。

## 和 chatbot / workflow / MCP 的区别

- 不是普通 chatbot：它治理的是“AI 如何进入业务系统并调用工具”；
- 不是传统 workflow：它不要求把所有路径画死，而是在可审计边界内动态选择大脑、知识、工具和送达策略；
- 不替代 MCP：MCP 是工具生态协议，中枢负责业务侧身份、权限、风险、限流、审批和审计。后续版本会继续评估 MCP 出站/入站设计。

## 已知边界

- 首版官方镜像优先覆盖 `linux/amd64`；ARM 场景建议使用源码构建，或自行确认镜像兼容；
- MCP 双向能力尚未发布；
- 持久化 outbox、全局分布式并发预算、结构化 request trace id 属于后续增强；
- 生产部署前仍需要自行完成域名、证书、备份、监控、密钥管理、凭证轮换和审批流程接入。

## 发布前验证

维护者发布前应执行：

```bash
npm run release:check
npm run images:check
```

并确认：

- `https://www.bailinghub.com/install.sh` 可访问；
- `https://www.bailinghub.com/connect/bailinghub-source.tgz` 可下载；
- `https://www.bailinghub.com/version.json` 显示当前版本与构建信息；
- `github.com/bailinghub/bailinghub` 指向公开仓库。
