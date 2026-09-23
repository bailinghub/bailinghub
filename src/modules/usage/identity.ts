import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import type { UsageActor } from './contracts';
import { UsageError, usageAssert } from './errors';
import type { UsageRepository } from './repository';

export const USAGE_ISSUER_PERMISSIONS = ['identity:exchange', 'identity:revoke', 'entitlements:write', 'allowance:grant', 'usage:read'] as const;
export type UsageIssuerPermission = typeof USAGE_ISSUER_PERMISSIONS[number];
export interface UsageIssuer {
  id: string; label: string; state: 'active' | 'suspended'; permissions: UsageIssuerPermission[];
  serviceIds: string[]; accountIds: string[]; revision: number; createdAt: number; updatedAt: number;
}
export interface UsageSessionContext {
  sessionId: string; userId: string; accountId: string; issuerId: string; serviceId: string; expiresAt: number; modelAccess?: "service" | "token_gateway";
}
export interface UsageExchangeInput {
  requestKey: string; tenant: string; subject: string; generation: string; serviceId: string; accountId?: string; modelAccess?: "token_gateway";
}
interface IssuerRow extends RowDataPacket {
  id: string; label: string; token_hash: string; state: 'active' | 'suspended' | 'deleted'; permissions_json: unknown;
  service_ids_json: unknown; account_ids_json: unknown; revision: number; created_at: number; updated_at: number;
}
interface UserRow extends RowDataPacket { id: string; state: string }
interface SessionRow extends RowDataPacket {
  id: string; issuer_id: string; user_id: string; account_id: string; service_id: string; request_key: string;
  request_hash: string; issuer_revision: number; token_hash: string; state: string; expires_at: number; model_access: string;
}

export const usageTokenHash = (token: string): string => createHash('sha256').update(token).digest('hex');
export function usageString(value: unknown, name: string, max = 128, allowEmpty = false): string {
  usageAssert(typeof value === 'string' && (allowEmpty || value.length > 0) && value.length <= max && value === value.trim()
    && !/[\u0000-\u001f\u007f]/.test(value) && !/[\uD800-\uDFFF]/u.test(value), 'USAGE_INVALID_INPUT', `${name} 格式不正确。`, 400);
  return value;
}
export function usageKey(value: unknown, name: string, max = 128): string {
  const key = usageString(value, name, max);
  usageAssert(/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(key), 'USAGE_INVALID_INPUT', `${name} 格式不正确。`, 400);
  return key;
}
export function usageFields(value: unknown, allowed: readonly string[], required: readonly string[] = []): Record<string, unknown> {
  usageAssert(value && typeof value === 'object' && !Array.isArray(value), 'USAGE_INVALID_INPUT', '请求必须是对象。', 400);
  const body = value as Record<string, unknown>;
  usageAssert(Object.keys(body).every(key => allowed.includes(key)) && required.every(key => Object.hasOwn(body, key)), 'USAGE_INVALID_INPUT', '请求字段不正确。', 400);
  return body;
}
function list(value: unknown): string[] {
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  if (!Array.isArray(parsed) || parsed.some(v => typeof v !== 'string')) throw new UsageError('USAGE_UNAVAILABLE', '使用身份配置不可用。', 503);
  return parsed;
}
function issuerView(row: IssuerRow): UsageIssuer {
  usageAssert(row.state !== 'deleted', 'USAGE_RESOURCE_DELETED', '身份来源已删除，原标识不能再次使用。');
  return { id: row.id, label: row.label, state: row.state, permissions: list(row.permissions_json) as UsageIssuerPermission[],
    serviceIds: list(row.service_ids_json), accountIds: list(row.account_ids_json), revision: Number(row.revision), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at) };
}
function sessionView(row: SessionRow): UsageSessionContext {
  usageAssert(['service', 'token_gateway'].includes(row.model_access), 'USAGE_ACCOUNT_FORBIDDEN', '使用凭证缺少明确的模型范围。', 403);
  return { sessionId: row.id, userId: row.user_id, accountId: row.account_id, issuerId: row.issuer_id, serviceId: row.service_id, expiresAt: Number(row.expires_at), modelAccess: row.model_access === "token_gateway" ? "token_gateway" : "service" };
}
function parseIssuerBody(value: unknown) {
  const body = usageFields(value, ['id', 'label', 'permissions', 'service_ids', 'account_ids'], ['id', 'label', 'permissions', 'service_ids']);
  const id = usageKey(body.id, 'id', 64), label = usageString(body.label, 'label');
  usageAssert(Array.isArray(body.permissions) && body.permissions.length > 0 && body.permissions.length <= USAGE_ISSUER_PERMISSIONS.length
    && body.permissions.every(p => USAGE_ISSUER_PERMISSIONS.includes(p)), 'USAGE_INVALID_INPUT', '请选择明确的服务端权限。', 400);
  usageAssert(Array.isArray(body.service_ids) && body.service_ids.length > 0 && body.service_ids.length <= 64, 'USAGE_INVALID_INPUT', '必须限定服务范围。', 400);
  const serviceIds = [...new Set(body.service_ids.map(v => usageKey(v, 'service_id')))];
  const accountIds = body.account_ids ?? [];
  usageAssert(Array.isArray(accountIds) && accountIds.length <= 256, 'USAGE_INVALID_INPUT', '账户范围格式不正确。', 400);
  return { id, label, permissions: [...new Set(body.permissions)] as UsageIssuerPermission[], serviceIds, accountIds: [...new Set(accountIds.map(v => usageKey(v, 'account_id')))] };
}
function bearer(req: IncomingMessage): string {
  const value = req.headers.authorization;
  usageAssert(typeof value === 'string' && /^Bearer [A-Za-z0-9_-]+$/.test(value), 'USAGE_IDENTITY_REQUIRED', '请通过产品登录取得使用凭证。', 401);
  return value.slice(7);
}

