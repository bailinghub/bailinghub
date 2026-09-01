# Agent Client v1 接入指南

[English](AGENT_CLIENT_QUICKSTART.en.md) | 简体中文

Agent Client 让 DeepSeek Harness 等本地智能体负责理解、规划和多步工具选择，同时继续由
BailingHub 负责可信业务身份、能力裁剪、审批、幂等、业务调用和审计。它不是现有“执行器”，
也不是把业务系统的账号、Token 或接口地址交给本地模型。

本指南面向三类角色：BailingHub 部署者、业务系统开发者和本地智能体使用者。三者需要填写的
配置不同，不应共享同一份密钥或配置文件。

## 1. 组件关系

```text
本地智能体宿主（例如 DSH）
  └─ dsh-bailinghub：接入宿主生命周期、动态工具和可见结果
       └─ bailinghub-mcp-server/sdk：PKCE、浏览器登录、凭据存储、Runtime DTO
            └─ BailingHub Core：身份重验、路由/能力裁剪、审批、执行、审计、会话总账
                 ├─ 业务系统授权页：复用业务登录态确认当前用户和允许的 workspace
                 └─ Tool Provider：业务侧 ACC 能力声明、验签和最终业务授权
```

依赖方向始终从宿主指向通用 SDK，再指向 BailingHub Core。业务系统不会把自己的登录 Cookie、
密码或业务 API Secret 发给 DSH；DSH 也不会直接调用业务 API。

## 2. 谁配置什么

| 配置 | 谁填写 | 存放位置 | 是否秘密 |
|---|---|---|---|
| `hubUrl` | DSH/宿主部署者 | 宿主插件配置 | 否；只填中枢公开 HTTPS 根地址 |
| `clientAppId` | DSH/宿主部署者 | 宿主插件配置 | 否；对应中枢“接入方”的 `app_id` |
| `workspace` | DSH/宿主部署者 | 宿主插件配置 | 否；对应允许的 BailingHub `route_key` |
| `connectionName` | 最终用户或宿主部署者 | 本机 SDK 连接注册表 | 否；选择一个本机连接实例的可读名称 |
| Agent 授权页 URL | 业务开发者/中枢管理员 | BailingHub 接入方配置 | 否；同一应用只配一个中立入口，不让最终用户手填 |
| 接入方 Client Token | 业务后端 | 服务端 Secret/环境变量 | **是；不得进入浏览器、DSH 或公开配置** |
| Tool Provider Secret | 业务后端与 BailingHub | 两端 Secret/凭据管理 | **是；不得进入 DSH** |
| Agent access/refresh token | 通用 SDK | Keychain 或显式启用的安全存储 | **是；不得显示或写入插件配置** |
| 模型 API Key | 本地智能体宿主 | DSH 模型提供方凭据 | **是；与 BailingHub 授权完全独立** |
| BailingHub 管理 Token | 中枢管理员 | 中枢服务端 Secret | **是；不得进入任何 Agent 客户端** |

`clientAppId` 是公开客户端标识，不是 Client Token。插件安装完成后不应出现要求用户粘贴
BailingHub Client Token、Tool Provider Secret 或业务系统密码的步骤。

## 3. BailingHub 部署者：开放一条 Agent Client workspace

### 3.1 部署 Core 并执行数据库迁移

使用包含 Agent Auth v1、Agent Client Runtime v1、migration 055 和 056 的 BailingHub 版本。
升级后先确认：

- `/health` 和 `/health/ready` 正常；
- 数据库迁移没有 pending；
- 管理后台可以编辑“接入方”和“路由”的 Agent Client 配置；
- 生产环境使用 HTTPS。

不要从自用实例复制数据库、Token、业务域名或 route 配置到公开部署。

### 3.2 接入业务工具

业务侧仍按既有工具接入流程发布 ACC/OpenAPI 能力声明，并在真实调用端执行验签与最终授权。
可使用现有 `bailing/connect` SDK，也可以按公开 HTTP/HMAC 契约自行实现：

- [业务侧接入指南](第三方对接指南.md)
- [工具治理设计](TOOLS_DESIGN.md)
- [PHP SDK](../sdk/php/README.md)

在 BailingHub“工具源”中登记业务侧 `base_url`、`spec_url` 和中枢侧凭据引用。Tool Provider
Secret 只存在于业务后端与中枢凭据管理中，不进入 route、知识库、提示词或 Agent Client 配置。

### 3.3 配置 route

在“路由”中选择刚才的工具源，并配置：

