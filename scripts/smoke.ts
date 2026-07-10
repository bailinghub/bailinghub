import { loadConfig } from '../src/core/config/config';
import { runHubSmoke } from '../src/core/runtime/smoke-runtime';

const cfg = loadConfig();
const hub = (process.argv[2] || process.env.BAILING_SMOKE_URL || cfg.executor.hubUrl || `http://127.0.0.1:${cfg.server.port}`).replace(/\/+$/, '');
const adminToken = process.argv[3] || process.env.BAILING_SMOKE_TOKEN || cfg.server.token || '';
const demoToken = process.env.DEMO_CLIENT_TOKEN || '';
const runRoute = process.env.BAILING_SMOKE_RUN_ROUTE || (demoToken ? 'demo_support' : '');
const runToken = process.env.BAILING_SMOKE_RUN_TOKEN || (runRoute === 'demo_support' ? demoToken : '') || adminToken;

console.log(`百灵中枢 smoke → ${hub}\n`);

const report = await runHubSmoke({
  hub,
  adminToken,
  runRoute,
  runToken,
  waitMs: Number(process.env.BAILING_SMOKE_WAIT_MS || 15_000),
});

for (const c of report.checks) {
  if (c.status === 'pass') console.log(`  ✓ ${c.name}`);
  else if (c.status === 'skip') console.log(`  - ${c.name}（跳过：${c.detail || '未满足条件'}）`);
  else console.log(`  ✗ ${c.name}${c.detail ? ' ← ' + c.detail : ''}`);
}

if (report.run?.job_id) {
  console.log(`\n任务：${report.run.job_id} · ${report.run.status || 'unknown'} · route=${report.run.route}`);
}
console.log(`\n结果：通过 ${report.pass} / 跳过 ${report.skip} / 失败 ${report.fail}`);
process.exit(report.fail ? 1 : 0);
