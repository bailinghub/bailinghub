import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';

// Exercise the real operator form over loopback; every API and every persisted service is a fixture.
const root = fileURLToPath(new URL('../', import.meta.url));
const cacheDir = await mkdtemp(join(tmpdir(), 'bailing-context-vite-'));
const server = await createServer({ root, base: '/console/', cacheDir, logLevel: 'error',
  server: { host: '127.0.0.1', port: 0, hmr: false }, optimizeDeps: { force: true } });
let browser;
try {
  await server.listen(0);
  const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(8000);
  const provider = 'fixture-connection', known = 'fixture/flash', pending = 'fixture/slow';
  const unknown = 'fixture/unlisted', failed = 'fixture/offline', alternative = 'fixture/alternate';
  const agreed = 'fixture/shared-window', conflicted = 'fixture/conflicting-windows';
  const reference = 'pricing-fixture', endpoint = 'fixture-price', source = 'https://example.invalid/model-spec';
  const credentials = [{ name: provider, default_model: known }, { name: 'fixture-other', default_model: known }];
  function service(id, model, contextWindowTokens) {
    return { id, label: id, revision: 1, state: 'active', availability: { state: 'ready' }, config: {
      purpose: 'chat', credential: provider, providerScope: provider, model, maxInputBytes: 8388608,
      maxOutputTokens: 32768, timeoutMs: 120000,
      pricing: { source: 'openrouter', kind: 'chat', modelId: reference, endpointId: endpoint },
      ...(contextWindowTokens == null ? {} : { contextWindowTokens }) } };
  }
  const services = [service('conservative', known, 8192), service('legacy-empty', failed), service('slow-route', pending),
    service('unknown-route', unknown), service('alternate-route', alternative), service('overstated', known, 2000000),
    service('same-route-1', agreed, 65536), service('same-route-2', agreed, 65536),
    service('conflicting-1', conflicted, 65536), service('conflicting-2', conflicted, 131072)];
  const checks = [], requests = [], posts = [], unexpected = [], errors = [];
  page.on('pageerror', error => errors.push(error.message));
  let releaseSlow;
  await page.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url()), path = url.pathname;
    if (url.origin !== origin) { unexpected.push(req.url()); return route.abort(); }
    const json = value => route.fulfill({ json: value });
    if (path === '/health' || path === '/branding') return json({});
    if (!path.startsWith('/admin/') && !path.startsWith('/usage/')) return route.continue();
    if (path === '/admin/api/me') return json({ username: 'fixture', role: 'admin', perms: ['*'] });
    if (path === '/admin/api/status') return json({ executors: [] });
    if (path === '/admin/api/demo-dataset/status') return json({ imported: false });
    if (path === '/admin/api/credentials') return json(credentials.map(c => ({ ...c, kind: 'llm' })));
    if (path === '/admin/api/usage/billing/plans') return json({ items: [], billing_ready: true, period_allowance_supported: true });
    if (path === '/admin/api/usage/accounts') return json({ items: [], next_cursor: null });
    if (path === '/admin/api/usage/services') {
      if (req.method() === 'GET') return json({ items: services });
      if (req.method() === 'POST') {
        const body = req.postDataJSON(), index = services.findIndex(item => item.id === body.id);
        assert.equal(body.expected_revision, services[index]?.revision || 0);
        posts.push(body);
        const saved = { ...body, revision: body.expected_revision + 1, availability: { state: 'ready' } };
        if (index < 0) services.push(saved); else services[index] = saved;
        return json(saved);
      }
    }
    if (path === '/admin/api/usage/pricing/models') return json({ items: [{ id: reference, label: reference, kind: 'chat' }], fetchedAt: 1 });
    if (path === '/admin/api/usage/pricing/endpoints') return json({ items: [{ id: endpoint, label: endpoint,
      pricing: { source: 'openrouter', currency: 'USD', modelId: url.searchParams.get('model_id'), endpointId: endpoint,
        fetchedAt: 1, lines: [{ billable: 'prompt', unit: 'token', costUsd: '0.000001' }] } }], fetchedAt: 1 });
    if (path === '/admin/api/usage/model-context' && req.method() === 'GET') {
      const credential = url.searchParams.get('credential'), model = url.searchParams.get('model');
      requests.push({ credential, model });
      if (model === pending) await new Promise(resolve => { releaseSlow = resolve; });
      if (model === failed) return route.fulfill({ status: 503, json: { error: 'synthetic metadata unavailable' } });
      const limit = model === known ? (credential === provider ? 1048576 : 32768) : model === pending ? 131072 : model === alternative ? 65536 : null;
      return json({ context_window_tokens: limit, source_url: limit ? source : null });
    }
    unexpected.push(req.method() + ' ' + path);
    return route.abort();
  });
  const drawer = page.getByRole('dialog').filter({ has: page.getByRole('button', { name: '保存服务', exact: true }) });
  const windowInput = drawer.getByTestId('context-window').locator('input');
  const changeSelect = async (select, option) => {
    await select.click();
    await page.getByRole('option', { name: option }).click();
  };
  const namedSelect = name => drawer.locator('.el-form-item').filter({ has: page.locator('.el-form-item__label').filter({ hasText: name }) }).locator('.el-select');
  const changeModel = model => changeSelect(namedSelect(/^模型标识$/), model);
  const waitValue = async expected => {
    const input = await windowInput.elementHandle();
    await page.waitForFunction(({ el, expected }) => el.value === expected, { el: input, expected: String(expected) });
  };
  const save = () => drawer.getByRole('button', { name: '保存服务', exact: true }).click();
  const edit = async label => {
    await page.locator('.model-card').filter({ has: page.getByRole('heading', { name: label, exact: true }) }).getByRole('button', { name: /配置/ }).click();
    await drawer.waitFor();
  };
  const discard = async () => {
    await drawer.getByRole('button', { name: '取消', exact: true }).click();
    const confirm = page.getByRole('button', { name: '放弃修改', exact: true });
    await Promise.race([confirm.waitFor(), drawer.waitFor({ state: 'hidden' })]);
    if (await confirm.isVisible()) await confirm.click();
    await drawer.waitFor({ state: 'hidden' });
  };
  const responseFor = model => page.waitForResponse(response => {
    const u = new URL(response.url());
    return u.pathname === '/admin/api/usage/model-context' && u.searchParams.get('model') === model;
  });
  await page.goto(origin + '/console/usage?tab=models');
  await page.getByRole('tab', { name: '模型服务', exact: true }).click();
  await page.getByRole('heading', { name: 'conservative', exact: true }).waitFor().catch(async error => {
    throw new Error(`Synthetic console did not load: ${page.url()} ${await page.locator('body').innerText()} ${JSON.stringify({ errors, unexpected })}`, { cause: error });
  });
  await page.getByRole('button', { name: '添加模型服务' }).click();
  const defaultResult = responseFor(known);
  await changeSelect(namedSelect(/^模型凭证$/), provider + ' · ' + known);
  await defaultResult;
  await waitValue(1048576);
  assert.deepEqual(requests.at(-1), { credential: provider, model: known });
  checks.push('credential default selects the deployed model and prefills the total window');
  const previous = requests.length;
  await changeSelect(namedSelect(/^计费模型/), reference);
  assert.equal(await windowInput.inputValue(), '1048576');
  assert.equal(requests.length, previous);
  await windowInput.fill('8192');
  await windowInput.press('Tab');
  assert.equal(await windowInput.inputValue(), '8192');
  await windowInput.fill('');
  await windowInput.press('Tab');
  await waitValue(1048576);
  checks.push('pricing alias is independent; operators can choose a smaller window');
  const delayedResponse = responseFor(pending);
  await changeModel(pending);
  assert.ok(releaseSlow);
  await changeModel(alternative);
  await waitValue(65536);
  releaseSlow();
  await delayedResponse;
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await windowInput.inputValue(), '65536');
  checks.push('a delayed lookup for an old route cannot overwrite the current model');
  await changeModel(known + ' · 凭证默认');
  await waitValue(1048576);
  const secondCredential = responseFor(known);
  await changeSelect(namedSelect(/^模型凭证$/), 'fixture-other · ' + known);
  await secondCredential;
  await waitValue(32768);
  assert.equal(requests.at(-1).credential, 'fixture-other');
  checks.push('changing the credential rereads the limit even when the model identifier is the same');
  await drawer.getByPlaceholder('例如：快速、深度思考').fill('created-from-default');
  await drawer.getByPlaceholder('例如 general-chat').fill('created-from-default');
  await drawer.getByText('模型规格与连接设置', { exact: true }).click();
  await changeSelect(drawer.getByTestId('budget-mode'), '兼容原配置');
  await drawer.getByTestId('budget-max').locator('input').fill('1024');
  await save();
  await drawer.waitFor({ state: 'hidden' });
  assert.equal(posts.at(-1).config.contextWindowTokens, 32768);
  assert.equal(posts.at(-1).config.maxOutputTokens, 1024);
  assert.equal(posts.at(-1).config.model, known);
  assert.equal(posts.at(-1).config.pricing.modelId, reference);
  checks.push('an active new service persists the selected model window and the independent billing alias');
  await edit('conservative');
  await waitValue(8192);
  await drawer.getByPlaceholder('例如：快速、深度思考').fill('conservative-renamed');
  await save();
  await drawer.waitFor({ state: 'hidden' });
  assert.equal(posts.at(-1).config.contextWindowTokens, 8192);
  assert.equal(posts.at(-1).config.maxOutputTokens, 32768);
  checks.push('a lower persisted window and output cap survive ordinary edits');
  await edit('overstated');
  const writes = posts.length;
  await save();
  await drawer.getByRole('alert').filter({ hasText: /上下文窗口/ }).waitFor();
  assert.equal(posts.length, writes);
  await discard();
  checks.push('an existing value above the verified route limit cannot be saved');
  await edit('conservative-renamed');
  const noResult = responseFor(unknown);
  await changeModel(unknown);
  await noResult;
  assert.ok(['', '0'].includes(await windowInput.inputValue()));
  await save();
  await drawer.getByRole('alert').filter({ hasText: /上下文窗口/ }).waitFor();
  assert.equal(posts.length, writes);
  await drawer.locator('.el-switch').filter({ hasText: '服务启用' }).click();
  await save();
  await drawer.waitFor({ state: 'hidden' });
  assert.equal(posts.at(-1).state, 'suspended');
  assert.equal(posts.at(-1).config.contextWindowTokens, undefined);
  checks.push('an unknown replacement needs manual verification to enable and can be saved inactive');
  const unavailable = responseFor(failed);
  await edit('legacy-empty');
  await unavailable;
  await drawer.getByPlaceholder('例如：快速、深度思考').fill('legacy-renamed');
  await save();
  await drawer.waitFor({ state: 'hidden' });
  assert.equal(posts.at(-1).state, 'active');
  assert.equal(posts.at(-1).config.contextWindowTokens, undefined);
  checks.push('existing unregistered services remain editable during a metadata outage');
  await edit('overstated');
  await windowInput.fill('32768');
  await windowInput.press('Tab');
  const beforeInvalidBudget = posts.length;
  await save();
  await drawer.getByRole('alert').filter({ hasText: /默认输出|输出预算/ }).waitFor();
  assert.equal(posts.length, beforeInvalidBudget);
  await windowInput.fill('65536');
  await windowInput.press('Tab');
  await save();
  await drawer.waitFor({ state: 'hidden' });
  assert.equal(posts.at(-1).config.contextWindowTokens, 65536);
  assert.equal(posts.at(-1).config.maxOutputTokens, 32768);
  checks.push('an updated active window leaves room for input without silently changing the output budget');
  await edit('legacy-renamed');
  const agreedResult = responseFor(agreed);
  await changeModel(agreed);
  await agreedResult;
  await waitValue(65536);
  assert.match(await drawer.getByTestId('context-window-status').innerText(), /参考/);
  await windowInput.fill('131072');
  await windowInput.press('Tab');
  await save();
  await drawer.waitFor({ state: 'hidden' });
  assert.equal(posts.at(-1).config.contextWindowTokens, 131072);
  checks.push('matching local registrations supply a suggestion and do not impose a provider ceiling');
  await edit('legacy-renamed');
  const conflictingResult = responseFor(conflicted);
  await changeModel(conflicted);
  await conflictingResult;
  assert.ok(['', '0'].includes(await windowInput.inputValue()));
  await discard();
  checks.push('conflicting local registrations leave the new model window unspecified');
  assert.deepEqual(unexpected, []);
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ok: true, checks, catalogReads: requests.length, fixtureWrites: posts.length,
    realModelOrBusinessCalls: 0 }, null, 2));
} finally {
  await browser?.close();
  await server.close();
  await rm(cacheDir, { recursive: true, force: true });
}
