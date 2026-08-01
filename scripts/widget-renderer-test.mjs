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
const history = [
  { r: 'a', t: `\`\`\`bailing-chart\n${JSON.stringify(validPayload)}\n\`\`\`` },
  { r: 'a', t: '```unknown-chart\n{"value":1}\n```' },
  { r: 'a', t: '```bailing-chart\n{"broken":\n```' },
  { r: 'a', t: '```bailing-chart\n"scalar"\n```' },
];

let resolveSubmission;
const submission = new Promise((resolve) => { resolveSubmission = resolve; });

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
    res.end(JSON.stringify({ messages: [] }));
    return;
  }
  if (req.url === '/chat/pub_test' && req.method === 'POST') {
    const chunks = [];
    req.on('data', (chunk) => { chunks.push(chunk); });
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      resolveSubmission(body);
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ done: true, job_id: 'job-1', visitor_id: 'visitor-12345678', reply: 'ok' }));
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
          const { container, payload, signal, theme } = context;
          window.__rendererMounts += 1;
          window.__rendererContextKeys = Object.keys(context).sort();
          window.__rendererContextFrozen = Object.isFrozen(context) && Object.isFrozen(theme);
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
    localStorage.setItem('bailing_chat_pub_test', JSON.stringify(seededHistory));
  }, { seededHistory: history });

  await page.goto(`http://127.0.0.1:${address.port}/`, { waitUntil: 'networkidle' });
  await page.waitForFunction(() => window.__rendererMounts - window.__rendererDestroys === 1);

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
      richMessageCount: root?.querySelectorAll('.m.rich').length || 0,
      panelWidth: root?.querySelector('.panel')?.getBoundingClientRect().width || 0,
      fallbacks,
    };
  });

  assert.equal(result.rendererApiVersion, '1');
  assert.equal(result.activeCount, 1);
  assert.equal(result.activeText, 'bar:12');
  assert.equal(result.mounts - result.destroys, 1);
  assert.deepEqual(result.contextKeys, ['container', 'payload', 'signal', 'source', 'theme', 'type', 'version']);
  assert.equal(result.contextFrozen, true);
  assert.equal(result.richMessageCount, 1);
  assert.ok(result.panelWidth >= 640, `expected rich content to widen the panel, got ${result.panelWidth}`);
  assert.ok(result.fallbacks.some((item) => item.language === 'unknown-chart' && item.text.includes('{"value":1}')));
  assert.ok(result.fallbacks.some((item) => item.language === 'bailing-chart' && item.text.includes('{"broken":')));
  assert.ok(result.fallbacks.some((item) => item.language === 'bailing-chart' && item.text === '"scalar"'));

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

  await page.locator('textarea').fill('请分析这组数据');
  await page.locator('.send').click();
  const submitted = await submission;
  assert.deepEqual(submitted.client_capabilities, { renderers: ['bailing-chart'] });
  await page.waitForFunction(() => {
    const host = Array.from(document.body.children).find((node) => node.shadowRoot);
    return host?.shadowRoot?.querySelector('.send')?.disabled === false;
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

  console.log('✓ widget renderers widen safely, expose presentation capabilities, maximize, fall back, and clean up');
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
