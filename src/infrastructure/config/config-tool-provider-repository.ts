import { dt, rowToolProvider } from '../../core/config/config-codec';
import type { ToolProvider } from '../../core/contracts/types';

export class ToolProviderRepository {
  constructor(private readonly poolOf: () => any) {}

  private get pool(): any { return this.poolOf(); }

  async list(): Promise<ToolProvider[]> {
    const [rows] = await this.pool.query('SELECT * FROM bz_tool_providers ORDER BY name');
    return (rows as any[]).map(rowToolProvider);
  }

  async get(name: string): Promise<ToolProvider | null> {
    const [rows] = await this.pool.query('SELECT * FROM bz_tool_providers WHERE name=? LIMIT 1', [name]);
    return rows[0] ? rowToolProvider(rows[0]) : null;
  }

  async upsert(p: ToolProvider): Promise<void> {
    await this.pool.query(
      'INSERT INTO bz_tool_providers (name,base_url,spec_source,spec_url,spec_json,spec_refreshed_at,authz_probe_json,secret,log_payload,timeout_ms,rate_limit_per_min,auto_refresh_min,enabled,description,embed_credential,embed_model,embed_dim,created_at,updated_at) ' +
        'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ' +
        'ON DUPLICATE KEY UPDATE base_url=VALUES(base_url),spec_source=VALUES(spec_source),spec_url=VALUES(spec_url),spec_json=VALUES(spec_json),spec_refreshed_at=VALUES(spec_refreshed_at),authz_probe_json=VALUES(authz_probe_json),secret=VALUES(secret),log_payload=VALUES(log_payload),timeout_ms=VALUES(timeout_ms),rate_limit_per_min=VALUES(rate_limit_per_min),auto_refresh_min=VALUES(auto_refresh_min),enabled=VALUES(enabled),description=VALUES(description),embed_credential=VALUES(embed_credential),embed_model=VALUES(embed_model),embed_dim=VALUES(embed_dim),updated_at=VALUES(updated_at)',
      [p.name, p.base_url, p.spec_source, p.spec_url ?? null, p.spec_json ?? null,
       p.spec_refreshed_at ? p.spec_refreshed_at.slice(0, 19).replace('T', ' ') : null,
       p.authz_probe ? JSON.stringify(p.authz_probe) : null,
       p.secret, p.log_payload ? 1 : 0, p.timeout_ms, p.rate_limit_per_min, p.auto_refresh_min,
       p.enabled ? 1 : 0, p.description ?? null,
       p.embed_credential ?? null, p.embed_model ?? null, p.embed_dim ?? null, dt(), dt()],
    );
  }

  async updateAuthzProbe(name: string, probe: NonNullable<ToolProvider['authz_probe']>): Promise<void> {
    await this.pool.query('UPDATE bz_tool_providers SET authz_probe_json=?, updated_at=? WHERE name=?', [JSON.stringify(probe), dt(), name]);
  }

  async delete(name: string): Promise<void> {
    await this.pool.query('DELETE FROM bz_tool_providers WHERE name=?', [name]);
  }
}
