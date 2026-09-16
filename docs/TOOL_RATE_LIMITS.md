# 批量业务操作的限额与恢复

例如智能体需要批量更新商城商品资料，管理员可以根据部署规模设置额度。无需修改业务能力声明，也无需取消原有权限与审批。

## 在哪里设置

进入 **工具源 → 编辑 → 治理**：

- **工具源总限额**：该工具源的所有工具、用户、授权与会话，共用每分钟额度。`0` 关闭这一层总闸。
- **单工具默认策略**：继承业务声明、自定义中枢限额，或关闭中枢单工具限额。
- **指定工具覆盖**：针对某个工具单独设置，优先于默认策略。“继承业务声明”表示直接使用该工具的声明。

自定义支持按秒、分钟、小时或天计数。每个工具分别计数；同一工具源、同一工具的不同用户与会话共享额度，并非每次新建会话获得一份新额度。工具清单详情同时显示原声明、生效限额和来源。刷新清单会保留管理员设置。

若要关闭该工具源在中枢的两层工具限额，将总限额设为 `0`，将单工具默认策略设为“关闭中枢单工具限额”，并检查指定工具覆盖。**接入方 → 编辑**中的每分钟限额仍独立生效，它按 `client_app_id` 共享，也支持 `0` 关闭。业务系统自己实施的限流仍由业务系统管理。

## 数量代表什么

`120 次/小时` 按一小时滑动窗口计数：空窗口中可连续接受 120 次，随后等待最早一笔额度到期。不会折算成每分钟 2 次。计数针对中枢调度闸接受的尝试，不是业务成功数量；接受后进入审批或业务拒绝的尝试也可能占用额度。

MySQL 运行时在同一事务中检查工具与工具源两层额度；任一层拒绝，均不增加另一层的计数。内存运行时使用同样的全闸检查。旧扩展若仅实现单桶 `consume` 回调，可继续运行；要获得全闸原子计数，应实现可选 `consumeAll` 接缝。修改配置不主动清空账本，按新窗口及已保留记录计算。

## 被限流后如何继续

调用尚未派发时，回执仍为 `rejected_before_dispatch`、`auto_retry_allowed=true`，并增加：

```json
{
  "retry_after_ms": 60000,
  "rate_limit": {
    "level": "tool",
    "count": 120,
    "window_sec": 3600,
    "scope": "tool_provider_shared",
    "source": "declaration"
  }
}
```

`retry_after_ms` 是当前观察下的等待提示，等待结束后仍会重新核验授权、配置和额度。SDK 保留这些可选字段；DSH 等待后只恢复原 `invocation_id`。等待超过本次自动等待预算时，DSH 返回 `agent_client_wait.state=rate_limited`，保留原调用供稍后恢复，避免高频轮询。

Core 在私有执行记录中加密保存原参数，并绑定原授权、run、工具、参数摘要与执行契约。恢复不会让模型重新拼参数。派发前先持久化执行标记；如果写操作可能已发出、但没有可靠结果，则进入 `reconciliation_required`，不重新派发。权限、参数审批与原身份核验照常生效。

## 升级与兼容

本说明适用于 Core 0.8.0 及配套 SDK/DSH 0.6.0。Core 需执行 `061_tool_rate_limit_policies.sql`；历史配置默认继承原声明。SDK/DSH 配套版本提供等待提示，旧包可忽略新增字段，仍沿用原接口。

原参数快照使用实例 `server.token` 派生的专用密钥加密；重启需保留该配置。轮换该令牌后未完成快照无法解密，会严格阻断自动派发。已完成结果与原审批记录仍沿原路径读取。旧版本已丢失的参数不会被猜补，不能承诺修复历史失败调用后自动执行。

Business backends keep their existing declarations and APIs. Operators can inherit, override or disable Hub tool limits under **Tool providers → Edit → Governance**. Tool limits are shared per provider/tool; the provider gate is shared across all its tools, and the client gate remains independent. Hour/day windows retain their original duration. Matching SDK/DSH candidates preserve retry hints and resume only the original invocation; an uncertain write is never replayed automatically.
