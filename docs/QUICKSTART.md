# 快速开始：从安装到第一条业务接入

> 本文是部署方（开发者）的通用旅程。中枢不预设你的业务——工单、代码审查、客服 FAQ 只是参考场景；
> 你接什么业务、用什么大脑、往哪个渠道送，全部由下面这些"插座"在控制台配出来。

## 心智模型（先看这个）

```
业务系统 ──POST /run──▶ 中枢（路由→排队→派发）──▶ 大脑执行 ──▶ 结果回流（callback/轮询/送达推送）
                              │
                              ├─ inhub 目标：中枢进程内执行（llm，内置）
                              └─ executor 目标：你的机器出站长轮询认领（任何本地智能体/脚本）
```

- **路由**＝一个业务场景（发给哪个大脑、什么会话策略、注入哪个知识库、结果送哪）
- **接入方**＝一个业务系统的钥匙（路由白名单 + 限速，可吊销）
- **调度目标**＝一个大脑插孔（注册即合法，中枢代码零改动）
- **工具源**＝一个业务系统的“Agent 可调接口清单”（让 Agent 从“会答”升级为“能查、能办”）
- **对话总账**＝所有往来落库，大脑会话只是缓存，可重放可重跑

## 旅程：九步，每步都有控制台页面

**第 0 步 · 部署**：

最快体验用 Docker：

```bash
export BAILING_TOKEN="${BAILING_TOKEN:-$(openssl rand -hex 32)}"
docker compose up --build
```

请在后续 `docker compose` 命令中沿用同一个 `BAILING_TOKEN`，或把生成值保存到本机 `.env`。仅 `development + 127.0.0.1/localhost/::1` 允许无 token 本地开发；生产模式或非回环监听会拒绝空值、短值和公开占位值。

全新 Ubuntu/Debian 服务器默认从国内 ACR 镜像安装：

```bash
BAILING_INSTALL_MODE=image curl -fsSL https://www.bailinghub.com/install.sh | sh
```

需要使用全球 GHCR 镜像时：

```bash
BAILING_INSTALL_MODE=image \
BAILING_IMAGE_REGISTRY=ghcr.io \
BAILING_IMAGE_NAMESPACE=bailinghub \
BAILING_MYSQL_IMAGE=mysql:8.4 \
curl -fsSL https://www.bailinghub.com/install.sh | sh
```

它会启动中枢、MySQL 和 demo 业务系统，并自动创建 `demo_support` 路由、`demo-business` 工具源、`demo-app` 接入方和 `admin` 后台账号。完整演示见 [DEMO.md](DEMO.md)。

手动部署：Node ≥ 22 + MySQL。复制 `.env.example` 到部署环境并设置 `BAILING_ENV=production`、`BAILING_TOKEN`、MySQL 连接、模型凭证等变量；按合规要求可设置 `BAILING_AUDIT_RETENTION_DAYS`（默认 0，不自动删除审计）。执行 `npm run db:init` 初始化数据库结构，`npm run admin:create` 建管理员，启动 `src/server.ts`，登录 `/console/`。本地烟测可直接用 `config.example.json` + jsonl 状态，完整能力请使用 MySQL。

**第 1 步 · 模型凭证**（控制台「模型凭证」）：填任意 OpenAI 兼容端点 + key（OpenAI / DashScope / OpenRouter / 自建均可）。**到这里 llm 已可用——不需要任何执行器就有完整价值。**

**第 2 步 · 知识库**（可选，「知识库」）：建库（选 embedding 凭证）→ 传文档 → 命中测试。知识库只在"资料路径"被用到：路由配了 `knowledge` 才检索注入，故障自动降级不阻塞任务。

**第 3 步 · 触发路由**（「触发路由」）：场景名 → target（先用 llm）→ 会话策略（new/per_key/fixed）→ 可选挂知识库/送达/重试。

**第 4 步 · 接入方**（「接入方」）：给业务系统发钥匙，限定可调路由与限速。

