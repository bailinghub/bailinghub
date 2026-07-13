# v0.1.1 Release Notes

BailingHub `v0.1.1` is a backward-compatible update focused on operational controls for the embedded chat widget and stricter OpenAPI tool compilation boundaries. Existing `/run`, tool signing, approval, SDK, and database contracts do not require migration.

## Highlights

- **Pause or resume chat entries without removing embed code**: disabling an entry hides the launcher and panel. Message, history, upload, and feedback endpoints continue to reject requests on the server side.
- **Configurable widget attribution**: each chat entry can show, hide, or customize its footer attribution. Existing entries keep the current BailingHub attribution by default.
- **Explicit public configuration state**: disabled entries return `{ "enabled": false }`. The widget fails closed and remains hidden when configuration cannot be loaded or its state is unknown.
- **Stricter OpenAPI compilation**: only `query`, `path`, and `header` parameter locations are accepted. `cookie`, unknown, or missing locations produce stable diagnostics and skip the affected operation. Quoted string values for `timeout_ms` now produce an actionable type error.
- **Improved distribution and community surfaces**: application images are published to both Aliyun ACR and GHCR; GitHub main and release tags mirror to Gitee; README images render on both platforms; community derivative and ecosystem collaboration principles are documented.

## Compatibility

- Existing chat entries remain enabled, and `powered_by_visible` defaults to `true`.
- Custom attribution is stored in the existing chat-entry `appearance` JSON; no database migration is added.
- Tool providers using unsupported OpenAPI parameter locations must move those parameters or translate them in a business-side adapter.
- Other public HTTP contracts, ACC fields, SDK calls, and signature formats remain unchanged.

## Upgrade and Verification

For source deployments:

```bash
npm install
npm run typecheck
npm test
npm --prefix web-admin run build
```

Published application images:

```text
crpi-xm97pbcjrmf5in3s.cn-shanghai.personal.cr.aliyuncs.com/bailinghub/bailinghub:0.1.1
ghcr.io/bailinghub/bailinghub:0.1.1
```

See [CHANGELOG.en.md](CHANGELOG.en.md) for the complete change history and [COMPATIBILITY.en.md](COMPATIBILITY.en.md) for upgrade discipline.
