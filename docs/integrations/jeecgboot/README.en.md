# JeecgBoot + BailingHub Governed User Actions

> Status: independent community integration recipe. It is not an official
> JeecgBoot integration and does not imply upstream endorsement.
>
> Goal: add an AI assistant to an existing JeecgBoot enterprise backend while
> exposing only two governed actions: read one user and freeze or unfreeze one
> user. JeecgBoot keeps ownership of tenant isolation, permissions, and user
> state rules.

## 1. Why These Two Actions

This recipe is grounded in JeecgBoot commit
`df83f4de76811ea73bf5b37a8fe00cbb59988a1b` and selects one read and one write:

| Scenario | Upstream endpoint | Existing permission | Agent capability |
| --- | --- | --- | --- |
| Read user details | `GET /sys/user/queryById` | `system:user:queryById` | `system.user.read` |
| Freeze or unfreeze a user | `PUT /sys/user/frozenBatch` | `system:user:frozenBatch` | `system.user.status.update` |

In SaaS mode, JeecgBoot filters user lists through `TenantContext`, while these
detail and status endpoints operate on global user IDs. A thin Agent adapter
therefore cannot merely forward the calls. Before invoking the existing
service, it must prove that both the operator and target user are active members
of the current tenant.

The boundary is:

> BailingHub governs what an Agent may reach, when approval is required, and
> how the action is audited. JeecgBoot still decides whether the operator has
> the original permission, whether the target belongs to the tenant, and
> whether the state transition is valid.

## 2. Correct Topology

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

The model must not hold a JeecgBoot admin token or choose the tenant or acting
subject. Use a trusted subject format such as:

```text
<tenant_id>:<operator_user_id>
```

## 3. Thin Adapter Requirements

Every check must fail closed:

1. Verify `X-Bailing-Signature` and `X-Bailing-Timestamp`.
2. Read the subject only from signed `X-Bailing-On-Behalf-Of`.
3. Restore `TenantContext` and clear it when the request ends.
4. Use `getUserTenantByTenantId(operatorUserId, tenantId)` to verify an active
   operator membership.
5. Re-check the original Shiro permission: `system:user:queryById` for the read
   and `system:user:frozenBatch` for the write.
6. Verify that the target user has an active membership in the same tenant.
7. Re-read the target user and reject missing users, `admin`, and cross-tenant
   targets.
8. Accept only JeecgBoot status values `1=normal` and `2=frozen`.
9. Bind the write to `X-Bailing-Idempotency-Key` so retries cannot create a
   second business intent.
10. Invoke the existing `SysUserService.updateStatus(...)` so JeecgBoot remains
    responsible for cache cleanup and final user state.

Do not rely only on `userTenantIzExist(...)`: the current implementation counts
whether a relation exists but does not prove that the membership is active.
Read and validate the complete `SysUserTenant` relation.

## 4. Explicitly Excluded Endpoints

The Agent tool source must not expose:

- `/sys/user/listAll`, because the upstream comment explicitly says it bypasses
  tenant isolation;
- `/sys/user/deleteBatch`, because irreversible batch deletion is outside this
  narrow recipe;
- `/sys/user/resetPassword`, because credential reset requires a separate
  identity and security workflow;
- `/sys/user/updatePassword`, because models must not construct or hold account
  credentials;
- the raw `/sys/user/queryById` or `/sys/user/frozenBatch` endpoints, which must
  only be reached through the adapter.

## 5. Import Into BailingHub

1. Implement the thin adapter on the JeecgBoot side.
2. Create a BailingHub tool source whose `base_url` points to the adapter, not
   the JeecgBoot admin backend.
3. Configure a dedicated HMAC secret for the source.
4. Import [jeecgboot-user-adapter.openapi.json](./jeecgboot-user-adapter.openapi.json).
5. Allow only `system.user.read` and `system.user.status.update` on the route.
6. Validate anonymous subjects, invalid signatures, wrong tenants, inactive
   memberships, and unauthorized operators.

Example route:

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

## 6. Governance Differences

### Read One User

- Risk: `low`
- Subject: required
- Read-only: yes
- Idempotent: yes
- Audit-sensitive: yes, because user details may contain organizational and
  contact information

### Freeze Or Unfreeze One User

- Risk: `high`, because the action changes account availability
- Subject: required
- Human approval: required, bound to tenant, target user, and target status
- Idempotent: declared and enforced by the adapter
- Final authority: JeecgBoot permissions, tenant membership, user state, and
  business service

Approval does not guarantee that the state change will succeed. If permission,
membership, or target state changes while approval is pending, the adapter must
deny execution or require a new approval.

## 7. Minimal Acceptance Flow

Use test tenants and test users to verify:

1. An active member with read permission can read a test user in the same tenant.
2. Missing subject, invalid signature, expired timestamp, and wrong tenant fail.
3. A user in another tenant is denied even when the global user ID exists.
4. An operator without `system:user:frozenBatch` cannot request a freeze.
5. The write cannot reach JeecgBoot before approval.
6. Changing target user, tenant, or status after approval requires re-approval.
7. Retrying one idempotency key cannot create a second business intent.
8. An inactive operator or target membership at dispatch causes denial.
9. The `admin` user cannot be frozen.
10. `listAll`, deletion, and password endpoints never appear in the tool list.

## 8. Static Verification

```bash
node verify_recipe.mjs
```

Expected output:

```text
PASS: JeecgBoot BailingHub recipe preserves signature, tenant, permission, approval, idempotency, and final-authority boundaries.
```

The verifier does not connect to JeecgBoot or modify any user. A production
integration still requires a real adapter plus permission, tenant, concurrency,
and recovery tests.

## 9. Primary Evidence

- [SysUserController at the inspected commit](https://github.com/jeecgboot/JeecgBoot/blob/df83f4de76811ea73bf5b37a8fe00cbb59988a1b/jeecg-boot/jeecg-module-system/jeecg-system-biz/src/main/java/org/jeecg/modules/system/controller/SysUserController.java)
- [SysUserServiceImpl at the inspected commit](https://github.com/jeecgboot/JeecgBoot/blob/df83f4de76811ea73bf5b37a8fe00cbb59988a1b/jeecg-boot/jeecg-module-system/jeecg-system-biz/src/main/java/org/jeecg/modules/system/service/impl/SysUserServiceImpl.java)
- [ISysUserTenantService at the inspected commit](https://github.com/jeecgboot/JeecgBoot/blob/df83f4de76811ea73bf5b37a8fe00cbb59988a1b/jeecg-boot/jeecg-module-system/jeecg-system-biz/src/main/java/org/jeecg/modules/system/service/ISysUserTenantService.java)
- [BailingHub third-party integration guide](../../第三方对接指南.md)
- [ACC OpenAPI binding](https://github.com/agent-capability/agent-capability-contract/blob/main/bindings/openapi.md)
