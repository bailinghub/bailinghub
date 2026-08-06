# BailingHub v0.2.0: Tool Catalog Access Protection and Active Verification

`v0.2.0` turns URL tool-catalog access from an implicit convention into an explicit, verifiable governance control. Operators must state whether a catalog requires signed access or is intentionally public. The console reports configured intent separately from observed evidence instead of assuming that sending a signature proves the endpoint is protected.

This release governs who may download a tool catalog. Tool execution keeps the existing signatures, trusted subject, route allowlist, risk approval, idempotency, and final business authorization. ACC and the Client API are unchanged.

## User-visible results

- New URL providers default to **Signed protection (recommended)**. Operators choose **Public allowed** only when they intentionally accept exposing paths, parameters, scopes, and risk declarations to anyone who can reach the URL. Saving public access requires a second confirmation.
- The provider list shows the expected policy and the latest observed result independently, including signed, unsigned, and invalid-signature HTTP evidence.
- Signed mode is `protected` only when the valid signed request returns 2xx and the unsigned plus invalid-signature requests each return 401, 403, or 404.
- A negative request returning 2xx is `public`. Redirects, 429, 5xx, network errors, and other insufficient evidence are `inconclusive`. Both cases reject the candidate refresh and preserve the previous usable catalog.
- Public mode sends only an unsigned request and never silently retries with a signature.

## Two access policies

| Policy | Use case | Hub refresh behavior | Business-side requirement |
|---|---|---|---|
| `signed_required` | Default; the catalog must not be anonymous | Read with a valid signature, then run unsigned and invalid-signature probes | Verify the same provider secret used for tool calls; reject negative probes with 401/403/404; prevent protected-response caching |
| `public_allowed` | Intentional public catalog discovery | Send only an unsigned request | Anonymous GET may return the catalog; tool calls still require independent signatures and authorization |

The catalog policy does not replace business authorization. Even with a public catalog, actual tool requests must still validate `X-Bailing-Signature`, `X-Bailing-On-Behalf-Of`, task identity, and business permissions under the existing protocol.

## Active probes and cache safety

- Each request has a 10-second bound. The two negative probes run concurrently, so their worst-case waits do not add up to 20 seconds.
- The successful primary response is limited to 5 MiB using both `Content-Length` and actual streamed bytes.
- Formal policies do not follow redirects, preventing evidence from being attributed to the wrong target after a redirect.
- Exposure or inconclusive results persist probe evidence and sanitized audit events, while full `spec_url` values are excluded from alert notifications.
- The cached catalog is replaced only after both policy verification and catalog parsing succeed. Every failure preserves the old cache.

## Upgrading existing providers

Migration `053_tool_spec_access_policy.sql` adds nullable policy and latest-probe columns to `bz_tool_providers`. The normal upgrade sequence remains:

```bash
npm run db:init
# then restart BailingHub
```

Existing URL providers are not guessed to be public or protected:

- their cached catalogs remain unchanged and refresh keeps the previous signed-read behavior;
- the console labels them **Pending confirmation (historical configuration)** and preselects neither real policy;
- the internal `legacy_unverified` compatibility marker is read-only, absent from the public Schema, and rejected as a create or update value;
- disabling a provider or changing descriptive, governance, retrieval, and other non-catalog fields does not force a policy choice;
- changing the catalog URL, secret, auto-refresh, re-enabling, or another action that changes catalog reads first requires a formal policy;
- when the latest probe already proves protection, the console can adopt **Signed protection** with one click, while the operator still confirms the decision.

After confirmation, the database stores only `signed_required` or `public_allowed`. The internal historical marker is normalized to `NULL` during a later normal save or refresh, with no additional data-cleanup migration.

## PHP and PHP7 SDKs

PHP and PHP7 `SpecServer` add:

- `handlePublic()` for an explicit public catalog response;
- `respondPublic()` for an explicit bare-PHP public response;
- `responseHeaders()` for framework integrations;
- automatic `Cache-Control: private, no-store` on protected `respond($spec, $secret)` responses.

The older `handle(..., null)` and `respond($spec, null)` public forms remain compatible. New code should prefer the explicit `Public` helpers so public exposure is not hidden inside a `null` argument.

## Compatibility and boundaries

- This is an additive minor upgrade. The new database columns are nullable, and older code ignores them.
- ACC, the Client API version, executor protocol, tool-call signatures, approval semantics, idempotency rules, and final business authorization are unchanged.
- A new URL provider that omits the policy safely defaults to `signed_required`. Explicitly submitting the internal historical marker is rejected.
- Custom provider repositories may continue using the existing `upsert` path. The narrow probe-update method is an optional extension point.
- An application rollback should keep migration 053 and its ledger entry. Restore a full pre-upgrade database snapshot only together with the old application; do not drop the columns or delete the ledger entry independently.

## Validation

```bash
npm run release:check
npm run e2e:console
```

Focused coverage includes:

- request behavior and fail-closed handling for both formal policies;
- signed, unsigned, and invalid-signature status classification;
- timeout, response-size, and redirect boundaries;
- old-cache preservation, probe persistence, and alert sanitization;
- historical records remaining unguessed and requiring confirmation before catalog-sensitive changes;
- second confirmation for public mode and one-click adoption for protected historical providers;
- Schema, API, database repository, and PHP/PHP7 SDK compatibility.

## Related documentation

- [Compatibility and upgrades](COMPATIBILITY.en.md#url-tool-catalog-access-policy-upgrade)
- [Runtime contract](CONTRACT.en.md)
- [Integration guide](INTEGRATION.en.md#publish-tools)
- [Tool governance](TOOLS.en.md)
- [SDK guide](SDK.en.md)
- [中文发布说明](RELEASE_NOTES_v0.2.0.md)
