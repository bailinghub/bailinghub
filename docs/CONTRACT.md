# 百灵中枢 · 边界契约

> 当前契约：`bailing.contract.v2.12`。这是业务系统与中枢之间唯一的网络边界。

**冻结它，两边就能各自独立开发。** 任何字段变更都按兼容方式演进（只增不改语义、不删字段）。

中枢自身的配置契约同时提供机器可读版本：`GET /schemas/config/<name>.schema.json`。当前包含 `route`、`target`、`tool-provider`、`channel`、`storage-bucket`、`client`、`executor-token` 和公共定义 `common`，后台表单、部署向导、第三方运维脚本应优先消费这些 schema。

## 0. 鉴权：三种凭证

| 身份 | 凭证 | 能做什么 |
|---|---|---|
| **接入方（业务系统）** | `bz_clients` 的 per-caller token（admin 后台发放，可换钥/吊销） | `POST /run`（仅白名单内的 route）+ `GET /jobs/:id`（仅自己触发的） |
| **管理（运营方）** | `server.token` | 全部：admin 后台 / 执行器通道 / kill switch / 任意 run |
| **执行中任务（大脑）** | `tool_token`（任务级短凭证，随认领件下发，任务终态即失效） | 仅 `POST /jobs/:job_id/tools/invoke`（见 §2.4，且只够到该任务路由白名单内的工具） |

带法：`Authorization: Bearer <token>`（推荐）或 `?token=`。接入方策略硬约束：
- **必须走 `route`**，不可自带 `project` / `profile`（路由配置由中枢后台决定）→ 违者 403；
- 路由须在该接入方 `allowed_routes` 白名单内 → 403；
- 超出 `rate_limit_per_min` → 429（稍后用**同 request_id** 重试，幂等不重复跑）；
- `request_id` 与其他接入方撞号 → 409（建议统一加自身 app_id 前缀，admin 生成的调用代码已内置）。

「这条请求**替哪个终端用户**发起」（店老板/财务/C端…）依然由业务层鉴权后在 `metadata` 里声明，中枢不做人的身份判定。

## 1. 触发：`POST /run`

业务侧 fire-and-forget 调用，**立即返回**，绝不同步等待调查结果。接入代码不必手写：admin 后台路由行「调用代码」按钮生成可粘贴的 PHP/curl（自带 2s 超时 + 异常吞掉的解耦保护）。

请求体：

| 字段 | 必填 | 说明 |
|---|---|---|
| `request_id` | 是 | 幂等键。同 `request_id` 重复调用返回同一个 job，不重复跑 |
| `route` | 接入方必填 | 触发路由 key（admin 后台配置 → 解析出 target/project/会话策略/能力档）；也可传 `"auto"` 让中枢按路由 Audience/关键词/优先级分诊 |
| `input` | 是 | 业务事件正文（工单/审查请求/任意任务）。**被当作不可信数据**，不作为指令执行 |
| `project` | 仅管理身份 | 显式指定项目（与 route 二选一；接入方禁用） |
| `profile` | 仅管理身份 | 能力档名（接入方禁用，由路由决定） |
| `source` | 否 | 来源标识；接入方缺省自动记为其 app_id |
| `metadata` | 否 | 透传对象（如 `{ticket_id, tenant_id}`），原样回带；推荐带 `principal` 标准主体；`per_key` 会话策略从这里取键；`passthrough` 会话策略从这里取 `session_id`（业务自管的执行器会话 id，给了续它、不给新建） |
| `callback_url` | 否 | 调查完成后把完整 job POST 到此地址；不填则靠轮询 |

响应（HTTP 202）：

```json
{ "job_id": "uuid", "status": "queued", "request_id": "...", "route": "ticket-triage", "target": "...", "session_id": "uuid", "continue": false }
```

被 kill switch 暂停时返回 HTTP 503 `{ "status": "paused" }` —— 业务侧应据此**降级到人工队列**，不要重试风暴。

### 1.0.1 标准主体与 Audience 策略

业务层仍然负责登录态、租户和权限判断；中枢只消费业务侧声明出的标准主体，用于路由受众、预算、审批、追溯和工具授权上下文。

推荐写法：

```json
{
  "metadata": {
    "ticket_id": "10086",
    "principal": {
      "id": "u-1001",
      "tenant": "t-179",
      "roles": ["staff", "cs"],
      "audience": "employee"
    }
  }
}
```

兼容写法：`metadata.user_id / uid / operator_id / principal_id`、`tenant / tenant_id`、`role / roles`、`audience` 也会被归一，但新接入建议统一使用 `metadata.principal`。中枢落单后会把标准主体写回 job 的 `metadata.principal`，并把总账主体记为 `t:<tenant>|p:<id>` 或 `p:<id>`。

路由可配置 `audience`：

```json
{
  "auto": true,
  "priority": 20,
  "keywords": ["退款", "售后"],
  "clients": ["crm"],
  "tenants": ["t-179"],
  "roles": ["cs"],
  "audiences": ["employee"],
  "anonymous": false
}
```

- 显式调用某 route 时，`audience` 是硬闸；主体不满足返回 403。
- `route:"auto"` 时，中枢只在接入方白名单内选择 `audience.auto=true` 或配置了 `keywords` 的路由；多个同分候选返回 409，要求提高 `priority` 或补关键词。
- `audience` 不替代业务权限表。它只决定“这个主体能否进入这条 AI 车道”；具体工具能不能执行，仍由业务工具授权闸按 `On-Behalf-Of` fail-closed 裁决。

后台提供只读分诊预演接口，使用与真实 `/run route:"auto"` 相同的规则，不建单、不触发模型、不消耗接入方限速：

```text
POST /admin/api/routes/auto-preview
```

请求体：

```jsonc
{
  "input": "客户申请退款",
  "client_app_id": "crm",
  "channel": "crm",
  "principal": { "id": "u-1001", "tenant": "t-1", "roles": ["cs"], "audience": "employee" },
  "metadata": { "order_id": "1001" }
}
```

响应包含 `selected_route`、候选得分、命中原因，以及每条路由被过滤的原因（如 `client_not_allowed`、`role_not_allowed`、`auto_not_enabled`）。控制台「系统体检 → route=auto 预演」即使用该接口。

## 1.1 聊天入口：网页同步问答的公开面

控制台「聊天入口」建入口（绑一条触发路由）→ 任意网页贴一行 `<script src="<中枢>/widget.js" data-entry="pub_xxx" async></script>` 即得聊天组件。**落点是路由**：背后是 llm 还是执行器智能体，入口无感。

公开端点（无需任何 token；`entry_key` 设计为可公开）：

| 端点 | 说明 |
|---|---|
| `POST /chat/:entry_key` | 体 `{message, visitor_id?, ticket?, thread_id?}`。`thread_id`（字母数字_-，≤32 字符）：同一身份下的平行会话切分键——开新会话=换新值，延续已有会话=复用，不带=单线程续聊；会话与对话总账同键切分，且写入 metadata.thread_id 供任务详情对账。返回 `{done:false, job_id, visitor_id}` 后，组件通过 SSE 结果流接收状态和最终回答 |
| `GET /chat/:entry_key/events/:job_id` | **SSE 结果流**：只能订阅本入口发起的任务，事件包括 `open/status/ping/done/failed/timeout`；`done` 事件携带 `{done:true, reply, job_id, visitor_id, references?, attachments?}` |
| `GET /chat/:entry_key/thread?visitor_id=&thread_id=&ticket=` | **拉服务端会话总账**：组件重开、或异步迟到结果（如审批批准后重跑的回复落在另一条任务里）回灌用——按与提问一致的身份重建线索、只读返回正序消息。身份纪律同 `POST /chat`（带票按 uid、无票按 visitor，票坏=401） |
| `GET /chat/:entry_key/config` | 组件状态与配置：停用入口返回 `{enabled:false}`，组件静默不挂载；启用时返回标题/开场白/主色/品牌，**外观**（窗口尺寸/标题对齐/气泡位置与偏移/头像/自定义气泡图标/底部品牌标识）、`upload`。控制台改完后，业务页面无需改嵌入代码 |
| `POST /chat/:entry_key/rate/:job_id` | **评价回答**：体 `{rating:"up"\|"down"\|"note", visitor_id, comment?}`；`note` 表示只提交文字反馈，此时 `comment` 必填。只能评自己问出来的那条（visitor_id 须与提问时一致）；一答一评，重评覆盖。运营在控制台「聊天入口 → 评价」看汇总 |

