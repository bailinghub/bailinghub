import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { loadConfig } from './config';

const ENV_KEYS = [
  'BAILING_ENV',
  'NODE_ENV',
  'BAILING_HOST',
  'BAILING_PORT',
  'BAILING_TOKEN',
  'BAILING_STATE_BACKEND',
  'BAILING_MYSQL_HOST',
  'BAILING_MYSQL_PORT',
  'BAILING_MYSQL_DATABASE',
  'BAILING_MYSQL_USER',
  'BAILING_MYSQL_PASSWORD',
  'BAILING_LLM_CREDENTIALS_JSON',
  'BAILING_ALERTS_TYPE',
  'BAILING_ALERTS_TO',
  'BAILING_ALERTS_URL',
  'BAILING_ALERTS_COOLDOWN_MIN',
  'BAILING_METRICS_ENABLED',
  'BAILING_METRICS_TOKEN',
  'BAILING_METRICS_SCRAPE_TIMEOUT_MS',
  'BAILING_TOOL_INDEX_LOAD_TIMEOUT_MS',
  'BAILING_TOOL_QUERY_EMBEDDING_TIMEOUT_MS',
  'BAILING_BOOTSTRAP_ADMIN_USERNAME',
  'BAILING_BOOTSTRAP_ADMIN_PASSWORD',
  'DEMO_BUSINESS_URL',
  'DEMO_TOOL_SECRET',
  'DEMO_PROFILE',
  'DEMO_CLIENT_TOKEN',
];

