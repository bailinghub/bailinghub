# DOCX dependency and source verification

[中文](DOCX_DEPENDENCY.md)

Core file context uses `extractRawText`; the bundled console converts knowledge-base DOCX files through `convertToHtml` and then Markdown. Both existing paths retain the original Mammoth 1.12.0 parsing implementation; Core v0.9.4 changes to the library distribution described below.

## Library distribution boundary

`vendor/mammoth-library` is a modified library distribution named `@bailinghub/mammoth-library`, version `1.12.0-bailinghub.1`. It retains upstream parsing sources, types, browser adaptations and the BSD-2-Clause license. It removes the CLI entry, CLI output handler and `argparse` dependency. It does not provide the Mammoth command-line tool. The original upstream manifest is provenance only, not an installation manifest.

Core and the console install the same repository-local `.tgz`, with runtime dependencies recorded in each lockfile. The Core npm artifact bundles the library and its runtime dependencies, so independent consumers do not rely on root overrides or a development checkout. Source exports include the archive and lockfiles, without `node_modules`; Docker copies `vendor` before `npm ci`.

This removes the `argparse → sprintf-js` CLI dependency chain carrying [GHSA-hp3w-g68c-fv3c](https://github.com/advisories/GHSA-hp3w-g68c-fv3c). The former temporary exception is retired, without renewal or a replacement vulnerability waiver. This does not fix upstream sprintf-js or establish that arbitrary documents and future dependencies are safe.

## Reproduction and audit

The distributed archive has fixed integrity. Different npm/gzip versions may encode equivalent tarballs differently; verification compares their full unpacked contents, not a newly compressed byte stream.

- [SOURCE.json](../vendor/mammoth-library/SOURCE.json) pins the official tarball, SHA-512 integrity and each retained file's SHA-256. The upstream [license](../vendor/mammoth-library/LICENSE) is preserved.
- `npm run docx:vendor:check` verifies the source inventory, metadata transformation, dependency declarations and bundling, then verifies the complete unpacked archive inventory and each file against the reviewed source.
- `npm run docx:vendor:verify-upstream` downloads the pinned official archive and verifies retained sources and the actual archive contents. CI and `release:check` require it and parsing regression tests.
- `npm run audit:deps` requires zero raw npm findings in both scopes. Findings, invalid responses, inconsistent counts and reintroduced CLI dependencies block. Because a custom name does not inherit upstream advisories, the gate also queries official npm direct advisories for the original `mammoth@1.12.0`; any finding or query failure blocks. Runtime dependencies remain visible in both regular lockfile audits.
- `npm run docx:test` covers Core's actual adapter, Chinese text, paragraphs and whitespace, headings/lists/tables/links/images, empty documents and corrupt archives. Raw text preserves upstream semantics: double newlines separate paragraphs; Word soft breaks add no character.
- Build the console, then run `npm run docx:browser:test` for the actual browser bundle and existing image placeholders. `npm run package:artifact:check` exercises both library APIs, the dependency chain and zero raw audit findings in a real independent npm consumer.

An upstream update requires an explicit source pin and custom version change, change review, rebuilt archive and both lockfiles, refreshed notices and all gates above. `node scripts/vendor-mammoth.mjs --refresh` only rebuilds the pinned source; it never tracks latest automatically. Existing installations receive this change only through their own upgrade to a BailingHub artifact containing it; publication does not upgrade deployments.
