# Next BailingHub release: use several business systems in one conversation

> **Unreleased source; no new installation package has been published.** The comparison baseline is Core 0.6.1, SDK 0.4.0 and DSH 0.4.0. The planned pairing is Core 0.7.0, SDK 0.5.0 and DSH 0.5.0, subject to final release checks. Existing installation commands do not deliver the additions below.
> [简体中文](RELEASE_NOTES_NEXT.md)

Suppose you have connected a shop and an inventory system. You want to ask:

> “Check how many tumblers are in stock. If any are available, change the corresponding shop product's price to 59 and list it. If none are available, leave it unlisted.”

The 0.6 release pairing already supports several accounts from one system in a conversation. This extension follows that direction: explicitly select authorizations from several systems on the same Hub, discover their tools as needed, and use the appropriate authority for each action while keeping a connected visible conversation.

This is an illustrative integration, with a confirmed mapping between the two products. The inventory system must expose stock lookup; the shop must expose price updates and product listing. BailingHub does not supply these business functions. Actual account permissions and approval rules continue to apply.

| Part of the request | Responsible system | What to check |
| --- | --- | --- |
| Look up stock | Inventory, using the selected inventory authorization | The actual product and returned quantity |
| Change the price if stock exists | Shop, using the selected shop authorization | The corresponding product's stored price |
| List the product | Shop, retaining its listing permission and approval rules | The result, pending approval or failure |

A successful price change followed by a pending listing approval is not “all done.” Administrators can inspect each original action from the conversation. Stock lookup is a point-in-time observation, not a stock reservation or automatic synchronization between systems.

## What changes and which problems it solves

### New: select several systems and use the right authorization for each step

The Agent uses inventory tools to check stock and shop tools to update the price and listing. Even if both systems call a tool “find product,” their calls retain separate ownership.

If a turn only asks the current shop price, selection alone does not send the full input to inventory, load its business context or mark it as executed. Unselected systems cannot be added implicitly. The first message freezes the scope; changing it requires a new conversation. Existing conversations never expand automatically.

### New: understand a system before searching its tools

A shop usually handles product presentation, online selling and promotions; inventory handles stock and movements. Administrators can maintain the system name, purpose, typical business areas and boundaries. Compatible clients provide the selected systems' descriptions before the first capability search, without a hard-coded product dictionary in every client.

Descriptions explain purpose, not permission. Actual actions still require authorized discovery. “Not loaded” means tools have not yet been requested. Reading descriptions creates no business run.

### New: show the actual business subject after authorization

After approving access to “Brand flagship store,” a compatible client can display “Shop system · Brand flagship store.” The business backend reads the name from the confirmed subject and supplies it through Core, SDK and the plugin.

Authorization subject display is generic: it can describe an organization, account, project, workspace or store. It is separate from system purpose. Duplicate names do not merge identities, and renames do not replace authorizations or rewrite conversation history. Missing names are explicitly pending; the backend can update an existing authorization's name.

### Improved: configure local Agent access from one entry point

Use **Agent Clients → Setup** for the authorization entry, system description, tools and approvals, and connection checks. The tool directory explains each action, its read/write type and configuration status.

These settings still belong to the original client application and route; no duplicate registration is required. Advanced route permissions remain available. Centralized setup neither enables every write operation nor removes business-required approval.

### New: let a business backend find and manage its authorizations

When a shop operator is disabled, the backend can find the relevant Agent Sessions and withdraw their access to product lookup, price changes or listing. Consumed authorizations now link to the resulting Session; an application can list its own Sessions and revoke access by original authorization.

The business backend must connect these APIs to its account, tenant and permission lifecycle. Core does not automatically subscribe to those events. Queries are limited to the owning application and return no access credentials.

### Extended: trace a conversation to actions in different systems

Complete visible conversation archives already exist in 0.6. This extension adds cross-system member and execution bindings. Administrators can follow stock lookup, price changes and listing to each system's original authorization and run.

