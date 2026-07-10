# 给工具源接入方：Agent 友好的工具设计指南

> 适用对象：把业务接口接入百灵中枢、按 ACC 声明为 Agent 可调用能力的开发者。
> 目标：用最少业务改造，把现有后台能力变成 AI 能正确、安全调用的工具。

## 先说结论

你不需要为 AI 重写一套业务系统。最推荐的路径是：

1. 从 Web 后台已经存在、权限已经跑通的动作里挑一个。
2. 给它补 OpenAPI / SDK 注解，让中枢知道它的 scope、风险、参数和返回。
3. 接口验签后，继续按 `X-Bailing-On-Behalf-Of` 回到你原来的权限表判断。

AI 不是获得新权限，它只是替同一个操作主体调用同一套业务动作。如果某个员工能在后台删除员工，AI 以这个员工为主体调用删除接口时，也应该走同一条权限裁决；如果原来不能操作，AI 也不能绕过。

## 不要一开始就暴露所有 CRUD

后台 CRUD 是给人点按钮用的，Agent 工具最好按业务意图重新挑选一层“门面”。优先从下面五类开始：

| 工具形态 | 适合暴露的动作 | 常见标注 |
|---|---|---|
| 查询 | 查订单、查员工、查库存、查客户 | `low`，GET 默认只读；POST 查询加 `readonly` / `idempotent` |
| 预检 / 试算 | 退款试算、删除影响分析、库存变更预览 | `low` 或 `medium`，只返回影响摘要 |
| 申请 / 草稿 | 创建退款申请、提交离职申请、生成待确认草稿 | `medium`，由业务系统自己的流程承接后续审批 |
| 真实执行 | 立即退款、直接删除、改权限、发券 | 通常 `high` 或 `confirm` |
| 批量执行 | 批量调价、批量外发、批量改权限 | 通常 `high`，再用 `confirmWhen` 控制数量/金额阈值 |

这套分类不是替你定义业务规则，而是给开发者一个统一心智：越接近“真实不可逆副作用”，越应该显式声明风险和确认条件。

## 最小可用样例

### 1. 查询工具

```js
tool({
  name: 'order_get',
  method: 'GET',
  path: '/api/orders/{id}',
  description: '查询订单详情',
  scope: 'order.read',
  requiresSubject: true,
  params: [param('id', { in: 'path', required: true, description: '订单 ID' })]
})
```

查询工具通常最容易接入。它们的重点不是审批，而是参数描述要清楚，避免 AI 猜错。

### 2. 申请 / 业务流程工具

```js
tool({
  name: 'refund_request_create',
  method: 'POST',
  path: '/api/refunds/requests',
  description: '创建退款申请',
  scope: 'refund.request',
  risk: 'medium',
  requiresSubject: true,
  whenToUse: '用户要发起退款但不要求立即打款时用；本工具只创建业务审批单',
  returns: '{code:1, data:{request_id,status,message,url}}',
  params: [
    param('order_id', { required: true, description: '订单 ID' }),
    param('amount', { type: 'number', required: true, description: '退款金额，单位元' }),
    param('reason', { required: true, description: '退款原因' })
  ]
})
```

如果业务系统本来就有审批流，让 Agent 创建“申请单”通常比让 Agent 直接执行更稳。中枢负责记录这次 Agent 触发了申请，谁审核、怎么审核、何时生效仍由业务系统决定。

### 3. 参数级确认工具

```js
tool({
  name: 'refund_execute',
  method: 'POST',
  path: '/api/refunds/execute',
  description: '执行退款',
  scope: 'refund.execute',
  risk: 'medium',
  requiresSubject: true,
  confirmWhen: [
    { param: 'amount', op: '>', value: 500, label: '超过 500 元退款需人工确认' }
  ],
  params: [
    param('order_id', { required: true, description: '订单 ID' }),
    param('amount', { type: 'number', required: true, description: '退款金额，单位元' })
  ]
})
```

`confirmWhen` 适合“小额可直接处理，大额进入确认”的场景。不要把阈值写进提示词，应该写进工具契约。

### 4. 高风险真实执行工具

```js
tool({
  name: 'staff_delete',
  method: 'POST',
  path: '/api/staff/delete',
  description: '删除员工',
  scope: 'staff.delete',
  risk: 'high',
  confirm: true,
  requiresSubject: true,
  confirmPrompt: 'AI 申请删除员工 #{id}',
  params: [param('id', { type: 'integer', required: true, description: '员工 ID' })]
})
```

高风险不等于“不能给 AI 用”。它表示这类工具应该有更明确的确认、审计和回放边界。

