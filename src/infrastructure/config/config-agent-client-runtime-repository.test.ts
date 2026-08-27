import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentClientRuntimeRepository } from './config-agent-client-runtime-repository';

test('AgentClientRuntimeRepository admin stats return aggregates only and parameterize client scope', async () => {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const pool = {
    async query(sql: string, params: unknown[] = []) {
      queries.push({ sql, params });
      if (sql.includes('FROM bz_agent_client_runs')) {
        return [[{
          client_app_id: 'example-business', runs: 4, conversations: 2,
          completed: 3, failed: 1, tool_calls: 7, total_tokens: 2400,
        }], []];
      }
      if (sql.includes('FROM bz_tool_approvals')) {
        return [[
          { client_app_id: 'example-business', status: 'approved', total: 2 },
          { client_app_id: 'example-business', status: 'denied', total: 1 },
        ], []];
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  const repo = new AgentClientRuntimeRepository(() => pool);
  const result = await repo.statsForAdmin({
    since: '2026-08-20 00:00:00', clientAppId: 'example-business',
  });
  assert.deepEqual(result, [{
    client_app_id: 'example-business', runs: 4, conversations: 2,
    completed: 3, failed: 1, tool_calls: 7, total_tokens: 2400,
    approvals: { approved: 2, denied: 1 },
  }]);
  assert.equal(queries.length, 2);
  assert.deepEqual(queries[0]!.params, ['2026-08-20 00:00:00', 'example-business']);
  assert.deepEqual(queries[1]!.params, ['2026-08-20 00:00:00', 'example-business']);
  assert.doesNotMatch(queries[0]!.sql, /user_input|final_content|context_json/);
});
