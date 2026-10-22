# Model output-budget contract

[简体中文](MODEL_OUTPUT_BUDGET.md)

AIaaS model services separate the default budget for a new request from its permitted service ceiling. This applies to `/usage/v1/model/models` and the chat-model gateway. It does not change bundled-chat knowledge assembly, image-model tools, metering or original-request recovery.

## Service configuration and discovery

| Configuration | Model descriptor | Meaning |
| --- | --- | --- |
| `maxOutputTokens` | `max_output_tokens` | Operator service ceiling, a positive integer currently bounded to 1–131072; not a vendor capability claim |
| `defaultOutputTokens` | `default_output_tokens` | Default when a new request omits its output parameter; positive and no larger than the ceiling |
| `outputTokenParameter` | `output_token_parameter` | Actual configured route parameter, `max_tokens` or `max_completion_tokens` |
| `outputBudgetScope` | `output_budget_scope` | `completion_total` shares the budget between reasoning and answer; `final_answer` limits the final answer only |
| `modelMaxOutputTokens` | `model_max_output_tokens` | Optional verified vendor maximum for this parameter/scope; omit unknown values, and keep the service ceiling at or below it |

Default, parameter and scope form an all-or-none explicit group. This contract permits `max_completion_tokens` only with `completion_total`; `max_tokens` can have either scope depending on the actual provider route. Metadata neither probes nor guarantees vendor support. Do not infer semantics from model names; reverify parameter, scope and vendor maximum after changing models, credentials or routes.

`modelMaxOutputTokens` is allowed only with the explicit policy, between 1 and 10000000. A higher vendor capability never removes the platform's bounded `maxOutputTokens` ceiling. Context window, output budget, input-byte limit and timeout are independent. Descriptors do not expose credential aliases, `providerScope`, vendor URLs or request bodies.

Example values illustrate the contract, not recommended settings for a real model:

```json
{
  "maxOutputTokens": 65536,
  "defaultOutputTokens": 32768,
  "outputTokenParameter": "max_completion_tokens",
  "outputBudgetScope": "completion_total",
  "modelMaxOutputTokens": 131072
}
```

Discovery returns the corresponding `max_output_tokens`, `default_output_tokens`, `output_token_parameter`, `output_budget_scope` and `model_max_output_tokens`. Its `provider_options` list includes only the configured output key alongside unchanged passthrough options. Gateway capabilities declare support through `output_budget` with schema `bailing.model-output-budget.v1`.

## Dispatch and rejection

Under an explicit policy, omitting the output parameter selects the independent default and configured wire key. A matching parameter is accepted through the exact service ceiling; ceiling plus one is rejected. Both output keys together remain invalid. A different key returns HTTP 400 `USAGE_OUTPUT_PARAMETER_MISMATCH`, never a silent rename that might change reasoning/answer semantics.

```json
{
  "error": "USAGE_OUTPUT_PARAMETER_MISMATCH",
  "dispatch": "not_dispatched",
  "feedback": {
    "output_budget": {
      "expected_parameter": "max_completion_tokens",
      "scope": "completion_total"
    }
  }
}
```

An excessive budget returns HTTP 413 `USAGE_OUTPUT_LIMIT`; `feedback.output_limit` contains `actual`, `allowed`, `parameter` and known `scope`. These are safe scalars, excluding messages, full requests, provider configuration and credentials. Both failures precede admission and vendor dispatch; Core does not clamp, retry or charge them.

Existing `thinking.budget_tokens`, `reasoning_effort` and similar options pass through. Core does not invent or add separate reasoning budgets. Reported reasoning Tokens are subsets, not another completion debit. A transport-complete exchange does not guarantee an untruncated answer.

## Legacy services and original requests

When the group is absent, legacy behavior remains: no separate default/scope/vendor maximum is invented; an omitted output key uses the existing ceiling as default `max_tokens`, and either historical output key can still be selected. Editing only a label or unrelated field must not enable the policy silently. A legacy image service's `maxOutputTokens` residue is not interpreted as an image Token limit; new chat policy fields are rejected for image tools.

Already admitted operations are resolved by original ID and request hash before consulting current policy. Policy changes never rewrite their service snapshot, intent or metering, and never redispatch them. Keep the original operation/digest and recovery flow.

A locally prepared but unadmitted request has no preserved old service snapshot. Enabling a policy may reject its original parameter. Refresh discovery, explain the change and explicitly prepare a new operation. Never rewrite the old intent, submit changed content under its ID or mistake a parameter rejection for a retryable network error.

Clients consume default and ceiling separately and construct new requests using the descriptor. Do not hardcode all services back to 8192 or treat a default as the maximum. SDK helpers parse descriptors and construct new options; saved prepared requests do not pass through a rewriting helper. Deploying the contract does not reconfigure old services. Production configuration and real-provider long-output acceptance are separate actions.

## Local verification

- `node --import tsx --test src/modules/usage/output-budget.test.ts` covers group validation, legacy discovery, bounds, parameter scope, scalar feedback, actual synthetic HTTP bodies and reasoning usage.
- With the dedicated local synthetic MySQL on `127.0.0.1:16307`, run `BAILING_USAGE_TEST_MYSQL=1 node --import tsx --test src/modules/usage/output-budget.mysql.test.ts`. Each case creates and removes random databases and checks persistence, dispatch, admitted recovery, unadmitted rejection and single billing. It does not read deployment secrets or call real providers.
