CREATE TABLE IF NOT EXISTS `bz_rate_limits` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `bucket` VARCHAR(190) NOT NULL,
  `created_at` DATETIME NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_bucket_created` (`bucket`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='集中限速事件账本（入口限速、登录防爆破等）';