/** Identity, issuer and account authority for the Token model gateway. */
export class UsageIdentity {
  constructor(readonly repository: UsageRepository) {}

  async ready(): Promise<boolean> {
    try {
      const required: Record<string, readonly string[]> = {
        bz_usage_accounts: ['id','state','revision'], bz_usage_members: ['account_id','user_id','state','revision'],
        bz_usage_changes: ['change_key','request_hash','result_json'], bz_usage_services: ['id','revision','config_json'],
        bz_usage_issuers: ['id','token_hash','permissions_json','service_ids_json','account_ids_json','state','revision'],
        bz_usage_users: ['id','issuer_id','tenant_key','subject_key','generation_key','state'],
        bz_usage_sessions: ['id','issuer_id','user_id','account_id','service_id','model_access','request_key','request_hash','issuer_revision','token_hash','state','expires_at'],
      };
      const [rows] = await this.repository.getPool().query<RowDataPacket[]>(
        'SELECT table_name,column_name FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name IN (?)', [Object.keys(required)]);
      const columns = new Set(rows.map(row => `${row.TABLE_NAME ?? row.table_name}.${row.COLUMN_NAME ?? row.column_name}`));
      return Object.entries(required).every(([table, fields]) => fields.every(field => columns.has(`${table}.${field}`)));
    } catch (error) {
      if (['ER_NO_SUCH_TABLE','ER_BAD_DB_ERROR'].includes(String((error as { code?: string }).code))) return false;
      throw new UsageError('USAGE_UNAVAILABLE', '无法读取用量模块状态。', 503);
    }
  }

  async requireUsageUser(id: string): Promise<void> {
    usageKey(id, 'user_id', 64);
    const [rows] = await this.repository.getPool().query<RowDataPacket[]>('SELECT id,state FROM bz_usage_users WHERE id=?', [id]);
    usageAssert(rows[0], 'USAGE_USER_NOT_FOUND', '需要已有的 AI 使用身份；后台管理账号不能直接作为使用身份。', 404);
  }

