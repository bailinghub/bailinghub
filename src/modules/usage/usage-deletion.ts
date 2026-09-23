import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import { UsageError, usageAssert } from './errors';
import { usageHash, type UsageRepository } from './repository';
import { billingKey } from './billing-ledger';
import { integer } from './validation';

export type UsageResourceKind = 'plan' | 'issuer' | 'account';
export interface UsageDeletionBlocker { code: string; message: string; count: number }
export interface UsageDeletionPreview {
  kind: UsageResourceKind; id: string; label: string; revision: number; can_delete: boolean;
  blockers: UsageDeletionBlocker[]; effect: string;
}
const tables = { plan: 'bz_usage_billing_plans', issuer: 'bz_usage_issuers', account: 'bz_usage_accounts' } as const;
async function rows(c: PoolConnection, sql: string, parameters: unknown[] = []): Promise<RowDataPacket[]> {
  return (await c.query<RowDataPacket[]>(sql, parameters))[0];
}
/** Each writer takes the same resource lock before adding a reference. */
async function blockers(c: PoolConnection, kind: UsageResourceKind, id: string, resource: RowDataPacket): Promise<UsageDeletionBlocker[]> {
  const found: UsageDeletionBlocker[] = [];
  const count = async (code: string, message: string, sql: string, params: unknown[] = [id]) => {
    const total = Number((await rows(c, sql, params))[0]!.n);
    if (total > 0) found.push({ code, message, count: total });
  };
  if (kind === 'plan') {
    // Only the account's current grant can require the live plan. Replaced grants
    // keep immutable terms for history and settlement; they must not pin the catalog.
    // Future active grants still own the plan. Suspended grants/accounts do not;
    // deleting the catalog does not restore it when an identity is re-enabled.
    await count('PLAN_CURRENT_ACCOUNTS', '仍有启用账户持有有效或待生效的套餐，请先更换或停用其套餐，或等待到期。',
      `SELECT COUNT(*) AS n FROM bz_usage_billing_heads h
       JOIN bz_usage_billing_grants g ON g.id=h.grant_id AND g.account_id=h.account_id
       JOIN bz_usage_accounts a ON a.id=h.account_id
       WHERE g.plan_id=? AND a.state='active' AND g.state='active' AND (g.expires_at IS NULL OR g.expires_at>CAST(UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3))*1000 AS UNSIGNED))`);
  } else if (kind === 'issuer') {
    await count('ISSUER_USER_HISTORY', '身份来源已接入使用身份，需保留关联；可停用来源。', 'SELECT COUNT(*) AS n FROM bz_usage_users WHERE issuer_id=?');
    await count('ISSUER_SESSION_HISTORY', '身份来源已有使用凭证记录，不能删除历史。', 'SELECT COUNT(*) AS n FROM bz_usage_sessions WHERE issuer_id=?');
    await count('ISSUER_GRANT_HISTORY', '身份来源已有发放额度记录，不能删除历史。', 'SELECT COUNT(*) AS n FROM bz_usage_billing_grants WHERE source_owner=?', [`issuer:${id}`]);
  } else {
    if (resource.state !== 'suspended') found.push({ code: 'ACCOUNT_ACTIVE', message: '请先停用账户，再从列表移除；停用会阻止新的模型请求。', count: 1 });
    // A head without its grant is incomplete storage, not evidence that deletion is safe.
    await count('ACCOUNT_ALLOWANCE_REFERENCE', '账户仍有关联额度记录，请先核对记录完整性。',
      'SELECT COUNT(*) AS n FROM bz_usage_billing_heads h LEFT JOIN bz_usage_billing_grants g ON g.id=h.grant_id WHERE h.account_id=? AND g.id IS NULL');
  }
  return found;
}
function effect(kind: UsageResourceKind): string {
  return kind === 'plan' ? '从套餐列表移除，保留历史开通、账本和原请求；原标识不能再次使用。'
    : kind === 'issuer' ? '从身份来源列表移除，原来源凭据失效；原标识不能再次使用。'
      : '从默认列表移除并撤销现有使用凭证；保留原身份、成员、套餐和用量历史。管理员可从“已移除”恢复原账户，恢复后仍为停用状态，不重发额度。';
}
export class UsageDeletionRepository {
  constructor(readonly repository: UsageRepository) {}
  async preview(kind: UsageResourceKind, id: string): Promise<UsageDeletionPreview> {
    billingKey(id, 'id', kind === 'plan' ? 191 : 64);
    return this.repository.withTransaction(async c => {
      const current = (await rows(c, `SELECT * FROM ${tables[kind]} WHERE id=? FOR SHARE`, [id]))[0];
      usageAssert(current && !['deleted', 'archived'].includes(current.state), 'USAGE_RESOURCE_NOT_FOUND', '资源不存在或已删除。', 404);
      const blocking = await blockers(c, kind, id, current);
      return { kind, id, label: String(current.label ?? id), revision: Number(current.revision), can_delete: !blocking.length, blockers: blocking, effect: effect(kind) };
    });
  }
  /** Restore the original account only. Never reissue allowance or revive sessions. */
  async restoreAccount(input: { id: string; requestKey: string; expectedRevision: number; actor: string }) {
    const { id, requestKey, expectedRevision, actor } = input;
    billingKey(id, 'id', 64); billingKey(requestKey, 'request_key'); integer(expectedRevision, 'expected_revision', 1);
    usageAssert(typeof actor === 'string' && actor.length > 0 && actor.length <= 191, 'USAGE_INVALID_INPUT', '恢复需要管理身份。', 400);
    return this.repository.withTransaction(async c => {
      const changeKey = usageHash(['usage-account-restore', id, requestKey]), hash = usageHash(input);
      const now = Number((await rows(c, 'SELECT CAST(UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3))*1000 AS UNSIGNED) AS ms'))[0]!.ms);
      await c.query("INSERT INTO bz_usage_changes(change_key,request_hash,result_json,created_at) VALUES(?,?,'null',?) ON DUPLICATE KEY UPDATE change_key=change_key", [changeKey, hash, now]);
      const change = (await rows(c, 'SELECT request_hash,result_json FROM bz_usage_changes WHERE change_key=? FOR UPDATE', [changeKey]))[0]!;
      usageAssert(change.request_hash === hash, 'USAGE_IDEMPOTENCY_CONFLICT', '同一恢复请求关联了不同内容。');
      const saved = typeof change.result_json === 'string' ? JSON.parse(change.result_json) : change.result_json;
      if (saved !== null) return saved as { id: string; state: 'suspended'; revision: number };
      const current = (await rows(c, 'SELECT * FROM bz_usage_accounts WHERE id=? FOR UPDATE', [id]))[0];
      usageAssert(current, 'USAGE_RESOURCE_NOT_FOUND', '账户不存在。', 404);
      usageAssert(current.state !== 'deleted', 'USAGE_RESOURCE_DELETED', '原删除标记不能恢复。');
      usageAssert(Number(current.revision) === expectedRevision, 'USAGE_REVISION_CONFLICT', '账户已更新，请刷新后恢复。');
      usageAssert(current.state === 'archived', 'USAGE_INVALID_INPUT', '只有已移除账户需要恢复。', 400);
      await c.query("UPDATE bz_usage_accounts SET state='suspended',revision=revision+1,updated_at=? WHERE id=?", [now, id]);
      const receipt = { id, state: 'suspended' as const, revision: expectedRevision + 1 };
      await c.query('UPDATE bz_usage_changes SET result_json=? WHERE change_key=?', [JSON.stringify(receipt), changeKey]);
      return receipt;
    });
  }
  async remove(input: { kind: UsageResourceKind; id: string; requestKey: string; expectedRevision: number; actor: string }) {
    const { kind, id, requestKey, expectedRevision, actor } = input;
    billingKey(id, 'id', kind === 'plan' ? 191 : 64); billingKey(requestKey, 'request_key'); integer(expectedRevision, 'expected_revision', 1);
    usageAssert(typeof actor === 'string' && actor.length > 0 && actor.length <= 191, 'USAGE_INVALID_INPUT', '删除操作需要管理身份。', 400);
    return this.repository.withTransaction(async c => {
      const changeKey = usageHash(['usage-resource-delete', kind, id, requestKey]), hash = usageHash(input);
      const now = Number((await rows(c, 'SELECT CAST(UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3))*1000 AS UNSIGNED) AS ms'))[0]!.ms);
      await c.query("INSERT INTO bz_usage_changes(change_key,request_hash,result_json,created_at) VALUES(?,?,'null',?) ON DUPLICATE KEY UPDATE change_key=change_key", [changeKey, hash, now]);
      const change = (await rows(c, 'SELECT request_hash,result_json FROM bz_usage_changes WHERE change_key=? FOR UPDATE', [changeKey]))[0]!;
      usageAssert(change.request_hash === hash, 'USAGE_IDEMPOTENCY_CONFLICT', '同一删除请求关联了不同内容。');
      const saved = typeof change.result_json === 'string' ? JSON.parse(change.result_json) : change.result_json;
      if (saved !== null) return saved as { id: string; deleted: true; revision: number; kind: UsageResourceKind; deletedAt: number };
      const current = (await rows(c, `SELECT * FROM ${tables[kind]} WHERE id=? FOR UPDATE`, [id]))[0];
      usageAssert(current, 'USAGE_RESOURCE_NOT_FOUND', '资源不存在。', 404);
      usageAssert(!['deleted', 'archived'].includes(current.state), 'USAGE_RESOURCE_DELETED', '资源已删除，原标识不能再次使用。');
      usageAssert(Number(current.revision) === expectedRevision, 'USAGE_REVISION_CONFLICT', '资源已更新，请刷新预览后再删除。');
      const blocking = await blockers(c, kind, id, current);
      if (blocking.length) throw new UsageError('USAGE_RESOURCE_IN_USE', '资源已有使用记录或关联，不能删除。请查看具体原因。', 409, { blockers: blocking });
      await c.query(`UPDATE ${tables[kind]} SET state=?,revision=revision+1,updated_at=? WHERE id=?`, [kind === 'account' ? 'archived' : 'deleted', now, id]);
      if (kind === 'account') await c.query("UPDATE bz_usage_sessions SET state='revoked' WHERE account_id=? AND state='active'", [id]);
      const receipt = { id, deleted: true as const, revision: expectedRevision + 1, kind, deletedAt: now };
      await c.query('UPDATE bz_usage_changes SET result_json=? WHERE change_key=?', [JSON.stringify(receipt), changeKey]);
      return receipt;
    });
  }
}
export function getUsageDeletionRepository(repository: UsageRepository): UsageDeletionRepository { return new UsageDeletionRepository(repository); }

export function usageDeletionId(segment: string, kind: UsageResourceKind): string {
  let decoded: string;
  try { decoded = decodeURIComponent(segment); }
  catch { throw new UsageError('USAGE_INVALID_INPUT', '资源标识格式不正确。', 400); }
  return billingKey(decoded, 'id', kind === 'plan' ? 191 : 64);
}
