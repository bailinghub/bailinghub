# Show the business name after authorization

English | [简体中文](AGENT_SUBJECT_DISPLAY.md)

When a user approves “Account A” on a business authorization page, their agent client should be able to show that name without asking for another connection label. Core 0.7.0 adds optional `subject_display` metadata supplied by the business backend, bound by BailingHub to the original Agent Session, and read by a matching client. The subject can be a store, company, project, or another business account.

**Use Core 0.7.0, Agent Client SDK 0.5.0 and DSH 0.5.0, or a custom host implementing the same interfaces.** An older authorization without a name shows “Pending synchronization”. Its existing local note may remain separate, without posing as a business-confirmed name or changing business access.

## Responsibilities

| Party | Responsibility |
|---|---|
| Business backend | Read the name from the actual business record after validating the selected account and current server session. Supply it when approving authorization; synchronize later renames or older authorizations. |
| BailingHub | Bind the display data to the original authorization and Agent Session. Only the owning client application can update an active session's display metadata. |
| Agent client | Display the SDK-provided name while retaining a separate local note, connection key and original session binding. Show system information or another distinguishing hint for duplicate names. |

A system description explains what the system normally does. A subject display name tells the user which business account this authorization represents. A device label identifies the device and remains separate.

## Approve a new authorization

Use the existing server-side Client Token and add one optional field to the approval body:

```json
{
  "principal": { "id": "user-a", "tenant": "tenant-a", "roles": ["operator"] },
  "on_behalf_of": "tenant-a:user-a",
  "allowed_routes": ["operations"],
  "subject_display": { "name": "Account A" }
}
```

`subject_display` allows only `name`, or `null` for no supplied name. The name must be valid Unicode, nonempty after trimming, single-line, and at most 120 UTF-16 code units. Reject C0/C1 control characters and U+2028/U+2029 in the original input before trimming. Read the actual authorized business record rather than trusting an editable form field. Do not put this metadata into `principal` or `device_label`.

PHP 8.1+ and PHP 7.3 use the same optional fifth argument:

```php
// Read $accountName from the business record after server-side identity and permission checks.
$result = $agentAuth->approve(
    $authorizationId,
    $principal,
    $onBehalfOf,
    $allowedRoutes,
    array('name' => $accountName)
);
```

Existing four-argument calls preserve the original HTTP body and remain compatible with older Core versions. Explicitly supplying the fifth argument requires a supporting Core. The browser still follows only the returned `redirect_uri`; do not append the name to a URL. Client Tokens remain on the business backend.

## Synchronize an older authorization or rename

After applying its own management permissions, the business backend finds the exact original Session using `context()` or `listSessions()`, then calls:

```http
PUT /agent-auth/v1/sessions/{session_id}/subject-display
Authorization: Bearer <Client Token>
Content-Type: application/json

{"subject_display":{"name":"Account A"}}
```

```php
$session = $agentAuth->updateSubjectDisplay($sessionId, array('name' => $accountName));
// Explicitly clear the display metadata:
$session = $agentAuth->updateSubjectDisplay($sessionId, null);
```

Only an active session owned by the current Client Token's application may be updated. This changes display data only: no token issuance, identity/route/expiry changes, or revival of a revoked session. The response is the safe business-session projection, including the original `session_id`, `subject_display`, and `subject_display_status`, with no tokens or token hashes. It creates no business run and calls no business tools. For concurrent changes with different names, the last successful save wins.

| HTTP / error code | Meaning |
|---|---|
| `400 invalid_request` | Invalid fields or name |
| `404 not_found` | Invalid Session ID, missing Session, or Session owned by another application |
| `409 session_inactive` | Original Session inactive; changing its name cannot restore access |
| `503 subject_display_unavailable` | Repository capability or storage operation unavailable; do not report a successful save |

A timeout, network error or 503 is not a successful synchronization. Retry the same value against the original Session; use the owning application's session query for readback. Do not reauthorize, recreate a connection or replace a Session merely to synchronize a name.

## Read the result

Token exchange/refresh, the current Agent Session view, the owning application's session list and the administrator session list add:

```json
{
  "subject_display": { "name": "Account A" },
  "subject_display_status": "provided"
}
```

Older or explicitly cleared authorizations return `subject_display: null` and `subject_display_status: "missing"`. The SDK reports `unsupported` for absent fields on a legacy server and `unavailable` for invalid display data. The UI may show a pending name in each case. Do not derive the business name from a device label or another identifier, or confuse display status with authorization status.

Matching clients use the supplied business name as a default display value and may keep a separate user note. Selection still uses `connectionKey` and the fixed scope retains its original Agent Session. Two authorizations called “Account A” remain separate. Renaming must not merge accounts, steal another connection's alias, or rewrite labels in an already-started conversation. Names are data, never model instructions.

The console's “Agent clients → Devices and runs” view shows authorization and device names separately. A read-only detail view retains the original subject, tenant, application, workspaces and Session. Missing names are shown as pending synchronization; the console does not invent them for the business system.

See [Agent Auth v1](AGENT_AUTH_API.en.md) for unchanged identity/lifecycle rules and [system descriptions](AGENT_SYSTEM_INFO.en.md) for product positioning metadata.
