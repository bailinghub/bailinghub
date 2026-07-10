# Contributing

Thanks for helping improve BailingHub.

## Development

Requirements:

- Node.js 22 or newer;
- MySQL 8 for full runtime features;
- Docker Compose for the local demo.

Useful commands:

```bash
npm install
npm run doctor
npm run typecheck
npm test
npm run sdk:test
npm run sdk:test7
docker compose up --build
```

`npm run doctor` is the default pre-flight check for contributors. It validates local prerequisites, docs/examples, secret hygiene, and open-source package boundaries. Use `BAILING_DOCTOR_FULL=1 npm run doctor` before larger PRs; use `BAILING_DOCTOR_SMOKE=1 npm run doctor` only when a hub is running locally or remotely.

## Pull Request Checklist

- Keep core contracts backward-compatible unless the change is intentionally major.
- Add or update tests for behavior changes.
- Update docs when changing public APIs, SDK behavior, config shape, database schema, or console workflows.
- Add new database changes as a new numbered file in `sql/`; do not edit already published migration files.
- Do not commit secrets, local config, generated logs, or private deployment details.
- Include validation evidence in the PR description: commands run, important manual checks, and any known gaps.
- Avoid refactor-only PRs unless the issue or maintainer discussion has already established a concrete architectural goal.

## Contribution Routing

| Change type | Expected route |
|---|---|
| Bug fix or regression | Issue or PR with reproduction, expected behavior, and validation evidence. |
| Documentation correction | Direct docs PR is fine if it does not change public contracts. |
| New channel, model provider, storage backend, or business integration | Prefer `src/adapters`, SDKs, examples, or an external package. Core should only change if a reusable contract is missing. |
| New core contract or governance primitive | Open an issue first with problem statement, alternatives, compatibility impact, and test plan. |
| Database schema change | Add a new numbered migration in `sql/`, update docs, and add tests or smoke coverage where practical. |
| Marketplace or third-party plugin distribution | Deferred until provenance, signing, sandboxing, review, and vulnerability response are designed. |

## Architecture Boundaries

- `src/core` contains pure contracts, config models, runtime primitives, platform utilities, state interfaces, and target abstractions.
- `src/app` composes runtime services, HTTP primitives, scheduling, delivery, tools, and lifecycle.
- `src/infrastructure` contains storage and repository implementations.
- `src/adapters` contains concrete integrations.
- `src/services` contains reusable service modules such as knowledge and tool indexing.

Core should not contain private deployment assumptions, hard-coded business channels, provider-specific credentials, or industry-specific workflows. The control plane must remain useful to any traditional system that can expose HTTP tools and consume HTTP callbacks.

Run the architecture boundary tests before submitting changes:

```bash
npm test
```

## Community Distributions And Independent Implementations

BailingHub welcomes independently maintained distributions, industry adaptations, ecosystem components, and ACC implementations. Community projects may keep their own names, roadmaps, maintainer teams, and governance. They are not required to contribute every modification upstream.

Reusable improvements are welcome as Issues, Discussions, or Pull Requests. Strong independent projects may also request a future listing through the official BailingHub ecosystem surface, provided that their origin, maintainers, compatibility, and independent status are clear. A listing is not certification, warranty, endorsement, or a transfer of maintenance responsibility.

See [Community Derivatives And Ecosystem Collaboration](docs/ECOSYSTEM.en.md) for the complete policy and [中文说明](docs/ECOSYSTEM.md) for the Chinese version.

## License

By contributing, you agree that your contributions are licensed under the Apache License 2.0.
