# Use Multiple Accounts in One Conversation and Follow the Full Story

[简体中文](conversations.md) · [User guide](README.en.md)

If you manage stores A and B in the same business system, you can select both authorizations for a conversation, then let the agent use the appropriate account for each action. Stores are an example: these may be any two authorized accounts in the same system.

## What you need

Deploy **BailingHub 0.6.1** and use **dsh-bailinghub 0.4.0**, which depends on the independent **bailinghub-mcp-server 0.4.0** SDK. A custom client must integrate conversation scope, original visible history and archive APIs. Upgrading only the Hub does not make an older client upload a full transcript.

Your business system must already expose the operations you need, and you must authorize A and B separately. This upgrade does not require rewriting existing business capabilities or approval rules. Start with the [public Docker demo](../DEMO.en.md) to learn query, approval and execution; that demo does not replace client installation and account authorization.

## A complete session

1. **Start a conversation and select accounts.** Choose A and B in a compatible client's scope selector. Selecting only A permits only A; selecting nothing means ordinary chat. For DSH commands, follow the [plugin getting-started guide](https://github.com/bailinghub/bailinghub-dsh-plugin/blob/main/docs/GETTING_STARTED.md).
2. **Name the intended account in your request.** For example: “Check orders for A and B, but update the contact for A only.” The agent chooses within the selected scope; available actions still depend on the business system and current permissions.
3. **Follow existing approvals.** Distinguish completed, awaiting-approval and failed actions. A conversational reply alone does not prove business success; inspect the original call or business result when needed.
4. **Follow the conversation into each action.** A Hub administrator opens **Tasks → Conversations → Client conversations**, reads each turn, then opens the original account's calls and approvals. The authorization-scoped records remain available separately.

The account selection is fixed after the first message. Start a new conversation to change it. Reopening an existing conversation restores the original scope, never today's default or every registered account.

## When something goes wrong

| Situation | Meaning and next step |
|---|---|
| Pending synchronization | Business may already be complete. Reconnect and retry synchronization in the original conversation; do not repeat a write merely to repair its record. |
| Authorization cannot yet be verified | Business tools stay closed. Retry in the same session after reconnecting; every original account must pass verification before recovery. |
| An original account is revoked or its identity changes | The whole original scope stays blocked. The client does not silently fall back to the remaining account. |
| Local storage failure or a history gap | A saved prefix is not the full history. Display unsaved counts or missing history; never invent the missing text. |
| Unsupported version | Check the Hub, SDK and plugin versions. Existing business features do not automatically disappear because the optional archive is unsupported. |

“Synced” means the currently saved events were uploaded. A separate history-gap or unverified-history indication still matters. Archive recovery does not reconstruct lost business tasks or repeat business writes.

## Who can read it

Full text belongs to the deployed Hub's administration audit domain, readable by administrators with task-read permission. Account identities, approvals and memory remain separate; a combined reply is not copied into each account's model memory.

The archive currently covers visible text and original execution links, not hidden reasoning, attachments or arbitrary local tool output. Older records containing only execution summaries continue to identify missing transcript text.

See the [v0.6.1 upgrade notes](../RELEASE_NOTES_v0.6.1.en.md). Client developers can continue with the [integration guide](../AGENT_CLIENT_QUICKSTART.en.md) and [conversation archive API](../AGENT_CONVERSATION_AUDIT.en.md).
