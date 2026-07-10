# bailing/connect（PHP 7.3 兼容版）

和 8.x 注解版**功能完全等价**，区别只在「怎么声明工具」：8.x 用 `#[AiTool]` 属性注解（PHP 8.0+ 语法），本版用 **fluent builder**（纯 PHP，**PHP ≥ 7.3** 即可），产出的 spec 与注解版**逐字段一致**。

> 用哪个版本：业务跑 **PHP 8.0+** 用注解版（`sdk/php`，更简洁）；跑 **PHP 7.3 / 7.4** 用本版。**不要为了对接去迁 PHP 版本**。
> 验签 `Verify`、票据 `Ticket`、spec 托管 `SpecServer` 三个运行时类两版 API 完全相同，签名公式逐字一致。

零依赖。能力声明遵循 ACC，验签与中枢接入约定见 `docs/CONTRACT.md §2.4`。

## 安装

```bash
# ① 从你的中枢直接下载（控制台「工具源 → 接入说明」也有此链接）
curl -O https://<中枢域名>/connect/bailing-connect-php7.tgz && tar -xzf bailing-connect-php7.tgz
```

```jsonc
// ② composer.json（path 仓库）
{
  "repositories": [{ "type": "path", "url": "./bailing-connect-php7" }],
  "require": { "bailing/connect-php7": "*" }
}
```

或 ③ 直接拷贝 `src/` 目录进项目——共 **5 个文件**（`ToolSpec`/`ToolDef`/`Verify`/`Ticket`/`SpecServer`）。零依赖，怎么引都行。命名空间同为 `Bailing\Connect`。

## 第一步：声明工具（builder，不动你的控制器）

```php
use Bailing\Connect\ToolSpec;
use Bailing\Connect\ToolDef;

$spec = ToolSpec::create('示例商城')              // 标题随便填，业务系统名
    ->tool(
        'staff_list',                            // 工具名（operationId）：定了就别改，改名会让 AI 认为这是另一个新工具
        'GET',                                   // method
        '/openapi/staff/list',                   // path（中枢拼在 base_url 后）
        'tenant.staff.read',                     // scope（路由白名单按它放行）
        '查询门店员工列表',                        // 一句话说明（AI 判断何时调用的首要依据）
        function (ToolDef $t) {
            $t->whenToUse('用户问员工、排班、人事时')
              ->returns('{code:1, data:[{id,name,role,dept}]}')
              ->examples([['dept' => '前厅']]);
            $t->query('dept', 'string', false, '按部门过滤', ['enum' => ['前厅', '后仓']]);
        })
    ->tool('staff_delete', 'DELETE', '/openapi/staff/delete', 'tenant.staff.delete', '删除门店员工',
        function (ToolDef $t) {
            $t->risk('high')                     // high = 先进人工审批
              ->confirm('AI 申请删除员工 #{staff_id}')  // 审批通知人话模板
              ->requiresSubject();               // 必须有操作主体；匿名访客看不到本工具
            $t->body('staff_id', 'integer', true, '员工 ID');
        })
    ->build();   // 或 ->buildJson() 直接拿 JSON 串
```

`ToolDef` 的链式方法一一对应注解字段（语义见各方法注释 / 8.x 版 `AiTool.php`）：
`risk()` `confirm()` `confirmWhen()` `requiresSubject()` `sensitive()` `readonly()` `idempotent()`
`rateLimit()` `timeoutMs()` `whenToUse()` `returns()` `examples()` `context()` `tags()` `deprecated()`，
参数用 `query()` / `body()`（第 5 参 `$opts` 可带 `enum` / `default` / `format` / `itemsType`）。

要点同注解版：
- **写接口**（非 GET）必须至少一个 `body()`/`query()` 参数，否则构建期报错（不让 AI 瞎猜参数）；
- **按参数升级确认**调 `->confirmWhen(...)`，例如金额超过阈值、跨主体、敏感字段命中才确认；
- **POST 实现的查询**调 `->readonly()`，AI 才敢放心调；
- **必须登录才有意义的接口**调 `->requiresSubject()`——匿名网页访客直接看不到它；
- **参数含手机号等敏感数据**调 `->sensitive()`——中枢审计只记键名。

构建期即体检：scope 缺失、写接口无参数、工具名/路由重复、risk 非法等会**直接抛 `InvalidArgumentException`**，CI 跑构建即完成体检，不会等发布后才在控制台"被跳过"列表里发现。

## 第二步：发布 spec

把 `buildJson()` 的产物挂到中枢「工具源」登记的 `spec_url`。裸 PHP 单文件：

```php
use Bailing\Connect\SpecServer;

$builder = ToolSpec::create('你的业务系统')
    ->authzProbe('/bailing/authz-probe') // 声明独立授权探针；宝塔站点建议用非点路径
    ->tool(/* ... */);
SpecServer::respond($builder, $secret); // $secret = 中枢「工具源」登记的签名密钥；中枢拉取时带 sha256= 签名校验
```

CI 预生成静态 JSON（量大时省去每次请求实时构建）：`php build-spec.php > tools.json`，`SpecServer::respond($spec, $secret, __DIR__.'/tools.json')` 传第 3 参走缓存。

> ⚠️ 宝塔/BT 面板：默认 vhost 的 `.well-known` 放行段会抢路由——约定路径建议用**非点开头**（如 `/bailing/tools.json`），spec_url 填它即可。详见控制台「工具源 → 接入说明」。

