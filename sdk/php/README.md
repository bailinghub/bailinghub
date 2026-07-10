# bailing/connect —— 百灵中枢业务侧接入 SDK（PHP）

把你的业务接口安全地开放给 AI，只需三步：**标注解 → 发布 spec → 验签名**。
零依赖，PHP ≥ 8.1。能力声明遵循 ACC，验签与中枢接入约定见 `docs/CONTRACT.md §2.4`。

## 安装

未发布 packagist 前三种方式任选：

```bash
# ① 从你的中枢直接下载（控制台「工具源 → 接入说明」也有此链接）
curl -O https://<中枢域名>/connect/bailing-connect-php.tgz && tar -xzf bailing-connect-php.tgz
```

```jsonc
// ② composer.json（path 仓库，指向解压/克隆出来的目录）
{
  "repositories": [{ "type": "path", "url": "./bailing-connect-php" }],
  "require": { "bailing/connect": "*" }
}
```

或 ③ 直接拷贝 `src/` 目录进项目——共 **6 个文件**（根下 4 个类 + `Attributes/` 下 2 个注解类，少拷会 class not found）。零依赖，怎么引都行。

## 第一步：标注解

在现有控制器方法上加 `#[AiTool]`（不影响原有调用方）：

```php
use Bailing\Connect\Attributes\{AiTool, AiParam};

#[AiTool(
    description: '查询门店员工列表',
    scope: 'tenant.staff.read',
    path: '/opentenantapi/staff/list',
    whenToUse: '用户问员工、排班、人事时',
    returns: '{code:1, data:[{id,name,role,dept}]}',
    examples: [['dept' => '前厅']],
)]
#[AiParam('dept', description: '按部门过滤', enum: ['前厅', '后仓'])]
public function list() { /* 你原有的逻辑 */ }
```

完整字段见 `src/Attributes/AiTool.php` 注释（每个字段都有说明），覆盖范例见
`examples/DemoStaffController.php`。要点：

- **写接口**必须 `#[AiParam]` 声明参数、按需标 `risk: 'high'` / `confirm: true`（进人工审批）；
- **按参数升级确认**用 `confirmWhen`，例如金额超过阈值、跨主体、敏感字段命中才确认；
- **POST 实现的查询**标 `readonly: true`，AI 才敢放心调；
- **必须登录才有意义的接口**标 `requiresSubject: true`——匿名网页访客直接看不到它；
- **参数含手机号等敏感数据**标 `sensitive: true`——中枢审计只记键名。

构建期即体检：scope 缺失、写接口无参数、工具名重复等会**直接抛异常**，
不会等发布后才在控制台"被跳过"列表里发现。

## 第二步：发布 spec（约定路径）

```
https://你的域名/.well-known/bailing/tools.json
```

ThinkPHP 路由一段（完整示例见 `examples/thinkphp-integration.php`）：

```php
Route::get('.well-known/bailing/tools.json', function () {
    $spec = (new \Bailing\Connect\SpecBuilder(title: '你的业务系统'))
        ->authzProbe('/.well-known/bailing/authz-probe')
        ->addClass(StaffController::class);
    [$status, $body] = \Bailing\Connect\SpecServer::handle(
        $spec, config('bailing.tool_secret'),
        request()->method(), request()->url(), request()->header());
    return response($body, $status)->contentType('application/json');
});
```

- `->authzProbe(...)` 会在 spec 根上声明 `x-bailing-authz-probe`。中枢刷新工具源时，会用一个不存在的主体探测该端点，确认业务侧授权闸是默认拒绝；
- `$secret` 传中枢「工具源」登记的密钥 = **spec 只对中枢开放**（中枢拉取自带 `sha256=` 签名）；传 `null` = 公开；
- 中枢侧开"自动刷新"后，你**每次部署新标注的接口自动成为 AI 工具**，无需任何人工导入；工具清单增删/风险变化中枢会审计并告警管理员；
- 实时反射模式下注解写错 spec 端点会回 500（响应体带具体错误）；**用 `$cacheFile` 时改注解后必须重新生成缓存文件**，否则一直发旧 spec——建议 CI 里固定跑构建脚本落盘。

同路径再挂一个独立授权探针端点（不要复用真实业务工具）：

```php
Route::post('.well-known/bailing/authz-probe', function () {
    [$status, $body] = \Bailing\Connect\SpecServer::authzProbe(
        config('bailing.tool_secret'),
        // 这里必须走你自己的权限表；不存在的主体应返回 false。
        fn (string $subject): bool => $subject !== '' && PermissionService::canUseAiTools($subject),
        request()->method(),
        request()->url(),
        request()->getInput(),
        request()->header()
    );
    return response($body, $status)->contentType('application/json');
});
```

裸 PHP 可用便捷入口：`\Bailing\Connect\SpecServer::respondAuthzProbe($secret, fn ($subject) => PermissionService::canUseAiTools($subject), '/.well-known/bailing/authz-probe');`。

### ⚠️ 宝塔/BT 面板必读（实测翻车点）

宝塔默认 vhost 自带 `location ~ \.well-known { allow all; }` 证书验证段，**正则 location 优先于框架重写**，导致：
- 动态路由方式 → 请求被当静态文件，**404 根本到不了 PHP**；
- 静态文件方式（CI 写 `public/.well-known/bailing/tools.json`）→ 被宝塔 lua 块**对任何人公开直出，签名保护静默失效**。

两个修法任选其一：

