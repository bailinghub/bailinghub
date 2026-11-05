# Core v0.10.1: Preserve explicit business risk and execution declarations

[简体中文](RELEASE_NOTES_v0.10.1.md)

A business service explicitly marked a POST operation as low risk, but its generated declaration omitted `risk.level`. A GET explicitly marked as non-readonly was still consumed as readonly. Core 0.10.1 fixes lost explicit values in business-side SDK generators and distinguishes an omitted boolean from `false` when Core consumes declarations.

This is a patch relative to Core 0.10.0. **The ACC specification remains at 1.0.6 and declarations retain `version: 1`; MCP / Agent Client SDK 0.8.0 and DSH 0.8.0 have no separate upgrade in this release.** The affected generators live in the Core repository and are business-provider SDKs, not those independent client packages. There are no new SQL migrations, authentication protocols or business-permission endpoints relative to 0.10.0.

## Corrected behavior

Seven SDK generators—PHP 7.3 builder, PHP 8 attributes, Node.js, Python, Go, Java and .NET—preserve explicit `readonly: false/true`, `idempotent: false/true` and `risk.level: low/medium/high`. Unspecified fields remain omitted; write operations are not assigned low risk globally.

Core preserves explicit boolean false and uses the existing GET fallback only when the field is unspecified. Effective risk uses an explicit risk value first, then the resolved readonly value. The HTTP method cannot override an explicit non-readonly declaration a second time.

| Declaration | Interpretation after the fix |
| --- | --- |
| GET with readonly and risk omitted | Existing readonly and low defaults |
| GET with `readonly: false`, risk omitted | Non-readonly and medium |
| POST with readonly and risk omitted | Existing non-readonly and medium defaults |
| POST with explicit `risk: low` | Low is retained; existing approval, subject and business authorization requirements remain independent |
| GET with explicit `idempotent: false` | The non-idempotent hint is retained instead of being overridden by GET |

**This correction can change the effective interpretation of declarations previously omitted or overridden incorrectly.** Business owners must confirm that explicit low and false values match the operation. In particular, a write operation previously interpreted as medium because low was omitted now retains its declared low risk. This requires review rather than being treated as a cosmetic change.

## Distribution and validation

Both PHP tgz companion packages are updated with the Core artifacts. A new verifier compares the complete source/archive file sets, file contents and SHA-256 values, then runs actual generator tests against both source and extracted packages. Missing files, unexpected files, digest differences and failing regressions fail the check. PHP7 retains PHP 7.3 syntax; the attribute-based package still requires PHP 8.1 or later.

Generator regressions cover all 24 combinations of GET/POST, readonly omitted/false/true and risk omitted/low/medium/high, plus explicit and omitted idempotency values. Core regressions check precedence and effective risk. PHP tests also verify that explicit low does not remove approval or subject requirements. These tests use synthetic capabilities and do not execute business operations or replace an integrator's declaration review.

PHP8 `AiTool::$risk` changes from the default `'low'` to a nullable string with default `null`; Java also uses null for unspecified risk, .NET uses the empty string, and Node.js/Python no longer fill unspecified risk with low. Custom code reading intermediate tool objects must handle the unspecified state. See the [upgrade guide](UPGRADE_v0.10.1.en.md).

The release also updates the bounded development/build dependencies to `fast-uri 3.1.9` and `Vite 6.4.5` to satisfy release audit gates. This dependency maintenance does not establish that a production exploit or production vulnerability occurred.

## Upgrade boundaries

Operators update Core and the business-side SDK, regenerate and review declarations, then refresh tool sources. **An SDK-only upgrade cannot fix an old Core overriding explicit GET false; a Core-only upgrade cannot recover fields already discarded by an old generator.** Integrations using hand-written OpenAPI or another runtime must check declaration contents and consumer behavior separately.

Business authorization, signatures, approval conditions, original-request recovery and metering rules are outside this change. Do not replay business requests for acceptance or rewrite saved original invocations and approved arguments. A public release does not automatically upgrade any existing deployment, private Host or downstream system.

[Upgrade guide](UPGRADE_v0.10.1.en.md) · [Business-side SDKs](SDK.en.md) · [Changelog](CHANGELOG.en.md) · [Previous release](RELEASE_NOTES_v0.10.0.en.md)
