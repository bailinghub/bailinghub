# Upgrade Core from v0.10.1 to v0.11.1

[简体中文](UPGRADE_v0.11.1.md)

## Update Core

1. Record the current image digest or npm version, configuration and data volumes. Use your usual maintenance procedure to stop admitting tasks, drain accepted work, and retain the previous artifact and a restorable backup of persistent data.
2. Update the image or source checkout to the `v0.11.1` release, or pin an embedding host to `bailinghub@0.11.1`. Upgrading from 0.10.1 requires no new SQL migration. For older versions, check the migration instructions for each intervening release.
3. Confirm that `/health/ready` returns 200 before resuming admission. Hosts can read the model window and diagnostic through their existing catalog and receipt APIs. Existing business authorization and model output budgets continue to apply. [Operations](OPERATIONS.en.md)

## Verify image identity

For a Docker deployment, inspect `ghcr.io/bailinghub/bailinghub:0.11.1` with `docker buildx imagetools inspect`. Find the digest beside the `linux/amd64` platform. It should match the manifest digest shown when inspecting the same version on the Aliyun ACR registry used in your Compose file. The top-level GHCR digest covers the complete index, including the build attestation. Repeat this check for `bailing-demo-business` if you use the demo. A deployment using the 0.11.0 GHCR image can follow the same steps.

## Check existing records

| Action | Expected result |
| --- | --- |
| Open a conversation with recorded messages under Tasks → Conversations. | The view identifies the channel and message roles and opens at the latest message. Follow an associated task to its trace when available. |
| Filter dispatches by a failure status and a known route. | Only matching tasks appear. Focus the status label with the keyboard to see its raw value. |
| Select a credential and invocation model in model service settings. | A supported route shows the verified window. For an unknown route, enter a verified value manually or save the new service as inactive. |
| Read `GET /usage/v1/model/models` using an account entitled to the service. | Match `service_id` and check `context_window_tokens`, the service revision and the existing output budget. The window covers input and output combined. Older registrations may return `null`. |

To support recovery of long conversations, test the host against a synthetic `CONTEXT_WINDOW_EXCEEDED` receipt. The host persists a compaction checkpoint and allocates a new operation ID for the shortened request. If the final receipt is missing, look up the original operation first. [Model continuation](MODEL_CONTINUATION.en.md)

## Roll back

Stop admission and drain active work before restoring the previous application artifact. Preserve operations, authorizations and configuration revisions recorded during the upgrade. Existing read paths remain available to older hosts. Consumers of the new diagnostic should tolerate an absent field. Recheck readiness and an existing operation after restart. [Release notes](RELEASE_NOTES_v0.11.1.en.md)
