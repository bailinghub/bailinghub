<?php

// 裸 PHP 单文件托管 spec 的范例（PHP 7.3 兼容）。把它放到中枢「工具源」登记的 spec_url 指向的位置。
// 中枢拉取时带 sha256= 签名（空体），本端点用同一把签名密钥校验——只对中枢开放。
//
// ⚠️ 宝塔/BT 面板：默认 vhost 自带 .well-known 放行段会抢路由，约定路径用非点开头（如 /bailing/tools.json）更稳；
//    详见中枢控制台「工具源 → 接入说明」与 CONTRACT §2.4。

require __DIR__ . '/../src/Verify.php';
require __DIR__ . '/../src/ToolDef.php';
require __DIR__ . '/../src/ToolSpec.php';
require __DIR__ . '/../src/SpecServer.php';

use Bailing\Connect\ToolDef;
use Bailing\Connect\ToolSpec;
use Bailing\Connect\SpecServer;

$secret = getenv('BAILING_TOOL_SECRET') ?: '在中枢「工具源」登记的签名密钥';

$spec = ToolSpec::create('示例商城')
    ->authzProbe('/bailing/authz-probe')
    ->tool('staff_list', 'GET', '/openapi/staff/list', 'tenant.staff.read', '查询门店员工列表',
        function (ToolDef $t) {
            $t->query('store_id', 'integer', true, '门店 ID');
        })
    ->tool('staff_delete', 'DELETE', '/openapi/staff/delete', 'tenant.staff.delete', '删除指定门店员工',
        function (ToolDef $t) {
            $t->risk('high')->confirm('AI 申请删除员工 #{staff_id}')->requiresSubject();
            $t->body('staff_id', 'integer', true, '员工 ID');
        });

// 处理当前请求、输出并退出（实时构建；量大可传第 3 参 $cacheFile 走缓存）
SpecServer::respond($spec, $secret);
