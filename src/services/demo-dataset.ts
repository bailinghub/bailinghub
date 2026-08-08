import { createHash } from 'node:crypto';
import type { PoolConnection, RowDataPacket } from 'mysql2/promise';
import { parseOpenApiSpec } from '../core/contracts/openapi-tools';
import type { ChatEntry, Client, Route, TargetDef, ToolProvider } from '../core/contracts/types';
import type { DemoDatasetConfig, DemoDatasetProfile } from '../core/config/config';
import { dtAt } from '../core/config/config-codec';
import { ChatConfigRepository } from '../infrastructure/config/config-chat-repository';
import { ClientRepository } from '../infrastructure/config/config-client-repository';
import { RouteRepository } from '../infrastructure/config/config-route-repository';
import { TargetRepository } from '../infrastructure/config/config-target-repository';
import { ToolProviderRepository } from '../infrastructure/config/config-tool-provider-repository';
import type { ConfigStoreContract } from '../infrastructure/config/configstore';

export interface DemoDatasetCounts {
  routes: number;
  clients: number;
  tool_providers: number;
  targets: number;
  channels: number;
  chat_entries: number;
  jobs: number;
  approvals: number;
}

export interface DemoDatasetStatus {
  available: boolean;
  imported: boolean;
  empty: boolean;
  imported_at?: string;
  counts: DemoDatasetCounts;
}

export interface DemoDatasetImportResult extends DemoDatasetStatus {
  ok: true;
  created: string[];
}

export interface DemoDatasetClearResult extends DemoDatasetStatus {
  ok: true;
  removed: string[];
}

interface DemoDatasetManifest {
  schema: 'bailinghub.demo-dataset.v1';
  profile: DemoDatasetProfile;
  resources: {
    targets: DemoOwnedResource[];
    tool_providers: DemoOwnedResource[];
    routes: DemoOwnedResource[];
    clients: DemoOwnedResource[];
    chat_entries: DemoOwnedResource[];
  };
}

interface DemoOwnedResource {
  key: string;
  fingerprint: string;
}

interface DatasetMarkerRow extends RowDataPacket {
  version: number;
  manifest_json: string | DemoDatasetManifest;
  imported_at: string | Date;
  updated_at: string | Date;
}

interface CountRow extends RowDataPacket {
  routes: number | string;
  clients: number | string;
  tool_providers: number | string;
  targets: number | string;
  channels: number | string;
  chat_entries: number | string;
  jobs: number | string;
  approvals: number | string;
  auxiliary: number | string;
  custom_targets: number | string;
}

export const DEMO_DATASET_KEY = 'core-getting-started';
export const DEMO_DATASET_VERSION = 1;
export const DEMO_TARGET = 'demo-agent';
export const DEMO_TOOL_PROVIDER = 'demo-business';
export const DEMO_ROUTE = 'demo_support';
export const DEMO_CLIENT = 'demo-app';
export const DEMO_CHAT_ENTRY = 'pub_demo_support';

const RESOURCE_KEYS = Object.freeze({
  targets: Object.freeze([DEMO_TARGET]),
  tool_providers: Object.freeze([DEMO_TOOL_PROVIDER]),
  routes: Object.freeze([DEMO_ROUTE]),
  clients: Object.freeze([DEMO_CLIENT]),
  chat_entries: Object.freeze([DEMO_CHAT_ENTRY]),
});

const LOCK_SQL = "SELECT GET_LOCK(SHA2(CONCAT('bailinghub:demo-dataset:', DATABASE()), 256), 10) AS acquired";
const UNLOCK_SQL = "SELECT RELEASE_LOCK(SHA2(CONCAT('bailinghub:demo-dataset:', DATABASE()), 256)) AS released";

export class DemoDatasetUnavailableError extends Error {}
export class DemoDatasetConflictError extends Error {
  constructor(message: string, readonly conflicts: string[] = []) { super(message); }
}

function capability(scope: string, options: {
  risk?: 'low' | 'medium' | 'high';
  requiresSubject?: boolean;
  readonly?: boolean;
  idempotent?: boolean;
  approval?: { required?: boolean; prompt?: string };
  whenToUse?: string;
  returns?: string;
} = {}): Record<string, unknown> {
  return {
    version: 1,
    enabled: true,
    scope,
    ...(options.risk && options.risk !== 'low' ? { risk: { level: options.risk } } : {}),
    ...(options.requiresSubject ? { subject: { required: true } } : {}),
    ...(options.approval ? { approval: options.approval } : {}),
    ...((options.readonly !== undefined || options.idempotent !== undefined) ? {
      execution: {
        ...(options.readonly !== undefined ? { readonly: options.readonly } : {}),
        ...(options.idempotent !== undefined ? { idempotent: options.idempotent } : {}),
      },
    } : {}),
    ...((options.whenToUse || options.returns) ? {
      guidance: {
        ...(options.whenToUse ? { when_to_use: options.whenToUse } : {}),
        ...(options.returns ? { returns: options.returns } : {}),
      },
    } : {}),
  };
}

