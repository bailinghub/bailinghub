import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEMO_CHAT_ENTRY,
  DemoDatasetConflictError,
  DemoDatasetService,
  demoToolSpec,
  parseDemoDatasetManifest,
} from './demo-dataset';

const hash = 'a'.repeat(64);

class FakeDemoDatabase {
  readonly events: string[] = [];
  readonly targets = new Map<string, Record<string, unknown>>([
    ['llm', { name: 'llm', kind: 'inhub', stateless: 1, needs_project: 0, timeout_ms: 120000, enabled: 1, description: 'built-in' }],
  ]);
  readonly providers = new Map<string, Record<string, unknown>>();
  readonly routes = new Map<string, Record<string, unknown>>();
  readonly clients = new Map<string, Record<string, unknown>>();
  readonly chatEntries = new Map<string, Record<string, unknown>>();
  readonly sessions: Array<Record<string, unknown>> = [];
  readonly threads: Array<Record<string, unknown>> = [];
  readonly jobs: Array<Record<string, unknown>> = [];
  readonly toolApprovals: Array<Record<string, unknown>> = [];
  readonly jobRatings: Array<Record<string, unknown>> = [];
  readonly toolEmbeddings: Array<Record<string, unknown>> = [];
  readonly pageContexts: Array<Record<string, unknown>> = [];
  readonly channels: Array<Record<string, unknown>> = [];
  readonly executorTokens: Array<Record<string, unknown>> = [];
  auditRows = 0;
  marker: Record<string, unknown> | null = null;

  readonly connection = {
    query: async (sql: string, params: unknown[] = []) => this.query(sql, params),
    beginTransaction: async () => { this.events.push('BEGIN'); },
    commit: async () => { this.events.push('COMMIT'); },
    rollback: async () => { this.events.push('ROLLBACK'); },
    release: () => { this.events.push('RELEASE'); },
  };

  readonly store = { db: { getConnection: async () => this.connection, query: async (sql: string, params: unknown[] = []) => this.query(sql, params) } };

  private rows<T extends Record<string, unknown>>(values: Iterable<T>): T[] {
    return [...values].map((value) => ({ ...value }));
  }

  private duplicate(): never {
    throw Object.assign(new Error('duplicate'), { code: 'ER_DUP_ENTRY', errno: 1062 });
  }

  private put(
    map: Map<string, Record<string, unknown>>,
    key: string,
    row: Record<string, unknown>,
    sql: string,
  ): void {
    if (map.has(key) && !sql.includes('ON DUPLICATE KEY UPDATE')) this.duplicate();
    map.set(key, row);
  }

