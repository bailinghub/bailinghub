import { dt, rowRoute } from '../../core/config/config-codec';
import type { Route } from '../../core/contracts/types';

export class RouteRepository {
  constructor(private readonly poolOf: () => any) {}

  private get pool(): any { return this.poolOf(); }

  async list(): Promise<Route[]> {
    const [rows] = await this.pool.query('SELECT * FROM bz_routes ORDER BY route_key');
    return (rows as any[]).map(rowRoute);
  }

  async get(key: string): Promise<Route | null> {
    const [rows] = await this.pool.query('SELECT * FROM bz_routes WHERE route_key=? LIMIT 1', [key]);
    return rows[0] ? rowRoute(rows[0]) : null;
  }

  async upsert(r: Route): Promise<void> {
    await this.pool.query(
      'INSERT INTO bz_routes (route_key,name,enabled,target,target_config,project,profile,permission,session_policy,session_fixed_id,session_key_field,default_callback_url,delivery,knowledge,retry,tools,audience,memory,budget,description,created_at,updated_at) ' +
        'VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ' +
        'ON DUPLICATE KEY UPDATE name=VALUES(name),enabled=VALUES(enabled),target=VALUES(target),target_config=VALUES(target_config),project=VALUES(project),profile=VALUES(profile),permission=VALUES(permission),session_policy=VALUES(session_policy),session_fixed_id=VALUES(session_fixed_id),session_key_field=VALUES(session_key_field),default_callback_url=VALUES(default_callback_url),delivery=VALUES(delivery),knowledge=VALUES(knowledge),retry=VALUES(retry),tools=VALUES(tools),audience=VALUES(audience),memory=VALUES(memory),budget=VALUES(budget),description=VALUES(description),updated_at=VALUES(updated_at)',
      [r.route_key, r.name, r.enabled ? 1 : 0, r.target, r.target_config ? JSON.stringify(r.target_config) : null,
       r.project ?? null, r.profile, r.permission ?? null, r.session_policy,
       r.session_fixed_id ?? null, r.session_key_field ?? null, r.default_callback_url ?? null,
       r.delivery && Object.keys(r.delivery).length ? JSON.stringify(r.delivery) : null,
       r.knowledge && Object.keys(r.knowledge).length ? JSON.stringify(r.knowledge) : null,
       r.retry && Object.keys(r.retry).length ? JSON.stringify(r.retry) : null,
       r.tools && Object.keys(r.tools).length ? JSON.stringify(r.tools) : null,
       r.audience && Object.keys(r.audience).length ? JSON.stringify(r.audience) : null,
       r.memory && Object.keys(r.memory).length ? JSON.stringify(r.memory) : null,
       r.budget && Object.keys(r.budget).length ? JSON.stringify(r.budget) : null,
       r.description ?? null, dt(), dt()],
    );
  }

  async delete(key: string): Promise<void> {
    await this.pool.query('DELETE FROM bz_routes WHERE route_key=?', [key]);
  }
}