  async listIssuers(): Promise<UsageIssuer[]> {
    const [rows] = await this.repository.getPool().query<IssuerRow[]>("SELECT * FROM bz_usage_issuers WHERE state<>'deleted' ORDER BY id LIMIT 1000");
    return rows.map(issuerView);
  }

  async createIssuer(value: unknown): Promise<{ issuer: UsageIssuer; credential: string | null; created: boolean }> {
    const input = parseIssuerBody(value), token = `bhu_i_${randomBytes(32).toString('base64url')}`, now = Date.now();
    return this.repository.withTransaction(async conn => {
      const [existing] = await conn.query<IssuerRow[]>('SELECT * FROM bz_usage_issuers WHERE id=? FOR UPDATE', [input.id]);
      if (existing[0]) {
        const saved = issuerView(existing[0]);
        usageAssert(saved.label === input.label && JSON.stringify(saved.permissions) === JSON.stringify(input.permissions)
          && JSON.stringify(saved.serviceIds) === JSON.stringify(input.serviceIds) && JSON.stringify(saved.accountIds) === JSON.stringify(input.accountIds),
        'USAGE_IDEMPOTENCY_CONFLICT', '同一身份来源已存在不同配置。');
        return { issuer: saved, credential: null, created: false };
      }
      for (const accountId of [...input.accountIds].sort()) {
        const [accounts] = await conn.query<RowDataPacket[]>('SELECT state FROM bz_usage_accounts WHERE id=? FOR SHARE', [accountId]);
        usageAssert(accounts[0] && !['deleted','archived'].includes(accounts[0].state), 'USAGE_ACCOUNT_FORBIDDEN', '所选账户不存在或已删除，不能加入来源范围。', 403);
      }
      await conn.execute('INSERT INTO bz_usage_issuers (id,label,token_hash,state,permissions_json,service_ids_json,account_ids_json,revision,created_at,updated_at) VALUES (?,?,?,\'active\',?,?,?,1,?,?)',
        [input.id, input.label, usageTokenHash(token), JSON.stringify(input.permissions), JSON.stringify(input.serviceIds), JSON.stringify(input.accountIds), now, now]);
      return { issuer: { ...input, state: 'active', revision: 1, createdAt: now, updatedAt: now }, credential: token, created: true };
    });
  }

  async authenticateIssuer(token: string, permission: UsageIssuerPermission): Promise<UsageIssuer> {
    usageAssert(/^bhu_i_[A-Za-z0-9_-]{43}$/.test(token), 'USAGE_ISSUER_REQUIRED', '需要独立的服务端身份来源凭证。', 401);
    const [rows] = await this.repository.getPool().query<IssuerRow[]>('SELECT * FROM bz_usage_issuers WHERE token_hash=?', [usageTokenHash(token)]);
    const issuer = rows[0]?.state === 'active' ? issuerView(rows[0]) : null;
    usageAssert(issuer?.state === 'active', 'USAGE_ISSUER_REQUIRED', '身份来源凭证无效或已停用。', 401);
    usageAssert(issuer.permissions.includes(permission), 'USAGE_FORBIDDEN', '此来源没有对应服务端权限。', 403);
    return issuer;
  }

  async requireIssuerAccount(issuer: UsageIssuer, accountId: string, serviceId?: string): Promise<void> {
    usageAssert(await this.repository.getAccount(accountId), 'USAGE_ACCOUNT_FORBIDDEN', '账户不存在或已删除。', 403);
    if (serviceId !== undefined) usageAssert(issuer.serviceIds.includes(serviceId), 'USAGE_FORBIDDEN', '此来源未获准管理该服务。', 403);
    if (issuer.accountIds.includes(accountId)) return;
    const [rows] = await this.repository.getPool().query<RowDataPacket[]>(
      'SELECT m.account_id FROM bz_usage_members m JOIN bz_usage_users u ON u.id=m.user_id JOIN bz_usage_accounts a ON a.id=m.account_id WHERE m.account_id=? AND u.issuer_id=? AND a.kind=\'personal\' AND m.state=\'active\' LIMIT 1', [accountId, issuer.id]);
    usageAssert(rows.length > 0, 'USAGE_ACCOUNT_FORBIDDEN', '此来源未获准管理该账户。', 403);
  }

