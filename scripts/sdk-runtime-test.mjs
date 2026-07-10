import { spawnSync } from 'node:child_process';
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
echo Bailing\\Connect\\Ticket::sign('secret', 'tenant:user', 7200, 2000000000), "\\n";
echo class_exists('Bailing\\\\Connect\\\\HubClient') ? 'HubClient' : 'missing';
`]);
ok('PHP sign ticket deterministic vector', php.status === 0 && php.stdout.split('\n')[0] === expectedTicket, php.stderr || php.stdout);
ok('PHP HubClient is exported', php.status === 0 && php.stdout.split('\n')[1] === 'HubClient', php.stderr || php.stdout);

const php7 = run('php', ['-r', `
require '${root}/sdk/php7/src/Ticket.php';
require '${root}/sdk/php7/src/HubClient.php';
echo Bailing\\Connect\\Ticket::sign('secret', 'tenant:user', 7200, 2000000000), "\\n";
echo class_exists('Bailing\\\\Connect\\\\HubClient') ? 'HubClient' : 'missing';
`]);
ok('PHP7 sign ticket deterministic vector', php7.status === 0 && php7.stdout.split('\n')[0] === expectedTicket, php7.stderr || php7.stdout);
ok('PHP7 HubClient is exported', php7.status === 0 && php7.stdout.split('\n')[1] === 'HubClient', php7.stderr || php7.stdout);

console.log(`\n结果：通过 ${pass} / 失败 ${fail}`);
process.exit(fail ? 1 : 0);

async function hmacHex(secret, msg) {
  const { createHmac } = await import('node:crypto');
  return createHmac('sha256', secret).update(msg, 'utf8').digest('hex');
}
