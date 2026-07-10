// 知识库数据源连接器（拉取式入库）：后台配「连接 + 取数 SQL + 字段映射」，中枢定时拉业务库渲染成文档。
// 角色宪法：连接器只是入库管道的另一个进料口——渲染完一律走 KbService.upsertDocByKey（与控制台手工/API 推送同道），
// 文档 source_key = ds{ds_id}:{主键}，对账删除只动本前缀，三种来源井水不犯河水。
// 安全边界：只读硬校验（仅单条 SELECT + 会话级 read only）；建议业务给只读账号；密码入库不回显。
import type { KbService } from './kb';
import type { KbDatasource } from '../core/contracts/types';
import { dt } from '../core/config/config-codec';
import type { KbDatasourceDraft, KbDatasourceRepository } from './kb-repository';

const ROW_CAP = 5000;          // 单次同步行数上限：超限报错而非静默截断（截断 = 部分文档悄悄消失在对账里）
const CONNECT_TIMEOUT = 8000;
const QUERY_TIMEOUT = 30_000;

export interface DsSyncStats { rows: number; upserted: number; skipped: number; deleted: number; errors: number; ms: number }

/** 只读硬校验：单条 SELECT，拒绝写操作与文件导出。mysql2 默认 multipleStatements=false 是第二道闸。 */
export function assertReadonlySql(sql: string): string {
  const cleaned = sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '').trim().replace(/;+\s*$/, '');
  if (!cleaned) throw new Error('取数 SQL 不能为空');
  if (cleaned.includes(';')) throw new Error('只允许单条语句（不得包含分号）');
  if (!/^select\s/i.test(cleaned)) throw new Error('只允许 SELECT 语句');
  if (/\binto\s+(outfile|dumpfile)\b/i.test(cleaned)) throw new Error('不允许 INTO OUTFILE/DUMPFILE');
  return cleaned;
}

/** 内容模板渲染：${字段} 占位，缺字段补空串。 */
export function renderTemplate(tpl: string, row: Record<string, unknown>): string {
  return tpl.replace(/\$\{([A-Za-z0-9_]+)\}/g, (_m, f: string) => (row[f] === null || row[f] === undefined ? '' : String(row[f])));
}

/** source_key 片段净化：落在入库插座的合法字符集内。 */
function safeKeyPart(v: unknown): string {
  return String(v ?? '').replace(/[^A-Za-z0-9_.:-]/g, '-').slice(0, 100);
}

type DsConn = Pick<KbDatasource, 'db_host' | 'db_port' | 'db_user' | 'db_password' | 'db_database'>;

export class KbSyncService {
  private running = new Set<number>(); // 进程内并发护栏；跨重启的滞留 running 态靠 last_sync_at+interval 自愈

  constructor(private readonly repository: KbDatasourceRepository, private readonly kb: KbService) {}

  // ---- 连接（每次同步独立短连接，用完即断；不向业务库常驻连接池）----
  private async connect(c: DsConn): Promise<any> {
    const mysql = await import('mysql2/promise');
    const conn = await mysql.createConnection({
      host: c.db_host, port: c.db_port || 3306, user: c.db_user, password: c.db_password,
      database: c.db_database, connectTimeout: CONNECT_TIMEOUT,
    });
    await conn.query('SET SESSION TRANSACTION READ ONLY').catch(() => { /* 目标数据库不支持只读事务时仍保留语句级只读校验 */ });
    return conn;
  }

  // ---- CRUD ----
  async list(kbId: string): Promise<Array<Omit<KbDatasource, 'db_password'> & { doc_count: number }>> {
    return this.repository.list(kbId);
  }

  async get(dsId: number): Promise<KbDatasource | null> {
    return this.repository.get(dsId);
  }

  /** 新建/更新。编辑时密码传空 = 保留原密码（列表不回显，没法回填——同模型凭证约定）。 */
  async upsert(d: KbDatasourceDraft): Promise<number> {
    assertReadonlySql(d.query_sql);
    let password = d.db_password;
    if (d.ds_id) {
      const ex = await this.get(d.ds_id);
      if (!ex) throw new Error(`数据源不存在: ${d.ds_id}`);
      if (!password) password = ex.db_password;
    } else if (!password) {
      throw new Error('新建数据源必须填数据库密码');
    }
    if (d.ds_id) {
      await this.repository.update(d.ds_id, { ...d, db_password: password }, dt());
      return d.ds_id;
    }
    return this.repository.create({ ...d, db_password: password }, dt());
  }

  /** 删数据源 = 它同步进来的文档与向量一并退场（前缀隔离保证不伤别的来源）。返回清掉的文档数。 */
  async remove(dsId: number): Promise<number> {
    const ds = await this.get(dsId);
    if (!ds) return 0;
    const n = await this.kb.deleteDocsByPrefix(ds.kb_id, `ds${dsId}:`);
    await this.repository.delete(dsId);
    return n;
  }

