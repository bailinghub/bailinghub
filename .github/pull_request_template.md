## Summary

Describe what changed and why.

## Type

- [ ] Bug fix
- [ ] Feature
- [ ] Documentation
- [ ] Refactor
- [ ] Test / CI

## Checks

- [ ] `npm run release:audit`
- [ ] `npm run typecheck`
- [ ] `npm test`
- [ ] `npm run web-admin:check` when console code changed
- [ ] SDK contract tests when SDK/tool contract changed
- [ ] `npm run oss:verify` before release or repository-boundary changes

## Contract Impact

- [ ] No public API/config/schema/database contract change
- [ ] Public contract changed and docs/schemas/SDK examples were updated

## Security

- [ ] No secrets, private domains, local paths, or personal data are included
- [ ] New tool, approval, auth, rate-limit, or storage behavior has tests or clear rationale
