# Scenario-Based Setup

## 1. Read-Only Business Query Agent

**Goal:** query orders, members, tickets, stock, or devices without changing state.

1. Register and validate a chat model credential.
2. Register the business OpenAPI JSON/YAML in Tool Providers.
3. Create a route using target `llm`.
4. Add the provider under `tools.sources[]` and allow only read scopes.
5. Add more sources if the answer spans systems, such as orders plus shipping.
6. Set `subject_field` when queries require a trusted business user.
7. Create a caller allowed to invoke the route.

Deliver the route key, caller token, `/run` example, signing secret, and subject-field requirement to developers.

## 2. Web Support Assistant

**Goal:** embed a conversation that can answer policy questions, query orders, and create support tickets.

Create a model credential, support knowledge base, order/ticket tool sources, support route, and web chat entry. Configure allowed origins and a signed visitor ticket for logged-in users. Give frontend developers the widget code and backend developers the ticket and tool-signature contracts.

## 3. Refund Request With Approval

**Goal:** let the Agent investigate and create a refund request without silently performing an irreversible refund.

Expose read-only order lookup and refund estimation separately from the write operation. Prefer a business API that creates a pending refund request. Mark immediate financial execution as high risk or approval-required. Configure business webhook approval when the existing business approval system should own reviewer assignment.

## 4. Internal Knowledge Agent

Create chat and embedding credentials, ingest manuals or policies into a knowledge base, verify retrieval, bind the base to a route, and expose the route through an internal caller, widget, or channel. Use tools instead of knowledge for live data.

## 5. Backend-Triggered Agent Task

Create the route and caller, configure callback or polling, and use the generated `/run` example from the route row. Use a business-unique `request_id` for idempotency. Put object IDs, acting subject, and session key in metadata.

## 6. Local Model Or Ollama

Run an OpenAI-compatible local endpoint such as Ollama, vLLM, or Xinference. Register its base URL and model as a Model Credential, Validate it, then select it in an `llm` route. Ensure the hub can reach the local endpoint from its network namespace.

## 7. Existing Agent, Script, OpenClaw, Codex, Or Claude Code

Register an executor target, issue an executor token, and run the generic executor or implement the claim/result protocol. The executor may call the same governed business-tool proxy using the work item's short-lived `tool_token`.

## 8. Images, Audio, And Files

Configure local or object media storage, then choose route input policy per type:

- images: dedicated vision tool, prepass recognition, or direct multimodal input;
- audio: hub transcription or direct audio input;
- files: local extraction, extract-and-summarize, or direct file input.

Validate that the selected model actually supports the chosen mode. Unsupported media must produce an explicit degradation message rather than fabricated understanding.

## 9. Page-Aware Assistant

Register page-context rules for a web chat entry and enable page-aware knowledge retrieval on the route. The widget reports the current URL, the hub resolves it to a registered page description, and retrieval uses that context as a relevance boost.

## 10. Pre-Launch Verification

1. Run Model Credential Validate.
2. Review tool compilation and authorization probe.
3. Run System Diagnostics and clear configuration errors.
4. Confirm `/health` and `/health/ready` return 200.
5. Run smoke and a real end-to-end route.
6. Inspect the resulting job trace, tool result, approval behavior, and delivery.
7. Verify backup restoration and operational alerts.

Developers should continue with [CONTRACT.en.md](../CONTRACT.en.md), [INTEGRATION.en.md](../INTEGRATION.en.md), [TOOLS_DESIGN.en.md](../TOOLS_DESIGN.en.md), and [OPERATIONS.en.md](../OPERATIONS.en.md).

