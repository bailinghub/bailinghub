# DeepSeek + BailingHub 双语 E2E 接入配方

> 状态：BailingHub 已完成 DeepSeek V4 模型目录更新、流式响应解析和思考模式工具调用的自动化兼容测试。DeepSeek 官方 API 的真实无副作用 E2E 仍待使用临时 API Key 完成。本文不代表 DeepSeek 官方合作、认证或推荐。

[English](README.en.md)

## 解决什么问题

DeepSeek 可以理解用户目标、生成回答并选择工具，但它不应该持有业务系统密钥，也不应该绕过治理边界自由调用退款、库存、账号或审批 API。

推荐链路是：

```text
user / channel
  -> BailingHub route
  -> DeepSeek V4                  理解目标、生成内容、提出工具调用
  -> BailingHub tool runtime      白名单、主体、风险、审批、审计、幂等
  -> business API                 业务系统保留最终授权
```

这里的职责划分是：

- DeepSeek 是模型与任务规划者；
- BailingHub 是自部署的业务动作治理控制面；
- 业务系统仍然是最终权限与业务规则的权威来源。

## 当前兼容基线

截至 2026-07-27，DeepSeek 官方 API 的当前文本模型为：

- `deepseek-v4-flash`
- `deepseek-v4-pro`

官方 OpenAI-compatible Base URL：

```text
https://api.deepseek.com
```

旧别名 `deepseek-chat` 与 `deepseek-reasoner` 已退出当前模型目录，不应继续作为新配置的默认值。模型列表会继续演进，部署前请以 DeepSeek 官方文档为准。

两个当前模型均可用于文本、流式输出与工具调用。BailingHub 不启用供应商专属路由语义，而是通过通用 OpenAI-compatible 适配器接入。

## 为什么需要保留 `reasoning_content`

DeepSeek 思考模式在工具调用场景中会返回 `reasoning_content`。当模型提出工具调用后，调用方需要在下一轮请求中把该字段随 assistant 消息原样带回。

BailingHub 的通用适配器会：

1. 在流式响应中聚合分片的 `reasoning_content`；
2. 不把思考内容作为面向用户的正文增量输出；
3. 在工具执行完成后的下一轮模型请求中保留该字段；
4. 继续由 `content` 承载用户可见回答。

这是 OpenAI-compatible 消息兼容能力，不是 ACC Core 字段，也不会改变 BailingHub 的工具治理语义。

## 前置准备

需要：

- 一套使用 MySQL 的自部署 BailingHub；
- 一个专用于测试的 BailingHub Client Token；
- 一条无业务工具、无写操作的测试路由；
- 一个新生成、可随时轮换的 DeepSeek API Key。

不要使用：

- BailingHub 管理员 Token；
- 执行器 Token；
- 业务系统密钥；
- 生产主体凭据；
- 包含真实客户数据的测试输入。

## 1. 创建模型凭证

在 BailingHub 控制台进入“模型凭证”，创建：

| 字段 | 建议值 |
| --- | --- |
| 名称 | `deepseek-main` |
| 服务商 | DeepSeek |
| Base URL | `https://api.deepseek.com` |
| API Key | DeepSeek 临时测试 Key |
| 默认模型 | `deepseek-v4-flash` |

密钥只保存在 BailingHub 中，不应写入路由、任务输入、文章、截图或版本库。

## 2. 创建无副作用测试路由

在“触发路由”中新建一条专用路由：

| 字段 | 建议值 |
| --- | --- |
| 场景标识 | `deepseek-e2e` |
| 调度目标 | `llm` |
| 模型凭证 | `deepseek-main` |
| 模型 | `deepseek-v4-flash`，也可以留空使用凭证默认模型 |
| 系统提示词 | `Follow the user instruction exactly. Do not call any tool.` |
| 工具来源 | 不配置 |
| 内置工具 | 不配置 |
| 流式输出 | 可以开启 |

这一步只验证：

