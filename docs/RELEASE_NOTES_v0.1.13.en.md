# BailingHub v0.1.13: Voice Transcription and Distribution-Version Alignment

`v0.1.13` closes the distribution loop for the voice-transcription fix introduced in `v0.1.12`. Runtime semantics are unchanged. This release aligns the installer, default images, validation task, and public version metadata so every entry point resolves to the same release.

## User-visible result

- Web-chat audio continues to use an explicit `transcribe`, `inline`, or `off` policy.
- `transcribe` continues to convert audio through a dedicated speech model before the main model receives text.
- Missing, disabled, or unresolved speech configuration continues to fail closed instead of forwarding audio to the main model or guessing its content.
- The one-line installer, source image Compose path, and independent-validation task now use `v0.1.13`.

## Distribution alignment

This release aligns:

- `package.json` and the lock file;
- the one-line installer's image-tag fallback;
- default application-image tags in the image Compose file;
- image build and tag-inspection fallbacks;
- Chinese and English independent-validation baselines;
- the independent-validation Issue template;
- bilingual changelogs and documentation indexes.

Before publication, the GitHub Release, source archive, installer, and both official application images must resolve to the same commit and version.

## Compatibility

- No database migration is required.
- Client API, executor protocol, tool signatures, approval semantics, and ACC are unchanged.
- The speech policies shipped in `v0.1.12` are unchanged.
- `v0.1.12` deployments need no configuration migration; upgrade with the `v0.1.13` source or images.

## Validation

```bash
npm run release:check
```

Release closure also requires the distribution check and official image-tag inspection to confirm that the default installation path can retrieve `v0.1.13`.

## Related documentation

- [v0.1.12 voice transcription policy](RELEASE_NOTES_v0.1.12.en.md)
- [Independent validation](INDEPENDENT_VALIDATION.en.md)
- [Compatibility and upgrades](COMPATIBILITY.en.md)
- [中文发布说明](RELEASE_NOTES_v0.1.13.md)
