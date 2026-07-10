-- 运行期短租约锁：用于 inhub 会话串行、多实例互斥等非业务持久状态。
CREATE TABLE IF NOT EXISTS `bz_runtime_locks` (
  `lock_key`   VARCHAR(191) NOT NULL COMMENT '锁名，如 serial:thread_id',
  `owner`      VARCHAR(128) NOT NULL COMMENT '持有者实例',
  `expires_at` DATETIME     NOT NULL COMMENT '租约过期时间（UTC）',
  `updated_at` DATETIME     NOT NULL,
  PRIMARY KEY (`lock_key`),
  KEY `idx_expires_at` (`expires_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='中枢运行期短租约锁';