**引用来源**：路由挂了知识库时，回答附 `references: [{seq, title, score, snippet}]`（本次检索命中），正文中模型按 `[n]` 标注实际引用的资料编号——消费方可据此展示"答案出处"。完整快照（含 doc_id）在 job 的 `dispatch.kb_refs`，`/run` 触发的任务同样携带。

**富内容**：`reply` 为 markdown；同时附 `attachments`（图片/文件的结构化数组），无 markdown 渲染器的端据此渲染——见 §2.5。

防滥用三件套：站点 **Origin 白名单**（浏览器 Origin 不可伪造；空=未限制）、**按 IP 限速**（默认 20/分钟）、入口可停用/删除。CORS 全放开（公开面无 Cookie）。

**身份纪律（与总纲一致）**：网页访客默认是**匿名主体**。`visitor_id` 是组件存 localStorage 的随机串，只用于会话/线索连续性（同访客自动续聊），**不是身份凭证**；metadata 由中枢服务端构造，组件带不进业务操作主体——绑了工具的路由查公开数据可用，写操作业务侧自然拒（on-behalf-of 恒空）。

**签名访客票据**：要让"登录用户"在组件里带可信身份，入口配置「票据签发方」（一个接入方 app_id）后，业务后端在登录态里用**自己的接入方 token** 签发短票：

```
payload = base64url( {"uid":"<业务用户ID>","exp":<unix秒过期>} )
ticket  = "v1." + payload + "." + HMAC_SHA256_hex(接入方token, payload)
```

页面把票据输出给组件（`<script ... data-ticket="<票据>">`，游客不输出即匿名）。中枢验签通过后：`metadata.visitor_uid = uid`（可作路由 tools 的 `subject_field`），会话/线索改按 uid 续（同一人换设备也接得上）。票坏/过期 → 401（不静默降级，避免掩盖集成 bug）。身份仍在服务端可信代码里确立——**接入方 token 永远不进前端**。

## 1.2 网页聊天的两个运行时增强

这两项由组件自动上报 + 中枢服务端处理，**业务侧零代码**，只在控制台配置：

- **页面上下文（page context）**：组件每条消息自动带上访客当前页面（`location` 的 path+query+hash，对 token/手机号等敏感键「留键抹值」脱敏 + `document.title`）。中枢按控制台「聊天入口 → 页面登记」的登记表（URL 模式 / 显式 `page_key` → 页面名+说明）**寻址**出用户所在页面，注入【当前页面】线索帮 AI 定位问题（如在分销页提问更可能是问分销）。命中页面落 `metadata.page_context`，控制台任务详情「发起页面」可见。**寻址（URL→哪个页面）走精确/模式匹配的登记表，不丢给向量检索**；页面→该看哪些文档才交给知识库（路由开「页面感知检索」时把页面主题前置进 KB 检索 query 偏置本页文档，全局仍兜底）。安全：页面上下文是**用户侧可伪造线索**，只作理解/检索提示，**绝不用于鉴权或工具放行**。
- **运营启停与品牌**：控制台可直接暂停某个聊天入口。已嵌入的 `script` 无需删除，组件在公开配置返回停用状态后不会展示悬浮按钮，同时聊天、历史、上传和评价端点继续在服务端拒绝访问；恢复入口后，下次加载页面自动重新展示。外观页可隐藏底部品牌标识，或把默认“由百灵中枢驱动”替换为部署方自己的文案。
- **对话记忆层（rolling summary）**：路由级可配（控制台「触发路由 → 对话记忆」，**默认关、行为不变**）。开启后超过水位线的早期对话被**异步增量压缩**成结构化摘要（关键事实/已定决策/待办/用户偏好），后续派发把「摘要 + 最近若干轮」一起注入，长会话不爆上下文。总账（`bz_messages`）始终是真值，摘要只是缓存视图。

## 2. 查询：`GET /jobs/:job_id`

返回完整 job 对象（见下）。

管理后台排障使用更完整的 trace 聚合接口：

```text
GET /admin/api/runs/<job_id>/trace
GET /admin/api/runs/trace?job_id=<job_id>
GET /admin/api/runs/trace?request_id=<request_id>
GET /admin/api/runs/trace?client_id=<app_id>&limit=20
GET /admin/api/runs/trace?thread_id=<thread_id>&limit=20
GET /admin/api/runs/trace?principal_id=<principal_id>&limit=20
```

唯一命中时返回 `{job, trace, approvals, messages, lookup, debug_bundle, debug_report}`；多命中时返回 `{matches, count}`，由调用方再选择具体 job_id。`debug_bundle` 是可转给接入开发者的结构化排障包，包含标识、标准主体、调度租约快照、当前 route 配置快照、落单时 dispatch 快照、审批、送达死信、会话消息预览、trace events 和规则化 `diagnosis` 建议。`debug_report` 是基于同一份脱敏排障包生成的 Markdown 报告，适合直接贴给接入方研发或归档到工单。排障包默认执行统一脱敏：凭证、令牌、密钥、常见手机号、邮箱、身份证和 token-like 字符串会被遮蔽。控制台「任务 → 追溯」只导出 `debug_bundle` / `debug_report`，文件名使用 `bailing-redacted-debug-<job>.json` 和 `bailing-debug-report-<job>.md`，用于和原始 `job/trace` 后台查看权限明确区分；部署方仍应按自身合规要求确认是否可外发。

后台系统体检提供一键 smoke：

```text
POST /admin/api/smoke
```

返回 `{hub, pass, fail, skip, checks, run}`。检查项覆盖健康入口、控制台静态入口、公开 schema、后台版本、配置体检、`route=auto` 预演；如果环境中存在启用的 `demo-app + demo_support`，会自动额外执行 `/run + jobs + trace + debug_bundle 脱敏声明`，用于开源 demo 的完整闭环验收。

## 2.1 知识检索：`POST /kb/search`

图书馆的纯检索口（只还原料，不做问答；问答走 `/run` 的路由+knowledge 注入）。

```jsonc
// 请求（admin token 或接入方 token；接入方与 /run 共用限速桶）
{ "kb_id": "cs-faq", "query": "会员卡退不了怎么办", "top_k": 5, "min_score": 0.35 }
// 响应
{ "kb_id": "cs-faq", "hits": [ { "score": 0.757, "content": "…", "doc_id": 1, "title": "…", "seq": 0 } ] }
```

知识库不可用时返回 400 带 error——调用方按可选服务降级，不得阻塞自身主流程。

> **向量存储与规模（文档此前空白，补明）**：embedding 向量以 **L2 归一化的 Float32 存在中枢状态库 MySQL**（`bz_kb_chunks` 的 MEDIUMBLOB），检索是**整库载内存暴力点积**（cosine 相似度），约 1 万 chunk≈40MB/单次 <10ms。这是**有意的单栈选择**——不引 pgvector / 外部向量库，守住"单依赖、可审计"的工程哲学；到十万级 chunk 以上再换专用向量库（检索 API 不变，是 `kbService` 内部实现）。所以"用 MySQL 存向量"是定位为中小规模的刻意取舍，不是临时方案。

## 2.1.1 知识库入库插座：业务系统把自家数据推进知识库

业务数据库内容（帮助中心文章、工单处理流程等）入知识库的正道：**业务侧把行渲染成 markdown 主动推过来**——中枢不猜业务 schema。鉴权 = 接入方 token（与 /run 同一把）；前置 = 控制台「知识库 → 库设置 → 可写接入方」勾选该接入方。

```text
PUT    /kb/{kb_id}/docs/{source_key}   体 {"title":"…","content":"markdown 或纯文本"}
       → {ok:true, doc_id, created:true|false, status:"embedding"}   // 向量化异步，几秒后就绪
DELETE /kb/{kb_id}/docs/{source_key}   → {ok:true}                   // 文档与向量一并删除
GET    /kb/{kb_id}/docs                → 文档清单（source_key/status/chunk_count）——定时对账用
```