  private async query(sql: string, params: unknown[]): Promise<[any[], Record<string, never>]> {
    const normalized = sql.replace(/\s+/g, ' ').trim();
    this.events.push(normalized);
    const result = (rows: any[] = []): [any[], Record<string, never>] => [rows, {}];

    if (normalized.startsWith('SELECT GET_LOCK')) return result([{ acquired: 1 }]);
    if (normalized.startsWith('SELECT RELEASE_LOCK')) return result([{ released: 1 }]);
    if (normalized === 'SET TRANSACTION ISOLATION LEVEL SERIALIZABLE') return result();
    if (normalized.includes('(SELECT COUNT(*) FROM bz_routes) AS routes')) {
      return result([{
        routes: this.routes.size,
        clients: this.clients.size,
        tool_providers: this.providers.size,
        targets: this.targets.size,
        channels: this.channels.length,
        chat_entries: this.chatEntries.size,
        jobs: this.jobs.length,
        approvals: 0,
        auxiliary: this.executorTokens.length,
        custom_targets: [...this.targets.keys()].filter((name) => name !== 'llm').length,
      }]);
    }
    if (normalized.startsWith('SELECT version,manifest_json,imported_at,updated_at FROM bz_demo_datasets')) {
      return result(this.marker ? [{ ...this.marker }] : []);
    }

    if (normalized === 'SELECT name FROM bz_targets WHERE name=? FOR UPDATE') return result(this.targets.has(String(params[0])) ? [{ name: params[0] }] : []);
    if (normalized === 'SELECT name FROM bz_tool_providers WHERE name=? FOR UPDATE') return result(this.providers.has(String(params[0])) ? [{ name: params[0] }] : []);
    if (normalized === 'SELECT route_key FROM bz_routes WHERE route_key=? FOR UPDATE') return result(this.routes.has(String(params[0])) ? [{ route_key: params[0] }] : []);
    if (normalized === 'SELECT app_id FROM bz_clients WHERE app_id=? FOR UPDATE') return result(this.clients.has(String(params[0])) ? [{ app_id: params[0] }] : []);
    if (normalized === 'SELECT entry_key FROM bz_chat_entries WHERE entry_key=? FOR UPDATE') return result(this.chatEntries.has(String(params[0])) ? [{ entry_key: params[0] }] : []);
    if (normalized.startsWith('SELECT id FROM bz_sessions WHERE route_key=')) return result(this.sessions.filter((row) => row['route_key'] === params[0]).slice(0, 1));
    if (normalized.startsWith('SELECT thread_id FROM bz_threads WHERE route_key=')) return result(this.threads.filter((row) => row['route_key'] === params[0]).slice(0, 1));
    if (normalized.startsWith('SELECT job_id FROM bz_jobs WHERE target=? OR client_app_id=?')) {
      return result(this.jobs.filter((row) => row['target'] === params[0]
        || row['client_app_id'] === params[1]
        || (row['dispatch'] as Record<string, unknown> | undefined)?.['route_key'] === params[2]).slice(0, 1));
    }
    if (normalized.startsWith('SELECT id FROM bz_tool_approvals WHERE provider=')) {
      return result(this.toolApprovals.filter((row) => row['provider'] === params[0]).slice(0, 1));
    }
    if (normalized.startsWith('SELECT job_id FROM bz_job_ratings WHERE entry_key=')) {
      return result(this.jobRatings.filter((row) => row['entry_key'] === params[0]).slice(0, 1));
    }
    if (normalized.startsWith('SELECT id FROM bz_tool_embeddings WHERE provider=')) {
      return result(this.toolEmbeddings.filter((row) => row['provider'] === params[0]).slice(0, 1));
    }

    if (normalized === 'SELECT * FROM bz_targets ORDER BY name') return result(this.rows(this.targets.values()));
    if (normalized.startsWith('SELECT * FROM bz_tool_providers WHERE name=')) return result(this.providers.has(String(params[0])) ? [{ ...this.providers.get(String(params[0]))! }] : []);
    if (normalized.startsWith('SELECT * FROM bz_routes WHERE route_key=')) return result(this.routes.has(String(params[0])) ? [{ ...this.routes.get(String(params[0]))! }] : []);
    if (normalized.startsWith('SELECT * FROM bz_clients WHERE app_id=')) return result(this.clients.has(String(params[0])) ? [{ ...this.clients.get(String(params[0]))! }] : []);
    if (normalized.startsWith('SELECT * FROM bz_chat_entries WHERE entry_key=')) return result(this.chatEntries.has(String(params[0])) ? [{ ...this.chatEntries.get(String(params[0]))! }] : []);

    if (normalized.startsWith('INSERT INTO bz_targets ')) {
      this.put(this.targets, String(params[0]), {
        name: params[0], kind: params[1], stateless: params[2], needs_project: params[3], timeout_ms: params[4],
        enabled: params[5], description: params[6], created_at: params[7], updated_at: params[8],
      }, normalized);
      return result();
    }
    if (normalized.startsWith('INSERT INTO bz_tool_providers ')) {
      this.put(this.providers, String(params[0]), {
        name: params[0], base_url: params[1], spec_source: params[2], spec_access_policy: params[3], spec_url: params[4],
        spec_json: params[5], spec_refreshed_at: params[6], spec_access_probe_json: params[7], authz_probe_json: params[8],
        secret: params[9], log_payload: params[10], timeout_ms: params[11], rate_limit_per_min: params[12],
        auto_refresh_min: params[13], enabled: params[14], description: params[15], embed_credential: params[16],
        embed_model: params[17], embed_dim: params[18], created_at: params[19], updated_at: params[20],
      }, normalized);
      return result();
    }
    if (normalized.startsWith('INSERT INTO bz_routes ')) {
      const columns = ['route_key', 'name', 'enabled', 'target', 'target_config', 'project', 'profile', 'permission', 'session_policy',
        'session_fixed_id', 'session_key_field', 'default_callback_url', 'delivery', 'knowledge', 'retry', 'tools', 'audience', 'memory',
        'budget', 'description', 'created_at', 'updated_at'];
      this.put(this.routes, String(params[0]), Object.fromEntries(columns.map((column, index) => [column, params[index]])), normalized);
      return result();
    }
    if (normalized.startsWith('INSERT INTO bz_clients ')) {
      const columns = ['app_id', 'name', 'token', 'allowed_routes', 'allowed_channels', 'rate_limit_per_min', 'budget', 'enabled', 'description', 'created_at', 'updated_at'];
      this.put(this.clients, String(params[0]), Object.fromEntries(columns.map((column, index) => [column, params[index]])), normalized);
      return result();
    }
    if (normalized.startsWith('INSERT INTO bz_chat_entries ')) {
      const columns = ['entry_key', 'name', 'route_key', 'enabled', 'allowed_origins', 'rate_limit_per_min', 'ticket_client', 'bucket',
        'title', 'greeting', 'color', 'appearance', 'description', 'created_at', 'updated_at'];
      this.put(this.chatEntries, String(params[0]), Object.fromEntries(columns.map((column, index) => [column, params[index]])), normalized);
      return result();
    }
    if (normalized.startsWith('UPDATE bz_clients SET token=')) {
      const client = this.clients.get(String(params[2]));
      if (client) { client['token'] = params[0]; client['updated_at'] = params[1]; }
      return result();
    }
    if (normalized.startsWith('INSERT INTO bz_demo_datasets ')) {
      if (this.marker) this.duplicate();
      this.marker = { dataset_key: params[0], version: params[1], manifest_json: params[2], imported_at: params[3], updated_at: params[4] };
      return result();
    }
    if (normalized.startsWith('UPDATE bz_demo_datasets SET version=')) {
      assert.ok(this.marker);
      this.marker = { ...this.marker!, version: params[0], manifest_json: params[1], updated_at: params[2] };
      return result();
    }

    if (normalized === 'SELECT route_key,target,tools,audience FROM bz_routes FOR UPDATE') return result(this.rows(this.routes.values()));
    if (normalized === 'SELECT entry_key,route_key,ticket_client FROM bz_chat_entries FOR UPDATE') return result(this.rows(this.chatEntries.values()));
    if (normalized === 'SELECT id,entry_key FROM bz_page_contexts FOR UPDATE') return result(this.rows(this.pageContexts));
    if (normalized === 'SELECT name,route_key FROM bz_channels FOR UPDATE') return result(this.rows(this.channels));
    if (normalized === 'SELECT app_id,allowed_routes FROM bz_clients FOR UPDATE') return result(this.rows(this.clients.values()));
    if (normalized === 'SELECT name,allowed_targets FROM bz_executor_tokens FOR UPDATE') return result(this.rows(this.executorTokens));

    if (normalized.startsWith('DELETE FROM bz_chat_entries WHERE entry_key=')) { this.chatEntries.delete(String(params[0])); return result(); }
    if (normalized.startsWith('DELETE FROM bz_clients WHERE app_id=')) { this.clients.delete(String(params[0])); return result(); }
    if (normalized.startsWith('DELETE FROM bz_routes WHERE route_key=')) { this.routes.delete(String(params[0])); return result(); }
    if (normalized.startsWith('DELETE FROM bz_tool_providers WHERE name=')) { this.providers.delete(String(params[0])); return result(); }
    if (normalized.startsWith('DELETE FROM bz_targets WHERE name=')) { this.targets.delete(String(params[0])); return result(); }
    if (normalized.startsWith('DELETE FROM bz_demo_datasets WHERE dataset_key=')) { this.marker = null; return result(); }

    throw new Error(`FakeDemoDatabase 未覆盖 SQL: ${normalized}`);
  }
}

