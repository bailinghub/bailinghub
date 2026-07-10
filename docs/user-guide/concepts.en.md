# Core Concepts

```text
Entry
  -> Route
    -> Target / Agent brain
      -> Context: memory, knowledge, page, image, audio, file
        -> Tool providers: one or more business systems
          -> Approval, audit, and delivery
```

## Route

A route represents one Agent scenario, not an API and not a model. It selects the target, model settings, session policy, knowledge, media strategy, tool sources, approval delivery, retries, budget, and final delivery.

## Caller

A caller is a business-system credential. It receives an `app_id`, token, route allowlist, and rate limit. It answers “which system may trigger which routes.” The final business user is a separate acting subject carried in trusted metadata or a verified widget ticket.

## Target

A target is the brain adapter. The built-in `llm` target calls hosted or local OpenAI-compatible model services. Executor targets let an internal Agent, script, OpenClaw, Codex, Claude Code, or another runtime claim and report work.

## Model Credential

A model credential stores the service URL, API key, default model, and purpose. Credentials may cover chat, image, audio, file, or embedding capabilities. Routes reference credentials; credentials do not define business scenarios.

## Tool Provider

A tool provider is a business system's ACC-enabled OpenAPI document plus its base URL and signing secret. It declares operation names, parameters, scope, risk, acting-subject requirements, approval conditions, and audit sensitivity.

A route may select multiple providers through `tools.sources[]`. Each source has its own scope allowlist and optional subject field. BailingHub applies identity, approval, rate limits, signatures, and audit per source, then exposes one combined tool surface to the Agent. Operation IDs must be unique within a route.

## Knowledge Base

Knowledge bases provide retrievable documents such as manuals, policies, product material, and FAQs. Live order state, stock, permissions, and state-changing actions belong in tools, not static knowledge.

## Web Chat Entry

A web chat entry binds a public widget to a route. A business backend may sign a visitor ticket so the hub can carry a trusted acting subject into business-tool calls.

## Inbound Channel

An inbound channel adapts messages from systems such as WeCom, DingTalk, or Feishu into a route. Channel credentials and reply constraints stay in the channel adapter, not the route core.

## Media Storage And Input Policy

Images, audio, and files are first stored locally or in object storage. Route input policy then decides whether the hub extracts or transcribes them, sends them to a dedicated model, or passes them directly to a capable target.

## Job And Trace

A job is one durable Agent run. The trace records route resolution, context, tools, approvals, target execution, delivery, warnings, and errors.

## Approval Intent

When a high-risk or conditionally approved tool is requested, BailingHub freezes the exact tool and argument snapshot. Approval may happen in the business system or the console fallback. Approval authorizes that snapshot only; changed arguments require a new decision.

## From Requirement To Configuration

For “let logged-in users ask about their order and create a support request,” define:

- a web entry;
- a support route and model target;
- order and ticket tool providers or sources;
- a verified user subject;
- support knowledge;
- the final reply or callback path;
- approval only for operations that require it.

