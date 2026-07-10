ALTER TABLE `bz_jobs` ADD COLUMN `run_after` DATETIME DEFAULT NULL COMMENT 'queued 任务最早可认领时间（重试退避/延迟调度）' AFTER `attempts`;

ALTER TABLE `bz_jobs` ADD KEY `idx_inhub_claim` (`status`, `target`, `run_after`, `created_at`);
