# Security Policy

## Supported Versions

Security fixes are provided for the latest public release line.

## Reporting a Vulnerability

Please do not open a public issue for suspected vulnerabilities.

Use GitHub private vulnerability reporting if it is enabled for the repository. If it is not available, contact the maintainers through a private channel and mark the report as security-sensitive.

Include:

- affected version or commit;
- deployment mode;
- reproduction steps;
- impact assessment;
- any relevant logs with secrets removed.

We aim to acknowledge reports within 3 business days.

## Security Baseline

- Do not commit `config.json`, `.env`, database passwords, model API keys, executor tokens, webhook secrets, or object-storage credentials.
- Production deployments should set `BAILING_ENV=production` and inject secrets through environment variables or a secret manager.
- `BAILING_TOKEN` is the root secret for machine-admin access and derived HMAC credentials. Production or non-loopback listeners require an explicit non-placeholder token of at least 24 characters. Only loopback-bound development mode may run without it.
- Docker Compose intentionally has no default `BAILING_TOKEN`. Generate one with `openssl rand -hex 32`, persist it in a local `.env` or secret manager, and rotate it if it may have been exposed.
- Business tools must verify `X-Bailing-Signature` and must perform their own authorization using `X-Bailing-On-Behalf-Of`.
- High-risk tools should use `risk=high`, `x-agent-capability.approval.required`, or parameter-level confirmation rules.
