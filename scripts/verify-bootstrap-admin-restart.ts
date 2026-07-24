// Docker demo CI 专用：验证管理员主动改密后，容器重启不会被 bootstrap 配置覆盖。
// 该脚本会修改管理员密码，只允许在带有一次性测试确认标记的 demo 栈中运行。
import { loadConfig } from '../src/core/config/config';
import { hashPassword, verifyPassword } from '../src/core/platform/password';
import { ConfigStore } from '../src/infrastructure/config/configstore';

const CONFIRMATION = 'disposable-demo-only';
const phase = process.argv[2];

if (phase !== 'prepare' && phase !== 'verify') {
  console.error('用法：tsx scripts/verify-bootstrap-admin-restart.ts <prepare|verify>');
  process.exit(1);
}
if (process.env.BAILING_BOOTSTRAP_CONTRACT_TEST !== CONFIRMATION) {
  console.error(`拒绝运行：必须显式设置 BAILING_BOOTSTRAP_CONTRACT_TEST=${CONFIRMATION}`);
  process.exit(1);
}
if (process.env.BAILING_SEED_DEMO !== '1') {
  console.error('拒绝运行：该验证器只允许用于 BAILING_SEED_DEMO=1 的一次性测试栈');
  process.exit(1);
}

const cfg = loadConfig();
if (cfg.state.backend !== 'mysql' || !cfg.bootstrapAdmin) {
  console.error('拒绝运行：需要 MySQL 后端和完整的首次管理员 bootstrap 配置');
  process.exit(1);
}

const changedPassword = String(process.env.BAILING_BOOTSTRAP_TEST_CHANGED_PASSWORD ?? '');
if (changedPassword.length < 8) {
  console.error('拒绝运行：BAILING_BOOTSTRAP_TEST_CHANGED_PASSWORD 至少 8 位');
  process.exit(1);
}
if (changedPassword === cfg.bootstrapAdmin.password) {
  console.error('拒绝运行：测试新密码不得与 bootstrap 密码相同');
  process.exit(1);
}

const store = new ConfigStore(cfg.state.mysql);
await store.init();

try {
  const admin = await store.admins.get(cfg.bootstrapAdmin.username);
  if (!admin) throw new Error('首次管理员不存在');

  if (phase === 'prepare') {
    if (!(await verifyPassword(cfg.bootstrapAdmin.password, admin.password_hash))) {
      throw new Error('首次启动后 bootstrap 密码未生效');
    }
    await store.admins.upsert(
      cfg.bootstrapAdmin.username,
      await hashPassword(changedPassword),
    );
    console.log('✓ 已模拟管理员主动改密，等待容器重启验证');
  } else {
    if (!(await verifyPassword(changedPassword, admin.password_hash))) {
      throw new Error('容器重启后管理员主动设置的密码未保留');
    }
    if (await verifyPassword(cfg.bootstrapAdmin.password, admin.password_hash)) {
      throw new Error('容器重启错误地恢复了 bootstrap 密码');
    }
    console.log('✓ 容器重启未覆盖已有管理员密码');
  }
} finally {
  await store.db.end();
}
