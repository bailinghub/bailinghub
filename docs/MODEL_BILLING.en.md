# Model services and plan billing

This optional lightweight model billing gateway is introduced in Core 0.9.0. Administrators configure provider connections, reference prices and plans, then grant them to accounts. Local agents continue to orchestrate reasoning, tool search, image generation and business actions. The Hub does not take over host orchestration or charge per user turn or task step. [简体中文](MODEL_BILLING.md).

## One plan, one allowance

For example, a monthly plan may sell for 300 USD and provide a 100 USD allowance with a 1.5 multiplier, two conversation models and one image tool. A request costing 0.20 USD at reference prices deducts 0.30 USD and leaves an actual allowance ratio of 99.70%. Summaries expose precise values and separate display strings; percentage display may round down. Models and tools share the allowance.

- **Periodic plans:** `priceUsd` is the sale price; explicit positive `periodAllowanceUsd` is the USD allowance per day, week or month. Customers see a percentage using that allowance as its denominator.
- **Credit packs:** `priceUsd` is the one-time USD allowance; `periodAllowanceUsd` is rejected. Customer Credits use a fixed 1000 Credits per USD with no separate credit ledger.
- `duration` controls validity separately from reset periods. A final partial period still receives the full allowance. Expiration stops new requests; unused allowance does not roll over. Daily, weekly and monthly periods retain the original grant time and UTC anchor. Payment, exchange rates, refunds and product pricing belong to the business application.
- `multiplier` applies uniformly across a plan; there are no separate model multipliers within it.
- Existing grants read the current plan service set and multiplier by plan ID. Price, allowance, period and validity are fixed when granted. Template price changes apply to future grants and do not reset active account balances.
- Removing a service does not remove allowance. Plans may have no available models and return an empty catalog. A plan still used by an effective grant requires its use relationship to be resolved before removal. Historical settlement evidence is retained.

Input, output and total Tokens remain raw usage fields for administration and history. They are neither allowance limits nor percentage denominators. Image services that provide no Tokens do not receive invented counts.

## Reference prices

The current reference source is OpenRouter's public model and image endpoint price catalog, bound to an exact `modelId + endpointId`. Actual calls use the administrator's credentials, URL and model identifier. A reference price does not represent another provider's paid price or invoice; operators must verify the mapping.

Access triggers a background refresh after the six-hour cache lifetime; administrators can also synchronize explicitly. A failed catalog fetch may retain an existing quote and expose its stale state. A successful refresh that identifies unsupported endpoint rules blocks new pricing requests rather than treating them as free. Each request saves its price and multiplier snapshot, so later changes never recalculate history.

Charge = actual provider metering × reference unit price × plan multiplier. Adapters map Token, image-count and supported image-pixel metering. Unreliable mappings keep `billing_state=pending` rather than guessing zero cost. An arbitrary provider `cost` field cannot replace the stored price snapshot.

Amounts use twelve-decimal fixed precision. Positive balances admit new requests and actual charges settle asynchronously; concurrency can create overage, which is recorded, while depleted balances block new requests. Settlement does not interrupt streaming, and an earlier pending settlement does not block every subsequent independent task.

## Models and tools

Services have `chat` or `tool` purpose:

- Conversation models populate the model picker; responses and streaming chunks return directly to the local host.
- Model tools have a separate catalog of names, purpose, parameters, output and callable state. Hosts inject and execute those tools.
- Initial executable adapters support text-to-image through Aliyun OpenAI Images-compatible, native DashScope and OpenRouter Images APIs. Requests persist dispatch evidence, return `202/pending` and finish asynchronously.
- Video, voice and custom capabilities may be declared. Without an execution adapter they have `callable=false`; declarations do not imply generation support.
- Image results are URL or Base64. Hosts may reuse the existing attachment space for durable or business use. Image generation does not automatically change business data.

Image adapters accept only declared, supported text-to-image parameters. An attachment reference cannot stand in for a provider-accessible URL. Aliyun has two explicit adapters: `aliyun-image` uses OpenAI Images compatibility and `aliyun-image-native` uses native DashScope. Credentials may use the standard service root, `/api/v1` or `/compatible-mode/v1`; the native adapter maps parameters to a fixed native path on the same origin. Errors never trigger an automatic protocol, region or model switch and retry.

## Client API

