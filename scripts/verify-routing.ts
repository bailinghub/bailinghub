// 零成本验证：路由的会话一致性逻辑（不调用 Claude）。用法：npx tsx scripts/verify-routing.ts
import { loadConfig } from '../src/core/config/config';
import { ConfigStore } from '../src/infrastructure/config/configstore';

const cfg = loadConfig();
const cs = new ConfigStore(cfg.state.mysql);
await cs.init();

await cs.upsertRoute({
  route_key: '__verify', name: 'verify', enabled: true, project: 'self',
  profile: 'triage-readonly', session_policy: 'per_key', session_key_field: 'ticket_id',
});
const route = await cs.getRoute('__verify');
if (!route) throw new Error('route 未创建');

const a = await cs.resolveSession(route, { ticket_id: 'T-1' });
const b = await cs.resolveSession(route, { ticket_id: 'T-1' });
const c = await cs.resolveSession(route, { ticket_id: 'T-2' });

console.log('T-1 第一次 :', a.sessionId, 'continue=', a.isContinue);
console.log('T-1 第二次 :', b.sessionId, 'continue=', b.isContinue);
console.log('T-2       :', c.sessionId, 'continue=', c.isContinue);
console.log('---');
console.log('同票→同会话 :', a.sessionId === b.sessionId);
console.log('第二次为续聊 :', b.isContinue === true);
console.log('异票→不同会话:', a.sessionId !== c.sessionId);

await cs.deleteRoute('__verify');
process.exit(0);
