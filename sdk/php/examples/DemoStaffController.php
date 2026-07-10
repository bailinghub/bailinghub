<?php

declare(strict_types=1);

namespace Bailing\Connect\Examples;

use Bailing\Connect\Attributes\AiParam;
use Bailing\Connect\Attributes\AiTool;

/**
 * 演示控制器：覆盖注解注册表全部字段的标注范例（也是 SDK 的契约测试夹具）。
 * 真实业务里这些方法体就是你现有的控制器逻辑，标注不影响原有调用方。
 */
final class DemoStaffController
{
    #[AiTool(
        description: '查询门店员工列表',
        name: 'staff_list',          // 显式命名是最佳实践：定了就别改（改名会让 AI 认为这是另一个新工具）
        scope: 'tenant.staff.read',
        path: '/opentenantapi/staff/list',
        whenToUse: '用户问员工、排班、人事相关问题时用；问工资明细别用本工具',
        returns: '{code:1, data:[{id,name,role,dept}]}',
        examples: [['dept' => '前厅']],
        rateLimit: '60/min',
        tags: ['门店管理'],
    )]
    #[AiParam('dept', description: '按部门过滤，如 前厅、后仓', enum: ['前厅', '后仓'])]
    public function list(): void
    {
    }

    #[AiTool(
        description: '按手机号查询会员资料',
        name: 'member_query',
        scope: 'tenant.member.read',
        path: '/opentenantapi/member/query',
        method: 'POST',
        readonly: true,          // POST 实现的查询接口：显式声明语义只读
        idempotent: true,
        sensitive: true,         // 参数含手机号：中枢审计只记键名
        requiresSubject: true,   // 必须有操作主体（匿名网页访客看不到本工具）
        whenToUse: '门店员工核实会员身份时',
        returns: '{code:1, data:{member_id, name, level, points}}',
    )]
    #[AiParam('mobile', description: '会员手机号', required: true, format: 'phone')]
    public function memberQuery(): void
    {
    }

    #[AiTool(
        description: '删除门店员工',
        name: 'staff_delete',
        scope: 'tenant.staff.delete',
        path: '/opentenantapi/staff/delete',
        method: 'POST',
        risk: 'high',
        confirm: true,
        requiresSubject: true,
        confirmPrompt: 'AI 申请删除员工 #{id}',
        context: ['audit:hr'],
    )]
    #[AiParam('id', description: '员工 ID', type: 'integer', required: true)]
    public function delete(): void
    {
    }

    #[AiTool(
        description: '创建退款申请',
        name: 'refund_request_create',
        scope: 'tenant.refund.request',
        path: '/opentenantapi/refund/request',
        method: 'POST',
        risk: 'medium',
        requiresSubject: true,
        whenToUse: '用户要发起退款但不要求立即打款时用；本工具只创建业务审批单',
        returns: '{code:1, data:{request_id,status,message,url}}',
        confirmWhen: [['param' => 'amount', 'op' => '>', 'value' => 500, 'label' => '超过 500 元退款需人工确认']],
    )]
    #[AiParam('order_id', description: '订单 ID', required: true)]
    #[AiParam('amount', description: '退款金额，单位元', type: 'number', required: true)]
    #[AiParam('reason', description: '退款原因', required: true)]
    public function createRefundRequest(): void
    {
    }

    #[AiTool(
        // 未显式 name：默认 蛇形(类名去Controller)+蛇形(方法名) → demo_staff_monthly_report
        description: '生成月度经营报表（慢接口）',
        scope: 'tenant.report.read',
        path: '/opentenantapi/report/monthly',
        timeoutMs: 30000,        // 报表慢，单独放宽超时
        returns: '{code:1, data:{url: 报表下载地址}}',
    )]
    #[AiParam('month', description: '月份，如 2026-05', required: true, format: 'date')]
    public function monthlyReport(): void
    {
    }

    #[AiTool(
        description: '示例：deprecated 员工查询接口',
        scope: 'tenant.staff.read',
        path: '/opentenantapi/staff/list_v1',
        deprecated: true,        // 弃用：spec 里保留声明、中枢不再暴露给 AI
    )]
    public function listV1(): void
    {
    }
}
