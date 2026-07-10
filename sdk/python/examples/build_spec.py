#!/usr/bin/env python3
import json
import os
import sys

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))
from bailing_connect import build_openapi_spec, param, tool


spec = build_openapi_spec(
    title="演示业务系统",
    version="1.0.0",
    authz_probe={"method": "POST", "path": "/.well-known/bailing/authz-probe"},
    tools=[
        tool(
            description="查询门店员工列表",
            name="staff_list",
            scope="tenant.staff.read",
            path="/opentenantapi/staff/list",
            whenToUse="用户问员工、排班、人事相关问题时用；问工资明细别用本工具",
            returns="{code:1, data:[{id,name,role,dept}]}",
            examples=[{"dept": "前厅"}],
            rateLimit="60/min",
            tags=["门店管理"],
            params=[param("dept", description="按部门过滤，如 前厅、后仓", enum=["前厅", "后仓"])],
        ),
        tool(
            description="按手机号查询会员资料",
            name="member_query",
            scope="tenant.member.read",
            path="/opentenantapi/member/query",
            method="POST",
            readonly=True,
            idempotent=True,
            sensitive=True,
            requiresSubject=True,
            whenToUse="门店员工核实会员身份时",
            returns="{code:1, data:{member_id, name, level, points}}",
            params=[param("mobile", description="会员手机号", required=True, format="phone")],
        ),
        tool(
            description="删除门店员工",
            name="staff_delete",
            scope="tenant.staff.delete",
            path="/opentenantapi/staff/delete",
            method="POST",
            risk="high",
            confirm=True,
            requiresSubject=True,
            confirmPrompt="AI 申请删除员工 #{id}",
            context=["audit:hr"],
            params=[param("id", description="员工 ID", type="integer", required=True)],
        ),
        tool(
            description="创建退款申请",
            name="refund_request_create",
            scope="tenant.refund.request",
            path="/opentenantapi/refund/request",
            method="POST",
            risk="medium",
            requiresSubject=True,
            whenToUse="用户要发起退款但不要求立即打款时用；本工具只创建业务审批单",
            returns="{code:1, data:{request_id,status,message,url}}",
            confirmWhen=[{"param": "amount", "op": ">", "value": 500, "label": "超过 500 元退款需人工确认"}],
            params=[
                param("order_id", description="订单 ID", required=True),
                param("amount", description="退款金额，单位元", type="number", required=True),
                param("reason", description="退款原因", required=True),
            ],
        ),
        tool(
            description="生成月度经营报表（慢接口）",
            name="demo_staff_monthly_report",
            scope="tenant.report.read",
            path="/opentenantapi/report/monthly",
            timeoutMs=30000,
            returns="{code:1, data:{url: 报表下载地址}}",
            params=[param("month", description="月份，如 2026-05", required=True, format="date")],
        ),
        tool(
            description="示例：deprecated 员工查询接口",
            name="staff_list_v1",
            scope="tenant.staff.read",
            path="/opentenantapi/staff/list_v1",
            deprecated=True,
        ),
    ],
)

print(json.dumps(spec, ensure_ascii=False, indent=2))
