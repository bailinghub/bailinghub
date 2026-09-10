import assert from 'node:assert/strict';
import test from 'node:test';
import { RouteRepository } from './config-route-repository';
import { agentSetupRevision } from '../../core/config/agent-setup';
import { rowRoute } from '../../core/config/config-codec';

function fixture() {
  let row: Record<string, unknown> | null = {
    route_key: 'helpdesk', name: 'Helpdesk', enabled: 1, target: 'notify', target_config: JSON.stringify({ private_setting: 'keep' }),
    profile: 'general', permission: 'readonly', session_policy: 'new', memory: JSON.stringify({ recent_messages: 10 }),
    agent_client: JSON.stringify({ enabled: false }), tools: JSON.stringify({ max_calls: 3 }),
  };
  const events: string[] = [];
  let failUpdate = false;
  const connection = {
    beginTransaction: async () => { events.push('begin'); },
    query: async (sql: string, args: unknown[]) => {
      events.push(sql);
      if (sql === 'SELECT * FROM bz_routes WHERE route_key=? FOR UPDATE') return [[row ? structuredClone(row) : undefined].filter(Boolean)];
      assert.equal(sql, 'UPDATE bz_routes SET agent_client=?,tools=?,updated_at=? WHERE route_key=?');
      if (failUpdate) throw new Error('synthetic storage error');
      assert.equal(args[3], 'helpdesk');
      row = { ...row, agent_client: args[0], tools: args[1], updated_at: args[2] };
      return [{ affectedRows: 1 }];
    },
    commit: async () => { events.push('commit'); }, rollback: async () => { events.push('rollback'); }, release: () => { events.push('release'); },
  };
  return { repository: new RouteRepository(() => ({ getConnection: async () => connection })), events,
    row: () => row, missing: () => { row = null; }, fail: () => { failUpdate = true; } };
}

test('Agent setup repository compares under lock and updates only the intended columns', async () => {
  const f = fixture();
  const before = structuredClone(f.row()!);
  const revision = agentSetupRevision(rowRoute(before));
  const result = await f.repository.compareAndSetAgentSetup('helpdesk', revision, { agent_client: { enabled: true }, tools: { max_calls: 3, agent_direct: { enabled: true } } });
  assert.equal(result.status, 'updated');
  const { agent_client: _agent, tools: _tools, updated_at: _updated, ...rest } = f.row()!;
  const { agent_client: _oldAgent, tools: _oldTools, ...oldRest } = before;
  assert.deepEqual(rest, oldRest);
  assert.equal(f.events[0], 'begin');
  assert.equal(f.events[1], 'SELECT * FROM bz_routes WHERE route_key=? FOR UPDATE');
  assert.deepEqual(f.events.slice(-2), ['commit', 'release']);
  const stale = await f.repository.compareAndSetAgentSetup('helpdesk', revision, { agent_client: {}, tools: {} });
  assert.equal(stale.status, 'conflict');
  assert.deepEqual(f.events.slice(-2), ['rollback', 'release']);
});

test('Agent setup repository releases its lock on missing route and update failure', async () => {
  for (const failure of ['missing', 'storage'] as const) {
    const f = fixture();
    const revision = agentSetupRevision(rowRoute(f.row()!));
    if (failure === 'missing') f.missing(); else f.fail();
    const promise = f.repository.compareAndSetAgentSetup('helpdesk', revision, { agent_client: undefined, tools: undefined });
    if (failure === 'missing') assert.equal((await promise).status, 'not_found');
    else await assert.rejects(promise, /synthetic storage error/);
    assert.deepEqual(f.events.slice(-2), ['rollback', 'release']);
  }
});