  async exchange(token: string, value: unknown): Promise<{ schema: 'bailing.usage-session.v1'; credential: string; session: UsageSessionContext }> {
    const issuer = await this.authenticateIssuer(token, 'identity:exchange');
    const body = usageFields(value, ['request_key', 'tenant', 'subject', 'generation', 'service_id', 'account_id', 'model_access'], ['request_key', 'tenant', 'subject', 'service_id']);
    usageAssert(body.model_access === undefined || body.model_access === 'service' || body.model_access === 'token_gateway', 'USAGE_INVALID_INPUT', '模型访问模式不正确。', 400);
    if (body.model_access === 'token_gateway') {
      const { getBillingRepository } = await import('./billing-repository');
      usageAssert(await getBillingRepository(this.repository).ready(), 'USAGE_UNSUPPORTED', '模型计费网关尚未完成迁移。', 503);
    }
    const input: UsageExchangeInput = { requestKey: usageKey(body.request_key, 'request_key'), tenant: usageString(body.tenant, 'tenant', 128, true), subject: usageString(body.subject, 'subject'),
      generation: usageString(body.generation ?? '', 'generation', 128, true), serviceId: usageKey(body.service_id, 'service_id'), ...(body.account_id !== undefined ? { accountId: usageKey(body.account_id, 'account_id') } : {}), ...(body.model_access === 'token_gateway' ? { modelAccess: 'token_gateway' as const } : {}) };
    usageAssert(issuer.serviceIds.includes(input.serviceId), 'USAGE_FORBIDDEN', '此身份来源未获准接入该服务。', 403);
    const requestHash = usageTokenHash(JSON.stringify(input));
    // Persist the identity fence independently of account/session creation. An existing
    // suspended generation is never reactivated, including a first exchange arriving
    // after revocation. This short transaction never waits for an account lock.
    const user = await this.ensureExternalUser(issuer, input.tenant, input.subject, input.generation, false);
    // First account creation is serialized by the existing identity row, not a
    // missing idempotency-key gap. This short transaction never locks an existing
    // personal/shared account; an uncredentialed empty account may safely remain.
    const personal = await this.repository.withTransaction(async conn => {
      const [current] = await conn.query<UserRow[]>('SELECT id,state FROM bz_usage_users WHERE id=? FOR UPDATE', [user.id]);
      if (current[0]?.state !== 'active') return null;
      const identityHash = usageTokenHash(JSON.stringify([issuer.id, input.tenant, input.subject, input.generation]));
      return this.repository.createAccountInTransaction(conn, { requestId: `identity-${identityHash}`, sourceOwner: `issuer:${issuer.id}`, sourceId: identityHash, kind: 'personal', label: '个人用量账户', userId: user.id });
    });
    return this.repository.withTransaction(async conn => {
      // Read before locking: replay follows the same account-first order as dispatch.
      // The current locking validation below remains authoritative after this read.
      const [prior] = await conn.query<SessionRow[]>('SELECT * FROM bz_usage_sessions WHERE issuer_id=? AND request_key=?', [issuer.id, input.requestKey]);
      if (prior[0]) {
        const row = prior[0];
        usageAssert(row.request_hash === requestHash, 'USAGE_IDEMPOTENCY_CONFLICT', '原交换请求关联不同身份或账户。');
        usageAssert(Number(row.issuer_revision) === issuer.revision, 'USAGE_IDENTITY_EXPIRED', '身份来源已轮换，请从真实登录重新交换。', 401);
        await conn.query('SELECT id FROM bz_usage_accounts WHERE id=? FOR UPDATE', [row.account_id]);
        await this.validateActor(conn, sessionView(row));
        return { schema: 'bailing.usage-session.v1', credential: this.sessionCredential(token, row.id), session: sessionView(row) };
      }
      usageAssert(personal, 'USAGE_ACCOUNT_SUSPENDED', '使用身份已停用。', 403);
      const accountId = input.accountId ?? personal.id;
      usageAssert(accountId === personal.id || issuer.accountIds.includes(accountId), 'USAGE_ACCOUNT_FORBIDDEN', '身份来源没有此组织账户的使用授权。', 403);
      // Account -> membership -> user/session/issuer is also used by dispatch. Never
      // retain an identity lock while waiting for an existing personal or shared account.
      for (const id of [...new Set([personal.id, accountId])].sort()) await conn.query('SELECT id FROM bz_usage_accounts WHERE id=? FOR UPDATE', [id]);
      const [accounts] = await conn.query<RowDataPacket[]>('SELECT a.id,a.state,m.state AS member_state FROM bz_usage_accounts a JOIN bz_usage_members m ON m.account_id=a.id AND m.user_id=? WHERE a.id=? FOR UPDATE', [user.id, accountId]);
      usageAssert(accounts[0]?.state === 'active' && accounts[0]?.member_state === 'active', 'USAGE_ACCOUNT_FORBIDDEN', '使用人无权使用该账户。', 403);
      const [currentUser] = await conn.query<UserRow[]>('SELECT id,state FROM bz_usage_users WHERE id=? FOR UPDATE', [user.id]);
      usageAssert(currentUser[0]?.state === 'active', 'USAGE_ACCOUNT_SUSPENDED', '使用身份已停用。', 403);
      const [fresh] = await conn.query<IssuerRow[]>('SELECT * FROM bz_usage_issuers WHERE id=? FOR UPDATE', [issuer.id]);
      usageAssert(fresh[0]?.state === 'active' && Number(fresh[0].revision) === issuer.revision, 'USAGE_ISSUER_REQUIRED', '身份来源状态已改变。', 401);
      const now = Date.now(), id = randomUUID(), credential = this.sessionCredential(token, id), expiresAt = now + 15 * 60_000;
      await conn.execute('INSERT INTO bz_usage_sessions (id,issuer_id,user_id,account_id,service_id,model_access,request_key,request_hash,issuer_revision,token_hash,state,expires_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,\'active\',?,?)',
        [id, issuer.id, user.id, accountId, input.serviceId, input.modelAccess ?? 'service', input.requestKey, requestHash, issuer.revision, usageTokenHash(credential), expiresAt, now]);
      return { schema: 'bailing.usage-session.v1', credential, session: { modelAccess: input.modelAccess ?? 'service', sessionId: id, userId: user.id, accountId, issuerId: issuer.id, serviceId: input.serviceId, expiresAt } };
    });
  }

