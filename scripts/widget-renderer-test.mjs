import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { chromium } from 'playwright';

const widgetSource = await readFile(new URL('../web/widget/widget.js', import.meta.url), 'utf8');

const validPayload = {
  kind: 'bar',
  data: [{ label: '已完成', value: 12 }],
};
const formPayload = {
  version: 1,
  form_id: 'refund_info',
  title: '请补充退款信息',
  description: '这些内容会作为下一轮用户消息提交。',
  schema: {
    customer: { type: 'text', label: '联系人', required: true, minLength: 2, maxLength: 20, placeholder: '请输入姓名' },
    reason: { type: 'textarea', label: '退款原因', required: true, maxLength: 200 },
    amount: { type: 'number', label: '退款金额', required: true, min: 0, max: 1000 },
    apply_date: { type: 'date', label: '申请日期', required: true, min: '2026-01-01', max: '2026-12-31' },
    confirmed: { type: 'boolean', label: '已确认信息', required: true },
    method: { type: 'single_select', label: '退款方式', required: true, options: [{ label: '原路退回', value: 'original' }, { label: '余额', value: 'balance' }] },
    tags: { type: 'multi_select', label: '需求标记', required: true, options: [{ label: '加急', value: 'urgent' }, { label: '回访', value: 'callback' }] },
    note: { type: 'text', label: '备注 <img src=x onerror="window.__formInjected=1">', maxLength: 80 },
  },
  submit_label: '提交信息',
};
const cancelFormPayload = {
  version: 1,
  form_id: 'cancel_form',
  title: '可取消的表单',
  schema: { note: { type: 'text', label: '备注', maxLength: 40 } },
  cancel_label: '暂不填写',
};
const invalidFormPayload = {
  version: 1,
  form_id: 'unsafe_remote',
  title: '不应渲染',
  schema: { source: { type: 'remote_select', label: '远程数据', endpoint: 'https://evil.example/data' } },
};
const strictInvalidPayloads = [
  { ...cancelFormPayload, form_id: 'extra_top', unexpected: true },
  { version: 1, form_id: 'required_string', title: '非法 required', schema: { value: { type: 'text', label: '值', required: 'true' } } },
  { version: 1, form_id: 'text_over_cap', title: '超限文本', schema: { value: { type: 'text', label: '值', maxLength: 501 } } },
  { version: 1, form_id: 'number_string', title: '非法数字边界', schema: { value: { type: 'number', label: '值', min: '0' } } },
  { version: 1, form_id: 'bad_date', title: '非法日期边界', schema: { value: { type: 'date', label: '日期', min: '2026-02-30' } } },
  { version: 1, form_id: 'sensitive_copy', title: '补充信息', description: '请输入 API Key', schema: { value: { type: 'text', label: '值' } } },
  { version: 1, form_id: 'option_extra', title: '非法选项', schema: { value: { type: 'single_select', label: '值', options: [{ label: 'A', value: 'a', endpoint: 'https://evil.example' }] } } },
  { version: 1, form_id: 'control_copy', title: '含\n换行', schema: { value: { type: 'text', label: '值' } } },
];
const formBlock = (payload) => `\`\`\`bailing-form\n${JSON.stringify(payload)}\n\`\`\``;
const history = [
  { r: 'a', t: `\`\`\`bailing-chart\n${JSON.stringify(validPayload)}\n\`\`\`` },
  { r: 'a', t: '```unknown-chart\n{"value":1}\n```' },
  { r: 'a', t: '```bailing-chart\n{"broken":\n```' },
  { r: 'a', t: '```bailing-chart\n"scalar"\n```' },
  { r: 'a', t: formBlock(formPayload), j: 'source-form-1' },
  { r: 'a', t: formBlock(cancelFormPayload), j: 'source-form-2' },
  { r: 'a', t: formBlock(invalidFormPayload), j: 'source-form-invalid' },
  ...strictInvalidPayloads.map((payload, index) => ({ r: 'a', t: formBlock(payload), j: `source-form-strict-invalid-${index}` })),
  { r: 'a', t: formBlock(cancelFormPayload) },
];

