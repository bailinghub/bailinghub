# BailingHub v0.3.1: PDF Parsing Security Update

`v0.3.1` is a security patch on top of `v0.3.0`. It upgrades the server-side `pdfjs-dist` dependency used to extract text from uploaded PDFs, fixes the arbitrary JavaScript execution risk described in [GHSA-hq66-cqwq-w95j](https://github.com/advisories/GHSA-hq66-cqwq-w95j), and adapts resource cleanup to PDF.js 6.

## Who Should Upgrade

Every `v0.3.0` deployment that accepts PDF uploads from users or business workflows should upgrade promptly. Deployments that do not currently expose PDF uploads should also update so that a known-vulnerable parser is not carried into future use.

## Changes

- Upgraded `pdfjs-dist` from `5.7.284` to `6.2.108`.
- Always destroys the `PDFDocumentLoadingTask` after successful or failed parsing, matching the PDF.js 6 API and releasing resources reliably.
- Restored the dependency audit to zero known vulnerabilities and synchronized the third-party notice with the lockfile.

## Compatibility and Boundaries

- No database migration or new configuration is required.
- The Client API, Kernel Host API v1, chat protocol, Executor Protocol, ACC, tool signatures, approval semantics, and final business authorization are unchanged.
- Plain-text, Word document, and other existing file paths are unchanged.
- This patch does not raise the Node.js runtime floor; the dependency continues to require a supported Node.js release at or above `22.13.0`.

## Upgrade

Docker deployments should pull the `0.3.1` images and restart through their existing procedure. Hosts that compose the Core npm package should update the exact version and lockfile:

```bash
npm install --save-exact bailinghub@0.3.1
```

## Validation

```bash
npm audit --audit-level=low
npm run release:check
```

Validation covers real PDF text extraction, failure-path cleanup, type checking, dependency audit, OSS boundaries, the npm artifact, and image-version consistency.

## Related Documentation

- [v0.3.0 Composable Core and Kernel Host API v1](RELEASE_NOTES_v0.3.0.en.md)
- [Compatibility and upgrades](COMPATIBILITY.en.md)
- [Security policy](../SECURITY.md)
- [中文发布说明](RELEASE_NOTES_v0.3.1.md)
