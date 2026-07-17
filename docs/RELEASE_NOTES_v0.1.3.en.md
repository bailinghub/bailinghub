# v0.1.3 Release Notes

BailingHub `v0.1.3` turns “make another agent an executor” from a long manual instruction block into a reusable Skill, a minimal bootstrap, and a representative OpenClaw adapter. It adds no database migration and does not change public HTTP, SDK, or signature formats.

## Highlights

### 1. Portable executor onboarding Skill

The public `connect-bailinghub-executor` Skill explains:

- when to use the generic command wrapper, the OpenClaw adapter, or the direct protocol;
- how to enter and store the executor token locally;
- how to confirm `EXECUTOR_ID`, target, and runtime metadata;
- how to verify presence, claim, execution, result reporting, and audit evidence.

The console now copies only the hub URL, target, route context, and Skill URL instead of embedding the complete protocol in chat.

### 2. OpenClaw stdio adapter

`web/connect/openclaw-stdio.mjs`:

- reads a BailingHub task from stdin;
- invokes a local OpenClaw agent;
- maps and resumes hub sessions;
- writes only the final answer to stdout so logs cannot corrupt the result;
- does not forward business-tool credentials to the OpenClaw child process by default.

### 3. Generic executor hardening

- `BAILING_EXECUTOR_TOKEN` is preferred so secrets stay out of shell history and process arguments; `--token` remains compatible.
- Heartbeats are independent of the claim loop, so long-running jobs keep the executor online.
- Result reports include the dispatch `claim_token`, allowing the hub to reject stale results after reassignment.

## Before upgrading

1. The hub still requires Node.js `22+`; the portable generic executor itself supports Node.js `18+`.
2. New integrations should store the executor token in `BAILING_EXECUTOR_TOKEN` or a local secret manager.
3. Existing `--token` commands continue to work and do not need an immediate change.

## Compatibility

- No database migration.
- `/run`, SDKs, business-tool signatures, and existing executor HTTP endpoints are unchanged.
- The Skill and OpenClaw adapter are optional onboarding capabilities.
- Final business authorization remains with the business system.

## Validation

The release is checked with:

- `npm run typecheck`
- `npm test`
- `npm --prefix web-admin run build`
- `npm run release:check`
- a representative OpenClaw end-to-end execution
