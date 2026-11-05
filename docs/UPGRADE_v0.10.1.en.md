# Core v0.10.1 Upgrade Guide

[简体中文](UPGRADE_v0.10.1.md)

This guide covers Core 0.10.0 → 0.10.1 and the matching business-side declaration SDK updates. ACC remains at specification release 1.0.6 with declaration `version: 1`; MCP / Agent Client SDK and DSH do not receive separate versions for this patch. Earlier Core installations must also follow the [0.10.0 upgrade guide](UPGRADE_v0.10.0.en.md) and their historical migration chain.

## 1. Pin identities and retain original evidence

Record source/target tags, exact commits and package or image digests. For business SDKs, retain the previous file manifest, candidate package SHA-256 and generated declaration. An unchanged filename or the label “PHP7” does not establish artifact identity.

Follow the existing deployment procedure to back up configuration, databases/JSONL, migration history, original operations/invocations and approvals. Stop new admissions and drain accepted work. Relative to 0.10.0 there is **no new SQL and no change to historical SQL or the migrator**; do not manually edit migration history. Keep old artifacts and declarations for comparison and controlled rollback.

## 2. Have business owners review declaration differences

Generators retain explicit risk, readonly and idempotent values previously omitted. Rebuild declarations outside production and compare individual operations:

- **Non-readonly POST with explicit low**: previously it could become medium when the field was discarded. It now retains the author's explicit low value. Confirm that the label is appropriate; do not set every write operation to low to eliminate differences.
- **GET with explicit readonly=false**: it now remains non-readonly and defaults to medium when risk is omitted. Review whether the operation modifies business state and whether GET accurately represents its interface.
- **GET with explicit idempotent=false**: the hint is preserved. Callers must not rely on the old assumption that every GET is idempotent. This is not a promise of automatic retries or exactly-once execution.
- **Unspecified fields**: remain omitted. Existing defaults for unspecified GET readonly and non-readonly POST medium risk are unchanged.
- **Approval and authority**: explicit low does not remove `approval.required`, `approval.when`, subject requirements or final business-system authorization. Retain and inspect these rules rather than bypassing approval because a risk value changed.

JSON, ETags, declaration digests and tool-discovery revisions may change. Refresh tool sources and client discovery through the existing workflow, using the new declaration for new calls. Preserve original invocation identities, frozen arguments and approvals; handle revision conflicts through the existing preparation/recovery process. Do not rewrite history or automatically replay business operations.

## 3. Generator compatibility

| SDK | Intermediate representation of unspecified risk | Integration impact |
| --- | --- | --- |
| PHP7 | No option is added unless `ToolDef::risk()` is called | Method signatures and PHP 7.3 compatibility remain; explicit boolean false is preserved |
| PHP8 | `AiTool::$risk` is `?string`, default `null` | Constructor parameter names/order are unchanged; custom property readers must handle null |
| Node.js | Unspecified risk is no longer filled with `'low'` | Custom readers of `tool()` objects must handle unspecified values |
| Python | Unspecified risk is no longer filled with `'low'` | Custom readers of intermediate dictionaries must handle unspecified values |
| Go | Empty string means unspecified; booleans remain pointers | Struct types are unchanged; nonempty explicit risk and pointed boolean values are retained |
| Java | `Tool.risk` defaults to `null` | Direct field readers must handle null; readonly/idempotent remain nullable Boolean values |
| .NET | `Tool.Risk` defaults to the empty string | The string type is retained; empty means omitted, and booleans remain nullable |

These are business-provider SDKs, not a requirement to replace MCP / Agent Client SDK 0.8.0 or DSH 0.8.0. Projects using another consumer must verify its precedence separately. Passing the ACC reference checker alone does not establish end-to-end business acceptance.

## 4. Companion packages and acceptance

Obtain `web/connect/bailing-connect-php7.tgz` or `bailing-connect-php.tgz` from the same release identity and compare its SHA-256 with the release manifest. From the source checkout:

```bash
node scripts/check-php-sdk-artifacts.mjs
# Use a real PHP 7.3 binary to check PHP7 source and extracted package:
node scripts/check-php-sdk-artifacts.mjs --sdk php7 --php /path/to/php7.3
```

The verifier checks complete file sets, per-file SHA-256 and actual generator regressions, not just file existence. Both drivers also accept an extracted SDK root as their first argument:

```bash
php sdk/php7/tests/declaration-serialization.php /path/to/bailing-connect-php7
php sdk/php/tests/declaration-serialization.php /path/to/bailing-connect-php
```

Check all 24 risk/readonly combinations, six idempotency combinations, preservation of approval/subject requirements with explicit low, and Core's readonly/idempotent/risk interpretation of the same declarations. Start with synthetic interfaces. Integrators review the full declaration diff for their systems without executing real writes for upgrade acceptance. After deployment, separately verify the exact version and `/health/ready`; synthetic regressions do not replace deployment or business acceptance.

Validate Core and generators together. If only one side can be updated, record the remaining unfixed layer explicitly. Do not conceal it by dropping false, changing HTTP methods or globally relabeling risk.

## 5. Dependency maintenance and rollback

The release applies bounded development/build patches to `fast-uri 3.1.9` and `Vite 6.4.5`. Keep the lockfiles and run the relevant build and dependency audits. These changes add no business protocol and do not establish that production was attacked.

Before rollback, stop admissions, drain work and retain new records and declaration revisions. Old SDKs discard the explicit values again, and old Core overrides explicit GET false again; rollback is not merely a version-number change. Verify the old generated declarations and consumer together in isolation, disabling ambiguous capabilities if necessary while preserving operator review. Do not delete approvals, unknown outcomes, original calls or ledgers. Restoring a backup cannot undo external business effects.

[Release notes](RELEASE_NOTES_v0.10.1.en.md) · [Compatibility policy](COMPATIBILITY.en.md) · [Operations](OPERATIONS.en.md)