再挂一个独立授权探针端点（不要复用真实业务工具）。中枢刷新工具源时，会用不存在的主体探测它，确认业务侧授权闸默认拒绝：

```php
use Bailing\Connect\SpecServer;

SpecServer::respondAuthzProbe($secret, function ($subject) {
    // 必须走你自己的权限表；不存在的主体应返回 false。
    return $subject !== '' && PermissionService::canUseAiTools($subject);
}, '/bailing/authz-probe');
```

## 第三步：验签每个工具调用

中枢调你的业务接口时带签名（统一 `sha256=`）。在接口入口先验签（验签只回答"真是中枢发的吗"；能不能做这件事，你接着用自己的权限体系裁决）：

> **单一签名方案 `sha256=`**（算法名，非版本号；GitHub `X-Hub-Signature-256` 同款）。验签材料把 `X-Bailing-On-Behalf-Of` + `X-Bailing-Job-Id` 纳入 HMAC（从协议层钉死"谁/哪个任务"，防窗口内重放篡改这两个头换租户/绕幂等，见 CONTRACT §2.4b）。当前只接受 `sha256=` 标签；未来若改签名构造按 `docs/兼容性与升级.md` 走新标签 + 过渡窗。

```php
use Bailing\Connect\Verify;

// 写法 A：base_url 是纯源站（无路径前缀）——REQUEST_URI 即等于中枢签名的 path，直接验
if (!Verify::currentRequest($secret)) {
    http_response_code(401);
    exit('{"code":0,"msg":"bad signature"}');
}

// 写法 B（推荐，最稳）：base_url 带路径前缀 / 框架会重写 REQUEST_URI（ThinkPHP pathinfo 等）时，
// 传该端点在 spec 里声明的 path——只借 REQUEST_URI 的 query 段，路径段用你给的 spec path
if (!Verify::currentRequest($secret, '/goods/create')) { http_response_code(401); exit; }

$operator = Verify::onBehalfOf();   // 操作主体（验签通过后再用）；匿名任务返回 null
// → 用 $operator 走你自己的权限表裁决，再执行原有业务逻辑
```

**中枢签的是哪段 path（最易踩，见 CONTRACT §2.4b）**：签名串里的 path = 你 spec 里声明的 operation **path 原文**（如 `/goods/create`），**不含** base_url 的路径前缀；query = 本次 AI 调用的 query 位参数（`URLSearchParams` 编码），**不含**你框架的路由参数。所以：
- **base_url 建议用纯源站**（无路径前缀），端点挂在**干净固定路径**上，别走 `?i=&c=&a=&r=` 这类带路由 query 的入口；
- 否则用上面写法 B 传 spec path；
- 验签**用原始 `REQUEST_URI`（或写法 B），别从 `$_GET` 重组**（会改编码/顺序，必崩）。

联调头号坑是**服务器时钟偏移**：`Verify::failureReason()` 会区分 `timestamp_out_of_window` 与 `bad_signature`，先给服务器对时（ntp/chrony）。

## 操作主体 X-Bailing-On-Behalf-Of

`Verify::onBehalfOf()` 返回的就是你 `Ticket::sign($token, $你的操作人uid)` 签进票据的那个 **值原样**——中枢不解析、不约束格式（≤64 字节），匿名（无票据）时返回 `null`。拿到它走你自己的权限表裁决（如加商品时认定操作人）。详见下「访客票据」。

**🟢 多租户推荐姿势（强烈建议从第一天就用）**：既然中枢原样回传，多租户系统就该把**定位一个操作人所需的全部维度**编进这一个串，而不是只签裸 `uid`：

```php
// ❌ 只签裸 uid：单店能跑，接第二个租户时 uid=1 跨租户撞车，中枢无处补救
// ✅ 结构化主体：把租户一起带上（分隔符自定、≤64 字节）
$operator = Verify::onBehalfOf();            // 如 "tenant_179:user_1"
list($tenantId, $uid) = explode(':', $operator);
// 先用 $tenantId 划定数据边界，再用 $uid 认定操作人，照走自家权限表
```

租户隔离是你的业务域知识，编进主体串后**中枢零改动即支持任意多租户模型**；反之让中枢理解租户=把私有模型塞进通用契约必写死。**单租户也建议直接用 `"tenant_1:user_1"` 这类结构化主体**，免日后接第二租户时回头改签发逻辑+清历史。

## 访客票据（可选，聊天入口带登录身份时）

```php
use Bailing\Connect\Ticket;
// 单租户：$ticket = Ticket::sign($接入方token, (string) $user->id);
$ticket = Ticket::sign($接入方token, $tenantId . ':' . $user->id);  // 多租户推荐，如 "tenant_179:user_1"；页面渲染时签，塞给聊天组件 data-ticket
```

铁律：接入方 token 只存你的服务器，永不进前端——进前端的只有签好的短票。

## 业务后端主动调中枢

```php
use Bailing\Connect\HubClient;

$hub = new HubClient('https://hub.example.com', $接入方token);

$job = $hub->run('crm_1001', 'order-support', '查询订单处理建议', array(
    'principal' => array('id' => (string) $user->id, 'tenant' => (string) $tenantId),
));

$result = $hub->getJob($job['job_id']);
$hub->send('notice_1001', 'team-im', 'user_001', '任务已完成');
```

## 范例

- `examples/build-spec.php`：完整 builder 范例（覆盖全部字段；与 8.x 版同源，跑同一个跨语言契约测试）
- `examples/well-known.php`：裸 PHP 托管 spec 范例
