# Separating periodic plan price from allowance

This guide applies to Core 0.9.0 and explains periodic allowance terms and migration of existing billing snapshots. Public Core 0.8.0 did not include this billing module. Its normal upgrade adds 063/064 through the official migrator and requires no real-data purge. See the [v0.9.0 upgrade guide](UPGRADE_v0.9.0.en.md).

## Period allowance contract

Periodic plans require both `priceUsd > 0` (sale price) and `periodAllowanceUsd > 0` (USD available per period), with at most twelve decimal places and a maximum of 1,000,000,000. Credit packs continue to use `priceUsd` as allowance and reject `periodAllowanceUsd`. Unknown fields remain rejected. There is no fallback to sale price, legacy field alias, turn limit or request-count limit.

For example, a weekly plan selling for 100 USD with a 20 USD allowance has 10 USD / 50% remaining after a 10 USD charge and regains 20 USD in the next week. A final partial week still receives the full allowance; expiration blocks new requests. Late settlement belongs to the original period, with its original multiplier, price and pool. Template edits affect future grant terms and do not automatically re-grant existing accounts.

`GET /admin/api/usage/billing/plans` provides `period_allowance_supported: true`. Without this marker, the frontend may preview the field but cannot save periodic plans. The marker describes code capability, not proof of database migration; verify the migration ledger and billing-structure readiness as well.

## Instances that already deployed a billing preview

These data checks apply only when 063 billing data already exists and periodic snapshots lack the new field. Separate cleanup of abandoned test schemas is outside this process and must not be applied to real customer data.

1. Coordinate all Core instances, frontends and plan writers sharing the state database on the new contract. Back up billing tables and migration ledger and retain previous artifacts. Stop old-version writes, including maintenance settlement and backend grant/control calls. Retain original IDs and evidence for dispatched requests; do not dispatch replacements.
2. Apply the outstanding `064_period_plan_allowance.sql` through the official Core schema migrator (`npm run db:init` for source installations), keeping its ledger and checksum checks.
3. Each periodic record missing the field receives its own original `priceUsd`, not the current template price. This covers plan `config_json`, grant snapshot `config_json`, request `grant_json` and grant/control replay `result_json.config`, including history. Original allowance semantics and cached request hashes remain unchanged. Explicit new allowances are never overwritten; credit packs are untouched. Original pools, ledger, charges, revisions and expiration are not rewritten.
4. Confirm positive new fields in all four periodic JSON forms and no new field on credit packs. Compare record counts, original prices, pool allowances and ledger amounts. Start the new Core and UI, then check capability discovery, historical summaries, original-ID lookup and idempotent replay. Runtime does not infer missing fields; do not start it expecting automatic compatibility.
5. Edit templates explicitly for later price or allowance changes. New terms apply to future grants; template edits are not migration of original grants. Use the normal provisioning flow if a new grant is needed.

The SQL converts only missing fields and retains explicit allowances. After interruption, keep writers stopped until the official migrator completes and checks pass. Do not manually change the migration ledger or replay recorded files.

## Rollback and verification

Once the new fields exist, old Core's strict validation cannot read those configurations. Rollback requires stopped writers and coordinated backup/artifact restoration. If new requests or charges exist, retain them and repair forward instead of discarding the ledger through an older backup.

Check positive values and precision, rejection of periodic fields on credits, percentage calculations, month-end rules, independence of template edits and original snapshots, period renewal, late original-period settlement, final partial periods and expiration. Migration checks include differing template/grant amounts, original-request settlement, replay of original idempotency keys and preservation of explicit new allowances.

[Model billing contract](MODEL_BILLING.en.md) · [简体中文](PERIOD_ALLOWANCE_UPGRADE.md)