/** 与 demo/business/server.mjs 的公开契约对齐；只读 profile 从定义层就不声明写工具。 */
export function demoToolSpec(profile: DemoDatasetProfile): Record<string, unknown> {
  const paths: Record<string, unknown> = {
    '/orders': {
      get: {
        operationId: 'list_demo_orders',
        summary: '查询当前操作主体可见的订单列表',
        description: '按订单号或客户名查询 demo 订单。无过滤条件时返回当前主体可见的最近订单。',
        'x-agent-capability': capability('demo.order.read', {
          requiresSubject: true,
          readonly: true,
          whenToUse: '用户询问订单状态、付款状态、物流状态或历史订单时使用。',
          returns: '订单号、客户、商品、金额、状态、物流状态。',
        }),
        parameters: [
          { name: 'order_no', in: 'query', required: false, description: '订单号，例如 SO-1001。', schema: { type: 'string' } },
          { name: 'customer', in: 'query', required: false, description: '客户名，可用于模糊过滤。', schema: { type: 'string' } },
        ],
        responses: { '200': { description: 'OK' } },
      },
    },
    '/failure-demo': {
      get: {
        operationId: 'demo_failure_probe',
        summary: '触发一个可观测失败',
        description: '用于演示中枢 trace 如何记录业务工具 5xx、错误正文和排障路径。',
        'x-agent-capability': capability('demo.failure.read', { requiresSubject: true, readonly: true }),
        responses: { '500': { description: 'Intentional demo failure' } },
      },
    },
  };
  if (profile === 'full-local') {
    paths['/tickets'] = {
      post: {
        operationId: 'create_demo_ticket',
        summary: '为当前操作主体创建售后工单',
        description: '当用户明确要求登记问题、创建工单或需要人工跟进时使用。',
        'x-agent-capability': capability('demo.ticket.create', {
          risk: 'medium', requiresSubject: true, idempotent: false,
          whenToUse: '用户要求人工处理、售后跟进、开工单或记录问题时使用。',
          returns: '工单编号与当前状态。',
        }),
        requestBody: {
          required: true,
          content: { 'application/json': { schema: {
            type: 'object',
            properties: { order_no: { type: 'string' }, title: { type: 'string' }, message: { type: 'string' } },
            required: ['title', 'message'],
          } } },
        },
        responses: { '200': { description: 'OK' } },
      },
    };
    paths['/refunds'] = {
      post: {
        operationId: 'request_demo_refund',
        summary: '提交退款申请',
        description: '本地单组织 demo 的高风险工具：会产生内存中的退款申请，必须进入审批车道。',
        'x-agent-capability': capability('demo.refund.request', {
          risk: 'high', requiresSubject: true,
          approval: { required: true, prompt: '确认要为订单 {{order_no}} 申请退款 {{amount}} 元吗？' },
        }),
        requestBody: {
          required: true,
          content: { 'application/json': { schema: {
            type: 'object',
            properties: { order_no: { type: 'string' }, amount: { type: 'number' }, reason: { type: 'string' } },
            required: ['order_no', 'amount', 'reason'],
          } } },
        },
        responses: { '202': { description: 'Accepted' } },
      },
    };
  }
  return {
    openapi: '3.1.0',
    info: { title: 'Bailing demo business tools', version: '1.0.0' },
    'x-bailing-authz-probe': { method: 'POST', path: '/.well-known/bailing/authz-probe' },
    paths,
  };
}

