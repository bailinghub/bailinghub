# Documentation Map

This directory contains public documentation for the open-source BailingHub project. Internal operations notes, official website planning, and temporary research reports do not belong in the open-source package.

## Getting Started

| Document | Purpose |
|---|---|
| [QUICKSTART.en.md](QUICKSTART.en.md) | Install BailingHub, run the Docker demo, create the first route, and connect the first business tool. |
| [DEMO.en.md](DEMO.en.md) | Docker demo walkthrough: hub, MySQL, demo business system, tool provider, audit, and trace. |
| [user-guide/README.en.md](user-guide/README.en.md) | User and product-owner guide: business goals, console concepts, and scenario-based setup. |
| [CONTRACT.en.md](CONTRACT.en.md) | Stable HTTP and wire contract between business systems and the hub. |
| [INTEGRATION.en.md](INTEGRATION.en.md) | Third-party integration guide for tools, signatures, authorization, and callback handling. |

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

## Release And Maintenance

| Document | Purpose |
|---|---|
| [ECOSYSTEM.en.md](ECOSYSTEM.en.md) | Policy for community distributions, independent implementations, and future ecosystem listings. |
| [ECOSYSTEM.md](ECOSYSTEM.md) | Chinese ecosystem and derivatives policy. |
| [RELEASE_NOTES_v0.1.0.en.md](RELEASE_NOTES_v0.1.0.en.md) | First public release notes. |
| [CHANGELOG.en.md](CHANGELOG.en.md) | Public changelog format and current release summary. |
| [COMPATIBILITY.en.md](COMPATIBILITY.en.md) | Versioning, compatibility, migration, and schema discipline. |

## Maintenance Rules

- Every public Chinese document should have an English companion document unless it is explicitly internal and excluded from the open-source package.
- Public contract changes must update the contract docs, SDK examples, and changelog together.
- Internal decision logs, release rehearsals, and website/console UX rules belong under `internal/`, not in the public package.
- Temporary discussion material should not be added here unless it has become maintained public documentation.
