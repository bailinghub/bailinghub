# Agent Auth v1

[English](AGENT_AUTH_API.en.md) | 简体中文

Agent Auth v1 把本地智能体的一次浏览器授权绑定到业务系统现有登录态，并签发可撤销的
Agent Session。BailingHub 提供协议与服务端 SDK 方法；业务系统负责自己的登录页、授权页样式、
用户/租户/角色判断和最终业务权限校验。

完整组件关系见 [Agent Client v1 接入指南](AGENT_CLIENT_QUICKSTART.md)。本协议不承载套餐、付费、
模型凭据或业务 API Secret。

## 1. 参与方与凭据

| 参与方 | 使用的标识/凭据 | 边界 |
|---|---|---|
| 本地 Agent SDK | 公开 `client_app_id`、PKCE、loopback callback | 不持有 Client Token 或业务密码 |
| 业务授权后端 | 接入方 Client Token | 只在服务端调用 context/approve/deny/revoke |
| BailingHub Core | Agent authorization/session 账本 | 只存 access/refresh token 的 SHA-256 摘要 |
| 业务工具端点 | Tool Provider Secret 与业务权限表 | 每次真实调用仍重新验签并校验权限 |

`client_app_id` 是公开客户端标识。Client Token 是业务后端秘密，不能进入浏览器 JavaScript、
本地插件配置、URL、截图或日志。

## 2. 前置配置

中枢管理员在“接入方”创建应用并配置：

- `app_id`：稳定的公开客户端标识，例如 `merchant-agent`；
- `agent_authorize_url`：业务系统自己的一个稳定、统一 HTTPS 授权入口，例如
  `https://business.example.com/agent/authorize`；它不能绑定具体账号、租户或门店；
- `allowed_routes`：该应用最多可申请的 route；
- `enabled=true` 与合理限速。

本地插件不会填写业务 URL。业务系统存在多账号或多租户时，统一授权入口负责完成登录、切换账号和
选择租户；业务后端再从所选结果对应的当前服务端登录态派生可信身份，不能让本地模型或 URL 参数
直接指定业务主体。

生产授权页只允许 HTTPS。本机开发可以使用带显式端口的 `127.0.0.1` 或 `::1` HTTP URL。

## 3. 授权流程

```text
本地 SDK                  BailingHub                  业务授权页/后端
   | POST authorizations      |                              |
   |------------------------->|                              |
   | authorization_url        |                              |
   |<-------------------------|                              |
   | 浏览器打开 -------------------------------------------->|
   |                          |<-- context (Client Token) ----|
   |                          |<-- approve/deny ---------------|
   |<---- loopback redirect --|-------------------------------|
   | POST token + PKCE ------>|                              |
   | Agent Session tokens <---|                              |
```

1. SDK 生成随机 `state`、PKCE verifier/challenge 和随机 loopback callback；
2. Core 创建 10 分钟有效的授权请求，返回业务授权页 URL；
3. Core 只向配置好的授权页追加 `authorization_id`；
4. 业务页要求用户先完成业务系统登录，并在需要时切换账号或选择当前账号有权访问的租户；
5. 业务后端用 Client Token 查询上下文，并从选择完成后的当前服务端登录态推导可信身份；
6. 批准后 Core 返回锁定 callback 的 `redirect_uri`，浏览器跳转回本机；
7. SDK 用一次性 code 和 PKCE verifier 换取 Agent Session；
8. 后续 Runtime 请求使用短期 access token，SDK 用轮换 refresh token 续期。

## 4. HTTP 端点

### 4.1 本地 SDK：创建授权请求

`POST /agent-auth/v1/authorizations`

```json
{
  "client_app_id": "merchant-agent",
  "redirect_uri": "http://127.0.0.1:49152/callback",
  "state": "random-csrf-state",
  "requested_routes": ["order-assistant"],
  "device_label": "My workstation",
  "code_challenge": "<PKCE-S256-base64url>",
  "code_challenge_method": "S256"
}
```

```json
{
  "authorization_id": "<uuid>",
  "authorization_url": "https://business.example.com/agent/authorize?authorization_id=<uuid>",
  "expires_in": 600
}
```

callback 必须是带显式端口的 loopback HTTP URL；不接受公网 callback、任意域名或 URL 用户名/密码。
v1 每次请求至少一个且最多 64 个明确 route，不接受 `auto` 或 `*`。宿主适配器首版应按一条连接
申请一个 workspace。

### 4.2 业务后端：查询授权上下文

`GET /agent-auth/v1/authorizations/{authorization_id}`

```http
Authorization: Bearer <BUSINESS_CLIENT_TOKEN>
```

