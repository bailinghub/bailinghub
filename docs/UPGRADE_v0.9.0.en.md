# v0.9.0 model billing: paired upgrade guide

Upgrade public Core 0.8.0 / SDK 0.6.0 / DSH 0.6.0 to Core 0.9.0 / SDK 0.7.0 / DSH 0.7.0. Verify versions, Tags and artifact digests when downloading or deploying, and retain original configuration and durable records.

## Choose what to enable

| Need | Console and Core | Host or business backend |
| --- | --- | --- |
| Retain business tools, approvals and long tasks | Upgrade Core and retain configuration/state | Existing workflows continue without enabling model billing |
| Offer a shared model plan | Configure provider connections, reference mappings and USD plans; grant accounts access | Hosts adopt discovery, model catalogs and summaries; trusted backends provide plan-scoped identity when needed |
| Generate images from a local assistant | Configure a supported adapter and price, then include it in the plan | Adopt tool discovery, durable original requests and asynchronous lookup; using images in business data remains a separate action |
| Provision plans from the business application | Configure source ownership and permissions | Trusted backends use external billing APIs with idempotency keys; payment, currency conversion and refunds remain application responsibilities |
| Remove/restore accounts or manually reset allowance | Administrators act under the required permissions and account state | Existing summaries suffice; these management features do not independently require SDK/DSH or backend changes |

## Backup and migration

Retain the database, instance configuration and keys, object storage, previous artifacts, and host credentials, sessions and durable records. Coordinate all Core instances and writers sharing the state database. Preserve IDs and evidence for dispatched requests; do not replace recovery with another request.

From public 0.8.0, apply all outstanding files through the official migrator (`npm run db:init` for source installations), then start the new Core. Startup does not migrate implicitly.

| Added file | Purpose |
| --- | --- |
| `063_usage_model_billing.sql` | Creates 14 model-billing tables for identity, accounts, services, USD plans, original requests, ledger and reference-price cache |
| `064_period_plan_allowance.sql` | Fills missing periodic allowances from each existing configuration/snapshot's own original allowance; empty fresh billing tables have nothing to backfill |

Migration retains existing business and real customer data. Public 0.8.0 did not include this billing module and requires no old-schema purge or table clearing. Incompatible abandoned schemas from unpublished test instances require separate maintenance; their cleanup must not become customer upgrade instructions or public migrations.

Instances that already deployed the 063 billing preview must follow the [period allowance guide](PERIOD_ALLOWANCE_UPGRADE.en.md): stop old writers, apply 064, verify original snapshots and ledger, then start the new runtime. The migrator skips recorded files; do not manually alter its ledger or replay applied SQL. Older public versions also need their outstanding preceding migrations.

## Configuration and host integration

1. **Model service:** configure actual credentials, URL and model identifier, with `chat` or `tool` purpose. Explicitly bind an OpenRouter reference model and endpoint; confirm that its metering maps to the actual service. The quote is not the provider's paid cost.
2. **Plan:** use USD and one multiplier. Periodic plans require both sale price and period allowance; credit packs use only the one-time allowance. Set validity, day/week/month period and services before granting a test account.
3. **Discovery:** inspect `model_gateway` in `GET /usage/v1/capabilities`. Use ready `items`; show configuration reasons from `unavailable_items`. Missing support stays explicit and must not trigger an automatic model switch.
4. **Identity and persistence:** trusted backends explicitly exchange `model_access: token_gateway` when plan-wide scope is needed. Single-model `service` scope remains restricted. Persist every original `operation_id` locally and query that request after reopening. Provider credentials must not be passed to browsers or models.
5. **Results and allowance:** handle `result_state`, `billing_state` and summary `presentation` separately. Complete results are usable; missing actual usage stays pending settlement. Display Credits or percentage from the summary, not inferred Token balances. Percentage strings may be rounded down; precise numeric values and display strings are separate fields.

Verify the actual installed and resolved SDK/DSH pairing, including packaged host dependencies. Changing a version declaration does not implement host UI, persistence or execution integration. Hosts that do not enable the gateway retain their existing business contract.

## Acceptance after enablement

- A test account discovers its ready models and tools; unavailable entries explain their state and no provider credentials enter catalogs.
- With explicit sale price, allowance and multiplier, check one controlled request's actual usage, reference cost, billed amount and presentation. Image services without Tokens leave them absent.
- Original-ID lookup and same-content replay do not dispatch again. Known failures, unknown outcomes, cancellation and pending settlement remain distinct. Expired results do not trigger regeneration.
- Plan edits preserve original grant allowances. Archiving blocks new use and restoration does not replenish allowance. A reset retains expiration, and already-dispatched requests settle against their original pool. Check only the administrative actions being enabled.
- Verify artifacts, migration ledger and client versions while retaining approvals, original-call rules and task restrictions.

Video/voice declarations are not execution acceptance. Current image adapters do not implement provider-task recovery through a provider task ID; original-ID lookup reads the Hub's persisted result.

## Rollback

Once new structures and snapshots exist, do not assume an older version can read or enforce them correctly. Stop new dispatches, inspect original in-flight requests and settlement, and retain ledger and rollback evidence. Restoring an older backup also requires accounting for subsequent requests and business effects. Do not roll back by dropping tables, discarding ledger entries or resending operations. Existing 0.8.0 task-enforcement markers still require compatible runtimes.

[Release notes](RELEASE_NOTES_v0.9.0.en.md) · [Complete billing contract](MODEL_BILLING.en.md) · [简体中文](UPGRADE_v0.9.0.md)
