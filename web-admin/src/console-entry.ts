/** Only a known-empty integration starts onboarding. Optional resources are not a gate. */
export async function consoleEntry(
  fetchList: (path: string) => Promise<Response>,
  canInspectIntegration: boolean,
): Promise<'setup' | 'workspace' | 'session-expired'> {
  if (!canInspectIntegration) return 'workspace';
  const results = await Promise.all(['/admin/api/routes', '/admin/api/clients'].map(async (path) => {
    try {
      const response = await fetchList(path);
      if (response.status === 401) return 'session-expired' as const;
      if (!response.ok) return 'unknown' as const;
      const rows: unknown = await response.json();
      return Array.isArray(rows) ? (rows.length ? 'configured' as const : 'empty' as const) : 'unknown' as const;
    } catch { return 'unknown' as const; }
  }));
  if (results.includes('session-expired')) return 'session-expired';
  // The guide can explain an unavailable read; a temporary failure must not end the session.
  if (results.includes('unknown')) return 'setup';
  return results.every((state) => state === 'empty') ? 'setup' : 'workspace';
}
