# 百灵中枢 Python SDK

业务系统侧 SDK，用来生成工具源 OpenAPI、签发聊天访客票据、校验中枢工具调用签名、校验 callback 签名、实现 authorize 探针，并调用中枢 `/run`、`/jobs/{id}`、`/send`。

## 安装

```bash
pip install bailing-connect
```

仓库内本地验证：

```bash
python3 sdk/python/examples/build_spec.py > tools.json
python3 sdk/python/examples/build_spec.py | npm run sdk:test-python
```

## 生成工具源

```python
import json
from bailing_connect import build_openapi_spec, param, tool

spec = build_openapi_spec(
    title="CRM 工具源",
    version="1.0.0",
    authz_probe={"method": "POST", "path": "/.well-known/bailing/authz-probe"},
    tools=[
        tool(
            name="member_query",
            method="GET",
            path="/api/members/{id}",
            description="查询会员基础资料",
            scope="member.read",
            requiresSubject=True,
            params=[
                param("id", **{"in": "path", "required": True, "description": "会员 ID"})
            ],
        ),
        tool(
            name="refund_request_create",
            method="POST",
            path="/api/refunds/requests",
            description="创建退款申请",
            scope="refund.request",
            risk="medium",
            requiresSubject=True,
            confirmWhen=[{"param": "amount", "op": ">", "value": 500, "label": "超过 500 元退款需人工确认"}],
            params=[
                param("order_id", required=True, description="订单 ID"),
                param("amount", type="number", required=True, description="退款金额，单位元"),
                param("reason", required=True, description="退款原因"),
            ],
        )
    ],
)

print(json.dumps(spec, ensure_ascii=False, indent=2))
```

## 验签与授权

```python
from bailing_connect import verify_tool_call

raw_body = request.get_data(as_text=True)
path_with_query = request.full_path.rstrip("?")
on_behalf_of = request.headers.get("x-bailing-on-behalf-of", "")
job_id = request.headers.get("x-bailing-job-id", "")

ok = verify_tool_call(
    secret=os.environ["BAILING_TOOL_SECRET"],
    method=request.method,
    path_with_query=path_with_query,
    body=raw_body,
    timestamp=request.headers.get("x-bailing-timestamp"),
    signature=request.headers.get("x-bailing-signature"),
    on_behalf_of=on_behalf_of,
    job_id=job_id,
)

if not ok:
    abort(401)
if not can_user_read_member(on_behalf_of):
    abort(403)
```

验签只证明请求来自中枢，不代表这个主体有权限执行该动作。业务工具端点必须先验签，再按 `X-Bailing-On-Behalf-Of` 走自身权限表做授权裁决。

## 访客票据与 HubClient

```python
import os
from bailing_connect import HubClient, sign_ticket

ticket = sign_ticket(os.environ["BAILING_CLIENT_TOKEN"], f"{tenant_id}:{user_id}")

hub = HubClient("https://hub.example.com", os.environ["BAILING_CLIENT_TOKEN"])
job = hub.run(
    request_id=f"crm_{order_id}",
    route="order-support",
    input="查询订单处理建议",
    metadata={"principal": {"id": str(user_id), "tenant": str(tenant_id)}},
)
result = hub.get_job(job["job_id"])
hub.send("notice_1001", "team-im", "user_001", "任务已完成")
```
