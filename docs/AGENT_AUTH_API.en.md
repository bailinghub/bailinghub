# Agent Auth v1

English | [简体中文](AGENT_AUTH_API.md)

Agent Auth v1 binds a local Agent's browser authorization to an existing authenticated business
session and issues a revocable Agent Session. BailingHub supplies the protocol and server-side SDK
methods. The business system owns its login page, consent UI, user/tenant/role decisions, and final
business authorization.

See the [Agent Client v1 Integration Guide](AGENT_CLIENT_QUICKSTART.en.md) for the full component
relationship. This protocol does not carry subscription, billing, model credentials, or business
API secrets.

The **authorization lifecycle additions in this branch are unpublished candidates**. A business
backend can identify the device session created by an authorization, page through sessions for an
operator or tenant, and withdraw access using the original authorization record. Session listing,
authorization revocation and `context.session` require matching candidate Core / PHP SDK sources;
the public stable Core v0.6.1 does not include these additions.

## 1. Parties and credentials

| Party | Identifier or credential | Boundary |
|---|---|---|
| local Agent SDK | public `client_app_id`, PKCE, loopback callback | no Client Token or business password |
| business authorization backend | BailingHub Client Token | server-only context/approve/deny/list/revoke calls |
| BailingHub Core | authorization and session ledger | stores only SHA-256 token hashes |
| business tool endpoint | Tool Provider Secret and business ACL | revalidates every real invocation |

`client_app_id` is public. The Client Token is a backend secret and must never enter browser
JavaScript, local plugin settings, URLs, screenshots, or logs.

## 2. Client registration

Create a BailingHub client with a stable public `app_id` such as `merchant-agent`, one stable,
account- and tenant-neutral business HTTPS `agent_authorize_url`, the minimum `allowed_routes`,
`enabled=true`, and a reasonable rate limit. The local plugin never asks for a business URL. If the
business system has multiple accounts or tenants, this single entry point owns login, account
switching, and tenant selection. The backend then derives trusted identity from the resulting
server session; neither the local model nor a URL parameter may select the business subject.
Production authorization pages require HTTPS. Explicit-port `127.0.0.1` or `::1` HTTP URLs are
allowed only for local development.

## 3. Flow

```text
Local SDK                  BailingHub                  business page/backend
   | POST authorizations      |                              |
   |------------------------->|                              |
   | authorization_url        |                              |
   |<-------------------------|                              |
   | open browser ------------------------------------------>|
   |                          |<-- context (Client Token) ----|
   |                          |<-- approve/deny ---------------|
   |<---- loopback redirect --|-------------------------------|
   | POST token + PKCE ------>|                              |
   | Agent Session tokens <---|                              |
```

The SDK creates random state, a PKCE verifier/challenge, and a random loopback callback. Core
appends only `authorization_id` to the registered business page. That page requires login and, when
needed, lets the user switch account or select an authorized tenant. The business backend derives
the trusted principal from the resulting current server session, approves or denies the request,
and returns the Core-generated redirect. The SDK exchanges the one-time code with PKCE and stores
the resulting session in a secure local credential store.

## 4. Endpoints

### 4.1 Create authorization

`POST /agent-auth/v1/authorizations`

```json
{
  "client_app_id": "merchant-agent",
  "redirect_uri": "http://127.0.0.1:49152/callback",
  "state": "random-csrf-state",
  "requested_routes": ["order-assistant"],
  "device_label": "My workstation",
  "code_challenge": "<PKCE-S256-base64url>",
  "code_challenge_method": "S256"
}
```

The response contains `authorization_id`, the configured business `authorization_url`, and
`expires_in: 600`. The callback must be an explicit-port loopback HTTP URL. Public callbacks,
URL credentials, `auto`, and `*` routes are rejected. v1 host adapters should request one workspace
per connection.

### 4.2 Read context from the business backend

`GET /agent-auth/v1/authorizations/{authorization_id}` with:

```http
Authorization: Bearer <BUSINESS_CLIENT_TOKEN>
```

The response exposes only client name, device name, requested routes, status, and expiry metadata.

The lifecycle candidate preserves those fields and adds `session` when `status=consumed`, linking
the authorization to the original session created by code exchange. Example `session` value:

```json
{
  "session_id": "22222222-2222-4222-8222-222222222222",
  "state": "active",
  "expires_at": "2030-02-01T00:00:00.000Z"
}
```

