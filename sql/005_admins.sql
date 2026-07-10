-- 百灵中枢 · 管理员账号与登录会话（admin 后台从 token 升级为账号密码 + Cookie 会话）
-- database: bailinghub。初始化：npm run db:init（逐句幂等，可重复执行）
-- 首个账号：npm run admin:create -- <username> [password]（不传密码则随机生成并打印）

CREATE TABLE IF NOT EXISTS `bz_admins` (
  `username`      VARCHAR(64)  NOT NULL,
  `password_hash` VARCHAR(255) NOT NULL COMMENT 'scrypt：s1$salthex$hashhex',
  `display_name`  VARCHAR(128) DEFAULT NULL,
  `enabled`       TINYINT      NOT NULL DEFAULT 1,
  `last_login_at` DATETIME     DEFAULT NULL,
  `created_at`    DATETIME     NOT NULL,
  `updated_at`    DATETIME     NOT NULL,
  PRIMARY KEY (`username`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='后台管理员账号';

CREATE TABLE IF NOT EXISTS `bz_admin_sessions` (
  `session_id`   CHAR(48)    NOT NULL COMMENT '随机 24 字节 hex',
  `username`     VARCHAR(64) NOT NULL,
  `created_at`   DATETIME    NOT NULL,
  `expires_at`   DATETIME    NOT NULL,
  `last_seen_at` DATETIME    NOT NULL,
  PRIMARY KEY (`session_id`),
  KEY `idx_user` (`username`),
  KEY `idx_expires` (`expires_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='后台登录会话';