Discover `model_gateway.supported=true` in `GET /usage/v1/capabilities`. Its schema is `bailing.model-gateway.v1`, with `billing_unit=USD`, `orchestration=host` and `turn_required=false`.

| Endpoint | Purpose |
| --- | --- |
| `GET /usage/v1/model/models` | Conversation models in the account's plan, using configured labels |
| `GET /usage/v1/model/tools` | Plan tool declarations and callable state |
| `GET /usage/v1/model/summary` | Remaining allowance, period and customer presentation |
| `POST /usage/v1/model/requests` | One conversation-model request |
| `POST /usage/v1/model/requests/stream` | Streaming using the same request contract |
| `POST /usage/v1/model/tools/requests` | `{operation_id,service_id,arguments,conversation_id?,turn_id?}` |
| `GET /usage/v1/model/requests/{operation_id}` | Read the original result without calling or generating again |
| `POST /usage/v1/model/requests/{operation_id}/cancel` | Cancel further result use while retaining incurred usage |

Persist the original `operation_id` locally. Missing responses, offline reopening and uncertain outcomes require querying the original request, never generating again with another ID. The same ID and content dispatch only once; different content with the same ID conflicts. New actions are distinct from recovery. Late usage after cancellation remains recorded and cannot resume a finished host turn.

Responses expose `result_state`, `billing_state`, `response`, raw `usage` (possibly absent), `raw_usage`, `reference_cost_usd`, `billed_usd` and `overage_usd`. `billing_rate` includes plan revision, multiplier and price snapshot. Results have bounded retention; `response_expired` does not authorize re-dispatch.

Trusted backends retain the existing identity-exchange entry point. `model_access: token_gateway` identifies plan-scoped credentials, not a legacy Token allowance mode; `service` remains restricted to one model. Identity, business authority, fixed session scope, approvals and business-call archives remain independent and are not expanded by a plan.

Console endpoints use `/admin/api/usage/billing/`. Business backends can use `/usage/v1/external/billing/plans` and `/accounts/{id}/summary|grant|control`, retaining source ownership, permissions and idempotent grants.

## Installation

From public Core 0.8.0, apply added `063_usage_model_billing.sql` and `064_period_plan_allowance.sql` through the official migrator. Fresh installations apply all outstanding files. Normal upgrades retain real data and require no old-schema purge. Instances already running a 063 billing preview follow the [period allowance migration](PERIOD_ALLOWANCE_UPGRADE.en.md) for their original snapshots. There are no legacy Token allowance, per-turn or per-model-multiplier interfaces. Maintenance of abandoned development schemas is not a customer upgrade requirement and test-data cleanup is not part of public SQL. See the [v0.9.0 upgrade guide](UPGRADE_v0.9.0.en.md).

## Configuration readiness and discovery

A service being `active` is not sufficient to call it: executable services also need explicit reference-model/endpoint bindings and usable cached quotes. The console exposes `availability` with `state`, `code` and `message`, and validates the quote before saving an active executable service. A plan cannot newly select an unready service; existing selections can remain or be removed without recreating accounts or changing allowance. External provisioning can stage declarations, but staging never makes them callable.

Both `/usage/v1/model/models` and `/usage/v1/model/tools` return only ready entries in `items`. `unavailable_items` contains unavailable service IDs, labels, revisions and reasons within the current plan/credential scope, without provider credentials or tool schemas. The default conversation model is ready or `null`. Hosts must not automatically switch models or replay requests when a service becomes unavailable. Refresh the catalog after configuration is fixed; no reauthorization or allowance reset is required. Existing SDKs pass these additive fields through; `items` alone is sufficient for a safe picker and callable registry.

- `USAGE_PRICE_NOT_CONFIGURED`: missing or invalid reference binding.
- `USAGE_PRICE_UNAVAILABLE`: no synchronized quote, or the fixed endpoint disappeared.
- `USAGE_PRICE_UNSUPPORTED`: unsupported endpoint metering rules.
- `MODEL_TOOL_ADAPTER_NOT_READY`: declaration only, without an execution adapter.

Configuration failures precede admission or provider dispatch and use `next_action=contact_operator`, not automatic retry. Discovery uses the same cached quote as admission and neither generates content nor waits for remote price lookup. A valid stale quote can remain usable during a catalog outage with a background refresh. Readiness does not guarantee provider availability or complete metering; missing actual usage remains pending settlement, never an invented fee.

## Generation and billing states are separate