```nginx
# 方法①：网站设置 → 配置文件，加这段（^~ 前缀匹配优先于正则，请求才能进 PHP 路由）。
# 注意 ?s=$1 必须带：ThinkPHP 在 nginx+FPM 下靠 s 参数恢复 pathinfo（REQUEST_URI 链路 cli 才生效），
# 裸 rewrite ^ /index.php 会丢路径、路由到默认页。Laravel 等直接解析 REQUEST_URI 的框架则不需要 s 参数。
location ^~ /.well-known/bailing/ {
    rewrite ^(.*)$ /index.php?s=$1 last;
}
```

方法②：**约定路径并非强制**——中枢注册工具源时 `spec_url` 是任意 URL，直接把发布路由挂在非点开头路径（如 `/bailing/tools.json`）即可，绕开宝塔点路径的所有特殊处理。

## 第三步：验签中间件

挂在暴露给 AI 的路由分组上（约 10 行，见 `examples/thinkphp-integration.php` ②）：

```php
// 最省事：currentRequest 从超全局取齐材料（裸 PHP / 多数框架可用）
if (!Verify::currentRequest($secret)) { /* 401 */ }

// 或手动传（ThinkPHP 等）：把主体+任务两个头一并传入，纳入验签材料
$ok = Verify::toolCall($secret, $request->method(), $request->url(),
    $request->getInput(), $request->header('x-bailing-timestamp', ''),
    $request->header('x-bailing-signature', ''), 300,
    $request->header('x-bailing-on-behalf-of', ''), $request->header('x-bailing-job-id', ''));
```

> **单一签名方案 `sha256=`**（算法名，非版本号；GitHub `X-Hub-Signature-256` 同款）。验签材料把 `X-Bailing-On-Behalf-Of` + `X-Bailing-Job-Id` 纳入 HMAC（协议层钉死"谁/哪个任务"，防窗口内重放篡改这两个头换租户/绕幂等，见 CONTRACT §2.4b）。用 `toolCall` 手动验签时记得把这两个头传进去（用 `currentRequest` 则自动取齐）。当前只接受 `sha256=` 标签；未来若改签名构造按 `docs/兼容性与升级.md` 走新标签 + 过渡窗。

**边界**：验签只回答"真是中枢发的吗"。`Verify::onBehalfOf()` 是谁、有没有权限做这件事，
由你用自己既有的权限体系裁决——AI 调用与人点按钮走同一条裁决路径。

联调与加固三件事：

- **先给服务器对时**（ntp/chrony）——验签失败的头号原因是时钟偏移。`Verify::failureReason()` 区分
  `timestamp_out_of_window` / `bad_signature`，401 响应里带上能省一半联调时间；
- **用原始 `REQUEST_URI` 验签，不要 decode 后重组**——中枢"签所发即所发"；URI 会被重写/重编码的
  CDN/网关后面验签必挂，中枢侧 base_url 要指源站直连地址；
- **防重放（可选加固）**：`sha256=` 签名不携带 nonce（验签零状态）。对高敏写接口，把收到的 `X-Bailing-Signature`
  缓存 300 秒拒绝重复出现即等价 nonce 去重（签名含时间戳，本身就是唯一指纹；AI 合法重试时间戳不同不受影响）：
  ```php
  if (!$redis->set('bailing:sig:' . md5($sig), 1, ['nx', 'ex' => 300])) {
      return json(['error' => 'replay rejected'], 401);
  }
  ```

## 附：聊天组件带登录身份

```php
// 单租户：裸 uid
$ticket = \Bailing\Connect\Ticket::sign($接入方token, (string) $user->id);
// 🟢 多租户推荐：把租户维度一起编进主体（中枢原样回传，零改动支持任意租户模型）
$ticket = \Bailing\Connect\Ticket::sign($接入方token, $tenantId . ':' . $user->id);  // 如 "tenant_179:user_1"
// <script src=".../widget.js" data-entry="pub_x" data-ticket="<?= $ticket ?>">
```

接入方 token 永不进前端——进前端的只有签好的短票（默认 2 小时过期）。

**多租户姿势（强烈建议从第一天就用）**：`onBehalfOf()` 返回的是你签进票据的值**原样**，中枢不解析、不约束格式（≤64 字节）。多租户系统应把**定位一个操作人所需的全部维度**编进这一个串（如 `"{$tenantId}:{$uid}"`），验签后 `explode(':', ...)` 拆出来**先按租户划数据边界、再认定操作人**。只签裸 `uid` 在单组织能跑，接第二个租户时 `uid=1` 会跨租户撞车，且中枢无处补救（租户隔离是你的业务域知识，不该进通用契约）。单租户也建议直接用 `"tenant_1:user_1"` 这类结构化主体，免日后回头改签发逻辑+清历史。详见中枢 `docs/CONTRACT.md §2.4 b)`。

## 附：业务后端主动调中枢

```php
$hub = new \Bailing\Connect\HubClient('https://hub.example.com', $接入方token);

$job = $hub->run('crm_1001', 'order-support', '查询订单处理建议', [
    'principal' => ['id' => (string) $user->id, 'tenant' => (string) $tenantId],
]);

$result = $hub->getJob($job['job_id']);
$hub->send('notice_1001', 'team-im', 'user_001', '任务已完成');
```

## CI 集成

```bash
php examples/build-spec.php > public/.well-known/bailing/tools.json  # 构建失败=标注有错，挡住部署
```

—— 百灵中枢
