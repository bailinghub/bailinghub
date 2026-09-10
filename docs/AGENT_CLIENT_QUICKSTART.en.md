# Agent Client v1 Integration Guide

English | [简体中文](AGENT_CLIENT_QUICKSTART.md)

Agent Client lets a local Agent host such as DeepSeek Harness perform reasoning, planning, and
multi-step tool selection while BailingHub continues to own trusted business identity,
capability filtering, approvals, idempotency, business invocation, and audit. It is not the
existing executor protocol, and it does not give local models business passwords, tokens, or
direct business API endpoints.

This guide separates the responsibilities of the BailingHub deployer, the business-system
developer, and the local Agent user. They do not share one credential or configuration file.

For the current console flow, start with [Local Agent Setup](LOCAL_AGENT_SETUP.en.md): authorization, descriptions, tools/approvals, and connection checks share one entry point under Agent Clients. The sections below explain configuration ownership and advanced integration details.

## 1. Component relationship

```text
Local Agent host (for example, DSH)
  └─ dsh-bailinghub: host lifecycle, dynamic tools, and visible results
       └─ bailinghub-mcp-server/sdk: PKCE, browser login, credential storage, Runtime DTOs
            └─ BailingHub Core: identity revalidation, capability filtering, approval,
                               execution, audit, and the visible conversation ledger
                 ├─ business authorization page: binds the current business login
                 └─ Tool Provider: ACC declarations, signature verification, final authorization
```

The dependency direction is host to generic SDK to BailingHub Core. The business system never
sends its login cookie, password, or API secret to DSH, and DSH never calls business APIs directly.

## 2. Configuration ownership

| Configuration | Owner | Storage | Secret |
|---|---|---|---|
| `hubUrl` | host deployer | host plugin settings | No; public BailingHub HTTPS origin |
| `clientAppId` | host deployer | host plugin settings | No; BailingHub client `app_id` |
| `workspace` | host deployer | host plugin settings | No; an allowed BailingHub `route_key` |
| `connectionName` | local user | local SDK registry | No; readable selector for one local connection instance |
| Agent authorization URL | business developer / Hub admin | BailingHub client config | No; one neutral entry per app, never entered by end users |
| business Client Token | business backend | server-side secret store | **Yes; never browser or DSH config** |
| Tool Provider Secret | business backend and BailingHub | both secret stores | **Yes; never DSH** |
| Agent access/refresh token | generic SDK | Keychain or explicit secure store | **Yes; never plugin settings** |
| model API key | local Agent host | DSH model-provider credential store | **Yes; independent of Hub auth** |
| BailingHub admin token | Hub operator | Hub server secret store | **Yes; never any Agent client** |

`clientAppId` is a public identifier, not a Client Token. A native Agent Client setup must not ask
the end user to paste a BailingHub Client Token, Tool Provider Secret, or business password.

## 3. BailingHub deployer: expose one Agent Client workspace

### 3.1 Deploy Core and apply migrations

For the complete cross-system flow, use BailingHub 0.7.0, Agent Client SDK 0.5.0 and DSH 0.5.0
or a compatible client. Apply all outstanding migrations, including 055–059, as part of the
deployment; runtime startup does not apply them.
Confirm that health and readiness pass, no migration is pending, the console can edit
Agent Client settings, and production traffic uses HTTPS.

Never copy databases, tokens, business domains, or route configuration from a maintainer's
self-use instance into a public deployment.

### 3.2 Connect business tools

The business system still publishes ACC/OpenAPI capability declarations and performs signature
verification plus final authorization at the real endpoint. Use `bailing/connect` or implement
the public HTTP/HMAC contract:

- [Business integration guide](INTEGRATION.en.md)
- [Tool governance design](TOOLS_DESIGN.en.md)
- [PHP SDK](../sdk/php/README.md)

