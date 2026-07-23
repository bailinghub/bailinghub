# BailingHub v0.1.7：版本化 Client API 与跨生态兼容门禁

`v0.1.7` 将外部工作流与 Agent 平台使用的公开 Client API 收敛为独立、可机器验证的稳定契约，并为 Dify 与 n8n 适配器建立双向兼容门禁。

## 为什么发布这个补丁

BailingHub、Dify 插件和 n8n 节点此前已经能够通过 `/run` 与 `/jobs/{job_id}` 协作，但接口约束分散在实现、文档和各适配器中。只靠人工同步，核心服务新增字段、改变状态或收紧校验时，可能直到某个适配器运行失败才发现契约漂移。

这次发布把“能调用”升级为“能证明彼此仍然兼容”：核心服务拥有唯一的机器契约，适配器显式声明自己消费的字段与状态，三个仓库在合并前互相验证。

## 本次变化

- 新增 `bailing.client-api.v1` 机器契约，覆盖 `GET /health`、`POST /run`、`GET /jobs/{job_id}`、认证方式、错误分类和任务状态；
- 通过 `/contracts/client-api/v1/` 公开 manifest、JSON Schema 与行为测试向量；
- 核心 CI 校验当前 Dify 与 n8n 适配器，适配器 CI 反向校验目标核心分支；
- Client API 请求现在严格校验顶层字段、`route`、`metadata`、`callback_url`、`request_id` 与输入长度；
- 旧 `/schemas/api/*` 地址继续存在，并转向版本化契约，避免文档入口分裂；
- 明确 Client API 与执行器协议的边界：OpenClaw 和便携执行器仍使用独立的 claim、heartbeat、lease 与结果回报协议。

## 升级与兼容性

不需要数据库迁移。按照公开文档使用 `request_id`、`route`、`input`、`metadata` 和 `callback_url` 的客户端无需修改；Dify `0.1.2` 与 n8n `0.1.0` 已通过契约检查。

依赖未声明顶层字段（例如客户端自行传入 `source`）的非正式接入将收到 `400`，应删除该字段。调用来源由中枢根据已认证的 client 身份写入，客户端不能自行声明。

Client API 契约版本与 BailingHub、插件、节点的软件版本独立演进。兼容的响应扩展允许新增；新增必填请求字段、认证变化或任务状态语义变化必须进入新的契约主版本。

## 验证

- `npm run client-api:contract`；
- `npm run client-api:ecosystem:local`；
- `npm run client-api:ecosystem:clone`；
- `npm run typecheck`；
- `npm test`；
- `npm run docs:check`；
- `npm run release:check`；
- Dify 插件与 n8n 节点各自的兼容声明、测试和打包检查。

完整契约说明见 [CLIENT_API.md](CLIENT_API.md)。
