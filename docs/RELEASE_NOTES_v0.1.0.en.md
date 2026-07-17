# v0.1.0 Release Notes

BailingHub `v0.1.0` is the first public release.

It is a self-hosted Agent control plane for existing business systems and adopts the open contract model of [ACC, the Agent Capability Contract](https://www.agentcapability.org). The independent ACC specification repository is [agent-capability/agent-capability-contract](https://github.com/agent-capability/agent-capability-contract). A business system can trigger jobs, embed a chat entry, or expose selected business tools. The hub handles routing, context assembly, tool governance, approvals, audit trails, traceability, and result delivery.

## Who It Is For

- Teams with existing business systems that want AI agents to call selected business APIs safely.
- Developers who need a self-hosted control plane instead of a hosted chatbot-only product.
- SaaS vendors and integrators that need repeatable AI operation governance.
- Teams that want business-side authorization to remain the final authority.

## Quick Start

To explore the product before installing it, open the [online experience](https://trial.bailinghub.com/console/login), create an account, inspect the console, import demo data, and run diagnostics. Do not upload production credentials or sensitive data, and do not connect real workloads to this environment.

To run the complete loop in your own environment:

```bash
curl -fsSL https://www.bailinghub.com/install.sh | sh
```

Or run from source:

```bash
export BAILING_TOKEN="${BAILING_TOKEN:-$(openssl rand -hex 32)}"
docker compose up --build
```

Open `http://localhost:18900/console/`. The Docker demo account is `admin / bailing-demo-admin`. The one-line installer generates a random password and prints it at the end.

## Included Capabilities

- Hub runtime: trigger routes, DB-backed scheduling, same-thread serialization, lease recovery, graceful shutdown.
- Console: routes, targets, tool providers, clients, channels, credentials, knowledge, trace, diagnostics.
- Tool governance: OpenAPI `x-agent-capability`, allowlists, risk levels, rate limits, approval intent, signatures, audit, trace.
- Knowledge and context: retrieval injection, page context, message ledger, optional rolling summaries.
- Open-source experience: Docker demo, demo business system, one-line installer, schemas, PHP/PHP7/Node/Python/Java/Go/.NET SDK examples.
- Release guardrails: docs link checks, example validation, OSS export guard, release audit, image tag checks.

## Boundaries

- The first public images focus on `linux/amd64`.
- MCP integration is not part of this release.
- Production deployments still need domain, TLS, backups, monitoring, secret management, credential rotation, and business approval workflow integration.