- BailingHub 能调用 DeepSeek 官方 API；
- 中英文输入能够返回预期标记；
- 流式响应能够收口为权威任务结果；
- 测试不会触碰真实业务 API。

## 3. 创建专用接入方

在“接入方”中创建一个只允许 `deepseek-e2e` 的测试 Client：

- 使用独立 Client Token；
- `allowed_routes` 只包含 `deepseek-e2e`；
- 设置较低的每分钟限速；
- 测试完成后可以禁用或轮换 Token。

## 4. 运行中文和英文 E2E

验证脚本只依赖 Python 标准库。它不会打印 Token，也不会输出完整任务内容。

中文：

```bash
BAILINGHUB_TOKEN='<dedicated client token>' \
python3 verify_e2e.py \
  --base-url 'https://hub.example.com' \
  --route 'deepseek-e2e' \
  --input '请只返回 DEEPSEEK_BAILINGHUB_E2E_OK，不要调用任何工具。'
```

英文：

```bash
BAILINGHUB_TOKEN='<dedicated client token>' \
python3 verify_e2e.py \
  --base-url 'https://hub.example.com' \
  --route 'deepseek-e2e'
```

通过标准：

1. `/run` 返回 `job_id` 和相同的 `request_id`；
2. 任务在限定时间内进入 `done`；
3. 权威任务记录中包含 `DEEPSEEK_BAILINGHUB_E2E_OK`；
4. 日志和终端不出现 API Key 或 Client Token；
5. 整个测试不调用业务工具。

## 5. 再启用受治理工具

无副作用 E2E 通过后，再把真实工具来源或内置工具加入另一条业务路由。

模型提出工具调用不等于工具一定会执行。BailingHub 仍会检查：

- 该工具是否进入路由白名单；
- 当前主体是否满足要求；
- 风险等级和条件审批是否触发；
- 参数是否和已批准快照一致；
- 幂等键、速率限制与审计约束是否满足；
- 业务系统是否最终授权。

不要为了验证模型会不会选工具，直接把生产写操作接到测试路由。

## 已验证与未声称

已由代码与自动化测试验证：

- DeepSeek 官方 Base URL 与当前 V4 模型建议已进入控制台目录；
- JSON 与 SSE 两类 OpenAI-compatible 响应均可解析；
- 流式 `reasoning_content` 会被聚合，但不会泄露成用户正文；
- 思考模式下的工具调用可以把 `reasoning_content` 带入下一轮请求；
- 上述兼容实现不修改 ACC Core，也不让模型取得业务系统权威。

完成真实 API E2E 前不声称：

- 已在 DeepSeek 官方 API 上完成中文和英文实测；
- 任意模型、任意提示词都能稳定选择正确工具；
- DeepSeek 与 BailingHub 存在官方合作、认证或生态背书；
- BailingHub 会展示、保存或审计模型的完整思考过程；
- 供应商测试版 strict tool call 行为已成为 BailingHub 的稳定契约。

## 安全收口

真实验证完成后：

1. 轮换或删除临时 DeepSeek API Key；
2. 禁用测试 Client，或轮换其 Token；
3. 保留脱敏后的状态序列、BailingHub 版本、模型 ID 和测试时间；
4. 不保留思考内容、业务凭据或真实客户数据作为公开证据。

## 一手依据

- [DeepSeek API Pricing and Models](https://api-docs.deepseek.com/quick_start/pricing)
- [DeepSeek List Models API](https://api-docs.deepseek.com/api/list-models)
- [DeepSeek Tool Calls](https://api-docs.deepseek.com/guides/tool_calls)
- [DeepSeek Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode)
- [DeepSeek Integrations](https://github.com/deepseek-ai/awesome-deepseek-integration)
- [BailingHub HTTP contract](../../CONTRACT.md)
- BailingHub `src/adapters/llm/openai-chat-stream.ts`
- BailingHub `src/adapters/targets/llm.ts`
