# RuoYi-Vue-Pro / 芋道源码 + BailingHub 接入配方

> 状态：独立社区接入配方，不是 RuoYi-Vue-Pro 官方集成，也不代表上游认可。
>
> 目标：给一套已有的 RuoYi-Vue-Pro 业务后台增加 AI 助理时，让 Agent 能查询售后详情、发起受治理的退款动作，但不能持有后台登录凭证、绕过原权限表或直接触发支付回调。

## 1. 为什么选择售后退款

这份配方基于 RuoYi-Vue-Pro `master` 分支的真实代码快照
`0418084e222612af2fc1141f566af454f9236ab1`，选择两个已经存在的管理后台能力：

| 场景 | 上游接口 | 原权限 | 配方中的 Agent 能力 |
| --- | --- | --- | --- |
| 查询售后详情 | `GET /admin-api/trade/after-sale/get-detail` | `trade:after-sale:query` | `trade.after-sale.read` |
| 确认退款 | `PUT /admin-api/trade/after-sale/refund` | `trade:after-sale:refund` | `trade.after-sale.refund` |

上游控制器仍会把当前管理员编号传给 `AfterSaleService.refundAfterSale(...)`，业务服务继续检查售后单状态并创建退款单。因此，这里适合验证一条重要边界：

> BailingHub 决定 Agent 最多能触达哪项能力；RuoYi-Vue-Pro 仍决定这个操作主体此刻有没有权限、售后状态是否允许退款，以及退款最终能否成立。

支付模块使用的 `POST /admin-api/trade/after-sale/update-refunded` 回调明确排除在 Agent 能力之外。它不是管理动作，不能因为带有 `@PermitAll` 就被当作可暴露工具。

## 2. 正确拓扑

```text
AI assistant / Agent
  -> BailingHub client and governed route
  -> capability allowlist / subject / approval / audit / idempotency
  -> thin RuoYi-Vue-Pro adapter
       1. verify BailingHub HMAC
       2. read signed X-Bailing-On-Behalf-Of
       3. map tenant_id:admin_user_id to the existing admin identity
       4. re-check the original RuoYi permission
       5. call the existing AfterSaleService
  -> RuoYi-Vue-Pro business service and payment service
```

不要采用下面两种捷径：

1. 把 RuoYi-Vue-Pro 管理后台的 Bearer Token 交给模型；
2. 让 BailingHub 直接代替 RuoYi-Vue-Pro 判断管理员权限或售后状态。

## 3. 为什么需要薄适配层

RuoYi-Vue-Pro 当前管理接口通过登录上下文取得管理员编号，并用
`@PreAuthorize("@ss.hasPermission(...)")` 检查权限。BailingHub 的工具调用不是一次后台网页登录请求，因此不能假装现有 Bearer Token 仍然代表某个真实管理员。

适配层必须完成以下工作，而且全部失败关闭：

1. 验证 `X-Bailing-Signature` 与 `X-Bailing-Timestamp`；
2. 从已签名的 `X-Bailing-On-Behalf-Of` 读取主体，不接受请求参数或模型文本里的主体；
3. 将主体解析为 `tenant_id:admin_user_id`，并恢复正确租户上下文；
4. 查询原权限系统：只读操作复核 `trade:after-sale:query`，退款复核 `trade:after-sale:refund`；
5. 退款前再次读取售后单状态，最终判断仍由 `AfterSaleService` 完成；
6. 使用 `X-Bailing-Idempotency-Key` 防止同一任务因网络重试产生第二次业务副作用；
7. 主体为空、租户不匹配、权限不足、签名错误、幂等键冲突或授权探针失败时，一律拒绝。

如果部署为单体应用，适配层可以调用现有 `PermissionService.hasAnyPermissions(...)`；如果系统模块和商城模块分开部署，应通过现有系统服务边界完成同一判断，而不是为了这份配方引入跨模块私有依赖。

## 4. 导入能力声明

