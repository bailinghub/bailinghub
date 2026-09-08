# BailingHub v0.6.0: Follow the Conversation Through Its Business Actions

A conversation may query account A and then update account B. Previously, administrators had to inspect separate execution records to find out what each account did. With a compatible client, they can now read the conversation first, then follow it into the original actions and approvals.

## What changes for users

- **Read the conversation in one place**: Tasks → Conversations adds a client-conversation view with synchronized user requests, intermediate explanations and final replies grouped by turn.
- **Follow a reply into its actions**: expand each account's original execution record to inspect calls, approvals and results. The existing authorization-scoped view remains available.
- **Keep account choices visible**: with the new SDK and DSH plugin, select accounts A and B from the same business system before chatting. The agent chooses the appropriate authorization for each action; identities, approvals and memory remain separate.
- **Recognize missing records**: business completion and transcript synchronization have separate status. Clients can upload saved events after reconnecting, and a lost acknowledgement does not duplicate them. Missing original text is reported as a gap rather than replaced with an execution summary.

Start with the [user guide](user-guide/conversations.en.md). Client developers can continue with the [integration contract](AGENT_CONVERSATION_AUDIT.en.md).

## Who should upgrade

| How you use BailingHub | What to prepare |
|---|---|
| You operate a Hub and want full local-agent conversations in its console | Upgrade Core to0.6.0, apply the new migration, and use a client that synchronizes visible conversations. |
| You use DeepSeek Harness with several business accounts | Install the separate `dsh-bailinghub@0.4.0` package, which pins `bailinghub-mcp-server@0.4.0`. Authorize each account and select the conversation scope before the first message. |
| You build a desktop or other agent client | Use Agent Client SDK0.4.0 and integrate scope, original visible history, durable capture and status. Changing a dependency version alone does not complete host integration. |
| You use web chat, Client API, Dify/n8n tasks or static MCP | Existing entry points remain usable without a new local client. Other adapters retain their independent release cycles. |

Prepare Core first, then the SDK and client. Upgrading Core alone cannot make older clients send their missing text; updating a plugin cannot add archive APIs to an older Core. Multi-account scope currently covers one business system and workspace, not cross-system or cross-route orchestration.

## Upgrade an existing deployment

1. Back up the database and retain the previous code or images, following the [operations guide](OPERATIONS.en.md).
2. Use the exact `v0.6.0` code or images. Run migrations from one deployment step: `sql/057_agent_conversation_audit.sql` adds three archive tables without rewriting previous migrations. Runtime startup does not apply it automatically.
3. Start the new version, check `/health/ready`, and open Tasks → Conversations. Verify new client text and its links to original execution records.
4. Upgrade clients using their SDK/plugin migration instructions. **A new conversation without selected authorizations is ordinary chat.** Scope becomes fixed with the first message; start a new conversation to change it. Reopening restores only the original authorizations.
5. With test data, check same-runtime recovery after reopening offline, whole-scope blocking after revocation, and cancellation without reactivating ended actions. Never repeat business writes merely to repair an archive.

When reverting code, retain the new tables and pending client events. Existing clients can use their original APIs; a client encountering an older Core should report the unsupported archive without discarding its original records.

## Permissions and recording boundaries

Full text is readable by administrators with task-read permission in the current Hub administration audit domain. There is no Agent read endpoint for the combined transcript, and combined replies do not flow back into each account's model memory. Business permissions, approvals and final checks remain with their original owners.

The archive covers visible client text and original execution links, not hidden reasoning, attachments or arbitrary local tool output. It cannot reconstruct text that was never saved, nor can scope restoration recover lost business tasks across process restarts. Existing business declarations, business-side SDKs and approval rules require no change for this archive feature.

ACC, ecosystem adapters, independent clients and hosted deployments remain separate projects; they are not bundled into Core or automatically upgraded by this release.

## Verification and further reading

The release commit must pass `npm run release:check`, covering permissions, membership, event idempotency, run links, console behavior, existing Client API/SDK compatibility, security and artifact boundaries. Client regressions additionally cover offline recovery, local storage failure and cancellation races. These checks use public tests or isolated synthetic data, not production-adoption evidence.

- [User guide](user-guide/conversations.en.md)
- [Client integration guide](AGENT_CLIENT_QUICKSTART.en.md)
- [Conversation archive API](AGENT_CONVERSATION_AUDIT.en.md)
- [SDK and plugin compatibility](https://github.com/bailinghub/bailinghub-dsh-plugin/blob/main/docs/COMPATIBILITY.md)
- [中文发布说明](RELEASE_NOTES_v0.6.0.md)
