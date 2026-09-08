# Agent Conversation Audit v1

[中文版](AGENT_CONVERSATION_AUDIT.md)

This optional API records the complete **visible** conversation managed by a local
Agent, and links its turns to separately authorized BailingHub runs. It does not
merge Agent Sessions, business identities, threads, runtime memory, tool grants,
approvals or invocation ownership. It does not collect hidden reasoning.

The feature requires `sql/057_agent_conversation_audit.sql`. Hosts must explicitly
apply their normal Core migration process; starting the runtime does not apply
this migration. Older hosts may omit `ConfigStore.agentConversationAudit`; these
write and admin read endpoints then report `conversation_audit_unavailable`.

## Authorization and storage boundary

- Every Agent request uses the existing `Authorization: Bearer <Agent access token>`
  authentication. Tokens are never fields in the archive or event DTOs.
- A creator freezes the exact member Agent Session UUIDs, client application,
  route and original `client_conversation_id`. The creator must be a member.
- Each other member confirms with **its own** authenticated bearer. A caller
  cannot confirm a session ID supplied in a body. All members must confirm before
  any event, including the first visible message, can be stored.
- Only the creator can append events. A conversation UUID or client conversation
  string alone gives no membership, write permission or read permission. There is
  consequently no separate enrollment secret.
- Every mutation checks current route availability and the client/session route
  allowlist intersection and audience policy. Every event batch also checks all
  frozen members for revocation, refresh expiry and unchanged identity snapshots.
  The mutation transaction locks the group, client, route and session rows until
  commit. A refreshed access token can continue the same Agent Session; replacing
  a session or its principal/on-behalf-of identity cannot replace an old member.
- Full bodies are readable only through the existing administrator `runs:read`
  permission. There is **no Agent transcript read endpoint**. Administrators see
  only the control-plane data domain supplied by their host; hosts must continue
  enforcing their own tenant isolation and must not combine unrelated tenant
  stores because IDs happen to match.
- Bodies live in `bz_agent_conversation_events`, not in `bz_messages` or thread
  memory. An authorized multi-store conversation is not copied into each store's
  model context. Existing run completion records keep their original purpose.

## Create and confirm membership

`POST /agent-api/v1/conversation-audits`

```json
{
  "client_archive_id": "323e4567-e89b-42d3-a456-426614174001",
  "client_conversation_id": "conversation-stable-id",
  "route": "orders",
  "member_session_ids": [
    "123e4567-e89b-42d3-a456-426614174001",
    "123e4567-e89b-42d3-a456-426614174002"
  ],
  "member_labels": {
    "123e4567-e89b-42d3-a456-426614174001": "Store A",
    "123e4567-e89b-42d3-a456-426614174002": "Store B"
  }
}
```

`client_archive_id` is a persistent random UUID owned by the host. Creation is
idempotent within `(creator_session_id, route, client_archive_id)` only when the
entire frozen input matches. A changed member set, label or original conversation
ID returns `409`; it does not widen or rewrite the original archive. Distinct
creators never auto-join through identical client IDs. Labels are optional,
limited to 128 characters, and are display text rather than identity evidence.

The creator is confirmed by its creation request. Each other member sends:

`POST /agent-api/v1/conversation-audits/:conversation_id/confirm` with `{}`.

Both operations return schema `bailing.agent-conversation-audit.v1` and the
conversation header described below. `state` is `enrolling` until all members
confirm, then `ready`. It describes enrollment, not a permanent guarantee that
all authorizations remain active; every subsequent write revalidates them.
Replies contain no transcript text, credentials, identity hashes or tool data.

## Append visible events

`POST /agent-api/v1/conversation-audits/:conversation_id/events`

```json
{
  "events": [
    {"event_id":"start-1","sequence":1,"client_turn_id":"turn-1","kind":"turn_start"},
    {"event_id":"user-1","sequence":2,"client_turn_id":"turn-1","kind":"user_message","content":"Compare the two selected stores."},
    {"event_id":"run-a","sequence":3,"client_turn_id":"turn-1","kind":"run_link","run_id":"223e4567-e89b-42d3-a456-426614174001","member_session_id":"123e4567-e89b-42d3-a456-426614174001"},
    {"event_id":"answer-1","sequence":4,"client_turn_id":"turn-1","kind":"assistant_message","content":"The complete answer shown to the user."},
    {"event_id":"end-1","sequence":5,"client_turn_id":"turn-1","kind":"turn_end","status":"completed"}
  ]
}
```

| Kind | Additional required fields | Meaning |
| --- | --- | --- |
| `turn_start` | none | Begin one host-visible turn. |
| `user_message` | `content` | Exact visible user text, including follow-up messages. |
| `assistant_message` | `content` | Exact visible assistant text; multiple visible messages are allowed. |
| `run_link` | `run_id`, `member_session_id` | Attach a verified original authorization run. |
| `turn_end` | `status` | `completed`, `failed` or `cancelled`. |

