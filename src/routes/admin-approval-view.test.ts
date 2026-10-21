import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import test from 'node:test';
import type { ToolApproval } from '../core/contracts/types';
import { approvalDetailView, approvalListView } from './admin-approval-view';
import { handleAdminRuntimeApiFor, type AdminRuntimeApiDeps } from './admin-runtime';

function approval(args = { source: { html: '<p>合成页面</p>', css: '' } }): ToolApproval {
  const argsJson = JSON.stringify(args);
  const intent = { args, args_hash: 'a'.repeat(64), method: 'POST', path: '/validate', readonly: false };
  return {
    id: 31, job_id: 'synthetic-job', request_id: 'synthetic-request', provider: 'synthetic-business',
    tool: 'shop_ai_decoration_save', scope: 'shop.decoration.save', risk: 'high', status: 'pending',
    args_json: argsJson, args_hash: 'a'.repeat(64), intent, intent_json: JSON.stringify(intent),
    created_at: '2026-10-21T01:00:00.000Z',
  };
}

test('small approval snapshots remain compatible and are labelled complete', () => {
  const row = approval();
  const view = approvalListView(row);
  assert.deepEqual(view, { ...row, args_bytes: Buffer.byteLength(row.args_json!), args_truncated: false, details_available: false });
});

test('50 large approvals have bounded previews and no nested or raw duplicate full arguments', () => {
  const row = approval({ source: { html: '合成😀"\\'.repeat(75_000), css: '' } });
  const rows = Array.from({ length: 50 }, (_, index) => approvalListView({ ...row, id: index + 1 }));
  for (const view of rows) {
    assert.equal(view.args_json, undefined);
    assert.equal(view.intent, undefined);
    assert.equal(view.intent_json, undefined);
    assert.equal(view.args_bytes, Buffer.byteLength(row.args_json!, 'utf8'));
    assert.equal(view.args_hash, row.args_hash);
    assert.equal(view.args_truncated, true);
    assert.equal(view.details_available, true);
    assert.ok(Buffer.byteLength(String(view.args_preview), 'utf8') <= 4096);
    assert.equal(String(view.args_preview).includes('\ufffd'), false);
  }
  assert.ok(Buffer.byteLength(JSON.stringify(rows), 'utf8') < 600_000, 'list must stay bounded independently of full payload size');
  assert.equal(row.intent?.args !== undefined, true, 'presentation does not mutate the execution snapshot');
});

test('large legacy intent_json is also deferred when the separate args_json is small', () => {
  const row = approval();
  row.intent_json = JSON.stringify({ args: { legacy: 'x'.repeat(100_000) } });
  const view = approvalListView(row);
  assert.equal(view.details_available, true);
  assert.equal(view.intent_json, undefined);
  assert.equal(view.intent, undefined);
  assert.equal(view.args_json, undefined);
  assert.equal(view.args_truncated, false);
  assert.equal(view.args_preview, row.args_json);
});

test('single approval details preserve exact stored JSON and intent, never the list preview', () => {
  const row = approval({ source: { html: 'x'.repeat(256 * 1024), css: 'body{}' } });
  const detail = approvalDetailView(row);
  assert.equal(detail.args_json, row.args_json);
  assert.deepEqual(detail.intent, row.intent);
  assert.equal(detail.args_bytes, Buffer.byteLength(row.args_json!, 'utf8'));
  assert.equal(detail.args_truncated, false);
  assert.equal(detail.details_available, false);
});

async function request(path: string, permissions: string[], row: ToolApproval | null = approval()) {
  let reads = 0, code = 0, response = '';
  const deps = {
    configStore: { approvals: {
      get: async (id: number) => { reads++; assert.equal(id, 31); return row; },
      list: async () => { reads++; return row ? [row] : []; },
    } },
    stateStore: { getJob: async () => null },
  } as unknown as AdminRuntimeApiDeps;
  const res = { writeHead(status: number) { code = status; }, end(value: string) { response += value; } } as unknown as ServerResponse;
  const handled = await handleAdminRuntimeApiFor(deps, 'GET', path, { url: path } as IncomingMessage, res,
    { kind: 'admin', via: 'session', username: 'reader', permissions });
  return { code, body: JSON.parse(response), reads, handled };
}

test('approval detail is runs:read-only, retrieves one snapshot and does not decide or continue', async () => {
  const row = approval({ source: { html: 'x'.repeat(64 * 1024), css: '' } });
  const result = await request('/admin/api/tool-approvals/31/details', ['runs:read'], row);
  assert.equal(result.handled, true);
  assert.equal(result.code, 200);
  assert.equal(result.reads, 1);
  assert.equal(result.body.args_json, row.args_json);
  assert.equal(result.body.status, 'pending');
  const list = await request('/admin/api/tool-approvals', ['runs:read'], row);
  assert.equal(list.code, 200);
  assert.equal(list.body[0].args_json, undefined);
  assert.equal(list.body[0].details_available, true);
});

test('approval list and details deny missing runs:read before repository access', async () => {
  for (const path of ['/admin/api/tool-approvals', '/admin/api/tool-approvals/31/details']) {
    const denied = await request(path, ['tools:read']);
    assert.equal(denied.code, 403);
    assert.equal(denied.reads, 0);
  }
});

test('missing approval details return 404; invalid numeric id cannot reach a repository', async () => {
  assert.equal((await request('/admin/api/tool-approvals/31/details', ['runs:read'], null)).code, 404);
  for (const id of ['0', '999999999999999999999']) {
    const invalid = await request(`/admin/api/tool-approvals/${id}/details`, ['runs:read']);
    assert.equal(invalid.code, 400);
    assert.equal(invalid.reads, 0);
  }
});
