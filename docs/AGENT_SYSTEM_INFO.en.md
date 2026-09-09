# Help an agent understand each business system

English | [简体中文](AGENT_SYSTEM_INFO.md)

Before choosing where to search for tools, an agent needs to understand what each selected system usually does. A helpdesk handles tickets while an inventory system manages stock; both may offer a tool called “find record”.

Administrators open **Agent Clients → Connection Setup**, choose **Configure Connection** on the application's row, and edit the **System Description** step. It stays in the original business route, shared by Clients using that workspace. A user-editable account label cannot establish system identity. Reading the description requires the original Agent Session and selected route, without a business run or conversation text.

For the whole setup flow, see [Configure a local agent in one place](LOCAL_AGENT_SETUP.en.md).

## What to enter

Choose the workspace, fill in its name, short purpose, typical domains, and boundaries, then save. Missing descriptions leave existing authorization and tool flows intact. The stored field is `agent_client.system_info`:

```json
{
  "name": "Helpdesk",
  "summary": "Manage support tickets, check progress, and prepare replies.",
  "domains": ["Ticket lookup", "Response preparation"],
  "boundaries": ["Inventory adjustments belong to the inventory system."]
}
```

| Field | Constraint |
| --- | --- |
| `name` | Nonempty, at most 120 characters |
| `summary` | Nonempty, at most 400 characters |
| `domains` | Up to 6 nonempty strings, each at most 120 characters; an empty array is allowed |
| `boundaries` | Up to 6 nonempty strings, each at most 160 characters; an empty array is allowed |

These fields describe the product, not additional model instructions. Use single-line text without control characters. Do not include credentials, conversation text, private endpoint addresses, or requests to bypass permissions. Configuration rejects unknown fields and oversized values. Reads do not invent descriptions from a route prompt, route name, authorization label, or tool result.

The existing `agent_client` JSON field stores the configuration; no new table or migration is required.

## Host read contract

```http
GET /agent-api/v1/workspaces/helpdesk/system-info
Authorization: Bearer <Agent access token>
```

The endpoint returns only this route's description. Core revalidates the Client, original Agent Session, both route grants, and route audience. Revocation or forbidden access remains 401/403. Disabled or missing routes return 404 `route_unavailable`. The read does not enumerate other routes, load tools, knowledge, memory, or business context, create a run, invoke business tools, or read a request body.

```json
{
  "schema_version": "bailing.agent-system-info.v1",
  "binding": {
    "client_app_id": "helpdesk-client",
    "session_id": "123e4567-e89b-42d3-a456-426614174000",
    "workspace": "helpdesk"
  },
  "metadata_status": "configured",
  "revision": "<sha256>",
  "system": {
    "name": "Helpdesk",
    "summary": "Manage support tickets, check progress, and prepare replies.",
    "domains": ["Ticket lookup", "Response preparation"],
    "boundaries": ["Inventory adjustments belong to the inventory system."]
  },
  "tool_status": "not_loaded",
  "availability": "unknown"
}
```

`revision` is the SHA-256 of the normalized description and schema. It identifies description changes, not authorization identity or capability revision. Responses use `Cache-Control: no-store`.

Keep these meanings separate:

- `system` describes what the product usually does; it does not prove that this authorization grants every related action.
- `metadata_status=missing` means there is no valid description, with `system` and `revision` both `null`; it does not mean there are no tools.
- `tool_status=not_loaded` means tools have not been loaded, not that there are zero tools.
- `availability=unknown` makes no claim about business-service connectivity. Disabled runtime or direct tools return `unavailable` with `agent_client_disabled` or `agent_direct_disabled`. The description remains readable while actual calls retain their original configuration checks.

Read only the conversation's explicitly selected targets. Validate the response binding against the original Agent Session, Client, and workspace, then associate it with the host's existing `authorization_ref` and `system_ref`. Single, same-system multiple, and cross-system authorizations use the same shape. Do not inject unselected targets or expand a fixed scope when descriptions change.

An old Core returns 404 `not_found` for this unknown endpoint, allowing the host to report description support as unavailable. Missing descriptions can display unknown purpose or use a controlled local dictionary keyed by the original binding. Do not classify 401/403, `route_unavailable`, or temporary network failures as old-version incompatibility. Metadata fallback never replaces identity checks or switches to a default authorization.

## Console configuration API

`GET /admin/api/routes/:route_key/agent-setup` returns only `route_key`, `name`, `enabled`, `permission`, `revision`, `agent_client`, `tool_sources`, and `agent_direct`. It excludes route `target_config` and provider credentials. `permission` is a read-only reminder of the route's existing execution permission, such as `readonly`; PUT cannot change it.

PUT to the same path accepts exactly four fields:

```json
{
  "expected_revision": "<revision returned by GET>",
  "agent_client": { "enabled": true, "system_info": { "name": "Helpdesk", "summary": "Support ticket management", "domains": [], "boundaries": [] } },
  "tool_sources": [{ "provider": "helpdesk", "allow": ["ticket.read"], "subject_field": "operator_id" }],
  "agent_direct": { "enabled": true }
}
```

`agent_client` and `agent_direct` may explicitly be `null` to clear them; an empty `tool_sources` clears source selection. Preserve existing instructions, active-tool limits, and source options when editing a description.

GET requires `routes:read`; PUT requires `routes:write`. Client-management permission does not substitute for route permission. Existing route, provider, exact write-operation, and approval validation still applies. The database transaction locks and compares the full route revision; a conflict returns 409 `agent_setup_conflict`. Success updates only `agent_client`, `tools`, and the update timestamp.

A host repository without optional `compareAndSetAgentSetup` can still read but receives 503 `agent_setup_unsupported` on save. There is no fallback to whole-row replacement. Success returns the same projection with its new revision. For the separate Client settings endpoint, see the [setup API appendix](LOCAL_AGENT_SETUP.en.md#api-appendix-narrow-updates).

The feature does not change business APIs, approval rules, fixed conversation scope, or archive behavior.