- **幂等键 `source_key`**（`[A-Za-z0-9_.:-]{1,128}`，如 `help_article_123`）：同 key 再推 = 覆盖原文并整篇重算向量，不产生重复文档；控制台手工添加的文档无 source_key，互不冲突。
- **同步策略**：业务「保存/删除」钩子里实时调一次 + 每天 GET 清单对账补漏，双保险。
- **限制**：单篇 ≤ 30 万字符（一篇文档一个主题检索效果最好）；写入与 /run 共用接入方限速桶（embedding 花的是真钱）。
- **图片约定**：内容里用 `![说明](https://…)` 链接，检索命中后 Agent 可在回答里带出、聊天组件渲染成图；**base64 内嵌图入库时会被替换为占位符**——知识库只存文字与链接，图片本体放业务自己的存储/CDN。
- 失败语义：未知 kb → 404；不在可写白名单 → 403；超限 → 400/429。推送后以 GET 清单的 `status` 为准（`error` 时带原因）。
- **数据源连接器**：拉取式的替代选项——控制台「知识库 → 数据源」配「连接 + 取数 SQL + 字段映射」，中枢定时拉业务库自动同步（复用本管道；source_key 前缀 `ds{id}:` 与推送文档隔离；内容指纹未变跳过重嵌；行消失对账下架；只读硬校验 + 建议只读账号）。表结构规整选连接器（零业务代码），渲染复杂/库不可达选推送 API。

## 2.2 外发签名（回调 / webhook 送达）

中枢主动发给业务系统的每个 HTTP POST（`callback_url` 回调、`delivery.type=webhook` 送达）都带签名头：

```
X-Bailing-Timestamp: 1765379100000              # 毫秒时间戳
X-Bailing-Signature: sha256=<hex hmac-sha256>   # "sha256=" + HMAC_SHA256(secret, "<毫秒timestamp>.<原始请求体>")
```

> 签名标签 `sha256=` 是算法名、全框架统一（与工具调用、spec 拉取同款；非版本号，没有 v 几）。回调构造比工具签名短（仅 `ts.body`、且 ts 是**毫秒**）。

- **secret 解析链**：触发方接入 token（你调 /run 用什么 token 验签就用什么）→ 聊天来源任务用**该入口"票据接入方"的 token**（与签访客票据同一把钥匙，签票/验票/收回调一钥贯通）→ 都没有才落 server.token（仅 admin 自触发场景）。无需另发密钥。
- 验签示例（PHP）：`$mac = hash_hmac('sha256', $_SERVER['HTTP_X_BAILING_TIMESTAMP'] . '.' . file_get_contents('php://input'), $myToken); $ok = hash_equals('sha256=' . $mac, $sig);`，并校验时间戳与当前差值 < 300 秒防重放（注意此处时间戳是**毫秒**，与工具调用签名的秒级不同）。Node/Python 见 `docs/examples/bailing-tool-verify.{mjs,py}` 的 `verifyCallback`。
- **webhook 送达载荷**：`{kind:"delivery", job_id, request_id, route_name, status:"done"|"error", message(成品通知文案), text(AI 回复原文 markdown|null), attachments(图片/文件结构化数组，见 §2.5), report(结构化报告|null), error(失败原因|null), metadata(任务 metadata 原样透传——含 chat_entry/visitor_uid/thread_id 等定位键), finished_at}`。**成功与失败都会回调**（失败仅回调 webhook，不推人渠道）；`callback_url` 回调的载荷则是完整 job 对象。
- **文案字段分工**：`message` 是带「【路由名】结果通知」抬头与品牌落款的**成品**，供直接转发推送渠道（企微/短信）用，全程无 emoji；回灌**聊天气泡/对话流**请用 `text`（AI 回复原文，零包装）；`status:"error"` 时 text 为 null，取 `error` 自行措辞。中枢**不提供文案模板配置**——展示权归业务侧，载荷已给齐全部原料字段，按场景取用即可。
- 投递可靠性：共 3 次尝试（立即 / +2s / +10s，单次 10s 超时）；HTTP 4xx（除 429）视为对方明确拒绝不再重试；5xx/429/网络错误重试，耗尽后记审计 `delivery_webhook{final:true}` 不再补投。**非持久队列**——业务方按 job_id 幂等去重（同一 job 重跑会再次回调，以 finished_at 新者为准）；需要强一致对账时凭 job_id 走任务总账或管理 API 对账。

## 2.3 送达类型（插座约定）

路由 `delivery.type` 决定结果怎么送达：

- **`webhook`**：中枢直发（带上述签名）到 `delivery.url`，业务方验签接收（机器对账渠道，成功失败都回调）。
- **`channel`**：中枢内置，经渠道注册表 `bz_channels` 的出站凭证把执行器/大脑的结果**直接推给某个渠道收件人**（如某个企业微信成员）。等价于"中枢替你自动调一次 `POST /send`"——**业务 `/run` 触发一次，结果就自动落到指定收件人的聊天窗，无需第二次调用**。配置字段：
  - `channel`：渠道标识（中枢后台「渠道」页里登记的那个 `name`，决定用谁的出站凭证）。
  - `to_field`：收件人取自哪个 metadata 键（**优先**）。**收件人是每次调用动态决定的、不写死**——`to_field:"wecom_userid"` → 收件人 = 触发 `/run` 时传的 `metadata.wecom_userid`，每次传谁就推给谁。**一条路由服务任意收件人，不需要为每个人各配一条路由。** 该 metadata 值支持**单个 id**、**数组** `["A","B"]` 或 **`"A|B|C"` 字符串**给**多个收件人**（一次合并发，各自进各自的会话历史）。
  - `to`：兜底固定收件人（同样支持 `"A|B|C"` 多个）；`to_field` 取不到时回落到它。适合"永远推给同一个/同一组人"。`to_field` 与 `to` 至少给一个。
  - 例（动态单人/多人）：`{"type":"channel","channel":"bn-wecom","to_field":"wecom_userid"}` + `/run` 带 `metadata:{"wecom_userid":"ZhangSan"}` 或 `{"wecom_userid":["ZhangSan","LiSi"]}`。例（固定收件人）：`{"type":"channel","channel":"bn-wecom","to":"ops-leader"}`。
  - 行为：**只在任务成功（done）时推**——失败不推人渠道免噪音（要对账失败请并用 webhook）；正文优先取 AI 回复原文、缺省取成品通知文案；长回复自动按字节分条；同一父任务幂等只投一次（重跑/恢复不重复推）；送达成功后会把这条消息记进收件人在该渠道的会话历史，收件人回话时大脑接得上上下文。收件人的企微 userid 由业务自己维护映射，中枢不存这层。
- **其余类型 `X`**：由名为 `X-notify` 的执行器目标承接（内置 `wecom`→`wecom-notify`）。部署方扩展渠道 = 在「调度目标」注册 `X-notify` + 运行能认领它的执行器，信封不变。

> `channel` vs `wecom-notify`：两者都能把结果推到企微，但 `channel` 是**中枢内置直发**（不需要执行器、用 `bz_channels` 凭证、自动分条/写总账），是"业务 /run → 自动推给指定人"的首选；`wecom-notify` 是经执行器承接的自定义渠道路径，需要部署方配置自己的发送命令，仅在你已有自建执行器渠道实现时使用。

## 2.4 工具插座：让 Agent 安全地调你的业务接口

设计全文见 TOOLS_DESIGN.md。职责劈分一句话：**中枢管"这路 AI 最多够到哪"（白名单/风险闸/限流/审计/签名），业务管"这个人此刻能不能做"（验签后按自己的权限表裁决）**。

业务侧接入的**两个动作**是标注解、验签 **+ 授权**——但**别低估工作量**：非平凡集成 = 给每个端点标 x-agent-capability（scope/risk）+ 实现验签**与授权**两道闸（把 `On-Behalf-Of` 接进你的权限表，**fail-closed**）+ 定空主体语义 + 发布 spec + 注册工具源 + 配 allow 白名单。这是个小项目，不是粘贴一段中间件。**安全要点**：工具调用是服务器到服务器、没有 session，业务平时基于登录态的鉴权对它不生效——所以授权（把主体接进权限表）是这条链路唯一的授权闸，**只验签不授权 = 认证了但没授权**。PHP 用 SDK 的 `Verify::gate($secret, $authorize)`（authorize 必填、fail-closed）把授权这步在代码层钉死；威胁模型见 TOOLS_DESIGN §11。

