-- Decision and continuation intent commit together. Job queue admission uses its
-- own durable marker so an outbox acknowledgement loss cannot requeue it twice.
CREATE TABLE IF NOT EXISTS `bz_approval_continuations` (
  `approval_id` BIGINT UNSIGNED NOT NULL,
  `intent_json` JSON NOT NULL,
  `audit_recorded_at` DATETIME DEFAULT NULL,
  `completed_at` DATETIME DEFAULT NULL,
  `created_at` DATETIME NOT NULL,
  PRIMARY KEY (`approval_id`),
  KEY `idx_approval_continuation_pending` (`completed_at`, `approval_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

ALTER TABLE `bz_jobs`
  ADD COLUMN `approval_continuation_keys` JSON DEFAULT NULL
  COMMENT 'Core-owned approval decision queue markers, never business metadata';
