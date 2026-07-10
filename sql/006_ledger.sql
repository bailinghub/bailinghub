-- 百灵中枢 · 对话总账 + 身份归一（角色宪法的地基：状态是王座，大脑是缓存）
-- 总账=唯一真值（谁、哪条线索、哪个渠道、说了什么、哪个 job 产生了哪条回复）；
-- 各大脑会话只是工作记忆/缓存，丢了从总账重建。单一写入者=中枢。
-- database: bailinghub。初始化：npm run db:init（逐句幂等，可重复执行）

-- 身份归一：终端用户的统一身份（业务层鉴权出"这是谁"，中枢只认声明并归一）
CREATE TABLE IF NOT EXISTS `bz_principals` (
  `principal_id` VARCHAR(64)  NOT NULL COMMENT '统一身份标识，如 p-guojunjie',
  `display_name` VARCHAR(128) DEFAULT NULL,
  `description`  VARCHAR(255) DEFAULT NULL,
  `created_at`   DATETIME     NOT NULL,
  `updated_at`   DATETIME     NOT NULL,
  PRIMARY KEY (`principal_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='终端用户统一身份';

-- 渠道身份映射：同一个人在企微/app/网页的各渠道 uid → principal
CREATE TABLE IF NOT EXISTS `bz_principal_channels` (
  `channel`      VARCHAR(32)  NOT NULL COMMENT '渠道：wecom / app / web / 业务系统名',
  `channel_uid`  VARCHAR(191) NOT NULL COMMENT '该渠道下的用户标识',
  `principal_id` VARCHAR(64)  NOT NULL,
  `created_at`   DATETIME     NOT NULL,
  PRIMARY KEY (`channel`, `channel_uid`),
  KEY `idx_principal` (`principal_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='渠道身份→统一身份映射';

-- 对话线索：用户/场景 × 话题（与 bz_sessions 同 scope 语义，会话=该线索在某大脑上的缓存）
CREATE TABLE IF NOT EXISTS `bz_threads` (
  `thread_id`      BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `route_key`      VARCHAR(64)  NOT NULL,
  `scope_key`      VARCHAR(191) NOT NULL COMMENT 'per_key 键值 / fixed=__singleton__ / new=req:<request_id>',
  `principal_id`   VARCHAR(64)  DEFAULT NULL,
  `summary`        TEXT         DEFAULT NULL COMMENT '滚动摘要（超窗后补）',
  `message_count`  INT          NOT NULL DEFAULT 0,
  `created_at`     DATETIME     NOT NULL,
  `last_active_at` DATETIME     NOT NULL,
  PRIMARY KEY (`thread_id`),
  UNIQUE KEY `uk_route_scope` (`route_key`, `scope_key`),
  KEY `idx_principal` (`principal_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='对话线索';

-- 消息总账：append-only，进出都记，关联 job 可回放
CREATE TABLE IF NOT EXISTS `bz_messages` (
  `id`           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `thread_id`    BIGINT UNSIGNED NOT NULL,
  `direction`    VARCHAR(8)   NOT NULL COMMENT 'in / out',
  `channel`      VARCHAR(64)  NOT NULL COMMENT '来源/去向：接入方 app_id / admin / hub / wecom…',
  `principal_id` VARCHAR(64)  DEFAULT NULL,
  `job_id`       CHAR(36)     DEFAULT NULL,
  `content`      MEDIUMTEXT   NOT NULL,
  `created_at`   DATETIME     NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_thread` (`thread_id`, `id`),
  KEY `idx_job` (`job_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='消息总账（append-only）';

-- job 关联线索：finish 时回写 out 消息用
ALTER TABLE `bz_jobs` ADD COLUMN `thread_id` BIGINT UNSIGNED DEFAULT NULL COMMENT '所属对话线索' AFTER `client_app_id`;