  /** A suspended exact generation is a durable revocation fence, even without a session. */
  private async ensureExternalUser(issuer: UsageIssuer, tenant: string, subject: string, generation: string, revoke: boolean): Promise<UserRow> {
    return this.repository.withTransaction(async conn => {
      const issuerId = issuer.id, now = Date.now();
      await conn.execute(`INSERT INTO bz_usage_users (id,issuer_id,tenant_key,subject_key,generation_key,state,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)
        ON DUPLICATE KEY UPDATE ${revoke ? 'state=VALUES(state),updated_at=VALUES(updated_at)' : 'id=id'}`,
      [randomUUID(), issuerId, tenant, subject, generation, revoke ? 'suspended' : 'active', now, now]);
      const [users] = await conn.query<UserRow[]>('SELECT id,state FROM bz_usage_users WHERE issuer_id=? AND tenant_key=? AND subject_key=? AND generation_key=? FOR UPDATE', [issuerId, tenant, subject, generation]);
      // Keep the same user -> source lock order as exchange and dispatch.
      // Validate before commit: if deletion wins first, this transaction rolls
      // back its identity insert/update; otherwise the shared source lock fences
      // deletion until the new identity reference is committed.
      const [sources] = await conn.query<IssuerRow[]>('SELECT state,revision FROM bz_usage_issuers WHERE id=? FOR SHARE', [issuer.id]);
      usageAssert(sources[0]?.state === 'active' && Number(sources[0].revision) === issuer.revision, 'USAGE_ISSUER_REQUIRED', '身份来源已更新、停用或删除。', 401);
      return users[0]!;
    });
  }

