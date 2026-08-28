# Agent Auth v1

English | [简体中文](AGENT_AUTH_API.md)

Agent Auth v1 binds a local Agent's browser authorization to an existing authenticated business
session and issues a revocable Agent Session. BailingHub supplies the protocol and server-side SDK
methods. The business system owns its login page, consent UI, user/tenant/role decisions, and final
business authorization.

See the [Agent Client v1 Integration Guide](AGENT_CLIENT_QUICKSTART.en.md) for the full component
relationship. This protocol does not carry subscription, billing, model credentials, or business
API secrets.

## 1. Parties and credentials

| Party | Identifier or credential | Boundary |
|---|---|---|
| local Agent SDK | public `client_app_id`, PKCE, loopback callback | no Client Token or business password |
| business authorization backend | BailingHub Client Token | server-only context/approve/deny/revoke calls |
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