**第 5 步 · 业务接入**：回到路由点「调用代码」——四个页签按需取：
- 业务后端 PHP / curl：粘到业务事件点，fire-and-forget；
- 智能体技能·触发：本地智能体、脚本或第三方 agent 装个技能就会调中枢；
- 本地执行器·干活：见第 6 步。

还要网页上直接聊？「聊天入口」页新建入口绑这条路由 → 拿一行 `<script>` 贴进任何网页（或直接发「在线演示页」链接给人试）。同步问答、按访客自动续聊；访客默认匿名。要带登录身份：入口配「票据签发方」，业务后端在登录页用自己的接入方 token 签短票（嵌入代码弹窗含 PHP 样例），组件 `data-ticket` 带上 → 验签通过的 uid 进任务元数据，可作工具调用的操作主体，会话跨设备连续。入口默认可上传图片、语音和常见文件（服务器本地 `data/uploads`），也可关联**媒体存储**切到业务对象存储；路由的**多模态输入策略**决定这些素材是先识别/转写/抽取，还是直送具备对应能力的模型或执行器。还能配**外观**（窗口尺寸/位置/头像/气泡图标/标题对齐）、**页面登记**让 Agent 知道访客在哪个页面提问——见下「可选增强」。

**第 6 步 · 接本地大脑**（需要时，「调度目标」）：注册一个 executor 类目标。优先在路由的「调用代码 → 执行器接入」复制短引导交给 Agent；完整、版本化的接入 Skill 也可直接读取：`<中枢地址>/connect/skills/connect-bailinghub-executor/SKILL.md`。

手工接入时，在你的机器上运行通用执行器：

```bash
curl -fsSL <中枢地址>/connect/executor.mjs -o bailing-executor.mjs
read -rsp 'BailingHub executor token: ' BAILING_EXECUTOR_TOKEN && printf '\n'
export BAILING_EXECUTOR_TOKEN
node bailing-executor.mjs --hub <中枢地址> --targets <目标名> --cmd '<你的命令>'
```

约定只有三条：stdin 进任务、stdout 出结果、退出码非 0 = 失败。`--cmd './my-agent.sh'` 可以替换成任何能读 stdin、写 stdout 的命令。出站长轮询，内网机器即可。本仓 `src/executor.ts` 是带会话/能力档的进阶参考实现；可用 `BAILING_EXECUTOR_CONCURRENCY` 或 `executor.concurrency` 开多个本地 worker 并发认领，同 thread 串行仍由中枢调度保证。

OpenClaw 已配置好模型 Provider 时，可再下载一个零依赖适配器，把上面的 `--cmd` 直接指向 OpenClaw：

```bash
curl -fsSL <中枢地址>/connect/openclaw-stdio.mjs -o bailing-openclaw.mjs
node bailing-executor.mjs --hub <中枢地址> --targets <目标名> \
  --runtime openclaw --cmd 'node bailing-openclaw.mjs --agent bailinghub-executor'
```

推荐给执行器单独创建 OpenClaw Agent，并使用 `minimal` 工具配置。适配器默认只转交任务正文和会话标识，不把业务工具令牌交给 OpenClaw；工具调用应在领取/回传链路跑通后再单独接入治理代理。

**第 7 步 · 结果去哪**（三选一，可叠加）：
- 不取回：fire-and-forget；
- 拉：`GET /jobs/{job_id}` 轮询，或路由配 `callback`（HMAC 签名回调，验签见 CONTRACT.md）；
- 推（送达层）：路由配 `delivery`。`{"type":"webhook","url":...}` 内置；要推自有渠道（企微/钉钉/短信/…）＝注册 `X-notify` 执行器目标 + 用第 6 步的执行器接它，中枢零改动。本仓的 wecom-notify 是这个模式的参考实现，部署方需配置自己的发送命令。

**第 8 步 · 运维**（「后台账号」「变更审计」「任务」）：RBAC 固定角色（admin / kb_editor / viewer）；顶栏看执行器在线；`BAILING_ALERTS_*` 配自监控告警出口，可走 webhook 或自家送达插座；`npm run doctor` 做本地配置/文档/开源边界体检，`npm run selftest` 在已运行实例上验证契约闸门。