> **注册期 authorize 探针（中枢健康检查，你会观测到）**：注册/刷新工具源时，中枢会发**一次**带合成越权主体 `__bailing_authz_probe__:nobody` 的签名探针，验证业务侧 authority 闸是否真的按 `On-Behalf-Of` fail-closed。推荐在 spec root 声明专用端点：`"x-bailing-authz-probe": { "method": "POST", "path": "/.well-known/bailing/authz-probe" }`，端点收到陌生主体后返回 `{"authorized": false}` 或 401/403 即通过；若返回 `{"authorized": true}` 会被标记为 `suspect`。未声明专用端点时，中枢回退到一个无参只读 GET 工具探测：声明 `x-agent-capability.subject.required` 的工具对合成越权主体返回 2xx 会被视为疑似只验签未授权。探针不产生业务副作用、不阻断注册；最近一次结论会在控制台「工具源」列表展示，可手动重新探针。

> **工具源调试调用**：控制台「工具源 → 工具清单」可选择任意已编译工具，按参数 schema 自动生成表单，也可切换 JSON 高级模式；填写 `On-Behalf-Of` 主体后发起一次真实签名调用，用于接入期验证 path/query/body/header 映射、签名、授权和响应格式。默认阻止 `risk=high` / `confirm-required` 工具；确需验证时必须显式勾选高风险调用。调试结果只展示脱敏后的请求摘要、参与签名的非密钥字段、HTTP 状态、耗时、响应预览和常见排障提示；最近调试样例仅保存在浏览器本地。

### a) 声明可调接口：OpenAPI `x-agent-capability` 注解

在你的 openapi.json 的 operation 上标（或手写一份只含 AI 接口的 spec，到控制台「工具源」注册；用官方 SDK 则由 `#[AiTool]` 属性注解生成）。
**注册表按"核心稳定、扩展开放"原则定稿**：下表是中枢会解释和执行的核心治理/模型字段；业务调用参数不放在 `x-agent-capability` 里，而是继续使用 OpenAPI 标准的 `parameters` / `requestBody` JSON Schema，业务需要多少字段、嵌套对象、enum、format、default、description 都可以声明。`x-agent-capability` 内未知字段不会参与闸门决策；operation 上的 `x-bailing-*`、`x-business-*` 会进入工具定义的 `extensions` 扩展袋，供控制台预览、后续投影或业务自定义编排使用。

如果业务方觉得核心字段不够：

- **只是业务侧私有标记/展示/分组/运营语义**：放 `x-agent-capability.guidance.context` 或自定义 `x-business-*` 扩展，中枢保留但不解释；
- **需要中枢产生治理效果**（例如参数级审批、金额阈值、租户隔离策略）：应升级为框架级字段或 OpenAPI Overlay 规则，由中枢显式解析、测试、审计，不应让 LLM 或业务私有字段隐式改变安全闸门；
- **只影响工具入参**：不要新增 `x-agent-capability`，直接把参数写进标准 JSON Schema。

**治理面（中枢闸门消费）：**

| 字段 | 必填 | 状态 | 说明 |
|---|---|---|---|
| `x-agent-capability.version` / `enabled` / `scope` | 是 | ✅消费 | ACC 版本、暴露开关、权限标签；scope 如 `tenant.staff.read`，路由 `allow` 白名单按它匹配（支持 `tenant.staff.*` 前缀通配）；缺失即跳过 |
| `risk.level` | 否 | ✅消费 | `low` / `medium`（放行留痕）/ `high`（先撤单走人工审批）。**缺省安全下限**：GET / 显式只读缺省 `low`；**未标的写操作**（非 GET 且非 `execution.readonly`）缺省 **`medium`**（漏标偏向"被看见、留痕"而非"静默放行"，不阻断调用）；显式声明的级别永远优先 |
| `approval.required: true` | 否 | ✅消费 | 与 high 同语义：调用先进审批车道，批准后任务自动重跑执行 |
| `approval.when` | 否 | ✅消费 | 参数级确认规则数组。用于“同一接口按实参决定是否审批”，如 `[{"param":"amount","op":">","value":1000,"label":"退款金额超过 1000 元"}]`。`param` 必须指向标准参数 schema 中已声明且有 type 的字段；比较遵循 JSON 类型，不把 `"1000"` 当作 `1000`、不把 `"true"` 当作 `true`。类型不符时中枢拒绝外发，命中后本次调用进入审批，参数快照按 `args_hash` 锁定；未命中则按原风险级别执行 |
| `execution.rate_limit` | 否 | ✅消费 | 结构化限流对象，如 `{"count":30,"window":"1m"}`、`{"count":600,"window":"1h"}`，中枢侧执行 |
| `subject.required: true` | 否 | ✅消费 | 该接口必须有操作主体（`X-Bailing-On-Behalf-Of`）才有意义——**无主体的任务（如匿名网页访客）装配时直接看不到这个工具**，调用层双闸兜底。业务侧运行时仍应自行校验（纵深防御） |
| `audit.sensitive: true` | 否 | ✅消费 | 参数含敏感数据（手机号/身份证等）：该工具的审计**只记参数键名不记值**、响应只记字节数（优先级高于工具源级 log_payload 配置） |
| `execution.timeout_ms` | 否 | ✅消费 | 单工具超时覆盖（1~600000 毫秒），慢接口（报表生成等）可单独放宽；缺省用工具源超时 |
| `deprecated: true`（标准字段） | 否 | ✅消费 | 弃用接口不再暴露给 AI（工具编译 `diagnostics` 产生 `error: deprecated`，控制台可派生展示 skipped 原因），业务可平滑下线 |

**模型面（喂给 AI，决定它用得准不准）：**

| 注解 | 必填 | 状态 | 说明 |
|---|---|---|---|
| `operationId`（标准） | 建议 | ✅消费 | 工具名（缺省 `<method>_<path>` slug 生成）；**定了就别改**，改名会让 Agent 认为这是另一个新工具 |
| `summary`（标准） | 是（实务上） | ✅消费 | 工具一句话说明，AI 判断何时调用的首要依据，务必写人话 |
| `parameters` + `requestBody`(json) schema（标准） | 写接口必填 | ✅消费 | 参数定义（enum/format/default/description 都会喂给 Agent，越细调用越准）；**非 GET 接口必须至少声明一个参数（query 或 body 均可），完全无参数则不暴露**（不让 Agent 瞎猜参数）。POST + 纯 query 参数合法：照常暴露，调用时参数进 query string |
| `guidance.when_to_use` | 否 | ✅消费 | 何时该用/不该用的补充提示（拼进工具描述），如"用户问员工、排班、人事时用；问工资别用，走 salary_query" |
| `guidance.returns` | 否 | ✅消费 | 返回结构的人话说明（拼进工具描述），如"返回 {code, data: 员工数组[{id,name,role,dept}]}"——AI 解读响应更稳 |
| `guidance.examples` | 否 | ✅消费 | 示例参数数组（如 `[{"dept":"前厅"}]`），首个示例拼进工具描述做 few-shot |
| `execution.readonly: true` | 否 | ✅消费 | **语义只读声明**：GET 默认只读；**POST 实现的查询接口**（PHP 生态常见）显式标注，Agent 可放心自由调用、进 defs 提示 |
| `execution.idempotent: true` | 否 | ✅消费 | 可安全重试（GET 默认 true）；网络抖动时大脑/执行器可凭此决定是否自动重发 |

**审批/运营面：**

| 注解 | 必填 | 状态 | 说明 |
|---|---|---|---|
| `approval.prompt` | 否 | ✅消费 | 审批通知的人话模板，`{参数名}` 占位，如 `"AI 申请删除员工 #{id}"`——审批人不用读 JSON |
| `tags`（标准） | 否 | 预留 | 控制台「工具清单」分组展示（几百个工具时的导航） |
| `responses` schema（标准） | 否 | 预留 | 机器可读的返回 schema（`guidance.returns` 人话版先行，将来结构化校验用） |
| `guidance.context` | 否 | ✅透传 | 业务自定义字符串数组，中枢不解释、原样透传——适合轻量上下文标签，如 `tenant-boundary`、`requires-inventory-check` |

**扩展袋 `extensions`**：operation 上的 `x-bailing-*`、`x-business-*` 会被保留到工具定义中，但不会影响 allow/risk/approval/limit/audit/signature 等安全闸门。示例：`x-business-owner: "trade-team"`、`x-business-policy: {"approval_scene":"order_over_limit"}`。这类字段适合二开控制台、工具市场、OpenAPI Overlay 或业务自定义运行时消费。

