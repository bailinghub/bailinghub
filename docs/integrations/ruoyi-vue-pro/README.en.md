# RuoYi-Vue-Pro / Yudao + BailingHub Integration Recipe

> Status: independent community integration recipe. It is not an official RuoYi-Vue-Pro integration and does not imply upstream endorsement.
>
> Goal: let an AI assistant read after-sale details and request a governed refund without holding an admin bearer token, bypassing the existing permission model, or exposing payment callbacks as Agent tools.

## Inspected upstream operations

This recipe is pinned to RuoYi-Vue-Pro commit
`0418084e222612af2fc1141f566af454f9236ab1` and maps two existing admin operations:

| Scenario | Upstream endpoint | Existing permission | Agent-facing scope |
| --- | --- | --- | --- |
| Read after-sale details | `GET /admin-api/trade/after-sale/get-detail` | `trade:after-sale:query` | `trade.after-sale.read` |
| Confirm a refund | `PUT /admin-api/trade/after-sale/refund` | `trade:after-sale:refund` | `trade.after-sale.refund` |

The boundary is deliberate:

> BailingHub limits which capability an Agent can reach. RuoYi-Vue-Pro still decides whether the acting admin is authorized, whether the after-sale state permits a refund, and whether the payment operation can succeed.

The payment callback `POST /admin-api/trade/after-sale/update-refunded` is explicitly excluded. `@PermitAll` on an infrastructure callback does not make it an Agent-facing business action.

## Topology

```text
AI assistant / Agent
  -> BailingHub client and governed route
  -> allowlist / trusted subject / approval / audit / idempotency
  -> thin RuoYi-Vue-Pro adapter
       1. verify BailingHub HMAC
       2. read signed X-Bailing-On-Behalf-Of
       3. restore tenant_id:admin_user_id
       4. re-check the original RuoYi permission
       5. call the existing AfterSaleService
  -> RuoYi-Vue-Pro business and payment services
```

Do not give the model an RuoYi-Vue-Pro admin bearer token. Do not let BailingHub replace RuoYi-Vue-Pro's permission checks or current business-state decisions.

## Thin adapter invariants

The adapter must fail closed and:

1. verify `X-Bailing-Signature` and `X-Bailing-Timestamp`;
2. derive the subject only from signed `X-Bailing-On-Behalf-Of`;
3. restore the correct tenant before authorization;
4. re-check `trade:after-sale:query` or `trade:after-sale:refund` in the original permission system;
5. let `AfterSaleService` re-check current state at execution time;
6. reuse `X-Bailing-Idempotency-Key` for one business effect;
7. deny missing, unknown, cross-tenant, unauthorized, stale, or conflicting requests.

The OpenAPI document describes the adapter, not the RuoYi-Vue-Pro admin API directly:

- [ruoyi-vue-pro-trade-adapter.openapi.json](./ruoyi-vue-pro-trade-adapter.openapi.json)
- [adapter-contract.v1.json](./adapter-contract.v1.json)

## Governance differences

The read operation is low-risk, read-only, and idempotent, but still requires a trusted acting subject because the upstream operation is permission protected.

The refund operation is high-risk and requires pre-execution approval with a frozen after-sale identifier. Approval is not final authorization: the adapter must re-authenticate the request, re-check the subject and permission, and let the business service decide against fresh state.

## Minimum validation

Use a test environment with no production payment effects and prove:

1. an authorized subject can read one known after-sale record;
2. missing or unknown subjects are denied;
3. an admin without `trade:after-sale:refund` is denied;
4. no refund call occurs before approval;
5. changed arguments require a new approval or are denied;
6. retrying one idempotency key cannot create a second business effect;
7. state changes during an approval pause are rejected by the business service;
8. `update-refunded` never appears in the Agent tool list.

These checks validate the boundary of this recipe. They do not by themselves prove production compliance or payment safety.

## Static verification

```bash
node verify_recipe.mjs
```

The checker is offline. It does not connect to RuoYi-Vue-Pro or execute a refund.

## Primary references

- [RuoYi-Vue-Pro AfterSaleController at the inspected commit](https://github.com/YunaiV/ruoyi-vue-pro/blob/0418084e222612af2fc1141f566af454f9236ab1/yudao-module-mall/yudao-module-trade/src/main/java/cn/iocoder/yudao/module/trade/controller/admin/aftersale/AfterSaleController.java)
- [RuoYi-Vue-Pro AfterSaleServiceImpl at the inspected commit](https://github.com/YunaiV/ruoyi-vue-pro/blob/0418084e222612af2fc1141f566af454f9236ab1/yudao-module-mall/yudao-module-trade/src/main/java/cn/iocoder/yudao/module/trade/service/aftersale/AfterSaleServiceImpl.java)
- [BailingHub third-party integration guide](../../INTEGRATION.en.md)
- [ACC OpenAPI binding](https://github.com/agent-capability/agent-capability-contract/blob/main/bindings/openapi.md)
