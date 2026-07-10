ALTER TABLE `bz_jobs` ADD COLUMN `claimed_at` DATETIME DEFAULT NULL COMMENT '最近一次被 worker/executor 原子认领的时间' AFTER `run_after`;

ALTER TABLE `bz_jobs` ADD COLUMN `lease_until` DATETIME DEFAULT NULL COMMENT '当前认领租约到期时间；到期未续租则可恢复回队列' AFTER `claimed_at`;

ALTER TABLE `bz_jobs` ADD KEY `idx_job_lease` (`status`, `lease_until`);

ALTER TABLE `bz_jobs` ADD KEY `idx_thread_claim` (`thread_id`, `status`, `created_at`);
