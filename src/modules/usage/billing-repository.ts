import type { ProviderFailure, ProviderDiagnostic } from './provider-failure';
import { randomUUID } from 'node:crypto';
import type { Pool, PoolConnection, RowDataPacket } from 'mysql2/promise';
import type { UsageActor } from './contracts';
import { UsageError, usageAssert } from './errors';
import { assertKnownFields, integer } from './validation';
import { operationIdKey, usageHash, type UsageRepository } from './repository';
import { billingAllowanceUsd, billingAllowance, tokenBillingRate, billingExpiry, billingKey, billingPeriod, tokenUsage, validateBillingPlan, billedUsdMicros } from './billing-ledger';
import { positivePart, usdAmount, usdDecimal, usdMicros } from './billing-decimal';
import { calculateReferenceCost } from './pricing';
import { usagePresentation } from './billing-presentation';
import type { BillingAdmissionInput, BillingCompletionInput, BillingGrant, BillingPlan, BillingRequest, BillingSummary, BillingRate } from './billing-contracts';

type Row = Record<string, any>;
async function rows(c: Pool | PoolConnection, sql: string, params: unknown[] = []): Promise<Row[]> {
  return (await c.query<RowDataPacket[]>(sql, params))[0];
}
function json<T>(v: unknown): T { return (typeof v === 'string' ? JSON.parse(v) : v) as T; }
function optionalNumber(v: unknown): number | null { return v === null || v === undefined ? null : Number(v); }
function plan(r: Row): BillingPlan {
  return { id: r.id, label: r.label, revision: Number(r.revision), state: r.state, config: validateBillingPlan(json(r.config_json)), createdAt: Number(r.created_at), updatedAt: Number(r.updated_at) };
}
function grant(r: Row): BillingGrant {
  return { id: r.id, accountId: r.account_id, planId: r.plan_id, planRevision: Number(r.plan_revision), label: r.label,
    revision: Number(r.revision), state: r.state, sourceOwner: r.source_owner, startsAt: Number(r.starts_at), expiresAt: optionalNumber(r.expires_at), config: billingAllowance(json(r.config_json)) };
}
function request(r: Row): BillingRequest {
  const rate = json<BillingRate>(r.billing_rate_json);
  usageAssert(rate, 'METERING_UNAVAILABLE', 'The original price snapshot is unavailable.', 503);
  return { id: r.id, operationId: r.operation_id, accountId: r.account_id, userId: r.user_id, sessionId: r.session_id,
    serviceId: r.service_id, conversationId: r.conversation_id, turnId: r.turn_id, requestHash: r.request_hash,
    revision: Number(r.revision), state: r.state, resultState: r.result_state, billingState: r.billing_state,
    serviceConfig: json(r.service_json), serviceRevision: Number(r.service_revision), model: r.model, fence: r.fence,
    billingRate: tokenBillingRate(rate.planId, rate.planRevision, rate.multiplier, rate.price),
    grantId: r.grant_id, grantRevision: Number(r.grant_revision), grantConfig: billingAllowance(json(r.grant_json)),
    periodStart: Number(r.period_start), periodEnd: optionalNumber(r.period_end), response: json(r.result_json), resultHash: r.result_hash, usage: json(r.usage_json),
    rawUsage: json(r.raw_usage_json), referenceCostUsd: r.reference_cost_usd == null ? null : usdAmount(usdMicros(r.reference_cost_usd)),
    billedUsd: r.billed_usd == null ? null : usdAmount(usdMicros(r.billed_usd)), overageUsd: r.overage_usd == null ? null : usdAmount(usdMicros(r.overage_usd)), cancelledAt: optionalNumber(r.cancelled_at),
    createdAt: Number(r.created_at), updatedAt: Number(r.updated_at) };
}
function label(value: unknown): string {
  usageAssert(typeof value === 'string' && value.trim().length > 0 && value.length <= 191 && !/[\x00-\x1f\x7f]/.test(value), 'USAGE_INVALID_INPUT', 'A short display label is required.', 400);
  return value.trim();
}
/** Provider usage can contain extension fields; the public result exposes metering only. */
function publicRawUsage(raw: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!raw) return null;
  const numbers = ['inputTokens','outputTokens','totalTokens','prompt_tokens','completion_tokens','total_tokens','input_tokens','output_tokens',
    'cachedInputTokens','cacheWriteTokens','prompt_cache_hit_tokens','prompt_cache_miss_tokens','cache_creation_input_tokens','requestCount','webSearchCount',
    'inputImageCount','outputImageCount','inputImageTokens','outputImageTokens','inputPixelCount','outputPixelCount','outputWidth','outputHeight','seconds'];
  const out: Record<string, unknown> = {};
  for (const key of numbers) if (typeof raw[key] === 'number' && Number.isFinite(raw[key]) && (raw[key] as number) >= 0) out[key] = raw[key];
  for (const key of ['inputVariant','outputVariant']) if (typeof raw[key] === 'string' && /^[a-zA-Z0-9_.:-]{1,64}$/.test(raw[key])) out[key] = raw[key];
  for (const key of ['prompt_tokens_details','completion_tokens_details','input_tokens_details','output_tokens_details']) {
    const details = raw[key];
    if (details && typeof details === 'object' && !Array.isArray(details)) {
      const safe = Object.fromEntries(Object.entries(details).filter(([name,value]) => /^[a-z_]+tokens$/.test(name) && typeof value === 'number' && Number.isFinite(value) && value >= 0));
      if (Object.keys(safe).length) out[key] = safe;
    }
  }
  return out;
}
const RESULT_RETENTION_MS = 7 * 86_400_000;