function withTempConfig(config: Record<string, unknown>, env: Record<string, string | undefined>, fn: () => void): void {
  const cwd = process.cwd();
  const saved: Record<string, string | undefined> = {};
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  const dir = mkdtempSync(join(tmpdir(), 'bailing-config-'));
  try {
    writeFileSync(join(dir, 'config.json'), JSON.stringify(config, null, 2));
    for (const [key, value] of Object.entries(env)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    process.chdir(dir);
    fn();
  } finally {
    process.chdir(cwd);
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

test('loadConfig: 生产模式拒绝 config.json 中的明文敏感项', () => {
  withTempConfig({
    server: { token: 'plain-token' },
    state: {
      backend: 'mysql',
      mysql: { host: 'db.example.com', database: 'bailing', user: 'root', password: 'plain-password' },
    },
  }, { BAILING_ENV: 'production' }, () => {
    assert.throws(
      () => loadConfig(),
      /生产模式禁止在 config\.json 写入敏感配置/,
    );
  });
});

test('loadConfig: 生产敏感项可完全由环境变量注入', () => {
  withTempConfig({
    server: { token: 'REPLACE_ME' },
    state: {
      backend: 'mysql',
      mysql: { host: 'REPLACE_ME', database: 'REPLACE_ME', user: 'REPLACE_ME', password: 'REPLACE_ME' },
    },
    llm_credentials: {
      main: { base_url: 'https://example.invalid', api_key: 'REPLACE_ME' },
    },
  }, {
    BAILING_ENV: 'production',
    BAILING_TOKEN: 'env-token-that-is-long-and-random-123',
    BAILING_STATE_BACKEND: 'mysql',
    BAILING_MYSQL_HOST: '127.0.0.1',
    BAILING_MYSQL_PORT: '3307',
    BAILING_MYSQL_DATABASE: 'bailinghub',
    BAILING_MYSQL_USER: 'bailing',
    BAILING_MYSQL_PASSWORD: 'secret',
    BAILING_LLM_CREDENTIALS_JSON: '{"main":{"base_url":"https://llm.example.com","api_key":"sk-env"}}',
    BAILING_ALERTS_TYPE: 'webhook',
    BAILING_ALERTS_URL: 'https://alert.example.com/hook',
    BAILING_ALERTS_COOLDOWN_MIN: '5',
  }, () => {
    const cfg = loadConfig();
    assert.equal(cfg.env, 'production');
    assert.equal(cfg.server.token, 'env-token-that-is-long-and-random-123');
    assert.equal(cfg.state.mysql.host, '127.0.0.1');
    assert.equal(cfg.state.mysql.port, 3307);
    assert.equal(cfg.state.mysql.database, 'bailinghub');
    assert.deepEqual(cfg.llmCredentials.main, { base_url: 'https://llm.example.com', api_key: 'sk-env' });
    assert.equal(cfg.alerts?.type, 'webhook');
    assert.equal(cfg.alerts?.url, 'https://alert.example.com/hook');
    assert.equal(cfg.alerts?.cooldown_min, 5);
  });
});

test('loadConfig: NODE_ENV 不会隐式开启生产密钥闸', () => {
  withTempConfig({
    server: { token: 'local-token' },
    state: { backend: 'jsonl' },
  }, { NODE_ENV: 'production' }, () => {
    const cfg = loadConfig();
    assert.equal(cfg.env, 'development');
    assert.equal(cfg.server.token, 'local-token');
  });
});

test('loadConfig: 本地回环开发允许不配置 token', () => {
  withTempConfig({
    server: { host: '127.0.0.1', token: '' },
    state: { backend: 'jsonl' },
  }, { BAILING_ENV: 'development' }, () => {
    const cfg = loadConfig();
    assert.equal(cfg.server.token, '');
  });
});

test('loadConfig: Kernel Host 从已安装 Core 制品加载默认值，不依赖或信任 consumer cwd', () => {
  withTempConfig({
    brand: { name: 'consumer-cwd-must-not-be-read' },
    server: { host: '0.0.0.0', token: 'consumer-secret' },
    state: { backend: 'mysql', mysql: { host: 'consumer-db', password: 'consumer-password' } },
  }, {}, () => {
    const consumerCwd = process.cwd();
    const cfg = loadConfig({ mode: 'kernel-host' });
    assert.notEqual(cfg.root, consumerCwd);
    assert.notEqual(cfg.brand.name, 'consumer-cwd-must-not-be-read');
    assert.equal(cfg.server.token, '');
    assert.deepEqual(cfg.state.mysql, {
      host: '', port: 3306, database: '', user: '', password: '', connectionLimit: 1,
    });
  });
});

test('loadConfig: 非回环开发监听缺少 token 时拒绝启动', () => {
  withTempConfig({
    server: { host: '0.0.0.0', token: '' },
    state: { backend: 'jsonl' },
  }, { BAILING_ENV: 'development' }, () => {
    assert.throws(() => loadConfig(), /BAILING_TOKEN 未配置/);
  });
});

test('loadConfig: 生产模式拒绝公开示例 token', () => {
  withTempConfig({
    server: { token: 'REPLACE_ME' },
    state: { backend: 'jsonl' },
  }, {
    BAILING_ENV: 'production',
    BAILING_TOKEN: 'bailing-dev-admin-token-change-me',
  }, () => {
    assert.throws(() => loadConfig(), /BAILING_TOKEN 不安全/);
  });
});

test('loadConfig: 首次管理员变量缺失时保持禁用', () => {
  withTempConfig({
    server: { host: '127.0.0.1', token: '' },
    state: { backend: 'jsonl' },
  }, { BAILING_ENV: 'development' }, () => {
    const cfg = loadConfig();
    assert.equal(cfg.bootstrapAdmin, null);
  });
});

test('loadConfig: metrics 默认关闭且启用时要求独立强令牌', () => {
  const config = {
    server: { host: '127.0.0.1', token: 'server-only-token-with-enough-entropy-2026' },
    state: { backend: 'jsonl' },
  };
  withTempConfig(config, {}, () => {
    assert.deepEqual(loadConfig().metrics, {
      enabled: false,
      token: '',
      scrapeTimeoutMs: 5000,
    });
  });
  withTempConfig(config, { BAILING_METRICS_ENABLED: 'true' }, () => {
    assert.throws(() => loadConfig(), /BAILING_METRICS_TOKEN 不安全/);
  });
  withTempConfig(config, {
    BAILING_METRICS_ENABLED: 'true',
    BAILING_METRICS_TOKEN: 'server-only-token-with-enough-entropy-2026',
  }, () => {
    assert.throws(() => loadConfig(), /必须与 BAILING_TOKEN 分离/);
  });
  withTempConfig(config, {
    BAILING_METRICS_ENABLED: 'true',
    BAILING_METRICS_TOKEN: 'metrics-only-token-with-enough-entropy-2026',
    BAILING_METRICS_SCRAPE_TIMEOUT_MS: '750',
  }, () => {
    assert.deepEqual(loadConfig().metrics, {
      enabled: true,
      token: 'metrics-only-token-with-enough-entropy-2026',
      scrapeTimeoutMs: 750,
    });
  });
});

test('loadConfig: metrics 配置拒绝模糊布尔值和越界超时', () => {
  const config = { server: { host: '127.0.0.1', token: '' }, state: { backend: 'jsonl' } };
  withTempConfig(config, { BAILING_METRICS_ENABLED: 'sometimes' }, () => {
    assert.throws(() => loadConfig(), /BAILING_METRICS_ENABLED 必须是/);
  });
  withTempConfig(config, { BAILING_METRICS_SCRAPE_TIMEOUT_MS: '100' }, () => {
    assert.throws(() => loadConfig(), /必须是 250~30000 的整数/);
  });
});

test('loadConfig: 工具检索运行保护使用安全默认值并允许部署覆盖', () => {
  const config = { server: { host: '127.0.0.1', token: '' }, state: { backend: 'jsonl' } };
  withTempConfig(config, {}, () => {
    assert.deepEqual(loadConfig().toolRetrieval, {
      indexLoadTimeoutMs: 5000,
      embeddingTimeoutMs: 15_000,
    });
  });
  withTempConfig(config, {
    BAILING_TOOL_INDEX_LOAD_TIMEOUT_MS: '1200',
    BAILING_TOOL_QUERY_EMBEDDING_TIMEOUT_MS: '8000',
  }, () => {
    assert.deepEqual(loadConfig().toolRetrieval, {
      indexLoadTimeoutMs: 1200,
      embeddingTimeoutMs: 8000,
    });
  });
});

test('loadConfig: 工具检索运行保护拒绝非整数与越界超时', () => {
  const config = { server: { host: '127.0.0.1', token: '' }, state: { backend: 'jsonl' } };
  withTempConfig(config, { BAILING_TOOL_INDEX_LOAD_TIMEOUT_MS: '99' }, () => {
    assert.throws(() => loadConfig(), /BAILING_TOOL_INDEX_LOAD_TIMEOUT_MS 必须是 100~60000 的整数/);
  });
  withTempConfig(config, { BAILING_TOOL_QUERY_EMBEDDING_TIMEOUT_MS: '120000.5' }, () => {
    assert.throws(() => loadConfig(), /BAILING_TOOL_QUERY_EMBEDDING_TIMEOUT_MS 必须是 250~120000 的整数/);
  });
});

test('loadConfig: 演示数据边界由环境注入且规范化 URL', () => {
  const config = { server: { host: '127.0.0.1', token: '' }, state: { backend: 'jsonl' } };
  withTempConfig(config, {
    DEMO_BUSINESS_URL: 'http://127.0.0.1:19080/',
    DEMO_TOOL_SECRET: 'a-strong-demo-secret-for-trial',
    DEMO_PROFILE: 'stateless-readonly',
  }, () => {
    assert.deepEqual(loadConfig().demoDataset, {
      businessBaseUrl: 'http://127.0.0.1:19080',
      toolSecret: 'a-strong-demo-secret-for-trial',
      profile: 'stateless-readonly',
    });
  });
});

test('loadConfig: 无状态只读演示拒绝缺失、非 HTTP 和弱密钥', () => {
  const config = { server: { host: '127.0.0.1', token: '' }, state: { backend: 'jsonl' } };
  withTempConfig(config, { DEMO_BUSINESS_URL: 'http://127.0.0.1:19080' }, () => {
    assert.throws(() => loadConfig(), /DEMO_BUSINESS_URL 与 DEMO_TOOL_SECRET 必须同时配置/);
  });
  withTempConfig(config, {
    DEMO_BUSINESS_URL: 'file:///tmp/demo',
    DEMO_TOOL_SECRET: 'a-strong-demo-secret-for-trial',
    DEMO_PROFILE: 'stateless-readonly',
  }, () => {
    assert.throws(() => loadConfig(), /http\(s\) URL/);
  });
  withTempConfig(config, {
    DEMO_BUSINESS_URL: 'http://127.0.0.1:19080',
    DEMO_TOOL_SECRET: 'demo-tool-secret-change-me',
    DEMO_PROFILE: 'stateless-readonly',
  }, () => {
    assert.throws(() => loadConfig(), /至少 24 位/);
  });
  withTempConfig(config, {
    DEMO_BUSINESS_URL: 'http://127.0.0.1:19080',
    DEMO_TOOL_SECRET: 'REPLACE_WITH_32_BYTE_INDEPENDENT_DEMO_TOOL_SECRET',
    DEMO_PROFILE: 'stateless-readonly',
  }, () => {
    assert.throws(() => loadConfig(), /至少 24 位/);
  });
  withTempConfig(config, {
    DEMO_BUSINESS_URL: 'http://127.0.0.1:19080',
    DEMO_TOOL_SECRET: ' a-strong-demo-secret-for-trial ',
    DEMO_PROFILE: 'stateless-readonly',
  }, () => {
    assert.throws(() => loadConfig(), /至少 24 位/);
  });
});

test('loadConfig: full-local Docker demo 保留显式的本地兼容默认', () => {
  const config = { server: { host: '127.0.0.1', token: '' }, state: { backend: 'jsonl' } };
  withTempConfig(config, {
    DEMO_BUSINESS_URL: 'http://demo-business:19080',
    DEMO_TOOL_SECRET: 'demo-tool-secret-change-me',
  }, () => {
    assert.deepEqual(loadConfig().demoDataset, {
      businessBaseUrl: 'http://demo-business:19080',
      toolSecret: 'demo-tool-secret-change-me',
      profile: 'full-local',
      clientToken: 'bailing-demo-client-token',
    });
  });
});

test('loadConfig: 首次管理员变量必须成对配置且不回显密码', () => {
  const password = 'bootstrap-secret-123';
  withTempConfig({
    server: { host: '127.0.0.1', token: '' },
    state: { backend: 'mysql', mysql: {} },
  }, {
    BAILING_ENV: 'development',
    BAILING_BOOTSTRAP_ADMIN_USERNAME: 'initial_admin',
  }, () => {
    assert.throws(
      () => loadConfig(),
      (error: unknown) => {
        assert.match(String(error), /必须同时配置/);
        assert.doesNotMatch(String(error), new RegExp(password));
        return true;
      },
    );
  });

  withTempConfig({
    server: { host: '127.0.0.1', token: '' },
    state: { backend: 'mysql', mysql: {} },
  }, {
    BAILING_ENV: 'development',
    BAILING_BOOTSTRAP_ADMIN_USERNAME: 'initial_admin',
    BAILING_BOOTSTRAP_ADMIN_PASSWORD: password,
  }, () => {
    assert.deepEqual(loadConfig().bootstrapAdmin, {
      username: 'initial_admin',
      password,
    });
  });
});

test('loadConfig: 首次管理员拒绝非法用户名、短密码和非 mysql 后端', () => {
  const base = {
    server: { host: '127.0.0.1', token: '' },
    state: { backend: 'mysql', mysql: {} },
  };
  withTempConfig(base, {
    BAILING_BOOTSTRAP_ADMIN_USERNAME: 'invalid username',
    BAILING_BOOTSTRAP_ADMIN_PASSWORD: 'long-enough-password',
  }, () => {
    assert.throws(() => loadConfig(), /仅允许 2~64 位/);
  });
  withTempConfig(base, {
    BAILING_BOOTSTRAP_ADMIN_USERNAME: 'admin',
    BAILING_BOOTSTRAP_ADMIN_PASSWORD: 'short',
  }, () => {
    assert.throws(() => loadConfig(), /至少 8 位/);
  });
  withTempConfig({
    server: { host: '127.0.0.1', token: '' },
    state: { backend: 'jsonl' },
  }, {
    BAILING_BOOTSTRAP_ADMIN_USERNAME: 'admin',
    BAILING_BOOTSTRAP_ADMIN_PASSWORD: 'long-enough-password',
  }, () => {
    assert.throws(() => loadConfig(), /需要 mysql 状态后端/);
  });
});