响应只包含应用名、设备名、请求的 routes、状态和过期时间，不包含 PKCE、callback 或 token。

### 4.3 业务后端：批准或拒绝

`POST /agent-auth/v1/authorizations/{authorization_id}/approve`

```http
Authorization: Bearer <BUSINESS_CLIENT_TOKEN>
Content-Type: application/json
```

```json
{
  "principal": {
    "id": "user-42",
    "tenant": "tenant-7",
    "roles": ["manager"],
    "audience": "internal"
  },
  "on_behalf_of": "tenant-7:user-42",
  "allowed_routes": ["order-assistant"]
}
```

`principal`、`on_behalf_of` 和 `allowed_routes` 必须由业务后端根据当前登录态和权限表生成；不得信任
浏览器表单、query 参数或模型输出。批准范围必须同时属于本次请求与接入方 `allowed_routes`。

拒绝使用 `POST /agent-auth/v1/authorizations/{authorization_id}/deny`，body 为 `{}`。approve/deny
都返回一个由 Core 构造的 `redirect_uri`；页面只能跳转该值，不得接受浏览器自带的回调地址。

### 4.4 本地 SDK：兑换与刷新

`POST /agent-auth/v1/token`

授权码兑换：

```json
{
  "grant_type": "authorization_code",
  "client_app_id": "merchant-agent",
  "code": "<one-time-code>",
  "redirect_uri": "http://127.0.0.1:49152/callback",
  "code_verifier": "<PKCE-verifier>"
}
```

refresh token 轮换：

```json
{
  "grant_type": "refresh_token",
  "client_app_id": "merchant-agent",
  "refresh_token": "<refresh-token>"
}
```

access token 默认 15 分钟有效，refresh session 默认 30 天有效；每次刷新都会轮换 refresh token。
重复使用旧 refresh token会失败关闭。SDK 应把 access/refresh token 保存到系统安全凭据存储，而不是
连接元数据或插件配置。

### 4.5 会话查询与撤销

- `GET /agent-auth/v1/session`：Agent access token Bearer，返回当前会话的非秘密元数据；
- `POST /agent-auth/v1/revoke`：可用 Agent access token 撤销，或用
  `client_app_id + refresh_token` body 撤销；
- `POST /agent-auth/v1/sessions/{session_id}/revoke`：业务后端使用 Client Token 撤销该应用的会话。

员工离职、租户禁用、设备丢失或业务权限撤销时，业务系统应主动撤销相关会话。即使会话尚未撤销，
业务工具端点仍必须在每次调用时按当前权限表重新裁决。

## 5. 业务授权页实现规则

- 页面属于业务系统，不由 SDK 自动注入；可以完全继承业务系统自己的 UI 风格；
- 同一 Client App 使用一个稳定、统一的入口，不为每个账号、租户或门店配置不同 URL；
- 未登录先跳业务登录，登录完成后回到同一授权请求；已登录用户可在这里切换账号，并从服务端确认
  其有权访问的租户中进行选择；
- 明确展示当前账号、租户、设备名和申请的 workspace；
- 授权页前端只持有 `authorization_id`，Client Token 只在后端；
- 所有响应使用 `Cache-Control: no-store`，不要在分析、监控或错误上报中记录 token；
- 对重复、过期、已处理请求给出明确终态，不重新批准；
- CSP、CSRF、点击劫持和开放重定向防护沿用业务系统生产安全基线。

## 6. 错误与恢复

- `invalid_client`：应用未启用、未配置授权页或 route 不在应用白名单；
- `invalid_request`：字段、PKCE、callback、route 或主体格式不合法；
- `route_not_allowed`：业务后端批准了请求之外或应用未允许的 route；
- `invalid_grant`：code/PKCE/refresh token 无效、过期、重放或不匹配；
- `access_denied`：用户拒绝授权；
- `401 unauthorized`：业务后端 Client Token 或 Agent access token 无效；
- `409/410`：请求已处理或已过期。

客户端遇到刷新失败不得回退为管理员 Token、Client Token 或匿名调用；应清理/隔离失效会话并要求
用户重新执行浏览器授权。

本机多连接实现可以用 `connectionName` 选择连接，但它不是可信身份声明。若同一公开绑定
（Hub + `client_app_id` + workspace）再次授权得到相同可信 `on_behalf_of`，SDK 可撤销并移除旧的
本机连接；不同 `on_behalf_of` 保持独立。若新授权已成功、但旧会话撤销或本地清理失败，SDK 应保留
可恢复状态并返回 `cleanupRequired`：此时不要重复授权，应先按返回信息清理旧连接。Core 不把该
本机去重规则提升为跨设备的全局会话唯一约束。
