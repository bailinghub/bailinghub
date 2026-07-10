import { dt, rowStorageBucket } from '../../core/config/config-codec';
import type { StorageBucket } from '../../core/contracts/types';

export class StorageBucketRepository {
  constructor(private readonly poolOf: () => any) {}

  private get pool(): any { return this.poolOf(); }

  async list(): Promise<StorageBucket[]> {
    const [rows] = await this.pool.query('SELECT * FROM bz_storage_buckets ORDER BY name');
    return (rows as any[]).map(rowStorageBucket);
  }

  async get(name: string): Promise<StorageBucket | null> {
    const [rows] = await this.pool.query('SELECT * FROM bz_storage_buckets WHERE name=? LIMIT 1', [name]);
    return rows[0] ? rowStorageBucket(rows[0]) : null;
  }

  /** 新建/更新。编辑时 access_key / secret_key 传空 = 保留原值（列表不回显完整凭证，没法回填）。 */
  async upsert(b: StorageBucket): Promise<void> {
    const existing = (!b.secret_key || !b.access_key) ? await this.get(b.name) : null;
    let sk = b.secret_key;
    if (!sk) {
      if (!existing) throw new Error('新建存储桶必须填 SecretKey');
      sk = existing.secret_key;
    }
    let ak = b.access_key;
    if (!ak) {
      if (!existing) throw new Error('新建存储桶必须填 SecretId / AccessKeyId');
      ak = existing.access_key;
    }
    await this.pool.query(
      'INSERT INTO bz_storage_buckets (name,kind,region,bucket,endpoint,access_key,secret_key,public_base_url,path_prefix,enabled,description,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?) ' +
        'ON DUPLICATE KEY UPDATE kind=VALUES(kind),region=VALUES(region),bucket=VALUES(bucket),endpoint=VALUES(endpoint),access_key=VALUES(access_key),secret_key=VALUES(secret_key),public_base_url=VALUES(public_base_url),path_prefix=VALUES(path_prefix),enabled=VALUES(enabled),description=VALUES(description),updated_at=VALUES(updated_at)',
      [b.name, b.kind, b.region, b.bucket, b.endpoint ?? null, ak, sk,
       b.public_base_url, b.path_prefix || 'bailing/chat', b.enabled ? 1 : 0, b.description ?? null, dt(), dt()],
    );
  }

  async delete(name: string): Promise<void> {
    await this.pool.query('DELETE FROM bz_storage_buckets WHERE name=?', [name]);
  }
}
