<?php

// PHP 7.3 builder 范例——产出与 8.x 注解版（sdk/php/examples）完全等价的 spec，跑同一个跨语言契约测试。
// 用法：php sdk/php7/examples/build-spec.php | npx tsx scripts/sdk-contract-test.ts

require __DIR__ . '/../src/ToolDef.php';
require __DIR__ . '/../src/ToolSpec.php';

use Bailing\Connect\ToolDef;
use Bailing\Connect\ToolSpec;

$spec = ToolSpec::create('某某业务系统')
    ->authzProbe('/bailing/authz-probe')
    ->tool('staff_list', 'GET', '/opentenantapi/staff/list', 'tenant.staff.read', '查询门店员工列表',
        function (ToolDef $t) {
            $t->whenToUse('用户问员工、排班、人事相关问题时用；问工资明细别用本工具')
              ->returns('{code:1, data:[{id,name,role,dept}]}')
              ->examples(array(array('dept' => '前厅')))
              ->rateLimit('60/min')
              ->tags(array('门店管理'));
            $t->query('dept', 'string', false, '按部门过滤，如 前厅、后仓', array('enum' => array('前厅', '后仓')));
        })
    ->tool('member_query', 'POST', '/opentenantapi/member/query', 'tenant.member.read', '按手机号查询会员资料',
        function (ToolDef $t) {
            $t->readonly()          // POST 实现的查询接口：显式声明语义只读
              ->idempotent()
              ->sensitive()         // 参数含手机号：中枢审计只记键名
              ->requiresSubject()   // 必须有操作主体（匿名网页访客看不到本工具）
              ->whenToUse('门店员工核实会员身份时')
              ->returns('{code:1, data:{member_id, name, level, points}}');
            $t->body('mobile', 'string', true, '会员手机号', array('format' => 'phone'));
        })
    ->tool('staff_delete', 'POST', '/opentenantapi/staff/delete', 'tenant.staff.delete', '删除门店员工',
        function (ToolDef $t) {
            $t->risk('high')
              ->confirm('AI 申请删除员工 #{id}')
              ->requiresSubject()
              ->context(array('audit:hr'));
            $t->body('id', 'integer', true, '员工 ID');
        })
    ->tool('refund_request_create', 'POST', '/opentenantapi/refund/request', 'tenant.refund.request', '创建退款申请',
        function (ToolDef $t) {
            $t->risk('medium')
              ->requiresSubject()
              ->whenToUse('用户要发起退款但不要求立即打款时用；本工具只创建业务审批单')
              ->returns('{code:1, data:{request_id,status,message,url}}')
              ->confirmWhen(array(array('param' => 'amount', 'op' => '>', 'value' => 500, 'label' => '超过 500 元退款需人工确认')));
            $t->body('order_id', 'string', true, '订单 ID');
            $t->body('amount', 'number', true, '退款金额，单位元');
            $t->body('reason', 'string', true, '退款原因');
        })
    ->tool('demo_staff_monthly_report', 'GET', '/opentenantapi/report/monthly', 'tenant.report.read', '生成月度经营报表（慢接口）',
        function (ToolDef $t) {
            $t->timeoutMs(30000)    // 报表慢，单独放宽超时
              ->returns('{code:1, data:{url: 报表下载地址}}');
            $t->query('month', 'string', true, '月份，如 2026-05', array('format' => 'date'));
        })
    ->tool('demo_staff_list_v1', 'GET', '/opentenantapi/staff/list_v1', 'tenant.staff.read', '示例：deprecated 员工查询接口',
        function (ToolDef $t) {
            $t->deprecated();       // 弃用：spec 里保留声明、中枢不再暴露给 AI
        });

// 警告打到 stderr（不污染 stdout 的 JSON）
foreach ($spec->warnings() as $w) {
    fwrite(STDERR, "[warn] {$w}\n");
}

echo $spec->buildJson();
