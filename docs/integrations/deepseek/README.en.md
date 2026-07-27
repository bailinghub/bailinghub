# DeepSeek + BailingHub Bilingual E2E Recipe

> Status: BailingHub has updated its DeepSeek V4 model catalog and added automated compatibility coverage for streaming responses and thinking-mode tool-call rounds. A real, harmless E2E against the official DeepSeek API is still pending a temporary API key. This document does not imply a DeepSeek partnership, certification, or endorsement.

[中文](README.md)

## Problem And Boundary

DeepSeek can interpret a user goal, generate a response, and propose tool calls. It should not hold business-system credentials or bypass governance to call refund, inventory, account, or approval APIs freely.

The intended path is:

```text
user / channel
  -> BailingHub route
  -> DeepSeek V4                  interpret the goal and propose tool calls
  -> BailingHub tool runtime      allowlist, subject, risk, approval, audit, idempotency
  -> business API                 final authorization remains in the business system
```

The responsibilities stay separate:

- DeepSeek is the model and task planner.
- BailingHub is the self-hosted governance control plane for business actions.
- The business system remains the final authority for permissions and business rules.

## Current Compatibility Baseline

As of 2026-07-27, the current text models in the official DeepSeek API are:

- `deepseek-v4-flash`
- `deepseek-v4-pro`

Official OpenAI-compatible base URL:

```text
https://api.deepseek.com
```

The legacy `deepseek-chat` and `deepseek-reasoner` aliases are no longer in the current model catalog and should not be used as defaults for new configurations. Model names will continue to evolve, so check the official DeepSeek documentation before deployment.

Both current models support text, streaming, and tool calls. BailingHub uses its provider-neutral OpenAI-compatible adapter rather than adding DeepSeek-specific route semantics.

## Why `reasoning_content` Must Round-Trip

DeepSeek thinking mode can return `reasoning_content` in a tool-call response. After executing the requested tool, the caller must include that field in the assistant message sent in the next model request.

BailingHub's generic adapter now:

1. aggregates fragmented `reasoning_content` from streaming responses;
2. does not emit it as user-visible answer text;
3. preserves it in the next model round after tool execution;
4. continues to use `content` for the user-visible answer.

This is OpenAI-compatible message handling. It is not an ACC Core field and does not change BailingHub's tool-governance semantics.

## Prerequisites

Prepare:

- a self-hosted BailingHub instance using MySQL;
- a dedicated BailingHub Client Token;
- a harmless test route with no business tools or write operations;
- a fresh DeepSeek API key that can be rotated after the test.

Do not use:

- a BailingHub admin token;
- an executor token;
- a business-system secret;
- a production subject credential;
- test input containing real customer data.

## 1. Create The Model Credential

In the BailingHub console, open Model Credentials and create:

| Field | Suggested value |
| --- | --- |
| Name | `deepseek-main` |
| Provider | DeepSeek |
| Base URL | `https://api.deepseek.com` |
| API Key | temporary DeepSeek test key |
| Default model | `deepseek-v4-flash` |

The key stays in BailingHub. Never place it in a route, job input, article, screenshot, or repository.

## 2. Create A Harmless Test Route

Create a dedicated Trigger Route:

| Field | Suggested value |
| --- | --- |
| Route key | `deepseek-e2e` |
| Target | `llm` |
| Model credential | `deepseek-main` |
| Model | `deepseek-v4-flash`, or empty to use the credential default |
| System prompt | `Follow the user instruction exactly. Do not call any tool.` |
| Tool sources | none |
| Built-in tools | none |
| Streaming | may be enabled |

This first stage verifies only that:

- BailingHub can call the official DeepSeek API;
- Chinese and English inputs return the expected marker;
- a streaming response converges to the authoritative job result;
- no real business API is touched.

## 3. Create A Dedicated Client

Create a test client that can use only `deepseek-e2e`:

- issue a dedicated Client Token;
- set `allowed_routes` to only `deepseek-e2e`;
- configure a low per-minute rate limit;
- disable the client or rotate the token after validation.

## 4. Run Chinese And English E2E

The verifier uses only the Python standard library. It never prints the token or the full job payload.

Chinese:

```bash
BAILINGHUB_TOKEN='<dedicated client token>' \
python3 verify_e2e.py \
  --base-url 'https://hub.example.com' \
  --route 'deepseek-e2e' \
  --input '请只返回 DEEPSEEK_BAILINGHUB_E2E_OK，不要调用任何工具。'
```

English:

```bash
BAILINGHUB_TOKEN='<dedicated client token>' \
python3 verify_e2e.py \
  --base-url 'https://hub.example.com' \
  --route 'deepseek-e2e'
```

Pass criteria:

1. `/run` returns a `job_id` and the same `request_id`.
2. The job reaches `done` within the bounded timeout.
3. The authoritative job record contains `DEEPSEEK_BAILINGHUB_E2E_OK`.
4. No API key or Client Token appears in logs or terminal output.
5. No business tool is invoked.

## 5. Add Governed Tools Separately

After the harmless E2E passes, add real tool sources or built-in tools to a separate business route.

A model tool call is a proposal, not an authorization. BailingHub still checks:

- whether the tool is on the route allowlist;
- whether the trusted subject requirement is satisfied;
- whether risk or conditional approval applies;
- whether arguments match the approved snapshot;
- whether idempotency, rate limits, and audit constraints hold;
- whether the business system grants final authorization.

Do not attach production write tools to the harmless validation route merely to test model tool selection.

## Verified And Not Claimed

Verified by implementation and automated tests:

- the official DeepSeek base URL and current V4 suggestions are in the console catalog;
- JSON and SSE OpenAI-compatible responses are parsed;
- streaming `reasoning_content` is aggregated without becoming visible answer text;
- thinking-mode tool calls preserve `reasoning_content` in the next request;
- the compatibility work does not modify ACC Core or transfer business authority to the model.

Until the real API E2E is complete, this project does not claim:

- a completed Chinese and English test against the official DeepSeek API;
- reliable tool selection for every model and prompt;
- an official DeepSeek partnership, certification, or endorsement;
- display, storage, or audit of a model's full chain of thought;
- provider-beta strict tool-call behavior as a stable BailingHub contract.

## Security Closeout

After live validation:

1. rotate or delete the temporary DeepSeek API key;
2. disable the test client or rotate its token;
3. retain only the sanitized status sequence, BailingHub version, model ID, and test time;
4. do not retain reasoning content, credentials, or real customer data as public evidence.

## Primary References

- [DeepSeek API Pricing and Models](https://api-docs.deepseek.com/quick_start/pricing)
- [DeepSeek List Models API](https://api-docs.deepseek.com/api/list-models)
- [DeepSeek Tool Calls](https://api-docs.deepseek.com/guides/tool_calls)
- [DeepSeek Thinking Mode](https://api-docs.deepseek.com/guides/thinking_mode)
- [DeepSeek Integrations](https://github.com/deepseek-ai/awesome-deepseek-integration)
- [BailingHub HTTP contract](../../CONTRACT.en.md)
- BailingHub `src/adapters/llm/openai-chat-stream.ts`
- BailingHub `src/adapters/targets/llm.ts`