  private sessionCredential(issuerToken: string, sessionId: string): string {
    return `bhu_s_${createHmac('sha256', issuerToken).update(`bailing.usage-session.v1:${sessionId}`).digest('base64url')}`;
  }

  async authenticate(token: string): Promise<UsageSessionContext> {
    usageAssert(/^bhu_s_[A-Za-z0-9_-]{43}$/.test(token), 'USAGE_IDENTITY_REQUIRED', '需要独立的 AI 使用凭证。', 401);
    const [rows] = await this.repository.getPool().query<SessionRow[]>('SELECT * FROM bz_usage_sessions WHERE token_hash=?', [usageTokenHash(token)]);
    usageAssert(rows[0], 'USAGE_IDENTITY_REQUIRED', '使用凭证无效。', 401);
    const actor = sessionView(rows[0]);
    await this.repository.withTransaction(async conn => {
      await conn.query('SELECT id FROM bz_usage_accounts WHERE id=? FOR UPDATE', [actor.accountId]);
      await this.validateActor(conn, actor);
    });
    return actor;
  }

  /** Caller holds the account lock before this validator, shared with dispatch and revocation. */
  async validateActor(conn: PoolConnection, actor: UsageActor & { serviceId?: string }): Promise<void> {
    const [rows] = await conn.query<RowDataPacket[]>(`SELECT s.*,u.state AS user_state,i.state AS issuer_state,i.revision AS current_issuer_revision,
      a.state AS account_state,m.state AS member_state FROM bz_usage_sessions s JOIN bz_usage_users u ON u.id=s.user_id
      JOIN bz_usage_issuers i ON i.id=s.issuer_id JOIN bz_usage_accounts a ON a.id=s.account_id
      JOIN bz_usage_members m ON m.account_id=s.account_id AND m.user_id=s.user_id WHERE s.id=? FOR UPDATE`, [actor.sessionId]);
    const row = rows[0];
    usageAssert(row && row.user_id === actor.userId && row.account_id === actor.accountId && (!actor.serviceId || row.service_id === actor.serviceId), 'USAGE_ACCOUNT_FORBIDDEN', '使用凭证与原账户或服务不匹配。', 403);
    usageAssert((actor.modelAccess ?? 'service') === row.model_access, 'USAGE_ACCOUNT_FORBIDDEN', '模型访问范围与原凭证不匹配。', 403);
    usageAssert(row.state === 'active' && Number(row.expires_at) > Date.now(), 'USAGE_IDENTITY_EXPIRED', '使用凭证已到期或撤销，请从产品重新登录。', 401);
    usageAssert(row.user_state === 'active' && row.issuer_state === 'active' && row.account_state === 'active' && row.member_state === 'active'
      && Number(row.issuer_revision) === Number(row.current_issuer_revision), 'USAGE_ACCOUNT_SUSPENDED', '使用身份、来源或账户已停用。', 403);
  }

  async revokeSession(actor: UsageSessionContext): Promise<void> {
    await this.repository.withTransaction(async conn => {
      await conn.query('SELECT id FROM bz_usage_accounts WHERE id=? FOR UPDATE', [actor.accountId]);
      await conn.execute('UPDATE bz_usage_sessions SET state=\'revoked\' WHERE id=? AND user_id=? AND account_id=?', [actor.sessionId, actor.userId, actor.accountId]);
    });
  }