Register the business `base_url`, `spec_url`, and a Hub-side credential reference in the Tool
Provider. The Tool Provider Secret must never enter a route, knowledge base, prompt, or Agent
Client setting.

### 3.3 Configure a route

1. Set `tools.agent_direct.enabled=true`.
2. Add only explicitly allowed write operation IDs to `write_tools`. For a large catalog, use
   **Select all current write operations** in the console; it stores an exact snapshot of the
   current operation IDs and does not authorize future writes automatically. Read-only tools do
   not need to be listed there.
3. Inherit approval requirements from the ACC declaration. Use `force_approval_tools` only to
   make selected writes stricter.
4. Enable Local Agent Runtime and optionally set host-specific instructions and an active tool
   limit from 1 to 12 (default 8).
5. Configure audience, tenant, and role boundaries instead of using `*` as production design.

The Agent Client never receives model credentials, Tool Provider Secrets, business API URLs, or
the complete `target_config`.

### 3.4 Create a client application

In Clients, create one Agent Client application:

- a stable public `app_id`, for example `merchant-agent`;
- the minimum `allowed_routes` set;
- one stable, account- and tenant-neutral HTTPS business authorization entry point, for example
  `https://business.example.com/agent/authorize`;
- a reasonable rate limit and `enabled=true`.

BailingHub displays the Client Token once. Give it only to the business backend that implements
the authorization page. Never put it in DSH settings, browser JavaScript, a URL, documentation,
or screenshots.

After creation, open **Agent Clients** in the console to:

- inspect which existing clients enable Agent authorization and their allowed workspaces;
- inspect device label, trusted business principal, last activity, and expiry for Agent Sessions;
- remotely revoke a lost or no-longer-authorized Agent Session;
- generate secret-free JSON or DSH commands from
  `hubUrl + clientAppId + workspace + connectionName`;
- view recent conversation, Agent Run, tool-call, token, failure-rate, and approval aggregates.

This page projects the existing client, Agent Session, and Agent Run ledgers. It does not create a
second Client resource and is not the Executor feature. Generated configuration contains no Client
Token, Agent token, or model key.

## 4. Business developer: bind trusted identity

The BailingHub SDK provides server-side Agent Auth methods; it does not inject one universal UI
into every business system. The business system owns one stable entry point that follows its normal
login and permission model. It handles login and, when needed, account switching plus selection
from tenants the backend confirms are accessible. The backend derives `principal`, `on_behalf_of`,
and allowed routes from the resulting current authenticated server session. Do not register a
different authorization URL per account, tenant, or store.

1. BailingHub appends only `authorization_id` to the configured page URL.
2. The page sends only that ID to its own backend.
3. The backend uses its server-side Client Token to read the authorization context.
4. After user confirmation, the backend derives trusted identity and approves the request.
5. The page navigates only to the `redirect_uri` returned by BailingHub.
6. Deny or revoke the session when the user rejects, leaves the organization, or loses a device.

PHP example:

```php
use Bailing\Connect\AgentAuth;

$agentAuth = new AgentAuth(
    getenv('BAILINGHUB_BASE_URL'),
    getenv('BAILINGHUB_CLIENT_TOKEN')
);

$context = $agentAuth->context($authorizationId);

// Both values come from the authenticated backend session, never from browser claims.
$result = $agentAuth->approve(
    $authorizationId,
    [
        'id' => (string) $currentUser->id,
        'tenant' => (string) $tenantId,
        'roles' => $currentUser->roles,
    ],
    "tenant_{$tenantId}:user_{$currentUser->id}",
    $context['requested_routes']
);

return redirect($result['redirect_uri']);
```

Other languages can implement the Agent Auth v1 HTTP contract directly. The Client Token stays
in the backend `Authorization: Bearer <BUSINESS_CLIENT_TOKEN>` header and is never sent to the
browser.

### 4.1 Inspect and withdraw access (Core 0.7.0)