`approval.when` 初期支持的 `op`：`>` / `>=` / `<` / `<=` / `==` / `!=` / `in` / `contains` / `exists`。`param` 支持点路径，如 `refund.amount`，并且必须能定位到 `parameters` / `requestBody` 的 JSON Schema；数值比较只接受 JSON number / integer，`==` / `!=` / `in` 使用严格 JSON 类型比较，`contains` 仅用于 string / array。条件字段类型不符时中枢拒绝调用，不把它静默当作“未命中”。跨主体、跨租户这类判断建议由业务系统在接口授权层 fail-closed，中枢只做通用参数级审批闸。

**明确不设的字段（推演过，记录决策防止反复）：**
- ~~`approval.approver`~~ —— 审批人/审批流不是接口注解属性；承接方式由路由 `tools.approval` 或业务侧审批系统配置，接口只声明风险与确认需求；
- ~~`execution.async`~~ —— 长任务拆"提交 + 查询"两个工具即可表达（提交回任务号、查询带任务号），是模式不是字段；
- ~~`business.cost`~~ —— 计费敏感接口用 `risk.level` 管控即可，私有成本标记走 `guidance.context`；
- 文件/二进制传输 —— 工具面 v1 仅 JSON；文件场景传 URL。

派生规则：工具名取 `operationId`（缺省 `<method>_<path>` slug）；参数 = query parameters + requestBody(json) 合并（**query 或 body 任一即满足"有参数"，POST+纯 query 合法暴露**）；非 GET 且完全无参数的接口即使标了 enabled 也不暴露；工具描述 = summary + when-to-use + returns + 首个 example 拼接（上限 500 字）。

#### spec 发布与自动刷新

spec 给到中枢的推荐方式是**发布到固定 URL**（控制台「工具源」选"从 URL 拉取"并设自动刷新间隔），约定路径：

```
https://<你的域名>/.well-known/bailing/tools.json
```

`/.well-known/bailing/` 为百灵保留目录，未来扩展文件均放此目录下。语义与机制：

- **自动生效**：CI 部署后更新该文件即可，中枢按间隔（分钟级，0=关闭）拉取，新标注的接口自动成为工具，无需人工重新导入；
- **变更对账**：每次拉取与上次派生清单 diff（比对 method/path/scope/risk/confirm 安全指纹）；工具新增 / 移除 / 指纹变化 → 审计事件 `spec_refreshed`（detail 含 added/removed/changed）+ 告警中枢管理员。仅描述文案变化只更新不告警；
- **签名拉取**：中枢拉 spec 的 GET 请求同样带 `X-Bailing-Timestamp` / `X-Bailing-Signature`（v2，空体哈希参与签名）——业务侧**可选**用同一验签函数保护 spec 地址，只对中枢开放接口清单；不验也能用；
- **拉取失败**：审计 `spec_refresh_failed` + 告警；AI 继续按缓存清单工作（缓存不失效），不因业务侧发布事故中断；
- **宝塔/BT 面板注意项**：宝塔默认 vhost 可能自带 `location ~ \.well-known { allow all; }` 证书验证段，**正则 location 优先于 `location /` 的框架重写**——动态路由方式会被它按静态文件处理直接 404；而静态文件方式可能被公开直出，绕过“只对中枢开放”的签名保护（且 content-type 错为 text/plain）。两个修法任选：①在网站配置加前缀匹配段（`^~` 优先级高于正则）把约定路径放行给 PHP：`location ^~ /.well-known/bailing/ { rewrite ^(.*)$ /index.php?s=$1 last; }`——**ThinkPHP 必须带 `?s=$1`**（nginx+FPM 下 TP 靠 `s` 参数恢复 pathinfo，REQUEST_URI 链路仅 cli 生效，裸 rewrite 丢路径会路由到默认页；Laravel 等直接解析 REQUEST_URI 的框架可省略）；②**约定路径本来就不是强制的**——注册工具源时 spec_url 填任意非点开头路径（如 `/bailing/tools.json`）同样有效。验签注意：内部 rewrite 不改 `REQUEST_URI`，仍用原始 URI 验签即可。

### b) 验签：中枢调你接口时带的头（sha256= 签名）

```
X-Bailing-Timestamp:    1781144508                    # unix 秒
X-Bailing-Signature:    sha256=<hex hmac-sha256>      # "sha256=" + HMAC_SHA256(工具源secret, "<ts>.<METHOD>.<path?query>.<sha256hex(body)>.<On-Behalf-Of>.<Job-Id>")
X-Bailing-Job-Id:       任务溯源
X-Bailing-Client:       触发方 app_id（admin 触发为空）
X-Bailing-On-Behalf-Of: 操作主体，票据/触发方声明的 uid 原样透传。取数链：metadata[subject_field] → 取不到回落 metadata.visitor_uid（聊天票据身份由中枢验签后写入的标准字段——聊天场景零配置即得身份，且不会被 API 场景的 subject_field 配置饿死）；可能为空
X-Bailing-Tool-Scope:   该工具的 x-agent-capability.scope（信息性，业务侧应自行重算）
```

- secret = 控制台「工具源」注册时设置的签名密钥（与接入 token、server.token 全部解耦，单独轮换）；
- GET 的 body 为空串（`sha256("")`）；时间窗 300 秒防重放；
- **`<path?query>` 精确定义**：`<path>` = 你在 spec 里给该 operation 声明的 **`path` 原文**（如 `/goods/create`），**不含** scheme/host，**也不含工具源 base_url 的路径前缀**。中枢实际请求的是 `base_url + <path?query>`，但**只对 `<path?query>` 这一段签名**。推论：
  - **base_url 用纯源站（无路径前缀）最省事**——此时业务收到的 `REQUEST_URI` 就等于 `<path?query>`，`Verify::currentRequest($secret)` 直接可用；
  - base_url **带路径前缀**（如 `https://shop.com/openapi`，spec path `/goods/create` → 实际请求 `/openapi/goods/create`）时，`REQUEST_URI` 含 `/openapi` 前缀而签名串不含 → 必 401。两种解法：把该前缀从 `REQUEST_URI` 剥掉再验，或直接用 SDK 的 `Verify::currentRequest($secret, '/goods/create')`（传该端点的 spec path，SDK 只借用 `REQUEST_URI` 的 query 段、路径段用你给的 spec path，**与 base_url 前缀、框架 pathinfo 重写都解耦**，推荐）；
  - `<query>` = **本次 Agent 调用的 query 位参数**（GET 的全部参数 / 非 GET 标了 `in:query` 的参数），经 `URLSearchParams` 序列化（参数按传入顺序、值百分号编码）。**不含**你框架的路由参数——所以**端点要挂在干净固定路径上，别走 `?i=&c=&a=&r=` 这类带路由 query 的入口**（那些 query 不在中枢签名里，必对不上）。无 query 参数时签名串就是纯 `<path>`；
- **编码形态**：中枢"签所发即所发"——签名串里的 `<path?query>` 与实际发出的请求行逐字节一致（query 值经 URLSearchParams 百分号编码）。业务侧**必须用原始 `REQUEST_URI` 验签（或 SDK 传 spec path 的形式），不要从 `$_GET` decode 后重组**（会改编码/顺序）；URI 会被重写/重编码的 CDN 或网关后面验签必挂——**工具源 base_url 必须指向源站直连地址**；
- **重放与幂等**：签名校验不要求业务侧维护 nonce（业务侧无需 Redis 也能接）。时间窗内同一请求可被重放，TLS 下风险有限；对高敏写接口建议任选其一加固：①业务侧把收到的 `X-Bailing-Signature` 缓存 300 秒拒绝重复出现（**签名串含时间戳，本身就是唯一性指纹——缓存它等价 nonce 去重**，合法的 AI 重试时间戳不同、签名不同，不受影响）；②按业务键做幂等（如删除二次自然 404）。`X-Bailing-Job-Id` 可辅助溯源对账；
- **签名方案 `sha256=`（唯一）**。标签是**算法名不是版本号**（GitHub webhook `X-Hub-Signature-256: sha256=` 同款约定）——开源接入方一眼知道"HMAC-SHA256、hex"，没有"v 几、前面的版本去哪了"的理解成本。签名材料把 `On-Behalf-Of` + `Job-Id` 也钉进 HMAC：
  ```
  sha256= + HMAC_SHA256(secret, "<ts>.<METHOD>.<path?query>.<sha256hex(body)>.<On-Behalf-Of>.<Job-Id>")
  ```
  否则窗口内拿到一个合法请求、**只改这两个头**即可换租户（GET 工具体为空，租户/主体全在 On-Behalf-Of 头里）或绕业务幂等键——把它们钉进 HMAC 后，这两个头不再是"签名外的可信明文"。
  - `<On-Behalf-Of>` = 实际发出的该头值，匿名（无该头）时为**空串**；`<Job-Id>` 同理。**spec 拉取共用同一套构造**，无主体/任务时三者皆空串（`SpecServer` 不变，GET body 也为空）。中枢"签所发即所发"，验签侧原样取这两个头即可（SDK `Verify` 已自动从 `$_SERVER` 取）；
  - **签名标签只有 `sha256=` 一套**：中枢只发 `sha256=`，SDK 与三份单文件参考也只验 `sha256=`。未来若需演进签名构造，会使用新的自描述标签，并按 `docs/兼容性与升级.md` 的 wire 变更流程处理；