  async controlIssuer(id: string, expectedRevision: number, state: 'active' | 'suspended', rotate = false): Promise<{ issuer: UsageIssuer; credential: string | null }> {
    usageKey(id, 'issuer_id', 64);
    usageAssert(Number.isSafeInteger(expectedRevision) && expectedRevision > 0, 'USAGE_INVALID_INPUT', '需要当前修订。', 400);
    return this.repository.withTransaction(async conn => {
      const [accountIds] = await conn.query<RowDataPacket[]>('SELECT DISTINCT account_id FROM bz_usage_sessions WHERE issuer_id=? ORDER BY account_id', [id]);
      for (const row of accountIds) await conn.query('SELECT id FROM bz_usage_accounts WHERE id=? FOR UPDATE', [row.account_id]);
      const [rows] = await conn.query<IssuerRow[]>('SELECT * FROM bz_usage_issuers WHERE id=? FOR UPDATE', [id]);
      const row = rows[0];
      usageAssert(row, 'USAGE_NOT_FOUND', '身份来源不存在。', 404);
      usageAssert(row.state !== 'deleted', 'USAGE_RESOURCE_DELETED', '身份来源已删除，不能恢复或轮换凭据。');
      usageAssert(Number(row.revision) === expectedRevision, 'USAGE_REVISION_CONFLICT', '身份来源已更新，请刷新。');
      const credential = rotate ? `bhu_i_${randomBytes(32).toString('base64url')}` : null, now = Date.now();
      await conn.execute('UPDATE bz_usage_issuers SET state=?,token_hash=?,revision=revision+1,updated_at=? WHERE id=?', [state, credential ? usageTokenHash(credential) : row.token_hash, now, id]);
      return { issuer: { ...issuerView(row), state, revision: expectedRevision + 1, updatedAt: now }, credential };
    });
  }

  async revokeExternalUser(issuer: UsageIssuer, value: unknown): Promise<void> {
    const body = usageFields(value, ['tenant', 'subject', 'generation'], ['tenant', 'subject']);
    const tenant = usageString(body.tenant, 'tenant', 128, true), subject = usageString(body.subject, 'subject'), generation = usageString(body.generation ?? '', 'generation', 128, true);
    // Commit the fence first: a failed or interrupted session cleanup must never let
    // a delayed first exchange create an active identity. Callers still receive an
    // error if cleanup fails and can repeat this exact revocation safely.
    const user = await this.ensureExternalUser(issuer, tenant, subject, generation, true);
    await this.repository.withTransaction(async conn => {
      const [accounts] = await conn.query<RowDataPacket[]>('SELECT account_id FROM bz_usage_members WHERE user_id=? ORDER BY account_id', [user.id]);
      for (const row of accounts) await conn.query('SELECT id FROM bz_usage_accounts WHERE id=? FOR UPDATE', [row.account_id]);
      await conn.execute('UPDATE bz_usage_sessions SET state=\'revoked\' WHERE user_id=?', [user.id]);
    });
  }
}

const identities = new WeakMap<UsageRepository, UsageIdentity>();
export function getUsageIdentity(repository: UsageRepository): UsageIdentity {
  let identity = identities.get(repository);
  if (!identity) { identity = new UsageIdentity(repository); identities.set(repository, identity); repository.setActorValidator((conn, actor) => identity!.validateActor(conn, actor)); }
  return identity;
}
export function authenticateUsageRequest(identity: UsageIdentity, req: IncomingMessage): Promise<UsageSessionContext> { return identity.authenticate(bearer(req)); }
export async function authenticateUsageIssuerRequest(identity: UsageIdentity, req: IncomingMessage, permission: UsageIssuerPermission): Promise<{ issuer: UsageIssuer; token: string }> {
  const token = bearer(req); return { issuer: await identity.authenticateIssuer(token, permission), token };
}