Pending or failed actions must not be reported as completed. Archive recovery resends saved records without repeating business writes; known missing original text remains visibly incomplete.

## Who should prepare an upgrade

| Role | Required or optional work |
| --- | --- |
| Hub administrator | Upgrade Core and apply new migrations; add system descriptions and access configuration as needed. |
| DSH user | Use the matched plugin and its exact SDK dependency; authorize each target and select the new conversation's scope before its first message. |
| Custom client developer | Upgrade SDK/DSH host dependencies and check target selection, scope restoration, storage and display. A package replacement does not implement a custom UI automatically. |
| Business backend developer | Existing actions remain unchanged. To provide names, use the updated business SDK or API; to withdraw access proactively, integrate session lookup and revocation. |
| Existing same-system user | Keep the existing flow and original scopes; descriptions and names are optional additions. |
| Web chat, Client API or other adapter user | No requirement to adopt a DSH client. Assess Core upgrades for the integration actually used. |

## Upgrade preparation

Stable installations retain the published pairing above. Source integration requires matched Core, SDK and DSH commits. The plugin lockfile still resolves the released SDK, so cloning the plugin alone does not enable all new capabilities.

Release order is Core → SDK → DSH. Only after the new SDK is publicly installable may DSH change its exact dependency and generate the registry lockfile. See [operations](OPERATIONS.en.md) and [DSH compatibility](https://github.com/bailinghub/bailinghub-dsh-plugin/blob/main/docs/COMPATIBILITY.md).

1. Back up the database and preserve the old deployment, configuration, original scopes, visible events and pending archive records.
2. Upgrade Core first. Relative to 0.6.1, migrations 058 add cross-system member bindings and 059 add subject display. Use the official migrator to apply every unapplied migration according to its ledger. Older installations may also need earlier files. Migration 059 does not guess or backfill names.
3. Upgrade the matched SDK and client. Custom stores must retain full cross-system bindings, original Session identities, events and revisions; today's authorization list cannot reconstruct old conversations. Custom Core hosts also need the new optional repository capabilities documented in the integration contracts.
4. Add system descriptions and business-supplied names as needed. Update an original valid authorization's name without replacing its connection or identity.
5. In a new test conversation, select two systems, perform an allowed query and a permitted low-risk action, and inspect the target, business result and original execution association. Approval-required actions must still enter the original approval flow.

Also check that a single selected system cannot access another, duplicate names and renames preserve identity, reopening restores the original scope, and archive-only retry never repeats writes.

For rollback, retain new database fields and client records and follow the relevant operations guide. Older clients cannot use the new cross-system scope. Report unsupported combinations; do not erase records or widen authorization to continue.

## Limits

- One Hub and administrator audit domain, with a distinct original Agent Session for each target. Cross-Hub scopes and several selected routes sharing one Session are unsupported.
- The Agent plans steps. This is not a durable workflow scheduler, distributed transaction, automatic rollback or cross-process business task recovery engine.
- Matching product names or IDs across systems are not identity evidence. Use confirmed mappings or explicit user identification.
- Queried business results enter the local conversation; visible text is archived in the administrator audit domain. This is not automatic redaction or a field-level sharing policy. Choose information appropriate for the shared context.
- Missing metadata or unsupported old versions remain explicit. They do not prove loaded tools or authorize switching to a default connection.

## Further reading

- [Four-step local Agent setup](LOCAL_AGENT_SETUP.en.md)
- [Authorization subject display](AGENT_SUBJECT_DISPLAY.en.md)
- [Authorization and revocation API](AGENT_AUTH_API.en.md)
- [Cross-system client integration](https://github.com/bailinghub/bailinghub-dsh-plugin/blob/main/docs/CROSS_SYSTEM_CONVERSATIONS.md)
- [Visible conversation and execution associations](AGENT_CONVERSATION_AUDIT.en.md)

ACC, independent adapters and business systems retain their own release boundaries.