A revoked session may also include `revoked_at`. If a legacy record has no reliable mapping, or
the linked session is missing, `session` is `null`. Never infer a Session ID from device labels,
identity or timestamps. The original top-level `expires_at` remains the authorization-request
expiry; `session.expires_at` is the refresh/session lifecycle expiry.

### 4.3 Approve or deny from the business backend

`POST /agent-auth/v1/authorizations/{authorization_id}/approve`

```json
{
  "principal": {
    "id": "user-42",
    "tenant": "tenant-7",
    "roles": ["manager"],
    "audience": "internal"
  },
  "on_behalf_of": "tenant-7:user-42",
  "allowed_routes": ["order-assistant"]
}
```

Use the Client Token Bearer header. Derive `principal`, `on_behalf_of`, and `allowed_routes` from
the authenticated backend session and current permission data, never from browser claims, query
parameters, or model output. The approved set must be within both the pending request and the
client allowlist.

Deny with `POST /agent-auth/v1/authorizations/{authorization_id}/deny` and `{}`. Both endpoints
return a Core-generated `redirect_uri`; navigate only to that value.

### 4.4 Exchange and refresh

`POST /agent-auth/v1/token`

Authorization-code exchange:

```json
{
  "grant_type": "authorization_code",
  "client_app_id": "merchant-agent",
  "code": "<one-time-code>",
  "redirect_uri": "http://127.0.0.1:49152/callback",
  "code_verifier": "<PKCE-verifier>"
}
```

Refresh rotation:

```json
{
  "grant_type": "refresh_token",
  "client_app_id": "merchant-agent",
  "refresh_token": "<refresh-token>"
}
```

Access tokens default to 15 minutes and refresh sessions to 30 days. Every refresh rotates the
refresh token; reuse of an old token fails closed. Store both tokens in the operating system's
secure credential store, never in connection metadata or plugin settings.

### 4.5 Inspect and revoke

- `GET /agent-auth/v1/session`: Agent access Bearer; returns non-secret session metadata.
- `POST /agent-auth/v1/revoke`: revoke with Agent access Bearer, or with a
  `client_app_id + refresh_token` body.
- `POST /agent-auth/v1/sessions/{session_id}/revoke`: business backend Client Token; revokes a
  session owned by that client.

Revoke sessions when an employee leaves, a tenant is disabled, a device is lost, or business
authority changes. Business tool endpoints still revalidate current permission on every call.

### 4.6 List business sessions (unpublished candidate)

`GET /agent-auth/v1/sessions` uses the business backend Client Token and is restricted to its
Client App. A query cannot select another app. The backend must also enforce its own caller's
permission to inspect the requested tenant or operator; browser-supplied filters are not authority.
The Client Token grants backend authority for the whole app. Do not proxy this endpoint as an
unrestricted browser API. Any business admin UI must constrain both queries and revocations in
its backend using the current administrator's tenant, operator and authorization permissions.
BailingHub does not interpret business-specific user/store identifiers or replace that admin ACL.

| Optional parameter | Rule |
|---|---|
| `authorization_id` | UUID of the original authorization |
| `on_behalf_of` | Non-empty exact value, at most 191 UTF-16 units |
| `principal_id` | Non-empty, at most 128 UTF-16 units; requires an explicit `tenant` |
| `tenant` | At most 128 UTF-16 units; may filter a tenant on its own. Empty means no tenant; omission means no tenant filter |
| `state` | `active`, `expired` or `revoked` |
| `limit` | Integer 1–100, default 20 |
| `cursor` | Non-empty, unpadded base64url returned by the server; at most 2048 characters |

All filters are combined with AND. Unknown or repeated parameters are rejected. Identity and
tenant values cannot contain leading/trailing whitespace or control characters and are not
trimmed. Use RFC3986 encoding so `+`, `&`, `=` and an explicitly empty tenant survive transport.
The cursor is bound to the current Client App and all filters, but not to `limit`. Preserve filters
on the next page and treat cursors as opaque. Reusing one across apps or filters returns
`400 invalid_request`.
This is keyset pagination over current state, not a snapshot frozen across requests. Sessions that
expire or are revoked between pages are evaluated using their state at that later request.

