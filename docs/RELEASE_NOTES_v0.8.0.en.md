# v0.8.0 BailingHub release: continue and control longer business tasks

Release 0.8.0. Pairing: Core 0.8.0 / Agent Client SDK 0.6.0 / DSH 0.6.0. Changes below are relative to the preceding public release.

Maintaining a shop catalog may involve checking inventory, producing images, editing products and waiting for approval. This update connects those steps with clearer discovery, original-call recovery and task controls. Multi-system authorization, subject display names and visible conversation archives were already available in the preceding release.

## What changes

**Task-wide budgets and controls.** Administrators can fix a task's authorized members, allowed tools, cumulative write-call budget, concurrent permit limit and optional deadline under Agent Clients → Task Control. A new message, tool search or host restart does not reset its budget. A batch operation affecting 20 products counts as one invocation, not 20 objects; a business rejection with a trustworthy response may also consume the write budget. Reads use concurrent permits but not the write budget. Original permissions and per-call approvals remain in force.

Pause blocks subsequent dispatch permits; already permitted work may finish. Continuing a task does not increase its budget or automatically continue an invocation. Cancelling prevents further dispatch and does not roll back completed changes.

**Inspect without executing.** A product listing can be approved without having been dispatched. A new read-only receipt keeps result, approval and dispatch facts separate. Refreshing it never submits the listing. Explicit continuation retains the original identity, parameters, run and invocation ID. An uncertain dispatched write is inspected rather than replaced. The paired DSH offers durable original-call recovery and panel APIs that work without an active model turn; hosts implement their own UI.

**Configurable tool limits.** Tool Providers → Edit → Governance supports inherited, custom or disabled Hub per-tool limits, including individual overrides. Provider-wide, per-tool and client-app gates remain separate. Hour/day limits keep their original windows. The same provider/tool shares its counter across users and conversations. SDK/DSH preserve retry guidance and original invocation recovery without asking the model to reconstruct write arguments.

**Local Agent attachment space, image-first.** An adapted host can register generated images or images explicitly selected by the user for business use. The Agent uploads them to operator-configured COS, OSS or explicit local storage and receives URLs for existing business tools—for example, a campaign cover or shop product image. PNG/JPEG/WebP, up to 6 MiB each and 1–8 images per DSH batch, are supported. Successful URLs are reusable; upload and business-action outcomes are separate. Chat attachments are not uploaded automatically. The host owns file access and image generation; the business system supplies the action accepting the URL.

Uploads are disabled by default. Configure storage under Agent Clients → Connection Configuration → Tools and Approval → Generated Image Upload. Images are publicly readable in this first phase. Operators manage retention; ending a conversation does not automatically delete objects.

**Clearer discovery and longer tool use.** Returned candidates, loaded tools and authorization-filtered catalog counts have separate meanings; unknown totals stay unknown. Ranked discovery is not exhaustive pagination. Paired DSH retains valid tools across searches within a turn. Adapted hosts can opt into declaration reuse across turns of the same living Session. Current target preparation, identity, permission and revision checks still apply.

## Who should upgrade

| Role | Action |
| --- | --- |
| Hub operator | Upgrade Core, apply unapplied migrations 060–062 and configure optional storage, rate policies and tasks |
| Client host developer | Upgrade the paired SDK/DSH, persistent stores and public task/receipt APIs; explicitly opt into cross-turn reuse |
| Business backend developer | Retain current declarations, authorization, approval and APIs; image use requires an existing URL interface or a separate business import operation |
| Plugin user | Use an adapted host; installing a package alone grants neither file access nor administrative permissions |

## Upgrade and boundaries

Follow the [paired upgrade guide](UPGRADE_v0.8.0.en.md). Migrations add attachment receipts, rate-limit policies and task records. Use the official migration ledger and retain configuration, encryption material, object storage and host records.

Task enrollment creates a persistent requirement on each original Agent Session, including its other conversations. Cancellation does not remove that requirement. Check every relevant host before enrolling dedicated test authorizations. Do not downgrade an enrolled deployment to a Core that does not enforce this marker.

The same-Hub, same-audit-domain boundary remains. This is not cross-system transactions, automatic product mapping, full-plan restart, automatic reconciliation of uncertain writes or business rollback. Documents, video and drive management are outside the first attachment release.

Component regression, synthetic integration and bounded client acceptance have been completed. Verify the release Tag and actual package provenance when upgrading. Windows device testing and actual user clicks in the latest panel are not covered by this acceptance; no general model reliability or production-adoption claim is made.
