import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createPool, type Pool } from 'mysql2/promise';
import { migrateBailingHubCoreSchema } from '../infrastructure/schema/core-schema-migrator';

/** Opt-in, disposable loopback database only. Never reads application configuration. */
export const taskMysqlConfigPath = process.env.BAILING_TASK_TEST_MYSQL_CONFIG;

export async function openTaskMysqlFixture(): Promise<Pool> {
  assert.ok(taskMysqlConfigPath, 'Explicit disposable test database configuration is required');
  const input = JSON.parse(readFileSync(taskMysqlConfigPath, 'utf8'));
  assert.equal(input.host, '127.0.0.1', 'Task tests must use a local disposable database');
  assert.match(input.database, /^bailing_task_test(?:_[a-z0-9]+)?$/, 'Dedicated test database required');
  const mysql = { host: input.host, port: Number(input.port), database: input.database,
    user: input.user, password: input.password, connectionLimit: 8 };
  await migrateBailingHubCoreSchema({ mysql });
  const repeated = await migrateBailingHubCoreSchema({ mysql });
  assert.deepEqual(repeated.appliedFiles, [], 'Repeated migration must not replay SQL');
  assert.equal(repeated.executedStatements, 0);
  return createPool({ ...mysql, timezone: 'Z', dateStrings: true });
}

/** Only synthetic shop/inventory identities and empty conversation bodies. */
export async function seedTaskMysqlMembers(pool: Pool) {
  const suffix = randomBytes(5).toString('hex');
  const conversationId = `conversation-${suffix}`;
  const members = [];
  for (const system of ['shop', 'inventory']) {
    const sessionId = randomUUID();
    const clientAppId = `${system}-${suffix}`;
    const route = `${system}-${suffix}`;
    const runId = randomUUID();
    const principal = { id: 'example-operator', tenant: `${system}-example`, roles: ['manager'] };
    const subject = `${system}-example:example-operator`;
    await pool.query('INSERT INTO bz_clients (app_id,name,token,allowed_routes,rate_limit_per_min,enabled,agent_authorize_url,created_at,updated_at) VALUES (?,?,?,?,0,1,?,NOW(),NOW())',
      [clientAppId, `Example ${system}`, randomBytes(16).toString('hex'), JSON.stringify([route]), 'https://business.example.com/authorize']);
    await pool.query('INSERT INTO bz_routes (route_key,name,enabled,profile,tools,agent_client,created_at,updated_at) VALUES (?,?,1,?,?,?,?,NOW())',
      [route, `Example ${system}`, 'general', JSON.stringify({ agent_direct: { enabled: true } }), JSON.stringify({ enabled: true }), '2026-01-01 00:00:00']);
    await pool.query('INSERT INTO bz_agent_sessions (session_id,client_app_id,device_label,principal_json,on_behalf_of,allowed_routes,access_token_hash,access_expires_at,refresh_expires_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,\'2099-01-01\',\'2099-02-01\',NOW(),NOW())',
      [sessionId, clientAppId, `Example ${system}`, JSON.stringify(principal), subject, JSON.stringify([route]), randomBytes(32).toString('hex')]);
    await pool.query('INSERT INTO bz_agent_client_runs (run_id,session_id,client_app_id,route_key,thread_id,client_conversation_id,client_turn_id,user_message_id,request_hash,user_input,status,created_at,updated_at) VALUES (?,?,?,?,1,?,?,?,?,\'\',\'context_ready\',NOW(),NOW())',
      [runId, sessionId, clientAppId, route, conversationId, `turn-${suffix}`, `message-${system}-${suffix}`, 'a'.repeat(64)]);
    members.push({ sessionId, clientAppId, route, clientConversationId: conversationId, runId, principal, subject });
  }
  return members;
}

export async function seedTaskMysqlInvocation(pool: Pool, member: Awaited<ReturnType<typeof seedTaskMysqlMembers>>[number],
  options: { tool?: string; readonly?: boolean; approvalRequired?: boolean; runId?: string; extraMetadata?: Record<string, unknown> } = {}) {
  const invocationId = randomBytes(32).toString('hex');
  const jobId = randomUUID();
  const tool = options.tool ?? 'product_update';
  const runId = options.runId ?? member.runId;
  const argsHash = 'b'.repeat(64);
  const executionFingerprint = 'c'.repeat(64);
  const metadata = {
    agent_tool_job_marker: 'bailing.agent-tool-job.v1', principal: member.principal,
    agent_tool_call_v1: true, agent_dispatch_attempted: false,
    agent_invocation_id: invocationId, agent_run_id: runId,
    agent_route: member.route, agent_tool: tool,
    agent_args_hash: argsHash, agent_capability_revision: 'd'.repeat(64),
    agent_execution_fingerprint: executionFingerprint,
    agent_task_tool_contract: { schema_version: 'bailing.agent-task-tool-contract.v1',
      readonly: options.readonly === true, approval_required: options.approvalRequired === true,
      args_hash: argsHash, execution_fingerprint: executionFingerprint },
    ...options.extraMetadata,
  };
  const requestId = `agent-tool:${createHash('sha256').update(`bailing.agent-tool.v1\0${member.sessionId}\0${invocationId}`).digest('hex')}`;
  await pool.query('INSERT INTO bz_jobs (job_id,request_id,status,profile,target,source,session_id,client_app_id,agent_session_id,on_behalf_of,metadata,dispatch,created_at,updated_at) VALUES (?,?,\'running\',\'general\',\'agent-tool-v1\',?,?,?,?,?,?,?,NOW(),NOW())',
    [jobId, requestId, `agent-tool:${member.clientAppId}`, runId, member.clientAppId, member.sessionId, member.subject,
      JSON.stringify(metadata), JSON.stringify({ route_key: member.route })]);
  return { sessionId: member.sessionId, runId, invocationId, jobId, tool, argsHash, executionFingerprint,
    readonly: options.readonly === true, approvalRequired: options.approvalRequired === true };
}
