import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  HubClient,
  authzProbeResponse,
  buildOpenApiSpec,
  param,
  signTicket,
  signToolCall,
  tool,
  verifyCallback,
  verifyToolCall,
} from '../sdk/node/src/index.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const expectedTicket = 'v1.eyJ1aWQiOiJ0ZW5hbnQ6dXNlciIsImV4cCI6MjAwMDAwMDAwMH0.ecfc7a95bda45da95751091c1f89e316170b5edbe555b4613e4049b9e9b848b1';

let pass = 0;
let fail = 0;
function ok(name, cond, extra = '') {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}${extra ? ` ← ${extra}` : ''}`);
  }
}

function run(cmd, args, input) {
  const r = spawnSync(cmd, args, { cwd: root, input, encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout.trim(), stderr: r.stderr.trim() };
}

function runAsync(cmd, args, input) {
  return new Promise((resolveRun) => {
    const child = spawn(cmd, args, { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => resolveRun({ status: null, stdout: stdout.trim(), stderr: String(error) }));
    child.on('close', (status) => resolveRun({ status, stdout: stdout.trim(), stderr: stderr.trim() }));
    child.stdin.end(input ?? '');
  });
}

async function closeServer(server) {
  await new Promise((resolveClose, rejectClose) => {
    server.close((error) => error ? rejectClose(error) : resolveClose());
  });
}

console.log('— SDK runtime helpers');
ok('Node signTicket deterministic vector', signTicket('secret', 'tenant:user', { expiresAt: 2_000_000_000 }) === expectedTicket);

const ts = Math.floor(Date.now() / 1000);
const sig = signToolCall('tool-secret', { ts, method: 'POST', pathWithQuery: '/api/members', body: '{"id":1}', onBehalfOf: 't:u', jobId: 'job_1' });
ok('Node verifyToolCall accepts signed vector', verifyToolCall('tool-secret', { method: 'POST', pathWithQuery: '/api/members', body: '{"id":1}', timestamp: ts, signature: sig, onBehalfOf: 't:u', jobId: 'job_1' }));
const cbTs = Date.now();
const cbSig = `sha256=${await hmacHex('client-token', `${cbTs}.{"ok":true}`)}`;
ok('Node verifyCallback accepts signed vector', verifyCallback('client-token', { rawBody: '{"ok":true}', timestamp: cbTs, signature: cbSig }));
const probe = authzProbeResponse('tool-secret', { method: 'POST', pathWithQuery: '/probe', body: '{"subject":"t:u"}', timestamp: ts, signature: signToolCall('tool-secret', { ts, method: 'POST', pathWithQuery: '/probe', body: '{"subject":"t:u"}' }) }, (subject) => subject === 't:u');
ok('Node authzProbeResponse returns authorized true', probe.status === 200 && probe.body.authorized === true);
const spec = buildOpenApiSpec({ title: 'T', tools: [tool({ name: 'ping', method: 'GET', path: '/ping', description: 'Ping', scope: 'ping.read', params: [param('id', { in: 'query', required: true })] })] });
ok('Node buildOpenApiSpec emits OpenAPI paths', !!spec.paths['/ping']?.get);
ok('Node buildOpenApiSpec emits ACC', spec.paths['/ping']?.get?.['x-agent-capability']?.scope === 'ping.read');
ok('Node HubClient is exported', typeof HubClient === 'function');

const py = run('python3', ['-'], `
import sys
sys.path.insert(0, '${root}/sdk/python')
from bailing_connect import sign_ticket, HubClient
print(sign_ticket('secret', 'tenant:user', expires_at=2000000000))
print(HubClient.__name__)
`);
ok('Python sign_ticket deterministic vector', py.status === 0 && py.stdout.split('\n')[0] === expectedTicket, py.stderr || py.stdout);
ok('Python HubClient is exported', py.status === 0 && py.stdout.split('\n')[1] === 'HubClient', py.stderr || py.stdout);

const php = run('php', ['-r', `
require '${root}/sdk/php/src/Ticket.php';
require '${root}/sdk/php/src/HubClient.php';
require '${root}/sdk/php/src/AgentAuth.php';
require '${root}/sdk/php/src/SpecServer.php';
echo Bailing\\Connect\\Ticket::sign('secret', 'tenant:user', 7200, 2000000000), "\\n";
echo class_exists('Bailing\\\\Connect\\\\HubClient') ? 'HubClient' : 'missing', "\\n";
echo class_exists('Bailing\\\\Connect\\\\AgentAuth') ? 'AgentAuth' : 'missing', "\\n";
$protectedHeaders = Bailing\\Connect\\SpecServer::responseHeaders('tool-secret');
echo isset($protectedHeaders['Cache-Control']) ? $protectedHeaders['Cache-Control'] : 'missing', "\\n";
list($publicStatus, $publicBody) = Bailing\\Connect\\SpecServer::handlePublic('{"ok":true}', 'GET', '/tools.json');
echo ($publicStatus === 200 && $publicBody === '{"ok":true}') ? 'public-helper' : 'bad-public-helper', "\\n";
list($legacyStatus, $legacyBody) = Bailing\\Connect\\SpecServer::handle('{"ok":true}', null, 'GET', '/tools.json', array());
echo ($legacyStatus === 200 && $legacyBody === '{"ok":true}') ? 'legacy-null' : 'bad-legacy-null';
`]);
ok('PHP sign ticket deterministic vector', php.status === 0 && php.stdout.split('\n')[0] === expectedTicket, php.stderr || php.stdout);
ok('PHP HubClient is exported', php.status === 0 && php.stdout.split('\n')[1] === 'HubClient', php.stderr || php.stdout);
ok('PHP AgentAuth is exported', php.status === 0 && php.stdout.split('\n')[2] === 'AgentAuth', php.stderr || php.stdout);
ok('PHP protected spec response is private/no-store', php.status === 0 && php.stdout.split('\n')[3] === 'private, no-store', php.stderr || php.stdout);
ok('PHP explicit public spec helper works', php.status === 0 && php.stdout.split('\n')[4] === 'public-helper', php.stderr || php.stdout);
ok('PHP legacy null-public signature remains compatible', php.status === 0 && php.stdout.split('\n')[5] === 'legacy-null', php.stderr || php.stdout);

const php7 = run('php', ['-r', `
require '${root}/sdk/php7/src/Ticket.php';
require '${root}/sdk/php7/src/HubClient.php';
require '${root}/sdk/php7/src/AgentAuth.php';
require '${root}/sdk/php7/src/SpecServer.php';
echo Bailing\\Connect\\Ticket::sign('secret', 'tenant:user', 7200, 2000000000), "\\n";
echo class_exists('Bailing\\\\Connect\\\\HubClient') ? 'HubClient' : 'missing', "\\n";
echo class_exists('Bailing\\\\Connect\\\\AgentAuth') ? 'AgentAuth' : 'missing', "\\n";
$protectedHeaders = Bailing\\Connect\\SpecServer::responseHeaders('tool-secret');
echo isset($protectedHeaders['Cache-Control']) ? $protectedHeaders['Cache-Control'] : 'missing', "\\n";
list($publicStatus, $publicBody) = Bailing\\Connect\\SpecServer::handlePublic('{"ok":true}', 'GET', '/tools.json');
echo ($publicStatus === 200 && $publicBody === '{"ok":true}') ? 'public-helper' : 'bad-public-helper', "\\n";
list($legacyStatus, $legacyBody) = Bailing\\Connect\\SpecServer::handle('{"ok":true}', null, 'GET', '/tools.json', array());
echo ($legacyStatus === 200 && $legacyBody === '{"ok":true}') ? 'legacy-null' : 'bad-legacy-null';
`]);
ok('PHP7 sign ticket deterministic vector', php7.status === 0 && php7.stdout.split('\n')[0] === expectedTicket, php7.stderr || php7.stdout);
ok('PHP7 HubClient is exported', php7.status === 0 && php7.stdout.split('\n')[1] === 'HubClient', php7.stderr || php7.stdout);
ok('PHP7 AgentAuth is exported', php7.status === 0 && php7.stdout.split('\n')[2] === 'AgentAuth', php7.stderr || php7.stdout);
ok('PHP7 protected spec response is private/no-store', php7.status === 0 && php7.stdout.split('\n')[3] === 'private, no-store', php7.stderr || php7.stdout);
ok('PHP7 explicit public spec helper works', php7.status === 0 && php7.stdout.split('\n')[4] === 'public-helper', php7.stderr || php7.stdout);
ok('PHP7 legacy null-public signature remains compatible', php7.status === 0 && php7.stdout.split('\n')[5] === 'legacy-null', php7.stderr || php7.stdout);

const authorizationId = '11111111-1111-4111-8111-111111111111';
const sessionId = '22222222-2222-4222-8222-222222222222';
const agentAuthRequests = [];
const agentAuthServer = createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  agentAuthRequests.push({
    method: req.method,
    url: req.url,
    authorization: req.headers.authorization,
    contentType: req.headers['content-type'],
    body,
  });
  res.setHeader('Content-Type', 'application/json');
  if (req.url === '/redirect') {
    res.statusCode = 302;
    res.setHeader('Location', '/agent-auth-leak');
    res.end('{}');
    return;
  }
  if (req.url === '/agent-auth-leak') {
    res.end('{"leaked":true}');
    return;
  }
  if (req.url === `/agent-auth/v1/authorizations/${authorizationId}`) {
    res.end('{"requested_routes":["staff-route"]}');
    return;
  }
  if (req.url?.endsWith('/approve')) {
    res.end('{"redirect_uri":"http://127.0.0.1/callback?code=unit-test"}');
    return;
  }
  if (req.url?.endsWith('/deny')) {
    res.end('{"status":"denied"}');
    return;
  }
  if (req.url?.endsWith('/revoke')) {
    res.end('{"status":"revoked"}');
    return;
  }
  res.statusCode = 404;
  res.end('{"error":"not found"}');
});
await new Promise((resolveListen, rejectListen) => {
  agentAuthServer.once('error', rejectListen);
  agentAuthServer.listen(0, '127.0.0.1', resolveListen);
});
let php7AgentAuth;
try {
  const address = agentAuthServer.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  php7AgentAuth = await runAsync('php', ['-r', `
