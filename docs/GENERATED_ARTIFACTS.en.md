# Local Agent attachment space: bring generated outputs into business workflows

This is an unreleased, image-first extension. The stable Core 0.7.0 and SDK/DSH 0.5.0 packages do not include it. Use matching candidate sources and an adapted host.

A local Agent can generate useful content, but another application usually cannot read a path on that computer. The attachment space connects an approved conversation image to a URL: the host registers it, the Agent selects its reference and authorization, and BailingHub stores it using the operator's configured storage.

Examples include campaign artwork for a content platform, PNG charts for a reporting system, and pictures for an online shop. The receiving application must already provide the relevant URL-based business action. The image generator remains a host choice.

## What the first increment provides

- A host-managed catalog of approved images for the original conversation.
- PNG, JPEG and WebP uploads, up to 6 MiB per image; DSH batches contain 1–8 images. Administrators can lower the size limit or restrict MIME types.
- Explicit destination authorization and per-image ready, pending or blocked results.
- Original upload receipt recovery after an uncertain response or a reopened conversation.
- Ordinary COS, OSS or explicitly configured server-local storage. Returned URLs are publicly readable. Retention is managed by the deployment, without automatic conversation-expiry deletion.

The first increment does not accept documents or video. Hosts supply permitted file bytes; BailingHub cannot read the client's filesystem. Enabling the SDK does not automatically grant file access to every MCP application.

## Upload and use are separate steps

Generate an image → register it in the conversation catalog → upload → receive a ready URL. Attachment delivery is complete at that point.

Use a ready URL directly with an existing business tool. Repeated receipt lookup is only needed for upload recovery, not for every use of the image. A business change keeps its own authorization, approvals and outcome. For example, a shop gallery update should wait for all required images and preserve any existing images the user did not ask to remove.

## Configure and integrate

1. Register a storage entry with its bucket, region, credentials, public address and write prefix.
2. In Agent Clients → Setup → Tools and approvals, choose the workspace, enable the current image-upload setting and select that storage.
3. Install matching Core, Agent Client SDK and DSH packages. SDK hosts supply bytes and retain original upload identities. DSH hosts supply artifactSource and a durable artifactStore.
4. Apply outstanding Core migrations, including sql/060_agent_artifacts.sql. Existing URL-based business APIs need no change for attachment delivery.

The existing APIs remain uploadArtifact/getArtifact in the SDK and list_generated_artifacts/upload_generated_artifacts in DSH. Naming the user-facing feature an attachment space does not rename these compatible technical interfaces.

The [configuration and HTTP contract](GENERATED_ARTIFACTS.md) includes exact metadata, original-target validation and error handling.

## Known issues tracked separately

The matching candidate adds [configurable tool limits and original-invocation recovery](TOOL_RATE_LIMITS.md). Hour/day windows retain their original duration; newly recorded pre-dispatch rejections retain encrypted arguments. Uncertain writes are never replayed, and missing arguments from historical calls are never reconstructed. Ready attachment URLs remain reusable independently.

DSH may simplify some artifact-list source errors to unknown_failure; hosts should preserve their own storage_error and recovery_gap diagnostics. Per-image upload results remain separate.
