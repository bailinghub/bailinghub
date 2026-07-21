# Independent Validation Task

This task answers one narrow question: **can a developer who is new to BailingHub independently deploy and verify a governed business-operation loop using only public documentation?**

It is not certification, a benchmark, or evidence of production adoption. Passing means that the public installation path and demo governance loop were independently reproducible. It does not mean that the validator connected BailingHub to a real business system.

## Scope

- Target: the open-source BailingHub Docker demo;
- Stable baseline: `v0.1.5`;
- Data: the bundled demo orders, tickets, refunds, and failure probe;
- Expected time: about 20 minutes after images and dependencies are available;
- Not required: a real model key, production API, production credential, or real business data.

The Dify and executor tracks are optional extensions. Complete the core Docker demo before attempting them.

## Prerequisites

- macOS or Linux;
- Git, `curl`, and OpenSSL;
- Docker Engine or Docker Desktop;
- Docker Compose v2 (`docker compose`).

## 1. Get the stable version

```bash
git clone --depth 1 --branch v0.1.5 https://github.com/bailinghub/bailinghub.git
cd bailinghub
git rev-parse HEAD
```

Keep the commit SHA for your report.

## 2. Start the local demo

```bash
export BAILING_TOKEN="$(openssl rand -hex 32)"
docker compose up -d --build
docker compose ps
```

Run the remaining commands in the same terminal with the same `BAILING_TOKEN`. All write operations are confined to local demo data.

After the containers become ready, check health:

```bash
curl -fsS http://localhost:18900/health
```

The console is available at <http://localhost:18900/console/>. Log in with `admin / bailing-demo-admin`.

## 3. Run the smoke test

```bash
docker compose exec bailinghub npm run smoke
```

Pass criteria: the process exits with code `0` and the final summary reports zero failures.

## 4. Run the governed business loop

```bash
docker compose exec bailinghub npm run demo:e2e
```

The command exercises these real local-demo paths:

1. query an order and create a support ticket;
2. create a business-side approval intent for a high-risk refund;
3. approve it in the demo business system and execute only the approved call;
4. return a 5xx from the failure probe while preserving a traceable task.

Pass criteria: the process exits with code `0` and ends with:

```text
结果：demo e2e passed
```

## 5. Record the result

Record all four checkpoints:

| Checkpoint | PASS criteria |
|---|---|
| Services | Services are healthy in `docker compose ps`, and `/health` is reachable |
| Console | You can log in and inspect the demo configuration |
| Smoke | `npm run smoke` exits with code 0 and zero failures |
| Business loop | `npm run demo:e2e` exits with code 0 and prints `结果：demo e2e passed` |

Whether the result is PASS, partial, or failed, please use the [independent validation report](https://github.com/bailinghub/bailinghub/issues/new?template=independent_validation.yml). Include:

- BailingHub version and commit SHA;
- operating system, CPU architecture, Docker, and Compose versions;
- the four checkpoint results;
- elapsed time excluding image downloads;
- the first blocker and sanitized logs;
- whether public docs were sufficient and which step was unclear.

**Never include** `BAILING_TOKEN`, client or executor tokens, admin credentials, model keys, a complete `.env`, personal information, or production business data.

## Optional extensions

After the core task passes, you may continue with:

- [Dify integration recipe](integrations/dify/README.en.md);
- [Executor onboarding and OpenClaw adapter](RELEASE_NOTES_v0.1.3.en.md).
- [Real web chat streaming and reconnectable SSE](RELEASE_NOTES_v0.1.4.en.md).
- [Reliable one-line installer arguments and clean-server compatibility](RELEASE_NOTES_v0.1.5.en.md).

Select the relevant track in the same Issue form and disclose whether you received direct maintainer assistance.

## Clean up

When you no longer need the local demo data, run this from the repository directory:

```bash
docker compose down -v
```

This removes the containers and local volumes created for the demo.
