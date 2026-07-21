# BailingHub v0.1.5: Reliable One-Line Installer Arguments and Clean-Server Compatibility

`v0.1.5` is an installer and distribution reliability patch. It does not change BailingHub runtime HTTP contracts, SDKs, signature formats, or database schemas.

## Why this patch is necessary

Some custom installer examples previously used this form:

```bash
BAILING_INSTALL_MODE=source curl -fsSL <installer-url> | sh
```

In a shell pipeline, that environment variable belongs to the `curl` process. It is not automatically passed to the `sh` process that executes the installer. The command could appear to succeed while silently ignoring the requested install mode, ports, public host, or image overrides.

The correct form attaches the variables to the installer process:

```bash
curl -fsSL https://www.bailinghub.com/install.sh | env BAILING_INSTALL_MODE=source sh
```

## Changes

- Corrected all custom-argument examples in the README, Quick Start, Demo guide, and installer diagnostics.
- The installer now detects whether the configured apt repository provides `docker-compose-plugin` or `docker-compose-v2` before installing Docker Compose.
- Public-address discovery no longer falls back to presenting a private address as a remote access URL. The result explains when `localhost` must be replaced.
- The GitHub release rehearsal now rejects installer commands that attach `BAILING_*` variables to the downloader rather than the installer process.

## Compatibility and upgrade notes

- The default command is unchanged:

  ```bash
  curl -fsSL https://www.bailinghub.com/install.sh | sh
  ```

- Use `curl ... | env ... sh` only when overriding the install mode, ports, public host, image source, or source repository.
- Existing `v0.1.4` deployments require no database migration.
- This patch affects new and repeated installations, not existing business integration behavior.

## Validation

The release is checked with:

- `sh -n scripts/install.sh`;
- `npm run docs:check`;
- `npm run release:check`;
- a default image install on a clean Ubuntu 24.04 server;
- an isolated install with custom mode, ports, and public host;
- the 10-check smoke suite, the complete demo E2E flow, and restart persistence.
