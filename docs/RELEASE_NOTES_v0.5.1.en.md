# BailingHub v0.5.1: Agent Client Management and Bulk Write-Operation Configuration

`v0.5.1` is a compatible management increment for the Agent Client v1 surface introduced in `v0.5.0`. It lets deployers inspect client applications, authorized devices and Agent Sessions, recent runtime statistics, and workspaces in one BailingHub console page, and bulk-select writable operations declared by current tool sources. Existing identity, approval, idempotency, business invocation, and final-authorization governance remains in force.

## Highlights

- **Dedicated management center**: the console adds an Agent Client menu backed by the existing Client App, route, Agent Auth, and Agent Client Runtime ledgers. It does not create another client or executor resource model.
- **Application and workspace overview**: shows client state, whether a neutral business authorization entry is configured, allowed routes, last use, and workspaces enabled for Agent Client access.
- **Session list and revocation**: filters Agent Sessions by client and active, expired, or revoked state. An administrator with client write permission may revoke one session, and the action is appended to the audit ledger.
- **Runtime statistics**: aggregates runs, conversations, completed and failed runs, tool calls, tokens, and approval states over a bounded time window. Failure rate is derived from Agent Runs already recorded by Core.
- **Bulk write-operation selection**: the route editor can select or clear all writable operationIds currently declared by selected tool sources. The persisted policy remains an exact operationId allowlist and never accepts `*`.
- **Neutral business authorization entry**: each Client App configures one account- and tenant-neutral `agent_authorize_url`. The business page uses its current login session to handle account switching, explicit tenant selection, approval, or denial, and the business backend derives the trusted identity.

## Security and Responsibility Boundaries

- The management APIs remain behind existing Core administrator permissions. Session projections do not select or return access-token hashes, refresh tokens, authorization codes, prompts, tool arguments, or business results.
- Bulk selection only removes repetitive console work. An operation remains unavailable unless the tool source declares it, the route exact allowlist contains it, and the Agent Session allows the route.
- Approval continues to inherit business-side ACC metadata and Core risk policy. `force_approval_tools` may only tighten approval; bulk selection cannot weaken it.
- The business system still verifies every tool request and checks the current user, tenant, role, and permissions. A BailingHub administrator does not replace final business authorization.
- `connectionName` is only a local host selector. It is not a trusted identity, business URL, account, or tenant declaration.

## Compatibility and Upgrade

- No SQL migration is added or modified. This release reuses the Agent Auth and Agent Client Runtime tables published in `v0.5.0`.
- Agent Client Runtime, Client API, Kernel API, the business-side PHP SDKs, Widget, Executor Protocol, tool signatures, and approval protocol remain compatible.
- The management center requires the MySQL Agent Auth and Runtime ledgers. A deployment without those ledgers does not receive fabricated session or runtime data.
- Deployments that do not use Agent Client require no new configuration. Existing `/run`, chat-entry, and executor paths are unchanged.

## Validation

The release candidate must pass:

```bash
npm run release:check
```

The gate covers Core type checking and 612 tests, management-API permissions and redacted projections, session revocation, bulk operationId selection, console build and E2E, Client API ecosystem consumers, all SDK contracts, Docker Demo, OSS boundaries, security and dependency audits, release consistency, and npm artifact inspection. Before publication, the public diff and package must also be checked for private domains, credentials, local paths, and environment-specific data.

## Related Documentation

- [Agent Client v1 Integration Guide](AGENT_CLIENT_QUICKSTART.en.md)
- [Agent Auth v1](AGENT_AUTH_API.en.md)
- [Agent Client Runtime v1](AGENT_CLIENT_RUNTIME_API.en.md)
- [Compatibility and Upgrade](COMPATIBILITY.en.md)
- [中文发布说明](RELEASE_NOTES_v0.5.1.md)
