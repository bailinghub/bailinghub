import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ConfigStoreContract } from '../infrastructure/config/configstore';
import type { RuntimeStateStore } from '../core/state/state-contracts';
import type { Principal } from '../app/auth';
import { send } from '../app/http';
import { handleAgentApiHttpFor, type AgentApiHttpDeps } from '../routes/agent-api';
import { tokenHash } from '../routes/agent-auth';
import { handleAdminConversationAuditFor } from '../routes/admin-conversation-audit';
import { conversationAuditFixture, AUDIT_SESSION_A, AUDIT_SESSION_B, AUDIT_SESSION_C } from './agent-conversation-audit-fixture';

/**
 * Real loopback HTTP + production Agent authentication/routes/repository, with a
 * transactional in-memory SQL model. All credentials/data are synthetic. The
 * admin bootstrap below supplies test principals; it does not replace or claim
 * coverage of production admin login. No business executor is installed.
 */
export async function conversationAuditHttpFixture(options: {
  crossBinding?: boolean; schemaReady?: boolean; legacyHost?: boolean;
} = {}) {
  const fx = conversationAuditFixture(options);
  const tokens = new Map([AUDIT_SESSION_A, AUDIT_SESSION_B, AUDIT_SESSION_C]
    .map((id, index) => [id, `bha_${String(index).repeat(43)}`]));
  const adminToken = 'synthetic-audit-viewer';
  const deniedAdminToken = 'synthetic-admin-without-runs-read';
  // An old private Host implements only the original contract. New capability
  // methods must remain optional, and absence must not enable cross binding.
  const repository: NonNullable<ConfigStoreContract['agentConversationAudit']> = options.legacyHost ? {
    create: fx.repo.create.bind(fx.repo), confirm: fx.repo.confirm.bind(fx.repo), append: fx.repo.append.bind(fx.repo),
    listForAdmin: fx.repo.listForAdmin.bind(fx.repo), detailForAdmin: fx.repo.detailForAdmin.bind(fx.repo),
    findRunLinkForAdmin: fx.repo.findRunLinkForAdmin.bind(fx.repo),
  } : fx.repo;
  const store = {
    ...fx.store, agentConversationAudit: repository,
    clients: { get: async (id: string) => fx.clients.get(id) ?? null },
    agentAuth: { getSessionByAccessHash: async (hash: string) => {
      const pair = [...tokens].find(([, token]) => tokenHash(token) === hash);
      if (!pair) return null;
      const session = fx.auth(pair[0]).session;
      return session.revoked_at ? null : session;
    } },
  } as unknown as ConfigStoreContract;
  const deps: AgentApiHttpDeps = {
    configStore: store, stateStore: {} as RuntimeStateStore, isPaused: () => false,
    handleRun: async () => { throw new Error('No business dispatch is installed in the archive fixture'); },
  };
  const requests: Array<{ method: string; path: string; sessionId: string | null }> = [];
  const handler = async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const token = String(req.headers.authorization ?? '').replace(/^Bearer /, '');
    const sessionId = [...tokens].find(([, value]) => value === token)?.[0] ?? null;
    requests.push({ method: req.method ?? 'GET', path: url.pathname, sessionId });
    if (await handleAgentApiHttpFor(deps, req, res, url)) return;
    let principal: Principal | null = null;
    if (token === adminToken) principal = { kind: 'admin', via: 'session', role: 'viewer' };
    if (token === deniedAdminToken) principal = { kind: 'admin', via: 'session', role: 'admin', permissions: [] };
    if (sessionId) principal = { kind: 'agent', ...fx.auth(sessionId) };
    if (!principal) { send(res, 401, { error: 'unauthorized' }); return; }
    if (await handleAdminConversationAuditFor(store, req.method ?? 'GET', url.pathname, req, res, principal)) return;
    send(res, 404, { error: 'not_found' });
  };
  const server = createServer((req, res) => {
    void handler(req, res).catch(() => send(res, 500, { error: 'fixture_failure' }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return Object.assign(fx, {
    store, deps, origin, tokens, adminToken, deniedAdminToken, requests,
    async api(method: string, path: string, body?: unknown, token: string | null = tokens.get(AUDIT_SESSION_A)!) {
      const response = await fetch(`${origin}${path}`, {
        method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await response.text();
      return { status: response.status, headers: response.headers, body: JSON.parse(text), text };
    },
    async close() {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  });
}
