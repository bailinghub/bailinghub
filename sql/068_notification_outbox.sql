-- Intentions are committed beside their owning Job or approval, before delivery.
CREATE TABLE IF NOT EXISTS `bz_notification_outbox` (
  `event_id` VARCHAR(191) NOT NULL,
  `kind` VARCHAR(32) NOT NULL,
  `job_id` VARCHAR(191) NOT NULL,
  `request_id` VARCHAR(191) NOT NULL,
  `payload_json` JSON NOT NULL,
  `status` VARCHAR(24) NOT NULL DEFAULT 'pending',
  `recovery` VARCHAR(16) NOT NULL DEFAULT 'retry',
  `attempts` INT UNSIGNED NOT NULL DEFAULT 0,
  `cycle_attempts` INT UNSIGNED NOT NULL DEFAULT 0,
  `available_at` DATETIME(3) NOT NULL,
  `lease_token` VARCHAR(64) DEFAULT NULL,
  `lease_owner` VARCHAR(191) DEFAULT NULL,
  `lease_until` DATETIME(3) DEFAULT NULL,
  `last_error` VARCHAR(96) DEFAULT NULL,
  `created_at` DATETIME(3) NOT NULL,
  `updated_at` DATETIME(3) NOT NULL,
  `completed_at` DATETIME(3) DEFAULT NULL,
  PRIMARY KEY (`event_id`),
  KEY `idx_notification_due` (`kind`,`status`,`available_at`),
  KEY `idx_notification_lease` (`kind`,`status`,`lease_until`),
  KEY `idx_notification_job` (`job_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

ALTER TABLE `bz_delivery_dlq`
  ADD COLUMN `event_id` VARCHAR(191) DEFAULT NULL,
  ADD UNIQUE KEY `uk_delivery_dlq_event` (`event_id`);
