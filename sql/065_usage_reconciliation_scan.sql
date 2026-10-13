-- Supports the bounded owner-local keyset scan of already saved usage evidence.
-- No original result, request ID, price snapshot or monetary ledger is rewritten.
ALTER TABLE bz_usage_billing_requests
  ADD KEY idx_usage_reconciliation_scan (billing_state, updated_at, id);
