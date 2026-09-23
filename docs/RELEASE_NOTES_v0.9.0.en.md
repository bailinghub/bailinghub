# BailingHub v0.9.0: model services and shared plan allowances

Release pairing: **Core 0.9.0 / MCP and Agent Client SDK 0.7.0 / DSH 0.7.0**. These notes describe changes and upgrade impact relative to public Core 0.8.0.

An enterprise assistant may select a conversation model, generate a campaign image and then call an authorized business API. Administrators can now give those models and generation tools a shared allowance. The local host continues to orchestrate the conversation and task; the Hub records original requests, actual usage and settlement. Existing business permissions and approvals still apply.

## An optional lightweight model billing gateway

Enable model billing when needed. Administrators configure a provider connection, actual model identifier, reference pricing model and endpoint, then grant a plan to a personal or shared organization account. Conversation models and model tools have separate discovery catalogs. Charges are not based on user turns or task steps.

The actual model identifier can differ from the reference catalog identifier; operators explicitly verify that mapping. OpenRouter supplies reference prices, **not the actual provider's paid price or invoice**. Each request retains its price and plan-multiplier snapshot, so later price changes do not recalculate history. Unready services stay out of callable catalog entries; hosts can show the reason and direct users to their administrator.

## One plan, one USD allowance

Every model and tool in a plan shares its USD allowance and a single multiplier. For example, an Enterprise Assistant monthly plan may sell for 300 USD and provide 100 USD per month at a 1.5 multiplier. A request with a 0.20 USD reference cost deducts 0.30 USD, leaving an actual allowance ratio of 99.70%.

- **Periodic plans** separate sale price `priceUsd` from per-period allowance `periodAllowanceUsd`. Daily, weekly or monthly resets restore that allowance; customers see a remaining percentage whose denominator is the allowance.
- **Credit packs** use `priceUsd` as the one-time USD allowance. Customers see Credits at a fixed 1000 Credits per USD, with no separate credit ledger.
- Validity and reset periods are independent. A final partial period still provides the full allowance; expiration stops new requests and unused allowance does not roll over. Template price edits do not reset existing grant terms; the current service set and unified multiplier are read from the plan.
- The business application owns payment, currency conversion, refunds and product pricing. Raw Token counts remain usage evidence, not plan limits or percentage denominators.

## Text-to-image tools and asynchronous settlement

Model tools declare their name, purpose, parameters and output; hosts choose and invoke them. Initial executable adapters support text-to-image through Aliyun's OpenAI Images-compatible API, native DashScope and OpenRouter Images. Video, voice and custom capabilities may be declared, but remain explicitly uncallable without an execution adapter. A saved declaration does not imply generation support.

Image requests persist dispatch evidence and finish asynchronously. Hosts query the original `operation_id`. A completed result can be used while billing awaits actual metering; missing reliable usage never becomes an invented fee or Token count. Positive balances admit requests; late concurrent settlements can create an overage, and depleted balances block new requests.

Connection loss, missing responses and unknown outcomes retain the original ID rather than creating another generation. Confirmed rejection and unknown results are distinct. Late usage after cancellation remains accountable and does not revive a finished turn. Hosts can reuse the existing attachment space for image URLs/Base64 when needed; generation does not automatically modify business data.

## Everyday administration

- Removing a plan preserves its identity, grants, allowance pools, requests and ledger. A plan still used by an effective grant requires its use relationship to be resolved first. Suspending a template only stops new grants.
- Disabled personal and shared accounts can be archived. Restoration returns the original account to disabled state; revoked credentials and members are not restored and allowance is not replenished.
- Authorized administrators can reset an active account's effective Hub-managed plan. Periodic plans regain their original period allowance with a new period anchor; credit packs regain their original Credits. Expiration is unchanged and original in-flight requests settle against their original pool.
- Console examples use generic business-assistant and enterprise-service descriptions suitable for different business systems.

## Upgrade impact and acceptance

From public Core 0.8.0, use the official migrator to apply `063_usage_model_billing.sql` and `064_period_plan_allowance.sql`, retaining existing data and the migration ledger. **Normal public-version upgrades require no real-data or test-data purge.** Instances that already deployed a billing preview separately follow the [period allowance guide](PERIOD_ALLOWANCE_UPGRADE.en.md) for original snapshots.

Hosts opt into model catalogs, tools, summaries and persistent original-request records. Business backends adopt provisioning or plan-scoped identity APIs only when needed. Existing business-tool deployments need not enable model billing. Identity, permissions, session scope, approvals, task controls and business-call archives remain independent.

Verify enabled service configuration, customer allowance display, actual usage, original-ID recovery and administration against the final matched artifacts. Automated checks do not establish provider, client or production acceptance.

[Paired upgrade guide](UPGRADE_v0.9.0.en.md) · [Model billing contract](MODEL_BILLING.en.md) · [简体中文](RELEASE_NOTES_v0.9.0.md)
