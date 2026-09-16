# Task control: persistence foundation

Historical foundation notes. The paired integration candidate now connects the actual runtime, HTTP, SDK/DSH and console; see [Task control](AGENT_TASK_CONTROL.en.md). The limitations below describe the earlier foundation slice only.

Status: internal implementation foundation. It is **not connected to the HTTP APIs,
tool runtime, SDK, DSH, or console**. Applying the new SQL alone does not enforce a
task budget or pause business execution. No client should enable task mode from
this foundation alone.

## What this layer is for

A user may ask an assistant to update product descriptions in a shop and check
stock in an inventory system. A task links those selected authorizations and the
original calls. It can restrict the allowed tools, cumulative write calls,
concurrent dispatch permits, and expiry time. Existing authorization and business
approval checks remain necessary.

The write counter counts calls to tools whose trusted declaration is not
`readonly`. This includes idempotent writes. It does not count products, money,
successful business changes, or tokens. One bulk call may affect many objects.

## Trusted inputs and persistent records

The future authenticated management layer must create the task and supply its
actor. The model cannot create a replacement task or increase its budget. Members
freeze the original Agent Session, Client, route, client conversation, identity
digest, and allowed tool names. Display names are not identities.

The repository also stores a persistent enforcement marker for each participating
Agent Session. Cancelling a task does not remove that marker. A future final
dispatch guard must check it even when a caller omits task metadata, changes its
conversation ID, or uses an older execution API. This first foundation does not
yet install that guard.

The first trusted reservation also binds the real run to exactly one task. A new
invocation ID cannot move that run to another approved task. The future run
creation path must establish this association from authenticated host state,
rather than letting the model choose a task on its first call.

`reserveInvocation` verifies a real Agent runtime run and the original Agent tool
Job. New operations require an active run. An existing original operation keeps
its original run even after that run ends. The classification must match a
Core-written `agent_task_tool_contract` snapshot in the original Job; user text or
model arguments cannot establish that snapshot. Current capability permission
and execution fingerprint validation must still be applied by the future runtime
integration before admission.

The task tables contain identifiers, hashes, control state and counters. They do
not duplicate conversation bodies, access tokens, or full business arguments.
Internal repository views include identity digests and group state; they are not
safe response DTOs. An authenticated API must authorize and project these views.

## Budget and dispatch semantics

| Fact | Write budget | Concurrency permit |
| --- | --- | --- |
| Original write reserved, including waiting for approval | reserved once | none |
| A fresh dispatch permit committed | remains reserved | held |
| Result is unknown | remains reserved | held as unknown |
| Trusted evidence confirms dispatch and a terminal outcome | consumed once | released |
| Trusted evidence confirms no dispatch, terminal outcome | released | released |
| Confirmed no dispatch, explicit retry of the same original operation | original reservation retained | a new permit may be granted |
| Read-only tool | no write charge | same concurrency policy |

Only `fresh: true` from a successful grant authorizes a new dispatch attempt. A
lost grant acknowledgement or a repeated grant returns the original permit and
must never cause a second request. An unresolved grant may require original
evidence reconciliation; a timer alone cannot prove that no request was sent.

Permit IDs fence settlement. A late response from an older permit cannot settle a
newer attempt. Only the trusted execution/evidence layer can report a settlement;
an Agent-facing API must not let the model claim `confirmed_not_dispatched` to
release its own quota.

A reservation that has never obtained a permit can be closed after an exact
denied approval or an authenticated administrator's abandonment. The transaction
checks the original no-dispatch fence and absence of an execution journal before
releasing budget. After a permit, this shortcut is forbidden. If a trusted
observation confirms that the original permitted operation was not dispatched,
an explicit retry may reuse its original still-approved approval ID; an unknown
outcome cannot enable that reuse or a new dispatch.

Task control revisions are separate from the execution ledger sequence. High
call volume should not continuously invalidate an administrator's pause request.
Pause stops **new permits** after the control transaction commits. Previously
granted permits can still finish and report their results. Cancellation is final
and does not promise rollback of completed business operations. Reading original
receipts remains distinct from explicitly continuing a business operation.

## Transaction boundary

This foundation requires the same MySQL database for task records, original Jobs,
Agent identities, and approvals. Granting a permit, consuming the matching
approval when required, and persisting the original Job attempt fence use one
connection and one transaction. Sharing a pool without sharing the connection is
insufficient.

The runtime integration must also coordinate the existing execution journal with
that transaction and the actual HTTP dispatch point. It must preserve known
journal results before allocating new permits and must not consume an approval
before discovering that the task is paused or its concurrency is exhausted.
External state stores and JSONL are not supported for task enforcement by this
foundation.

## Remaining activation requirements

Before advertising task-control support or enabling it for a client:

1. Connect one final admission path to direct invoke/resume and cover or reject
   older run, engine rerun, approval continuation and executor tool paths.
2. Require authoritative run/task association. A marked Session cannot escape
   enforcement by omitting a field or creating another conversation.
3. Add authenticated management APIs, protected Agent projections, capability
   negotiation, and explicit unsupported behavior for incompatible stores.
4. Integrate SDK/DSH using the original scope and invocation journal. Observation
   must use read-only receipts; explicit continuation must pass task admission.
5. Add the console controls and full synthetic HTTP/host acceptance, including
   cancellation, missing acknowledgements, identity revocation and local storage
   failures. A repository test is not proof of end-to-end enforcement.

`062_agent_task_control.sql` only adds task tables; it does not backfill tasks or
change existing limits. Once enforcement is activated in a later implementation,
downgrading to an implementation that ignores markers is not a safe rollback.
Keep the original task and invocation records when disabling new admission.

## Local verification

Pure state tests run with the normal test suite. The separate MySQL test accepts
`BAILING_TASK_TEST_MYSQL_CONFIG`, a path to a disposable database connection JSON.
It refuses non-loopback hosts and databases outside the `bailing_task_test` naming
boundary. It runs the real migration twice, seeds synthetic identities and empty
conversation bodies, then exercises concurrent budget/permit decisions,
transaction rollback, pause, revocation, and original-ID recovery. Never point
these tests at a business or shared environment.
