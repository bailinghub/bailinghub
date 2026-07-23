const hub = String(process.env.DEMO_E2E_HUB_URL || process.env.BAILING_SMOKE_URL || 'http://127.0.0.1:18900').replace(/\/+$/, '');
const business = String(process.env.DEMO_E2E_BUSINESS_URL || process.env.DEMO_BUSINESS_URL || 'http://127.0.0.1:19080').replace(/\/+$/, '');
const token = String(process.env.DEMO_CLIENT_TOKEN || 'bailing-demo-client-token');
const routeKey = String(process.env.DEMO_E2E_ROUTE || 'demo_support');
const waitMs = Number(process.env.DEMO_E2E_WAIT_MS || 25_000);

function sleep(ms: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, ms)); }
function uniq(prefix: string): string { return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`; }
const runVisitorUid = uniq('visitor');

async function jsonFetch<T = any>(url: string, init?: RequestInit & { ok?: number[] }): Promise<T> {
  const resp = await fetch(url, init);
  const text = await resp.text();
  const ok = init?.ok ?? [200];
  if (!ok.includes(resp.status)) throw new Error(`${init?.method || 'GET'} ${url} HTTP ${resp.status}: ${text.slice(0, 500)}`);
  return text ? JSON.parse(text) as T : {} as T;
}

async function run(input: string, requestId: string, metadata: Record<string, unknown> = {}): Promise<{ job_id: string; raw: any }> {
  const raw = await jsonFetch<any>(`${hub}/run`, {
    method: 'POST',
    ok: [200, 202],
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({
      request_id: requestId,
      route: routeKey,
      input,
      metadata: { visitor_uid: runVisitorUid, operator_uid: 'demo-user-001', ...metadata },
    }),
  });
  const jobId = String(raw.job_id || raw.id || raw.job?.job_id || '');
  if (!jobId) throw new Error(`/run 未返回 job_id：${JSON.stringify(raw).slice(0, 500)}`);
  return { job_id: jobId, raw };
}

async function getJob(jobId: string): Promise<any> {
  return jsonFetch(`${hub}/jobs/${jobId}?token=${encodeURIComponent(token)}`);
}

async function waitForJob(jobId: string, accept = new Set(['done', 'error', 'rejected'])): Promise<any> {
  const deadline = Date.now() + waitMs;
  let last: any = null;
  while (Date.now() < deadline) {
    last = await getJob(jobId);
    if (accept.has(String(last.status))) return last;
    await sleep(800);
  }
  throw new Error(`job ${jobId} 等待超时，最后状态：${last?.status || 'unknown'}`);
}

async function state(): Promise<any> {
  return jsonFetch(`${business}/api/state`);
}

async function waitFor<T>(label: string, fn: () => Promise<T | null | undefined>): Promise<T> {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const got = await fn();
    if (got) return got;
    await sleep(800);
  }
  throw new Error(`${label} 等待超时`);
}

async function waitForService(label: string, url: string): Promise<void> {
  await waitFor(label, async () => {
    try {
      await jsonFetch(url);
      return true;
    } catch {
      return null;
    }
  });
}

async function decideViaBusiness(approvalId: number, decision: 'approved' | 'denied'): Promise<void> {
  const resp = await fetch(`${business}/api/approvals/${approvalId}/decision`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ decision }),
  });
  if (![200, 303].includes(resp.status)) {
    const text = await resp.text().catch(() => '');
    throw new Error(`demo-business 审批决策失败 HTTP ${resp.status}: ${text.slice(0, 500)}`);
  }
}

async function main(): Promise<void> {
  console.log(`Demo E2E\n  hub=${hub}\n  business=${business}\n`);
  await waitForService('中枢健康检查', `${hub}/health`);
  await waitForService('demo 业务健康检查', `${business}/health`);

  const before = await state();
  const ticketsBefore = Array.isArray(before.tickets) ? before.tickets.length : 0;
  const refundsBefore = Array.isArray(before.refunds) ? before.refunds.length : 0;

  const normalReq = uniq('demo-e2e-normal');
  const normal = await run('帮我查一下订单 SO-1001 的状态，并创建一个售后工单说明需要人工跟进', normalReq);
  const normalJob = await waitForJob(normal.job_id);
  if (normalJob.status !== 'done') throw new Error(`正常工具链路未完成：${normalJob.status}`);
  await waitFor('工单创建', async () => {
    const s = await state();
    return (s.tickets || []).length > ticketsBefore ? s.tickets.at(-1) : null;
  });
  console.log(`  ✓ 查单 + 建工单：${normal.job_id}`);

  const refundReq = uniq('demo-e2e-refund');
  const refund = await run('帮 SO-1001 申请退款 199 元', refundReq);
  await waitForJob(refund.job_id);
  const approval = await waitFor<any>('业务侧审批意图', async () => {
    const s = await state();
    return (s.approvals || []).find((a: any) => a.request_id === refundReq && a.status === 'pending');
  });
  await decideViaBusiness(Number(approval.approval_id), 'approved');
  await waitFor('退款申请落业务系统', async () => {
    const s = await state();
    return (s.refunds || []).length > refundsBefore ? s.refunds.at(-1) : null;
  });
  console.log(`  ✓ 退款审批业务侧批准：approval=${approval.approval_id}`);

  const failure = await run('演示一次业务工具失败排障', uniq('demo-e2e-failure'));
  const failureJob = await waitForJob(failure.job_id);
  if (!['done', 'error'].includes(String(failureJob.status))) throw new Error(`故障演示状态异常：${failureJob.status}`);
  console.log(`  ✓ 故障排障链路：${failure.job_id} status=${failureJob.status}`);

  console.log('\n结果：demo e2e passed');
}

main().catch((e) => {
  console.error(`\nDemo E2E failed: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
