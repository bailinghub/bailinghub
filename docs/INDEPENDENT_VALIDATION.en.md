# Independent Validation Task

This task answers one narrow question: **can a developer who is new to BailingHub independently deploy and verify a governed business-operation loop using only public documentation?**

It is not certification, a benchmark, or evidence of production adoption. Passing means that the public installation path and demo governance loop were independently reproducible. It does not mean that the validator connected BailingHub to a real business system.

## Scope

- Target: the open-source BailingHub Docker demo;
- Stable baseline: `v0.1.7`;
- Data: the bundled demo orders, tickets, refunds, and failure probe;
- Expected time: about 20 minutes after images and dependencies are available;
- Not required: a real model key, production API, production credential, or real business data.

Dify, n8n, MCP, and executor/OpenClaw tracks are optional extensions. Complete the core Docker demo before attempting them.

## Prerequisites

Choose one path:

- **One-line install on a fresh server (recommended)**: a non-production Ubuntu/Debian host, `curl`, and working `sudo` or root access. The installer checks and installs Docker and Compose;
- **Local source reproduction**: macOS or Linux, Git, `curl`, OpenSSL, Docker Engine or Docker Desktop, and Docker Compose v2 (`docker compose`).

Both paths validate the same governed demo loop. Do not run this task on a production host, production network, or Docker environment that contains important data.

## 1. Install the stable version

### Path A: fresh Ubuntu/Debian server (recommended)

```bash
curl -fsSL https://www.bailinghub.com/install.sh | sh
cd "$HOME/bailinghub"
```

The installer pulls the official `v0.1.7` images by default, generates random tokens and an admin password, starts the services, and runs the smoke test. Keep the reported version, install mode, elapsed time, and the commands printed under `常用命令`, but never include passwords or tokens in your report. After Docker is installed, the current non-root login usually still needs the printed `sudo docker compose ...` commands; Docker group membership may not take effect until the next login.

If the default directory is already in use, choose a new empty directory instead of overwriting an existing deployment:

```bash
curl -fsSL https://www.bailinghub.com/install.sh | env \
  BAILING_INSTALL_DIR="$HOME/bailinghub-validation" \
  sh
cd "$HOME/bailinghub-validation"
```

### Path B: local source reproduction

```bash
git clone --depth 1 --branch v0.1.7 https://github.com/bailinghub/bailinghub.git
cd bailinghub
git rev-parse HEAD
export BAILING_TOKEN="$(openssl rand -hex 32)"
docker compose up -d --build
```

Keep the commit SHA and run the remaining commands in the same terminal with the same `BAILING_TOKEN`. All write operations are confined to local demo data.

## 2. Check the services and console

For Path A, use the complete Compose prefix printed by the installer. Immediately after Docker is installed, it will usually be:

```bash
sudo docker compose -f docker-compose.images.yml ps
```

For Path B, use:

```bash
docker compose ps
```

For both paths, check health:

```bash
curl -fsS http://localhost:18900/health
```

The console is available at <http://localhost:18900/console/>:

- Path A uses the random admin password printed when installation completes. It is also stored in the installation directory's `.env`; never attach that file to an Issue;
- Path B uses the default demo account `admin / bailing-demo-admin`.

## 3. Run the smoke test

For Path A, use the command printed by the installer, usually:

```bash
sudo docker compose -f docker-compose.images.yml exec -T bailinghub npm run smoke
```

For Path B, use:

```bash
docker compose exec -T bailinghub npm run smoke
```

Pass criteria: the process exits with code `0` and the final summary reports zero failures.

## 4. Run the governed business loop

For Path A, use the command printed by the installer, usually:

```bash
sudo docker compose -f docker-compose.images.yml exec -T bailinghub npm run demo:e2e
```

For Path B, use:

```bash
docker compose exec -T bailinghub npm run demo:e2e
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

- BailingHub version, installation path, and the commit SHA when using the source path;
- operating system, CPU architecture, Docker, and Compose versions;
- the four checkpoint results;
- elapsed time excluding image downloads;
- the first blocker and sanitized logs;
- whether public docs were sufficient and which step was unclear.

**Never include** `BAILING_TOKEN`, client or executor tokens, admin credentials, model keys, a complete `.env`, personal information, or production business data.

## Optional extensions

After the core task passes, you may continue with:

- [Integration overview and first-success criteria](https://www.bailinghub.com/en/integrations);
- [Dify integration recipe](integrations/dify/README.en.md);
- [n8n community node](https://github.com/bailinghub/bailinghub-n8n-node);
- [MCP server](https://github.com/bailinghub/bailinghub-mcp-server);
- [Executor onboarding and OpenClaw adapter](https://github.com/bailinghub/bailinghub-openclaw-skill).
- [Real web chat streaming and reconnectable SSE](RELEASE_NOTES_v0.1.4.en.md).
- [Reliable one-line installer arguments and clean-server compatibility](RELEASE_NOTES_v0.1.5.en.md).
- [Independent validation paths and post-install privilege hints](RELEASE_NOTES_v0.1.6.en.md).
- [Versioned Client API and cross-ecosystem compatibility gates](RELEASE_NOTES_v0.1.7.en.md).

Select the relevant track in the same Issue form and disclose whether you received direct maintainer assistance.

## Clean up

When you no longer need the local demo data, run this from the repository directory:

```bash
# Path A: keep the Compose prefix printed by the installer
sudo docker compose -f docker-compose.images.yml down -v

# Path B
docker compose down -v
```

If Path A was run as root, or the current user already has Docker socket access, omit `sudo`. Run only the cleanup command for the path you selected.

This removes the containers and local volumes created for the demo.