1. 部署一个只包含本配方两个端点的薄适配服务；
2. 在 BailingHub 新建工具源，`base_url` 指向适配服务，不是 RuoYi-Vue-Pro 管理后台地址；
3. 为工具源设置独立 HMAC Secret；
4. 导入 [ruoyi-vue-pro-trade-adapter.openapi.json](./ruoyi-vue-pro-trade-adapter.openapi.json)；
5. 工具源验证必须执行授权探针，并确认匿名主体、未知主体和错误租户均返回拒绝。

示例路由只允许这两个 scope：

```json
{
  "tools": {
    "sources": [
      {
        "provider": "yudao-trade-adapter",
        "allow": [
          "trade.after-sale.read",
          "trade.after-sale.refund"
        ],
        "subject_field": "operator_uid"
      }
    ],
    "max_calls": 4,
    "approval": {
      "type": "business_webhook",
      "url": "https://your-business.example.com/ai/approvals"
    }
  }
}
```

网页票据或调用方 metadata 中的 `operator_uid` 应由可信业务登录态生成，格式建议固定为：

```text
<tenant_id>:<admin_user_id>
```

模型不能填写、修改或猜测这个值。

## 5. 两个动作的治理差异

### 查询售后详情

- 风险：`low`
- 主体：必需，因为原接口要求管理权限
- 只读：是
- 幂等：是
- 审计敏感：是，结果可能包含会员、订单与售后日志

### 确认退款

- 风险：`high`
- 主体：必需
- 人工审批：必需，审批内容应固定售后编号与操作主体
- 只读：否
- 幂等：是，但必须由适配层和业务执行共同兑现
- 最终授权：仍由 RuoYi-Vue-Pro 的权限表、租户上下文、售后状态和支付服务决定

`approval.required: true` 不是退款授权本身。它只表示 BailingHub 在调用业务适配层之前必须冻结参数并取得批准；适配层收到请求后仍要重新验签、认人、查权限和校验当前业务状态。

## 6. 最小验收流程

在无生产资金副作用的测试环境中依次验证：

1. **合法只读**：有查询权限的主体读取一个测试售后单，返回详情；
2. **无主体拒绝**：去掉可信票据，工具不应暴露或适配层返回拒绝；
3. **越权拒绝**：没有 `trade:after-sale:refund` 的管理员请求退款，业务适配层返回 403；
4. **审批前不执行**：退款任务进入审批等待，适配层尚未收到真实退款调用；
5. **参数漂移拒绝**：批准后更换售后编号，必须重新审批或拒绝；
6. **重复请求不产生第二次副作用**：复用同一幂等键重试，只能对应一个退款业务结果；
7. **状态变化拒绝**：审批等待期间售后单不再处于待退款状态，执行时由业务服务拒绝；
8. **回调不可见**：`update-refunded` 不出现在 BailingHub 工具清单中。

满足这些条件，只能证明这条配方在测试环境中保持了责任边界，不能自动证明生产合规或真实支付安全。

## 7. 本地静态校验

```bash
node verify_recipe.mjs
```

成功输出：

```text
PASS: RuoYi-Vue-Pro BailingHub recipe keeps signature, subject, permission, approval, idempotency, and business-authority boundaries explicit.
```

静态校验不访问网络、不连接 RuoYi-Vue-Pro、不执行退款。生产接入仍必须实现并测试薄适配层。

## 8. 一手依据

- [RuoYi-Vue-Pro AfterSaleController at the inspected commit](https://github.com/YunaiV/ruoyi-vue-pro/blob/0418084e222612af2fc1141f566af454f9236ab1/yudao-module-mall/yudao-module-trade/src/main/java/cn/iocoder/yudao/module/trade/controller/admin/aftersale/AfterSaleController.java)
- [RuoYi-Vue-Pro AfterSaleServiceImpl at the inspected commit](https://github.com/YunaiV/ruoyi-vue-pro/blob/0418084e222612af2fc1141f566af454f9236ab1/yudao-module-mall/yudao-module-trade/src/main/java/cn/iocoder/yudao/module/trade/service/aftersale/AfterSaleServiceImpl.java)
- [BailingHub 第三方对接指南](../../第三方对接指南.md)
- [ACC OpenAPI binding](https://github.com/agent-capability/agent-capability-contract/blob/main/bindings/openapi.md)