The lifecycle additions in this branch let a business backend identify the device session created
by an authorization and find sessions for an operator or tenant before withdrawing access. Tool
declarations and the existing consent page need no redesign. The new methods require matching
Core 0.7.0 and its matching PHP/PHP7 SDKs.

```php
// Derive filters from the backend's validated management permission and tenant scope.
$page = $agentAuth->listSessions(['tenant' => (string) $tenantId, 'limit' => 20]);
// Keep the same filters and pass next_cursor for the next page; null means no next page.
$context = $agentAuth->context($authorizationId);
$session = $context['session'] ?? null; // Reliable link on consumed records only; never guess.
$result = $agentAuth->revokeAuthorization($authorizationId);
```

An operator filter requires both `principal_id` and `tenant`; use `tenant => ''` for no tenant.
`active` describes the session ledger, not current business-account permission; expiry follows the
refresh/session lifetime. Revocation and exchange are atomic, and repeated revocation of the same
authorization is idempotent. A 503/timeout, or a 404 for a consumed record with no valid mapping,
does not prove revocation. Keep the failure and retry or investigate the original ID.
Use the existing `revokeSession()` when the exact Session ID is already known. See the
[Agent Auth contract](AGENT_AUTH_API.en.md) for pagination and compatibility details.

## 5. Local Agent user: install and authorize

