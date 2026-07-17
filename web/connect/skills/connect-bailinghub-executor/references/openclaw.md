# OpenClaw Adapter

Use this recipe when OpenClaw is already installed and has a working model provider. BailingHub does not require a dedicated OpenClaw protocol implementation; the adapter turns one stdin task into one OpenClaw response.

## Prepare a Dedicated Agent

Create or select a dedicated OpenClaw agent for BailingHub execution. Give it only the tools needed for the intended route. Avoid reusing a personal interactive agent with broad local permissions.

Verify the agent can answer one non-interactive prompt before connecting it to BailingHub. If the installed OpenClaw CLI cannot run non-interactively, stop and report that incompatibility.

## Download the Adapter

```bash
curl -fsSL "$HUB_URL/connect/openclaw-stdio.mjs" -o bailing-openclaw.mjs
node --check bailing-openclaw.mjs
```

Use the common Skill workflow with:

```bash
RUNTIME_NAME='openclaw'
BRAIN_CMD='node bailing-openclaw.mjs --agent bailinghub-executor'
```

Replace `bailinghub-executor` only when the user has approved another dedicated OpenClaw agent id.

The adapter preserves BailingHub session context through `BAILING_SESSION_ID`. By default it does not forward `BAILING_TOOL_TOKEN` or other BailingHub business-tool credentials into OpenClaw. Keep that default unless the user explicitly chooses a tool-enabled trust boundary.

## Verification

Use a dedicated test task that requires a simple semantic response. Confirm that:

- OpenClaw generates a new answer rather than echoing stdin.
- the BailingHub job reaches `done`;
- a continuation task reuses the intended session when supported;
- the executor remains online during a model call longer than one heartbeat interval;
- no provider key or executor token appears in logs.

Do not test with production business credentials or a production mutation route.
