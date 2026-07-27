# BailingHub v0.1.10: Instance Branding and Ecosystem Integration Improvements

`v0.1.10` lets self-hosted deployments manage instance branding in the console without modifying frontend source code. It also improves model-identifier diagnostics and adds reproducible DeepSeek and Alibaba Cloud Bailian integration recipes.

## Main Changes

### Instance branding

Administrators with `admins:manage` can configure:

- site name and browser title;
- site description and keywords;
- login heading and subheading;
- logo and favicon.

Settings are stored in the hub-owned `bz_instance_branding` table. Code upgrades, service restarts, and console rebuilds do not overwrite saved values. Public `GET /branding` responses contain display data only. Logo and favicon assets are served through separate public endpoints without exposing management-source or platform metadata.

Image types are detected from file bytes rather than trusting the browser-provided MIME type:

- logos support PNG, JPEG, and WebP up to 512 KiB;
- favicons support PNG and ICO up to 128 KiB.

### Explicit future platform-ownership boundary

The console and public display path depend only on the stable `InstanceBrandingProvider` contract. The open-source edition uses the local provider. A future external platform may replace it, make instance-local settings read-only, and provide a platform management URL.

An upgrade must perform a one-time migration and then use one authoritative source. Local and platform stores are never dual-written.

### Model identifier diagnostics

When model verification fails and the configured model ID contains whitespace, the console now warns that a display name may have been entered and recommends copying the exact ID from provider documentation or `/models`.

Tencent Cloud TokenHub is included as a provider preset:

```text
base_url: https://tokenhub.tencentmaas.com/v1
model: kimi-k3
```

This is a diagnostic and usability improvement, not a universal protocol restriction. Deployments that intentionally use custom aliases may continue entering their own model IDs.

### DeepSeek and Alibaba Cloud Bailian recipes

The public documentation now includes:

- a DeepSeek V4 recipe covering text, streaming, tool calling, and complete hub E2E verification;
- bilingual Alibaba Cloud Bailian remote-MCP configuration, verification steps, and a verification script.

These are optional ecosystem recipes. They do not change the BailingHub Client API, executor protocol, or ACC semantics.

## Database Migration

This release adds:

```text
sql/051_instance_branding.sql
```

The official Docker entrypoint runs migrations automatically. Deployments that run from source, use a custom startup path, or bypass the official entrypoint must run:

```bash
npm run db:init
```

The migration adds one singleton branding table and does not modify existing jobs, approvals, audits, tools, or administrator data.

## Compatibility Boundaries

- Existing deployments keep the default BailingHub branding after upgrade and require no immediate configuration.
- Client API, executor protocol, tool signatures, approval semantics, and ACC are unchanged.
- The new public branding API provides display data only and has no authorization role.
- The model-ID warning does not reject legitimate custom aliases.
- Platform ownership is a replaceable extension boundary; the open-source edition ships only the local provider, while external platform adapters remain separate.

## Validation

Before release:

```bash
npm run typecheck
npm test
npm run web-admin:check
npm run docs:check
npm run security:scan
npm run release:check
```

After upgrade, verify:

1. `npm run db:init` completes and the migration ledger includes `051_instance_branding.sql`;
2. `/health/ready` reports ready;
3. `GET /branding` returns the default or saved instance branding;
4. saved branding remains unchanged after a service restart;
5. unsupported, oversized, or non-image assets are rejected;
6. existing job, approval, audit, and executor paths remain operational.

## Related Documentation

- [Compatibility and Upgrade Policy](COMPATIBILITY.en.md)
- [DeepSeek Integration Recipe](integrations/deepseek/README.en.md)
- [Alibaba Cloud Bailian MCP Recipe](integrations/bailian/README.en.md)
- [Changelog](CHANGELOG.en.md)