For DSH, follow the versioned installation and compatibility matrix in the
[dsh-bailinghub repository](https://github.com/bailinghub/bailinghub-dsh-plugin). The native
plugin configuration contains only:

```text
hubUrl=https://hub.example.com
clientAppId=merchant-agent
workspace=order-assistant
connectionName=default
```

Equivalent environment variables are:

```bash
export BAILINGHUB_HUB_URL='https://hub.example.com'
export BAILINGHUB_CLIENT_APP_ID='merchant-agent'
export BAILINGHUB_WORKSPACE='order-assistant'
export BAILINGHUB_CONNECTION_NAME='default'
```

`hubUrl` is the Hub origin without `/console`, `/agent-api`, or a business path. `workspace` is a
route key, not a business domain, tenant ID, or chat-entry ID. Plugin settings contain no business
URL: BailingHub returns the registered page for `clientAppId`, and the user confirms the business
account and tenant only on that page.

Run in DSH:

```text
/bailinghub login
/bailinghub status
```

Login creates a random loopback PKCE callback and opens the business authorization page. The SDK
uses macOS Keychain; a Linux/POSIX file fallback is explicit opt-in and requires mode `0600`.
Windows uses native CurrentUser DPAPI protection. Consult the independent SDK/plugin compatibility matrix for platform requirements.

Configure the model provider and model API key separately in DSH. The BailingHub plugin neither
reads nor manages model-provider keys.

## 6. Multiple Hubs, workspaces, and same-binding identity instances

The public binding is `Hub + clientAppId + workspace`; `connectionName` is only a local connection
selector, not a trusted account, tenant or store identity. Multiple instances may share the same
public binding, but every instance requires separate
browser authorization. Core does not trust the local instance name or id: the trusted subject
still comes only from business-backend approval as `principal` and `on_behalf_of`.

Each login requests one workspace for least privilege. For another Hub, route, or business identity
on the same public binding, use a console-generated command or run these user commands in DSH:

```text
/bailinghub connections add "identity-a" https://hub-a.example.com merchant-agent order-assistant
/bailinghub connections list
/bailinghub connections use "identity-a"
/bailinghub login
```

Connection selection is a user command, not a model tool. It selects the connection-management and
login target; it does not grant business scope to a new conversation. DSH0.5.0 requires a separate
explicit scope selection before the first message. Existing conversations retain their original scope. `/bailinghub use
<workspace>` moves only within workspaces already granted to the current authorization and is not
a multi-connection selector. `/bailinghub connections remove <name>` first revokes the remote
Agent Session and deletes that instance's local credentials only after success; a failed remote
revoke keeps that instance for retry. Never copy access or refresh-token files between connections.

On one device, when a newly authorized connection under the same public binding yields the same
trusted `on_behalf_of` as an older connection, the SDK revokes and removes the older local
connection after the new authorization succeeds. Different identities remain independent. If the
new authorization succeeded but revoking or removing the older connection failed, the result marks
`cleanupRequired` and retains a recoverable state. Do not reauthorize; clean up the reported old
connection first. Core still keys `bz_agent_sessions` by `session_id` and performs no global
cross-device identity deduplication, so sessions on different devices can be revoked and audited
independently.

### 6.1 Select conversation scope before the first message

Authorize the intended accounts separately, then obtain each `connectionKey` from `/bailinghub connections list`. Before the first user message in a new conversation, run:

```text
/bailinghub scope set <connectionKey-for-A> <connectionKey-for-B>
/bailinghub scope
```

Use the actual returned keys, not these placeholders or account labels. Select only A to allow only A; `/bailinghub scope none` means ordinary chat without Hub access. Wait for successful selection before sending business requests. DSH0.5.0 accepts distinct original Agent Sessions from different Client Apps/workspaces on one Hub and audit domain. Existing same-system scopes remain supported and never expand automatically.

The first user message fixes the scope; changing it requires a new conversation. Custom hosts use `setSessionScope/getSessionScope/restoreSessionScope`. Failed restoration must never select a default or remaining subset.

### 6.2 Read the conversation and retry synchronization

Compatible hosts use SDK0.5.0 to capture actual visible text, preserving the original Session, durable history and separate pending records. Administrators open Tasks → Conversations → Client conversations and follow each turn into the original account's execution record.

Use `/bailinghub archive status` to inspect synchronization and `/bailinghub archive sync` to retry. After reopening offline, the same runtime and Session can revalidate the original scope and synchronize when connectivity returns. Confirmed revocation keeps the whole group blocked. Show storage failures and history gaps separately; never resend user messages or repeat business actions merely to repair the archive. Restoring an archive does not restore an invocation lost across process restarts. See the [user guide](user-guide/conversations.en.md) and [archive API](AGENT_CONVERSATION_AUDIT.en.md).

## 7. Minimum acceptance

1. Install a clean DSH profile using public packages only, without local paths or tarballs.
2. Confirm `/bailinghub login` opens the configured business authorization domain.
3. Confirm `/bailinghub status` exposes non-secret session metadata only.
4. Run one read-only business capability.
5. Run one reversible write that follows ACC/route approval semantics and is never duplicated.
6. Confirm BailingHub shows local-orchestration and Hub-governance trace boundaries.
7. Confirm logs, pages, and package artifacts contain no Client Token, Agent token, model key,
   business cookie, tool argument value, or response body.

## 8. Troubleshooting

- **`invalid_client`:** check `clientAppId`, enabled state, authorization URL, and allowed route.
- **Authorization page does not open:** production requires HTTPS; only loopback development may
  use port-qualified `127.0.0.1` or `::1` HTTP.
- **A fixed tenant or store opens:** `agent_authorize_url` is misconfigured. Register the business
  system's neutral authorization entry point, perform account/tenant choice inside that page, and
  do not add a business URL to plugin settings.
- **`cleanupRequired`:** the new identity authorization already succeeded. Do not authorize again;
  retry revoke or removal for the reported old connection.
- **Authorized but no tools:** first confirm a nonempty scope was selected before this conversation’s first message; login or default-connection switching alone does not grant scope. Then check the Tool Provider, `tools.agent_direct.enabled`, audience
  policy, and Local Agent Runtime switch.
- **A write requires approval:** inspect the ACC declaration first. `force_approval_tools` may
  only make policy stricter.
- **Missing SDK:** the host adapter and `bailinghub-mcp-server/sdk` were not installed at compatible
  versions. Fix the public package dependency; do not copy SDK source or add a local absolute path.
