/** Existing database resource used only for fixed, read-only schema probes. */
export interface SchemaReadinessDatabase {
  query(sql: string): Promise<[unknown, unknown]>;
}

export interface SchemaReadinessCheck {
  database: 'ok' | 'failed';
  /** Internal aggregation only; HTTP responses expose a count, never ledger rows. */
  pendingFilenames: string[];
  migrations: { status: 'ok' | 'pending' | 'failed'; pending: number };
}
