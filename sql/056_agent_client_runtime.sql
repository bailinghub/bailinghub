-- 056: Agent Client Runtime v1 私有候选。
-- 本迁移只增加本地编排的配置、会话映射、运行幂等和可见消息关联；不改变旧 /run 编排语义。

ALTER TABLE `bz_routes`
  ADD COLUMN `agent_client` JSON DEFAULT NULL COMMENT '本地 Agent Runtime 覆盖配置' AFTER `memory`;

ALTER TABLE `bz_messages`
  ADD COLUMN `agent_run_id` CHAR(36) DEFAULT NULL COMMENT '本地 Agent Runtime run 关联' AFTER `job_id`;

ALTER TABLE `bz_messages`
  ADD COLUMN `external_message_id` VARCHAR(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL COMMENT '客户端可见消息幂等键' AFTER `agent_run_id`;

ALTER TABLE `bz_messages`
  ADD UNIQUE KEY `uk_agent_run_direction` (`agent_run_id`, `direction`);

ALTER TABLE `bz_messages`
  ADD KEY `idx_external_message` (`external_message_id`);

CREATE TABLE IF NOT EXISTS `bz_agent_client_conversations` (
  `session_id`             CHAR(36)     NOT NULL,
  `client_app_id`          VARCHAR(64)  NOT NULL,
  `route_key`              VARCHAR(64)  NOT NULL,
  `client_conversation_id` VARCHAR(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  `thread_id`              BIGINT UNSIGNED NOT NULL,
  `created_at`             DATETIME     NOT NULL,
  `last_active_at`         DATETIME     NOT NULL,
  PRIMARY KEY (`session_id`, `route_key`, `client_conversation_id`),
  KEY `idx_agent_conversation_thread` (`thread_id`),
  KEY `idx_agent_conversation_client` (`client_app_id`, `last_active_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='本地 Agent 会话到 Hub thread 的隔离映射';

CREATE TABLE IF NOT EXISTS `bz_agent_client_runs` (
  `run_id`                 CHAR(36)     NOT NULL,
  `session_id`             CHAR(36)     NOT NULL,
  `client_app_id`          VARCHAR(64)  NOT NULL,
  `route_key`              VARCHAR(64)  NOT NULL,
  `thread_id`              BIGINT UNSIGNED NOT NULL,
  `client_conversation_id` VARCHAR(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  `client_turn_id`         VARCHAR(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  `user_message_id`        VARCHAR(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
  `request_hash`           CHAR(64)     NOT NULL,
  `user_input`             MEDIUMTEXT   NOT NULL,
  `context_json`           JSON         DEFAULT NULL,
  `status`                 VARCHAR(24)  NOT NULL DEFAULT 'preparing',
  `completion_hash`        CHAR(64)     DEFAULT NULL,
  `assistant_message_id`   VARCHAR(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin DEFAULT NULL,
  `final_content`          MEDIUMTEXT   DEFAULT NULL,
  `model`                  VARCHAR(191) DEFAULT NULL,
  `runtime`                VARCHAR(191) DEFAULT NULL,
  `usage_json`             JSON         DEFAULT NULL,
  `created_at`             DATETIME     NOT NULL,
  `updated_at`             DATETIME     NOT NULL,
  `completed_at`           DATETIME     DEFAULT NULL,
  PRIMARY KEY (`run_id`),
  UNIQUE KEY `uk_agent_turn` (`session_id`, `route_key`, `client_conversation_id`, `client_turn_id`),
  UNIQUE KEY `uk_agent_user_message` (`session_id`, `route_key`, `user_message_id`),
  UNIQUE KEY `uk_agent_assistant_message` (`session_id`, `route_key`, `assistant_message_id`),
  KEY `idx_agent_run_thread` (`thread_id`, `created_at`),
  KEY `idx_agent_run_client` (`client_app_id`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='本地 Agent Runtime 运行与幂等快照';