  // ---- 测试连接 + 预览（保存前看渲染长相，免得同步完才发现模板配错）----
  async preview(c: DsConn & { query_sql: string; key_field: string; title_field: string; content_template: string }): Promise<Array<{ source_key: string; title: string; content: string }>> {
    const sql = assertReadonlySql(c.query_sql);
    const conn = await this.connect(c);
    try {
      const [rows] = await conn.query({ sql: `SELECT * FROM (${sql}) bz_ds_preview LIMIT 3`, timeout: QUERY_TIMEOUT });
      return (rows as any[]).map((row) => ({
        source_key: `ds?:${safeKeyPart(row[c.key_field])}`,
        title: String(row[c.title_field] ?? '').slice(0, 191) || '（标题字段为空）',
        content: renderTemplate(c.content_template, row).slice(0, 2000),
      }));
    } finally { await conn.end().catch(() => undefined); }
  }

  // ---- 同步 ----
  async sync(dsId: number, trigger: 'manual' | 'schedule'): Promise<DsSyncStats> {
    const ds = await this.get(dsId);
    if (!ds) throw new Error(`数据源不存在: ${dsId}`);
    if (this.running.has(dsId)) throw new Error('该数据源正在同步中');
    this.running.add(dsId);
    const t0 = Date.now();
    await this.repository.markRunning(dsId, dt());
    const stats: DsSyncStats = { rows: 0, upserted: 0, skipped: 0, deleted: 0, errors: 0, ms: 0 };
    try {
      const sql = assertReadonlySql(ds.query_sql);
      const conn = await this.connect(ds);
      let rows: any[];
      try {
        [rows] = await conn.query({ sql: `SELECT * FROM (${sql}) bz_ds LIMIT ${ROW_CAP + 1}`, timeout: QUERY_TIMEOUT }) as [any[], unknown];
      } finally { await conn.end().catch(() => undefined); }
      if (rows.length > ROW_CAP) throw new Error(`取数超过 ${ROW_CAP} 行上限——请在 SQL 加条件收窄（宁可拆多个数据源，不做静默截断）`);
      stats.rows = rows.length;

      const prefix = `ds${dsId}:`;
      const seen = new Set<string>();
      for (const row of rows) {
        const keyPart = safeKeyPart(row[ds.key_field]);
        if (!keyPart) { stats.errors++; continue; } // 幂等键空值行：跳过并计错（别让空 key 互相覆盖）
        const sourceKey = prefix + keyPart;
        if (seen.has(sourceKey)) { stats.errors++; continue; } // 重复键同理
        seen.add(sourceKey);
        const title = String(row[ds.title_field] ?? '').slice(0, 191) || keyPart;
        const content = renderTemplate(ds.content_template, row).trim();
        if (!content) { stats.errors++; continue; }
        // 串行 awaitEmbed：天然限住对 embedding API 的并发；未变更行在 upsert 内被指纹短路
        const r = await this.kb.upsertDocByKey(ds.kb_id, sourceKey, title, content.slice(0, 300_000), { awaitEmbed: true });
        if (r.skipped) stats.skipped++; else stats.upserted++;
      }
      // 对账删除：行从查询结果消失 = 文档下架（只动本前缀）
      const existing = await this.kb.listSourceKeysByPrefix(ds.kb_id, prefix);
      for (const [key, docId] of existing) {
        if (!seen.has(key)) { await this.kb.deleteDoc(ds.kb_id, docId); stats.deleted++; }
      }
      stats.ms = Date.now() - t0;
      await this.repository.markOk(dsId, stats);
      return stats;
    } catch (e) {
      stats.ms = Date.now() - t0;
      const msg = (e instanceof Error ? e.message : String(e)).slice(0, 480);
      await this.repository.markError(dsId, msg, stats)
        .catch(() => undefined);
      throw new Error(`同步失败（${trigger}）：${msg}`);
    } finally {
      this.running.delete(dsId);
    }
  }

  /** 调度心跳：每分钟扫一遍，到点的拉起（错峰靠各自 interval；单数据源并发由 running 集合挡）。 */
  async tick(onDone: (ds: KbDatasource, stats: DsSyncStats | null, err?: string) => void): Promise<void> {
    const rows = await this.repository.listDue(dt());
    for (const ds of rows) {
      if (this.running.has(ds.ds_id)) continue;
      try { onDone(ds, await this.sync(ds.ds_id, 'schedule')); }
      catch (e) { onDone(ds, null, e instanceof Error ? e.message : String(e)); }
    }
  }
}
