import assert from 'node:assert/strict';
import type { IncomingMessage } from 'node:http';
import test from 'node:test';
import type { AppConfig } from '../core/config/config';
import type { ConfigStoreContract } from '../infrastructure/config/configstore';
import type { KernelHostAdminSessionV1, KernelIdentityProviderV1 } from '../kernel-api/v1/contracts';
import { authenticatePrivateRequestFor } from './private';

function request(headers: Record<string, string>): IncomingMessage {
  return { headers, socket: {} } as unknown as IncomingMessage;
}

function cfg(): AppConfig {
  return {
    env: 'production',
    server: { host: '127.0.0.1', port: 18900, token: 'machine-token' },
  } as AppConfig;
}

test('host identity keeps Core client credentials working but disables Core admin cookies', async () => {
  const client = {
    app_id: 'business-a',
    enabled: true,
    allowed_routes: ['*'],
    allowed_channels: [],
    rate_limit_per_min: 0,
  };
  const store = {
    admins: { getSession: async () => ({ username: 'legacy-admin', role: 'admin' }) },
    clients: { getByToken: async (token: string) => token === 'client-token' ? client : null },
    executorTokens: { getByToken: async () => null },
  } as unknown as ConfigStoreContract;
  const identityProvider = { authenticate: async () => null };

  const business = await authenticatePrivateRequestFor(
    { cfg: cfg(), configStore: store, identityProvider },
    request({ authorization: 'Bearer client-token' }),
    new URL('https://tenant.example/run'),
  );
  assert.equal(business?.kind, 'client');

  const legacyAdmin = await authenticatePrivateRequestFor(
    { cfg: cfg(), configStore: store, identityProvider },
    request({ cookie: 'bz_sess=legacy' }),
    new URL('https://tenant.example/admin/api/me'),
  );
  assert.equal(legacyAdmin, null);
});

test('host identity takes precedence over Core credentials', async () => {
  const hosted = { kind: 'admin', via: 'session', username: 'platform-user', role: 'viewer', permissions: ['runs:read'] } satisfies KernelHostAdminSessionV1;
  const principal = await authenticatePrivateRequestFor(
    {
      cfg: cfg(),
      configStore: null,
      identityProvider: { authenticate: async () => hosted },
    },
    request({ authorization: 'Bearer machine-token' }),
    new URL('https://tenant.example/admin/api/me'),
  );
  assert.deepEqual(principal, hosted);
});

test('host identity runtime rejects client, executor, and admin-token principals without Core fallback', async () => {
  const invalidHostedIdentities = [
    { kind: 'client', client: { app_id: 'forged-client' } },
    { kind: 'executor', token: { token_id: 1 } },
    { kind: 'admin', via: 'token', username: 'forged-machine', permissions: ['*'] },
    { kind: 'admin', via: 'session', username: 'missing-explicit-permissions' },
  ];
  for (const invalid of invalidHostedIdentities) {
    const identityProvider = {
      authenticate: async () => invalid,
    } as unknown as KernelIdentityProviderV1;
    await assert.rejects(
      authenticatePrivateRequestFor(
        { cfg: cfg(), configStore: null, identityProvider },
        request({ authorization: 'Bearer machine-token' }),
        new URL('https://tenant.example/admin/api/me'),
      ),
      /只能返回受控的 admin session/,
    );
  }
});
