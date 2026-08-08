// 初始化开源体验 demo。演示数据的定义、事务和所有权规则由 Core service 单一实现，
// CLI 只负责启动时调用，避免与控制台 API 长成两套数据仓储逻辑。
import { loadConfig } from '../src/core/config/config';
import { ConfigStore } from '../src/infrastructure/config/configstore';
import { bootstrapInitialAdmin } from '../src/app/admin-bootstrap';
import { DemoDatasetConflictError, DemoDatasetService } from '../src/services/demo-dataset';

const cfg = loadConfig();
if (cfg.state.backend !== 'mysql') {
  console.error('demo seed 需要 mysql 后端');
  process.exit(1);
}
if (!cfg.demoDataset) {
  console.error('demo seed 需要同时配置 DEMO_BUSINESS_URL 与 DEMO_TOOL_SECRET');
  process.exit(1);
}

const adminPassword = String(process.env.BAILING_DEMO_ADMIN_PASSWORD ?? 'bailing-demo-admin');
const adminConfig = cfg.bootstrapAdmin ?? { username: 'admin', password: adminPassword };
const store = new ConfigStore(cfg.state.mysql);
await store.init();
const adminBootstrap = await bootstrapInitialAdmin(adminConfig, { admins: store.admins });

try {
  const result = await new DemoDatasetService(store, cfg.demoDataset).import();
  console.log('✓ demo 配置已就绪');
  console.log(`  Hub: http://localhost:${cfg.server.port}`);
  console.log('  Console: http://localhost:18900/console/');
  console.log(`  Admin: ${adminBootstrap === 'created' ? adminConfig.username : 'existing account preserved'}`);
  console.log('  Demo route: demo_support');
  console.log(`  Demo business: ${cfg.demoDataset.businessBaseUrl}`);
  console.log(`  Demo profile: ${cfg.demoDataset.profile}`);
  console.log(`  Owned resources: ${result.created.join(', ')}`);
} catch (error) {
  if (!(error instanceof DemoDatasetConflictError)) throw error;
  // 0.3.1 之前的 Docker demo 没有 durable marker。不猜测旧对象所有权，也不让警告阻断 Core 启动。
  console.warn(`! demo 配置未自动导入：${error.message}`);
  console.warn('  请在控制台核对同名对象；Core 未覆盖或删除任何现有配置。');
}

await store.close?.();
