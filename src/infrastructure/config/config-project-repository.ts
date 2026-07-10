import { dt, rowProject } from '../../core/config/config-codec';
import type { ProjectReg } from '../../core/contracts/types';

export class ProjectRepository {
  constructor(private readonly poolOf: () => any) {}

  private get pool(): any { return this.poolOf(); }

  async list(): Promise<ProjectReg[]> {
    const [rows] = await this.pool.query('SELECT * FROM bz_projects ORDER BY name');
    return (rows as any[]).map(rowProject);
  }

  async get(name: string): Promise<ProjectReg | null> {
    const [rows] = await this.pool.query('SELECT * FROM bz_projects WHERE name=? LIMIT 1', [name]);
    return rows[0] ? rowProject(rows[0]) : null;
  }

  async upsert(p: ProjectReg): Promise<void> {
    await this.pool.query(
      'INSERT INTO bz_projects (name,path,enabled,description,created_at,updated_at) VALUES (?,?,?,?,?,?) ' +
        'ON DUPLICATE KEY UPDATE path=VALUES(path),enabled=VALUES(enabled),description=VALUES(description),updated_at=VALUES(updated_at)',
      [p.name, p.path, p.enabled ? 1 : 0, p.description ?? null, dt(), dt()],
    );
  }

  async delete(name: string): Promise<void> {
    await this.pool.query('DELETE FROM bz_projects WHERE name=?', [name]);
  }
}
