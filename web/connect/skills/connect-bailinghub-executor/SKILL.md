---
name: connect-bailinghub-executor
description: Connect a local AI agent, CLI, or script to a BailingHub executor target through the target-scoped claim, heartbeat, and result channel. Use when a BailingHub HUB_URL and TARGET are supplied and this machine should become a persistent executor without exposing an inbound port.
---

# Connect BailingHub Executor

Turn a local non-interactive agent or command into a persistent BailingHub executor. Keep the BailingHub protocol in the official wrapper unless the runtime can reliably own a long-running claim loop.

## Required Inputs

Obtain all of these before installing anything:

- `HUB_URL`: the BailingHub origin, without a trailing slash.
- `TARGET`: the exact registered executor target.
- `EXECUTOR_ID`: a stable, user-approved name for this machine and runtime.
- A target-scoped executor token issued in the BailingHub console.
- A trusted, non-interactive brain command that reads one task from stdin, writes only its final answer to stdout, and exits non-zero on failure.

Do not guess a missing value. Treat any supplied route name as context only; executors claim by `TARGET`, not by route.

## Security Invariants

- Ask the user to enter the executor token locally through hidden input or an approved secret manager. Never ask them to paste it into chat.
- Pass the token through `BAILING_EXECUTOR_TOKEN`. Do not place it in command arguments, scripts, repositories, screenshots, or logs.
- Use a token scoped only to the required target and keep the executor on an outbound-only connection.
- Do not forward BailingHub business-tool credentials to another runtime unless the user explicitly enables and understands that boundary.
- Never use `cat` or another echo command on a live route. A successful echo proves transport only and can return user messages unchanged.

## Preflight

1. Confirm that the machine has a shell, Node.js 18 or newer, outbound HTTPS access to `HUB_URL`, and a way to keep a process alive.
2. Confirm that `TARGET` exists and that the token is authorized for it.
3. Confirm the exact brain command. It must support non-interactive stdin-to-stdout execution.
4. If any prerequisite is missing, stop and report the missing capability instead of inventing a replacement.

## Choose the Connection Mode

Use the generic wrapper by default. It owns long polling, independent heartbeat, stale-result protection, retries, and process environment assembly.

Use direct protocol mode only when the current runtime can reliably maintain a persistent process and implement every protocol invariant. Read [Direct protocol](references/direct-protocol.md) before doing so.

For OpenClaw, read [OpenClaw adapter](references/openclaw.md) after completing the common preflight.

## Install the Generic Wrapper

Work in a user-approved local directory, then download and inspect the official single-file wrapper:

```bash
curl -fsSL "$HUB_URL/connect/executor.mjs" -o bailing-executor.mjs
node --check bailing-executor.mjs
```

Have the user enter the token locally without echoing it:

```bash
read -rsp 'BailingHub executor token: ' BAILING_EXECUTOR_TOKEN
printf '\n'
export BAILING_EXECUTOR_TOKEN
```

Start the wrapper in an attached terminal for the first verification. Substitute the approved values without changing their meaning:

```bash
node bailing-executor.mjs \
  --hub "$HUB_URL" \
  --targets "$TARGET" \
  --executor-id "$EXECUTOR_ID" \
  --runtime "$RUNTIME_NAME" \
  --cmd "$BRAIN_CMD"
```

The brain command receives the task text on stdin. It can also read `BAILING_JOB_ID`, `BAILING_REQUEST_ID`, `BAILING_TARGET`, `BAILING_PROFILE`, `BAILING_SESSION_ID`, `BAILING_IS_CONTINUE`, `BAILING_METADATA`, and `BAILING_PROJECT_PATH`.

After an attached test succeeds, move the same command and secret into the machine's existing supervisor, such as systemd, launchd, or pm2. Do not claim persistence until restart behavior is verified.

## Verify the Connection

Verify all of the following:

1. The BailingHub console shows `EXECUTOR_ID` online under the exact `TARGET`.
2. A dedicated test task is claimed and reaches a terminal status.
3. The returned content is a real processed answer, not an unchanged copy of the input.
4. Stopping the process makes the executor become offline, and restarting it restores the same `EXECUTOR_ID`.
5. No token appears in process arguments, shell history, logs, or the final report.

## Report Completion

Report only:

- executor id
- target
- runtime and brain command type, without secrets
- persistence mechanism
- verification result and any remaining limitation

Never include the executor token or task-level tool credentials.
