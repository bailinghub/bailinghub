import assert from 'node:assert/strict';
import test from 'node:test';
import { demoVerified, onboardingSteps, pendingResource, resourceFromResponse, type OnboardingResources, type SetupResource, type SetupSmoke } from './onboarding-state';

const ready = <T>(data: T): SetupResource<T> => ({ status: 'ready', data });
function resources(): OnboardingResources {
  return {
    credentials: ready([{ name: 'saved-key', enabled: true }]),
    targets: ready([{ name: 'llm', enabled: true }]),
    providers: ready([{ name: 'business-tools', enabled: true }]),
    routes: ready([{ route_key: 'support', target: 'llm', enabled: true }]),
    clients: ready([{ app_id: 'business-app', allowed_routes: ['support'], enabled: true }]),
    agent: ready({ applications: [{ app_id: 'business-app', allowed_routes: ['support'], enabled: true, agent_auth_enabled: true }], setup_workspaces: [{ route: 'support', enabled: true, runtime_enabled: true, direct_enabled: true, source_count: 1 }] }),
    demo: ready({ available: true, imported: false, empty: false }),
  };
}
const byKey = (flow: 'business' | 'agent', r: OnboardingResources, key: string) => onboardingSteps(flow, r).find((step) => step.key === key)!;

test('both task paths prepare a route before asking for a client', () => {
  for (const flow of ['business', 'agent'] as const) {
    const keys = onboardingSteps(flow, resources()).map((step) => step.key);
    assert.ok(keys.indexOf('routes') < keys.indexOf('clients'));
    assert.equal(keys.at(-1), 'verify');
  }
});
test('connecting an existing local-agent workspace does not require additional hub credentials', () => {
  const r = resources();
  r.credentials = { status: 'forbidden', data: null };
  r.targets = { status: 'error', data: null, error: 'unavailable' };
  const steps = onboardingSteps('agent', r);
  assert.ok(steps.every((step) => !['credentials', 'targets'].includes(step.key)));
  assert.ok(steps.every((step) => step.status === 'configured' || step.status === 'verify'));
});
test('saved credentials and fully configured resources never prove a real invocation', () => {
  for (const flow of ['business', 'agent'] as const) {
    const steps = onboardingSteps(flow, resources());
    assert.equal(steps.at(-1)?.status, 'verify');
    assert.ok(steps.slice(0, -1).every((step) => step.status === 'configured'));
  }
});
test('disabled configuration is not counted as a completed preparation step', () => {
  const r = resources();
  r.targets.data![0]!.enabled = false;
  r.providers.data![0]!.enabled = false;
  r.routes.data![0]!.enabled = false;
  r.clients.data![0]!.enabled = false;
  const business = onboardingSteps('business', r);
  assert.equal(business.find((step) => step.key === 'tools')?.status, 'optional');
  for (const key of ['targets', 'routes', 'clients']) assert.equal(byKey('business', r, key).status, 'missing');
  assert.equal(byKey('agent', r, 'tools').status, 'missing');
});
test('custom execution targets are not excluded by naming suffix', () => {
  const r = resources(); r.targets = ready([{ name: 'customer-notify', enabled: true }]);
  assert.equal(byKey('business', r, 'targets').status, 'configured');
});
test('a client must actually allow an enabled business route', () => {
  const r = resources();
  r.clients.data![0]!.allowed_routes = ['unrelated-route'];
  assert.equal(byKey('business', r, 'clients').status, 'missing');
  r.clients.data![0]!.allowed_routes = ['*'];
  assert.equal(byKey('business', r, 'clients').status, 'configured');
  r.routes.data![0]!.enabled = false;
  assert.equal(byKey('business', r, 'clients').status, 'missing');
});
test('failed reads and denied access stay distinct from a successfully empty list', () => {
  const valid = (value: unknown): value is never[] => Array.isArray(value);
  const r = resources();
  r.routes = resourceFromResponse(503, { error: 'database unavailable' }, valid);
  assert.equal(byKey('business', r, 'routes').status, 'error');
  assert.equal(byKey('business', r, 'clients').status, 'error');
  assert.match(byKey('business', r, 'routes').detail, /database unavailable/);
  r.routes = resourceFromResponse(403, { error: 'forbidden' }, valid);
  assert.equal(byKey('business', r, 'routes').status, 'forbidden');
  r.routes = resourceFromResponse(200, [], valid);
  assert.equal(byKey('business', r, 'routes').status, 'missing');
});
test('pending, unavailable and malformed responses cannot become empty configuration', () => {
  const r = resources();
  r.routes = pendingResource();
  assert.equal(byKey('business', r, 'routes').status, 'loading');
  const valid = (value: unknown): value is never[] => Array.isArray(value);
  r.routes = resourceFromResponse(404, {}, valid);
  assert.equal(byKey('business', r, 'routes').status, 'unavailable');
  r.routes = resourceFromResponse(200, { list: [] }, valid);
  assert.equal(byKey('business', r, 'routes').status, 'error');
});
test('tool sources are optional for backend-triggered text work, required for local business operations', () => {
  const r = resources(); r.providers = ready([]);
  assert.equal(byKey('business', r, 'tools').optional, true);
  assert.equal(byKey('business', r, 'tools').status, 'optional');
  assert.equal(byKey('agent', r, 'tools').optional, false);
  assert.equal(byKey('agent', r, 'tools').status, 'missing');
});
test('owned demo resources are kept separate from real business setup', () => {
  const r = resources();
  r.targets = ready([{ name: 'demo-agent', enabled: true }]);
  r.providers = ready([{ name: 'demo-business', enabled: true }]);
  r.routes = ready([{ route_key: 'demo_support', enabled: true }]);
  r.clients = ready([{ app_id: 'demo-app', allowed_routes: ['demo_support'], enabled: true }]);
  r.demo = ready({ available: true, imported: true, empty: false });
  for (const key of ['targets', 'routes', 'clients']) assert.equal(byKey('business', r, key).status, 'missing');
  assert.equal(byKey('agent', r, 'tools').status, 'missing');
  r.demo.data!.imported = false;
  assert.equal(byKey('business', r, 'routes').status, 'configured', 'a matching name alone does not prove demo ownership');
});
test('local-agent setup requires the authorization and tool channel on the same allowed workspace', () => {
  const r = resources();
  assert.equal(byKey('agent', r, 'agent').status, 'configured');
  for (const key of ['enabled', 'runtime_enabled', 'direct_enabled'] as const) {
    r.agent.data!.setup_workspaces[0]![key] = false;
    assert.equal(byKey('agent', r, 'agent').status, 'missing');
    r.agent.data!.setup_workspaces[0]![key] = true;
  }
  r.agent.data!.setup_workspaces[0]!.source_count = 0;
  assert.equal(byKey('agent', r, 'agent').status, 'missing');
  r.agent.data!.setup_workspaces[0]!.source_count = 1;
  r.agent.data!.applications[0]!.agent_auth_enabled = false;
  assert.equal(byKey('agent', r, 'agent').status, 'missing');
  r.agent.data!.applications[0]!.agent_auth_enabled = true;
  r.agent.data!.applications[0]!.allowed_routes = ['other'];
  assert.equal(byKey('agent', r, 'agent').status, 'missing');
});
test('an agent overview failure remains a failure rather than missing authorization', () => {
  const r = resources(); r.agent = { status: 'error', data: null, error: 'cannot read runtime' };
  assert.equal(byKey('agent', r, 'agent').status, 'error');
  assert.equal(byKey('agent', r, 'clients').status, 'configured');
});
function report(): SetupSmoke {
  return { hub: 'http://localhost', pass: 2, fail: 0, skip: 0, checks: [{ name: '/run 任务进入终态', status: 'pass' }, { name: '按 request_id 可追溯 debug_bundle', status: 'pass' }], run: { route: 'demo_support', job_id: 'job-1', status: 'done' } };
}
test('only a done demo job with trace evidence can advance the demo journey', () => {
  assert.equal(demoVerified(report()), true);
  assert.equal(demoVerified(null), false);
  for (const status of ['error', 'rejected', 'running', 'unknown', '']) {
    const r = report(); r.run!.status = status;
    assert.equal(demoVerified(r), false, status);
  }
  const r = report(); r.run!.route = 'production-route';
  assert.equal(demoVerified(r), false);
  r.run!.route = 'demo_support'; delete r.run!.job_id;
  assert.equal(demoVerified(r), false);
});
test('passing infrastructure checks and skipped execution never certify a demo invocation', () => {
  const r = report();
  r.checks = [{ name: 'health 返回 ok', status: 'pass' }, { name: '/run + trace smoke', status: 'skip' }];
  assert.equal(demoVerified(r), false);
  r.checks = report().checks; r.fail = 1;
  assert.equal(demoVerified(r), false);
});

