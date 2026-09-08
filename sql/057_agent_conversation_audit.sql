-- Complete visible conversations are admin-only audit records. Authorization
-- threads, runtime memory, Agent Sessions, runs and tool ownership stay separate.
CREATE TABLE IF NOT EXISTS `bz_agent_conversation_audits` (
  `conversation_id` CHAR(36) NOT NULL,
  `creator_session_id` CHAR(36) NOT NULL,
  `client_app_id` VARCHAR(64) NOT NULL,
  `route_key` VARCHAR(64) NOT NULL,
  `client_archive_id` CHAR(36) NOT NULL,
  `client_conversation_id` VARCHAR(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  `enrollment_hash` CHAR(64) NOT NULL,
  `state` VARCHAR(16) NOT NULL,
  `member_count` SMALLINT UNSIGNED NOT NULL,
  `confirmed_count` SMALLINT UNSIGNED NOT NULL,
  `last_sequence` INT UNSIGNED NOT NULL DEFAULT 0,
  `content_bytes` INT UNSIGNED NOT NULL DEFAULT 0,
  `message_count` INT UNSIGNED NOT NULL DEFAULT 0,
  `turn_count` INT UNSIGNED NOT NULL DEFAULT 0,
  `last_turn_id` VARCHAR(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL,
  `last_turn_status` VARCHAR(16) DEFAULT NULL,
  `created_at` DATETIME NOT NULL,
  `updated_at` DATETIME NOT NULL,
  PRIMARY KEY (`conversation_id`),
  UNIQUE KEY `uk_conversation_archive` (`creator_session_id`,`route_key`,`client_archive_id`),
  KEY `idx_conversation_recent` (`updated_at`,`conversation_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Administrator-only visible conversation audit';

CREATE TABLE IF NOT EXISTS `bz_agent_conversation_members` (
  `conversation_id` CHAR(36) NOT NULL,
  `session_id` CHAR(36) NOT NULL,
  `display_label` VARCHAR(128) NOT NULL,
  `identity_hash` CHAR(64) DEFAULT NULL,
  `principal_json` JSON DEFAULT NULL,
  `on_behalf_of` VARCHAR(191) DEFAULT NULL,
  `confirmed_at` DATETIME DEFAULT NULL,
  PRIMARY KEY (`conversation_id`,`session_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Frozen members confirmed by their own Agent bearer';

CREATE TABLE IF NOT EXISTS `bz_agent_conversation_events` (
  `conversation_id` CHAR(36) NOT NULL,
  `sequence` INT UNSIGNED NOT NULL,
  `event_id` VARCHAR(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  `client_turn_id` VARCHAR(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  `kind` VARCHAR(24) NOT NULL,
  `content` MEDIUMTEXT DEFAULT NULL,
  `run_id` CHAR(36) DEFAULT NULL,
  `member_session_id` CHAR(36) DEFAULT NULL,
  `thread_id` BIGINT UNSIGNED DEFAULT NULL,
  `status` VARCHAR(16) DEFAULT NULL,
  `event_hash` CHAR(64) NOT NULL,
  `created_at` DATETIME NOT NULL,
  PRIMARY KEY (`conversation_id`,`sequence`),
  UNIQUE KEY `uk_conversation_event` (`conversation_id`,`event_id`),
  UNIQUE KEY `uk_conversation_run` (`run_id`),
  KEY `idx_conversation_turn` (`conversation_id`,`client_turn_id`,`kind`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Idempotent visible text and verified run links, never Agent memory';
