# BailingHub v0.1.16: Bounded Tool Runtime and Resilient Semantic Retrieval

`v0.1.16` makes tool-enabled agents converge more reliably. The runtime follows each route's own business-tool budget, explicitly guides the model toward a final answer near exhaustion, and prevents internal tool-protocol markup from becoming user-visible or executable content. Optional semantic tool retrieval now uses bounded waits and safe fallback instead of allowing index or embedding failures to block the entire conversation.

This release also aligns the official widget's minimize control with its actual behavior and includes independent community governance recipes for RuoYi-Vue-Pro and JeecgBoot.

## User-visible results

- The existing per-route `tools.max_calls` setting remains the business-tool budget for a task. After every business-tool round, the model receives the used and remaining counts and is guided to avoid an unnecessary final call.
- When the budget is exhausted, BailingHub stops offering tools and requires a natural-language final answer based only on facts already obtained. Missing information must be stated explicitly instead of returning unfinished control text.
- If a model emits DSML-like internal tool-protocol markup as ordinary content, BailingHub clears provisional streamed text and allows one tool-free safe rewrite. Repeated violations fail closed. Text protocol is neither shown as an answer nor parsed for execution.
- Semantic retrieval failures fall back to the existing progressive tool-discovery path instead of blocking the conversation on an optional dependency.
- The official widget replaces the misleading close glyph with a minimize icon, title, and accessible label. The panel-hiding behavior is unchanged.

## Tool-runtime convergence

The route-specific business-tool budget keeps its existing defaults and allowed range. The runtime now adds the following convergence guarantees:

- The model-round bound is derived from the route's business-tool budget and the independently bounded discovery, image, and message tools. A hidden fixed 12-round ceiling no longer truncates a larger valid route budget.
- Trusted budget state is appended after each business-tool execution round.
- With one call remaining, the model is told to use it only when required to complete the request.
- At exhaustion, all tools are removed and the model must enter the final-answer phase.
- Trace events cover near-limit and exhausted budgets, internal-protocol interception, and successful safe rewrites.

`max_calls` still applies only to business tools. `search_tools`, `see_image`, and `send_message` retain their own existing independent limits.

## Final-output safety gate

Both streaming and non-streaming answers are checked for known internal tool-protocol markers:

1. when suspicious control markup appears in a stream, BailingHub stops forwarding it and emits `reset` to discard provisional text from that round;
2. text protocol is never converted into a tool call and its arguments are never executed;
3. the model receives one natural-language rewrite opportunity with no tools available;
4. a repeated violation fails closed instead of presenting a false successful answer.

The streaming protocol remains `bailing.chat.stream.v1`. Custom clients should continue treating every `reset` as an instruction to discard provisional text and `done.reply` as the only authoritative final answer. This release adds the `protocol_violation` reset reason.

## Semantic tool-retrieval resilience

Semantic retrieval remains an optional context enhancement inside the governed allowlist. It does not affect identity, approval, or final business authorization. This release adds:

- sequential background prewarming after HTTP readiness, without blocking startup;
- stale-while-revalidate caching with single-flight refresh;
- bounded waits only for a true cold cache;
- database query timeouts for index and embedding-credential reads;
- abortable HTTP deadlines for query embeddings;
- progressive tool-discovery fallback when the index, credential store, or embedding service is unavailable;
- sanitized diagnostics for cache state and index, credential, embedding, and total latency without recording the user query, service URL, or credential;
- verification of the stored vector model, dimension, and byte length plus the actual length returned by the embedding service; legacy extensions that omit row-level coordinates safely fall back instead of guessing coordinates from a second mutable snapshot;
- serialized same-provider reindexing with authoritative configuration rereads after lock acquisition;
- atomic provider replacement when the embedding model or dimension changes, preserving the old index on failure instead of exposing a partial coordinate system.

Optional deployment-level settings:

| Variable | Default | Allowed range |
|---|---:|---:|
| `BAILING_TOOL_INDEX_LOAD_TIMEOUT_MS` | 5000 ms | 100–60000 ms |
| `BAILING_TOOL_QUERY_EMBEDDING_TIMEOUT_MS` | 15000 ms | 250–120000 ms |

Deployments that omit them automatically use the defaults.

## Independent community recipes

This release includes two auditable governance recipes:

- **RuoYi-Vue-Pro**: a thin-adapter pattern for after-sale detail lookup and refund while preserving original permissions, tenant context, approval, idempotency, and final business authority.
- **JeecgBoot**: a pattern for individual user lookup and freeze/unfreeze actions with operator and target tenant-membership checks, original Shiro permissions, approval, and idempotency.

Each recipe includes Agent-facing OpenAPI, a machine-readable adapter contract, and a local verification script. These are independent community recipes, not official upstream integrations, certifications, or endorsements, and they do not provide a direct adapter that bypasses existing business authorization.

## Compatibility and upgrade impact

- No database migration is required.
- ACC, the Client API version, executor protocol, tool signatures, approval semantics, and final business authorization are unchanged.
- Existing routes do not need to change `tools.max_calls`.
- Both retrieval timeout variables are optional.
- Custom chat clients already implementing `reset` and `done.reply` correctly require no change.
- Existing custom `ToolEmbeddingRepository` implementations remain source-compatible. A repository must implement atomic `replaceProvider` when the embedding model or dimension changes; otherwise reindexing now fails explicitly and preserves the old index instead of performing a non-atomic delete-and-rewrite.

## Validation

```bash
npm run release:check
node docs/integrations/ruoyi-vue-pro/verify_recipe.mjs
node docs/integrations/jeecgboot/verify_recipe.mjs
```

Focused coverage includes:

- route budgets larger than the former fixed model-round ceiling;
- near-limit and exhausted-budget convergence;
- streaming and non-streaming protocol interception, reset, single rewrite, and repeated-violation failure;
- prewarming, stale cache service, single-flight refresh, database and embedding deadlines, and progressive fallback;
- serialized provider reindexing and atomic coordinate replacement;
- widget minimize semantics and existing panel behavior;
- signature, subject, permission, approval, idempotency, and final-authority boundaries in both community recipes.

## Related documentation

- [Tool governance design](TOOLS_DESIGN.en.md)
- [Operations guide](OPERATIONS.en.md)
- [Streaming chat contract](STREAMING.en.md)
- [RuoYi-Vue-Pro recipe](integrations/ruoyi-vue-pro/README.en.md)
- [JeecgBoot recipe](integrations/jeecgboot/README.en.md)
- [Compatibility and upgrades](COMPATIBILITY.en.md)
- [中文发布说明](RELEASE_NOTES_v0.1.16.md)
