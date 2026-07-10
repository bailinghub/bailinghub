import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('../../..', import.meta.url));
const schemasDir = join(root, 'schemas');
const configSchemasDir = join(schemasDir, 'config');

type SchemaObject = Record<string, any>;

function schemaFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return schemaFiles(path);
    return entry.isFile() && entry.name.endsWith('.schema.json') ? [path] : [];
  }).sort();
}

function readSchema(path: string): SchemaObject {
  return JSON.parse(readFileSync(path, 'utf8')) as SchemaObject;
}

function collectRefs(value: unknown, refs: string[] = []): string[] {
  if (!value || typeof value !== 'object') return refs;
  if (Array.isArray(value)) {
    for (const item of value) collectRefs(item, refs);
    return refs;
  }
  const obj = value as Record<string, unknown>;
  if (typeof obj.$ref === 'string') refs.push(obj.$ref);
  for (const item of Object.values(obj)) collectRefs(item, refs);
  return refs;
}

test('Config JSON Schemas: 文件可解析、id 唯一、相对引用不断链', () => {
  const files = schemaFiles(configSchemasDir);
  assert.deepEqual(files.map((f) => relative(configSchemasDir, f)), [
    'alert-rule.schema.json',
    'channel.schema.json',
    'chat-entry.schema.json',
    'client.schema.json',
    'common.schema.json',
    'credential.schema.json',
    'executor-token.schema.json',
    'page-context.schema.json',
    'route.schema.json',
    'storage-bucket.schema.json',
    'target.schema.json',
    'tool-provider.schema.json',
  ]);

  const ids = new Set<string>();
  for (const file of files) {
    const schema = readSchema(file);
    assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema', `${basename(file)} should use draft 2020-12`);
    assert.match(schema.$id, /^https:\/\/www\.bailinghub\.com\/schemas\/config\/.+\.schema\.json$/);
    assert.equal(ids.has(schema.$id), false, `${schema.$id} duplicated`);
    ids.add(schema.$id);

    for (const ref of collectRefs(schema)) {
      if (ref.startsWith('#')) continue;
      const [refFile] = ref.split('#');
      assert.ok(refFile, `${basename(file)} has empty external ref`);
      assert.equal(existsSync(join(dirname(file), refFile)), true, `${basename(file)} broken ref: ${ref}`);
    }
  }
});

test('Config JSON Schemas: 路由、目标和工具治理关键契约对齐', () => {
  const route = readSchema(join(configSchemasDir, 'route.schema.json'));
  const target = readSchema(join(configSchemasDir, 'target.schema.json'));
  const common = readSchema(join(configSchemasDir, 'common.schema.json'));

  assert.deepEqual(route.properties.session_policy.enum, ['new', 'fixed', 'per_key', 'passthrough']);
  assert.deepEqual(route.required, ['route_key', 'name', 'enabled', 'target', 'target_config', 'profile', 'session_policy']);
  assert.equal(route.properties.retry.properties.max.maximum, 5);
  assert.equal(route.properties.retry.properties.backoff_ms.minimum, 500);
  assert.equal(route.properties.retry.properties.backoff_ms.maximum, 300000);

  assert.deepEqual(target.properties.kind.enum, ['inhub', 'executor']);
  assert.equal(target.properties.timeout_ms.maximum, 3600000);

  const llm = common.$defs.llmTargetConfig;
  assert.deepEqual(llm.required, ['credential']);
  assert.equal(llm.properties.temperature.maximum, 2);
  assert.deepEqual(llm.properties.input.properties.image.properties.mode.enum, ['tool', 'prepass', 'inline', 'off']);
  assert.equal(llm.properties.input.properties.image.properties.max_calls.maximum, 30);
  assert.deepEqual(llm.properties.input.properties.audio.properties.mode.enum, ['transcribe', 'inline', 'off']);
  assert.equal(llm.properties.input.properties.audio.properties.max_bytes.maximum, 52428800);
  assert.deepEqual(llm.properties.input.properties.file.properties.mode.enum, ['extract', 'summarize', 'inline', 'off']);
  assert.equal(llm.properties.input.properties.file.properties.max_chars.maximum, 200000);

  const flatDisallowed = common.$defs.routeToolsConfig.not.anyOf.map((item: SchemaObject) => item.required[0]);
  assert.deepEqual(flatDisallowed, ['provider', 'allow', 'subject_field', 'send_channels', 'approver', 'source']);
  assert.deepEqual(common.$defs.routeToolsConfig.properties.sources.items.required, ['provider', 'allow']);
  assert.equal(common.$defs.routeToolsConfig.properties.sources.minItems, 1);
  assert.equal(common.$defs.routeToolsConfig.properties.max_calls.maximum, 50);
  assert.deepEqual(common.$defs.routeToolsConfig.properties.builtin.properties.send_message.required, ['channels']);
  assert.deepEqual(common.$defs.routeToolsConfig.properties.approval.required, ['type']);
});

