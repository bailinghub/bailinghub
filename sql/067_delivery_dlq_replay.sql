-- Keep native channels separate from executor notification targets. Legacy rows
-- stay unclassified until their original job can be checked by Core.
ALTER TABLE `bz_delivery_dlq`
  ADD COLUMN `delivery_kind` VARCHAR(24) DEFAULT NULL,
  ADD COLUMN `notification_job_id` VARCHAR(191) DEFAULT NULL,
  ADD COLUMN `executor_replay_key` VARCHAR(191) DEFAULT NULL;

ALTER TABLE `bz_jobs`
  ADD COLUMN `delivery_replay_keys` JSON DEFAULT NULL
  COMMENT 'Core-owned notification DLQ queue markers, never business metadata';