/** Current plan models share the account grant's original allowance and periods. */
export class BillingRepository {
  constructor(readonly repository: UsageRepository) {}
  async configurationReady(): Promise<boolean> { return this.schemaReady(); }
  async ready(): Promise<boolean> { return this.schemaReady(); }
  private async schemaReady(): Promise<boolean> {
    const required: Record<string, string[]> = {
      bz_usage_billing_plans: ['id','revision','config_json'], bz_usage_billing_grants: ['id','source_owner','revision','config_json'],
      bz_usage_billing_heads: ['account_id','grant_id','revision'], bz_usage_billing_periods: ['grant_id','period_start','consumed_usd'],
      bz_usage_billing_requests: ['id','request_hash','fence','billing_state','result_state','execution_key','grant_json','cancelled_at','billing_rate_json','reference_cost_usd'],
      bz_usage_billing_ledger: ['request_id','reference_cost_usd','billed_usd','overage_usd'], bz_usage_sessions: ['model_access'],
      bz_usage_price_snapshots: ['cache_key','snapshot_json','fetched_at'],
    };
    try {
      const found = await rows(this.repository.getPool(), 'SELECT table_name,column_name,data_type,numeric_scale,is_nullable FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name IN (?)', [Object.keys(required)]);
      const columns = new Set(found.map(r => `${r.TABLE_NAME ?? r.table_name}.${r.COLUMN_NAME ?? r.column_name}`));
      const decimalColumns = ['bz_usage_billing_periods.allowance_usd','bz_usage_billing_periods.consumed_usd','bz_usage_billing_requests.reference_cost_usd','bz_usage_billing_ledger.reference_cost_usd','bz_usage_billing_requests.billed_usd','bz_usage_billing_requests.overage_usd','bz_usage_billing_ledger.billed_usd','bz_usage_billing_ledger.overage_usd'];
      return Object.entries(required).every(([table, fields]) => fields.every(field => columns.has(`${table}.${field}`)))
        && (decimalColumns.every(column => found.some(r => `${r.TABLE_NAME ?? r.table_name}.${r.COLUMN_NAME ?? r.column_name}` === column
          && (r.DATA_TYPE ?? r.data_type) === 'decimal' && Number(r.NUMERIC_SCALE ?? r.numeric_scale) === 12))
          && ['billing_rate_json'].every(column => found.some(r => (r.TABLE_NAME ?? r.table_name) === 'bz_usage_billing_requests'
            && (r.COLUMN_NAME ?? r.column_name) === column && (r.IS_NULLABLE ?? r.is_nullable) === 'NO')));
    } catch (e) {
      if (['ER_NO_SUCH_TABLE','ER_BAD_DB_ERROR'].includes(String((e as { code?: string }).code))) return false;
      throw new UsageError('USAGE_UNAVAILABLE', 'Billing readiness is unavailable.', 503);
    }
  }
  private async now(c: PoolConnection): Promise<number> {
    return Number((await rows(c, 'SELECT CAST(UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3))*1000 AS UNSIGNED) AS ms'))[0]!.ms);
  }
  private async lockAccount(c: PoolConnection, accountId: string): Promise<Row> {
    const a = (await rows(c, 'SELECT * FROM bz_usage_accounts WHERE id=? FOR UPDATE', [billingKey(accountId, 'accountId', 64)]))[0];
    usageAssert(a, 'USAGE_ACCOUNT_NOT_FOUND', 'Account not found.', 404);
    usageAssert(a.state !== 'deleted', 'USAGE_RESOURCE_DELETED', '账户已删除，不能恢复或重新关联。'); return a;
  }
  private async currentGrant(c: Pool | PoolConnection, accountId: string, lock = false): Promise<BillingGrant | null> {
    const r = (await rows(c, `SELECT g.* FROM bz_usage_billing_heads h JOIN bz_usage_billing_grants g ON g.id=h.grant_id WHERE h.account_id=?${lock ? ' FOR UPDATE' : ''}`, [accountId]))[0];
    return r ? grant(r) : null;
  }
  private async mutate<T>(c: PoolConnection, domain: string, key: string, input: unknown, fn: () => Promise<T>): Promise<T> {
    const changeKey = usageHash(['billing', domain, billingKey(key, 'request_key')]), hash = usageHash(input);
    const old = (await rows(c, 'SELECT * FROM bz_usage_changes WHERE change_key=? FOR UPDATE', [changeKey]))[0];
    if (old) { usageAssert(old.request_hash === hash, 'USAGE_IDEMPOTENCY_CONFLICT', 'This request key has different input.'); return json<T>(old.result_json); }
    const result = await fn();
    await c.query('INSERT INTO bz_usage_changes(change_key,request_hash,result_json,created_at) VALUES(?,?,?,?)', [changeKey, hash, JSON.stringify(result), await this.now(c)]);
    return result;
  }
  async listPlans(): Promise<BillingPlan[]> {
    return (await rows(this.repository.getPool(), 'SELECT * FROM bz_usage_billing_plans WHERE state<>\'deleted\' ORDER BY updated_at DESC,id LIMIT 500')).map(plan);
  }
  async putPlan(value: unknown): Promise<BillingPlan> {
    assertKnownFields(value, ['id','label','expected_revision','state','config'], 'USD plan');
    const b = value as Row, id = billingKey(b.id), title = label(b.label), revision = integer(b.expected_revision, 'expected_revision');
    const config = validateBillingPlan(b.config);
    usageAssert(b.state === undefined || ['active','suspended'].includes(b.state), 'USAGE_INVALID_INPUT', 'Invalid plan state.', 400);
    return this.repository.withTransaction(async c => {
      const old = (await rows(c, 'SELECT * FROM bz_usage_billing_plans WHERE id=? FOR UPDATE', [id]))[0];
      usageAssert(old?.state !== 'deleted', 'USAGE_RESOURCE_DELETED', '套餐已删除，新增套餐请使用新的标识。');
      usageAssert(Number(old?.revision ?? 0) === revision, 'USAGE_REVISION_CONFLICT', 'Plan changed; refresh before saving.');
      for (const serviceId of [...config.serviceIds].sort()) {
        const service = (await rows(c, "SELECT id FROM bz_usage_services WHERE id=? AND state<>'deleted' FOR SHARE", [serviceId]))[0];
        usageAssert(service, 'USAGE_SERVICE_NOT_FOUND', 'A selected model service does not exist.', 404);
      }
      const now = await this.now(c);
      const out: BillingPlan = { id, label: title, revision: revision + 1, state: b.state ?? old?.state ?? 'active', config, createdAt: Number(old?.created_at ?? now), updatedAt: now };
      await c.query('INSERT INTO bz_usage_billing_plans(id,label,revision,state,config_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE label=VALUES(label),revision=VALUES(revision),state=VALUES(state),config_json=VALUES(config_json),updated_at=VALUES(updated_at)',
        [id, title, out.revision, out.state, JSON.stringify(config), out.createdAt, now]);
      return out;
    });
  }
  async grant(accountId: string, value: unknown, sourceOwner = 'hub'): Promise<BillingGrant> {
    assertKnownFields(value, ['request_key','plan_id','expected_revision','starts_at'], 'Token grant');
    const b = value as Row, requestKey = billingKey(b.request_key), planId = billingKey(b.plan_id), expectedRevision = integer(b.expected_revision, 'expected_revision');
    billingKey(sourceOwner, 'sourceOwner');
    if (b.starts_at !== undefined) integer(b.starts_at, 'starts_at');
    return this.repository.withTransaction(async c => {
      const account = await this.lockAccount(c, accountId);
      usageAssert(account.state === 'active', 'USAGE_ACCOUNT_SUSPENDED', 'Account is suspended.', 403);
      if (sourceOwner.startsWith('issuer:')) {
        const issuer = (await rows(c, 'SELECT state FROM bz_usage_issuers WHERE id=? FOR SHARE', [sourceOwner.slice(7)]))[0];
        usageAssert(issuer?.state === 'active', 'USAGE_ISSUER_REQUIRED', '原身份来源已停用或删除，不能发放新的额度。', 401);
      }
      const result = await this.mutate(c, `grant:${accountId}:${sourceOwner}`, requestKey, b, async () => {
        const old = await this.currentGrant(c, accountId, true);
        usageAssert((old?.revision ?? 0) === expectedRevision, 'USAGE_REVISION_CONFLICT', 'Account plan changed; refresh before granting.');
        usageAssert(!old || old.sourceOwner === sourceOwner, 'USAGE_SOURCE_CONFLICT', 'Another source owns this account plan.', 403);
        const p = (await rows(c, 'SELECT * FROM bz_usage_billing_plans WHERE id=? FOR SHARE', [planId]))[0];
        usageAssert(p?.state === 'active', 'SERVICE_NOT_ENTITLED', 'The selected plan is not active.', 403);
        const planConfig = validateBillingPlan(json(p.config_json)), config = billingAllowance(planConfig), now = await this.now(c), startsAt = b.starts_at ?? now;
        await this.requireAvailableServiceIdentities(c, planConfig.serviceIds);
        const out: BillingGrant = { id: randomUUID(), accountId, planId, planRevision: Number(p.revision), label: p.label, revision: expectedRevision + 1, state: 'active', sourceOwner,
          startsAt, expiresAt: billingExpiry(startsAt, config.duration), config };
        await c.query('INSERT INTO bz_usage_billing_grants(id,account_id,plan_id,plan_revision,label,revision,state,source_owner,starts_at,expires_at,config_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
          [out.id, accountId, planId, out.planRevision, out.label, out.revision, out.state, sourceOwner, startsAt, out.expiresAt, JSON.stringify(config), now, now]);
        await c.query('INSERT INTO bz_usage_billing_heads(account_id,grant_id,revision) VALUES(?,?,?) ON DUPLICATE KEY UPDATE grant_id=VALUES(grant_id),revision=VALUES(revision)', [accountId, out.id, out.revision]);
        return out;
      });
      return { ...result, config: billingAllowance(result.config) };
    });
  }
  /** Issue a fresh allowance window without erasing prior consumption or extending expiry. */
  async resetAllowance(accountId: string, value: unknown, actor: string): Promise<BillingGrant> {
    assertKnownFields(value, ['request_key','expected_revision'], 'Allowance reset');
    const b = value as Row, requestKey = billingKey(b.request_key), expectedRevision = integer(b.expected_revision, 'expected_revision', 1);
    label(actor);
    return this.repository.withTransaction(async c => {
      const account = await this.lockAccount(c, accountId);
      usageAssert(account.state === 'active', 'USAGE_ACCOUNT_SUSPENDED', '请先启用账户。', 403);
      return this.mutate(c, `reset:${accountId}`, requestKey, { ...b, actor }, async () => {
        const old = await this.currentGrant(c, accountId, true), now = await this.now(c);
        usageAssert(old, 'SERVICE_NOT_ENTITLED', '账户尚未开通套餐。', 403);
        usageAssert(old.sourceOwner === 'hub', 'USAGE_SOURCE_CONFLICT', '此额度由业务后端维护，请在原来源调整。', 403);
        usageAssert(old.revision === expectedRevision, 'USAGE_REVISION_CONFLICT', '账户套餐已更新，请刷新后重置。');
        usageAssert(old.state === 'active' && billingPeriod(old, now), 'SERVICE_NOT_ENTITLED', '只能重置已经生效且未暂停、未到期的套餐。', 403);
        usageAssert(await this.currentPlan(c, old.planId), 'SERVICE_NOT_ENTITLED', '原套餐已删除，请先开通有效套餐。', 403);
        // The new pool is independent even for resets in the same millisecond.
        // Original dispatched requests retain their immutable grant and period.
        const out = { ...old, id: randomUUID(), revision: old.revision + 1, startsAt: now,
          reset: { previousGrantId: old.id, actor, at: now } };
        await c.query('INSERT INTO bz_usage_billing_grants(id,account_id,plan_id,plan_revision,label,revision,state,source_owner,starts_at,expires_at,config_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
          [out.id, accountId, out.planId, out.planRevision, out.label, out.revision, out.state, out.sourceOwner, now, out.expiresAt, JSON.stringify(out.config), now, now]);
        await c.query('UPDATE bz_usage_billing_heads SET grant_id=?,revision=? WHERE account_id=?', [out.id, out.revision, accountId]);
        return out;
      });
    });
  }
  async control(accountId: string, value: unknown, sourceOwner = 'hub'): Promise<BillingGrant> {
    assertKnownFields(value, ['request_key','expected_revision','state'], 'Token control');
    const b = value as Row, expectedRevision = integer(b.expected_revision, 'expected_revision');
    billingKey(sourceOwner, 'sourceOwner'); billingKey(b.request_key, 'request_key');
    usageAssert(['active','suspended'].includes(b.state), 'USAGE_INVALID_INPUT', 'Invalid plan state.', 400);
    return this.repository.withTransaction(async c => {
      const account = await this.lockAccount(c, accountId);
      usageAssert(account.state !== 'archived', 'USAGE_ACCOUNT_SUSPENDED', '账户已移除，请先恢复原账户。', 403);
      const result = await this.mutate(c, `control:${accountId}:${sourceOwner}`, b.request_key, b, async () => {
        const old = await this.currentGrant(c, accountId, true);
        usageAssert(old, 'SERVICE_NOT_ENTITLED', 'No plan.', 403);
        usageAssert(old.sourceOwner === sourceOwner, 'USAGE_SOURCE_CONFLICT', 'Another source owns this account plan.', 403);
        usageAssert(old.revision === expectedRevision, 'USAGE_REVISION_CONFLICT', 'Account plan changed; refresh before changing state.');
        if (b.state === 'active') usageAssert(await this.currentPlan(c, old.planId), 'SERVICE_NOT_ENTITLED', '原套餐已删除，请重新开通可用套餐。', 403);
        await c.query('UPDATE bz_usage_billing_grants SET state=?,revision=revision+1,updated_at=? WHERE id=?', [b.state, await this.now(c), old.id]);
        await c.query('UPDATE bz_usage_billing_heads SET revision=revision+1 WHERE account_id=?', [accountId]);
        return { ...old, revision: old.revision + 1, state: b.state };
      });
      return { ...result, config: billingAllowance(result.config) };
    });
  }
  private async requireAvailableServiceIdentities(c: PoolConnection, serviceIds: string[]): Promise<void> {
    for (const id of [...serviceIds].sort()) {
      const service = (await rows(c, "SELECT id FROM bz_usage_services WHERE id=? AND state<>'deleted' FOR SHARE", [id]))[0];
      usageAssert(service, 'USAGE_SERVICE_NOT_FOUND', '套餐引用的模型服务已删除，请先调整套餐。', 404);
    }
  }
  async summary(accountId: string): Promise<BillingSummary> {
    return this.repository.withTransaction(async c => {
      const a = await this.lockAccount(c, accountId), g = await this.currentGrant(c, accountId), now = await this.now(c);
      integer(now, 'now');
      const currentPlan = g ? await this.currentPlan(c, g.planId) : null;
      const period = g ? billingPeriod(g, now) : null;
      const aggregate = g ? (await rows(c, 'SELECT COALESCE(SUM(consumed_usd),0) AS total,COALESCE(SUM(CASE WHEN period_start=? THEN consumed_usd ELSE 0 END),0) AS current FROM bz_usage_billing_periods WHERE grant_id=?', [period?.start ?? -1, g.id]))[0]! : { total: 0, current: 0 };
      const consumed = usdMicros(aggregate.current), quota = g ? usdMicros(billingAllowanceUsd(g.config)) : 0n, active = a.state === 'active' && g?.state === 'active' && currentPlan && period;
      const pending = Number((await rows(c, "SELECT COUNT(*) AS n FROM bz_usage_billing_requests WHERE account_id=? AND billing_state='pending'", [accountId]))[0]!.n);
      const available = active ? positivePart(quota - consumed) : 0n, availableUsd = usdAmount(available);
      return { schema: 'bailing.billing-summary.v1', accountId, grant: g, plan: currentPlan, availableUsd,
        consumedUsd: usdAmount(usdMicros(aggregate.total)), currentPeriodConsumedUsd: usdAmount(consumed), overageUsd: g && period ? usdAmount(positivePart(consumed - quota)) : 0,
        resetAt: g?.config.mode === 'periodic' && period && period.end !== g.expiresAt ? period.end : null, expiresAt: g?.expiresAt ?? null, pendingRequests: pending,
        presentation: usagePresentation(a.state, g, usdDecimal(available), now) };
    });
  }
  private async currentPlan(c: PoolConnection, planId: string): Promise<BillingSummary['plan']> {
    const row = (await rows(c, 'SELECT id,label,revision,config_json FROM bz_usage_billing_plans WHERE id=? AND state<>\'deleted\' FOR SHARE', [planId]))[0];
    if (!row) return null;
    const config = validateBillingPlan(json(row.config_json));
    return { id: row.id, label: row.label, revision: Number(row.revision), serviceIds: config.serviceIds, multiplier: config.multiplier };
  }
  private async requirePlanService(c: PoolConnection, grant: BillingGrant, serviceId: string): Promise<NonNullable<BillingSummary['plan']>> {
    const plan = await this.currentPlan(c, grant.planId);
    if (!plan?.serviceIds.includes(serviceId)) throw new UsageError('SERVICE_NOT_ENTITLED', 'This model is not included in the current plan.', 403, { next_action: 'select_model' });
    return plan;
  }
  private async scope(c: PoolConnection, actor: UsageActor, serviceId: string): Promise<void> {
    await this.repository.validateActor(c, actor);
    const s = (await rows(c, 'SELECT service_id,model_access FROM bz_usage_sessions WHERE id=? FOR SHARE', [actor.sessionId]))[0];
    usageAssert(s && (s.model_access === 'token_gateway' || s.service_id === serviceId),
      'USAGE_ACCOUNT_FORBIDDEN', 'The original usage credential does not permit this model service.', 403);
  }
  async findRequest(actor: UsageActor, operationId: string): Promise<BillingRequest | null> {
    billingKey(operationId, 'operation_id');
    const found = await this.repository.withTransaction(async c => {
      await this.lockAccount(c, actor.accountId); await this.repository.validateActor(c, actor);
      const r = (await rows(c, 'SELECT * FROM bz_usage_billing_requests WHERE id=?', [operationIdKey(actor, operationId)]))[0];
      if (!r) return null;
      await this.scope(c, actor, r.service_id); return request(r);
    });
    // Reads and original-result recovery never wait for financial aggregation.
    return found;
  }
  async listRequests(accountId: string, options: { limit?: number; cursor?: string | null } = {}) {
    billingKey(accountId, 'accountId', 64); const limit = integer(options.limit ?? 30, 'limit', 1, 100);
    const cursor = options.cursor ? billingKey(options.cursor, 'cursor', 64) : null;
    const anchor = cursor ? (await rows(this.repository.getPool(), 'SELECT created_at FROM bz_usage_billing_requests WHERE account_id=? AND id=?', [accountId, cursor]))[0] : null;
    usageAssert(!cursor || anchor, 'USAGE_INVALID_INPUT', 'Invalid request cursor for this account.', 400);
    const page = await rows(this.repository.getPool(), `SELECT * FROM bz_usage_billing_requests WHERE account_id=?${cursor ? ' AND (created_at<? OR (created_at=? AND id<?))' : ''} ORDER BY created_at DESC,id DESC LIMIT ?`, [accountId, ...(cursor ? [anchor!.created_at, anchor!.created_at, cursor] : []), limit + 1]);
    return { items: page.slice(0, limit).map(r => this.view(request(r))), next_cursor: page.length > limit ? String(page[limit - 1]!.id) : null };
  }
  async admit(i: BillingAdmissionInput): Promise<BillingRequest> {
    billingKey(i.operationId, 'operation_id'); billingKey(i.serviceId, 'service_id');
    if (i.conversationId !== null) billingKey(i.conversationId, 'conversation_id');
    if (i.turnId !== null) billingKey(i.turnId, 'turn_id');
    usageAssert(typeof i.requestHash === 'string' && /^[a-f0-9]{64}$/.test(i.requestHash), 'USAGE_INVALID_INPUT', 'Invalid request hash.', 400);
    return this.repository.withTransaction(async c => {
      await this.lockAccount(c, i.actor.accountId); await this.scope(c, i.actor, i.serviceId);
      const id = operationIdKey(i.actor, i.operationId), prior = (await rows(c, 'SELECT * FROM bz_usage_billing_requests WHERE id=? FOR UPDATE', [id]))[0];
      if (prior) {
        usageAssert(prior.request_hash === i.requestHash && prior.service_id === i.serviceId && prior.conversation_id === i.conversationId && prior.turn_id === i.turnId,
          'USAGE_IDEMPOTENCY_CONFLICT', 'The original operation ID has different input.');
        return { ...request(prior), created: false };
      }
      const now = await this.now(c), g = await this.currentGrant(c, i.actor.accountId, true);
      usageAssert(g && g.state === 'active', 'SERVICE_NOT_ENTITLED', 'No active plan.', 403);
      const period = billingPeriod(g, now);
      usageAssert(period, 'SUBSCRIPTION_EXPIRED', 'The plan is not currently valid.', 403);
      const plan = await this.requirePlanService(c, g, i.serviceId);
      const billingRate = tokenBillingRate(plan.id, plan.revision, plan.multiplier, i.priceSnapshot);
      const service = (await rows(c, 'SELECT * FROM bz_usage_services WHERE id=? FOR SHARE', [i.serviceId]))[0];
      usageAssert(service?.state === 'active', 'METERING_UNAVAILABLE', 'Model service is unavailable.', 503);
      usageAssert(Number(service.revision) === i.expectedServiceRevision && usageHash(json(service.config_json)) === usageHash(i.serviceConfig)
        && json<{ model: string }>(service.config_json).model === i.model, 'USAGE_REVISION_CONFLICT', 'Model service changed; reload its configuration.');
      await c.query('INSERT IGNORE INTO bz_usage_billing_periods(grant_id,period_start,period_end,allowance_usd,consumed_usd) VALUES(?,?,?,?,0)', [g.id, period.start, period.end, billingAllowanceUsd(g.config)]);
      const pool = (await rows(c, 'SELECT * FROM bz_usage_billing_periods WHERE grant_id=? AND period_start=? FOR UPDATE', [g.id, period.start]))[0]!;
      if (usdMicros(pool.consumed_usd) >= usdMicros(billingAllowanceUsd(g.config))) throw new UsageError(g.config.mode === 'periodic' ? 'QUOTA_WINDOW_EXHAUSTED' : 'ALLOWANCE_INSUFFICIENT', 'The allowance is exhausted. Current replies may finish; no new model request was sent.', 402, { resetAt: g.config.mode === 'periodic' ? period.end : null });
      await c.query(`INSERT INTO bz_usage_billing_requests(id,operation_id,account_id,user_id,session_id,service_id,conversation_id,turn_id,request_hash,revision,state,result_state,billing_state,service_revision,service_json,model,grant_id,grant_revision,grant_json,billing_rate_json,period_start,period_end,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,1,'admitted','pending','pending',?,?,?,?,?,?,?,?,?,?,?)`,
        [id, i.operationId, i.actor.accountId, i.actor.userId, i.actor.sessionId, i.serviceId, i.conversationId, i.turnId, i.requestHash,
          i.expectedServiceRevision, JSON.stringify(i.serviceConfig), i.model, g.id, g.revision, JSON.stringify(g.config), JSON.stringify(billingRate), period.start, period.end, now, now]);
      return { ...request((await rows(c, 'SELECT * FROM bz_usage_billing_requests WHERE id=?', [id]))[0]!), created: true };
    });
  }
  private async locked(c: PoolConnection, id: string): Promise<Row> {
    const hint = (await rows(c, 'SELECT account_id FROM bz_usage_billing_requests WHERE id=?', [billingKey(id)]))[0];
    usageAssert(hint, 'USAGE_OPERATION_NOT_FOUND', 'Original model request not found.', 404);
    await this.lockAccount(c, hint.account_id);
    return (await rows(c, 'SELECT * FROM bz_usage_billing_requests WHERE id=? FOR UPDATE', [id]))[0]!;
  }
  async commitDispatch(id: string, actor: UsageActor): Promise<BillingRequest> {
    return this.repository.withTransaction(async c => {
      const r = await this.locked(c, id);
      usageAssert(r.account_id === actor.accountId && r.user_id === actor.userId, 'USAGE_ACCOUNT_FORBIDDEN', 'Original request belongs to another user.', 403);
      await this.scope(c, actor, r.service_id);
      usageAssert(r.state === 'admitted', 'USAGE_PENDING', 'This original request cannot obtain another dispatch permit.');
      const g = await this.currentGrant(c, actor.accountId, true), now = await this.now(c);
      usageAssert(g && g.id === r.grant_id && g.revision === Number(r.grant_revision) && g.state === 'active' && billingPeriod(g, now), 'SERVICE_NOT_ENTITLED', 'The original plan has changed or is no longer active.', 403);
      await this.requirePlanService(c, g, r.service_id);
      const service = (await rows(c, 'SELECT * FROM bz_usage_services WHERE id=? FOR SHARE', [r.service_id]))[0];
      usageAssert(service?.state === 'active' && Number(service.revision) === Number(r.service_revision), 'USAGE_REVISION_CONFLICT', 'The original model configuration has changed.');
      const fence = randomUUID();
      await c.query("UPDATE bz_usage_billing_requests SET state='dispatch_committed',fence=?,revision=revision+1,updated_at=? WHERE id=?", [fence, now, id]);
      return request((await rows(c, 'SELECT * FROM bz_usage_billing_requests WHERE id=?', [id]))[0]!);
    });
  }
  async recordCompletion(id: string, fence: string, input: BillingCompletionInput): Promise<BillingRequest> {
    usageAssert(input.response && typeof input.response === 'object' && !Array.isArray(input.response), 'USAGE_INVALID_INPUT', 'A complete model result is required.', 400);
    const measured = input.usage === undefined ? null : tokenUsage(input.usage), responseHash = usageHash(input.response);
    // Persist the usable answer before touching the financial aggregate. A later
    // settlement outage must not turn a completed reply into an unknown model run.
    const recorded = await this.repository.withTransaction(async c => {
      const r = await this.locked(c, id);
      usageAssert(r.fence && r.fence === fence, 'USAGE_FENCE_CONFLICT', 'This result does not match the original dispatch.');
      usageAssert(['dispatch_committed','unknown','completed','cancelled'].includes(r.state), 'USAGE_OPERATION_ENDED', 'This request was not dispatched.');
      usageAssert(!r.result_hash || r.result_hash === responseHash, 'USAGE_RECEIPT_CONFLICT', 'The original result has different evidence.');
      usageAssert(!r.usage_json || !measured || usageHash(json(r.usage_json)) === usageHash(measured), 'USAGE_RECEIPT_CONFLICT', 'The original usage has different evidence.');
      const executionKey = input.executionId ? usageHash([json<{ providerScope: string }>(r.service_json).providerScope, input.executionId]) : null;
      if (executionKey) {
        const owner = (await rows(c, 'SELECT id FROM bz_usage_billing_requests WHERE execution_key=? FOR UPDATE', [executionKey]))[0];
        usageAssert(!owner || owner.id === id, 'USAGE_RECEIPT_CONFLICT', 'This supplier execution already belongs to another request.');
        usageAssert(!r.execution_key || r.execution_key === executionKey, 'USAGE_RECEIPT_CONFLICT', 'Supplier execution identity changed.');
      }
      usageAssert(!r.raw_usage_json || !input.rawUsage || usageHash(json(r.raw_usage_json)) === usageHash(input.rawUsage), 'USAGE_RECEIPT_CONFLICT', 'The original raw usage has different evidence.');
      if (r.billing_state === 'settled') return request(r);
      const now = await this.now(c), cancelled = r.cancelled_at !== null;
      await c.query('UPDATE bz_usage_billing_requests SET state=?,result_state=?,result_json=?,result_hash=?,usage_json=COALESCE(usage_json,?),raw_usage_json=COALESCE(raw_usage_json,?),execution_key=COALESCE(execution_key,?),resolution=?,revision=revision+1,updated_at=? WHERE id=?',
        [cancelled ? 'cancelled' : 'completed', cancelled ? 'cancelled' : 'complete', JSON.stringify(input.response), responseHash,
          measured ? JSON.stringify(measured) : null, input.rawUsage ? JSON.stringify(input.rawUsage) : null, executionKey, measured || input.rawUsage ? 'settlement_pending' : 'usage_missing', now, id]);
      return request((await rows(c, 'SELECT * FROM bz_usage_billing_requests WHERE id=?', [id]))[0]!);
    });
    return recorded;
  }
  /** Explicit combined operation for internal reconciliation; never awaited by model delivery. */
  async complete(id: string, fence: string, input: BillingCompletionInput): Promise<BillingRequest> {
    const recorded = await this.recordCompletion(id, fence, input);
    return recorded.billingState === 'pending' && (recorded.usage || recorded.rawUsage) ? this.settleRecorded(recorded) : recorded;
  }
  private readonly settlements = new Map<string, Promise<void>>();
  scheduleSettlement(operationId: string, actor: UsageActor): void {
    const key = operationIdKey(actor, operationId);
    if (this.settlements.has(key)) return;
    const work = Promise.resolve().then(async () => {
      const r = await this.findRequest(actor, operationId);
      if (r?.billingState === 'pending' && (r.usage || r.rawUsage) && r.resultHash) await this.settleRecorded(r);
    }).catch(() => { /* Durable pending evidence is retried by maintenance. */ })
      .finally(() => { this.settlements.delete(key); });
    this.settlements.set(key, work);
  }
  async drainSettlements(): Promise<void> { await Promise.allSettled([...this.settlements.values()]); }
  private async settleRecorded(recorded: BillingRequest): Promise<BillingRequest> {
    try {
      return await this.repository.withTransaction(async c => {
        const r = await this.locked(c, recorded.id);
        usageAssert(r.fence === recorded.fence, 'USAGE_FENCE_CONFLICT', 'Settlement does not match the original dispatch.');
        if (r.billing_state === 'settled' || (!r.usage_json && !r.raw_usage_json) || !r.result_hash) return request(r);
        const measured = r.usage_json ? tokenUsage(json(r.usage_json)) : null;
        const p = (await rows(c, 'SELECT * FROM bz_usage_billing_periods WHERE grant_id=? AND period_start=? FOR UPDATE', [r.grant_id, r.period_start]))[0];
        usageAssert(p, 'METERING_UNAVAILABLE', 'The original allowance pool is unavailable.', 503);
        const rate = request(r).billingRate;
        const referenceCost = calculateReferenceCost(rate.price, { ...(json<Record<string, unknown>>(r.raw_usage_json) ?? {}), ...(measured ?? {}) });
        if (referenceCost === null) return request(r);
        const charged = billedUsdMicros(referenceCost, rate.multiplier);
        const before = usdMicros(p.consumed_usd), after = before + charged, quota = usdMicros(p.allowance_usd);
        const overage = positivePart(after - quota) - positivePart(before - quota), now = await this.now(c);
        // The numeric API must not silently lose fractional evidence at extreme magnitudes.
        usdAmount(charged); usdAmount(after); usdAmount(overage); usdAmount(positivePart(quota - after));
        const chargedValue = usdDecimal(charged), afterValue = usdDecimal(after), overageValue = usdDecimal(overage);
        await c.query('UPDATE bz_usage_billing_periods SET consumed_usd=? WHERE grant_id=? AND period_start=?', [afterValue, r.grant_id, r.period_start]);
        await c.query('INSERT INTO bz_usage_billing_ledger(request_id,account_id,grant_id,period_start,input_tokens,output_tokens,reference_cost_usd,billed_usd,overage_usd,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
          [r.id, r.account_id, r.grant_id, r.period_start, measured?.inputTokens ?? null, measured?.outputTokens ?? null, referenceCost, chargedValue, overageValue, now]);
        await c.query("UPDATE bz_usage_billing_requests SET billing_state='settled',reference_cost_usd=?,billed_usd=?,overage_usd=?,resolution='actual_usage',revision=revision+1,updated_at=? WHERE id=?", [referenceCost, chargedValue, overageValue, now, r.id]);
        return request((await rows(c, 'SELECT * FROM bz_usage_billing_requests WHERE id=?', [r.id]))[0]!);
      });
    } catch (e) {
      if (e instanceof UsageError && e.status < 500) throw e;
      // Durable evidence remains available for the original request to reconcile.
      return recorded;
    }
  }
  async cleanupExpiredResponses(now = Date.now()): Promise<void> {
    integer(now, 'now');
    await this.repository.getPool().query('UPDATE bz_usage_billing_requests SET result_json=NULL WHERE created_at<? AND result_json IS NOT NULL AND result_hash IS NOT NULL LIMIT 500', [now - RESULT_RETENTION_MS]);
  }
  async reconcilePendingUsage(): Promise<void> {
    // Only previously saved supplier evidence may settle in maintenance. This
    // path has no credentials/provider transport and cannot create model work.
    const pending = await rows(this.repository.getPool(), "SELECT * FROM bz_usage_billing_requests WHERE billing_state='pending' AND (usage_json IS NOT NULL OR raw_usage_json IS NOT NULL) AND result_hash IS NOT NULL AND fence IS NOT NULL ORDER BY updated_at,id LIMIT 50");
    for (const row of pending) await this.settleRecorded(request(row));
  }
  /** Persist a terminal rejection independently of settlement; never dispatch again. */
  async recordProviderFailure(id: string, fence: string, failure: ProviderFailure): Promise<BillingRequest> {
    return this.repository.withTransaction(async c => {
      const r = await this.locked(c, id);
      usageAssert(r.fence && r.fence === fence, 'USAGE_FENCE_CONFLICT', 'Failure does not match original dispatch.');
      if (r.billing_state === 'settled' || r.result_state === 'complete' || r.result_state === 'failed') return request(r);
      const cancelled = r.cancelled_at !== null, rejected = failure.rejected;
      await c.query('UPDATE bz_usage_billing_requests SET state=?,result_state=?,billing_state=?,result_json=?,reference_cost_usd=?,billed_usd=?,overage_usd=?,resolution=?,revision=revision+1,updated_at=? WHERE id=?',
        [cancelled ? 'cancelled' : rejected ? 'failed' : 'unknown', cancelled ? 'cancelled' : rejected ? 'failed' : 'unknown',
          rejected ? 'settled' : 'pending', JSON.stringify({schema:'bailing.provider-failure.v1',error:failure.diagnostic}),
          rejected ? 0 : null, rejected ? 0 : null, rejected ? 0 : null, failure.code, await this.now(c), id]);
      return request((await rows(c, 'SELECT * FROM bz_usage_billing_requests WHERE id=?', [id]))[0]!);
    });
  }
  async markUnknown(id: string, fence: string, reason: string): Promise<BillingRequest> {
    billingKey(reason, 'reason', 64);
    return this.repository.withTransaction(async c => {
      const r = await this.locked(c, id);
      usageAssert(r.fence && r.fence === fence, 'USAGE_FENCE_CONFLICT', 'The uncertainty report does not match original dispatch.');
      if (r.billing_state === 'settled' || r.result_state === 'complete' || r.result_state === 'cancelled' || r.result_state === 'failed') return request(r);
      await c.query("UPDATE bz_usage_billing_requests SET state='unknown',result_state='unknown',resolution=?,revision=revision+1,updated_at=? WHERE id=?", [reason, await this.now(c), id]);
      return request((await rows(c, 'SELECT * FROM bz_usage_billing_requests WHERE id=?', [id]))[0]!);
    });
  }
  async cancel(actor: UsageActor, operationId: string): Promise<BillingRequest> {
    billingKey(operationId, 'operation_id');
    return this.repository.withTransaction(async c => {
      const r = await this.locked(c, operationIdKey(actor, operationId)); await this.scope(c, actor, r.service_id);
      if (r.cancelled_at !== null || r.result_state === 'complete') return request(r);
      if (r.result_state === 'failed') return request(r);
      const now = await this.now(c), sent = r.fence !== null;
      await c.query("UPDATE bz_usage_billing_requests SET state='cancelled',result_state='cancelled',billing_state=?,reference_cost_usd=?,billed_usd=?,overage_usd=?,cancelled_at=?,resolution=?,revision=revision+1,updated_at=? WHERE id=?",
        [sent ? 'pending' : 'settled', sent ? null : 0, sent ? null : 0, sent ? null : 0, now, sent ? 'cancel_requested' : 'cancelled_before_dispatch', now, r.id]);
      return request((await rows(c, 'SELECT * FROM bz_usage_billing_requests WHERE id=?', [r.id]))[0]!);
    });
  }
  /** Recovery metadata is durable. Response content is returned for seven days only. */
  view(r: BillingRequest, now = Date.now()) {
    const responseExpired = r.resultHash !== null && now - r.createdAt > RESULT_RETENTION_MS;
    const diagnostic = r.response?.schema === 'bailing.provider-failure.v1' ? r.response.error as ProviderDiagnostic : undefined;
    return { schema: 'bailing.model-operation.v1' as const, operation_id: r.operationId, account_id: r.accountId, user_id: r.userId,
      service_id: r.serviceId, conversation_id: r.conversationId, turn_id: r.turnId, state: r.state, result_state: r.resultState,
      billing_state: r.billingState, billing_rate: r.billingRate, dispatch: r.resultState === 'failed' ? 'rejected' as const : r.fence === null ? 'not_dispatched' as const : r.resultHash !== null ? 'completed' as const : 'unknown' as const,
      ...(diagnostic ? {error:diagnostic} : {}),
      next_action: r.resultState === 'failed' ? 'contact_operator' as const : r.resultState === 'unknown' || r.resultState === 'pending' ? 'inspect_original' as const : 'none' as const,
      revision: r.revision, ...(r.resultState === 'complete' && r.response && !responseExpired ? { response: r.response } : {}),
      ...(responseExpired ? { response_expired: true } : {}), usage: r.usage, raw_usage: publicRawUsage(r.rawUsage), reference_cost_usd: r.referenceCostUsd, billed_usd: r.billedUsd, overage_usd: r.overageUsd };
  }
}
const repositories = new WeakMap<UsageRepository, BillingRepository>();
export function getBillingRepository(repository: UsageRepository): BillingRepository {
  let value = repositories.get(repository);
  if (!value) { value = new BillingRepository(repository); repositories.set(repository, value); }
  return value;
}