- **401 建议带原因**：接入期头号坑是服务器时钟偏移，401 响应体建议区分 `timestamp_out_of_window` / `bad_signature`（不泄密，机制本就写在本契约里；SDK `Verify::failureReason()` 直接给出）。先给服务器对时（ntp/chrony）；
- **验签通过只说明"真是中枢发的"。On-Behalf-Of 是谁、有没有权限做这件事，由你按自己既有的权限体系裁决**——Agent 调用与人点按钮走同一条裁决路径。该主体由你的业务后端在触发 `/run` 时写进 `metadata`（可信代码产出，全程不经 LLM）；
- **`X-Bailing-On-Behalf-Of` 取值**：聊天入口场景 = 你 `Ticket::sign($接入方token, $你的操作人uid)` 签进票据的那个 **`uid` 原样回传**。链路：票据验签通过 → 中枢写 `metadata.visitor_uid = uid`（逐字、组件无法伪造）→ `subjectOf` 取 `metadata[subject_field] ?? metadata.visitor_uid` → 作为本头逐字发出。**中枢不解析、不约束这个值的格式**——它对中枢是不透明字符串，你放业务操作员 id、放 `t{租户}:u{uid}` 都行，怎么放就怎么收，你的业务侧按它走自家权限裁决（如加商品时认定操作人）。**匿名（无票据/无主体）时该头缺省**——配合 `x-agent-capability.subject.required` 的工具对匿名直接不可见，双保险；
- **多租户推荐姿势：用「结构化主体」一次性携带租户+用户**。On-Behalf-Of 是中枢原样回传的不透明串，多租户系统应把**定位一个操作人所需的全部维度**编进这一个值里，而不是只签裸 `uid`。推荐形态如 `tenant_1:user_1001` 或 `t1:u1001`。
  - **怎么签**：`Ticket::sign($接入方token, "{$tenant}:{$uid}")`（如 `"tenant_179:user_1"`；其他体系按需 `"{tenant}:{role}:{uid}"` 等），分隔符自定、≤64 字节（票据 uid 上限）。
  - **怎么收**：业务侧验签后 `explode(':', $operator)` 拆出租户与用户，**先用租户维度划定数据边界、再认定操作人**，照走自家权限表。
  - **为什么是接入方的活、不是中枢的活**：租户隔离是业务域知识，编进主体串后**中枢零改动即支持任意多租户模型**；反过来若让中枢理解租户，等于把每个接入方的私有模型塞进通用契约，必然写死。**结论：单租户也建议从第一天就用结构化主体**（如 `"1:1"`），为后续多租户扩展留下空间。
- **🧪 冻结测试向量（任意语言离线自检，避免"连真 hub 才发现 canonical 串拼错"）**。固定 `secret = "bailing-test-secret"`：

  | 场景 | 输入 | 期望 `X-Bailing-Signature` |
  |---|---|---|
  | 工具调用 | ts=`1718000000`、`POST`、`/goods/create`、body=`{"title":"test","price":9.9}`、On-Behalf-Of=`179:1`、Job-Id=`job-test-001` | `sha256=6deb8dbd54268eee4631129b442acbc9797431642473326a10a5b0826431aae5` |
  | spec 拉取 | ts=`1718000000`、`GET`、`/bailing/tools.json`、body/主体/任务皆空 | `sha256=505ab99763cd20b50ba4066ee2ac315fe6af12a8638e7dabef63508abddedc74` |
  | 回调/webhook（§2.2，**毫秒** ts、构造 `ts.body`） | ts=`1718000000000`、body=`{"kind":"delivery","job_id":"job-test-001","status":"done"}` | `sha256=ca81d247422d926be3066f065a8c92a1beaffc6f37f01ef7d3e2c47b46f63210` |

  body 按**原始 UTF-8 字节**哈希（"签所发即所发"——验签侧用收到的原始 body，**别 decode 后重新序列化**）。三份单文件参考直接运行即比对这三组向量。
- 参考实现（**三份均零依赖、直接运行即比对上方向量，并包含独立授权探针 helper**）：`docs/examples/bailing-tool-verify.php`（PHP，含 ThinkPHP 中间件用法）/ `.mjs`（Node）/ `.py`（Python）。
- 官方 SDK：`sdk/php`、`sdk/php7`、`sdk/node`、`sdk/python`、`sdk/java`、`sdk/go`、`sdk/dotnet`。PHP SDK 提供属性注解与 `Verify::gate()` / `SpecServer::authzProbe()`；Node/Python/Java/Go/.NET SDK 提供工具 spec 构建、访客票据签发、工具调用验签、回调验签、authorize 探针响应 helper 和 HubClient。PHP/PHP7/Node/Python 的 OpenAPI 输出通过同一份 contract test 校验，Java/Go/.NET 作为 P1 后端 SDK 走示例编译/源码检查。

### c) 大脑侧：统一工具面（执行器认领件 + 调用代理）

路由挂了 `tools` 时，执行器认领件多一个 `tools` 字段：

```jsonc
{
  "tools": {
    "invoke_url": "/jobs/<job_id>/tools/invoke",
    "tool_token": "<任务级凭证：HMAC 派生，任务终态即失效>",
    "max_calls": 5,
    "mode": "inline",                  // inline=defs 全量内联 / catalog=渐进披露
    "defs": [ { "name": "staff_list", "description": "…", "parameters": { /* JSON Schema */ }, "scope": "tenant.staff.read", "risk": "low", "confirm_required": false, "readonly": true, "idempotent": true } ],
    "approved_note": "（审批重跑时才有）已批准调用清单"
  }
}
```

**渐进式披露**：白名单内工具数 > 12 时 `mode` 变为 `catalog`——`defs` 不下发，
使用轻目录 `catalog: [{name, summary, scope, risk, confirm_required}]`（每条只有描述首句，无参数 schema）
和取定义端点 `defs_url`。大脑先看目录，用哪个再取完整定义（"看菜单不点菜"，**不计入 max_calls**，审计 `tool_lookup`）：

```
GET <中枢>/jobs/<job_id>/tools/defs?names=staff_list,order_query
Authorization: Bearer <tool_token>
→ 200 { "defs": [ { "name": "...", "description": "...", "parameters": { /* 完整 schema */ } } ] }   // 未知名忽略
```

llm 大脑同语义内置：目录注入系统提示 + `find_tools` 元工具按需取定义。defs/目录按工具名稳定排序（prompt cache 友好）。
≤12 个工具维持全量内联不引入额外往返——**白名单按场景收窄仍是第一性控制，渐进披露是兜底**。

大脑（llm / executor / 任何第三方运行时）调用方式统一：

```
POST <中枢>/jobs/<job_id>/tools/invoke
Authorization: Bearer <tool_token>
{ "tool": "staff_list", "arguments": { ... } }
→ 200 { "ok": true, "text": "<业务返回原文，≤8KB 截断>", "status": 200 }
```

白名单复核/风险闸/限流/审计/`sha256=` 签名全在中枢侧——与 llm 的 function-calling 走**完全相同**的出口。通用执行器（/connect/executor.mjs）会把这些放进环境变量 `BAILING_TOOLS` / `BAILING_TOOL_TOKEN` / `BAILING_TOOLS_URL`。

