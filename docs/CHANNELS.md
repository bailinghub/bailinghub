# 百灵中枢 · 入站渠道接入说明（2026-06 上线）

「入站渠道」是**外部平台的消息进中枢的前门**：用户在企业微信（未来飞书等）里发消息 → 平台回调中枢 → 中枢按渠道绑定的路由派给大脑 → 把回答送回平台。与 `POST /run`（业务后端主动调）、网页聊天组件（公开面）并列，是第三类触发入口。

设计要点：**`kind + config + route_key` 三段解耦**——`kind` 区分平台、`config` 放平台专属参数（含密钥）、`route_key` 把「消息进来」与「谁来处理」解开。换大脑只改路由，渠道配置不动；加平台只加一个 handler，信封不变。当前实现 **企业微信（wecom）**。

---

## 1. 一条渠道是什么

控制台「渠道」注册表（`bz_channels`），每行一条入站渠道：

| 字段 | 说明 |
|---|---|
| `name` | 渠道名，**同时是回调 URL 的路径段**：企微回调 = `https://<中枢域名>/wecom/<name>`。仅小写字母/数字/中划线/下划线 |
| `kind` | 平台类型，当前 `wecom`（飞书等预留） |
| `route_key` | 绑定的触发路由（即大脑）——消息都派给它 |
| `config` | 平台专属配置（见下，含密钥，列表只回显掩码） |
| `enabled` | 停用即回调返回 404，不处理 |

企微 `config` 字段：

| 字段 | 必填 | 说明 |
|---|---|---|
| `token` | 是 | 企微「接收消息」配置里的 Token，用于回调签名校验 |
| `aes_key` | 是 | 企微 EncodingAESKey（43 位），消息加解密用 |
| `corpid` | 否 | 企业 ID。**留空时运行时从解密报文的 receiveId 自动识别**；多企业共用一个应用可不填 |
| `agentid` | 否 | 应用 AgentId——**仅「超窗异步主动推」需要**（被动回复不需要） |
| `secret` | 否 | 应用 Secret——**仅异步主动推需要**（换 access_token 调 qyapi） |
| `reply_wait_ms` | 否 | 被动回复等待窗口，默认 4000，**上限 4500**（须 < 企微 5s 超时）。窗口内答完走被动回复，超窗转异步推 |

> 密钥纪律：`token` / `aes_key` / `secret` 列表只回显掩码，编辑时**留空 = 保留原值**；`corpid` / `agentid` 非密钥，明文回显。

---

## 2. 企业微信接入步骤

### 2.1 中枢侧：注册渠道
控制台「渠道 → 新建」：填 `name`（如 `kefu`）、选 `kind=wecom`、选已建好的 `route_key`、填 `token` + `aes_key`（必填），如需主动推再填 `corpid` + `agentid` + `secret`。保存即生效（无需重启）。回调地址即 `https://<中枢域名>/wecom/<name>`。

### 2.2 企微侧：自建应用「接收消息」配置
进入企业微信管理后台 → 应用管理 → 你的自建应用 → 「接收消息」→ 设置 API 接收：
- **URL**：`https://<中枢域名>/wecom/<name>`（与 2.1 的 `name` 一致）
- **Token**：与渠道 `config.token` 一致
- **EncodingAESKey**：与渠道 `config.aes_key` 一致

点「保存」时企微会发一个 **GET 验证请求**（带 `msg_signature/timestamp/nonce/echostr`），中枢解密 `echostr` 原样回显完成握手。验证不过 → 检查 token/aes_key 是否两侧一致、URL 是否可公网访问。

### 2.3 收发链路（中枢自动处理，了解即可）
1. **GET**（企微保存 URL 时）：校验签名 + 解密 echostr 回显 → 握手成功。
2. **POST**（用户发消息）：校验 `msg_signature` → 解密 → 可选校验 corpid → 取 `FromUserName`（成员 UserID，可信主体）和文本内容。
3. 非文本消息回「只看得懂文字」；关注/进入应用等 event 静默 ack；同一 `MsgId` 企微会重试，中枢按 MsgId 去重，重试一律空 ack 不重复处理。
4. 文本消息 → 按 `route_key` 派给大脑，会话按 `wecom:<渠道>:<成员>` 切分（同一成员连续对话自动续聊），主体 = `wxuid:<成员UserID>`。
5. **快路径**：`reply_wait_ms` 窗口内答完 → **被动加密回复**（零依赖，不碰 qyapi）。
6. **慢路径**：超窗 → 空 ack + 任务完成后**异步主动推**（走 qyapi，需 `agentid`+`secret`+可识别的 `corpid`）。执行器类慢大脑、长任务靠这条覆盖。

---

## 3. 身份与安全

- **主体可信**：`FromUserName` 来自企微**解密后**的报文，是企业成员 UserID，中枢作为可信主体写入（`metadata.wecom_userid`、principal `wxuid:<user>`）。若路由挂了写工具，这个主体会作为 `X-Bailing-On-Behalf-Of` 发给业务侧——业务按自家权限表裁决。
- **签名校验**：回调 `msg_signature` 必须用渠道 `token` 重算一致才处理，伪造请求被 401 挡掉；corpid 配了则再校验解密报文的 receiveId 匹配。
- **注意**：入站渠道走平台自己的身份体系（企微解密报文里的成员身份），中枢信任的是「平台已验明的成员」。要让 Agent 替成员做写操作，仍按工具插座的 on-behalf-of + `sha256=` 签名 + 业务侧裁决那一套走（见 [CONTRACT §2.4](CONTRACT.md)）。
- 服务暂停（kill switch）时回「服务暂停中，请稍后再试」。

---

## 4. 扩展到其他平台

加飞书/钉钉等：在 `src/server.ts` 加一个按 `channel.kind` 分派的入站 handler（参照 `handleWecomInbound`：平台 URL 验证握手 + 消息解密 + 派路由 + 回复/推送），渠道注册表与 `route_key` 解耦机制完全复用。回调路径约定 `/<平台>/<渠道名>`。被动回复 / 异步推的窗口取舍按平台超时规则定。

相关：[CONTRACT.md](CONTRACT.md)（边界契约）、[ARCHITECTURE.md](ARCHITECTURE.md)（整体架构）。
