import assert from 'node:assert/strict';

type Row = Record<string, any>;

/** Narrow in-memory SELECT evaluator shared by repository and loopback HTTP tests. */
export function evaluateBusinessSessionQuery(sessions: Row[], authorizations: Row[], sql: string, params: unknown[]): any[] {
  assert.match(sql, /FROM bz_agent_sessions s WHERE s\.client_app_id=\?/);
  assert.doesNotMatch(sql, /SELECT s\.\*|access_token_hash|refresh_token/);
  let index = 0;
  let found: Row[] = sessions.map((row): Row => ({ ...row, principal_json: typeof row.principal_json === 'string' ? JSON.parse(row.principal_json) : row.principal_json })).filter((row) => row.client_app_id === params[index]);
  index++;
  if (sql.includes('AND s.session_id=?')) { const id = params[index++]; found = found.filter((row) => row.session_id === id); }
  if (sql.includes('matched.authorization_id=?')) {
    const id = params[index++];
    found = found.filter((row) => authorizations.some((item) => item.authorization_id === id && item.session_id === row.session_id && item.client_app_id === row.client_app_id && item.status === 'consumed'));
  }
  if (sql.includes('BINARY s.on_behalf_of=BINARY ?')) { const subject = params[index++]; found = found.filter((row) => row.on_behalf_of === subject); }
  if (sql.includes("BINARY JSON_UNQUOTE(JSON_EXTRACT(s.principal_json,'$.id'))=BINARY ?")) {
    const id = params[index++]; found = found.filter((row) => row.principal_json.id === id);
  }
  if (sql.includes("JSON_EXTRACT(s.principal_json,'$.tenant')")) {
    const tenant = params[index++]; found = found.filter((row) => (row.principal_json.tenant ?? '') === tenant);
  }
  if (sql.includes('s.revoked_at IS NULL AND s.refresh_expires_at>?')) {
    const now = String(params[index++]); found = found.filter((row) => !row.revoked_at && row.refresh_expires_at > now);
  } else if (sql.includes('s.revoked_at IS NULL AND s.refresh_expires_at<=?')) {
    const now = String(params[index++]); found = found.filter((row) => !row.revoked_at && row.refresh_expires_at <= now);
  } else if (sql.includes('s.revoked_at IS NOT NULL')) found = found.filter((row) => row.revoked_at);
  if (sql.includes('(s.created_at<? OR (s.created_at=? AND s.session_id<?))')) {
    const created = params[index++]; assert.equal(params[index++], created); const id = params[index++];
    found = found.filter((row) => row.created_at < String(created) || (row.created_at === created && row.session_id < String(id)));
  }
  if (sql.includes('ORDER BY')) {
    assert.match(sql, /ORDER BY s\.created_at DESC,s\.session_id DESC LIMIT \?$/);
    found.sort((a, b) => b.created_at.localeCompare(a.created_at) || b.session_id.localeCompare(a.session_id));
    found = found.slice(0, Number(params[index++]));
  } else found = found.slice(0, 1);
  assert.equal(index, params.length, 'every SQL placeholder has an explicitly consumed value');
  return [found.map((row) => {
    const links = authorizations.filter((item) => item.client_app_id === row.client_app_id && item.session_id === row.session_id && item.status === 'consumed');
    return { ...structuredClone(row), cursor_created_at: `${row.created_at.replace(' ', 'T')}.000Z`, authorization_id: links.length === 1 ? links[0]!.authorization_id : null };
  }), []];
}
