import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { hostname } from 'node:os';
import { assertServerTokenPolicy } from '../platform/server-token';
import { assertMetricsTokenPolicy } from '../platform/metrics-token';

export interface MysqlConfig {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  connectionLimit: number;
}

export interface StateConfig {
  backend: 'jsonl' | 'mysql';
  jsonlPath: string;
  mysql: MysqlConfig;
}

export interface BootstrapAdminConfig {
  username: string;
  password: string;
}

export interface MetricsConfig {
  enabled: boolean;
  token: string;
  scrapeTimeoutMs: number;
}

export interface LlmCredential {
  base_url: string;
  api_key: string;
}

/** 参考执行器配置：出站连到中枢，长轮询认领 targets 声明的任务。仅执行器进程用。 */
export interface ExecutorConfig {
  hubUrl: string;     // 中枢地址
  token: string;      // 与中枢 server.token 一致
  executorId: string; // 执行器标识（控制台「执行器」里显示的身份）
  targets: string[];  // 本执行器能干的 target（须先在控制台「调度目标」注册）
  waitMs: number;     // 单次长轮询挂起时长上限
  concurrency: number; // 本参考执行器本地并发 worker 数；默认 1
  labels: string[];   // 可选自定义标签（上报给中枢，便于在「执行器」页识别这台机器的角色）
}

/** 中枢自监控告警出口：复用送达插座（type=webhook 直发 / 其余类型 X 走注册的 X-notify 执行器）。不配 = 只记审计不外发。 */
export interface AlertsConfig {
  type: string;          // 'webhook' | 自定义渠道 X（由 X-notify 执行器目标承接）
  to?: string;           // 渠道收件人标识
  url?: string;          // type=webhook 时的地址
  cooldown_min: number;  // 同一告警去重冷却
}

export interface AppConfig {
  root: string;
  env: 'development' | 'production';
  server: { host: string; port: number; token: string };
  brand: { name: string }; // 对外产出署名（送达消息落款等），部署方可改
  displayTz: string;        // 展示时区 IANA 名（喂大脑/给人看时把 UTC 转成它），默认 Asia/Shanghai；详见 time.ts
  displayTzLabel: string;   // 展示时区友好名（如「北京时间」），仅用于标注文案；偏移 UTC±N 由 time.ts 动态算
  auditRetentionDays: number; // bz_audit 保留天数；0=不自动删除
  alerts: AlertsConfig | null;
  metrics: MetricsConfig;
  bootstrapAdmin: BootstrapAdminConfig | null;
  concurrency: number;
  killSwitchFile: string;
  claudeBin: string;
  defaultProfile: string;
  brainDir: string;
  state: StateConfig;
  projects: Record<string, string>;
  llmCredentials: Record<string, LlmCredential>; // llm 凭据，按名引用，不落 DB/admin
  executor: ExecutorConfig;                      // Mac 执行器进程用（server 进程忽略）
}

function envName(v: unknown): 'development' | 'production' {
  return String(v ?? '').toLowerCase() === 'production' ? 'production' : 'development';
}

function envJson(name: string): Record<string, any> {
  const raw = process.env[name];
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, any> : {};
  } catch (e) {
    throw new Error(`${name} 必须是 JSON 对象`);
  }
}

function isPlaceholder(v: unknown): boolean {
  const s = String(v ?? '').trim();
  return !s || s === 'REPLACE_ME' || s.includes('REPLACE_ME') || s.startsWith('_example_');
}

function rawSensitive(raw: Record<string, any>, path: string): unknown {
  let cur: any = raw;
  for (const part of path.split('.')) cur = cur?.[part];
  return cur;
}

function assertNoRawSecrets(raw: Record<string, any>, sourceFile: string, paths: string[]): void {
  const bad = paths.filter((p) => !isPlaceholder(rawSensitive(raw, p)));
  if (bad.length) {
    throw new Error(`生产模式禁止在 ${sourceFile} 写入敏感配置：${bad.join(', ')}。请改用环境变量或密钥管理器。`);
  }
}

function requiredEnv(name: string): string {
  const v = String(process.env[name] ?? '').trim();
  if (!v) throw new Error(`生产模式缺少环境变量 ${name}`);
  return v;
}

