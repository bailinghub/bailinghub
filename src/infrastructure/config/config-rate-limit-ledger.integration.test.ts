import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import mysql from 'mysql2/promise';
import { RateLimitLedger } from './config-rate-limit-ledger';
import { ToolProviderRepository } from './config-tool-provider-repository';
import { migrateBailingHubCoreSchema } from '../schema/core-schema-migrator';
import type { MysqlConfig } from '../../core/config/config';

test('isolated MySQL: migration, persisted policies, 120/hour and concurrent all-gate admission', { skip: !process.env.BAILING_RATE_TEST_MYSQL_PORT }, async () => {
  const port = Number(process.env.BAILING_RATE_TEST_MYSQL_PORT);
  const database = `rate_test_${randomBytes(8).toString('hex')}`;
  const admin = await mysql.createConnection({ host: '127.0.0.1', port, user: 'root' });
  await admin.query(`CREATE DATABASE ${database}`);
  const config = { host: '127.0.0.1', port, user: 'root', password: '', database, timezone: 'Z', connectionLimit: 8 };
  const pool = mysql.createPool({ ...config, connectionLimit: 8 });
  try {
    const migration = await migrateBailingHubCoreSchema({ mysql: config as MysqlConfig, logger: { log() {}, warn() {} } });
    assert.ok(migration.appliedFiles.includes('061_tool_rate_limit_policies.sql'));
    assert.equal((await migrateBailingHubCoreSchema({ mysql: config as MysqlConfig, logger: { log() {}, warn() {} } })).appliedFiles.length, 0);
    const repository = new ToolProviderRepository(() => pool);
    await repository.upsert({ name: 'store', base_url: 'https://business.invalid', spec_source: 'inline', secret: 'synthetic', log_payload: false,
      timeout_ms: 10000, rate_limit_per_min: 0, auto_refresh_min: 0, enabled: true,
      tool_rate_limits: { default: { mode: 'disabled' }, overrides: { images_update: { mode: 'custom', count: 1000, window: '1h' } } } });
    const saved = (await repository.get('store'))!;
    await repository.upsert({ ...saved, description: 'refreshed metadata' });
    assert.deepEqual((await repository.get('store'))!.tool_rate_limits, saved.tool_rate_limits);
    const ledger = new RateLimitLedger(() => pool);
    const tool = { bucket: 'tool:store:images_update', limit: 120, windowSec: 3600 };
    for (let i = 0; i < 120; i++) assert.equal((await ledger.consumeAll([tool])).limited, false);
    assert.equal((await ledger.consumeAll([tool])).limited, true);
    await pool.query('UPDATE bz_rate_limits SET created_at=DATE_SUB(UTC_TIMESTAMP(), INTERVAL 61 SECOND)');
    assert.equal((await ledger.consumeAll([tool])).limited, true);
    await pool.query('UPDATE bz_rate_limits SET created_at=DATE_SUB(UTC_TIMESTAMP(), INTERVAL 3601 SECOND)');
    assert.equal((await ledger.consumeAll([tool])).limited, false);
    await ledger.clear(tool.bucket);
    const provider = { bucket: 'provider:store', limit: 3, windowSec: 60 };
    const gates = [{ ...tool, limit: 20 }, provider];
    const results = await Promise.all(Array.from({ length: 12 }, () => ledger.consumeAll(gates)));
    assert.equal(results.filter((r) => !r.limited).length, 3);
    assert.equal(await ledger.count(tool.bucket, 3600), 3);
    assert.equal(await ledger.count(provider.bucket, 60), 3);
    // Saturated tool cannot consume the provider gate; a third tool still has the full provider quota.
    await ledger.clear(provider.bucket);
    assert.equal((await ledger.consumeAll([{ ...tool, limit: 3 }, provider])).limited, true);
    assert.equal(await ledger.count(provider.bucket, 60), 0);
  } finally {
    await pool.end();
    await admin.query(`DROP DATABASE ${database}`);
    await admin.end();
  }
});