test('demo dataset manifest: MySQL JSON 重排键后仍按结构验证', () => {
  const reordered = JSON.stringify({
    resources: {
      chat_entries: [],
      clients: [{ fingerprint: hash, key: 'demo-app' }],
      routes: [{ fingerprint: hash, key: 'demo_support' }],
      tool_providers: [{ fingerprint: hash, key: 'demo-business' }],
      targets: [{ fingerprint: hash, key: 'demo-agent' }],
    },
    profile: 'stateless-readonly',
    schema: 'bailinghub.demo-dataset.v1',
  });
  assert.equal(parseDemoDatasetManifest(reordered).profile, 'stateless-readonly');
});

test('demo dataset contract: hosted profile 不声明写工具或公开聊天入口', () => {
  const spec = demoToolSpec('stateless-readonly') as { paths: Record<string, unknown> };
  assert.deepEqual(Object.keys(spec.paths).sort(), ['/failure-demo', '/orders']);
  assert.match(DEMO_CHAT_ENTRY, /^pub_[A-Za-z0-9_-]{8,64}$/);
  assert.throws(() => parseDemoDatasetManifest({
    schema: 'bailinghub.demo-dataset.v1',
    profile: 'stateless-readonly',
    resources: {
      targets: [{ key: 'demo-agent', fingerprint: hash }],
      tool_providers: [{ key: 'demo-business', fingerprint: hash }],
      routes: [{ key: 'demo_support', fingerprint: hash }],
      clients: [{ key: 'demo-app', fingerprint: hash }],
      chat_entries: [{ key: DEMO_CHAT_ENTRY, fingerprint: hash }],
    },
  }), /chat_entries/);
});