const submissions = [];
const submissionWaiters = [];
function recordSubmission(body) {
  const waiter = submissionWaiters.shift();
  if (waiter) waiter(body);
  else submissions.push(body);
}
function nextSubmission() {
  if (submissions.length) return Promise.resolve(submissions.shift());
  return new Promise((resolve) => { submissionWaiters.push(resolve); });
}
let serverMessages = [];
let cancelAttempts = 0;
let jobSeq = 0;

const server = createServer((req, res) => {
  if (req.url === '/widget.js') {
    res.writeHead(200, { 'content-type': 'text/javascript; charset=utf-8' });
    res.end(widgetSource);
    return;
  }
  if (req.url === '/chat/pub_test/config') {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ enabled: true, title: 'Renderer Test', greeting: '', powered_by_visible: false }));
    return;
  }
  if (req.url?.startsWith('/chat/pub_test/thread')) {
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ messages: serverMessages }));
    return;
  }
  if (req.url?.startsWith('/chat/pub_test/events/job-refund_info-')) {
    const jobId = req.url.split('/events/')[1].split('?')[0];
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
    });
    setTimeout(() => {
      res.write(`event: done\ndata: ${JSON.stringify({ done: true, job_id: jobId, reply: 'ok:refund_info' })}\n\n`);
      res.end();
    }, 500);
    return;
  }
  if (req.url === '/chat/pub_test' && req.method === 'POST') {
    const chunks = [];
    req.on('data', (chunk) => { chunks.push(chunk); });
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      recordSubmission(body);
      if (body.interaction_response?.form_id === 'cancel_form' && cancelAttempts++ === 0) {
        res.writeHead(503, { 'content-type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: '模拟提交失败' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      const suffix = body.interaction_response?.form_id || 'message';
      const jobId = `job-${suffix}-${++jobSeq}`;
      res.end(JSON.stringify({ done: suffix !== 'refund_info', job_id: jobId, visitor_id: 'visitor-12345678', ...(suffix === 'refund_info' ? {} : { reply: `ok:${suffix}` }) }));
    });
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end('<!doctype html><html><body><script src="/widget.js" data-entry="pub_test" data-open="1"></script></body></html>');
});

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(0, '127.0.0.1', resolve);
});

const address = server.address();
if (!address || typeof address === 'string') throw new Error('test server did not bind to a TCP port');

const bundledExecutable = chromium.executablePath();
const systemExecutables = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];
const executablePath = existsSync(bundledExecutable)
  ? bundledExecutable
  : systemExecutables.find((candidate) => existsSync(candidate));
