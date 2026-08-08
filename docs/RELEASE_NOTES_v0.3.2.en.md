# BailingHub v0.3.2: Managed Demo Dataset Onboarding

`v0.3.2` makes empty-instance demo import a Core-owned onboarding capability. Administrators can import a deterministic set of targets, tool providers, routes, and clients from the console, inspect or exercise them through a real smoke run, and later clear only the configuration that Core can still prove it owns. No external data fork or hidden initialization path is required.

## Who should upgrade

- Deployments that want new users to understand targets, tool providers, routes, and clients from an empty instance;
- self-hosted environments that need repeatable import, refresh, and clear operations for the official demo configuration;
- Kernel Host API consumers that want the same onboarding model in each isolated Core.

Existing instances do not import anything automatically. The console shows the action only when Demo Business is configured and the current principal has the aggregate write permissions.

## What changed

- Adds `GET /admin/api/demo-dataset/status`, `POST /admin/api/demo-dataset/import`, and `DELETE /admin/api/demo-dataset`.
- Adds an empty-instance console prompt plus import, refresh, and clear actions on the setup page.
- Core stores a durable ownership manifest and fixed fingerprints for the demo objects it creates. Existing names, user modifications, or external references return `409`; the service never guesses ownership or overwrites user configuration.
- Import and clear run inside a transaction and a dataset-level advisory lock. First creation uses conflict-closed inserts so concurrent requests cannot replace same-name objects.
- Clear removes only demo configuration that the manifest still proves is owned, unchanged, and unreferenced. Jobs, messages, traces, and audit entries are real runtime history and remain intact.
- `demo-business` now has two explicit profiles:
  - `full-local` retains the Docker demo for order lookup, ticket creation, refund approval, and failure diagnosis;
  - `stateless-readonly` requires loopback binding and exposes only signed order lookup and a failure probe, with no mutable state, business writes, or approval callbacks.

## Database and upgrade

Migration `054_demo_dataset_state.sql` adds `bz_demo_datasets`. It stores only the dataset version, owned-resource manifest and fingerprints, and timestamps. Run the official migrator before restarting:

```bash
npm run db:init
```

Hosts that compose Core through Kernel Host API v1 should keep using their existing explicit migration and drain workflow.

## Configuration

To enable console import, provide:

```bash
DEMO_BUSINESS_URL=http://127.0.0.1:19080
DEMO_TOOL_SECRET=<independent-random-secret>
DEMO_PROFILE=stateless-readonly
```

Shared or embedded environments must use `stateless-readonly`, a loopback URL, and independent random signing material. The value is stored in each tenant's demo tool provider and can be revealed by a tenant administrator with the relevant management permission, so it must never be reused as a platform, tenant, or real business secret.

## Compatibility and validation

- Client API, Kernel Host API v1, the chat protocol, Executor Protocol, ACC, tool signatures, approval semantics, and final business authorization remain compatible.
- Production instances without Demo Business configuration keep their existing behavior: demo status is unavailable and the console does not expose the import action.
- Release validation covers the full `npm run release:check`, Docker demo, npm tarball inspection, concurrency and conflict tests, and a manual import, inspection, and clear flow from an empty instance.

## Related documentation

- [Docker Demo](DEMO.en.md)
- [SQL migration discipline](../sql/README.en.md)
- [Compatibility](COMPATIBILITY.en.md)
- [中文发布说明](RELEASE_NOTES_v0.3.2.md)
