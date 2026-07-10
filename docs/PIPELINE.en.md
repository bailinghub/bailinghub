# Runtime Pipeline

The runtime pipeline explains how one job moves through BailingHub from trigger to result delivery.

## 1. Trigger

A job can enter through:

- `POST /run`;
- web chat widget;
- inbound channel adapter;
- controlled internal APIs.

The entry layer authenticates the client or channel, validates payload shape, applies idempotency, and resolves the route.

## 2. Route Resolution

The route determines:

- target model or executor;
- model credential;
- memory and session policy;
- knowledge base and retrieval settings;
- allowed tool providers and scopes;
- budget and rate limits;
- callback or delivery policy.

`route=auto` can be used when the client is allowed to let the hub select a route from configured audience and keyword rules.

## 3. Context Assembly

The hub assembles:

- current input;
- message ledger;
- optional rolling summary;
- route-level knowledge retrieval;
- page context;
- principal and metadata;
- tool definitions visible to the route.

Untrusted user input and page context are wrapped as data, not executed as instructions.

## 4. Dispatch

The job is dispatched to a target:

- in-hub OpenAI-compatible model target;
- external executor target;
- future adapters that implement the same target contract.

Jobs are claimed through the persistent queue and lease model so multi-process deployments can recover abandoned work.

## 5. Tool Invocation

When the model requests a tool call, the tool runtime checks:

- route allowlist;
- tool scope;
- subject requirement;
- risk level;
- rate limits;
- approval or confirmation rules;
- authorization probe result when configured.

Allowed tool calls are signed and sent to the business system. The business system verifies the signature and performs final authorization.

## 6. Approval

High-risk or confirmation-required calls are frozen as approval intents. In production, the business-side workflow should usually own the actual approval decision. The hub records the approval intent and only replays the exact approved argument snapshot.

## 7. Audit, Trace, And Delivery

The hub records trace events, audit records, approvals, messages, delivery attempts, and final result. The business system can poll job status or receive signed callbacks.