const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
try {
  const page = await browser.newPage();
  await page.addInitScript(({ seededHistory }) => {
    window.__rendererMounts = 0;
    window.__rendererDestroys = 0;
    window.BailingChat = {
      renderers: [{
        type: 'bailing-chart',
        label: 'Test chart',
        contentType: 'application/json',
        mount(context) {
          const { container, payload, signal, theme, message, respond } = context;
          window.__rendererMounts += 1;
          window.__rendererContextKeys = Object.keys(context).sort();
          window.__rendererContextFrozen = Object.isFrozen(context) && Object.isFrozen(theme) && Object.isFrozen(message) && Object.isFrozen(message.responses);
          window.__rendererHasRespond = typeof respond === 'function';
          container.textContent = `${payload.kind}:${payload.data[0].value}`;
          const onAbort = () => { container.dataset.aborted = '1'; };
          signal.addEventListener('abort', onAbort, { once: true });
          return () => {
            signal.removeEventListener('abort', onAbort);
            window.__rendererDestroys += 1;
          };
        },
      }],
    };
    if (!sessionStorage.getItem('renderer_test_seeded')) {
      localStorage.setItem('bailing_chat_pub_test', JSON.stringify(seededHistory));
      sessionStorage.setItem('renderer_test_seeded', '1');
    }
  }, { seededHistory: history });

  await page.goto(`http://127.0.0.1:${address.port}/`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.__rendererMounts - window.__rendererDestroys === 1);
  await page.locator('.rich-renderer[data-renderer="bailing-form"][data-form-id="refund_info"] .bailing-form').waitFor();

  const result = await page.evaluate(() => {
    const host = Array.from(document.body.children).find((node) => node.shadowRoot);
    const root = host?.shadowRoot;
    const active = root?.querySelector('.rich-renderer[data-renderer="bailing-chart"]');
    const fallbacks = Array.from(root?.querySelectorAll('pre code') || []).map((code) => ({
      language: code.dataset.language || '',
      text: code.textContent || '',
    }));
    return {
      rendererApiVersion: window.BailingChat.rendererApiVersion,
      activeCount: root?.querySelectorAll('.rich-renderer').length || 0,
      activeText: active?.textContent || '',
      mounts: window.__rendererMounts,
      destroys: window.__rendererDestroys,
      contextKeys: window.__rendererContextKeys,
      contextFrozen: window.__rendererContextFrozen,
      hasRespond: window.__rendererHasRespond,
      richMessageCount: root?.querySelectorAll('.m.rich').length || 0,
      formCount: root?.querySelectorAll('.rich-renderer[data-renderer="bailing-form"] .bailing-form').length || 0,
      formImageCount: root?.querySelectorAll('.rich-renderer[data-form-id="refund_info"] img').length || 0,
      formInjected: window.__formInjected || 0,
      dateMin: root?.querySelector('[data-form-id="refund_info"] input[name="apply_date"]')?.min || '',
      dateMax: root?.querySelector('[data-form-id="refund_info"] input[name="apply_date"]')?.max || '',
      booleanRequired: root?.querySelector('[data-form-id="refund_info"] input[name="confirmed"]')?.required,
      panelWidth: root?.querySelector('.panel')?.getBoundingClientRect().width || 0,
      fallbacks,
      bailingFormFallbackCount: fallbacks.filter((item) => item.language === 'bailing-form').length,
    };
  });

  assert.equal(result.rendererApiVersion, '1');
  assert.equal(result.activeCount, 3);
  assert.equal(result.activeText, 'bar:12');
  assert.equal(result.mounts - result.destroys, 1);
  assert.deepEqual(result.contextKeys, ['container', 'message', 'payload', 'respond', 'signal', 'source', 'theme', 'type', 'version']);
  assert.equal(result.contextFrozen, true);
  assert.equal(result.hasRespond, true);
  assert.ok(result.richMessageCount >= 3);
  assert.equal(result.formCount, 2);
  assert.equal(result.formImageCount, 0);
  assert.equal(result.formInjected, 0);
  assert.equal(result.dateMin, '2026-01-01');
  assert.equal(result.dateMax, '2026-12-31');
  assert.equal(result.booleanRequired, false, 'required boolean must still allow submitting false');
  assert.ok(result.panelWidth >= 640, `expected rich content to widen the panel, got ${result.panelWidth}`);
  assert.ok(result.fallbacks.some((item) => item.language === 'unknown-chart' && item.text.includes('{"value":1}')));
  assert.ok(result.fallbacks.some((item) => item.language === 'bailing-chart' && item.text.includes('{"broken":')));
  assert.ok(result.fallbacks.some((item) => item.language === 'bailing-chart' && item.text === '"scalar"'));
  assert.ok(result.fallbacks.some((item) => item.language === 'bailing-form' && item.text.includes('remote_select')));
  assert.equal(result.bailingFormFallbackCount, 2 + strictInvalidPayloads.length, 'invalid and source-less forms must stay inert code blocks');

  await page.locator('.maximize').click();
  const maximized = await page.evaluate(() => {
    const host = Array.from(document.body.children).find((node) => node.shadowRoot);
    const root = host?.shadowRoot;
    return {
      pressed: root?.querySelector('.maximize')?.getAttribute('aria-pressed'),
      width: root?.querySelector('.panel')?.getBoundingClientRect().width || 0,
    };
  });
  assert.equal(maximized.pressed, 'true');
  assert.ok(maximized.width >= 1200, `expected maximized panel width, got ${maximized.width}`);
  await page.locator('.maximize').click();

  const minimizeControl = await page.evaluate(() => {
    const host = Array.from(document.body.children).find((node) => node.shadowRoot);
    const root = host?.shadowRoot;
    const control = root?.querySelector('.minimize');
    return {
      exists: Boolean(control),
      ariaLabel: control?.getAttribute('aria-label'),
      title: control?.getAttribute('title'),
      hasSvg: Boolean(control?.querySelector('svg')),
      legacyCloseExists: Boolean(root?.querySelector('.close')),
    };
  });
  assert.deepEqual(minimizeControl, {
    exists: true,
    ariaLabel: '最小化',
    title: '最小化',
    hasSvg: true,
    legacyCloseExists: false,
  });
  await page.locator('.minimize').click();
  assert.equal(await page.locator('.panel').evaluate((panel) => panel.classList.contains('open')), false);
  await page.locator('.bubble').click();
  assert.equal(await page.locator('.panel').evaluate((panel) => panel.classList.contains('open')), true);

  const refundForm = page.locator('.rich-renderer[data-form-id="refund_info"]');
  await refundForm.locator('input[name="customer"]').fill('张三');
  await refundForm.locator('textarea[name="reason"]').fill('商品与描述不符');
  await refundForm.locator('input[name="amount"]').fill('88.5');
  await refundForm.locator('input[name="apply_date"]').fill('2026-08-24');
  // required boolean 是 yes/no 数据而非强制同意；故意保持 false 也应可提交。
  await refundForm.locator('select[name="method"]').selectOption('original');
  await refundForm.locator('input[name="tags"][value="urgent"]').check();
  await refundForm.locator('button.primary').click();
  const formSubmitted = await nextSubmission();
  assert.equal(formSubmitted.message, undefined);
  assert.deepEqual(formSubmitted.client_capabilities, { renderers: ['bailing-form', 'bailing-chart'] });
  assert.deepEqual({ ...formSubmitted.interaction_response, submission_id: '<dynamic>' }, {
    type: 'bailing-form',
    version: 1,
    source_job_id: 'source-form-1',
    form_id: 'refund_info',
    submission_id: '<dynamic>',
    action: 'submit',
    values: {
      customer: '张三',
      reason: '商品与描述不符',
      amount: 88.5,
      apply_date: '2026-08-24',
      confirmed: false,
      method: 'original',
      tags: ['urgent'],
    },
  });
  assert.match(formSubmitted.interaction_response.submission_id, /^[a-zA-Z0-9_-]{8,64}$/);
  await refundForm.locator('.bf-status.receipt').waitFor();
  const acknowledgedBeforeDone = await page.evaluate(() => {
    const host = Array.from(document.body.children).find((node) => node.shadowRoot);
    const root = host?.shadowRoot;
    return {
      sendDisabled: root?.querySelector('.send')?.disabled,
      hasFinalReply: Array.from(root?.querySelectorAll('.m.a') || []).some((node) => node.textContent?.includes('ok:refund_info')),
    };
  });
  assert.equal(acknowledgedBeforeDone.sendDisabled, true, 'global send stays pending while the next answer streams');
  assert.equal(acknowledgedBeforeDone.hasFinalReply, false, 'form receipt must not wait for the delayed SSE answer');
  await page.waitForFunction(() => {
    const host = Array.from(document.body.children).find((node) => node.shadowRoot);
    return host?.shadowRoot?.querySelector('.send')?.disabled === false;
  });

  const cancelForm = page.locator('.rich-renderer[data-form-id="cancel_form"]');
  await cancelForm.getByRole('button', { name: '暂不填写' }).click();
  const rejectedCancel = await nextSubmission();
  assert.equal(rejectedCancel.interaction_response.action, 'cancel');
  assert.deepEqual(rejectedCancel.interaction_response.values, {});
  await cancelForm.locator('.bf-status.error').waitFor();
  assert.equal(await cancelForm.getByRole('button', { name: '暂不填写' }).isEnabled(), true, 'HTTP rejection must re-enable form controls');
  await cancelForm.getByRole('button', { name: '暂不填写' }).click();
  const acceptedCancel = await nextSubmission();
  assert.equal(acceptedCancel.interaction_response.submission_id, rejectedCancel.interaction_response.submission_id, 'retry keeps one idempotency key');
  assert.equal(acceptedCancel.interaction_response.source_job_id, 'source-form-2');
  await cancelForm.locator('.bf-status.receipt').waitFor();
  await page.waitForFunction(() => {
    const host = Array.from(document.body.children).find((node) => node.shadowRoot);
    return host?.shadowRoot?.querySelector('.send')?.disabled === false;
  });

  await page.locator('.foot textarea').fill('请分析这组数据');
  await page.locator('.send').click();
  const submitted = await nextSubmission();
  assert.equal(submitted.message, '请分析这组数据');
  assert.deepEqual(submitted.client_capabilities, { renderers: ['bailing-form', 'bailing-chart'] });
  await page.waitForFunction(() => {
    const host = Array.from(document.body.children).find((node) => node.shadowRoot);
    return host?.shadowRoot?.querySelector('.send')?.disabled === false;
  });

  const localInteractions = await page.evaluate(() => JSON.parse(localStorage.getItem('bailing_chat_pub_test') || '[]').filter((item) => item.i).map((item) => item.i));
  assert.equal(localInteractions.length, 2);
  assert.deepEqual(localInteractions.map((item) => item.form_id).sort(), ['cancel_form', 'refund_info']);
  assert.ok(localInteractions.every((item) => !Object.hasOwn(item, 'values')), 'local interaction metadata must not duplicate submitted values');
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForFunction(() => {
    const host = Array.from(document.body.children).find((node) => node.shadowRoot);
    return host?.shadowRoot?.querySelectorAll('.bailing-form .bf-status.receipt').length === 2;
  });

  await page.evaluate(() => {
    const host = Array.from(document.body.children).find((node) => node.shadowRoot);
    host?.shadowRoot?.querySelector('.restart')?.click();
  });
  await page.waitForFunction(() => window.__rendererMounts === window.__rendererDestroys);

  const afterRestart = await page.evaluate(() => {
    const host = Array.from(document.body.children).find((node) => node.shadowRoot);
    return {
      activeCount: host?.shadowRoot?.querySelectorAll('.rich-renderer').length || 0,
      mounts: window.__rendererMounts,
      destroys: window.__rendererDestroys,
    };
  });
  assert.equal(afterRestart.activeCount, 0);
  assert.equal(afterRestart.mounts, afterRestart.destroys);

  serverMessages = [
    { r: 'a', t: formBlock(formPayload), j: 'server-source-form' },
    {
      r: 'u',
      t: '用户提交了结构化表单。',
      j: 'server-followup-job',
      interaction: {
        type: 'bailing-form', version: 1, source_job_id: 'server-source-form', form_id: 'refund_info', submission_id: 'sub_server_1234', action: 'submit',
      },
    },
  ];
  const historyPage = await browser.newPage();
  await historyPage.addInitScript(() => {
    localStorage.removeItem('bailing_chat_pub_test');
    localStorage.setItem('bailing_visitor_pub_test', 'visitor-server-history');
  });
  await historyPage.goto(`http://127.0.0.1:${address.port}/`, { waitUntil: 'networkidle' });
  await historyPage.waitForFunction(() => {
    const host = Array.from(document.body.children).find((node) => node.shadowRoot);
    return host?.shadowRoot?.querySelector('[data-form-id="refund_info"] .bf-status.receipt')?.textContent?.includes('已提交');
  });
  assert.equal(await historyPage.locator('[data-form-id="refund_info"] button.primary').isDisabled(), true);
  await historyPage.close();

  console.log('✓ widget renderers expose safe forms, non-blocking acknowledgements, idempotent recovery, history receipts, capabilities, fallbacks, and cleanup');
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
