// 覆盖：模型凭证解析优先级与 DB 凭证运行期注入。
// 这是 target 插座工业化的基础：engine 不应关心凭证存在 config 还是 DB。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  injectLlmRuntimeCredentials,
  resolveLlmCredential,
  resolveSummaryCredential,
  type CredentialStoreLike,
} from './credential-resolver';
import type { Credential } from '../contracts/types';

function store(rows: Record<string, Credential | null>, touched: string[] = []): CredentialStoreLike {
  return {
    async get(name) {
      return rows[name] ?? null;
    },
    async touch(name) {
      touched.push(name);
    },
  };
}

const dbMain: Credential = {
  name: 'main',
  kind: 'chat',
  base_url: 'https://db.example.com/v1',
  api_key: 'db-key',
  default_model: 'db-model',
  enabled: true,
};

test('resolveLlmCredential: config.json 凭证优先于 DB', async () => {
  const touched: string[] = [];
  const got = await resolveLlmCredential('main', {
    llmCredentials: { main: { base_url: 'https://file.example.com/v1', api_key: 'file-key' } },
  }, store({ main: dbMain }, touched));

  assert.equal(got?.source, 'config');
  assert.equal(got?.credential.base_url, 'https://file.example.com/v1');
  assert.deepEqual(touched, []);
});

test('injectLlmRuntimeCredentials: 只注入非敏感凭证来源，config 凭证内容不复制进运行期配置', async () => {
  const target = await injectLlmRuntimeCredentials({ credential: 'main' }, {
    llmCredentials: { main: { base_url: 'https://file.example.com/v1', api_key: 'file-key' } },
  }, store({ main: dbMain }));

  assert.equal(target['_credential_source'], 'config');
  assert.equal(target['_db_credential'], undefined);
  assert.doesNotMatch(JSON.stringify(target), /file-key|db-key/);
});

test('resolveLlmCredential: DB chat/both 凭证可用并 touch，disabled/embedding 不可用', async () => {
  const touched: string[] = [];
  const s = store({
    main: dbMain,
    disabled: { ...dbMain, name: 'disabled', enabled: false },
    embedding: { ...dbMain, name: 'embedding', kind: 'embedding' },
  }, touched);

  const got = await resolveLlmCredential('main', { llmCredentials: {} }, s);
  assert.equal(got?.source, 'db');
  assert.equal(got?.credential.default_model, 'db-model');
  assert.deepEqual(touched, ['main']);
  assert.equal(await resolveLlmCredential('disabled', { llmCredentials: {} }, s), null);
  assert.equal(await resolveLlmCredential('embedding', { llmCredentials: {} }, s), null);
});

test('injectLlmRuntimeCredentials: DB brain/input 凭证只注入运行期字段', async () => {
  const target = await injectLlmRuntimeCredentials({
    credential: 'main',
    model: 'qwen-plus',
    input: {
      image: { credential: 'vision', model: 'qwen-vl-max', mode: 'tool' },
      audio: { credential: 'asr', model: 'whisper-1', mode: 'transcribe' },
      file: { credential: 'doc', model: 'qwen-long', mode: 'summarize' },
    },
  }, { llmCredentials: {} }, store({
    main: dbMain,
    vision: { ...dbMain, name: 'vision', base_url: 'https://vision.example.com/v1', default_model: 'vl-default' },
    asr: { ...dbMain, name: 'asr', base_url: 'https://asr.example.com/v1', default_model: 'whisper-default' },
    doc: { ...dbMain, name: 'doc', base_url: 'https://doc.example.com/v1', default_model: 'doc-default' },
  }));

  assert.deepEqual(target['_db_credential'], {
    base_url: 'https://db.example.com/v1',
    api_key: 'db-key',
    default_model: 'db-model',
  });
  assert.equal(target['_credential_source'], 'db');
  const input = target['input'] as Record<string, Record<string, unknown>>;
  assert.ok(input.image);
  assert.ok(input.audio);
  assert.ok(input.file);
  assert.deepEqual(input.image['_db_credential'], {
    base_url: 'https://vision.example.com/v1',
    api_key: 'db-key',
    default_model: 'vl-default',
  });
  assert.equal(input.image['_credential_source'], 'db');
  assert.deepEqual(input.audio['_db_credential'], {
    base_url: 'https://asr.example.com/v1',
    api_key: 'db-key',
    default_model: 'whisper-default',
  });
  assert.deepEqual(input.file['_db_credential'], {
    base_url: 'https://doc.example.com/v1',
    api_key: 'db-key',
    default_model: 'doc-default',
  });
});

test('injectLlmRuntimeCredentials: input 子策略留空或同 brain 时不重复注入凭证', async () => {
  const target = await injectLlmRuntimeCredentials({
    credential: 'main',
    input: { image: { credential: 'main', model: 'qwen-vl-max' } },
  }, { llmCredentials: {} }, store({ main: dbMain }));

  assert.ok(target['_db_credential']);
  assert.equal(((target['input'] as Record<string, unknown>).image as Record<string, unknown>)['_db_credential'], undefined);
});

test('resolveSummaryCredential: 摘要复用 route target_config 的 llm 凭证', async () => {
  const got = await resolveSummaryCredential({ credential: 'main' }, { llmCredentials: {} }, store({ main: dbMain }));
  assert.equal(got?.name, 'main');
  assert.equal(got?.credential.default_model, 'db-model');
  assert.equal(await resolveSummaryCredential({}, { llmCredentials: {} }, store({})), null);
});