Unknown fields and event kinds are rejected. There is no arbitrary metadata,
reasoning, credential, tool-argument or tool-result field. Text is preserved, not
silently rewritten or truncated. A host must submit only text visible to its user;
the server cannot infer whether a client-authored statement was actually shown.

Sequences start at 1 and remain strictly contiguous. Each batch is ordered and
atomic. Identical `sequence` + `event_id` + body retries succeed; different content,
reused IDs, gaps and conflicting turn histories return `409` without partial writes.
A normal message or `turn_end` must belong to the current running turn. A late
`run_link` may attach to an already started, completed or cancelled original turn;
it never reopens that turn or changes a newer turn's status.

For every run link, BailingHub verifies the persisted run's exact member Session,
client application, route, original `client_conversation_id` and `client_turn_id`.
The server derives `thread_id`. A run belongs to at most one archive, so old run
and tool traces can link back without ambiguous matches. This relationship does
not authorize execution, retry, approval or memory access.

Successful append response:

```json
{
  "schema": "bailing.agent-conversation-audit-ack.v1",
  "conversation_id": "423e4567-e89b-42d3-a456-426614174001",
  "last_sequence": 5
}
```

Hosts should persist the archive UUID, creator/member binding, stable event IDs,
ordered events and acknowledged sequence before claiming successful archival.
Lost acknowledgements can be retried unchanged. Restoring an audit queue does not
restore invocation execution state or grant permission to resume unknown IDs.

## Administrator read API

`GET /admin/api/conversation-audits?limit=50&offset=0` returns:

```json
{
  "schema": "bailing.agent-conversation-audit-list.v1",
  "items": [],
  "has_more": false,
  "next_offset": null
}
```

Each header includes `conversation_id`, `client_archive_id`,
`client_conversation_id`, `client_app_id`, `route_key`, `state`, `member_count`,
`confirmed_count`, `last_sequence`, `message_count`, `turn_count`,
`last_turn_status`, `created_at` and `updated_at`. The last turn status is initially
null, then `running`, `completed`, `failed` or `cancelled`. Sequences count all
event kinds and must not be displayed as message counts.

`GET /admin/api/conversation-audits/:id?after_sequence=0&limit=100` returns schema
`bailing.agent-conversation-audit-detail.v1`, `conversation` (the header),
`members`, `events`, `has_more` and `next_after_sequence`. Member views contain
`session_id`, `display_label`, `confirmed`, and, once confirmed, the frozen
`principal` and `on_behalf_of`. Event views contain the submitted visible fields,
server `created_at`, and server-derived numeric `thread_id` on run links.
Read the next page using `next_after_sequence`; no fixed first-1000-message cutoff
is imposed. Responses use `Cache-Control: no-store`.

Existing administrator agent-run traces add optional
`run.conversation_audit_id` / `run.client_turn_id`; verified tool job traces add
the same fields under `job`. The original trace endpoint and its full
thread/run/client/session/route ownership checks remain in use.

## Limits and errors

The member limit is 64. Each append batch contains 1–50 events, each visible text
is at most 64,000 UTF-16 code units, total batch text is at most 256 KiB of UTF-8,
and the HTTP JSON envelope is at most 2 MiB. An archive accepts at most 20,000
events and 16 MiB of visible text. List pages cap at 100 items; event pages cap at
200 events. Hosts should batch below these maxima. Limits reject writes rather
than truncate an allegedly complete transcript.

| HTTP | Code | Host interpretation |
| --- | --- | --- |
| 400 | `invalid_request` | Invalid or undeclared DTO fields. |
| 401 | `unauthorized` | Existing Agent bearer authentication failed. |
| 403 | `conversation_audit_authorization_invalid` | A frozen authorization or route is no longer valid. |
| 404 | `conversation_audit_not_found` | Unknown archive or unavailable to this identity; do not enumerate membership. |
| 409 | `conversation_audit_not_ready` | Some members have not confirmed; do not submit text. |
| 409 | `conversation_audit_conflict` | Frozen membership, event sequence/content, turn or run association conflicts. |
| 413 | `conversation_audit_limit` | No partial or truncated events were saved. |
| 503 | `conversation_audit_unavailable` | Optional archive repository is not available. |
| 500 | `conversation_audit_internal_error` | Storage/internal failure; raw exception details are not returned. |

Unknown endpoints, including every Agent transcript GET, return `404`. An older
Core without these routes may also return `404`; adapters must report archival
as unsupported, not claim that a complete conversation was uploaded. An archive
failure must remain visible independently of a successful business operation.
