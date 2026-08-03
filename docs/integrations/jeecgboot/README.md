# JeecgBoot + BailingHub 用户治理接入配方

> 状态：独立社区接入候选，不是 JeecgBoot 官方集成，也不代表上游认可。
>
> 目标：给一套已有 JeecgBoot 企业后台增加 AI 助理时，只开放“查询一个用户”和“冻结或解冻一个用户”两项受治理能力，同时继续使用 JeecgBoot 原有租户、权限与用户状态规则。

## 1. 为什么选择用户查询与冻结

这份配方基于 JeecgBoot 仓库提交
`df83f4de76811ea73bf5b37a8fe00cbb59988a1b` 的真实代码，选择一读一写两个动作：

| 场景 | 上游接口 | 原权限 | Agent 能力 |
| --- | --- | --- | --- |
| 查询用户详情 | `GET /sys/user/queryById` | `system:user:queryById` | `system.user.read` |
| 冻结或解冻用户 | `PUT /sys/user/frozenBatch` | `system:user:frozenBatch` | `system.user.status.update` |

JeecgBoot 的用户列表在 SaaS 模式下会按 `TenantContext` 过滤租户成员，但上述详情和冻结接口本身只按全局用户 ID 操作。因此，Agent 适配层不能简单转发这两个接口：它必须在调用原服务前额外验证操作人与目标用户都属于当前租户，且租户成员关系处于有效状态。

这条边界可以概括为：

> BailingHub 管理 Agent 最多可以触达什么、何时审批和如何审计；JeecgBoot 继续决定当前操作人是否有原系统权限、目标用户是否属于当前租户，以及状态变更是否允许成立。

## 2. 正确拓扑

```text
AI assistant / Agent
  -> BailingHub governed route
  -> capability allowlist / trusted subject / approval / audit / idempotency
  -> thin JeecgBoot adapter
       1. verify BailingHub HMAC
       2. read signed X-Bailing-On-Behalf-Of
       3. restore tenant context
       4. verify active operator tenant membership
       5. re-check the original Shiro permission
       6. verify active target tenant membership
       7. re-read target user and call the existing service
  -> JeecgBoot permission, tenant, user, and cache services
```

模型不能持有 JeecgBoot 后台 Token，也不能填写租户或操作主体。可信主体建议固定为：

```text
<tenant_id>:<operator_user_id>
```

## 3. 薄适配层必须做什么

所有检查都必须失败关闭：

1. 验证 `X-Bailing-Signature` 与 `X-Bailing-Timestamp`；
2. 只从已签名的 `X-Bailing-On-Behalf-Of` 读取主体；
3. 恢复 `TenantContext`，并在请求结束后清理上下文；
4. 通过 `getUserTenantByTenantId(operatorUserId, tenantId)` 确认操作人租户关系存在且状态为正常；
5. 查询原 Shiro 权限，只读复核 `system:user:queryById`，写操作复核 `system:user:frozenBatch`；
6. 通过同一租户关系查询确认目标用户属于当前租户且状态正常；
7. 重新读取目标用户，拒绝不存在、`admin` 或不属于当前租户的目标；
8. 写操作只接受 JeecgBoot 已定义的 `1=正常`、`2=冻结`；
9. 以 `X-Bailing-Idempotency-Key` 固定一次状态变更，防止重试产生第二次业务意图；
10. 最终调用现有 `SysUserService.updateStatus(...)`，由 JeecgBoot 清理用户缓存并持有最终业务状态。

不能只调用 `userTenantIzExist(...)`：当前实现只统计关系是否存在，不能证明成员关系状态正常。适配层应读取完整 `SysUserTenant` 关系并校验状态。

## 4. 明确不暴露的接口

以下能力不进入该 Agent 工具源：

- `/sys/user/listAll`：上游注释明确说明不做租户隔离；
- `/sys/user/deleteBatch`：不可逆批量删除不属于本配方；
- `/sys/user/resetPassword`：密码重置需要独立身份与安全流程；
- `/sys/user/updatePassword`：不能让模型代持或构造凭证；
- 原始 `/sys/user/queryById` 与 `/sys/user/frozenBatch`：只允许经薄适配层调用。