export function parseDemoDatasetManifest(value: unknown): DemoDatasetManifest {
  let parsed: unknown;
  try { parsed = typeof value === 'string' ? JSON.parse(value) as unknown : value; }
  catch { throw new DemoDatasetConflictError('演示数据所有权 manifest 已损坏，为避免误删已停止操作'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new DemoDatasetConflictError('演示数据所有权 manifest 已损坏，为避免误删已停止操作');
  }
  const manifest = parsed as Partial<DemoDatasetManifest>;
  if (manifest.schema !== 'bailinghub.demo-dataset.v1'
    || (manifest.profile !== 'full-local' && manifest.profile !== 'stateless-readonly')
    || !manifest.resources || typeof manifest.resources !== 'object') {
    throw new DemoDatasetConflictError('演示数据所有权 manifest 格式不受当前 Core 支持');
  }
  for (const [kind, allowed] of Object.entries(RESOURCE_KEYS)) {
    const rows = (manifest.resources as unknown as Record<string, unknown>)[kind];
    const expected = kind === 'chat_entries' && manifest.profile === 'stateless-readonly' ? [] : allowed;
    if (!Array.isArray(rows) || rows.length !== expected.length) {
      throw new DemoDatasetConflictError(`演示数据 manifest 的 ${kind} 清单与 Core 固定允许列表不匹配`);
    }
    const keys = rows.map((row) => row && typeof row === 'object' && !Array.isArray(row)
      ? String((row as Record<string, unknown>)['key'] ?? '')
      : '');
    const fingerprints = rows.map((row) => row && typeof row === 'object' && !Array.isArray(row)
      ? String((row as Record<string, unknown>)['fingerprint'] ?? '')
      : '');
    if (JSON.stringify(keys) !== JSON.stringify(expected) || fingerprints.some((item) => !/^[a-f0-9]{64}$/.test(item))) {
      throw new DemoDatasetConflictError(`演示数据 manifest 的 ${kind} 所有权证据无效`);
    }
  }
  return manifest as DemoDatasetManifest;
}

function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).filter((key) => record[key] !== undefined).sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function fingerprint(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function targetFingerprint(value: TargetDef): string { return fingerprint(value); }
function providerFingerprint(value: ToolProvider): string {
  const { spec_access_probe: _specProbe, authz_probe: _authzProbe, ...stable } = value;
  return fingerprint(stable);
}
function routeFingerprint(value: Route): string { return fingerprint(value); }
function clientFingerprint(value: Client): string {
  const { last_used_at: _lastUsedAt, ...stable } = value;
  return fingerprint(stable);
}
function chatEntryFingerprint(value: ChatEntry): string { return fingerprint(value); }

function integer(value: unknown): number {
  return Math.max(0, Number(value) || 0);
}

function iso(value: string | Date): string {
  return new Date(value).toISOString();
}

function storedJson(value: unknown): { ok: boolean; value: unknown } {
  if (typeof value !== 'string') return { ok: true, value };
  try { return { ok: true, value: JSON.parse(value) as unknown }; }
  catch { return { ok: false, value: null }; }
}

function sourceProviders(tools: unknown): { ok: boolean; values: string[] } {
  const parsedResult = storedJson(tools);
  if (!parsedResult.ok) return { ok: false, values: [] };
  const parsed = parsedResult.value;
  if (parsed === null || parsed === undefined) return { ok: true, values: [] };
  if (typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, values: [] };
  const record = parsed as Record<string, unknown>;
  const sources = Array.isArray(record['sources']) ? record['sources'] : record['source'] ? [record['source']] : [];
  return { ok: true, values: sources.flatMap((source) => {
    if (!source || typeof source !== 'object' || Array.isArray(source)) return [];
    const provider = String((source as Record<string, unknown>)['provider'] ?? '').trim();
    return provider ? [provider] : [];
  }) };
}

function jsonStringArray(value: unknown): { ok: boolean; values: string[] } {
  const parsed = storedJson(value);
  if (!parsed.ok) return { ok: false, values: [] };
  if (parsed.value === null || parsed.value === undefined) return { ok: true, values: [] };
  if (!Array.isArray(parsed.value)) return { ok: false, values: [] };
  return { ok: true, values: parsed.value.map(String) };
}

function audienceClients(value: unknown): { ok: boolean; values: string[] } {
  const parsed = storedJson(value);
  if (!parsed.ok) return { ok: false, values: [] };
  if (parsed.value === null || parsed.value === undefined) return { ok: true, values: [] };
  if (typeof parsed.value !== 'object' || Array.isArray(parsed.value)) return { ok: false, values: [] };
  const clients = (parsed.value as Record<string, unknown>)['clients'];
  if (clients === undefined) return { ok: true, values: [] };
  if (!Array.isArray(clients)) return { ok: false, values: [] };
  return { ok: true, values: clients.map(String) };
}

function definition(config: DemoDatasetConfig, nowIso: string): {
  target: TargetDef;
  provider: ToolProvider;
  route: Route;
  client: Omit<Client, 'token'>;
  chatEntry: ChatEntry | null;
} {
  const parsed = parseOpenApiSpec(JSON.stringify(demoToolSpec(config.profile)));
  if (!parsed.ok) throw new Error(`Core 内置演示工具契约无效：${parsed.error}`);
  const full = config.profile === 'full-local';
  return {
    target: {
      name: DEMO_TARGET,
      kind: 'inhub',
      stateless: true,
      needs_project: false,
      timeout_ms: 30_000,
      enabled: true,
      description: '开源体验用确定性 Agent；不依赖外部 LLM，完整走工具治理出口。',
    },
    provider: {
      name: DEMO_TOOL_PROVIDER,
      base_url: config.businessBaseUrl,
      spec_source: 'inline',
      spec_json: parsed.canonicalJson,
      spec_refreshed_at: nowIso,
      secret: config.toolSecret,
      log_payload: false,
      timeout_ms: 8000,
      rate_limit_per_min: 120,
      auto_refresh_min: 0,
      enabled: true,
      description: full
        ? '本地单组织 demo 业务系统：订单、工单、退款审批与故障观测。'
        : '无状态只读 demo 业务系统：只暴露静态订单查询与故障观测，不保存租户请求。',
    },
    route: {
      route_key: DEMO_ROUTE,
      name: full ? 'Demo 售后助手' : 'Demo 只读订单助手',
      enabled: true,
      target: DEMO_TARGET,
      target_config: {},
      profile: 'demo',
      permission: full ? 'readwrite' : 'readonly',
      session_policy: 'per_key',
      session_key_field: 'visitor_uid',
      tools: {
        sources: [{
          provider: DEMO_TOOL_PROVIDER,
          allow: full
            ? ['demo.order.*', 'demo.ticket.*', 'demo.refund.*', 'demo.failure.*']
            : ['demo.order.*', 'demo.failure.*'],
          subject_field: 'operator_uid',
        }],
        max_calls: full ? 5 : 3,
        ...(full ? { approval: { type: 'business_webhook', url: `${config.businessBaseUrl}/approvals` } } : {}),
      },
      memory: { recent_messages: 8, recent_budget_chars: 6000 },
      retry: { max: 1, backoff_ms: 1000 },
      description: full
        ? '本地开源 demo：用确定性 Agent 展示查询、写工具与审批。'
        : '共享体验环境 demo：仅调用无状态只读工具，不产生业务侧写入或回调。',
    },
    client: {
      app_id: DEMO_CLIENT,
      name: 'Demo 业务系统',
      allowed_routes: [DEMO_ROUTE],
      allowed_channels: [],
      rate_limit_per_min: 60,
      enabled: true,
      description: '中枢内置演示接入方，仅可触发 demo_support。',
    },
    chatEntry: full ? {
      entry_key: DEMO_CHAT_ENTRY,
      name: 'Demo 网页助手',
      route_key: DEMO_ROUTE,
      enabled: false,
      allowed_origins: [],
      rate_limit_per_min: 20,
      ticket_client: DEMO_CLIENT,
      title: '订单助手',
      greeting: '你好，我可以查订单、创建售后工单，高风险退款会先进入审批。',
      color: '#2f7d68',
      appearance: { width: 400, height: 600, position: 'right' },
      description: '本地演示入口：默认停用，请先设置明确 Origin 白名单再启用。',
    } : null,
  };
}

async function markerFor(connection: PoolConnection, lock = false): Promise<DatasetMarkerRow | null> {
  const [rows] = await connection.query<DatasetMarkerRow[]>(
    `SELECT version,manifest_json,imported_at,updated_at FROM bz_demo_datasets WHERE dataset_key=? LIMIT 1${lock ? ' FOR UPDATE' : ''}`,
    [DEMO_DATASET_KEY],
  );
  return rows[0] ?? null;
}

async function countStatus(connection: Pick<PoolConnection, 'query'>): Promise<{ counts: DemoDatasetCounts; empty: boolean }> {
  const [rows] = await connection.query<CountRow[]>(
    `SELECT
      (SELECT COUNT(*) FROM bz_routes) AS routes,
      (SELECT COUNT(*) FROM bz_clients) AS clients,
      (SELECT COUNT(*) FROM bz_tool_providers) AS tool_providers,
      (SELECT COUNT(*) FROM bz_targets) AS targets,
      (SELECT COUNT(*) FROM bz_channels) AS channels,
      (SELECT COUNT(*) FROM bz_chat_entries) AS chat_entries,
      (SELECT COUNT(*) FROM bz_jobs) AS jobs,
      (SELECT COUNT(*) FROM bz_tool_approvals) AS approvals,
      (SELECT COUNT(*) FROM bz_targets WHERE name <> 'llm') AS custom_targets,
      ((SELECT COUNT(*) FROM bz_credentials) +
       (SELECT COUNT(*) FROM bz_projects) +
       (SELECT COUNT(*) FROM bz_kb_bases) +
       (SELECT COUNT(*) FROM bz_storage_buckets) +
       (SELECT COUNT(*) FROM bz_executor_tokens)) AS auxiliary`,
  );
  const row = rows[0]!;
  const counts: DemoDatasetCounts = {
    routes: integer(row.routes),
    clients: integer(row.clients),
    tool_providers: integer(row.tool_providers),
    targets: integer(row.targets),
    channels: integer(row.channels),
    chat_entries: integer(row.chat_entries),
    jobs: integer(row.jobs),
    approvals: integer(row.approvals),
  };
  const empty = counts.routes + counts.clients + counts.tool_providers + counts.channels
    + counts.chat_entries + counts.jobs + counts.approvals + integer(row.custom_targets) + integer(row.auxiliary) === 0;
  return { counts, empty };
}

async function statusFor(
  connection: Pick<PoolConnection, 'query'>,
  available: boolean,
): Promise<DemoDatasetStatus> {
  const [{ counts, empty }, markerRows] = await Promise.all([
    countStatus(connection),
    connection.query<DatasetMarkerRow[]>(
      'SELECT version,manifest_json,imported_at,updated_at FROM bz_demo_datasets WHERE dataset_key=? LIMIT 1',
      [DEMO_DATASET_KEY],
    ),
  ]);
  const marker = markerRows[0][0];
  if (marker) {
    if (Number(marker.version) !== DEMO_DATASET_VERSION) {
      throw new DemoDatasetConflictError(`演示数据版本 ${marker.version} 与当前 Core 版本 ${DEMO_DATASET_VERSION} 不匹配`);
    }
    parseDemoDatasetManifest(marker.manifest_json);
  }
  return {
    available,
    imported: Boolean(marker),
    empty,
    ...(marker ? { imported_at: iso(marker.imported_at) } : {}),
    counts,
  };
}

async function lockReservedSlots(connection: PoolConnection, profile: DemoDatasetProfile): Promise<string[]> {
  const checks: Array<{ label: string; sql: string; key: string }> = [
    { label: `target:${DEMO_TARGET}`, sql: 'SELECT name FROM bz_targets WHERE name=? FOR UPDATE', key: DEMO_TARGET },
    { label: `tool-provider:${DEMO_TOOL_PROVIDER}`, sql: 'SELECT name FROM bz_tool_providers WHERE name=? FOR UPDATE', key: DEMO_TOOL_PROVIDER },
    { label: `route:${DEMO_ROUTE}`, sql: 'SELECT route_key FROM bz_routes WHERE route_key=? FOR UPDATE', key: DEMO_ROUTE },
    { label: `client:${DEMO_CLIENT}`, sql: 'SELECT app_id FROM bz_clients WHERE app_id=? FOR UPDATE', key: DEMO_CLIENT },
    ...(profile === 'full-local' ? [{
      label: `chat-entry:${DEMO_CHAT_ENTRY}`,
      sql: 'SELECT entry_key FROM bz_chat_entries WHERE entry_key=? FOR UPDATE',
      key: DEMO_CHAT_ENTRY,
    }] : []),
  ];
  const occupied: string[] = [];
  for (const item of checks) {
    const [rows] = await connection.query<RowDataPacket[]>(item.sql, [item.key]);
    if (rows.length) occupied.push(item.label);
  }
  return occupied;
}

async function reservedRuntimeConflicts(connection: PoolConnection): Promise<string[]> {
  const conflicts: string[] = [];
  const [sessions] = await connection.query<RowDataPacket[]>(
    'SELECT id FROM bz_sessions WHERE route_key=? LIMIT 1 FOR UPDATE', [DEMO_ROUTE],
  );
  if (sessions.length) conflicts.push(`session-route:${DEMO_ROUTE}`);
  const [threads] = await connection.query<RowDataPacket[]>(
    'SELECT thread_id FROM bz_threads WHERE route_key=? LIMIT 1 FOR UPDATE', [DEMO_ROUTE],
  );
  if (threads.length) conflicts.push(`thread-route:${DEMO_ROUTE}`);
  const [jobs] = await connection.query<RowDataPacket[]>(
    "SELECT job_id FROM bz_jobs WHERE target=? OR client_app_id=? OR JSON_UNQUOTE(JSON_EXTRACT(dispatch,'$.route_key'))=? LIMIT 1 FOR UPDATE",
    [DEMO_TARGET, DEMO_CLIENT, DEMO_ROUTE],
  );
  if (jobs.length) conflicts.push('job-demo-identity');
  const [approvals] = await connection.query<RowDataPacket[]>(
    'SELECT id FROM bz_tool_approvals WHERE provider=? LIMIT 1 FOR UPDATE', [DEMO_TOOL_PROVIDER],
  );
  if (approvals.length) conflicts.push(`tool-approval-provider:${DEMO_TOOL_PROVIDER}`);
  const [ratings] = await connection.query<RowDataPacket[]>(
    'SELECT job_id FROM bz_job_ratings WHERE entry_key=? LIMIT 1 FOR UPDATE', [DEMO_CHAT_ENTRY],
  );
  if (ratings.length) conflicts.push(`job-rating-entry:${DEMO_CHAT_ENTRY}`);
  const [embeddings] = await connection.query<RowDataPacket[]>(
    'SELECT id FROM bz_tool_embeddings WHERE provider=? LIMIT 1 FOR UPDATE', [DEMO_TOOL_PROVIDER],
  );
  if (embeddings.length) conflicts.push(`tool-embedding-provider:${DEMO_TOOL_PROVIDER}`);
  return conflicts;
}

async function reservedConflicts(connection: PoolConnection, profile: DemoDatasetProfile): Promise<string[]> {
  return [
    ...await lockReservedSlots(connection, profile),
    ...await reservedRuntimeConflicts(connection),
  ];
}

async function externalReferences(
  connection: PoolConnection,
  manifest?: DemoDatasetManifest,
  importingProfile?: DemoDatasetProfile,
): Promise<string[]> {
  const conflicts: string[] = [];
  // 清理很少发生；在 SERIALIZABLE 交易中锁住相关配置表的现有行与插入空隙，
  // 避免“检查无引用→并发新建引用→删除”留下断链配置。
  const [routeRows] = await connection.query<Array<RowDataPacket & {
    route_key: string; target: string; tools: unknown; audience: unknown;
  }>>(
    'SELECT route_key,target,tools,audience FROM bz_routes FOR UPDATE',
  );
  for (const row of routeRows) {
    if (manifest && row.route_key === DEMO_ROUTE) continue;
    if (row.target === DEMO_TARGET) conflicts.push(`route:${row.route_key}->target:${DEMO_TARGET}`);
    const providers = sourceProviders(row.tools);
    if (!providers.ok) conflicts.push(`route:${row.route_key}->unreadable-tools`);
    else if (providers.values.includes(DEMO_TOOL_PROVIDER)) conflicts.push(`route:${row.route_key}->tool-provider:${DEMO_TOOL_PROVIDER}`);
    const clients = audienceClients(row.audience);
    if (!clients.ok) conflicts.push(`route:${row.route_key}->unreadable-audience`);
    else if (clients.values.includes(DEMO_CLIENT)) conflicts.push(`route:${row.route_key}->client:${DEMO_CLIENT}`);
  }
  const [chatRows] = await connection.query<Array<RowDataPacket & {
    entry_key: string; route_key: string; ticket_client: string | null;
  }>>(
    'SELECT entry_key,route_key,ticket_client FROM bz_chat_entries FOR UPDATE',
  );
  const ownsChatEntry = Boolean(manifest?.resources.chat_entries.some((item) => item.key === DEMO_CHAT_ENTRY));
  for (const row of chatRows) {
    if (ownsChatEntry && row.entry_key === DEMO_CHAT_ENTRY) continue;
    if (row.route_key === DEMO_ROUTE) conflicts.push(`chat-entry:${row.entry_key}->route:${DEMO_ROUTE}`);
    if (row.ticket_client === DEMO_CLIENT) conflicts.push(`chat-entry:${row.entry_key}->client:${DEMO_CLIENT}`);
  }
  const [pageRows] = await connection.query<Array<RowDataPacket & { id: number; entry_key: string }>>(
    'SELECT id,entry_key FROM bz_page_contexts FOR UPDATE',
  );
  if (ownsChatEntry || (!manifest && importingProfile === 'full-local')) {
    conflicts.push(...pageRows
      .filter((row) => row.entry_key === DEMO_CHAT_ENTRY)
      .map((row) => `page-context:${row.id}->chat-entry:${DEMO_CHAT_ENTRY}`));
  }
  const [channelRows] = await connection.query<Array<RowDataPacket & { name: string; route_key: string }>>(
    'SELECT name,route_key FROM bz_channels FOR UPDATE',
  );
  conflicts.push(...channelRows
    .filter((row) => row.route_key === DEMO_ROUTE)
    .map((row) => `channel:${row.name}->route:${DEMO_ROUTE}`));
  const [clientRows] = await connection.query<Array<RowDataPacket & { app_id: string; allowed_routes: unknown }>>(
    'SELECT app_id,allowed_routes FROM bz_clients FOR UPDATE',
  );
  for (const row of clientRows) {
    if (manifest && row.app_id === DEMO_CLIENT) continue;
    const routes = jsonStringArray(row.allowed_routes);
    if (!routes.ok) conflicts.push(`client:${row.app_id}->unreadable-routes`);
    else if (routes.values.includes(DEMO_ROUTE)) {
      conflicts.push(`client:${row.app_id}->route:${DEMO_ROUTE}`);
    }
  }
  const [executorRows] = await connection.query<Array<RowDataPacket & { name: string; allowed_targets: unknown }>>(
    'SELECT name,allowed_targets FROM bz_executor_tokens FOR UPDATE',
  );
  for (const row of executorRows) {
    const targets = jsonStringArray(row.allowed_targets);
    if (!targets.ok) conflicts.push(`executor-token:${row.name}->unreadable-targets`);
    else if (targets.values.includes(DEMO_TARGET)) conflicts.push(`executor-token:${row.name}->target:${DEMO_TARGET}`);
  }
  return [...new Set(conflicts)];
}

function isDuplicateEntry(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const record = error as Record<string, unknown>;
  return record['code'] === 'ER_DUP_ENTRY' || Number(record['errno']) === 1062;
}

async function writeDefinition(
  connection: PoolConnection,
  config: DemoDatasetConfig,
  nowIso: string,
  insertOnly: boolean,
): Promise<string[]> {
  const item = definition(config, nowIso);
  const targets = new TargetRepository(() => connection);
  const providers = new ToolProviderRepository(() => connection);
  const routes = new RouteRepository(() => connection);
  const clients = new ClientRepository(() => connection);
  const chatEntries = new ChatConfigRepository(() => connection);
  if (config.profile === 'full-local' && config.clientToken && config.clientToken.length < 16) {
    throw new Error('DEMO_CLIENT_TOKEN 至少 16 位');
  }
  if (insertOnly) {
    await targets.create(item.target);
    await providers.create(item.provider);
    await routes.create(item.route);
    await clients.create(item.client, config.profile === 'full-local' ? config.clientToken : undefined);
    if (item.chatEntry) await chatEntries.create(item.chatEntry);
  } else {
    await targets.upsert(item.target);
    await providers.upsert(item.provider);
    await routes.upsert(item.route);
    await clients.upsert(item.client, false);
    if (config.profile === 'full-local' && config.clientToken) {
      await clients.replaceToken(DEMO_CLIENT, config.clientToken);
    }
    if (item.chatEntry) await chatEntries.upsert(item.chatEntry);
  }
  return [
    `target:${DEMO_TARGET}`,
    `tool-provider:${DEMO_TOOL_PROVIDER}`,
    `route:${DEMO_ROUTE}`,
    `client:${DEMO_CLIENT}`,
    ...(item.chatEntry ? [`chat-entry:${DEMO_CHAT_ENTRY}`] : []),
  ];
}

async function currentOwnedResources(connection: PoolConnection): Promise<{
  target: TargetDef | null;
  provider: ToolProvider | null;
  route: Route | null;
  client: Client | null;
  chatEntry: ChatEntry | null;
}> {
  const targets = new TargetRepository(() => connection);
  const providers = new ToolProviderRepository(() => connection);
  const routes = new RouteRepository(() => connection);
  const clients = new ClientRepository(() => connection);
  const chatEntries = new ChatConfigRepository(() => connection);
  const [targetRows, provider, route, client, chatEntry] = await Promise.all([
    targets.list(),
    providers.get(DEMO_TOOL_PROVIDER),
    routes.get(DEMO_ROUTE),
    clients.get(DEMO_CLIENT),
    chatEntries.get(DEMO_CHAT_ENTRY),
  ]);
  return {
    target: targetRows.find((item) => item.name === DEMO_TARGET) ?? null,
    provider,
    route,
    client,
    chatEntry,
  };
}

async function manifestFromCurrent(connection: PoolConnection, profile: DemoDatasetProfile): Promise<DemoDatasetManifest> {
  const current = await currentOwnedResources(connection);
  if (!current.target || !current.provider || !current.route || !current.client
    || (profile === 'full-local' && !current.chatEntry)) {
    throw new Error('Core 演示配置写入后未能完整读回，交易已回滚');
  }
  return {
    schema: 'bailinghub.demo-dataset.v1',
    profile,
    resources: {
      targets: [{ key: DEMO_TARGET, fingerprint: targetFingerprint(current.target) }],
      tool_providers: [{ key: DEMO_TOOL_PROVIDER, fingerprint: providerFingerprint(current.provider) }],
      routes: [{ key: DEMO_ROUTE, fingerprint: routeFingerprint(current.route) }],
      clients: [{ key: DEMO_CLIENT, fingerprint: clientFingerprint(current.client) }],
      chat_entries: profile === 'full-local'
        ? [{ key: DEMO_CHAT_ENTRY, fingerprint: chatEntryFingerprint(current.chatEntry!) }]
        : [],
    },
  };
}

async function verifyOwnedResources(connection: PoolConnection, manifest: DemoDatasetManifest): Promise<void> {
  const current = await currentOwnedResources(connection);
  const checks: Array<{ label: string; current: unknown | null; expected: string; actual(value: any): string }> = [
    { label: `target:${DEMO_TARGET}`, current: current.target, expected: manifest.resources.targets[0]!.fingerprint, actual: targetFingerprint },
    { label: `tool-provider:${DEMO_TOOL_PROVIDER}`, current: current.provider, expected: manifest.resources.tool_providers[0]!.fingerprint, actual: providerFingerprint },
    { label: `route:${DEMO_ROUTE}`, current: current.route, expected: manifest.resources.routes[0]!.fingerprint, actual: routeFingerprint },
    { label: `client:${DEMO_CLIENT}`, current: current.client, expected: manifest.resources.clients[0]!.fingerprint, actual: clientFingerprint },
    ...manifest.resources.chat_entries.map((item) => ({
      label: `chat-entry:${item.key}`,
      current: current.chatEntry,
      expected: item.fingerprint,
      actual: chatEntryFingerprint,
    })),
  ];
  const conflicts = checks.flatMap((item) => item.current && item.actual(item.current) !== item.expected ? [item.label] : []);
  if (conflicts.length) {
    throw new DemoDatasetConflictError(
      `演示资源导入后已被修改或同名重建，Core 不会覆盖或删除这些对象：${conflicts.join(', ')}`,
      conflicts,
    );
  }
}

async function clearDefinition(connection: PoolConnection, manifest: DemoDatasetManifest): Promise<string[]> {
  const chatEntries = new ChatConfigRepository(() => connection);
  const clients = new ClientRepository(() => connection);
  const routes = new RouteRepository(() => connection);
  const providers = new ToolProviderRepository(() => connection);
  const targets = new TargetRepository(() => connection);
  for (const item of manifest.resources.chat_entries) await chatEntries.delete(item.key);
  for (const item of manifest.resources.clients) await clients.delete(item.key);
  for (const item of manifest.resources.routes) await routes.delete(item.key);
  for (const item of manifest.resources.tool_providers) await providers.delete(item.key);
  for (const item of manifest.resources.targets) await targets.delete(item.key);
  return [
    ...manifest.resources.chat_entries.map((item) => `chat-entry:${item.key}`),
    ...manifest.resources.clients.map((item) => `client:${item.key}`),
    ...manifest.resources.routes.map((item) => `route:${item.key}`),
    ...manifest.resources.tool_providers.map((item) => `tool-provider:${item.key}`),
    ...manifest.resources.targets.map((item) => `target:${item.key}`),
  ];
}

export class DemoDatasetService {
  constructor(
    private readonly store: Pick<ConfigStoreContract, 'db'>,
    private readonly config: DemoDatasetConfig | null | undefined,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  async status(): Promise<DemoDatasetStatus> {
    return await statusFor(this.store.db, Boolean(this.config));
  }

  async import(): Promise<DemoDatasetImportResult> {
    if (!this.config) throw new DemoDatasetUnavailableError('当前部署未配置演示业务服务，无法导入演示数据');
    return await this.withLockedTransaction(async (connection) => {
      const marker = await markerFor(connection, true);
      if (marker) {
        if (Number(marker.version) !== DEMO_DATASET_VERSION) {
          throw new DemoDatasetConflictError(`演示数据版本 ${marker.version} 与当前 Core 版本 ${DEMO_DATASET_VERSION} 不匹配`);
        }
        const manifest = parseDemoDatasetManifest(marker.manifest_json);
        if (manifest.profile !== this.config!.profile) {
          throw new DemoDatasetConflictError(
            `已导入的演示 profile 为 ${manifest.profile}，当前配置为 ${this.config!.profile}；请先清理再切换`,
          );
        }
        await lockReservedSlots(connection, manifest.profile);
        await verifyOwnedResources(connection, manifest);
        const references = await externalReferences(connection, manifest);
        if (references.length) {
          throw new DemoDatasetConflictError(
            `演示资源已被其他配置引用，为避免刷新时改变这些依赖已停止导入：${references.join(', ')}`,
            references,
          );
        }
      } else {
        const conflicts = await reservedConflicts(connection, this.config!.profile);
        if (conflicts.length) {
          throw new DemoDatasetConflictError(
            `保留的 demo 资源名已被占用，Core 不会猜测所有权或覆盖已有配置：${conflicts.join(', ')}`,
            conflicts,
          );
        }
        const references = await externalReferences(connection, undefined, this.config!.profile);
        if (references.length) {
          throw new DemoDatasetConflictError(
            `现有配置已引用 Core 保留的 demo 标识，首次导入可能会意外接通这些对象：${references.join(', ')}`,
            references,
          );
        }
      }
      const nowIso = this.now();
      let created: string[];
      try {
        created = await writeDefinition(connection, this.config!, nowIso, !marker);
      } catch (error) {
        if (!marker && isDuplicateEntry(error)) {
          throw new DemoDatasetConflictError(
            '演示资源在首次导入期间被其他操作占用，Core 已回滚且不会覆盖该对象',
            ['reserved-demo-resource'],
          );
        }
        throw error;
      }
      const manifest = await manifestFromCurrent(connection, this.config!.profile);
      const nowSql = dtAt(new Date(nowIso).getTime());
      if (marker) {
        await connection.query(
          'UPDATE bz_demo_datasets SET version=?,manifest_json=?,updated_at=? WHERE dataset_key=?',
          [DEMO_DATASET_VERSION, JSON.stringify(manifest), nowSql, DEMO_DATASET_KEY],
        );
      } else {
        await connection.query(
          'INSERT INTO bz_demo_datasets (dataset_key,version,manifest_json,imported_at,updated_at) VALUES (?,?,?,?,?)',
          [DEMO_DATASET_KEY, DEMO_DATASET_VERSION, JSON.stringify(manifest), nowSql, nowSql],
        );
      }
      return { ok: true, ...await statusFor(connection, true), created };
    });
  }

  async clear(): Promise<DemoDatasetClearResult> {
    return await this.withLockedTransaction(async (connection) => {
      const marker = await markerFor(connection, true);
      if (!marker) return { ok: true, ...await statusFor(connection, Boolean(this.config)), removed: [] };
      if (Number(marker.version) !== DEMO_DATASET_VERSION) {
        throw new DemoDatasetConflictError(`演示数据版本 ${marker.version} 与当前 Core 版本 ${DEMO_DATASET_VERSION} 不匹配`);
      }
      const manifest = parseDemoDatasetManifest(marker.manifest_json);
      await lockReservedSlots(connection, manifest.profile);
      await verifyOwnedResources(connection, manifest);
      const references = await externalReferences(connection, manifest);
      if (references.length) {
        throw new DemoDatasetConflictError(
          `演示资源已被其他配置引用，为避免破坏用户配置已停止清理：${references.join(', ')}`,
          references,
        );
      }
      const removed = await clearDefinition(connection, manifest);
      await connection.query('DELETE FROM bz_demo_datasets WHERE dataset_key=?', [DEMO_DATASET_KEY]);
      return { ok: true, ...await statusFor(connection, Boolean(this.config)), removed };
    });
  }

  private async withLockedTransaction<T>(work: (connection: PoolConnection) => Promise<T>): Promise<T> {
    const connection = await this.store.db.getConnection();
    let locked = false;
    try {
      const [lockRows] = await connection.query<Array<RowDataPacket & { acquired: number }>>(LOCK_SQL);
      locked = Number(lockRows[0]?.acquired) === 1;
      if (!locked) throw new Error('演示数据操作锁获取超时，请稍后重试');
      await connection.query('SET TRANSACTION ISOLATION LEVEL SERIALIZABLE');
      await connection.beginTransaction();
      try {
        const result = await work(connection);
        await connection.commit();
        return result;
      } catch (error) {
        await connection.rollback().catch(() => undefined);
        throw error;
      }
    } finally {
      if (locked) await connection.query(UNLOCK_SQL).catch(() => undefined);
      connection.release();
    }
  }
}