### d) 审批车道（risk=high / confirm-required）

命中的调用不会执行：中枢冻结工具+参数快照并形成审批意图（pending）→ 经审批承接 adapter 发出 `ApprovalIntent`（生产推荐业务侧 webhook/OA/IM；控制台「审批意图」页只是兜底）→ 业务侧或控制台回传决策 → 批准后**任务自动重跑**，重跑只放行"与批准快照完全一致"的那一次调用（换参数/换动作 = 重新审批）；拒绝则任务保持原结论。

审批策略来源统一用 `policy` 表示：

- `risk_high`：工具声明 `x-agent-capability.risk.level: high`；
- `confirm_required`：工具声明 `x-agent-capability.approval.required: true`；
- `confirm_when`：本次实参命中 `x-agent-capability.approval.when`。

路由可把审批意图直接投给业务系统：

```jsonc
// route.tools.approval
{
  "type": "business_webhook",
  "url": "https://business.example.com/ai/approvals"
}
```

中枢会对 `url` 发起带 §2.2 外发签名的 POST，body 为：

```jsonc
{
  "kind": "tool_approval_request",
  "approval_id": 123,
  "job_id": "...",
  "request_id": "...",
  "route": "store_ops",
  "subject": "tenant_1:user_1001",
  "provider": "bn-server",
  "tool": "inventory.adjust",
  "scope": "store.inventory.write",
  "risk": "high",
  "policy": "risk_high",
  "reason": "risk=high",
  "method": "POST",
  "path": "/inventory/adjust",
  "args": { "store_id": 8, "sku_id": 10086, "delta": -20 },
  "args_hash": "...",
  "summary": "将门店 8 的 SKU 10086 库存减少 20",
  "intent": {
    "approval_id": 123,
    "kind": "tool_approval_intent",
    "schema_version": "bailing.approval-intent.v1",
    "job_id": "...",
    "request_id": "...",
    "route_key": "store_ops",
    "route_name": "门店运营",
    "source": "chat:store-widget",
    "subject": "tenant_1:user_1001",
    "provider": "bn-server",
    "tool": "inventory.adjust",
    "scope": "store.inventory.write",
    "risk": "high",
    "policy": "risk_high",
    "reason": "risk=high",
    "method": "POST",
    "path": "/inventory/adjust",
    "args": { "store_id": 8, "sku_id": 10086, "delta": -20 },
    "args_hash": "...",
    "summary": "将门店 8 的 SKU 10086 库存减少 20",
    "metadata": {}
  },
  "decision_path": "/approvals/123/decision",
  "decision_contract": {
    "kind": "tool_approval_decision",
    "schema_version": "bailing.approval-decision.v1",
    "required_fields": ["approval_id", "job_id", "request_id", "args_hash", "decision_id", "decision", "approver"],
    "decision_values": ["approved", "denied"],
    "idempotency": "decision_id",
    "match": {
      "approval_id": 123,
      "job_id": "...",
      "request_id": "...",
      "args_hash": "..."
    }
  },
  "metadata": {}
}
```

业务侧完成自己的审批流后，回调中枢决策端点：

```http
POST /approvals/123/decision
Authorization: Bearer <触发方 client token 或 server.token>
Content-Type: application/json

{
  "kind": "tool_approval_decision",
  "schema_version": "bailing.approval-decision.v1",
  "approval_id": 123,
  "job_id": "...",
  "request_id": "...",
  "args_hash": "...",
  "decision_id": "oa:approval:9001",
  "decision": "approved",
  "approver": "user_2002",
  "comment": "确认处理"
}
```

- `decision` 只接受 `approved` / `denied`；
- `approval_id` / `job_id` / `request_id` / `args_hash` 必须与审批单冻结快照一致，防止业务侧把 A 审批结果错打到 B 审批单；
- `decision_id` 是业务审批系统的幂等键（建议使用 OA/审批表主键、工单审批记录号等稳定值），同一 `decision_id` 重试同一决策会返回 200 + `idempotent:true`，复用于其他审批单会被拒绝；
- `approver` 是业务侧真实审批人，不应填中枢 token 名；
- Bearer 使用触发该任务的接入方 token；聊天入口任务则允许该入口的 `ticket_client` token；管理 token 仅用于兜底运维；
- 也可不用 Bearer，改用与 §2.2 相同的 `X-Bailing-Timestamp`（毫秒）+ `X-Bailing-Signature: sha256=<HMAC(secret, "ts.rawBody")>` 对原始 body 签名，secret 解析链同 §2.2；
- 中枢只校验“这次决策可信且属于该任务”、更新 `bz_tool_approvals` 闸门账本并触发重跑；谁能审、几级审、在哪个页面审，归业务系统自己的审批流决定。

### e) 聊天组件附件上传（图片 / 语音 / 文件生成永久 URL）

**问题**：聊天里要"加商品配图"、"发一段语音说明"、"上传合同/PDF/表格让 Agent 参考"这类操作，Agent 的工具调用是 JSON，传不了二进制——附件必须先变成一个 URL。且上传那一刻并不知道它的用途（用户可能要 Agent **理解素材**，也可能要把文件 URL **传给业务接口**），用途是会话级事实，不该在上传时锁死。

**方案：附件一律先进入「媒体存储」，变成一个永久 URL**，用途交给会话。默认媒体存储是服务器本地 `data/uploads`，不需要先开 OSS/COS；生产环境可切到对象存储。一份存储同时喂三件事：① **完整聊天追溯**（附件永久存在，会话记录永不残缺，可追责）② **多模态输入策略**（图片/语音/文件按路由配置抽取、转写、直送或忽略）③ **业务接口入参**（AI 把 URL 传给加商品图、导入附件等工具）。

**为什么不是 TTL 暂存、也不是中枢当永久图床**：暂存会清掉图、破坏追溯；而"桶是谁的"只是**一条配置**——

- **媒体存储 = 存储登记项**。不选登记项时走内置本地存储：写入 `<repo>/data/uploads/<path_prefix>/...`，通过 `GET /uploads/*` 公开读取。控制台可登记外部对象存储：`kind`(local/cos/oss/s3) + region + bucket + AK/SK + 公开域名 + 写入前缀；SecretKey 不回显。**当前实现 local 与腾讯云 COS**。
- **聊天入口可按名关联一个存储**；留空不是关闭上传，而是使用本地存储。配了外部对象存储则使用外部存储。
- 指向**业务自己的桶** → 上传得到的 URL 本就是**业务 CDN 全地址**，业务要图片入参直接用、**无需再传一遍图**（永久家天然在业务侧，零转存）。
- 指向**中枢自己的桶** → 中枢掌控留存（追溯最稳）；此时若要让商品图永久归业务，业务可对该 URL 再做一次"按 URL 导入媒体"转存自己桶。

**链路**：组件 `POST /chat/:entry/upload`（公开面，Origin 白名单 + IP 限速 + 可停用，与 `/chat/:entry` 同门禁），body `{filename, mime, data_base64, visitor_id, ticket?}` → 中枢写入入口关联的媒体存储；没有关联则写入本地 `data/uploads` → 返回 `{ok, url, name, type:"image"|"audio"|"file"}`。`/chat/:entry/config` 默认返回 `upload:true`，组件自动露出按钮。当前支持图片 PNG/JPG/WEBP/GIF（≤6MB）、音频 WEBM/MP3/M4A/WAV/OGG/FLAC（≤12MB）、常见文件 PDF/Office/CSV/TSV/TXT/Markdown/JSON/XML/YAML/日志/配置/SQL/压缩包（≤20MB）。

**业务侧要做的（指向业务桶时）**：**几乎为零**——① 给中枢一个**限定 `path_prefix` 前缀的子账号/RAM 策略或 STS 临时凭证**（铁律：别把整桶 AK/SK 交出来）；② 确认加商品等接口的图片字段吃完整 URL（基本都吃）。落桶对象设为公读（多模态模型与前台都要取）。

> 注：让 Agent 如何使用这些附件由路由 `target_config.input.{image,audio,file}` 决定。图片可解耦成图片模型；语音可先由中枢转写，也可直送给业务自己的语音模型或执行器；文件可抽取文本、抽取后摘要、直送具备文件能力的模型/执行器，或只留痕不参与回答。视频等后续类型继续挂在同一 `input` 契约下扩展，不新增零散字段。

