-- 送达死信队列（最终失败可查可重投）
-- 送达最终失败（executor-notify 子任务重试耗尽 / 内联渠道 channelSend 失败）的消息落表，
-- 配合 delivery_failed_* 告警形成"失败不静默丢、可追溯、可手动重投"闭环。
CREATE TABLE IF NOT EXISTS `bz_delivery_dlq` (
  `id` BIGINT AUTO_INCREMENT PRIMARY KEY,
  `parent_job_id` VARCHAR(191) NOT NULL DEFAULT '',
  `channel` VARCHAR(191) NOT NULL DEFAULT '',
  `recipient` VARCHAR(512) NOT NULL DEFAULT '',
  `content` MEDIUMTEXT,
  `error` TEXT,
  `resolved` TINYINT(1) NOT NULL DEFAULT 0,
  `created_at` DATETIME NOT NULL,
  `resolved_at` DATETIME NULL,
  KEY `idx_resolved` (`resolved`,`id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='送达死信队列（最终失败可查可重投）';