**第 9 步 · 给 AI 接工具**（要"能查、能办"时，「工具源」+「审批意图」）：

1. 业务系统声明可调接口 + 实现验签中间件。**PHP 业务直接用 SDK**（`sdk/php/`，零依赖）：控制器方法标 `#[AiTool(...)]` 注解（完整字段注册表见 CONTRACT §2.4a，构建期自动体检），`SpecServer` 一行挂出 `/.well-known/bailing/tools.json`，`Verify::toolCall` 即验签；其他语言照 CONTRACT 手写 openapi.json + 验签（参考 `docs/examples/bailing-tool-verify.php`）；
2. 控制台「工具源」注册：base_url + 签名密钥 + spec（粘贴或 URL 拉取，推荐业务把 spec 发布到 `/.well-known/bailing/tools.json` 并开自动刷新——业务侧新标注的接口自动成为工具，清单增删/风险变化会审计并告警；中枢拉 spec 也带 `sha256=` 签名，业务可选只对中枢开放该地址），「工具清单」预览能看到哪些接口进来了、哪些被跳过及原因；「授权探针」会显示业务侧是否对合成越权主体 fail-closed；页面右上「开发文档」跳转官网对应文档；
3. 路由挂 `tools`：`{"sources":[{"provider":"你的工具源","allow":["tenant.staff.*"],"subject_field":"operator_uid"}],"max_calls":5}` ——每个来源的 `allow` 是 scope 白名单（双闸：业务标了 ∩ 路由允许才暴露）；`subject_field` 指明 metadata 里哪个字段是操作主体，业务后端触发时写入（全程不经 LLM）；跨系统场景可在 `sources` 继续添加来源；
4. 完成。llm 走 function-calling 循环；执行器大脑（自研智能体 / 脚本 / 第三方运行时）认领件里自带工具清单 + `tool_token`，curl 中枢代理即可调用——两条路走**同一套**白名单/风险闸/限流/审计/签名出口。
5. 风险操作不放养：`high` / `confirm-required` 的调用先冻结成「审批意图」，批准后任务自动重跑，且只允许执行被批准的那个调用快照。

鉴权两段式（谁负责什么）：**中枢管 reach**（这路 AI 最多够到哪），**业务管 authority**（这个人此刻能不能做——验签后用你既有的权限表裁决，AI 与人点按钮走同一条路径）。

> **诚实一点（别当成粘贴一段中间件）**：你**不需要改架构**，但非平凡集成是个小项目——给每个端点标 x-agent-capability（scope/risk）+ 实现验签**与授权**两道闸 + **把 On-Behalf-Of 主体接进你的权限表**（这是 authority 闸，**服务器到服务器没有 session，平时的登录态鉴权不生效，不接 = 认证了但没授权**）+ 定空主体语义 + 发布 spec + 注册工具源 + 配 allow 白名单。PHP 用官方 SDK 的 `Verify::gate()`（authorize 是**必填回调、fail-closed**），把"授权"这步在代码层钉死，避免最常见的"只验签不授权"陷阱——切勿把 authorize 写成 `return true`。

## 可选增强（按需开，都在控制台，业务侧零代码或极小改动）

九步跑通后，这些能力按需叠加，互不影响、默认不打扰：

