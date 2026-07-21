# Documentation Map

This directory contains public documentation for the open-source BailingHub project. Internal operations notes, official website planning, and temporary research reports do not belong in the open-source package.

## Getting Started

| Document | Purpose |
|---|---|
| [QUICKSTART.en.md](QUICKSTART.en.md) | Install BailingHub, run the Docker demo, create the first route, and connect the first business tool. |
| [DEMO.en.md](DEMO.en.md) | Docker demo walkthrough: hub, MySQL, demo business system, tool provider, audit, and trace. |
| [INDEPENDENT_VALIDATION.en.md](INDEPENDENT_VALIDATION.en.md) | Independent Docker demo task with objective pass criteria and a standard report path. |
| [INDEPENDENT_VALIDATION.md](INDEPENDENT_VALIDATION.md) | Chinese independent validation task. |
| [user-guide/README.en.md](user-guide/README.en.md) | User and product-owner guide: business goals, console concepts, and scenario-based setup. |
| [CONTRACT.en.md](CONTRACT.en.md) | Stable HTTP and wire contract between business systems and the hub. |
| [INTEGRATION.en.md](INTEGRATION.en.md) | Third-party integration guide for tools, signatures, authorization, and callback handling. |
| [integrations/dify/README.en.md](integrations/dify/README.en.md) | Minimal Dify integration through the governed BailingHub `/run` and `/jobs/{job_id}` APIs. |
| [integrations/dify/README.md](integrations/dify/README.md) | Chinese Dify + BailingHub minimal integration recipe. |

## Architecture And Models

| Document | Purpose |
|---|---|
| [ARCHITECTURE.en.md](ARCHITECTURE.en.md) | Architecture overview: layers, runtime path, boundaries, and extension points. |
| [PIPELINE.en.md](PIPELINE.en.md) | Runtime pipeline from trigger to dispatch, tools, audit, approval, and delivery. |

## Runtime Capabilities

| Document | Purpose |
|---|---|
| [TOOLS_MODEL.en.md](TOOLS_MODEL.en.md) | Unified tool definition model across OpenAPI, SDK, overlays, and future adapters. |
| [TOOLS_DESIGN.en.md](TOOLS_DESIGN.en.md) | Tool governance design: allowlists, risk, rate limits, approvals, audit, and signatures. |
| [AI_FRIENDLY_TOOLS.en.md](AI_FRIENDLY_TOOLS.en.md) | How to design business APIs as AI-friendly tools without exposing raw backend CRUD. |
| [TOOLS.en.md](TOOLS.en.md) | Practical tool provider and governance guide. |
| [SDK.en.md](SDK.en.md) | SDK guide for PHP, Node, Python, Java, Go, .NET, and any-language OpenAPI/HMAC integration. |
| [CHANNELS.en.md](CHANNELS.en.md) | Inbound channel model and adapter expectations. |
| [OPERATIONS.en.md](OPERATIONS.en.md) | Production topology, readiness, capacity, upgrades, backups, and recovery. |
| [STREAMING.en.md](STREAMING.en.md) | Chat streaming protocol, reconnect behavior, canonical final result, and multi-replica boundary. |
| [STREAMING.md](STREAMING.md) | Chinese chat streaming protocol. |

## Release And Maintenance

| Document | Purpose |
|---|---|
| [ECOSYSTEM.en.md](ECOSYSTEM.en.md) | Policy for community distributions, independent implementations, and future ecosystem listings. |
| [ECOSYSTEM.md](ECOSYSTEM.md) | Chinese ecosystem and derivatives policy. |
| [RELEASE_NOTES_v0.1.1.en.md](RELEASE_NOTES_v0.1.1.en.md) | `v0.1.1` release notes for widget operations and stricter integration boundaries. |
| [RELEASE_NOTES_v0.1.1.md](RELEASE_NOTES_v0.1.1.md) | Chinese `v0.1.1` release notes. |
| [RELEASE_NOTES_v0.1.2.en.md](RELEASE_NOTES_v0.1.2.en.md) | `v0.1.2` server-token and derived-credential security hardening. |
| [RELEASE_NOTES_v0.1.2.md](RELEASE_NOTES_v0.1.2.md) | Chinese `v0.1.2` release notes. |
| [RELEASE_NOTES_v0.1.3.en.md](RELEASE_NOTES_v0.1.3.en.md) | `v0.1.3` portable executor onboarding and OpenClaw adapter release notes. |
| [RELEASE_NOTES_v0.1.3.md](RELEASE_NOTES_v0.1.3.md) | Chinese `v0.1.3` release notes. |
| [RELEASE_NOTES_v0.1.4.en.md](RELEASE_NOTES_v0.1.4.en.md) | `v0.1.4` real web chat streaming and reconnectable SSE release notes. |
| [RELEASE_NOTES_v0.1.4.md](RELEASE_NOTES_v0.1.4.md) | Chinese `v0.1.4` release notes. |
| [RELEASE_NOTES_v0.1.5.en.md](RELEASE_NOTES_v0.1.5.en.md) | `v0.1.5` installer reliability and clean-server compatibility release notes. |
| [RELEASE_NOTES_v0.1.5.md](RELEASE_NOTES_v0.1.5.md) | Chinese `v0.1.5` release notes. |
| [RELEASE_NOTES_v0.1.6.en.md](RELEASE_NOTES_v0.1.6.en.md) | `v0.1.6` independent-validation and post-install privilege-hint release notes. |
| [RELEASE_NOTES_v0.1.6.md](RELEASE_NOTES_v0.1.6.md) | Chinese `v0.1.6` release notes. |
| [RELEASE_NOTES_v0.1.0.en.md](RELEASE_NOTES_v0.1.0.en.md) | First public release notes. |
| [CHANGELOG.en.md](CHANGELOG.en.md) | Public changelog format and current release summary. |
| [COMPATIBILITY.en.md](COMPATIBILITY.en.md) | Versioning, compatibility, migration, and schema discipline. |

## Maintenance Rules

- Every public Chinese document should have an English companion document unless it is explicitly internal and excluded from the open-source package.
- Public contract changes must update the contract docs, SDK examples, and changelog together.
- Internal decision logs, release rehearsals, and website/console UX rules belong under `internal/`, not in the public package.
- Temporary discussion material should not be added here unless it has become maintained public documentation.