```json
{
  "list": [{
    "session_id": "22222222-2222-4222-8222-222222222222",
    "authorization_id": "11111111-1111-4111-8111-111111111111",
    "client_app_id": "merchant-agent",
    "device_label": "Workstation",
    "principal": { "id": "user-42", "tenant": "tenant-7", "roles": ["manager"] },
    "on_behalf_of": "tenant-7:user-42",
    "allowed_routes": ["order-assistant"],
    "state": "active",
    "created_at": "2030-01-01T00:00:00.000Z",
    "expires_at": "2030-02-01T00:00:00.000Z"
  }],
  "next_cursor": null
}
```

Items may include `last_seen_at` and `revoked_at`; `authorization_id` is omitted when there is no
reliable original mapping. No access/refresh token, token hash, PKCE, callback URL or business
execution text is returned. Expiry and the `expired` state follow the refresh/session lifetime,
not the short-lived access token. `active` describes the session ledger; it does not guarantee that
the business account is currently valid. Per-call business permission checks remain mandatory.

### 4.7 Revoke an authorization (unpublished candidate)

`POST /agent-auth/v1/authorizations/{authorization_id}/revoke` uses the business Client Token and
an empty JSON object `{}`.

```json
{
  "authorization_id": "11111111-1111-4111-8111-111111111111",
  "revoked": true,
  "session_id": "22222222-2222-4222-8222-222222222222"
}
```

Revoked `pending` / `approved` requests can no longer exchange a code. A `consumed` authorization
revokes its reliably linked original Session and may return `session_id`. Revocation and exchange
are atomic against the same authorization record; repeated revocation is idempotent and never
creates or selects a replacement session. An unexchanged request may omit `session_id`. For a
`consumed` record, a missing mapping, missing session or session owned by another app returns 404;
failure to find a session must never be treated as proof of revocation.
Existing `revokeSession(sessionId)` remains appropriate when the exact Session ID is already known.

The candidate PHP 8.1+ / PHP 7.3 SDKs expose `listSessions(array $filters = [])` and
`revokeAuthorization($authorizationId)`; `context()` passes through the new fields. Node / Python
currently have no separate `AgentAuth` module and can use the same server-side HTTP contract.

Older Core versions may return 404. A Host without the lifecycle repository methods returns
`503 agent_auth_lifecycle_unavailable` for the new list/revoke operations. Keep failures explicit;
do not report an empty list or successful revocation, or fall back to stronger credentials.
A 503 or timeout does not prove revocation; retry idempotently with the same `authorization_id`.
This lifecycle addition adds no SQL migration; the combined candidate still includes the earlier
cross-system archive migration 058. Validate matching candidates in isolation before arranging a
separate production upgrade.

## 5. Business-page rules

- The page belongs to the business system; the SDK does not inject a universal UI.
- Use one stable entry point for the Client App, not a different URL per account, tenant, or store.
- Require the normal business login before consent. Let a signed-in user switch account and select
  only a tenant that the backend confirms the account may access.
- Show the current account, tenant, device, and requested workspace clearly.
- Keep the Client Token in the backend; the page holds only `authorization_id`.
- Use `Cache-Control: no-store` and never export tokens to analytics or error reporting.
- Treat repeated, expired, and completed requests as terminal.
- Apply the business system's normal CSRF, CSP, clickjacking, and open-redirect defenses.

## 6. Errors and recovery

- `invalid_client`: disabled client, missing authorization page, or disallowed route.
- `invalid_request`: invalid fields, PKCE, callback, route, or principal.
- `route_not_allowed`: approval exceeds the request or client allowlist.
- `invalid_grant`: invalid, expired, replayed, or mismatched code/PKCE/refresh token.
- `access_denied`: the user rejected the request.
- `401 unauthorized`: invalid business Client Token or Agent access token.
- `409/410`: already processed or expired authorization.

On refresh failure, never fall back to an admin token, Client Token, or anonymous access. Isolate
the invalid session and require a new browser authorization.

A local multi-connection implementation may use `connectionName` as a selector, but it is not a
trusted identity claim. When a new authorization under the same public binding (Hub +
`client_app_id` + workspace) yields the same trusted `on_behalf_of`, the SDK may revoke and remove
the older local connection. Different `on_behalf_of` values remain independent. If the new
authorization succeeded but revoking or removing the older connection failed, the SDK must retain
a recoverable state and return `cleanupRequired`. Do not reauthorize in that state; clean up the
reported old connection first. Core does not turn this local deduplication rule into a global
cross-device session-uniqueness constraint.