## 行业模板

### 电商 / 交易

| 业务意图 | 推荐工具 | 推荐处理 |
|---|---|---|
| 查询订单 | `order.get` | `low` |
| 退款试算 | `refund.preview` | `low`，返回可退金额、手续费、影响说明 |
| 创建退款申请 | `refund.request.create` | `medium`，业务审批流承接 |
| 立即退款 | `refund.execute` | `high` 或 `confirmWhen amount > 阈值` |

### HR / OA

| 业务意图 | 推荐工具 | 推荐处理 |
|---|---|---|
| 搜索员工 | `staff.search` | `low` |
| 删除影响分析 | `staff_remove.impact` | `low`，返回绑定门店、账号、排班、审批关系 |
| 提交删除申请 | `staff_remove.request.create` | `medium` |
| 直接删除员工 | `staff.delete` | `high` 或 `confirm` |

### CRM / 客服

| 业务意图 | 推荐工具 | 推荐处理 |
|---|---|---|
| 查询客户 | `customer.search` | `low`，手机号等敏感字段标 `sensitive` |
| 新增跟进记录 | `followup.create` | `medium`，通常可直接落库并留痕 |
| 修改成交阶段 | `deal.stage.update` | `medium`，金额大或跨负责人时 `confirmWhen` |

### 运维 / 内部平台

| 业务意图 | 推荐工具 | 推荐处理 |
|---|---|---|
| 查看服务状态 | `service.health` | `low` |
| 发布预检 | `deploy.preview` | `low`，只返回 diff 和影响范围 |
| 创建发布单 | `deploy.request.create` | `medium` |
| 重启/发布执行 | `service.restart` / `deploy.execute` | `high` |

### 财务 / 票据

| 业务意图 | 推荐工具 | 推荐处理 |
|---|---|---|
| 查询发票 | `invoice.query` | `low` |
| 创建付款申请 | `payment.request.create` | `medium` |
| 立即付款/作废票据 | `payment.execute` / `invoice.void` | `high` 或金额阈值确认 |

## 查询工具：让 Agent 不被精确过滤卡住

很多老接口是给前端精确调用设计的：前端先从下拉框拿到精确商品名、分类 id，再传给接口。AI 面对的是自然语言，例如“可乐”“有饮料吗”“便宜点的房间”，很容易把模糊词塞进精确过滤字段。

这不是接口 bug，而是工具契约没说明清楚。推荐按三层处理：

### 第 0 层：中枢侧统一使用纪律

中枢会倾向让 Agent 遵守这些通用纪律：

- 不确定精确值时，先用最少过滤拉候选集，再从结果里筛。
- 查分类/部门等关联实体时，先查分类/部门列表，再拿 id 查业务对象。
- 一次查空时，先放宽条件复查，不直接断言“没有”。

### 第 1 层：业务侧补注解，通常不改逻辑

你只需要把接口的真实脾气写清楚：

- 过滤是精确还是模糊，例如“商品名称精确匹配；查不到时建议不传此参数拉全量再筛”。
- 列表大概多大，能否全量拉，例如“门店商品通常 <200 条，可不带过滤拉全量”。
- 枚举值含义，例如 `item_kind: 0=门票 1=商品 2=服务 3=套餐`。
- 关联查询路径，例如“查某分类下商品：先 item_type_list 拿分类，再传 type_id”。
- 写接口若支持名称自动解析，也写出来，例如“dept_name 可直接传部门名称，接口自动解析”。

### 第 2 层：只有大数据量接口才考虑改代码

会员、交易流水、手牌等大表如果全量拉不现实，才需要在少数接口上增加模糊搜索、名称解析或服务端检索能力。小数据量列表通常靠第 0+1 层就够。

## 自检清单

- [ ] 这个工具是不是后台已有动作，原权限表已经能裁决？
- [ ] `scope` 是否能表达业务权限边界？
- [ ] 查询工具是否说明了过滤精确/模糊、枚举含义和列表规模？
- [ ] 写工具是否区分了“申请/草稿”和“真实执行”？
- [ ] 真实执行是否按业务影响选择了 `medium` / `high` / `confirm` / `confirmWhen`？
- [ ] 涉及手机号、身份证、地址、token 等参数时是否标了 `sensitive`？
- [ ] 响应里是否能清楚告诉 AI：已执行、已提交申请、已创建草稿，还是失败？

## 一句话心法

> 百灵中枢不是让 Agent 绕过业务系统，而是把“人能在后台做的事”用可治理、可审计、可确认的方式交给 Agent 代办。
