import assert from 'node:assert/strict';

const timeout = 8000;
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
function responseGate() {
  return { started: deferred(), released: deferred(), finished: deferred() };
}
async function fulfill(route, json, gate) {
  if (!gate) return route.fulfill({ json });
  gate.started.resolve();
  await gate.released.promise;
  try { await route.fulfill({ json }); }
  finally { gate.finished.resolve(); }
}
async function waitFor(check, message) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  assert.fail(message);
}
async function visible(page, text) {
  await page.getByText(text, { exact: false }).filter({ visible: true }).first().waitFor({ state: 'visible', timeout });
}
async function rendered(page) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
}

/** Isolated fixtures only: no live task controls, business calls or knowledge writes. */
export async function verifyTroubleshootingExtra(browser, base, mockApi, fixtures) {
  const context = await browser.newContext();
  await mockApi(context);
  const page = await context.newPage();
  page.setDefaultTimeout(timeout);
  const errors = [], writes = [], gates = [];
  page.on('pageerror', error => errors.push(error.message));
  const newGate = () => { const gate = responseGate(); gates.push(gate); return gate; };
  const taskA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
  const taskB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2';
  const invocationId = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc3';
  const jobId = fixtures.runs[0].job_id;
  const now = new Date().toISOString();
  const member = { session_id: 'dddddddd-dddd-4ddd-8ddd-ddddddddddd4', client_app_id: 'demo-app', workspace: 'demo_support', client_conversation_id: 'troubleshooting-session', allowed_tools: ['update_demo_record'] };
  const task = id => ({ task_id: id, state: 'active', revision: 1, ledger_sequence: 1, scope_hash: 'fixture-scope', members: [member], policy: { max_write_calls: 3, max_concurrent: 1, expires_at: null }, counters: { write_reserved: 1, write_consumed: 0, active_permits: 1 }, created_at: now, updated_at: now });
  const tasks = [task(taskA), task(taskB)];
  const invocation = { session_id: member.session_id, invocation_id: invocationId, run_id: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeee5', job_id: jobId, tool: 'update_demo_record', readonly: false, budget_state: 'reserved', permit_state: 'unknown', outcome: 'unknown', terminal: false, attempt: 1 };
  let controlGate, taskReadGate, docsGate;
  const kbA = { kb_id: 'kb-a', name: '回归知识库 A', credential: 'embedding-test', model: 'fixture-model', dim: 3, doc_count: 1, chunk_count: 1 };
  const kbB = { ...kbA, kb_id: 'kb-a-extra', name: '回归知识库 B' };
  const document = id => ({ doc_id: id === kbA.kb_id ? 201 : 202, title: id === kbA.kb_id ? 'A 库原文档' : 'B 库原文档', status: 'ready', chunk_count: 1, created_at: now });
  const trace = { job: { ...fixtures.runs[0], target: 'demo-agent', console_execution: { kind: 'agent_tool', rerun: { available: false, reason: 'outcome_unknown' } } }, trace: { summary: {}, events: [] }, approvals: [], messages: [] };
  let channelReadFails = false, ruleReadFails = false;
  const alertRules = [
    { id: 17, description: '孤立告警规则 17', event_prefix: 'executor_offline', channel: 'deleted-channel', recipients: ['operator'], enabled: true, cooldown_min: 10 },
    { id: 117, description: '近似告警规则 117', event_prefix: 'queue_backlog', channel: 'deleted-channel', recipients: ['operator'], enabled: true, cooldown_min: 10 },
  ];
  const comparisonRoutes = [fixtures.routes[0], { ...fixtures.routes[0], route_key: 'extra-second', name: '第二条待比较路由' }, { ...fixtures.routes[0], route_key: `${fixtures.routes[0].route_key}-similar`, name: '近似路由不应进入精确比较' }];

  // Registered after mockApi so these fixtures take precedence and unrelated reads fall back.
  await context.route('**/admin/api/**', async route => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    if (path === '/admin/api/agent-tasks') return route.fulfill({ json: { items: tasks, next_cursor: null } });
    const control = path.match(/^\/admin\/api\/agent-tasks\/([^/]+)\/control$/);
    if (control) {
      assert.equal(route.request().method(), 'POST');
      const body = route.request().postDataJSON();
      writes.push({ taskId: control[1], body });
      const row = tasks.find(item => item.task_id === control[1]);
      const gate = controlGate; controlGate = undefined;
      const result = { ...row, state: body.action === 'pause' ? 'paused' : 'active', revision: row.revision + 1 };
      return fulfill(route, result, gate);
    }
    const detail = path.match(/^\/admin\/api\/agent-tasks\/([^/]+)$/);
    if (detail) {
      const row = tasks.find(item => item.task_id === detail[1]);
      assert.ok(row, `unexpected task detail ${detail[1]}`);
      const gate = detail[1] === taskA ? taskReadGate : undefined;
      if (gate) taskReadGate = undefined;
      return fulfill(route, { task: row, invocations: detail[1] === taskA ? [invocation] : [], next_cursor: null }, gate);
    }
    if (path === `/admin/api/runs/${jobId}/trace` || path === '/admin/api/runs/trace') return route.fulfill({ json: trace });
    if (path === '/admin/api/kb') return route.fulfill({ json: [kbA, kbB] });
    if (path === '/admin/api/routes') return route.fulfill({ json: comparisonRoutes });
    const docs = path.match(/^\/admin\/api\/kb\/([^/]+)\/docs$/);
    if (docs) {
      const gate = docs[1] === kbA.kb_id ? docsGate : undefined;
      if (gate) docsGate = undefined;
      return fulfill(route, [document(docs[1])], gate);
    }
    if (/^\/admin\/api\/kb\/[^/]+\/datasources$/.test(path)) return route.fulfill({ json: [] });
    if (path === '/admin/api/channels') return route.fulfill(channelReadFails ? { status: 503, json: { error: 'fixture_channel_read_failed' } } : { json: [] });
    if (path === '/admin/api/alert-rules') return route.fulfill(ruleReadFails ? { status: 503, json: { error: 'fixture_rule_read_failed' } } : { json: alertRules });
    if (path === '/admin/api/storage-buckets' || path === '/admin/api/executor-tokens') return route.fulfill({ json: [] });
    if (path === '/admin/api/executors') return route.fulfill({ json: [{ executor_id: 'extra-online-worker', online: true, targets: ['extra-target'], last_seen_at: now }] });
    if (path === '/admin/api/dispatch-status') return route.fulfill({ json: { now, summary: { queued: 0, running: 0, dispatched: 0, delayed_queued: 0, expired_leases: 0, blocked_threads: 0 }, by_target: [], leases: [], blocked_threads: [] } });
    return route.fallback();
  });

  const taskDrawer = () => page.getByRole('dialog', { name: '受控任务详情', exact: true });
  const closeTask = async () => {
    await taskDrawer().locator('.el-drawer__close-btn').click();
    await page.waitForURL(url => !url.searchParams.has('task'));
    await taskDrawer().waitFor({ state: 'hidden' });
  };
  const selectTask = async id => {
    await page.locator('.task-control-page .el-table').getByRole('button', { name: `${id.slice(0, 8)}…${id.slice(-4)}`, exact: true }).click();
    await page.waitForURL(url => url.searchParams.get('task') === id);
    await taskDrawer().locator('.task-id').filter({ hasText: id }).waitFor();
  };
  try {
    // Unknown original invocations remain original references through the Job round trip.
    await page.goto(`${base}/console/agent-tasks?task=${taskA}&invocation=${invocationId}`);
    await visible(page, '存在结果未知的原调用');
    await taskDrawer().locator('.el-table__expanded-cell').getByText(invocationId, { exact: true }).waitFor();
    await taskDrawer().getByRole('button', { name: '查看原 Job', exact: true }).click();
    await page.waitForURL(url => url.pathname.endsWith('/runs') && url.searchParams.get('job') === jobId);
    const returnTo = new URL(page.url()).searchParams.get('return_to');
    assert.equal(new URL(returnTo, base).searchParams.get('task'), taskA);
    assert.equal(new URL(returnTo, base).searchParams.get('invocation'), invocationId);
    await visible(page, '原调用结果不明');
    assert.equal(await page.getByRole('button', { name: '重新执行任务', exact: true }).count(), 0);
    await page.locator('.runDetailDrawer').locator('.el-drawer__close-btn').click();
    await page.locator('.runDetailDrawer').waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: '返回来源页面', exact: true }).click();
    await page.waitForURL(url => url.pathname.endsWith('/agent-tasks') && url.searchParams.get('task') === taskA && url.searchParams.get('invocation') === invocationId);
    await taskDrawer().locator('.el-table__expanded-cell').getByText(invocationId, { exact: true }).waitFor();
    assert.equal(writes.length, 0, '查看未知原调用不得执行任务控制');

    // A's delayed control completion must not replace B's verified detail or URL.
    const control = newGate(); controlGate = control;
    await taskDrawer().getByRole('button', { name: '暂停', exact: true }).click();
    await page.locator('.el-message-box').getByRole('button', { name: '确认', exact: true }).click();
    await Promise.race([control.started.promise, waitFor(() => writes.length === 1, '任务控制请求未开始')]);
    await closeTask();
    await selectTask(taskB);
    control.released.resolve();
    await control.finished.promise;
    await waitFor(() => taskDrawer().getByRole('button', { name: '取消任务', exact: true }).isEnabled(), '任务控制结束后按钮未恢复');
    await rendered(page);
    assert.equal(await taskDrawer().locator('.task-id').textContent(), taskB, 'A 的控制完成不得覆盖已选 B');
    assert.equal(new URL(page.url()).searchParams.get('task'), taskB);
    assert.deepEqual(writes.map(item => [item.taskId, item.body.action]), [[taskA, 'pause']]);

    // Closing an in-flight detail read must restore the page refresh control immediately.
    await closeTask();
    const detail = newGate(); taskReadGate = detail;
    await page.locator('.task-control-page .el-table').getByRole('button', { name: `${taskA.slice(0, 8)}…${taskA.slice(-4)}`, exact: true }).click();
    await waitFor(() => Boolean(taskReadGate === undefined), '任务详情读取未开始');
    await closeTask();
    const refresh = page.locator('.task-heading').getByRole('button', { name: '刷新', exact: true });
    await waitFor(() => refresh.isEnabled(), '关闭加载中的详情后刷新仍被 loading 禁用');
    detail.released.resolve();
    await detail.finished.promise;
    await rendered(page);
    assert.equal(await taskDrawer().isVisible(), false, '迟到详情不得重新打开抽屉');
    assert.equal(await refresh.isEnabled(), true);

    // Exact diagnostic focus must not choose the similarly named knowledge base.
    await page.goto(`${base}/console/kb?q=kb-a&focus=kb-a`);
    await visible(page, 'A 库原文档');
    assert.equal(await page.locator('.kb-item').count(), 1);
    assert.equal(await page.locator('.kb-item .kb-name').textContent(), kbA.name);
    assert.equal(await page.getByText('B 库原文档', { exact: true }).count(), 0);
    await page.reload();
    await visible(page, 'A 库原文档');
    assert.equal(await page.locator('.kb-item').count(), 1);
    await page.goto(`${base}/console/kb?q=missing-kb&focus=missing-kb`);
    await visible(page, '未找到知识库「missing-kb」');
    assert.equal(await page.locator('.kb-item').count(), 0);
    assert.equal(await page.locator('.kb-main .el-table').count(), 0, '缺失的精确定位不得显示其他库的文档');

    // A real selection is in the URL and survives reload and browser history.
    await page.goto(`${base}/console/kb?kb=${kbA.kb_id}`);
    await visible(page, 'A 库原文档');
    await page.locator('.kb-item').filter({ hasText: kbB.name }).click();
    await page.waitForURL(url => url.searchParams.get('kb') === kbB.kb_id);
    await visible(page, 'B 库原文档');
    await page.reload();
    await visible(page, 'B 库原文档');
    assert.equal(await page.locator('.kb-item.active .kb-name').textContent(), kbB.name);
    await page.goBack();
    await page.waitForURL(url => url.searchParams.get('kb') === kbA.kb_id);
    await visible(page, 'A 库原文档');

    // Resolve A after B: the selected base, document list and loading state must stay B.
    await page.locator('.kb-item').filter({ hasText: kbB.name }).click();
    await visible(page, 'B 库原文档');
    const slowDocs = newGate(); docsGate = slowDocs;
    await page.locator('.kb-item').filter({ hasText: kbA.name }).click();
    await waitFor(() => docsGate === undefined, 'A 库文档读取未开始');
    await page.locator('.kb-item').filter({ hasText: kbB.name }).click();
    await visible(page, 'B 库原文档');
    slowDocs.released.resolve();
    await slowDocs.finished.promise;
    await rendered(page);
    assert.equal(await page.locator('.kb-item.active .kb-name').textContent(), kbB.name);
    assert.equal(await page.getByText('A 库原文档', { exact: true }).count(), 0, 'A 的迟到文档不得覆盖 B');
    assert.equal(await page.getByText('B 库原文档', { exact: true }).count(), 1);
    // Element Plus leaves opacity-transition masks mounted for 0.3s after loading=false.
    // Playwright's :visible includes opacity:0, so wait for actual removal instead of sampling a frame.
    await waitFor(async () => await page.locator('.kb-main .block').first().locator('.el-loading-mask:visible').count() === 0, 'B 库文档加载遮罩未退出');

    // Existing orphan rules remain inspectable even when the channel list is truly empty.
    await page.goto(`${base}/console/channels?alert_q=17&alert_focus=17#alert-rules`);
    const rulePanel = page.locator('#alert-rules');
    await visible(page, '孤立告警规则 17');
    assert.equal(await rulePanel.locator('.el-table__row').count(), 1, '告警规则精确定位不得包含 117');
    assert.equal(await page.getByText('近似告警规则 117', { exact: true }).count(), 0);
    assert.equal(await rulePanel.getByText('还没有告警规则：建一条把运行告警推给自己', { exact: true }).count(), 0);
    await page.reload();
    await visible(page, '孤立告警规则 17');

    // A failed rules read is not an empty rules list, and retry recovers the exact target.
    ruleReadFails = true;
    await page.reload();
    await rulePanel.locator('.el-alert--error').waitFor();
    assert.equal(await rulePanel.getByText('还没有告警规则：建一条把运行告警推给自己', { exact: true }).count(), 0);
    ruleReadFails = false;
    await rulePanel.getByRole('button', { name: '重试读取告警规则', exact: true }).click();
    await visible(page, '孤立告警规则 17');
    assert.equal(await rulePanel.locator('.el-table__row').count(), 1);

    // Channel failure must not hide successfully read orphan rules or claim no channels exist.
    channelReadFails = true;
    await page.reload();
    await visible(page, '孤立告警规则 17');
    await page.locator('.el-card').filter({ has: page.getByText('入站渠道', { exact: true }) }).first().locator('.el-alert--error').waitFor();
    assert.equal(await page.getByText('还没有渠道：把外部消息平台接进来从这里开始', { exact: true }).count(), 0);
    channelReadFails = false;

    // Known online workers filtered to offline are "no matches", never "no workers online".
    await page.goto(`${base}/console/executors?state=offline#executor-instances`);
    const instances = page.locator('#executor-instances');
    await instances.getByText('没有匹配的执行器', { exact: false }).waitFor();
    assert.equal(await instances.getByText('还没有执行器在线。', { exact: false }).count(), 0);
    assert.equal(await instances.locator('.el-table__row').count(), 0);
    await instances.getByRole('button', { name: '清除全部筛选', exact: true }).click();
    await page.waitForURL(url => !url.searchParams.has('state'));
    await instances.getByText('extra-online-worker', { exact: true }).waitFor();
    await instances.getByRole('textbox', { name: '搜索执行器 / 目标', exact: true }).fill('not-this-worker');
    await page.waitForURL(url => url.searchParams.get('instance_q') === 'not-this-worker');
    await page.reload();
    await instances.getByText('没有匹配的执行器', { exact: false }).waitFor();
    assert.equal(await instances.getByText('还没有执行器在线。', { exact: false }).count(), 0);
    assert.equal(await instances.locator('.el-table__row').count(), 0);

    // A route-auto ambiguity deep link must show exactly the two compared keys.
    await page.goto(`${base}/console/routes?focus=${encodeURIComponent(fixtures.routes[0].route_key)}&related=extra-second`);
    await visible(page, '第二条待比较路由');
    assert.equal(await page.locator('.el-table__body .el-table__row').count(), 2);
    assert.equal(await page.getByText('近似路由不应进入精确比较', { exact: true }).count(), 0);
    await page.reload();
    await visible(page, '第二条待比较路由');
    assert.equal(await page.locator('.el-table__body .el-table__row').count(), 2);
    assert.deepEqual(errors, []);
    console.log('✓ troubleshooting extra: task races, KB focus/history/late reads, orphan rule errors and truthful executor filters passed');
  } finally {
    for (const gate of gates) gate.released.resolve();
    await context.close();
  }
}
