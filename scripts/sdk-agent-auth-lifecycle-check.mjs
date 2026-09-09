import { createServer } from 'node:http';

// Invoked by sdk-runtime-test.mjs so lifecycle checks share its runtime matrix.
export async function checkAgentAuthLifecycle({ root, runAsync, ok, closeServer }) {
  const authorizationId = '11111111-1111-4111-8111-111111111111';
  const unmappedId = '33333333-3333-4333-8333-333333333333';
  const sessionId = '22222222-2222-4222-8222-222222222222';
  const session = { session_id: sessionId, state: 'revoked', expires_at: '2030-02-01T00:00:00.000Z', revoked_at: '2030-01-02T00:00:00.000Z' };
  const item = {
    ...session, authorization_id: authorizationId, client_app_id: 'merchant-agent',
    device_label: 'Test device', principal: { id: '用户 +/?&=😀', tenant: '租户&=' },
    on_behalf_of: 'tenant:user +/?&=😀', allowed_routes: ['staff-route'],
    created_at: '2030-01-01T00:00:00.000Z', last_seen_at: '2030-01-01T01:00:00.000Z',
  };
  const filters = {
    authorization_id: authorizationId, on_behalf_of: item.on_behalf_of,
    principal_id: item.principal.id, tenant: item.principal.tenant,
    state: 'revoked', limit: 100, cursor: 'next_page-1',
  };
  const invalid = [
    { unknown: 'field' }, { client_app_id: 'other-app' }, { 0: 'active' },
    { authorization_id: null }, { authorization_id: '-'.repeat(36) },
    { authorization_id: '11111111-1111-0111-8111-111111111111' },
    { authorization_id: '11111111-1111-4111-0111-111111111111' },
    { on_behalf_of: '' }, { on_behalf_of: 'x'.repeat(192) }, { on_behalf_of: [] },
    { principal_id: 'u' }, { principal_id: '', tenant: '' },
    { principal_id: 'u'.repeat(129), tenant: '' },
    { tenant: null }, { tenant: 't'.repeat(129) },
    { on_behalf_of: ' user' }, { tenant: 'tenant ' }, { tenant: '\uFEFFtenant' },
    { tenant: 'a\u0000b' }, { tenant: 'a\u007fb' },
    { tenant: '😀'.repeat(65) }, { state: 'all' }, { state: [] },
    { limit: 0 }, { limit: 101 }, { limit: '20' }, { limit: 1.5 }, { limit: true },
    { cursor: '' }, { cursor: null }, { cursor: 'with=' }, { cursor: 'with+' },
    { cursor: 'with/' }, { cursor: 'next\n' }, { cursor: 'a'.repeat(2049) },
  ];
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push({ method: req.method, url: req.url, body, headers: req.headers });
    res.setHeader('Content-Type', 'application/json');
    const url = new URL(req.url, 'http://fixture.invalid');
    if (url.pathname === `/agent-auth/v1/authorizations/${authorizationId}`) {
      res.end(JSON.stringify({ status: 'consumed', requested_routes: ['staff-route'], session }));
    } else if (url.pathname === `/agent-auth/v1/authorizations/${unmappedId}`) {
      res.end(JSON.stringify({ status: 'consumed', requested_routes: ['staff-route'], session: null }));
    } else if (url.pathname === '/agent-auth/v1/sessions') {
      res.end(JSON.stringify({ list: [item], next_cursor: url.search ? null : 'next_page-1' }));
    } else if (url.pathname === `/agent-auth/v1/authorizations/${authorizationId}/revoke`) {
      res.end(JSON.stringify({ authorization_id: authorizationId, revoked: true, session_id: sessionId }));
    } else if (url.pathname.endsWith('/deny') || url.pathname.endsWith('/revoke') || url.pathname === '/body-check') {
      res.end('{}');
    } else {
      res.statusCode = 404;
      res.end('{"error":"not found"}');
    }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const encoded = (value) => Buffer.from(JSON.stringify(value)).toString('base64');
  try {
    for (const variant of ['php', 'php7']) {
      const command = variant === 'php7' ? (process.env.BAILING_SDK_PHP7_BINARY || 'php') : 'php';
      const start = requests.length;
      const result = await runAsync(command, ['-r', `
require '${root}/sdk/${variant}/src/HubClient.php';
require '${root}/sdk/${variant}/src/AgentAuth.php';
$auth = new Bailing\\Connect\\AgentAuth('http://127.0.0.1:${server.address().port}', 'synthetic-client-token');
$out = array('runtime' => PHP_VERSION);
$out['context'] = $auth->context('${authorizationId}');
$out['unmapped'] = $auth->context('${unmappedId}');
$out['default'] = $auth->listSessions();
$out['filtered'] = $auth->listSessions(json_decode(base64_decode('${encoded(filters)}'), true));
$out['tenantless'] = $auth->listSessions(array('principal_id' => 'u', 'tenant' => '', 'limit' => 1));
$out['tenant'] = $auth->listSessions(array('tenant' => str_repeat('😀', 64)));
$out['revoke'] = $auth->revokeAuthorization('${authorizationId}');
$out['repeat'] = $auth->revokeAuthorization('${authorizationId}');
$auth->deny('${authorizationId}');
$auth->revokeSession('${sessionId}');
$hub = new Bailing\\Connect\\HubClient('http://127.0.0.1:${server.address().port}', 'synthetic-client-token');
$hub->post('/body-check', array('nested' => array(), 'value' => 'kept'));
$hub->post('/body-check', array('nonempty-list'));
$out['invalid'] = array();
foreach (json_decode(base64_decode('${encoded(invalid)}'), true) as $filters) {
    try { $auth->listSessions($filters); $out['invalid'][] = false; }
    catch (InvalidArgumentException $e) { $out['invalid'][] = true; }
}
try { $auth->listSessions(array('tenant' => "\\xFF")); $out['invalidUtf8'] = false; }
catch (InvalidArgumentException $e) { $out['invalidUtf8'] = true; }
try { $auth->revokeAuthorization('not-a-uuid'); $out['invalidId'] = false; }
catch (InvalidArgumentException $e) { $out['invalidId'] = true; }
echo json_encode($out, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
`]);
      let data;
      try { data = JSON.parse(result.stdout); } catch {}
      const captured = requests.slice(start);
      const label = `${variant.toUpperCase()} AgentAuth lifecycle`;
      ok(`${label} runs on PHP ${data?.runtime ?? 'unknown'}`, result.status === 0 && !!data, result.stderr || result.stdout);
      ok(`${label} preserves consumed context and missing-session projection`,
        JSON.stringify(data?.context?.session) === JSON.stringify(session)
          && data?.context?.requested_routes?.[0] === 'staff-route'
          && data?.unmapped?.session === null);
      ok(`${label} returns list metadata and opaque/null cursors unchanged`,
        JSON.stringify(data?.default?.list) === JSON.stringify([item])
          && data?.default?.next_cursor === 'next_page-1' && data?.filtered?.next_cursor === null);
      const listRequests = captured.filter((request) => request.url.startsWith('/agent-auth/v1/sessions') && request.method === 'GET');
      const query = new URL(listRequests[1]?.url ?? '/', 'http://fixture.invalid');
      ok(`${label} uses only whitelisted RFC3986 query fields without broadening`,
        listRequests[0]?.url === '/agent-auth/v1/sessions'
          && JSON.stringify(Object.fromEntries(query.searchParams)) === JSON.stringify(Object.fromEntries(Object.entries(filters).map(([key, value]) => [key, String(value)])))
          && listRequests[1]?.url.includes('%20') && !listRequests[1]?.url.includes('+')
          && listRequests[2]?.url === '/agent-auth/v1/sessions?principal_id=u&tenant=&limit=1'
          && new URL(listRequests[3]?.url ?? '/', 'http://fixture.invalid').searchParams.get('tenant') === '😀'.repeat(64));
      ok(`${label} rejects ${invalid.length + 2} invalid filters/IDs before HTTP`,
        data?.invalid?.length === invalid.length && data.invalid.every(Boolean)
          && data?.invalidUtf8 === true && data?.invalidId === true && captured.length === 12);
      ok(`${label} uses idempotent revoke-authorization path and empty object bodies`,
        JSON.stringify(data?.revoke) === JSON.stringify({ authorization_id: authorizationId, revoked: true, session_id: sessionId })
          && JSON.stringify(data?.repeat) === JSON.stringify(data?.revoke)
          && captured.slice(6, 10).every((request) => request.method === 'POST' && request.body === '{}')
          && captured[6]?.url === `/agent-auth/v1/authorizations/${authorizationId}/revoke`
          && captured[7]?.url === captured[6]?.url);
      ok(`${label} keeps non-empty HubClient bodies unchanged`,
        captured[10]?.body === '{"nested":[],"value":"kept"}' && captured[11]?.body === '["nonempty-list"]');
      ok(`${label} sends only server-side Client Token headers`, captured.every((request) =>
        request.headers.authorization === 'Bearer synthetic-client-token'
          && !request.url.includes('synthetic-client-token') && !request.body.includes('synthetic-client-token')));
    }
  } finally {
    await closeServer(server);
  }
}