### f) 内置「主动发消息」动作 `send_message`：大脑/执行器自己决定发给谁

让大脑（llm）或执行器（本地 claude）在**执行过程中自己命名收件人**、主动经渠道发消息——"完成了某件事，自己就知道发给谁"。与「送达·渠道直推」（§2.3 `delivery.type=channel`，结果由中枢统一送达给触发时指定的人）互补：这里是大脑**自主**发送，可发多人、多次、中途发。

- **它和业务工具源不同**：`send_message` 是中枢**内置动作**，不需要你发布 OpenAPI、不需要工具源、不验签——它直接用「渠道」里的出站凭证投递。是否暴露给大脑，只取决于路由配置。
- **配置（中枢后台「路由」页 → 工具 → 主动发消息）**：`tools.builtin.send_message.channels` = 渠道名数组（`['*']` = 所有启用渠道）。这是**唯一的发送闸**：路由声明"准发哪些渠道"，**收件人是谁由大脑当场指定**——中枢不持有任何「人↔身份」映射，不在后台枚举任何收件人。
- **大脑看到的工具**：`send_message(to, text[, files][, channel])`。`to` = 收件人在渠道的原生 id（企微即成员 UserID），多人用 `"A|B|C"`；`channel` 仅当允许多个渠道时才需给（单渠道默认）。中枢校验 `channel ∈ tools.builtin.send_message.channels`、投递、并把这条消息记进每个收件人在该渠道的会话历史（与 `/send` 同纪律）。
- **附件 `files`**：可随消息发文件（如代码审核报告）。每项二选一——`{name, content}`：`content` 是文件**完整文本内容**（大脑直接把报告全文放这里，中枢生成文件发出，**无需先上传到任何桶/URL**，最适合执行器现生成的 .md/.txt/.json 报告）；或 `{name, url}`：已托管文件的 http URL（中枢拉取后转发）。单次 ≤5 个、单文件 ≤20MB。底层复用 channelSend 的文件能力（企微走 media/upload→file 消息）。
- **限额**：单任务默认最多 20 次主动发送（与业务工具的 `max_calls` 各自独立计数）。失败以文本回流给大脑，由它向用户说明。
- **两个大脑都支持**：llm 作为内置工具直接调用；执行器经统一工具面（认领件里多一个 `send_message`，调用走 `/jobs/:id/tools/invoke`）。**纯 send 路由**（只配 `tools.builtin.send_message.channels`、不挂业务工具源）也成立。

> 设计取舍：为什么是内置动作而不是让业务再配一个工具源——发消息是中枢已有的渠道能力（§2.3 的 channelSend），把它作为内置动作暴露给大脑，业务零额外对接；"谁发给谁"完全由大脑在执行时决定，中枢只守"这条路由准发哪个渠道"这一道闸。

## 2.5 富内容输出契约：第三方怎么渲染图片/文件

AI 的回复是 **GitHub 风味 markdown**。为让没有 markdown 渲染器的端（小程序气泡等）也能正确呈现富内容，中枢在服务端把回复解析成结构化 **`attachments`** 数组，与 `text` 一起给出。出现在两处出口：**聊天 SSE `done` 事件**（字段名 `attachments`）与 **webhook 送达载荷**（§2.2，字段名 `attachments`）。

```jsonc
{
  "reply": "…操作步骤…\n![操作截图](https://…png)",   // 聊天出口字段名 reply；webhook 出口字段名 text。markdown 原文
  "attachments": [                                       // 中枢解析出的结构化富内容（text 的镜像，按出现顺序）
    { "type": "image", "url": "https://…png", "caption": "操作截图" },
    { "type": "file",  "url": "https://…/手册.pdf", "name": "对接手册.pdf" }
  ],
  "references": [ … ]
}
```

**附件类型（按需扩展）：**

| type | 字段 | 来源 | 渲染 |
|---|---|---|---|
| `image` | `url`, `caption?` | 回复里的 `![说明](url)` | 图片组件 |
| `file` | `url`, `name` | 回复里指向文件后缀（pdf/doc/xls/ppt/csv/txt/zip…）的链接 `[名称](url)` | 文件卡片 / 下载链接 |

**渲染契约（第三方按此实现）：**
- **有 markdown 渲染器**：直接渲染 `text`/`reply`——图片、链接、列表、加粗都由渲染器处理，可忽略 `attachments`；
- **只能纯文本（小程序气泡等）**：把 `text` 当纯文字显示（建议去掉 markdown 标记），再遍历 `attachments` 用**原生组件**渲染图片/文件卡片；
- **遇到不认识的 `type`：忽略，或降级成可点击链接**——第三方渲染端只需要消费自己认识的附件类型；
- `attachments` 缺省（无富内容时）不返回该字段，按空处理；普通网页超链接**不**进 attachments（留在 `text` 内联），只有图片与文件类链接才会被提取。

约束：图片/文件本体存放在业务自己的存储/CDN（中枢只透传 url，不代管二进制）；同一 url 在 attachments 内去重。

## 2.6 入站渠道：外部平台消息进中枢

第三类触发入口（与 `/run`、聊天组件并列）：外部平台（当前企业微信）的消息回调直达中枢。控制台「渠道」注册 `kind + config + route_key`（`kind` 区分平台、`config` 放平台密钥、`route_key` 绑大脑），回调路径 `/<平台>/<渠道名>`（企微 = `/wecom/<name>`）。企微链路：GET 验证握手 → POST 解密消息 → 按路由派大脑 → `reply_wait_ms`（≤4500，须 < 企微 5s）窗口内答完走**被动加密回复**、超窗则空 ack + 任务完成后**异步主动推**（qyapi，需 agentid+secret）。成员身份来自企微解密报文（可信主体），按成员切会话。完整接入步骤、字段、握手与安全见 **docs/CHANNELS.md**。

## 3. Job 对象 / 回送体

`callback_url` 收到的、以及 `GET /jobs/:id` 返回的结构：

```jsonc
{
  "job_id": "uuid",
  "request_id": "...",
  "status": "queued | dispatched | running | done | error | rejected",
  "profile": "triage-readonly",
  "project": "lengmon_shop",
  "source": "ticket",
  "client_app_id": "触发方 app_id（admin 触发为空）",
  "session_id": "claude 会话 id（可用于后续追问续聊）",
  "report": { /* TriageReport，见下，status=done 时有 */ },
  "raw_result": "解析 report 失败时保留的原始模型输出",
  "usage": { "duration_ms": 0, "num_turns": 0, "cost_usd": 0 },
  "error": "出错原因（status=error 时）",
  "metadata": { "ticket_id": "..." },
  "attempts": 0,
  "run_after": "ISO8601，可选：queued 任务最早认领时间",
  "claimed_at": "ISO8601，可选：最近一次被执行者认领时间",
  "lease_until": "ISO8601，可选：当前执行租约到期时间",
  "created_at": "ISO8601",
  "updated_at": "ISO8601"
}
```

## 4. TriageReport（大脑的结构化结论）

业务侧据此**自动路由**：高 `confidence` + 低 `severity` 可自动归类；`needs_human=true` 升级人工。

```jsonc
{
  "summary": "一句话结论",
  "severity": "P0 | P1 | P2 | P3 | unknown",
  "category": "代码bug | 配置 | 环境 | 数据 | 需更多信息 | ...",
  "root_cause_hypothesis": "根因假设",
  "evidence": ["app/xxx.php:123", "日志摘录", "表名/字段"],
  "confidence": 0.0,                 // 0~1
  "needs_human": true,               // 解析失败/拿不准时强制 true
  "suggested_owner": "建议处理人/团队（可空）",
  "suggested_next_step": "下一步建议",
  "proposed_actions": [              // P1 永远是建议性、不执行；P2 才进动作网关
    { "description": "...", "risk": "low|medium|high", "reversible": true }
  ]
}
```

## 5. 降级约定（必须遵守）

- 中枢无响应 / 超时 / 503：业务**不阻塞、不报 500**，原有业务流程照常走，事后可重试同 `request_id`。
- 报告解析失败：`status=done` 但 `report.needs_human=true` 且 `raw_result` 保留，交人工看。
- 这是「消费关系」的本质：**单向、松、可断**。
