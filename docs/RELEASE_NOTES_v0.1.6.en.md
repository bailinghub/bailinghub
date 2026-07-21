# BailingHub v0.1.6: Independent Validation Paths and Post-Install Privilege Hints

`v0.1.6` is an installation-experience and independent-validation patch. It does not change BailingHub runtime HTTP contracts, SDKs, signature formats, ACC semantics, or database schemas.

## Why this patch exists

During a clean Ubuntu 24.04 regression, the installer correctly used `sudo docker` when the current non-root user did not yet have Docker socket access. The completion screen, however, always printed operator commands without `sudo`. The deployment was healthy, but copying those commands immediately produced a permission error and could make a successful installation look broken.

The same review found that the public independent-validation task treated source cloning and building as the only core path, adding unnecessary work for developers who only wanted to reproduce the product loop.

## What changed

- The installer prints either `docker compose` or `sudo docker compose` according to the current session's actual access;
- a fresh Ubuntu/Debian one-line install is now the recommended core independent-validation path;
- local source reproduction remains an equivalent alternative;
- the Chinese and English task cards define non-production, credential-protection, and cleanup boundaries;
- the Issue template separately records one-line installer, source Docker, Dify, and executor validation, with a commit SHA required only for the source path.

## Upgrade and compatibility

Existing deployments require no migration. This patch does not add a database migration or change tool signatures, approval, audit, executor, chat, SDK, or ACC contracts.

New installations continue to use:

```bash
curl -fsSL https://www.bailinghub.com/install.sh | sh
```

After installation, preserve the complete Compose prefix printed under `常用命令`.

## Verification

- `sh -n scripts/install.sh`;
- `npm run docs:check`;
- `npm run release:check`;
- isolated Ubuntu 24.04 installation regression;
- correct `sudo docker compose -f docker-compose.images.yml` output in the current non-root session;
- passing `/health`, 10-check smoke suite, and complete `demo:e2e` flow;
- cleanup of isolated containers, network, volumes, directory, and credential-bearing logs while the pre-existing instance remained healthy.

See [INDEPENDENT_VALIDATION.en.md](INDEPENDENT_VALIDATION.en.md) for the public task.
