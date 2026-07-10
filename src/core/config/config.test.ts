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
    BAILING_TOKEN: 'env-token',
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
    assert.equal(cfg.server.token, 'env-token');
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