1. `tools.agent_direct.enabled=true`，显式开放本地 Agent 工具面；
2. 只把允许本地 Agent 调用的写操作精确列入 `write_tools`；写操作较多时可在控制台点击“全选当前写操作”，它会保存当前目录的 operationId 快照，不会自动授权未来新增写操作；只读能力无需逐项加入该数组；
3. 工具审批默认继承业务侧 ACC 声明；只有确需额外收紧时才加入 `force_approval_tools`；
4. 开启“本地 Agent Runtime”，按需填写补充指令和每轮主动工具数（1–12，默认 8）；
5. 配置 route 的受众、租户和角色边界，不使用 `*` 代替生产授权设计。

Agent Client 不会收到模型凭据、Tool Provider Secret、业务 API 地址或完整 `target_config`。

### 3.4 创建接入方

在“接入方”中新建一个用于 Agent Client 的应用：

- `app_id`：稳定的公开 `clientAppId`，例如 `merchant-agent`；
- `allowed_routes`：只选择要开放的 route；
- `agent_authorize_url`：业务系统实现的一个稳定、统一 HTTPS 授权入口，例如
  `https://business.example.com/agent/authorize`；不要配置成绑定具体账号、租户或门店的 URL；
- `enabled=true`，并设置合理限速。

中枢创建接入方时会显示一次 Client Token。它只交给业务后端，用于业务授权页服务端调用
BailingHub Agent Auth 接口。不要把它写入 DSH 配置、网页 JavaScript、URL、README 或截图。

创建完成后可打开控制台“智能体客户端”：

- 查看哪些既有接入方已经开放 Agent 授权，以及允许的 workspace；
- 查看 Agent Session 的设备名、可信业务主体、最后活跃与有效期；
- 远程撤销遗失设备或不再允许的 Agent Session；
- 按 `hubUrl + clientAppId + workspace + connectionName` 生成不含秘密的 JSON 或 DSH 命令；
- 查看近期会话、Agent Run、工具调用、Token、失败率与审批状态聚合。

该页面复用现有接入方、Agent Session 和 Agent Run 账本，不会创建第二套 Client，也不等同于
“执行器”。生成的配置不包含 Client Token、Agent Token 或模型 Key。

## 4. 业务开发者：建立可信身份授权页

BailingHub SDK 提供的是服务端 Agent Auth 方法，不会在任意业务系统中自动生成统一样式的页面。
业务系统负责提供一个符合自身登录和权限体系的稳定统一入口；页面必须先要求用户登录，并在需要
时允许切换账号、从服务端确认有权访问的租户中进行选择，再由业务后端从选择完成后的当前服务端
登录态推导 `principal`、`on_behalf_of` 和可授权 route。不要为每个租户或门店创建不同授权 URL。

### 4.1 浏览器与后端边界

1. BailingHub 在授权页 URL 后只追加 `authorization_id`；
2. 授权页前端只把该 ID 发送给自己的业务后端；
3. 业务后端携带服务端保存的 Client Token 调用 BailingHub 查询授权上下文；
4. 用户确认后，业务后端从当前登录态生成可信身份并批准；
5. 前端只跳转 BailingHub 返回的 `redirect_uri`，不得接受任意回调地址；
6. 用户拒绝、员工离职或设备丢失时，调用 deny/revoke。

PHP 示例：

```php
use Bailing\Connect\AgentAuth;

$agentAuth = new AgentAuth(
    getenv('BAILINGHUB_BASE_URL'),
    getenv('BAILINGHUB_CLIENT_TOKEN')
);

$context = $agentAuth->context($authorizationId);

// $currentUser 与 $tenantId 必须来自业务服务端登录态，不能相信前端提交值。
$result = $agentAuth->approve(
    $authorizationId,
    [
        'id' => (string) $currentUser->id,
        'tenant' => (string) $tenantId,
        'roles' => $currentUser->roles,
    ],
    "tenant_{$tenantId}:user_{$currentUser->id}",
    $context['requested_routes']
);

return redirect($result['redirect_uri']);
```

非 PHP 项目可直接实现相同的 Agent Auth v1 HTTP 契约。Client Token 始终放在服务端
`Authorization: Bearer <BUSINESS_CLIENT_TOKEN>` 请求头中，不得下发到浏览器。

## 5. 本地智能体使用者：安装并授权