- `result_state=pending`: work is ongoing; query the original ID without another generation.
- `complete`: use the result immediately even if `billing_state=pending`; settlement does not block it.
- `failed`: confirmed rejection, such as an absent API, invalid parameters or denied access. `dispatch=rejected`; stop waiting and show the safe error without automatic resubmission. Confirmed rejection without generation closes with zero charge.
- `unknown`: a disconnect, server error or incomplete result leaves execution uncertain. Stop the generating indicator and retain the ID for inspection; do not change ID or endpoint and retry. Other independent requests remain possible.
- `cancelled`: remain cancelled; late results and charges do not re-enable a tool or resume a finished turn.

Failure `error` contains only `code`, fixed safe `message`, optional `http_status / provider_code / provider_request_id`, `retryable=false` and `next_action`. Provider raw error bodies, prompts, secrets and URLs are not stored or returned as errors. HTTP 408, 409 and 5xx do not prove non-execution.

Hub asynchronous admission and provider task protocols are separate. Current native/compatible image adapters perform one provider request in the background; original-ID lookup reads persisted results. Without a provider task ID, provider-task recovery must not be claimed. Historical unknown outcomes are not guessed into failure; original evidence and price snapshots remain.

## Removing plans and retaining history

Plans are soft-deleted with their original IDs. Removal checks active, unexpired grants currently referenced by active accounts, including future-start grants. Older grants, expired grants, disabled accounts and suspended grants do not prevent removal. Suspending a template stops new grants without terminating existing ones.

Historical grants, pools, ledger and request snapshots remain. Already-dispatched requests recover and settle against their original snapshots without moving to a new plan or re-dispatching. Restoring an account does not restore a removed plan; renewed use requires a valid grant.

## Archiving and restoring accounts

Disabled personal and shared organization accounts can be archived. Default lists hide them while retaining the original account ID, trusted identity, member states, grants, allowance, requests and ledger associations. History does not block archiving; integrity problems must be repaired first. Source account scopes remain unchanged but cannot use archived accounts.

Archiving revokes existing usage credentials and blocks new requests, grants and membership/account-state changes. Already-dispatched requests still save results and settle idempotently under original snapshots. Logging in again under the same identity does not create a replacement account or replenish allowance.

Administrators restore an original account from Accounts and Members → Archived. Restoration returns it to disabled state, does not restore revoked members or credentials and does not reset allowance. Re-enable and log in again to use it; a removed or expired plan requires a valid grant. The legacy `deleted` marker is not revived through restoration.

- List: `GET /admin/api/usage/accounts?view=current|archived`, default `current`, with existing pagination. Client account lists omit archived accounts.
- Archive: existing `DELETE /admin/api/usage/accounts/:id` and preview, requiring a disabled account, current revision and `request_key`.
- Restore: `POST /admin/api/usage/accounts/:id/restore` with `expected_revision` and `request_key`, requiring administrator `usage:write`.
- Both operations replay the original receipt idempotently without overriding later management decisions.

These administration changes add no tables or SQL migration and independently require no SDK/DSH changes.

## Manually resetting one account's allowance

Under Account Usage → Usage Details → Reset Allowance, administrators with `usage:write` and `usage:adjust` can reset an active account's effective Hub-managed plan. A periodic plan regains its original period allowance (100%) and starts a new period at the server-confirmed reset time. A credit pack regains original Credits without an automatic reset date. Remaining balances do not stack and expiration is not extended. If expiration ends the final period first, no later reset date is shown.

- `POST /admin/api/usage/billing/accounts/:id/reset` requires `request_key` and the current grant's `expected_revision`.
- Future, expired or suspended grants and disabled/archived accounts cannot reset. Backend-managed allowance must be adjusted by its owning source.
- A new current grant reuses the existing allowance terms and pool mechanism. Template price changes do not change its restored amount; service selection and the current multiplier keep their existing rules.
- Original grants, requests, usage and ledger remain. Late results from already-dispatched requests settle against the original pool without charging the new allowance. Undispatched old requests retain their original grant-revision checks and do not automatically re-dispatch.
- Idempotent replay returns the original receipt. Revision checks prevent duplicate concurrent resets. The receipt records `reset.previousGrantId`, `reset.actor` and `reset.at` to identify the original grant and operator.

Existing summaries return the new balance and next reset date. This feature adds no SQL migration and independently requires no SDK/DSH or backend changes.
