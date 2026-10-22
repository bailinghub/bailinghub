# Agent知识按需搜索与读取

[English](AGENT_KNOWLEDGE_API.en.md) | [Runtime契约](AGENT_CLIENT_RUNTIME_API.md)

这是Agent Session专用的可选协议 `bailing.agent-knowledge.v1`。它只改变智能体客户端的补充知识交付，自带聊天、embed和widget继续由服务端按原配置自动检索并装配知识正文。知识是 `reference_only`，不能替代路由规则、能力机器约束、授权、审批、业务回执或未知调用核对。

## 协商与兼容

先以当前Agent bearer读取：

```http
GET /agent-api/v1/workspaces/:route/knowledge/capabilities
Authorization: Bearer <Agent access token>
```

响应schema为 `bailing.agent-knowledge-capabilities.v1`，包含 `protocol`、`supported: true`、`route`、`enabled`、`knowledge_scope_revision`、`delivery_modes: ["inline", "on_demand"]` 和固定 `limits`：

```json
{
  "search_max_results": 3,
  "search_max_bytes": 4096,
  "read_default_bytes": 16384,
  "read_max_bytes": 32768,
  "reference_ttl_seconds": 300,
  "read_chain_max_bytes": 131072
}
```

`supported`表示协议存在；`enabled`表示配置了知识来源且知识服务可用，不保证全部来源此刻都能检索。旧Core的404/405/501可视为不支持并保持inline，401/403/5xx及未知schema不能冒充成功。

仅显式支持协议的宿主可在新turn请求添加 `knowledge_delivery: "on_demand"`。服务端保留 `context.knowledge` / `knowledge_refs` 两个空数组，另回显：

```json
{
  "knowledge_delivery": {
    "schema_version": "bailing.agent-knowledge-delivery.v1",
    "mode": "on_demand",
    "protocol": "bailing.agent-knowledge.v1",
    "knowledge_scope_revision": "<sha256>",
    "status": "ok",
    "hints": []
  }
}
```

必要instructions、governance、memory和工具schema保持独立。无选项的旧客户端仍获原有有界正文。模式计入turn请求哈希，同turn切模式返回冲突；丢响应后应重试原选项，不创建新业务调用。这里没有 `off/hint/full` 参数，也不把旧轮内序号 `knowledge:1` 升为可读引用。

## 独立搜索

```http
POST /agent-api/v1/workspaces/:route/knowledge/search
Content-Type: application/json

{"query":"退款窗口设为0会怎样？","limit":3,"run_id":"<当前run UUID>"}
```

`query`非空、最多2000字符；`limit`为1–3。`run_id`可省略用于未加入受管理任务的会话；给出时必须属于当前Session/client/route且处于活跃context_ready状态。受管理任务沿用其成员和任务状态约束。内部turn装配可在preparing阶段生成同run提示，公开端点不能读取未就绪run。

结果schema为 `bailing.agent-knowledge-search.v1`，含route、可选run_id、独立 `knowledge_scope_revision`、`trust: "reference_only"`、`status`、`hints`和`truncated`。每个hint仅含 `ref`、`title`、`summary`、`revision`、`score`、`expires_at`；摘要来自当前有效命中片段的有界摘录，没有调用模型生成摘要。最多3篇父文档，整个JSON UTF-8最多4096字节，可能因预算少于3篇。不会附正文、memory、业务工具schema或连接凭据。

`status=ok`且hints为空表示本次无符合路由阈值的命中；`disabled`表示未配置；`unavailable`表示无法检索；`partial`表示部分库不可用。检索错误不能描述成“知识库没有资料”。相似度分数不是相关概率，也不为凑满数量降低路由阈值。知识搜索无需开启业务工具直调，不创建invocation/job或派发业务。

Agent专用检索读取当前索引并回查当前ready文档、归属及命中片段，不复用原生聊天的索引缓存。多个库按现有分数近似合并；跨模型分数不能视为统一概率，本批未更换召回算法。

## 按引用分页读取

```http
POST /agent-api/v1/workspaces/:route/knowledge/read
Content-Type: application/json

{"ref":"<搜索返回的ref>","run_id":"<同一个run UUID>","max_bytes":16384}
```

响应schema为 `bailing.agent-knowledge-read.v1`，包含route、可选run_id、knowledge_scope_revision、原ref、revision、title、content、trust、`next_cursor`、`truncated`、`budget_exhausted`、`total_content_bytes`、`read_chain_max_bytes`。下一页传同ref、同run和原样 `cursor`，不自行推导偏移。

`max_bytes`为4096–32768，默认16384，按完整响应JSON UTF-8字节计量，保持Unicode完整字符。`next_cursor`非空表示可继续；引用读取链正文最多128KiB，超过时最后一页 `truncated=true`、`budget_exhausted=true`、`next_cursor=null`。这不表示已读完整原文；客户端应说明资料不完整，不能无限翻页或把该上限说成每轮总用量限制。

引用和分页游标由现有server token域分离HMAC签名，自包含、5分钟有效，无新配置或迁移；相同实例密钥的进程可核验，密钥轮换后需重新搜索。引用绑定Client、Session、主体/on_behalf_of、route、可选run、完整知识配置及文档标题/正文SHA256修订。引用不是授权凭据，每次读取都重新检查当前身份、路由、任务、KB启用状态、归属、ready状态与文档修订。客户端不得传任意kb_ids/doc_id扩大范围。

篡改或跨身份引用返回 `400 knowledge_reference_invalid`；过期返回 `410 knowledge_reference_expired`；知识配置变化返回 `409 knowledge_scope_changed`；文档更新、删除或停用返回 `409 knowledge_changed`；服务不可用返回 `503 knowledge_unavailable`。需要重新搜索，不静默用新版正文替换旧ref，不重放业务写操作。响应均 `Cache-Control: no-store`，错误不包含内部地址、凭据、SQL或文档正文。

## 宿主职责

给模型独立的知识search/read工具和简短可见说明；工具发现不应强制读取文档，规则问答也不应被迫执行业务工具。将hint、分页正文保留为当前授权的参考资料，不能提升为system治理。根据回显模式和状态装配，不按空数组猜测“没有知识”。跨轮、换账号、换授权、换route或声明变化时隔离/失效缓存，并拒绝迟到响应污染当前上下文。

已有宿主命名context交付确认仍只解决重复装配；它不会代替本协议的搜索、读取或当前引用授权。必要业务前提必须同时由能力指导和服务端校验承载，不能只藏在可选知识里。
