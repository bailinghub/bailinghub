-- Optional model gateway: identity, model services, USD plans and original usage evidence.
-- No real-user plan or allowance is created by this migration.

CREATE TABLE IF NOT EXISTS bz_usage_accounts (
  id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  kind VARCHAR(24) NOT NULL,
  label VARCHAR(191) NOT NULL,
  state VARCHAR(24) NOT NULL,
  revision BIGINT UNSIGNED NOT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS bz_usage_members (
  account_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  user_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  state VARCHAR(24) NOT NULL,
  revision BIGINT UNSIGNED NOT NULL,
  created_at BIGINT NOT NULL,
  updated_at BIGINT NOT NULL,
  PRIMARY KEY(account_id,user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS bz_usage_changes (
  change_key CHAR(64) CHARACTER SET ascii PRIMARY KEY,
  request_hash CHAR(64) CHARACTER SET ascii NOT NULL,
  result_json JSON NOT NULL,
  created_at BIGINT NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS bz_usage_services (
  id VARCHAR(191) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  label VARCHAR(191) NOT NULL,
  state VARCHAR(24) NOT NULL,
  revision BIGINT UNSIGNED NOT NULL,
  config_json JSON NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS bz_usage_issuers (
  id VARCHAR(64) COLLATE utf8mb4_bin PRIMARY KEY,
  label VARCHAR(128),
  token_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin UNIQUE,
  state VARCHAR(16),
  permissions_json JSON,
  service_ids_json JSON,
  account_ids_json JSON,
  revision BIGINT,
  created_at BIGINT,
  updated_at BIGINT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS bz_usage_users (
  id CHAR(36) CHARACTER SET ascii PRIMARY KEY,
  issuer_id VARCHAR(64) COLLATE utf8mb4_bin,
  tenant_key VARCHAR(128) COLLATE utf8mb4_bin,
  subject_key VARCHAR(128) COLLATE utf8mb4_bin,
  generation_key VARCHAR(128) COLLATE utf8mb4_bin,
  state VARCHAR(16),
  created_at BIGINT,
  updated_at BIGINT,
  UNIQUE(issuer_id,tenant_key,subject_key,generation_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS bz_usage_sessions (
  id CHAR(36) CHARACTER SET ascii PRIMARY KEY,
  issuer_id VARCHAR(64) COLLATE utf8mb4_bin,
  user_id CHAR(36) CHARACTER SET ascii,
  account_id CHAR(36) CHARACTER SET ascii,
  service_id VARCHAR(128) COLLATE utf8mb4_bin,
  model_access VARCHAR(24) NOT NULL DEFAULT 'service',
  request_key VARCHAR(128) COLLATE utf8mb4_bin,
  request_hash CHAR(64) CHARACTER SET ascii,
  issuer_revision BIGINT,
  token_hash CHAR(64) CHARACTER SET ascii UNIQUE,
  state VARCHAR(16),
  expires_at BIGINT,
  created_at BIGINT,
  UNIQUE(issuer_id,request_key),
  INDEX(account_id),
  INDEX(user_id),
  INDEX(issuer_id,state)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS bz_usage_billing_plans (
  id VARCHAR(191) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  label VARCHAR(191) NOT NULL, revision BIGINT UNSIGNED NOT NULL,
  state VARCHAR(24) NOT NULL, config_json JSON NOT NULL,
  created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS bz_usage_billing_grants (
  id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  account_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  plan_id VARCHAR(191) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  plan_revision BIGINT UNSIGNED NOT NULL, label VARCHAR(191) NOT NULL,
  revision BIGINT UNSIGNED NOT NULL, state VARCHAR(24) NOT NULL,
  source_owner VARCHAR(191) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  starts_at BIGINT NOT NULL, expires_at BIGINT NULL, config_json JSON NOT NULL,
  created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL,
  KEY(account_id,created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS bz_usage_billing_heads (
  account_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  grant_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  revision BIGINT UNSIGNED NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS bz_usage_billing_periods (
  grant_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  period_start BIGINT NOT NULL, period_end BIGINT NULL,
  allowance_usd DECIMAL(30,12) UNSIGNED NOT NULL, consumed_usd DECIMAL(30,12) UNSIGNED NOT NULL DEFAULT 0,
  PRIMARY KEY(grant_id,period_start)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS bz_usage_billing_requests (
  id CHAR(64) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  operation_id VARCHAR(191) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  account_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  user_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  session_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  service_id VARCHAR(191) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  conversation_id VARCHAR(191) CHARACTER SET ascii COLLATE ascii_bin NULL,
  turn_id VARCHAR(191) CHARACTER SET ascii COLLATE ascii_bin NULL,
  request_hash CHAR(64) CHARACTER SET ascii NOT NULL,
  revision BIGINT UNSIGNED NOT NULL, state VARCHAR(24) NOT NULL,
  result_state VARCHAR(24) NOT NULL, billing_state VARCHAR(24) NOT NULL,
  service_revision BIGINT UNSIGNED NOT NULL, service_json JSON NOT NULL, model VARCHAR(191) NOT NULL,
  fence VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
  grant_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  grant_revision BIGINT UNSIGNED NOT NULL, grant_json JSON NOT NULL, billing_rate_json JSON NOT NULL,
  period_start BIGINT NOT NULL, period_end BIGINT NULL,
  result_json JSON NULL, result_hash CHAR(64) CHARACTER SET ascii NULL,
  usage_json JSON NULL, raw_usage_json JSON NULL,
  execution_key CHAR(64) CHARACTER SET ascii NULL,
  reference_cost_usd DECIMAL(30,12) UNSIGNED NULL, billed_usd DECIMAL(30,12) UNSIGNED NULL, overage_usd DECIMAL(30,12) UNSIGNED NULL,
  cancelled_at BIGINT NULL, resolution VARCHAR(64) NULL,
  created_at BIGINT NOT NULL, updated_at BIGINT NOT NULL,
  UNIQUE KEY(execution_key), KEY(account_id,created_at,id), KEY(grant_id,period_start),
  KEY(account_id,billing_state)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
CREATE TABLE IF NOT EXISTS bz_usage_billing_ledger (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  request_id CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  account_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  grant_id VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  period_start BIGINT NOT NULL, input_tokens BIGINT UNSIGNED NULL,
  output_tokens BIGINT UNSIGNED NULL, reference_cost_usd DECIMAL(30,12) UNSIGNED NOT NULL, billed_usd DECIMAL(30,12) UNSIGNED NOT NULL,
  overage_usd DECIMAL(30,12) UNSIGNED NOT NULL, created_at BIGINT NOT NULL,
  UNIQUE KEY(request_id), KEY(account_id,id), KEY(grant_id,period_start)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS bz_usage_price_snapshots (
  cache_key VARCHAR(512) CHARACTER SET ascii COLLATE ascii_bin PRIMARY KEY,
  snapshot_json JSON NOT NULL,
  fetched_at BIGINT NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
