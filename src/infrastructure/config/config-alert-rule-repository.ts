import { dt, rowAlertRule } from '../../core/config/config-codec';
import type { AlertRule } from '../../core/contracts/types';

export class AlertRuleRepository {
  constructor(private readonly poolOf: () => any) {}

  private get pool(): any { return this.poolOf(); }

  async list(): Promise<AlertRule[]> {
    const [rows] = await this.pool.query('SELECT * FROM bz_alert_rules ORDER BY event_prefix, id');
    return (rows as any[]).map(rowAlertRule);
  }

  /** 命中某告警 key 的启用规则：event_prefix 是 key 的前缀（''=全部）。规则数极少，取启用规则后 JS 前缀匹配。 */
  async matching(key: string): Promise<AlertRule[]> {
    const [rows] = await this.pool.query('SELECT * FROM bz_alert_rules WHERE enabled=1');
    return (rows as any[]).map(rowAlertRule).filter((r) => key.startsWith(r.event_prefix));
  }

  async upsert(r: Omit<AlertRule, 'id'> & { id?: number }): Promise<void> {
    const recipients = JSON.stringify(Array.isArray(r.recipients) ? r.recipients : []);
    if (r.id) {
      await this.pool.query(
        'UPDATE bz_alert_rules SET event_prefix=?,channel=?,recipients=?,cooldown_min=?,enabled=?,description=?,updated_at=? WHERE id=?',
        [r.event_prefix ?? '', r.channel, recipients, r.cooldown_min ?? 60, r.enabled ? 1 : 0, r.description ?? null, dt(), r.id],
      );
    } else {
      await this.pool.query(
        'INSERT INTO bz_alert_rules (event_prefix,channel,recipients,cooldown_min,enabled,description,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)',
        [r.event_prefix ?? '', r.channel, recipients, r.cooldown_min ?? 60, r.enabled ? 1 : 0, r.description ?? null, dt(), dt()],
      );
    }
  }

  async delete(id: number): Promise<void> {
    await this.pool.query('DELETE FROM bz_alert_rules WHERE id=?', [id]);
  }
}
