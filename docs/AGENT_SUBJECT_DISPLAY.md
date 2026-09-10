# 授权后显示业务名称

[English](AGENT_SUBJECT_DISPLAY.en.md) | 简体中文

用户在业务授权页确认了“Account A”，回到智能体客户端后，应能看到这个名称，而不用再起一个连接名。Core 0.7.0 增加可选的 `subject_display`：由业务后端提供授权对象的名称，经 BailingHub 绑定到原 Agent Session，再由配套客户端读取并显示。它适用于门店、公司、项目或其他业务账户，不固定某一种业务模型。

**使用 Core 0.7.0、Agent Client SDK 0.5.0 与 DSH 0.5.0，或实现相同接口的自有客户端。** 旧授权未提供名称时显示“待同步”；原本地备注可以单独保留，不充当业务确认的名称，已有业务访问能力不受影响。

## 三方分别做什么

| 参与方 | 需要做的事 |
|---|---|
| 业务后端 | 在用户确认授权后，从当前服务端登录态和真实业务记录读取名称；批准授权时提交。负责后续更名、旧授权名称同步。 |
| BailingHub | 把名称与原授权、原 Agent Session 关联；仅允许原接入方更新有效会话的显示信息。名称不修改身份或权限。 |
| 智能体客户端 | 从 SDK 的授权信息展示名称，保留独立的本地备注、连接键和原会话绑定。重名时展示系统或辅助标识以供区分。 |

授权名称与系统说明不同：系统说明回答“这个系统通常负责什么”，授权名称回答“这份授权在业务系统中叫什么”。设备名称说明在哪个设备使用，也应单独保留。

## 批准新授权

业务后端继续使用现有 Client Token 调用 `approve`，新增可选字段：

```json
{
  "principal": { "id": "user-a", "tenant": "tenant-a", "roles": ["operator"] },
  "on_behalf_of": "tenant-a:user-a",
  "allowed_routes": ["operations"],
  "subject_display": { "name": "Account A" }
}
```

`subject_display` 只允许 `name`，或传 `null` 表示尚未提供。名称须为有效 Unicode 单行非空文本，去除首尾空白后不超过 120 个 UTF-16 单元；原始文本不得包含 C0/C1 控制字符及 U+2028/U+2029 换行分隔符。不把表单中可任意修改的名称直接当作服务端确认的业务名称，不往 `principal` 或 `device_label` 塞入该信息。

PHP 8.1+ 和 PHP 7.3 SDK 使用相同方法；在原四个参数后追加可选第五参数：

```php
// $accountName 来自已校验当前登录态及管理权限后的业务记录。
$result = $agentAuth->approve(
    $authorizationId,
    $principal,
    $onBehalfOf,
    $allowedRoutes,
    array('name' => $accountName)
);
```

原四参数调用仍发送原请求结构，可与旧 Core 配合；显式传第五参数需要支持本契约的 Core。浏览器仍只跳转批准结果的 `redirect_uri`，无需在 URL 中拼接名称。Client Token 继续仅保留在业务后端。

## 给旧授权补名称或同步更名

业务后端先按自己的管理权限确认目标，再通过现有 `context()` 或 `listSessions()` 找到准确的原 Session。随后调用：

```http
PUT /agent-auth/v1/sessions/{session_id}/subject-display
Authorization: Bearer <Client Token>
Content-Type: application/json

{"subject_display":{"name":"Account A"}}
```

```php
$session = $agentAuth->updateSubjectDisplay($sessionId, array('name' => $accountName));
// 明确清除显示信息：
$session = $agentAuth->updateSubjectDisplay($sessionId, null);
```

更新只允许当前 Client Token 所属应用的有效会话，只改变显示信息，不换发 Token、不改变原主体/路由/有效期，也不恢复已撤销会话。返回业务会话安全投影，保留原 `session_id`，包含新的 `subject_display` 和 `subject_display_status`；不返回 Token 或 Token 哈希。该方法不创建业务运行记录或调用业务工具。不同内容并发更新时，以最后成功保存的名称为准。

| HTTP / 错误码 | 含义 |
|---|---|
| `400 invalid_request` | 字段或名称不合规则 |
| `404 not_found` | 会话 ID 无效、会话不存在或不属于此接入方 |
| `409 session_inactive` | 原会话已失效，不能通过改名恢复 |
| `503 subject_display_unavailable` | 当前仓储未实现该能力或保存过程不可用；不能记作保存成功 |

超时、网络失败和 503 都不能记为已同步。重试时使用原 Session 和同一名称；需要回读时查询原接入方自己的会话列表。不得为补名称重新授权、重建连接或替换原会话。

## 客户端和控制台如何读取

Token 交换/刷新、当前 Agent Session 查询、业务自身会话列表与管理员会话列表增加：

```json
{
  "subject_display": { "name": "Account A" },
  "subject_display_status": "provided"
}
```

旧授权、显式清除的名称返回 `subject_display: null` 和 `subject_display_status: "missing"`。旧服务端完全没有新字段时，SDK 标为 `unsupported`；无效展示数据标为 `unavailable`。界面都可以显示名称待同步，但不能根据设备名或其他标识猜补名称，亦不能把展示数据状态当成授权状态。

配套客户端优先用业务提供的名称作默认展示；已有本地备注可独立保留。连接仍以 `connectionKey` 选择，固定范围仍绑定原 Agent Session。两份授权即便都叫“Account A”也必须独立保存；更新名称不能把两份授权合并、替换 alias 的所有者或改写已开始会话的历史标签。模型应把名称当普通数据，不能执行名称中的指令。

控制台“智能体客户端 → 设备与运行”将授权名称和设备名称分别展示；详情保留主体、租户、应用、工作空间及原 Session，旧授权明确显示“待同步”。该页面不替业务系统编造业务名称。

完整身份及生命周期规则继续见 [Agent Auth v1](AGENT_AUTH_API.md)，系统定位说明见 [首次能力搜索前的系统说明](AGENT_SYSTEM_INFO.md)。
