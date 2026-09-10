-- Additive opt-in for cross-client/route audit membership. Legacy v1 rows keep
-- their original single binding; no Session, run, invocation or text is moved.
ALTER TABLE `bz_agent_conversation_audits` ADD COLUMN `membership_version` TINYINT UNSIGNED NOT NULL DEFAULT 1 COMMENT '1=legacy common binding, 2=explicit per-member binding';

ALTER TABLE `bz_agent_conversation_members` ADD COLUMN `client_app_id` VARCHAR(64) DEFAULT NULL COMMENT 'Frozen original Client App, NULL for legacy v1';

ALTER TABLE `bz_agent_conversation_members` ADD COLUMN `route_key` VARCHAR(64) DEFAULT NULL COMMENT 'Frozen original route/workspace, NULL for legacy v1';

ALTER TABLE `bz_agent_conversation_members` ADD COLUMN `client_name` VARCHAR(128) DEFAULT NULL COMMENT 'Display snapshot only, never identity or authorization';
