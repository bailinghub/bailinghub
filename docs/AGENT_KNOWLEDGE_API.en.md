# Agent knowledge search and read

[简体中文](AGENT_KNOWLEDGE_API.md) | [Runtime API](AGENT_CLIENT_RUNTIME_API.en.md)

Optional protocol `bailing.agent-knowledge.v1` applies only to Agent Clients. Native chat,
embed and widget keep existing server-side retrieval and body injection. Knowledge is
`reference_only`: it does not replace instructions, permissions, approvals or business receipts.

All endpoints require the current Agent bearer, revalidate Client/Session/route/audience and
`agent_client.enabled`, and return `Cache-Control: no-store`. Knowledge-only routes do not
require direct business tools. The client cannot supply KB IDs or document IDs.

## Negotiation

`GET /agent-api/v1/workspaces/:route/knowledge/capabilities` returns schema
`bailing.agent-knowledge-capabilities.v1`, protocol, supported, route, enabled,
knowledge_scope_revision, delivery_modes (`inline`, `on_demand`) and limits:
search_max_results=3, search_max_bytes=4096, read_default_bytes=16384,
read_max_bytes=32768, reference_ttl_seconds=300, read_chain_max_bytes=131072.

After explicit support negotiation, a trusted host may request `knowledge_delivery: "on_demand"`
in a new turn. The option is part of the immutable request hash. Core keeps knowledge and
knowledge_refs as empty arrays and echoes context.knowledge_delivery with schema_version
`bailing.agent-knowledge-delivery.v1`, mode, protocol, scope revision, status and bounded hints.
Instructions, governance and memory remain. Legacy requests without the option retain inline
bodies. Do not silently strip bodies when negotiation fails. Old endpoint 404/405/501 may fall
back to inline; authorization/server errors and unknown schemas must not pretend success.

## Search

`POST /agent-api/v1/workspaces/:route/knowledge/search` accepts
`{query, limit?, run_id?}`. Nonempty query is at most 2000 characters; limit is 1–3. An optional
run must be current, owned by this Session/client/route and context_ready. Managed tasks retain
their membership and active-state checks. Server-only turn preparation may issue run-bound
hints before finalization; the public endpoint cannot access preparing runs.

Schema `bailing.agent-knowledge-search.v1` returns route, optional run_id, knowledge_scope_revision,
status, trust=reference_only, hints and truncated. Each hint has ref, title, summary, revision,
score and expires_at. Summaries are bounded excerpts from actual current hits, not model output.
The entire JSON response is at most 4096 UTF-8 bytes and up to three distinct parent documents.
No knowledge body, memory or business schemas are included.

Status distinguishes ok (including zero matches), disabled, unavailable and partial. Do not call
retrieval failure “no knowledge”. Respect route thresholds; scores are not relevance probabilities.
Agent retrieval validates fresh index hits against current ready documents, ownership and exact
chunk content without changing native retrieval/cache behavior. Cross-model ranking remains an
approximation. No invocation/job or business dispatch is created.

## Read

`POST /agent-api/v1/workspaces/:route/knowledge/read` accepts
`{ref, run_id?, cursor?, max_bytes?}`. Reuse exactly the same run and original opaque cursor.
Schema `bailing.agent-knowledge-read.v1` returns route, optional run_id, knowledge_scope_revision,
ref, revision, title, content, trust, next_cursor, truncated, budget_exhausted,
total_content_bytes and read_chain_max_bytes.

Full JSON UTF-8 response budget defaults to 16384 bytes, accepts 4096–32768, and preserves Unicode
characters. Follow next_cursor when non-null. A reference reading chain exposes at most 128 KiB
of body: its last page explicitly has truncated=true, budget_exhausted=true and next_cursor=null
if the source exceeds that limit. This is not a per-turn total budget or a complete-source claim.

References/cursors use domain-separated HMAC under the existing server token, with a five-minute
TTL and no migration/new configuration. References bind Client, Session, principal/on_behalf_of,
route, optional run, full knowledge configuration and SHA-256 of title/body. Every read revalidates
current identity, scope, task state, KB enabled state, document ownership, ready state and revision.
Shared-key processes can validate references; key rotation requires a new search.

Errors: knowledge_reference_invalid (400, including cross-identity), knowledge_reference_expired
(410), knowledge_scope_changed (409), knowledge_changed (409), knowledge_unavailable (503).
Search again when references change; never substitute a new body for an old revision or replay
a business write to repair knowledge retrieval. Errors do not include body, credentials or SQL.

Hosts expose separate knowledge search/read tools, keep hints visible, isolate caches by current
authorization and turn, reject late responses, and preserve reference-only provenance. Existing
named-context delivery confirmation only addresses duplicate assembly; it does not replace
knowledge authorization or retrieval. Required business preconditions must also live in capability
guidance and server validation.
