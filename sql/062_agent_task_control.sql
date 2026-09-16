-- Candidate foundation only: no Agent HTTP or tool-dispatch admission is enabled by this migration.
-- Runtime wiring must use the same MySQL transaction for permit, approval consumption and Job fence.
CREATE TABLE IF NOT EXISTS `bz_agent_tasks` (
  `task_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `create_key` CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `create_hash` CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `state` VARCHAR(16) NOT NULL,
  `revision` BIGINT UNSIGNED NOT NULL,
  `ledger_sequence` BIGINT UNSIGNED NOT NULL,
  `policy_json` JSON NOT NULL,
  `scope_hash` CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `write_reserved` BIGINT UNSIGNED NOT NULL DEFAULT 0,
  `write_consumed` BIGINT UNSIGNED NOT NULL DEFAULT 0,
  `active_permits` INT UNSIGNED NOT NULL DEFAULT 0,
  `created_by` VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  `created_at` DATETIME(3) NOT NULL,
  `updated_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`task_id`),
  UNIQUE KEY `uk_agent_task_create` (`create_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `bz_agent_task_members` (
  `task_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `member_key` CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `session_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `client_app_id` VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  `route_key` VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  `client_conversation_id` VARCHAR(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  `allowed_tools_json` JSON NOT NULL,
  `identity_hash` CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  PRIMARY KEY (`task_id`,`member_key`),
  KEY `idx_agent_task_member_session` (`session_id`,`task_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Sticky: task cancellation/completion never removes a Session's enforcement marker.
CREATE TABLE IF NOT EXISTS `bz_agent_task_enforcements` (
  `session_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `first_task_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `created_by` VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  `created_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`session_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `bz_agent_task_invocations` (
  `session_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `invocation_id` CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `task_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `run_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `job_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `tool` VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  `args_hash` CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `execution_fingerprint` CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `is_readonly` TINYINT NOT NULL,
  `approval_required` TINYINT NOT NULL,
  `approval_id` BIGINT UNSIGNED DEFAULT NULL,
  `budget_state` VARCHAR(16) DEFAULT NULL,
  `permit_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
  `permit_state` VARCHAR(16) NOT NULL DEFAULT 'none',
  `outcome` VARCHAR(32) DEFAULT NULL,
  `is_terminal` TINYINT NOT NULL DEFAULT 0,
  `attempt` INT UNSIGNED NOT NULL DEFAULT 0,
  `created_at` DATETIME(3) NOT NULL,
  `updated_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`session_id`,`invocation_id`),
  UNIQUE KEY `uk_agent_task_job` (`job_id`),
  KEY `idx_agent_task_invocations` (`task_id`,`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- A real Agent run belongs to one task. A new invocation cannot switch its budget.
CREATE TABLE IF NOT EXISTS `bz_agent_task_runs` (
  `run_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `task_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `session_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `created_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`run_id`),
  KEY `idx_agent_task_runs` (`task_id`,`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

CREATE TABLE IF NOT EXISTS `bz_agent_task_events` (
  `task_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  `sequence` BIGINT UNSIGNED NOT NULL,
  `event` VARCHAR(40) NOT NULL,
  `request_key` CHAR(64) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
  `request_hash` CHAR(64) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
  `actor` VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL,
  `invocation_id` CHAR(64) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
  `permit_id` CHAR(36) CHARACTER SET ascii COLLATE ascii_bin DEFAULT NULL,
  `detail_json` JSON NOT NULL,
  `created_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`task_id`,`sequence`),
  UNIQUE KEY `uk_agent_task_control_request` (`task_id`,`request_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