test('Config JSON Schemas: 接入方、渠道、存储桶和工具源契约对齐', () => {
  const channel = readSchema(join(configSchemasDir, 'channel.schema.json'));
  const credential = readSchema(join(configSchemasDir, 'credential.schema.json'));
  const client = readSchema(join(configSchemasDir, 'client.schema.json'));
  const executorToken = readSchema(join(configSchemasDir, 'executor-token.schema.json'));
  const storageBucket = readSchema(join(configSchemasDir, 'storage-bucket.schema.json'));
  const toolProvider = readSchema(join(configSchemasDir, 'tool-provider.schema.json'));
  const alertRule = readSchema(join(configSchemasDir, 'alert-rule.schema.json'));
  const chatEntry = readSchema(join(configSchemasDir, 'chat-entry.schema.json'));
  const pageContext = readSchema(join(configSchemasDir, 'page-context.schema.json'));

  assert.deepEqual(channel.required, ['name', 'kind', 'route_key', 'config', 'enabled']);
  assert.equal(channel.properties.config.properties.reply_wait_ms.maximum, 4500);
  assert.deepEqual(channel.allOf[0].then.properties.config.required, ['token', 'aes_key']);

  assert.deepEqual(credential.properties.kind.enum, ['chat', 'embedding', 'both']);
  assert.deepEqual(credential.required, ['name', 'kind', 'base_url', 'api_key', 'enabled']);

  assert.deepEqual(client.required, ['app_id', 'name', 'allowed_routes', 'allowed_channels', 'rate_limit_per_min', 'enabled']);
  assert.equal(client.properties.budget.$ref, 'common.schema.json#/$defs/budgetPolicy');

  assert.deepEqual(executorToken.required, ['name', 'allowed_targets', 'enabled']);
  assert.equal(executorToken.properties.allowed_targets.uniqueItems, true);

  assert.deepEqual(storageBucket.properties.kind.enum, ['local', 'cos', 'oss', 's3']);
  assert.deepEqual(storageBucket.required, ['name', 'kind', 'path_prefix', 'enabled']);
  assert.deepEqual(storageBucket.allOf[0].then.required, ['region', 'bucket', 'public_base_url']);

  assert.deepEqual(toolProvider.properties.spec_source.enum, ['url', 'inline']);
  assert.deepEqual(toolProvider.required, ['name', 'base_url', 'spec_source', 'secret', 'log_payload', 'timeout_ms', 'rate_limit_per_min', 'auto_refresh_min', 'enabled']);
  assert.deepEqual(toolProvider.allOf[0].then.required, ['spec_url']);

  assert.deepEqual(alertRule.required, ['channel', 'recipients', 'cooldown_min', 'enabled']);
  assert.equal(alertRule.properties.cooldown_min.maximum, 1440);

  assert.deepEqual(chatEntry.required, ['name', 'route_key', 'allowed_origins', 'rate_limit_per_min', 'enabled']);
  assert.equal(chatEntry.properties.rate_limit_per_min.maximum, 600);
  assert.deepEqual(chatEntry.properties.appearance.properties.title_align.enum, ['center', 'left']);
  assert.deepEqual(chatEntry.properties.appearance.properties.position.enum, ['right', 'left']);
  assert.equal(chatEntry.properties.appearance.properties.ai_notice.type, 'boolean');

  assert.deepEqual(pageContext.required, ['entry_key', 'url_pattern', 'enabled']);
  assert.equal(pageContext.properties.description.maxLength, 1000);
  assert.equal(pageContext.properties.kb_tag, undefined);
});
