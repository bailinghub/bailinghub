# 网页聊天增量输出协议

> 协议标识：`bailing.chat.stream.v1`

本文定义百灵中枢网页聊天组件的增量输出、断线重放、降级和持久化边界。这里的 `delta` 是模型提供商返回的文本片段，不承诺每个片段恰好对应一个 tokenizer token。

## 1. 设计边界

- 增量文本只用于当前界面的临时展示。
- 任务库中的终态结果是单一真值源；`done` 始终从该结果生成。
- 对话总账、Webhook 回调、渠道送达和最终附件/引用只消费终态结果，不消费中间片段。
- 审计可记录分片数、字符数、首段延迟和结束原因，不记录每个 `delta` 的正文。
- 工具调用、重试或降级可以使模型重新生成。客户端必须支持 `reset`，不得把两轮临时文本拼成一条最终回答。

## 2. 连接流程

1. 组件调用 `POST /chat/:entry_key` 创建任务，获取 `job_id`。
2. 组件连接 `GET /chat/:entry_key/events/:job_id`。
3. 服务端发送 `open`，然后持续发送任务状态和可用的增量事件。
4. 组件收到 `done` 后，用其 `reply` 替换临时气泡，再写入本地历史和附件/引用 UI。
5. 连接在窗口内中断时，标准 `EventSource` 使用 `Last-Event-ID` 自动重连。

## 3. SSE 事件

| 事件 | 关键字段 | 客户端行为 |
|---|---|---|
| `open` | `job_id`, `status`, `protocol`, `streaming` | 确认连接。`streaming:true` 表示当前实例具备增量转发通道，不保证上游一定返回片段。 |
| `status` | `job_id`, `status` | 可选展示 `queued/running/dispatched`。 |
| `phase` | `seq`, `ts`, `name`, `round` | `name` 为 `model` 或 `tool`；可选展示阶段，不得据此判定任务终态。 |
| `reset` | `seq?`, `reason`, `round?`, `latest_seq?` | 立即丢弃尚未完成的临时文本。 |
| `delta` | `seq`, `ts`, `text`, `round` | 把 `text` 追加到当前临时回答。 |
| `ping` | `ts`, `job_id` | 保活；无业务语义。 |
| `done` | `done`, `reply`, `job_id`, `visitor_id`, `references?`, `attachments?`, `error?` | 权威终态。用 `reply` 替换临时文本并关闭连接。 |
| `failed` | `done`, `error`, `reply` | 连接层无法继续读取该任务。 |
| `timeout` | `done:false`, `job_id` | 本次连接窗口结束；任务不一定失败，可通过历史回灌恢复。 |

`reset.reason` 当前可为：

- `model_round`：新的模型轮次开始；
- `tool_call`：模型改为调用工具，已生成的临时文本不是最终答案；
- `retry`：任务将重试；
- `fallback`：提供商明确不支持 streaming，本轮改为非流式；
- `replay_gap`：客户端游标早于服务端当前回放窗口，旧临时文本必须清空。

## 4. 序号与断线重放

- `phase/reset/delta` 在每个 `job_id` 内使用从 1 开始的单调 `seq`，SSE `id` 与 `seq` 一致。
- 客户端应忽略 `seq <= last_seq` 的重复事件。
- 服务端使用有界、有 TTL 的短期回放窗口，不把增量事件当作持久化日志。
- 游标已经落后于回放窗口时，服务端发送 `reset: replay_gap`，然后从尚可用的最早事件继续。

## 5. 模型提供商与降级

- 只有当当前调用有增量消费者时，`llm` 适配器才会向 OpenAI-compatible `/chat/completions` 发送 `stream:true`。
- 路由可通过 `target_config.streaming: false` 显式关闭。
- 如果提供商忽略 `stream:true` 并返回普通 JSON，中枢直接按非流式结果处理。
- 只有提供商以 400/404/415/422/501 且错误文本明确指出 streaming 不支持时，中枢才重试一次 `stream:false`。
- 超时、限流、5xx 或不明确的 4xx 不会因为“尝试降级”而额外重发，避免重复工具或业务操作。

## 6. 多副本与反向代理

默认 `InMemoryJobStreamBroker` 是单进程短期传输实现。多副本时二选一：

1. 对同一 `job_id` 使用粘性路由，让任务执行副本和 SSE 连接一致；
2. 通过组合根注入共享 `JobStreamBroker` 实现。

无论增量 broker 是否可用，终态任务仍在 MySQL 中，`done` 不依赖进程内片段。

反向代理/CDN 需要：

- 关闭响应缓冲和转码；
- 保留 `text/event-stream`；
- 读取超时大于聊天连接窗口；
- 允许标准 `Last-Event-ID` 请求头。

## 7. 兼容性

- 这是 Widget API v1 下的可选事件扩展，不改变 `done` 结构。
- 旧客户端可以忽略 `phase/reset/delta`，继续只等待 `done`。
- 新客户端必须把 `done` 视为最终权威值，不得仅凭已收到的 `delta` 宣称任务完成。

## 8. 验证

```bash
npm run typecheck
node --import tsx --test \
  src/adapters/llm/openai-chat-stream.test.ts \
  src/adapters/targets/llm.test.ts \
  src/core/runtime/job-stream.test.ts \
  src/routes/chat.test.ts \
  src/routes/public.test.ts
```

完整发布前还应运行 `npm test`、控制台构建和 `npm run docs:check`。
