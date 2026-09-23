import { validatePricingBinding } from './pricing';
import { validateModelToolConfig } from './model-tools';
import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolConnection, RowDataPacket } from "mysql2/promise";
import type { CreateUsageAccountInput, UsageAccount, UsageActor, UsageActorValidator, UsageService, UsageServiceConfig } from "./contracts";
import { integer, assertKnownFields } from "./validation";
import { usageAssert } from "./errors";
type Row = Record<string, any>;
// Impact previews derive account models from each current grant's plan.
function serviceReferenceSources(id: string) {
  const selected = "p.state<>'deleted' AND JSON_CONTAINS(p.config_json,JSON_QUOTE(?),'$.serviceIds')";
  return {
    plans: { from: 'bz_usage_billing_plans p', where: selected, params: [id] },
    accounts: { from: 'bz_usage_billing_heads h JOIN bz_usage_billing_grants g ON g.id=h.grant_id JOIN bz_usage_billing_plans p ON p.id=g.plan_id',
      where: selected, params: [id] },
    requests: { from: 'bz_usage_billing_requests r', where: 'r.service_id=?', params: [id] },
  };
}
function stable(v: unknown): string {
  if (Array.isArray(v)) return "[" + v.map(stable).join(",") + "]";
  if (v && typeof v === "object")
    return (
      "{" +
      Object.keys(v as Row)
        .sort()
        .filter((k) => (v as Row)[k] !== undefined)
        .map((k) => JSON.stringify(k) + ":" + stable((v as Row)[k]))
        .join(",") +
      "}"
    );
  return JSON.stringify(v) ?? "null";
}
export function usageHash(v: unknown): string {
  return createHash("sha256").update(stable(v)).digest("hex");
}
export function operationIdKey(actor: UsageActor, operationId: string): string {
  return usageHash([actor.userId, actor.accountId, operationId]);
}
function json<T>(v: unknown): T {
  return (typeof v === "string" ? JSON.parse(v) : v) as T;
}
function key(v: string, name = "id", max = 191): string {
  usageAssert(
    typeof v === "string" &&
      v.length > 0 &&
      v.length <= max &&
      !/[\x00-\x1f]/.test(v),
    "USAGE_INVALID_INPUT",
    `Invalid ${name}.`,
    400,
  );
  return v;
}
async function rows(
  c: Pool | PoolConnection,
  sql: string,
  p: unknown[] = [],
): Promise<Row[]> {
  return (await c.query<RowDataPacket[]>(sql, p))[0] as Row[];
}
function account(r: Row): UsageAccount {
  return {
    id: r.id,
    kind: r.kind,
    label: r.label,
    state: r.state,
    revision: Number(r.revision),
    createdAt: Number(r.created_at),
    updatedAt: Number(r.updated_at),
  };
}
function service(r: Row): UsageService {
  return {
    id: r.id,
    label: r.label,
    state: r.state,
    revision: Number(r.revision),
    config: json(r.config_json),
  };
}
export class UsageRepository {
  private validator: UsageActorValidator | undefined;
  constructor(private readonly pool: () => Pool) {}
  getPool(): Pool {
    return this.pool();
  }
  setActorValidator(v: UsageActorValidator): void {
    this.validator = v;
  }
  async withTransaction<T>(fn: (c: PoolConnection) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const c = await this.pool().getConnection();
      try {
        await c.beginTransaction();
        const out = await fn(c);
        await c.commit();
        return out;
      } catch (e) {
        await c.rollback().catch(() => undefined);
        if (
          attempt < 2 &&
          ["ER_LOCK_DEADLOCK", "ER_LOCK_WAIT_TIMEOUT", "ER_DUP_ENTRY"].includes(
            String((e as { code?: string }).code),
          )
        )
          continue;
        throw e;
      } finally {
        c.release();
      }
    }
  }
  private async now(c: PoolConnection): Promise<number> {
    return Number(
      (
        await rows(
          c,
          "SELECT CAST(UNIX_TIMESTAMP(CURRENT_TIMESTAMP(3))*1000 AS UNSIGNED) AS ms",
        )
      )[0]!.ms,
    );
  }
  private async lockAccount(
    c: PoolConnection,
    id: string,
  ): Promise<UsageAccount> {
    const r = (
      await rows(c, "SELECT * FROM bz_usage_accounts WHERE id=? FOR UPDATE", [
        key(id),
      ])
    )[0];
    usageAssert(r, "USAGE_ACCOUNT_NOT_FOUND", "Account not found.", 404);
    usageAssert(r.state !== "deleted", "USAGE_RESOURCE_DELETED", "账户已删除，不能恢复或重新关联。");
    usageAssert(r.state !== "archived", "USAGE_ACCOUNT_SUSPENDED", "账户已移除，请由管理员恢复原账户。", 403);
    return account(r);
  }
  /** Shared identity/account lock validation for the request-based Token ledger. */
  async validateActor(c: PoolConnection, actor: UsageActor): Promise<void> { await this.checkActor(c, actor); }

  private async checkActor(c: PoolConnection, a: UsageActor): Promise<void> {
    const acc = await this.lockAccount(c, a.accountId);
    usageAssert(
      acc.state === "active",
      "USAGE_ACCOUNT_SUSPENDED",
      "Account is suspended.",
      403,
    );
    const m = (
      await rows(
        c,
        "SELECT state FROM bz_usage_members WHERE account_id=? AND user_id=? FOR UPDATE",
        [a.accountId, a.userId],
      )
    )[0];
    usageAssert(
      m?.state === "active",
      "USAGE_ACCOUNT_FORBIDDEN",
      "Membership is not active.",
      403,
    );
    usageAssert(
      this.validator,
      "METERING_UNAVAILABLE",
      "Usage identity validation is unavailable.",
      503,
    );
    await this.validator(c, a);
  }
  private async mutate<T>(
    c: PoolConnection,
    domain: string,
    id: string,
    input: unknown,
    fn: () => Promise<T>,
    reserveKey = false,
  ): Promise<T> {
    const ck = usageHash([domain, key(id)]),
      hash = usageHash(input);
    if (reserveKey) {
      // Account creation has no existing account row to serialize on. Reserve its
      // idempotency key atomically instead of taking a missing-key gap lock. JSON
      // null is an uncommitted placeholder; account/result are committed together.
      await c.query(
        "INSERT INTO bz_usage_changes(change_key,request_hash,result_json,created_at) VALUES(?,?,'null',?) ON DUPLICATE KEY UPDATE change_key=change_key",
        [ck, hash, await this.now(c)],
      );
    }
    const old = (
      await rows(
        c,
        "SELECT * FROM bz_usage_changes WHERE change_key=? FOR UPDATE",
        [ck],
      )
    )[0];
    if (old) {
      usageAssert(
        old.request_hash === hash,
        "USAGE_IDEMPOTENCY_CONFLICT",
        "The request ID is already bound to different input.",
      );
      const saved = json<T | null>(old.result_json);
      if (!reserveKey || saved !== null) return saved as T;
    }
    const result = await fn();
    if (reserveKey) {
      await c.query("UPDATE bz_usage_changes SET result_json=? WHERE change_key=?", [JSON.stringify(result), ck]);
    } else {
      await c.query(
        "INSERT INTO bz_usage_changes(change_key,request_hash,result_json,created_at) VALUES(?,?,?,?)",
        [ck, hash, JSON.stringify(result), await this.now(c)],
      );
    }
    return result;
  }
  async createAccountInTransaction(
    c: PoolConnection,
    i: CreateUsageAccountInput,
  ): Promise<UsageAccount> {
    key(i.sourceOwner);
    key(i.sourceId);
    key(i.userId);
    key(i.label);
    usageAssert(
      ["personal", "organization"].includes(i.kind),
      "USAGE_INVALID_INPUT",
      "Unsupported account kind.",
      400,
    );
    const result = await this.mutate<UsageAccount>(
      c,
      "account:" + i.sourceOwner,
      i.requestId,
      i,
      async () => {
        const id = randomUUID(),
          now = await this.now(c);
        await c.query("INSERT INTO bz_usage_accounts VALUES(?,?,?,?,?,?,?)", [
          id,
          i.kind,
          i.label,
          "active",
          1,
          now,
          now,
        ]);
        await c.query("INSERT INTO bz_usage_members VALUES(?,?,?,?,?,?)", [
          id,
          i.userId,
          "active",
          1,
          now,
          now,
        ]);
        return {
          id,
          kind: i.kind,
          label: i.label,
          state: "active",
          revision: 1,
          createdAt: now,
          updatedAt: now,
        };
      },
      true,
    );
    // An exact creation retry keeps its original identity, even after deletion.
    // It may not return a stale active receipt or create a replacement account.
    const saved = (await rows(c, `SELECT state FROM bz_usage_accounts WHERE id=?${i.kind === 'organization' ? ' FOR SHARE' : ''}`, [result.id]))[0];
    usageAssert(saved && saved.state !== 'deleted', 'USAGE_RESOURCE_DELETED', '原账户已删除，不能通过重试创建替代账户。');
    usageAssert(saved.state !== "archived", "USAGE_ACCOUNT_SUSPENDED", "原账户已移除，请由管理员恢复，不能创建替代账户。", 403);
    return result;
  }
  async createAccount(i: CreateUsageAccountInput): Promise<UsageAccount> {
    return this.withTransaction((c) => this.createAccountInTransaction(c, i));
  }
  async getAccount(id: string, includeArchived = false): Promise<UsageAccount | null> {
    const r = (
      await rows(this.pool(), `SELECT * FROM bz_usage_accounts WHERE id=? AND state<>'deleted'${includeArchived ? "" : " AND state<>'archived'"}`, [
        id,
      ])
    )[0];
    return r ? account(r) : null;
  }
  async listAccounts(
    i: { userId?: string; limit?: number; before?: string; archived?: boolean } = {},
  ): Promise<{ items: UsageAccount[]; nextCursor: string | null }> {
    const limit = Math.min(100, Math.max(1, i.limit ?? 30));
    const r = await rows(
      this.pool(),
      `SELECT a.* FROM bz_usage_accounts a ${i.userId ? "JOIN bz_usage_members m ON m.account_id=a.id AND m.user_id=? AND m.state='active'" : ""} WHERE ${i.archived && !i.userId ? "a.state='archived'" : "a.state NOT IN ('deleted','archived')"} AND a.id<? ORDER BY a.id DESC LIMIT ?`,
      [...(i.userId ? [i.userId] : []), i.before ?? "~", limit + 1],
    );
    return {
      items: r.slice(0, limit).map(account),
      nextCursor: r.length > limit ? r[limit - 1]!.id : null,
    };
  }
  async setMembership(i: {
    requestId: string;
    accountId: string;
    userId: string;
    state: "active" | "revoked";
    expectedRevision: number;
    actor: string;
  }): Promise<{ revision: number }> {
    return this.withTransaction(async (c) => {
      await this.lockAccount(c, i.accountId);
      return this.mutate(
        c,
        "membership:" + i.accountId,
        i.requestId,
        i,
        async () => {
          usageAssert(
            ["active", "revoked"].includes(i.state),
            "USAGE_INVALID_INPUT",
            "Invalid membership state.",
            400,
          );
          const m = (
            await rows(
              c,
              "SELECT * FROM bz_usage_members WHERE account_id=? AND user_id=? FOR UPDATE",
              [i.accountId, key(i.userId)],
            )
          )[0];
          usageAssert(
            Number(m?.revision ?? 0) === i.expectedRevision,
            "USAGE_REVISION_CONFLICT",
            "Membership revision changed.",
          );
          const rev = i.expectedRevision + 1,
            n = await this.now(c);
          await c.query(
            "INSERT INTO bz_usage_members VALUES(?,?,?,?,?,?) ON DUPLICATE KEY UPDATE state=VALUES(state),revision=VALUES(revision),updated_at=VALUES(updated_at)",
            [i.accountId, i.userId, i.state, rev, n, n],
          );
          return { revision: rev };
        },
      );
    });
  }
  async setAccountState(i: {
    requestId: string;
    accountId: string;
    expectedRevision: number;
    state: "active" | "suspended";
    actor: string;
  }): Promise<UsageAccount> {
    return this.withTransaction(async (c) => {
      const a = await this.lockAccount(c, i.accountId);
      return this.mutate(
        c,
        "account-state:" + i.accountId,
        i.requestId,
        i,
        async () => {
          usageAssert(
            a.revision === i.expectedRevision,
            "USAGE_REVISION_CONFLICT",
            "Account revision changed.",
          );
          usageAssert(
            ["active", "suspended"].includes(i.state),
            "USAGE_INVALID_INPUT",
            "Invalid account state.",
            400,
          );
          const now = await this.now(c);
          await c.query(
            "UPDATE bz_usage_accounts SET state=?,revision=revision+1,updated_at=? WHERE id=?",
            [i.state, now, i.accountId],
          );
          return {
            ...a,
            state: i.state,
            revision: a.revision + 1,
            updatedAt: now,
          };
        },
      );
    });
  }
  async getService(id: string): Promise<UsageService | null> {
    const r = (
      await rows(this.pool(), "SELECT * FROM bz_usage_services WHERE id=? AND state<>'deleted'", [
        id,
      ])
    )[0];
    return r ? service(r) : null;
  }
  async listServices(): Promise<UsageService[]> {
    return (
      await rows(this.pool(), "SELECT * FROM bz_usage_services WHERE state<>'deleted' ORDER BY id")
    ).map(service);
  }
  /** Bounded operator-only metadata; never returns request bodies or credentials. */
  async serviceReferences(id: string) {
    key(id);
    return this.withTransaction(async c => {
      const current = (await rows(c, 'SELECT id,label,revision,state FROM bz_usage_services WHERE id=? FOR SHARE', [id]))[0];
      usageAssert(current && current.state !== 'deleted', 'USAGE_SERVICE_NOT_FOUND', '模型服务不存在或已删除。', 404);
      const sources = serviceReferenceSources(id);
      const counts = async (source: { from: string; where: string; params: unknown[] }) =>
        Number((await rows(c, `SELECT COUNT(*) AS total FROM ${source.from} WHERE ${source.where}`, source.params))[0]!.total);
      // All ordinary reads share the same transaction snapshot, including totals.
      const planTotal = await counts(sources.plans), accountTotal = await counts(sources.accounts), requestTotal = await counts(sources.requests);
      const plans = await rows(c, `SELECT p.id,p.label FROM ${sources.plans.from} WHERE ${sources.plans.where} ORDER BY p.id LIMIT 20`, sources.plans.params);
      const accounts = await rows(c, `SELECT h.account_id,g.id AS grant_id,g.label AS grant_label,g.state AS grant_state,g.source_owner,p.config_json,g.revision,a.label,a.kind,a.state FROM ${sources.accounts.from} LEFT JOIN bz_usage_accounts a ON a.id=h.account_id WHERE ${sources.accounts.where} ORDER BY h.account_id LIMIT 20`, sources.accounts.params);
      const requests = await rows(c, `SELECT r.account_id,a.label AS account_label,r.operation_id,r.state,r.result_state FROM ${sources.requests.from} LEFT JOIN bz_usage_accounts a ON a.id=r.account_id WHERE ${sources.requests.where} ORDER BY r.created_at,r.id LIMIT 20`, sources.requests.params);
      return {
        service: { id: current.id as string, label: current.label as string, revision: Number(current.revision) },
        deletable: true,
        plans: { total: planTotal, truncated: planTotal > plans.length, items: plans.map(p => ({ id: p.id as string, label: p.label as string })) },
        accounts: { total: accountTotal, truncated: accountTotal > accounts.length, items: accounts.map(a => ({
          id: a.account_id as string, label: String(a.label ?? a.account_id), kind: String(a.kind ?? 'unknown'), state: String(a.state ?? 'unknown'),
          grantId: a.grant_id as string, grantLabel: a.grant_label as string, grantState: a.grant_state as string,
          sourceOwner: a.source_owner as string, serviceIds: json<{ serviceIds: string[] }>(a.config_json).serviceIds, revision: Number(a.revision),
        })) },
        requests: { total: requestTotal, truncated: requestTotal > requests.length, items: requests.map(r => ({
          accountId: r.account_id as string, accountLabel: String(r.account_label ?? r.account_id), operationId: r.operation_id as string,
          state: r.state as string, resultState: r.result_state as string,
        })) },
      };
    });
  }
  /** Remove a selectable service while retaining its identity and original request evidence. */
  async deleteService(i: {
    id: string; expectedRevision: number; requestId: string; actor: string;
  }): Promise<{ id: string; deleted: true; revision: number; deletedAt: number; deletedBy: string; affected_plan_count: number; affected_account_count: number; affected_request_count: number }> {
    key(i.id); key(i.requestId); key(i.actor); integer(i.expectedRevision, 'expected_revision', 1);
    return this.withTransaction(c => this.mutate(c, `service-delete:${i.id}`, i.requestId, i, async () => {
      const current = (await rows(c, 'SELECT * FROM bz_usage_services WHERE id=? FOR UPDATE', [i.id]))[0];
      usageAssert(current && current.state !== 'deleted', 'USAGE_SERVICE_NOT_FOUND', '模型服务不存在或已删除。', 404);
      usageAssert(Number(current.revision) === i.expectedRevision, 'USAGE_REVISION_CONFLICT', '模型服务已变化，请刷新后再删除。');
      const now = await this.now(c);
      // The service lock serializes model admission and plan writers. Lock every
      // affected plan before removing this identity; no grant or request snapshot
      // is rewritten, so previously dispatched work retains its original evidence.
      const affectedPlans = await rows(c, "SELECT id,config_json FROM bz_usage_billing_plans WHERE state<>'deleted' AND JSON_CONTAINS(config_json,JSON_QUOTE(?),'$.serviceIds') ORDER BY id FOR UPDATE", [i.id]);
      const accountIds = affectedPlans.length ? await rows(c,
        'SELECT h.account_id FROM bz_usage_billing_heads h JOIN bz_usage_billing_grants g ON g.id=h.grant_id WHERE g.plan_id IN (?) FOR SHARE',
        [affectedPlans.map(p => p.id)]) : [];
      const requestCount = Number((await rows(c, 'SELECT COUNT(*) AS total FROM bz_usage_billing_requests WHERE service_id=?', [i.id]))[0]!.total);
      for (const p of affectedPlans) {
        const config = json<{ serviceIds: string[] }>(p.config_json);
        await c.query('UPDATE bz_usage_billing_plans SET config_json=?,revision=revision+1,updated_at=? WHERE id=?',
          [JSON.stringify({ ...config, serviceIds: config.serviceIds.filter(id => id !== i.id),  }), now, p.id]);
      }
      const revision = i.expectedRevision + 1;
      // Keep this primary key permanently reserved: an old credential or request
      // must never become bound to a different model created with the same ID.
      await c.query("UPDATE bz_usage_services SET state='deleted',revision=? WHERE id=?", [revision, i.id]);
      return { id: i.id, deleted: true as const, revision, deletedAt: now, deletedBy: i.actor,
        affected_plan_count: affectedPlans.length, affected_account_count: accountIds.length, affected_request_count: requestCount };
    }, true));
  }
  async putService(i: {
    id: string;
    label: string;
    expectedRevision: number;
    state?: "active" | "suspended";
    config: UsageServiceConfig;
  }): Promise<UsageService> {
    key(i.id);
    key(i.label);
    assertKnownFields(
      i.config,
      [
        "credential",
        "model",
        "providerScope",
        "maxInputBytes",
        "maxOutputTokens",
        "timeoutMs",
        "contextWindowTokens",
        "inputModalities",
        "purpose",
        "tool",
        "pricing",
      ],
      "service config",
    );
    validateModelToolConfig(i.config);
    if (i.config.pricing !== undefined) validatePricingBinding(i.config.pricing);
    if (i.config.pricing) usageAssert(i.config.pricing.kind === (i.config.purpose === "tool" ? "image" : "chat"), "USAGE_INVALID_INPUT", "参考价格类型与服务用途不一致。", 400);
    if (i.config.contextWindowTokens !== undefined)
      integer(i.config.contextWindowTokens, "contextWindowTokens", 1, 10000000);
    if (i.config.inputModalities !== undefined)
      usageAssert(Array.isArray(i.config.inputModalities) && i.config.inputModalities.includes('text')
        && i.config.inputModalities.every(value => ['text', 'image'].includes(value))
        && new Set(i.config.inputModalities).size === i.config.inputModalities.length,
      'USAGE_INVALID_INPUT', 'Model modalities must include text with optional image.', 400);
    integer(i.expectedRevision, "expectedRevision");
    usageAssert(
      i.state === undefined || ["active", "suspended"].includes(i.state),
      "USAGE_INVALID_INPUT",
      "Invalid service state.",
      400,
    );
    key(i.config.credential);
    key(i.config.model);
    key(i.config.providerScope);
    integer(i.config.maxInputBytes, "maxInputBytes", 1, 16 * 1024 * 1024);
    integer(i.config.maxOutputTokens, "maxOutputTokens", 1, 131072);
    integer(i.config.timeoutMs, "timeoutMs", 1000, 600000);
    return this.withTransaction(async (c) => {
      const r = (
        await rows(c, "SELECT * FROM bz_usage_services WHERE id=? FOR UPDATE", [
          i.id,
        ])
      )[0];
      usageAssert(r?.state !== 'deleted', 'USAGE_SERVICE_DELETED', '该模型服务标识已删除，新增服务请使用新的标识。');
      usageAssert(
        Number(r?.revision ?? 0) === i.expectedRevision,
        "USAGE_REVISION_CONFLICT",
        "Service revision changed.",
      );
      const out: UsageService = {
        id: i.id,
        label: i.label,
        state: i.state ?? "active",
        revision: i.expectedRevision + 1,
        config: i.config,
      };
      await c.query(
        "INSERT INTO bz_usage_services VALUES(?,?,?,?,?) ON DUPLICATE KEY UPDATE label=VALUES(label),state=VALUES(state),revision=VALUES(revision),config_json=VALUES(config_json)",
        [
          out.id,
          out.label,
          out.state,
          out.revision,
          JSON.stringify(out.config),
        ],
      );
      return out;
    });
  }
}
