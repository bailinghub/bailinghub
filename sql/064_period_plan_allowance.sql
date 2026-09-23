-- Explicit upgrade of pre-split periodic terms. Stop all old writers first.
-- Preserve each original snapshot's allowance, independently of the current plan.
-- Existing pool allowances, prices, revisions, charges and request hashes are unchanged.
-- Missing fields alone are converted; reruns cannot overwrite explicit new allowances.
UPDATE bz_usage_billing_plans
SET config_json = JSON_SET(config_json, '$.periodAllowanceUsd', JSON_EXTRACT(config_json, '$.priceUsd'))
WHERE JSON_UNQUOTE(JSON_EXTRACT(config_json, '$.mode')) = 'periodic'
  AND JSON_CONTAINS_PATH(config_json, 'one', '$.periodAllowanceUsd') = 0;

UPDATE bz_usage_billing_grants
SET config_json = JSON_SET(config_json, '$.periodAllowanceUsd', JSON_EXTRACT(config_json, '$.priceUsd'))
WHERE JSON_UNQUOTE(JSON_EXTRACT(config_json, '$.mode')) = 'periodic'
  AND JSON_CONTAINS_PATH(config_json, 'one', '$.periodAllowanceUsd') = 0;

UPDATE bz_usage_billing_requests
SET grant_json = JSON_SET(grant_json, '$.periodAllowanceUsd', JSON_EXTRACT(grant_json, '$.priceUsd'))
WHERE JSON_UNQUOTE(JSON_EXTRACT(grant_json, '$.mode')) = 'periodic'
  AND JSON_CONTAINS_PATH(grant_json, 'one', '$.periodAllowanceUsd') = 0;

-- Grant/control idempotency replays carry their own immutable allowance config.
UPDATE bz_usage_changes
SET result_json = JSON_SET(result_json, '$.config.periodAllowanceUsd', JSON_EXTRACT(result_json, '$.config.priceUsd'))
WHERE JSON_CONTAINS_PATH(result_json, 'all', '$.planId', '$.sourceOwner') = 1
  AND JSON_UNQUOTE(JSON_EXTRACT(result_json, '$.config.mode')) = 'periodic'
  AND JSON_CONTAINS_PATH(result_json, 'one', '$.config.periodAllowanceUsd') = 0;