test('uncertain demo ownership cannot certify known demo IDs as real integration', () => {
  const r = resources();
  r.targets = ready([{ name: 'demo-agent', enabled: true }]);
  r.providers = ready([{ name: 'demo-business', enabled: true }]);
  r.routes = ready([{ route_key: 'demo_support', enabled: true }]);
  r.clients = ready([{ app_id: 'demo-app', allowed_routes: ['demo_support'], enabled: true }]);
  r.agent = ready({ applications: [{ ...r.clients.data![0]!, agent_auth_enabled: true }], setup_workspaces: [{ route: 'demo_support', enabled: true, runtime_enabled: true, direct_enabled: true, source_count: 1 }] });
  for (const status of ['loading', 'error', 'forbidden', 'unavailable'] as const) {
    r.demo = { status, data: null };
    for (const key of ['targets', 'tools', 'routes', 'clients']) assert.equal(byKey('business', r, key).status, status);
    assert.equal(byKey('agent', r, 'agent').status, status);
  }
});
test('demo status failures do not block unequivocal business configuration', () => {
  const r = resources();
  r.demo = { status: 'error', data: null, error: 'demo status unavailable' };
  for (const flow of ['business', 'agent'] as const) {
    assert.ok(onboardingSteps(flow, r).slice(0, -1).every((step) => step.status === 'configured'));
  }
  // A separate real route must not make a demo-only client look configured.
  r.routes.data!.push({ route_key: 'demo_support', enabled: true });
  r.clients = ready([{ app_id: 'demo-app', allowed_routes: ['demo_support'], enabled: true }]);
  assert.equal(byKey('business', r, 'clients').status, 'error');
});