- **入站渠道（企微等）**（「渠道」）：让外部平台消息**直接进中枢**——注册 `kind=wecom + config + route_key`，企微自建应用「接收消息」填回调 `https://<中枢>/wecom/<渠道名>`。窗口内被动回复、超窗异步推。完整步骤/字段/握手见 **docs/CHANNELS.md**。
- **聊天附件上传**（「媒体存储」+「聊天入口」）：不开任何对象存储也能用，默认写服务器 `data/uploads` 并返回 `/uploads/*` 公开 URL；生产需要 CDN、生命周期管理或多副本共享时，再登记业务对象存储（当前 COS：region/bucket/AK·SK/公开域名/写入前缀）并让聊天入口关联它。图片、语音、文件都会得到**永久 URL**，一份存储喂三件事：完整追溯 / 多模态输入策略 / 业务接口入参。路由决定图片、语音、文件分别走识别、转写、文本抽取、摘要、直送或忽略；指向业务自己的桶则 URL 即业务 CDN、零转存。见 CONTRACT §2.4e。
- **对话记忆**（「触发路由 → 对话记忆」）：长会话开**滚动摘要**（默认关、不改原行为）——超水位线的早期对话异步压缩成结构化摘要，后续连摘要一起注入，上下文不爆。
- **页面感知**（「聊天入口 → 页面登记」）：配 URL 模式 → 页面名+说明的登记表，AI 据此知道访客在哪页提问、精准定位；路由再开「页面感知检索」可偏置召回本页相关文档（全局仍兜底）。见 CONTRACT §1.2。
- **组件外观与运营启停**（「聊天入口」）：窗口尺寸/高度、标题对齐、气泡贴左/右下角与像素偏移、头部头像、自定义气泡图标、底部品牌标识都可配置；入口可在列表一键暂停，已嵌入页面无需删除脚本，恢复后自动重新展示。

## 不同形态怎么配（速查）

| 你的情况 | 配法 |
|---|---|
| 只想要"带知识库的异步 LLM 工人" | 第 1–5 步即止，target=llm |
| 有本地 agent、脚本或第三方运行时，想让它干重活 | 注册 executor 目标 + 通用执行器 `--cmd './my-agent.sh'`（或用 src/executor.ts 获得能力档/项目目录支持） |
| 有自研智能体/其他框架 | 同上，`--cmd` 换你的 CLI；或自己实现 claim/result 两个 HTTP 端点（见 CONTRACT.md） |
| 要把结果推进自有 IM/短信 | 注册 `<渠道>-notify` executor 目标，执行器里调你的发送命令 |
| 业务要同会话多轮追问 | 路由 session_policy=per_key + metadata 带业务键；总账自动装配上下文 |
| 要让 Agent 直接查/办业务（客服查订单、运营改配置） | 第 9 步：业务按 ACC 标 `x-agent-capability` + 注册工具源 + 路由挂 tools；写操作走「审批意图」 |
| 要在官网/H5 放个聊天框 | 「聊天入口」建入口绑路由 → 一行 script 嵌入；Origin 白名单 + IP 限速防滥用；外观/传图/页面登记按需开 |
| 要让外部平台(企微)消息直接进中枢 | 「渠道」注册 `kind=wecom` + 回调 `/wecom/<名>` 绑路由；见 docs/CHANNELS.md |
| 聊天里要把图传给 AI 看 / 当商品图 | 「对象存储」登记桶 + 「聊天入口」关联；图落桶取永久 URL；见 CONTRACT §2.4e |
| 长会话上下文要压缩 | 路由「对话记忆」开滚动摘要（默认关） |

## 中枢承诺不变的东西

信封契约 v1（`/run`、`/jobs`、executor claim/result、外发签名）是冻结的——见 CONTRACT.md。其余一切（大脑、渠道、场景）都是插座上的插头，随你换。

## 接真实业务前的检查

在把 demo 配置换成真实系统前，至少确认：

- 生产环境设置 `BAILING_ENV=production`，敏感项只从环境变量或密钥管理器注入；
- 每个业务系统都有独立接入方 token、路由白名单和限速；
- 工具源只暴露已标注 `x-agent-capability` 的接口，路由 `tools.sources[].allow` 分别只放行必要 scope；
- 业务侧验签后必须执行自己的授权判断，不能只验签就执行写操作；
- `high` / `confirm-required` 工具已经接到业务审批流，或明确使用中枢控制台作为兜底审批；
- 审计保留期已经按组织合规要求配置；如果必须永久留存，保持 `BAILING_AUDIT_RETENTION_DAYS=0`；
- `/admin/system/status`、任务 trace、变更审计和告警出口都能正常查看；
- 真实凭证、真实域名、客户数据和本机路径没有进入公开仓、示例配置或日志样例。
