import assert from 'node:assert/strict';

function deferred() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
function gate() { return { started: deferred(), release: deferred(), finished: deferred() }; }
async function gated(route, data, pending) {
  pending.started.resolve(); await pending.release.promise;
  try { await route.fulfill({ json: data }); } finally { pending.finished.resolve(); }
}
async function rendered(page) { await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))); }

/** Request ownership regression: delayed catalogs/results must never cross configuration objects. All writes are intercepted. */
export async function verifyConfigRaces(browser, base, mockApi, fixtures) {
  const context = await browser.newContext();
  await mockApi(context);
  const page = await context.newPage(); page.setDefaultTimeout(8000);
  const errors = [], pending = [];
  page.on('pageerror', error => errors.push(error.message));
  const makeGate = () => { const value = gate(); pending.push(value); return value; };
  let catalogGate, debugGate, retrieveGate, readOnly = false;
  let pageRuleWrites = 0, pageRuleRefreshFails = false;
  const providers = [
    { ...fixtures.providers[0], name: 'race-a', description: '回归工具源 A', embed_credential: 'fixture-embedding' },
    { ...fixtures.providers[0], name: 'race-b', description: '回归工具源 B', embed_credential: 'fixture-embedding' },
  ];
  const tool = name => ({ name: name === 'race-a' ? 'read_a' : 'read_b', scope: name === 'race-a' ? 'scope.a' : 'scope.b', readonly: true, risk: 'low', method: 'GET', path: '/read', parameters: { type: 'object', properties: {} } });
  const routeRow = { ...fixtures.routes[0], tools: { sources: [{ provider: 'race-a', allow: [] }], max_calls: 5 } };
  await context.route('**/admin/api/**', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/admin/api/me' && readOnly) return route.fulfill({ json: { username: 'viewer', role: 'viewer', perms: ['targets:read', 'projects:read', 'credentials:read', 'storage:read', 'routes:read', 'clients:read'] } });
    if (['/admin/api/projects', '/admin/api/targets', '/admin/api/credentials', '/admin/api/storage-buckets', '/admin/api/chat-entries'].includes(url.pathname) && route.request().method() === 'POST') return route.fulfill({ status: 503, json: { error: 'fixture_save_failed' } });
    if (url.pathname === '/admin/api/credentials') return route.fulfill({ json: [{ name: 'fixture-embedding', kind: 'embedding', base_url: 'https://model.example.com/v1', default_model: 'fixture-embedding-model', enabled: true }] });
    if (url.pathname === '/admin/api/projects') return route.fulfill({ json: [{ name: 'fixture-project', path: '/fixture', enabled: true }] });
    if (url.pathname === '/admin/api/storage-buckets') return route.fulfill({ json: [{ name: 'fixture-storage', kind: 'local', enabled: true }] });
    if (url.pathname === '/admin/api/tool-providers') return route.fulfill({ json: providers });
    if (url.pathname === '/admin/api/routes') return route.fulfill({ json: [routeRow] });
    if (url.pathname === '/admin/api/page-contexts') {
      if (route.request().method() === 'POST') { pageRuleWrites++; pageRuleRefreshFails = true; return route.fulfill({ json: { id: 1 } }); }
      return pageRuleRefreshFails ? route.fulfill({ status: 503, json: { error: 'fixture_page_list_failed' } }) : route.fulfill({ json: [] });
    }
    const catalog = url.pathname.match(/^\/admin\/api\/tool-providers\/(race-[ab])\/tools$/);
    if (catalog) {
      const data = { tools: [tool(catalog[1])], skipped: [], warnings: [] };
      if (catalog[1] === 'race-a' && catalogGate) { const current = catalogGate; catalogGate = null; return gated(route, data, current); }
      return route.fulfill({ json: data });
    }
    if (url.pathname.endsWith('/debug-invoke')) return gated(route, { ok: true, request: { marker: 'OLD_B_DEBUG' }, response: { status: 200, text: 'OLD_B_DEBUG', duration_ms: 1 } }, debugGate);
    if (url.pathname.endsWith('/retrieve-test')) return gated(route, { enabled: true, min_score_default: 0.3, hits: [{ name: 'OLD_B_RETRIEVAL', scope: 'scope.b', score: 0.9 }] }, retrieveGate);
    if (url.pathname === '/admin/api/agent-clients/overview') return route.fulfill({ json: { applications: [{ ...fixtures.clients[0], agent_auth_enabled: true, stats: {} }], workspaces: [], setup_workspaces: [{ route: routeRow.route_key, name: routeRow.name, enabled: true, runtime_enabled: true, direct_enabled: true, source_count: 1 }], summary: {} } });
    if (url.pathname.endsWith(`/clients/${fixtures.clients[0].app_id}/agent-setup`)) return route.fulfill({ json: { ...fixtures.clients[0], agent_authorize_url: 'https://business.example.com/agent/authorize', revision: 'fixture' } });
    if (url.pathname.endsWith(`/routes/${routeRow.route_key}/agent-setup`)) return route.fulfill({ json: { route_key: routeRow.route_key, enabled: true, revision: 'fixture', agent_client: { enabled: true }, agent_direct: { enabled: true }, tool_sources: [{ provider: 'race-a', allow: [] }] } });
    return route.fallback();
  });
  try {
    // Route editor: A's old scope response must not overwrite the new provider B.
    await page.goto(`${base}/console/routes`);
    catalogGate = makeGate(); const routeCatalog = catalogGate;
    await page.getByRole('button', { name: '编辑', exact: true }).first().click();
    await routeCatalog.started.promise;
    await page.getByRole('tab', { name: '工具治理', exact: true }).click();
    const source = page.locator('.tool-source-editor').first();
    await source.locator('.el-select__wrapper').first().click();
    await Promise.all([page.waitForResponse(response => response.url().endsWith('/race-b/tools')), page.getByRole('option', { name: 'race-b（回归工具源 B）', exact: true }).click()]);
    routeCatalog.release.resolve(); await routeCatalog.finished.promise; await rendered(page);
    await source.locator('.el-select__wrapper').nth(1).click();
    await page.getByRole('option', { name: 'scope.b（read_b）', exact: true }).waitFor();
    assert.equal(await page.getByRole('option', { name: 'scope.a（read_a）', exact: true }).count(), 0);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '取消', exact: true }).click();
    await page.getByRole('button', { name: '放弃修改', exact: true }).click();

    // A confirmed page-rule save stays successful even if the following list refresh fails.
    await page.goto(`${base}/console/chat`);
    await page.getByRole('button', { name: '更多', exact: true }).first().click();
    await page.getByRole('menuitem', { name: '页面登记', exact: true }).click();
    const pageEditor = page.getByRole('dialog', { name: `页面登记 · ${fixtures.chatEntries[0].name}`, exact: true });
    const pattern = pageEditor.getByRole('textbox').first();
    await pattern.fill('/fixture-saved-page');
    await pageEditor.getByRole('button', { name: '新增规则', exact: true }).click();
    await pageEditor.getByText(/已保存，但页面登记列表刷新失败.*fixture_page_list_failed/).waitFor();
    assert.equal(pageRuleWrites, 1);
    assert.equal(await pattern.inputValue(), '');
    assert.equal(await pageEditor.getByText('输入已保留', { exact: false }).count(), 0);
    assert.equal(await pageEditor.getByText('有未保存修改', { exact: true }).count(), 0);
    await pageEditor.locator('.el-drawer__close-btn').click();
    await pageEditor.waitFor({ state: 'hidden' });

    // Tool preview: closing a loading drawer then opening B invalidates A's request.
    await page.goto(`${base}/console/tools`);
    catalogGate = makeGate(); const previewCatalog = catalogGate;
    const providerRow = name => page.locator('.el-table__row').filter({ hasText: name });
    await providerRow('race-a').getByRole('button', { name: '工具清单', exact: true }).click();
    await previewCatalog.started.promise;
    await page.getByText('正在读取工具清单…', { exact: true }).waitFor();
    await page.locator('.el-drawer__close-btn').filter({ visible: true }).click();
    await providerRow('race-b').getByRole('button', { name: '工具清单', exact: true }).click();
    await page.locator('.el-drawer__title').getByText('工具清单 · race-b', { exact: true }).waitFor();
    await page.locator('.el-drawer .el-table__row').filter({ hasText: 'read_b' }).waitFor();
    previewCatalog.release.resolve(); await previewCatalog.finished.promise; await rendered(page);
    assert.equal(await page.locator('.el-drawer .el-table__row').filter({ hasText: 'read_a' }).count(), 0);

    // Delayed real-call feedback and retrieval cannot appear under a different provider.
    debugGate = makeGate(); retrieveGate = makeGate();
    await page.getByPlaceholder('语义召回预演：输入用户可能问的话').fill('fixture question');
    await page.getByRole('button', { name: '召回预演', exact: true }).click(); await retrieveGate.started.promise;
    await page.getByRole('button', { name: '实调验证', exact: true }).click(); await debugGate.started.promise;
    await page.locator('.el-drawer__close-btn').filter({ visible: true }).click();
    await providerRow('race-a').getByRole('button', { name: '工具清单', exact: true }).click();
    await page.locator('.el-drawer .el-table__row').filter({ hasText: 'read_a' }).waitFor();
    debugGate.release.resolve(); retrieveGate.release.resolve();
    await Promise.all([debugGate.finished.promise, retrieveGate.finished.promise]); await rendered(page);
    assert.equal(await page.getByText('OLD_B_DEBUG', { exact: false }).count(), 0);
    assert.equal(await page.getByText('OLD_B_RETRIEVAL', { exact: false }).count(), 0);
    assert.equal(await page.evaluate(() => localStorage.getItem('bailing.tool-debug.race-a.read_a')), null);
    await page.locator('.el-drawer__close-btn').filter({ visible: true }).click();

    // All configuration drawers share cancellation / unsaved protection, including the older resource pages.
    const drawerCases = [
      ['targets', '注册目标'], ['projects', '新建项目'], ['credentials', '新建凭证'], ['storage', '新建存储'], ['chat', '新建入口'],
    ];
    for (const [path, button] of drawerCases) {
      await page.goto(`${base}/console/${path}`);
      await page.getByRole('button', { name: button, exact: true }).first().click();
      const drawer = page.locator('.el-drawer').filter({ visible: true });
      const input = drawer.getByRole('textbox').first();
      await input.fill(`draft-${path}`);
      await drawer.locator('.el-drawer__close-btn').click();
      await page.getByRole('button', { name: '继续编辑', exact: true }).click();
      assert.equal(await input.inputValue(), `draft-${path}`);
      await drawer.getByRole('button', { name: '取消', exact: true }).click();
      await page.getByRole('button', { name: '放弃修改', exact: true }).click();
      await drawer.waitFor({ state: 'hidden' });
    }
    // Hydration of an embedding credential must not clear its stored default model or make it dirty.
    await page.goto(`${base}/console/credentials`);
    await page.getByRole('button', { name: '编辑', exact: true }).first().click();
    await page.getByRole('tab', { name: '连接与模型', exact: true }).click();
    await page.locator('.el-drawer').filter({ visible: true }).getByText('fixture-embedding-model', { exact: true }).waitFor();
    assert.equal(await page.getByText('有未保存修改', { exact: true }).filter({ visible: true }).count(), 0);
    await page.getByRole('button', { name: '取消', exact: true }).click();
    // A failed save keeps the drawer and draft visible instead of relying on a transient toast.
    await page.goto(`${base}/console/projects`);
    await page.getByRole('button', { name: '新建项目', exact: true }).first().click();
    await page.getByPlaceholder('如 crm-server').fill('failed-project');
    await page.getByPlaceholder('/srv/projects/example').fill('/fixture/project');
    await page.getByRole('button', { name: '保存', exact: true }).click();
    await page.getByText(/未能确认保存成功.*fixture_save_failed/).waitFor();
    assert.equal(await page.getByPlaceholder('如 crm-server').inputValue(), 'failed-project');
    await page.getByRole('button', { name: '取消', exact: true }).click();
    await page.getByRole('button', { name: '放弃修改', exact: true }).click();

    // Agent setup: a source switch releases the old loading state; a late old read cannot alter the new directory.
    await page.goto(`${base}/console/agent-clients?workspace=${routeRow.route_key}`);
    await page.locator('.setup-panel').waitFor();
    await page.locator('.setup-steps button').nth(2).click();
    const agentSource = page.locator('.source-card').first();
    await agentSource.waitFor();
    catalogGate = makeGate(); const agentCatalog = catalogGate;
    await agentSource.getByRole('button', { name: '读取工具目录', exact: true }).click(); await agentCatalog.started.promise;
    await agentSource.locator('.el-select__wrapper').first().click();
    await page.getByRole('option', { name: 'race-b · 回归工具源 B', exact: true }).click();
    await agentSource.getByRole('button', { name: '读取工具目录', exact: true }).click();
    await agentSource.getByText('read_b', { exact: true }).first().waitFor();
    agentCatalog.release.resolve(); await agentCatalog.finished.promise; await rendered(page);
    assert.equal(await agentSource.getByText('read_a', { exact: true }).count(), 0);
    await page.locator('.setup-header').getByRole('button', { name: '关闭', exact: true }).click();
    await page.getByRole('button', { name: '放弃修改', exact: true }).click();
    readOnly = true;
    for (const [path, button] of drawerCases) {
      await page.goto(`${base}/console/${path}`);
      await rendered(page);
      assert.equal(await page.getByRole('button', { name: button, exact: true }).count(), 0);
      assert.equal(await page.getByRole('button', { name: '编辑', exact: true }).count(), 0);
    }
    assert.deepEqual(errors, []);
    console.log('✓ config regression: request ownership, five dirty drawers, credential model hydration, failed saves, confirmed save with failed refresh and read-only controls');
  } finally {
    for (const value of pending) value.release.resolve();
    await context.close();
  }
}
