// 创建/重置后台账号：npm run admin:create -- <username> [password] [role]
// 不传 password 则随机生成并打印。重复执行同 username = 重置密码（role 同时更新）。
// role：admin（全能，默认）/ kb_editor（知识库维护）/ viewer（只读任务）。日常建号优先用后台「账号」板块。
import { randomBytes } from 'node:crypto';
import { loadConfig } from '../src/core/config/config';
import { hashPassword } from '../src/core/platform/password';
import { ConfigStore } from '../src/infrastructure/config/configstore';

const ROLES = ['admin', 'kb_editor', 'viewer'];
const [username, passwordArg, roleArg] = process.argv.slice(2);
if (!username || !/^[a-z0-9][a-z0-9_-]{1,63}$/i.test(username)) {
  console.error('用法：npm run admin:create -- <username> [password] [role]（username 限字母/数字/中划线/下划线）');
  process.exit(1);
}
const role = roleArg ?? 'admin';
if (!ROLES.includes(role)) { console.error(`未知角色: ${role}（可选 ${ROLES.join(' / ')}）`); process.exit(1); }
const password = passwordArg ?? randomBytes(9).toString('base64url');
if (password.length < 8) { console.error('密码至少 8 位'); process.exit(1); }

const cfg = loadConfig();
if (cfg.state.backend !== 'mysql') { console.error('账号体系需要 mysql 后端（config.json state.backend=mysql）'); process.exit(1); }
const store = new ConfigStore(cfg.state.mysql);
await store.init();
await store.admins.upsert(username, await hashPassword(password), username, role);
console.log(`✓ 后台账号已就绪：${username}（角色 ${role}）`);
console.log(`  密码：${password}${passwordArg ? '' : '（随机生成，登录后请在后台「改密」）'}`);
process.exit(0);
