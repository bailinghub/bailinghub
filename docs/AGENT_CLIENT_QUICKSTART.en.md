# Agent Client v1 Integration Guide

English | [简体中文](AGENT_CLIENT_QUICKSTART.md)

Agent Client lets a local Agent host such as DeepSeek Harness perform reasoning, planning, and
multi-step tool selection while BailingHub continues to own trusted business identity,
capability filtering, approvals, idempotency, business invocation, and audit. It is not the
existing executor protocol, and it does not give local models business passwords, tokens, or
direct business API endpoints.

This guide separates the responsibilities of the BailingHub deployer, the business-system
developer, and the local Agent user. They do not share one credential or configuration file.

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
| `connectionName` | local user | local SDK registry | No; local readable alias only |
| Agent authorization URL | business developer / Hub admin | BailingHub client config | No, but users do not enter it |
| business Client Token | business backend | server-side secret store | **Yes; never browser or DSH config** |
| Tool Provider Secret | business backend and BailingHub | both secret stores | **Yes; never DSH** |
| Agent access/refresh token | generic SDK | Keychain or explicit secure store | **Yes; never plugin settings** |
| model API key | local Agent host | DSH model-provider credential store | **Yes; independent of Hub auth** |
| BailingHub admin token | Hub operator | Hub server secret store | **Yes; never any Agent client** |

`clientAppId` is a public identifier, not a Client Token. A native Agent Client setup must not ask
the end user to paste a BailingHub Client Token, Tool Provider Secret, or business password.

## 3. BailingHub deployer: expose one Agent Client workspace

### 3.1 Deploy Core and apply migrations

Use a BailingHub release that contains Agent Auth v1, Agent Client Runtime v1, and migrations 055
and 056. Confirm that health and readiness pass, no migration is pending, the console can edit
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
2. Add only explicitly allowed write operation IDs to `write_tools`; read-only tools do not need
   to be listed there.
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
- the HTTPS business authorization page, for example
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
into every business system. The business system owns a page that follows its normal login and
permission model. The backend derives `principal`, `on_behalf_of`, and allowed routes from the
current authenticated server session.

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
route key, not a business domain, tenant ID, or chat-entry ID.

Run in DSH:

```text
/bailinghub login
/bailinghub status
```

Login creates a random loopback PKCE callback and opens the business authorization page. The SDK
uses macOS Keychain; a Linux/POSIX file fallback is explicit opt-in and requires mode `0600`.
Agent Session fails closed on Windows until a native secure store is available.

Configure the model provider and model API key separately in DSH. The BailingHub plugin neither
reads nor manages model-provider keys.

## 6. Multiple Hubs and workspaces

A connection is uniquely bound to `Hub + clientAppId + workspace`; `connectionName` is only its
local alias. Each login requests one workspace for least privilege. For another Hub or route, use a
console-generated command or run these user commands in DSH:

```text
/bailinghub connections add "shop A" https://hub-a.example.com merchant-agent order-assistant
/bailinghub connections list
/bailinghub connections use "shop A"
/bailinghub login
```

Connection selection is a user command, not a model tool. It affects only newly created Agent
sessions; existing sessions stay pinned to their original connection. `/bailinghub use
<workspace>` moves only within workspaces already granted to the current authorization and is not
a multi-connection selector. `/bailinghub connections remove <name>` first revokes the remote
Agent Session and deletes local credentials only after success; a failed remote revoke keeps the
connection for retry. Never copy access or refresh-token files between connections.

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
- **Authorized but no tools:** check the Tool Provider, `tools.agent_direct.enabled`, audience
  policy, and Local Agent Runtime switch.
- **A write requires approval:** inspect the ACC declaration first. `force_approval_tools` may
  only make policy stricter.
- **Missing SDK:** the host adapter and `bailinghub-mcp-server/sdk` were not installed at compatible
  versions. Fix the public package dependency; do not copy SDK source or add a local absolute path.