require '${root}/sdk/php7/src/HubClient.php';
require '${root}/sdk/php7/src/AgentAuth.php';
$authorizationId = '${authorizationId}';
$sessionId = '${sessionId}';
$auth = new Bailing\\Connect\\AgentAuth('${baseUrl}', 'unit-test-client-token');
$out = array();
$out['context'] = $auth->context($authorizationId);
$out['approve'] = $auth->approve(
    $authorizationId,
    array('id' => 'user-7', 'tenant' => 'tenant-3'),
    'tenant-3:user-7',
    array('selected' => 'staff-route')
);
$out['deny'] = $auth->deny($authorizationId);
$out['revoke'] = $auth->revokeSession($sessionId);
$out['validation'] = array();
$checks = array(
    function () use ($auth) { $auth->context('not-a-uuid'); },
    function () use ($auth, $authorizationId) { $auth->approve($authorizationId, array(), 'tenant-3:user-7', array('staff-route')); },
    function () use ($auth, $authorizationId) { $auth->approve($authorizationId, array('id' => 'user-7'), '', array('staff-route')); },
    function () use ($auth, $authorizationId) { $auth->approve($authorizationId, array('id' => 'user-7'), 'tenant-3:user-7', array()); }
);
foreach ($checks as $check) {
    try {
        $check();
        $out['validation'][] = 'missing-error';
    } catch (InvalidArgumentException $e) {
        $out['validation'][] = $e->getMessage();
    }
}
$hub = new Bailing\\Connect\\HubClient('${baseUrl}', 'unit-test-client-token');
try {
    $hub->get('/redirect');
    $out['redirect'] = 'followed';
} catch (RuntimeException $e) {
    $out['redirect'] = $e->getMessage();
}
echo json_encode($out, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
`]);
} finally {
  await closeServer(agentAuthServer);
}

let php7AgentAuthData = null;
try {
  php7AgentAuthData = JSON.parse(php7AgentAuth.stdout);
} catch {}
ok('PHP7 AgentAuth HTTP flow completes', php7AgentAuth.status === 0 && php7AgentAuthData !== null, php7AgentAuth.stderr || php7AgentAuth.stdout);
ok('PHP7 AgentAuth context/approve/deny/revoke responses round-trip',
  php7AgentAuthData?.context?.requested_routes?.[0] === 'staff-route'
    && php7AgentAuthData?.approve?.redirect_uri === 'http://127.0.0.1/callback?code=unit-test'
    && php7AgentAuthData?.deny?.status === 'denied'
    && php7AgentAuthData?.revoke?.status === 'revoked');
ok('PHP7 AgentAuth validates UUID, principal, subject and route scope',
  JSON.stringify(php7AgentAuthData?.validation) === JSON.stringify([
    'authorizationId 必须是 UUID',
    'principal.id 必填',
    'onBehalfOf 必填',
    'allowedRoutes 至少包含一条路由',
  ]));
ok('PHP7 AgentAuth uses the v1 paths and methods',
  JSON.stringify(agentAuthRequests.slice(0, 4).map(({ method, url }) => [method, url])) === JSON.stringify([
    ['GET', `/agent-auth/v1/authorizations/${authorizationId}`],
    ['POST', `/agent-auth/v1/authorizations/${authorizationId}/approve`],
    ['POST', `/agent-auth/v1/authorizations/${authorizationId}/deny`],
    ['POST', `/agent-auth/v1/sessions/${sessionId}/revoke`],
  ]));
let approveBody = null;
try {
  approveBody = JSON.parse(agentAuthRequests[1]?.body ?? '');
} catch {}
ok('PHP7 AgentAuth derives the approval wire body without client-side credentials',
  JSON.stringify(approveBody) === JSON.stringify({
    principal: { id: 'user-7', tenant: 'tenant-3', roles: [] },
    on_behalf_of: 'tenant-3:user-7',
    allowed_routes: ['staff-route'],
  }));
ok('PHP7 AgentAuth keeps Client Token in the backend Authorization header',
  agentAuthRequests.every((request) => request.authorization === 'Bearer unit-test-client-token')
    && agentAuthRequests.slice(1, 4).every((request) => request.contentType === 'application/json'));
ok('PHP7 HubClient does not follow a Bearer-authenticated redirect',
  php7AgentAuthData?.redirect === 'HTTP 302'
    && !agentAuthRequests.some((request) => request.url === '/agent-auth-leak'));

console.log(`\n结果：通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);

async function hmacHex(secret, msg) {
  const { createHmac } = await import('node:crypto');
  return createHmac('sha256', secret).update(msg, 'utf8').digest('hex');
}
