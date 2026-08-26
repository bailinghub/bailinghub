# BailingHub v0.5.0: Revocable Local-Agent Authorization and Governed Local Planning

`v0.5.0` adds Agent Auth v1 and Agent Client Runtime v1. A local Agent may now own understanding, planning, and multi-step tool selection while BailingHub continues to own revocable business identity, route and capability filtering, approvals, idempotency, business invocation, recovery, audit, and the visible conversation ledger. These are optional additive surfaces; they do not replace `/run`, chat entries, or the executor protocol.

## Main changes

- **Agent Auth v1**: a local SDK starts browser authorization with PKCE S256 and a locked loopback callback. The business system continues to use its own authenticated session, user/tenant/role model, and permission tables when deciding whether to approve.
- **Revocable Agent Sessions**: access tokens are short-lived, refresh tokens rotate, and replay of an old refresh token fails closed. Core stores only SHA-256 token digests and supports user denial, local revocation, and business-backend session revocation.
- **Agent Client Runtime v1**: adds workspace discovery, bounded bootstrap, turn snapshots, authorized capability search, governed tool invocation, and visible completion reporting. Prompts, memory, knowledge, and capability configuration remain centrally managed by Core while planning runs locally.
- **Exact capability and approval semantics**: an effective workspace is the intersection of the client, Agent Session, route audience, and `tools.agent_direct` policies. `write_tools` explicitly exposes writable operation IDs. Approval continues to inherit business-side ACC by default, while `force_approval_tools` may only tighten the policy.
- **Visible conversation and governance trace**: user messages, visible final answers, tool requests, and governance outcomes enter the Core ledger. Hidden reasoning is neither accepted, synchronized, nor persisted.
- **Business-side SDKs**: both the PHP 8.1+ and PHP 7.3-compatible SDKs provide the same server-side `AgentAuth` thin client for context, approve, deny, and session revoke. Non-PHP systems may implement the same HTTP contract directly.
- **Console configuration**: the route page configures `tools.agent_direct` structurally and reads operation ID, scope, read-only status, and ACC approval metadata from the selected tool provider. Writable-tool allowlists cannot use `*`.

## Security and responsibility boundaries

- The authorization page belongs to the business system. The BailingHub SDK provides server-side methods; it does not inject a universal UI or replace business login and final authorization.
- The Client Token is supplied only to the business backend. It must not enter browser JavaScript, URLs, local-plugin settings, logs, or screenshots. The local Agent also receives no Tool Provider Secret, business password, cookie, business API address, or model key.
- Agent Auth binds revocable business identity, device, and routes. It carries no plan, payment, entitlement, or usage semantics.
- Tool invocation still revalidates the session and policy in BailingHub and follows the existing idempotency, approval, uncertain-outcome freezing, and audit paths. Every business tool endpoint must still verify the request signature and current business permission.
- Host plugins, the generic Agent SDK/MCP package, and model providers are not bundled with BailingHub Core. Install them independently according to their public compatibility matrices.

## Compatibility and upgrade

- This release adds `055_agent_auth.sql` and `056_agent_client_runtime.sql`. Back up the state database, upgrade code or images, run `npm run db:init`, and start or switch traffic only after every pending migration succeeds. Never edit an applied migration or copy a state database from another instance.
- Agent Auth v1 and Agent Client Runtime v1 are additive. Existing `/run`, chat entries, Client API v1, Kernel Host API v1, Executor Protocol, ACC, tickets, tool signatures, and final business authorization remain compatible.
- Deployments that do not use Agent Client need no authorization page or `tools.agent_direct` configuration. Existing chat-entry and executor flows keep their original behavior.
- The early private-candidate `unattended_write_tools` field remains read-compatible only. New configuration uses `force_approval_tools`; migrate it with the set-difference rule documented by the public Runtime contract.

## Validation

The stable release gate requires the complete `npm run release:check`, type checks, focused Core and Agent Auth/Runtime coverage, console builds, database migration checks, bilingual documentation, OSS-boundary and security scans, npm artifact consistency, and a clean-host acceptance flow using only public dependencies. That acceptance covers browser authorization, a read-only invocation, a reversible write, and conversation/trace inspection. Before publication, both source and actual package artifacts must also be checked for private domains, local paths, credentials, and local dependencies.

## Related documentation

- [Agent Client v1 Integration Guide](AGENT_CLIENT_QUICKSTART.en.md)
- [Agent Auth v1](AGENT_AUTH_API.en.md)
- [Agent Client Runtime v1](AGENT_CLIENT_RUNTIME_API.en.md)
- [Business-side PHP SDK](../sdk/php/README.md) / [PHP 7.3 SDK](../sdk/php7/README.md)
- [Compatibility and upgrade](COMPATIBILITY.en.md)
- [中文发布说明](RELEASE_NOTES_v0.5.0.md)
