# Next release draft: Local Agent attachment space

Status: release preparation, not published. Relative to stable Core 0.7.0, the candidate adds attachment upload contracts and the accepted capability-discovery feedback improvements. Freeze final versions and matched installation commands during release verification.

A local Agent may generate campaign artwork or a chart, while the next application needs an image URL. This extension registers approved conversation images, stores them in operator-configured storage and returns URLs for existing business tools.

## Changes

- Add an image-first attachment space: PNG, JPEG, WebP, up to 6 MiB per image and 1–8 images per DSH batch. Keep explicit authorization targets, per-image results, ready URL reuse and original upload recovery.
- Reuse ordinary COS, OSS or explicitly configured local storage. The operator manages retention; workspace uploads are disabled by default.
- Clarify capability discovery: separate returned candidates from loaded tools, preserve unknown totals and describe replacement and original-execution associations.

Use cases include campaign covers, PNG charts for operational pages, or shop product images. The receiving business action must already exist; the host chooses the generator.

## Upgrade and verify

Administrators upgrade Core, apply outstanding migrations including 060 and 061, and select storage for the workspace. Client developers upgrade matched SDK/DSH packages and supply approved image sources plus durable recovery storage. Existing business APIs that accept image URLs need no change; systems requiring asset IDs use their own import capability.

Generate an image in an authorized conversation, register it, and verify a ready URL. Recovery should retain the original upload. Using the URL in a business action is a separate check with its own outcome and approvals.

The first increment accepts public images, not documents or video. The matching candidate fixes original-window counting and recovery for newly recorded pre-dispatch rejections; missing historical arguments remain unrecoverable. An upload success is not a claim that every business batch operation succeeds.

See the [attachment-space guide](GENERATED_ARTIFACTS.en.md).

## Batch-operation limits

The matching candidate adds [configurable tool limits](TOOL_RATE_LIMITS.md) under Tool providers → Edit → Governance: inherit declarations, customize count/window, or disable the Hub tool limit while keeping the provider total independent. Limits are shared per provider/tool, across users and conversations. Hour/day windows retain their original duration. Newly recorded pre-dispatch rejections resume encrypted original arguments; uncertain writes are never replayed. Apply migration 061. Existing configuration inherits declarations; missing historical arguments are not reconstructed.
