# BailingHub v0.3.3: npm Publication Metadata Correction

`v0.3.3` is a publication-metadata-only correction to `v0.3.2`. The `v0.3.2` npm artifact contents and integrity checks were valid, but npm Registry did not contain the `gitHead` field used by BailingHub's release gate to match the package to public source. That immutable version remains part of the release history; it was not overwritten, moved, or republished.

## What this corrects

- Publishes the npm package from the exact Tag in an independent full Git clone so Registry `gitHead`, the Git Tag commit, and public source can be checked consistently.
- Aligns the default installer, image tags, independent-validation baseline, and current release notes on `v0.3.3`.
- Carries forward the managed demo dataset import, refresh, and clear capability introduced in `v0.3.2` without changing runtime behavior.

## Compatibility and upgrade

- Runtime content under `src/`, `sql/`, `web/`, `web-admin/`, `demo/`, and `sdk/` is unchanged from `v0.3.2`.
- There is no new database migration; `054_demo_dataset_state.sql` remains the latest migration.
- Client API, Kernel Host API v1, the chat protocol, Executor Protocol, ACC, tool signatures, approval semantics, and final business authorization are unchanged.
- Deployments already on `v0.3.2` can upgrade as a normal patch release; new deployments should use `v0.3.3` directly.

## Validation

This release repeats the complete `npm run release:check` gate and then verifies the npm Registry version, integrity, tarball, and exact Git commit. The GitHub Release and public installation distribution are created only after every readiness check passes.

## Related documentation

- [v0.3.2 managed demo dataset onboarding](RELEASE_NOTES_v0.3.2.en.md)
- [Docker Demo](DEMO.en.md)
- [SQL migration discipline](../sql/README.en.md)
- [Compatibility](COMPATIBILITY.en.md)
- [中文发布说明](RELEASE_NOTES_v0.3.3.md)
