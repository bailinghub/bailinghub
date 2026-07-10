// 初始化开源体验 demo：目标、工具源、路由、接入方和后台账号。
// 设计目标：docker compose up 后无需真实 LLM key，也能跑通「业务系统暴露工具 → 中枢治理 → AI/agent 调工具 → 审计」闭环。
import { loadConfig } from '../src/core/config/config';
import { ConfigStore } from '../src/infrastructure/config/configstore';
import { hashPassword } from '../src/core/platform/password';
import type { Route, ToolProvider } from '../src/core/contracts/types';
import { parseOpenApiSpec } from '../src/core/contracts/openapi-tools';

const cfg = loadConfig();
if (cfg.state.backend !== 'mysql') {
  console.error('demo seed 需要 mysql 后端');
  process.exit(1);
}

const demoBusinessUrl = String(process.env.DEMO_BUSINESS_URL ?? 'http://127.0.0.1:19080').replace(/\/+$/, '');
const toolSecret = String(process.env.DEMO_TOOL_SECRET ?? 'demo-tool-secret-change-me');
const clientToken = String(process.env.DEMO_CLIENT_TOKEN ?? 'bailing-demo-client-token');
const adminPassword = String(process.env.BAILING_DEMO_ADMIN_PASSWORD ?? 'bailing-demo-admin');

async function fetchTextWithRetry(url: string, attempts = 30): Promise<string> {
  let last = '';
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(3000) });
      if (r.ok) return await r.text();
      last = `HTTP ${r.status}`;
    } catch (e) {
      last = e instanceof Error ? e.message : String(e);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`demo business spec 不可用：${last}`);
}

const specUrl = `${demoBusinessUrl}/.well-known/bailing/tools.json`;
const specText = await fetchTextWithRetry(specUrl);
const parsedSpec = parseOpenApiSpec(specText);
if (!parsedSpec.ok) throw new Error(parsedSpec.error);
const specJson = parsedSpec.canonicalJson;

const store = new ConfigStore(cfg.state.mysql);
await store.init();

await store.targets.upsert({
  name: 'demo-agent',
  kind: 'inhub',
  stateless: true,
  needs_project: false,
  timeout_ms: 30000,
  enabled: true,
  description: '开源体验用确定性 agent：不依赖外部 LLM，完整走工具治理出口。',
});

const provider: ToolProvider = {
  name: 'demo-business',
  base_url: demoBusinessUrl,
  spec_source: 'url',
  spec_url: specUrl,
  spec_json: specJson,
  spec_refreshed_at: new Date().toISOString(),
  secret: toolSecret,
  log_payload: true,
  timeout_ms: 8000,
  rate_limit_per_min: 120,
  auto_refresh_min: 10,
  enabled: true,
  description: 'Docker Compose 内置 demo 业务系统：订单、工单、退款示例工具。',
};
await store.toolProviders.upsert(provider);

const route: Route = {
  route_key: 'demo_support',
  name: 'Demo 售后助手',
  enabled: true,
  target: 'demo-agent',
  target_config: {},
  profile: 'demo',
  permission: 'readonly',
  session_policy: 'per_key',
  session_key_field: 'visitor_uid',
  tools: {
    sources: [{
      provider: 'demo-business',
      allow: ['demo.order.*', 'demo.ticket.*', 'demo.refund.*', 'demo.failure.*'],
      subject_field: 'operator_uid',
    }],
    max_calls: 5,
    approval: { type: 'business_webhook', url: `${demoBusinessUrl}/approvals` },
  },
  memory: { recent_messages: 8, recent_budget_chars: 6000 },
  retry: { max: 1, backoff_ms: 1000 },
  description: '开源体验路由：用 demo-agent 调用 demo 业务工具，展示工具治理闭环。',
};
await store.routes.upsert(route);

await store.clients.upsert({
  app_id: 'demo-app',
  name: 'Demo 业务系统',
  allowed_routes: ['demo_support'],
  allowed_channels: [],
  rate_limit_per_min: 60,
  enabled: true,
  description: 'Docker Compose 内置 demo 接入方。',
}, true);
await store.db.query('UPDATE bz_clients SET token=? WHERE app_id=?', [clientToken, 'demo-app']);

await store.admins.upsert('admin', await hashPassword(adminPassword), 'Admin', 'admin');

console.log('✓ demo 配置已就绪');
console.log(`  Hub: http://localhost:${cfg.server.port}`);
console.log('  Console: http://localhost:18900/console/');
console.log('  Admin: admin');
console.log(`  Admin password: ${adminPassword}`);
console.log('  Demo route: demo_support');
console.log(`  Demo client token: ${clientToken}`);
console.log(`  Demo business tools: ${specUrl}`);
process.exit(0);