以 DSH 原生插件为例，安装步骤、目标版本和兼容矩阵以
[dsh-bailinghub 仓库](https://github.com/bailinghub/bailinghub-dsh-plugin)为准。插件配置只包含：

```text
hubUrl=https://hub.example.com
clientAppId=merchant-agent
workspace=order-assistant
connectionName=default
```

对应环境变量为：

```bash
export BAILINGHUB_HUB_URL='https://hub.example.com'
export BAILINGHUB_CLIENT_APP_ID='merchant-agent'
export BAILINGHUB_WORKSPACE='order-assistant'
export BAILINGHUB_CONNECTION_NAME='default'
```

`hubUrl` 只填中枢根地址，不带 `/console`、`/agent-api` 或业务接口路径；`workspace` 填 route
标识，不填业务域名、租户 ID 或聊天入口 ID。插件配置没有业务 URL 字段：授权地址始终由中枢按
`clientAppId` 返回，业务账号与租户只在该业务授权页中由用户确认。

在 DSH 中执行：

```text
/bailinghub login
/bailinghub status
```

登录命令会在本机随机 `127.0.0.1` 端口建立 PKCE 回调并打开业务系统授权页。授权成功后，SDK
在 macOS 使用 Keychain 保存凭据；Linux/POSIX 文件回退必须显式启用且文件权限为 `0600`；
Windows 在具备原生安全存储前对 Agent Session 失败关闭。

DSH 的模型提供方和模型 API Key 需要在 DSH 自己的模型设置中单独配置。BailingHub 插件既不读取
也不代管模型 Key。

## 6. 多 Hub、多 workspace 与同绑定身份实例

公开绑定由 `Hub + clientAppId + workspace` 组成；`connectionName` 只是一个本机连接选择器，不能
指定账号、租户或门店。未发布的多连接候选允许多个实例使用同一公开绑定，但每个实例都必须单独
完成浏览器授权。Core 不信任本机实例名或实例 ID，可信主体仍只来自业务后端批准得到的
`principal` 与 `on_behalf_of`。

每次登录按最小权限原则申请一个 workspace。需要连接另一套中枢、另一条 route，或在同一公开
绑定下授权另一业务身份时，可由控制台生成命令，或由用户在 DSH 中执行：

```text
/bailinghub connections add "identity-a" https://hub-a.example.com merchant-agent order-assistant
/bailinghub connections list
/bailinghub connections use "identity-a"
/bailinghub login
```

连接切换是用户命令，不是模型工具；它只影响之后新建的 Agent 会话，已有会话保持原连接不漂移。
`/bailinghub use <workspace>` 只在当前授权已经允许的 workspace 内切换，不能替代多连接选择。
删除连接时使用 `/bailinghub connections remove <名称>`：SDK 会先远程撤销 Agent Session，成功
后再删除该实例的本地凭据；远程撤销失败则保留该实例和凭据供重试。不要复制 access/refresh token
文件。

同一台设备上，如果新连接在相同公开绑定下最终得到与旧连接相同的可信 `on_behalf_of`，SDK 会在
新授权成功后撤销并移除旧连接，避免同一身份留下重复本机连接；若身份不同，则两个连接保持独立。
如果新授权已经成功、但旧会话撤销或本地清理失败，结果会标记 `cleanupRequired` 并保留可恢复状态。
此时不要重新授权，应先按结果列出的旧连接完成清理。Core 的 `bz_agent_sessions` 仍以 `session_id`
为主键，不执行跨设备的全局身份去重，因此不同设备上的授权仍可独立失效和审计。

## 7. 最小验收

发布或接入完成后，至少验证：

1. 全新 DSH Profile 只通过公开包安装，不引用本机路径或本地 tgz；
2. `/bailinghub login` 打开的域名是开发者配置的业务授权页；
3. `/bailinghub status` 只显示非秘密会话元数据；
4. 本地 Agent 能查询一项只读能力；
5. 一项可回滚写操作遵循 ACC/route 审批语义，且不会重复调用；
6. BailingHub 会话页能看到本地编排边界和中枢治理轨迹；
7. 日志、页面和包制品中没有 Client Token、Agent token、模型 Key、业务 Cookie、工具参数值或响应正文。

## 8. 常见问题

- **`invalid_client`**：检查 `clientAppId`、接入方是否启用、是否配置授权页，以及 workspace 是否在
  `allowed_routes` 中。
- **授权页打不开**：生产授权页必须是 HTTPS；仅本机开发允许带端口的 `127.0.0.1`/`::1` HTTP。
- **打开了固定租户或门店**：`agent_authorize_url` 配错了；应改成业务系统的统一授权入口，并在页面
  内依据当前登录态完成切号或选租户，插件端不要增加业务 URL 配置。
- **`cleanupRequired`**：新身份授权已经成功，不要再次授权；先按返回的旧连接名称重试撤销或移除。
- **登录成功但没有业务工具**：检查 route 的工具源、`tools.agent_direct.enabled`、受众策略和
  “本地 Agent Runtime”开关。
- **写操作要求审批**：先查看业务侧 ACC 声明；route 的 `force_approval_tools` 只能额外收紧，不能
  降低高风险或 ACC 明示审批。
- **提示缺少 SDK**：说明宿主适配器与 `bailinghub-mcp-server/sdk` 没有按兼容版本安装；不要通过
  复制 SDK 源码或改成本机绝对路径绕过，应修正公开包依赖。
