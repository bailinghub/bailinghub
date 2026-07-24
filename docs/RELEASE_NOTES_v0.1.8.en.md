# BailingHub v0.1.8: Create-Once Initial Administrator Bootstrap

`v0.1.8` fixes the administrator lifecycle in unattended installation and demo startup paths. The initial administrator is now created only when the administrator table is empty. Restarts, upgrades, container recreation, and reinstallation against the same persistent database never reconcile or overwrite an existing account.

## Why this matters

A deployment may create an administrator during first installation, but startup configuration must not remain the authoritative source for that account.

If every startup rewrites the account from environment variables, restarting the service after an administrator changes the password can restore an old bootstrap password. That violates operational expectations and gives stale deployment configuration an unintended password-reset capability.

`v0.1.8` separates the two actions:

- **bootstrap** creates the first administrator for an empty database;
- **explicit administration** continues to use `npm run admin:create` for later account creation or password reset.

## Main changes

### Create-once bootstrap

Configure the paired variables:

```text
BAILING_BOOTSTRAP_ADMIN_USERNAME
BAILING_BOOTSTRAP_ADMIN_PASSWORD
```

Their semantics are:

- neither variable configured: skip automatic creation;
- only one variable configured: fail startup instead of accepting a partial configuration;
- administrator table empty: create the first enabled account with the `admin` role;
- any administrator already present: do not modify any username, password, role, or enabled state.

### Safe concurrent cold starts

MySQL deployments serialize first creation with a named lock and a transaction. When multiple replicas cold-start together, only one can create the first administrator. Failure to acquire the initialization lock fails startup instead of continuing from an uncertain state.

### One contract for the demo and installer

- The one-line installer generates a random initial password and passes it through the bootstrap variables.
- Demo seeding uses the same create-once logic.
- Restarting no longer resets an administrator password.
- Service logs do not print the administrator password.

### Administrator repository compatibility fix

When an explicit password update omits the role:

- a new account uses `admin` as its insert default;
- an existing account preserves its current role.

This avoids a MySQL non-null rejection before the duplicate-key update can run.

## Upgrade and compatibility

- No database migration is required.
- The Client API, executor protocol, tool signatures, and ACC semantics are unchanged.
- `npm run admin:create` remains available.
- Upgrades, reinstalls, and container recreation with the same database preserve existing accounts.
- Only a genuinely fresh installation after deleting the persistent database creates a new initial administrator.

Back up the database and deployment configuration before upgrading as usual. Historical deployments may still retain `BAILING_DEMO_ADMIN_PASSWORD` for compatible demo configuration, but it is no longer an authority that resets an administrator on every startup.

## Validation

The release is validated with:

```bash
npm run typecheck
npm test
npm run security:scan
npm run release:check
```

Real-MySQL validation also covers:

1. first creation from an empty administrator table;
2. password persistence across restart after an explicit password change;
3. exactly one initial administrator during concurrent cold starts;
4. password redaction from service logs;
5. Docker demo CI changing the password, restarting the container, and logging in with the new password.

## Related documentation

- [Quickstart](QUICKSTART.en.md)
- [Production operations](OPERATIONS.en.md)
- [Compatibility and upgrade policy](COMPATIBILITY.en.md)
- [Changelog](CHANGELOG.en.md)