test('demo dataset import: SERIALIZABLE 在交易前设置且首导 duplicate fail-closed', async () => {
  const events: string[] = [];
  const connection = {
    async query(sql: string): Promise<[any[], any]> {
      events.push(sql);
      if (sql.startsWith('SELECT GET_LOCK')) return [[{ acquired: 1 }], []];
      if (sql.startsWith('SELECT RELEASE_LOCK')) return [[{ released: 1 }], []];
      if (sql.startsWith('INSERT INTO bz_targets')) {
        assert.doesNotMatch(sql, /ON DUPLICATE KEY UPDATE/);
        throw Object.assign(new Error('duplicate'), { code: 'ER_DUP_ENTRY', errno: 1062 });
      }
      return [[], []];
    },
    async beginTransaction(): Promise<void> { events.push('BEGIN'); },
    async commit(): Promise<void> { events.push('COMMIT'); },
    async rollback(): Promise<void> { events.push('ROLLBACK'); },
    release(): void { events.push('RELEASE'); },
  };
  const service = new DemoDatasetService({
    db: { getConnection: async () => connection },
  } as any, {
    businessBaseUrl: 'http://127.0.0.1:19080',
    toolSecret: 'strong-independent-demo-secret',
    profile: 'stateless-readonly',
  });

  await assert.rejects(
    () => service.import(),
    (error: unknown) => error instanceof DemoDatasetConflictError && /Core 已回滚/.test(error.message),
  );
  assert.ok(events.indexOf('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE') < events.indexOf('BEGIN'));
  assert.ok(events.includes('ROLLBACK'));
  assert.ok(events.includes('RELEASE'));
});

test('demo dataset lifecycle: stateless import/status/refresh/clear 不伪造或清理运行账本', async () => {
  const db = new FakeDemoDatabase();
  let tick = 0;
  const service = new DemoDatasetService(db.store as any, {
    businessBaseUrl: 'http://127.0.0.1:19080',
    toolSecret: '4f7b2c91a8d03e65b49c27e018f3d6aa',
    profile: 'stateless-readonly',
  }, () => `2026-08-08T10:00:0${tick++}.000Z`);

  assert.deepEqual(await service.status(), {
    available: true,
    imported: false,
    empty: true,
    counts: { routes: 0, clients: 0, tool_providers: 0, targets: 1, channels: 0, chat_entries: 0, jobs: 0, approvals: 0 },
  });
  const imported = await service.import();
  assert.equal(imported.imported, true);
  assert.equal(db.chatEntries.size, 0);
  assert.deepEqual(imported.created.sort(), [
    'client:demo-app', 'route:demo_support', 'target:demo-agent', 'tool-provider:demo-business',
  ]);
  const importedAt = imported.imported_at;

  const refreshed = await service.import();
  assert.equal(refreshed.imported_at, importedAt);
  assert.equal(db.marker?.['version'], 1);

  db.jobs.push({ job_id: 'job-1', dispatch: { route_key: 'demo_support' } });
  db.auditRows = 3;
  const cleared = await service.clear();
  assert.equal(cleared.imported, false);
  assert.equal(cleared.counts.jobs, 1);
  assert.equal(db.jobs.length, 1);
  assert.equal(db.auditRows, 3);
  assert.equal(db.targets.has('demo-agent'), false);
  assert.equal(db.targets.has('llm'), true);
  assert.equal(db.events.some((sql) => /^DELETE FROM bz_(jobs|audit|messages)/.test(sql)), false);
});