function booleanEnv(name: string, fallback = false): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(value)) return true;
  if (['0', 'false', 'no', 'off'].includes(value)) return false;
  throw new Error(`${name} 必须是 true/false、1/0、yes/no 或 on/off`);
}

function boundedIntegerEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} 必须是 ${min}~${max} 的整数`);
  }
  return value;
}

function bootstrapAdminFromEnv(env: NodeJS.ProcessEnv): BootstrapAdminConfig | null {
  const username = String(env['BAILING_BOOTSTRAP_ADMIN_USERNAME'] ?? '').trim();
  const password = String(env['BAILING_BOOTSTRAP_ADMIN_PASSWORD'] ?? '');
  const hasUsername = username.length > 0;
  const hasPassword = password.length > 0;
  if (!hasUsername && !hasPassword) return null;
  if (!hasUsername || !hasPassword) {
    throw new Error('BAILING_BOOTSTRAP_ADMIN_USERNAME 与 BAILING_BOOTSTRAP_ADMIN_PASSWORD 必须同时配置');
  }
  if (!/^[a-z0-9][a-z0-9_-]{1,63}$/i.test(username)) {
    throw new Error('BAILING_BOOTSTRAP_ADMIN_USERNAME 仅允许 2~64 位字母、数字、中划线或下划线，且必须以字母或数字开头');
  }
  if (password.length < 8) {
    throw new Error('BAILING_BOOTSTRAP_ADMIN_PASSWORD 至少 8 位');
  }
  return { username, password };
}

/** 加载配置：config.json 优先，缺省回退 config.example.json；环境变量再覆盖。路径相对仓库根目录解析。 */
export function loadConfig(): AppConfig {
  const root = process.cwd();
  const file = existsSync(resolve(root, 'config.json')) ? 'config.json' : 'config.example.json';
  const raw = JSON.parse(readFileSync(resolve(root, file), 'utf8')) as Record<string, any>;
  const env = process.env;
  const runtimeEnv = envName(env['BAILING_ENV']);
  const llmEnv = envJson('BAILING_LLM_CREDENTIALS_JSON');
  const rawAlerts = (raw['alerts'] ?? {}) as Record<string, any>;
  const alertType = env['BAILING_ALERTS_TYPE'] ?? rawAlerts.type;
  const productionRawSecrets = [
    'server.token',
    'state.mysql.host',
    'state.mysql.database',
    'state.mysql.user',
    'state.mysql.password',
    'executor.token',
    'alerts.url',
  ];
  for (const name of Object.keys(raw['llm_credentials'] ?? {})) {
    productionRawSecrets.push(`llm_credentials.${name}.api_key`);
  }
  if (runtimeEnv === 'production' && file === 'config.json') {
    assertNoRawSecrets(raw, file, productionRawSecrets);
  }

  const cfg: AppConfig = {
    root,
    env: runtimeEnv,
    server: {
      host: env['BAILING_HOST'] ?? raw['server']?.host ?? '127.0.0.1',
      port: Number(env['BAILING_PORT'] ?? raw['server']?.port ?? 18900),
      token: String(env['BAILING_TOKEN'] ?? raw['server']?.token ?? '').trim(),
    },
    brand: { name: String(raw['brand']?.name ?? '百灵中枢') },
    displayTz: String(env['BAILING_DISPLAY_TZ'] ?? raw['display_tz'] ?? 'Asia/Shanghai'),
    displayTzLabel: String(env['BAILING_DISPLAY_TZ_LABEL'] ?? raw['display_tz_label'] ?? '北京时间'),
    auditRetentionDays: Math.max(0, Number(env['BAILING_AUDIT_RETENTION_DAYS'] ?? raw['audit_retention_days'] ?? 0) || 0),
    alerts: alertType
      ? {
          type: String(alertType),
          to: env['BAILING_ALERTS_TO'] ? String(env['BAILING_ALERTS_TO']) : rawAlerts.to ? String(rawAlerts.to) : undefined,
          url: env['BAILING_ALERTS_URL'] ? String(env['BAILING_ALERTS_URL']) : rawAlerts.url ? String(rawAlerts.url) : undefined,
          cooldown_min: Number(env['BAILING_ALERTS_COOLDOWN_MIN'] ?? rawAlerts.cooldown_min ?? 60) || 60,
        }
      : null,
    metrics: {
      enabled: booleanEnv('BAILING_METRICS_ENABLED'),
      token: String(env['BAILING_METRICS_TOKEN'] ?? '').trim(),
      scrapeTimeoutMs: boundedIntegerEnv('BAILING_METRICS_SCRAPE_TIMEOUT_MS', 5000, 250, 30_000),
    },
    bootstrapAdmin: bootstrapAdminFromEnv(env),
    concurrency: Number(raw['concurrency'] ?? 2),
    killSwitchFile: resolve(root, raw['killSwitchFile'] ?? '.paused'),
    claudeBin: raw['claudeBin'] ?? 'claude',
    defaultProfile: raw['defaultProfile'] ?? 'readonly',
    brainDir: resolve(root, raw['brainDir'] ?? 'brain'),
    state: {
      backend: (env['BAILING_STATE_BACKEND'] ?? raw['state']?.backend ?? 'jsonl') as 'jsonl' | 'mysql',
      jsonlPath: resolve(root, raw['state']?.jsonlPath ?? 'data/jobs.jsonl'),
      mysql: {
        host: env['BAILING_MYSQL_HOST'] ?? raw['state']?.mysql?.host ?? '',
        port: Number(env['BAILING_MYSQL_PORT'] ?? raw['state']?.mysql?.port ?? 3306),
        database: env['BAILING_MYSQL_DATABASE'] ?? raw['state']?.mysql?.database ?? 'bailing_zhongshu',
        user: env['BAILING_MYSQL_USER'] ?? raw['state']?.mysql?.user ?? '',
        password: env['BAILING_MYSQL_PASSWORD'] ?? raw['state']?.mysql?.password ?? '',
        connectionLimit: Number(env['BAILING_MYSQL_CONNECTION_LIMIT'] ?? raw['state']?.mysql?.connection_limit ?? 15) || 15,
      },
    },
    projects: {},
    llmCredentials: {},
    executor: {
      hubUrl: env['BAILING_HUB_URL'] ?? raw['executor']?.hub_url ?? '',
      token: env['BAILING_EXECUTOR_TOKEN'] ?? raw['executor']?.token ?? raw['server']?.token ?? '',
      executorId: env['BAILING_EXECUTOR_ID'] ?? raw['executor']?.executor_id ?? hostname(),
      targets: Array.isArray(raw['executor']?.targets) ? raw['executor'].targets.map(String) : [],
      waitMs: Number(raw['executor']?.wait_ms ?? 25000),
      concurrency: Math.max(1, Number(env['BAILING_EXECUTOR_CONCURRENCY'] ?? raw['executor']?.concurrency ?? 1) || 1),
      labels: Array.isArray(raw['executor']?.labels) ? raw['executor'].labels.map(String) : [],
    },
  };

  const projects = (raw['projects'] ?? {}) as Record<string, string>;
  for (const name of Object.keys(projects)) {
    if (name.startsWith('_')) continue; // 下划线开头为示例占位
    cfg.projects[name] = resolve(root, String(projects[name]));
  }

  const creds = { ...((raw['llm_credentials'] ?? {}) as Record<string, any>), ...llmEnv };
  for (const name of Object.keys(creds)) {
    if (name.startsWith('_')) continue;
    cfg.llmCredentials[name] = {
      base_url: String(creds[name]?.base_url ?? ''),
      api_key: String(creds[name]?.api_key ?? ''),
    };
  }
  assertServerTokenPolicy({ env: cfg.env, host: cfg.server.host, token: cfg.server.token });
  assertMetricsTokenPolicy({
    enabled: cfg.metrics.enabled,
    token: cfg.metrics.token,
    serverToken: cfg.server.token,
  });
  if (cfg.bootstrapAdmin && cfg.state.backend !== 'mysql') {
    throw new Error('首次管理员初始化需要 mysql 状态后端');
  }
  if (cfg.env === 'production') {
    if (cfg.state.backend === 'mysql') {
      requiredEnv('BAILING_MYSQL_HOST');
      requiredEnv('BAILING_MYSQL_DATABASE');
      requiredEnv('BAILING_MYSQL_USER');
      requiredEnv('BAILING_MYSQL_PASSWORD');
    }
  }
  return cfg;
}
