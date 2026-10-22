import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { buildRouteCallSnippets, canCallRoute, type SnippetRoute } from './route-call-snippets';

const client = { app_id: 'demo-business', enabled: true, allowed_routes: ['support'], token: '****masked-token-must-not-enter-code' };
const route: SnippetRoute = { route_key: 'support', name: '业务助手', session_policy: 'per_key', session_key_field: 'case_id', delivery: { type: 'channel', to_field: 'recipient_id' } };

test('only enabled clients with this route or a wildcard are available for call snippets', () => {
  assert.equal(canCallRoute(client, 'support'), true);
  assert.equal(canCallRoute(client, 'another-route'), false);
  assert.equal(canCallRoute({ ...client, enabled: false }, 'support'), false);
  assert.equal(canCallRoute({ ...client, allowed_routes: ['*'] }, 'another-route'), true);
  assert.equal(canCallRoute({ ...client, enabled: false, allowed_routes: ['*'] }, 'support'), false);
  assert.equal(canCallRoute({ app_id: 'missing', enabled: true }, 'support'), false);
  assert.equal(canCallRoute(client, undefined), false);
});

test('all copyable snippets omit client credentials even when a caller supplies a full token', () => {
  for (const token of [client.token, 'synthetic-full-token-must-not-enter-code']) {
    const snippets = buildRouteCallSnippets(route, { ...client, token } as typeof client, 'https://hub.example.test');
    for (const [language, code] of Object.entries(snippets)) {
      assert.ok(!code.includes(token), language);
      assert.match(code, /BAILING_CLIENT_TOKEN/, language);
    }
  }
});

test('generated Node code reads runtime credentials and preserves request metadata', async () => {
  const code = buildRouteCallSnippets(route, client, 'https://hub.example.test/').node;
  const run = new (Object.getPrototypeOf(async function () {}).constructor)('process', 'fetch', 'console', code);
  let request: { url: string; init: RequestInit } | undefined;
  const fetch = async (url: string, init: RequestInit) => {
    request = { url, init };
    return { ok: true, json: async () => ({ job_id: 'job-demo', status: 'queued' }) };
  };
  await run({ env: { BAILING_CLIENT_TOKEN: 'synthetic-runtime-token' } }, fetch, { log() {}, error() {} });
  assert.equal(request?.url, 'https://hub.example.test/run');
  assert.equal((request?.init.headers as Record<string, string>).authorization, 'Bearer synthetic-runtime-token');
  assert.deepEqual(JSON.parse(request?.init.body as string), {
    request_id: 'demo-business_demo-1', route: 'support', input: '联调测试内容', metadata: { case_id: 'demo-1', recipient_id: '<收件人id>' },
  });
  request = undefined;
  await assert.rejects(() => run({ env: {} }, fetch, { log() {}, error() {} }), /BAILING_CLIENT_TOKEN/);
  assert.equal(request, undefined, 'missing credentials must fail before making a request');
});

test('generated shell commands expand the environment token without executing token contents', () => {
  const { curl } = buildRouteCallSnippets(route, client, 'https://hub.example.test');
  // A local shell function captures arguments. No HTTP command is executed.
  const token = 'synthetic token $(false)';
  const run = spawnSync('bash', ['-c', `curl() { printf '%s\\n' "$@"; }\n${curl}`], {
    env: { PATH: process.env.PATH, BAILING_CLIENT_TOKEN: token }, encoding: 'utf8',
  });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stdout.split('\n').filter((line) => line === `Authorization: Bearer ${token}`).length, 2);
  assert.ok(run.stdout.includes('"case_id":"demo-1"'));
  const missing = spawnSync('bash', ['-c', `curl() { printf 'unexpected-network-call'; }\n${curl}`], { env: { PATH: process.env.PATH }, encoding: 'utf8' });
  assert.notEqual(missing.status, 0);
  assert.doesNotMatch(missing.stdout, /unexpected-network-call/);
});

for (const [label, fixture] of [
  ['normal', route],
  ['quoted metadata', { ...route, session_key_field: "case's\\key", delivery: { type: 'channel', to_field: 'receiver"key' } }],
] as const) {
  const snippets = buildRouteCallSnippets(fixture, client, 'https://hub.example.test');
  const languages = [
    ['Node.js', process.execPath, ['--input-type=module', '--check'], snippets.node],
    ['Python', 'python3', ['-c', 'import ast, sys; ast.parse(sys.stdin.read())'], snippets.python],
    ['PHP', 'php', ['-l'], snippets.php],
    ['cURL shell', 'bash', ['-n'], snippets.curl],
    ['Agent shell', 'bash', ['-n'], [...snippets.skill.matchAll(/```bash\n([\s\S]*?)```/g)].map((match) => match[1]).join('\n')],
  ] as const;
  for (const [language, executable, args, code] of languages) {
    test(`${language} snippet is syntactically valid (${label})`, (t) => {
      const result = spawnSync(executable, [...args], { input: code, encoding: 'utf8' });
      if (result.error && 'code' in result.error && result.error.code === 'ENOENT') { t.skip(`${executable} is unavailable`); return; }
      assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}`);
    });
  }
}