test('demo dataset ownership: 指纹漂移后拒绝覆盖与删除', async () => {
  const db = new FakeDemoDatabase();
  const service = new DemoDatasetService(db.store as any, {
    businessBaseUrl: 'http://127.0.0.1:19080',
    toolSecret: '4f7b2c91a8d03e65b49c27e018f3d6aa',
    profile: 'stateless-readonly',
  });
  await service.import();
  db.routes.get('demo_support')!['name'] = '用户重建的同名路由';

  await assert.rejects(() => service.import(), (error: unknown) =>
    error instanceof DemoDatasetConflictError && error.conflicts.includes('route:demo_support'));
  assert.equal(db.routes.get('demo_support')?.['name'], '用户重建的同名路由');
  await assert.rejects(() => service.clear(), (error: unknown) =>
    error instanceof DemoDatasetConflictError && error.conflicts.includes('route:demo_support'));
  assert.equal(db.routes.has('demo_support'), true);
  assert.ok(db.marker);
});

test('demo dataset references: 首导不意外接通 dangling chat，清理不破坏外部引用', async () => {
  const dangling = new FakeDemoDatabase();
  dangling.chatEntries.set('pub_existing_entry', {
    entry_key: 'pub_existing_entry', name: 'existing', route_key: 'demo_support', enabled: 1,
    allowed_origins: '[]', rate_limit_per_min: 20, ticket_client: null,
  });
  const firstImport = new DemoDatasetService(dangling.store as any, {
    businessBaseUrl: 'http://127.0.0.1:19080',
    toolSecret: '4f7b2c91a8d03e65b49c27e018f3d6aa',
    profile: 'stateless-readonly',
  });
  await assert.rejects(() => firstImport.import(), (error: unknown) =>
    error instanceof DemoDatasetConflictError && error.conflicts.includes('chat-entry:pub_existing_entry->route:demo_support'));
  assert.equal(dangling.routes.has('demo_support'), false);

  const db = new FakeDemoDatabase();
  const service = new DemoDatasetService(db.store as any, {
    businessBaseUrl: 'http://127.0.0.1:19080',
    toolSecret: '4f7b2c91a8d03e65b49c27e018f3d6aa',
    profile: 'stateless-readonly',
  });
  await service.import();
  db.routes.set('user-route', {
    route_key: 'user-route', name: 'user', enabled: 1, target: 'demo-agent', target_config: '{}', profile: 'readonly',
    session_policy: 'new', tools: null, audience: null,
  });
  await assert.rejects(() => service.import(), (error: unknown) =>
    error instanceof DemoDatasetConflictError && error.conflicts.includes('route:user-route->target:demo-agent'));
  await assert.rejects(() => service.clear(), (error: unknown) =>
    error instanceof DemoDatasetConflictError && error.conflicts.includes('route:user-route->target:demo-agent'));
  assert.equal(db.routes.has('demo_support'), true);
});

test('演示数据首导：保留的运行账本不能重新认领固定 demo 身份', async () => {
  const db = new FakeDemoDatabase();
  db.jobs.push({ job_id: 'legacy-job', target: 'demo-agent', client_app_id: null, dispatch: {} });
  const service = new DemoDatasetService(db.store as any, {
    businessBaseUrl: 'http://127.0.0.1:19080',
    toolSecret: '4f7b2c91a8d03e65b49c27e018f3d6aa',
    profile: 'stateless-readonly',
  });

  await assert.rejects(() => service.import(), (error: unknown) =>
    error instanceof DemoDatasetConflictError && error.conflicts.includes('job-demo-identity'));
  assert.equal(db.routes.has('demo_support'), false);
});

test('demo dataset profile: full-local 仅导入默认停用的合法 chat entry', async () => {
  const db = new FakeDemoDatabase();
  const service = new DemoDatasetService(db.store as any, {
    businessBaseUrl: 'http://127.0.0.1:19080',
    toolSecret: 'demo-tool-secret-change-me',
    profile: 'full-local',
    clientToken: 'bailing-demo-client-token',
  });
  const imported = await service.import();
  assert.ok(imported.created.includes(`chat-entry:${DEMO_CHAT_ENTRY}`));
  assert.equal(db.chatEntries.get(DEMO_CHAT_ENTRY)?.['enabled'], 0);
  assert.equal(db.chatEntries.get(DEMO_CHAT_ENTRY)?.['route_key'], 'demo_support');
});