## 5. 导入 BailingHub

1. 在 JeecgBoot 侧实现上述薄适配层；
2. 在 BailingHub 新建工具源，`base_url` 指向适配层，不指向 JeecgBoot 管理后台；
3. 为工具源配置独立 HMAC Secret；
4. 导入 [jeecgboot-user-adapter.openapi.json](./jeecgboot-user-adapter.openapi.json)；
5. 路由只允许 `system.user.read` 与 `system.user.status.update`；
6. 工具源验证至少覆盖匿名主体、错误签名、错误租户、失效成员关系和越权主体。

示例路由：

```json
{
  "tools": {
    "sources": [
      {
        "provider": "jeecgboot-user-adapter",
        "allow": [
          "system.user.read",
          "system.user.status.update"
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

## 6. 治理差异

### 查询一个用户

- 风险：`low`
- 主体：必需
- 只读：是
- 幂等：是
- 审计敏感：是，用户详情可能包含组织与联系信息

### 冻结或解冻一个用户

- 风险：`high`，操作会改变账号可用性
- 主体：必需
- 人工审批：必需，批准内容固定目标用户、租户和目标状态
- 幂等：是，但适配层必须兑现
- 最终授权：仍由 JeecgBoot 权限、租户关系、目标用户状态和业务服务决定

审批通过不等于状态变更必然成功。执行前若权限、成员关系或目标状态变化，适配层必须拒绝或要求重新审批。

## 7. 最小验收流程

在测试租户和测试账号中依次验证：

1. 有查询权限的有效租户成员读取同租户测试用户；
2. 无主体、错误签名、过期时间戳或错误租户均拒绝；
3. 查询其他租户用户时拒绝，即使全局用户 ID 存在；
4. 无 `system:user:frozenBatch` 权限的主体请求冻结时拒绝；
5. 冻结任务在批准前不能调用 JeecgBoot；
6. 批准后更换目标用户、租户或状态时拒绝并重新审批；
7. 同一幂等键重试不能产生第二个业务意图；
8. 审批等待期间操作人或目标用户租户关系失效时拒绝；
9. `admin` 用户不能被冻结；
10. `listAll`、删除与密码接口不出现在工具清单中。

## 8. 静态校验

```bash
node verify_recipe.mjs
```

成功输出：

```text
PASS: JeecgBoot BailingHub recipe preserves signature, tenant, permission, approval, idempotency, and final-authority boundaries.
```

静态校验不连接 JeecgBoot，也不会修改用户状态。生产接入仍需实现适配层并完成真实权限、租户与并发测试。

## 9. 一手依据

- [SysUserController at the inspected commit](https://github.com/jeecgboot/JeecgBoot/blob/df83f4de76811ea73bf5b37a8fe00cbb59988a1b/jeecg-boot/jeecg-module-system/jeecg-system-biz/src/main/java/org/jeecg/modules/system/controller/SysUserController.java)
- [SysUserServiceImpl at the inspected commit](https://github.com/jeecgboot/JeecgBoot/blob/df83f4de76811ea73bf5b37a8fe00cbb59988a1b/jeecg-boot/jeecg-module-system/jeecg-system-biz/src/main/java/org/jeecg/modules/system/service/impl/SysUserServiceImpl.java)
- [ISysUserTenantService at the inspected commit](https://github.com/jeecgboot/JeecgBoot/blob/df83f4de76811ea73bf5b37a8fe00cbb59988a1b/jeecg-boot/jeecg-module-system/jeecg-system-biz/src/main/java/org/jeecg/modules/system/service/ISysUserTenantService.java)
- [BailingHub third-party integration guide](https://github.com/bailinghub/bailinghub/blob/main/docs/%E7%AC%AC%E4%B8%89%E6%96%B9%E5%AF%B9%E6%8E%A5%E6%8C%87%E5%8D%97.md)
- [ACC OpenAPI binding](https://github.com/agent-capability/agent-capability-contract/blob/main/bindings/openapi.md)
