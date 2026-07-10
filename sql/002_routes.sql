-- 百灵中枢 · 触发路由配置（web 后台管理，动态驱动 runner，替代文件写死）
-- database: bailinghub。初始化：npm run db:init（会按文件名顺序跑 sql/*.sql）

-- 项目目录注册表（项目名 → Mac 上绝对目录）
CREATE TABLE IF NOT EXISTS `bz_projects` (
  `name`        VARCHAR(64)  NOT NULL COMMENT '项目名（业务/路由引用）',
  `path`        VARCHAR(512) NOT NULL COMMENT 'Mac 上的绝对目录',
  `enabled`     TINYINT      NOT NULL DEFAULT 1,
  `description` VARCHAR(255) DEFAULT NULL,
  `created_at`  DATETIME     NOT NULL,
  `updated_at`  DATETIME     NOT NULL,
  PRIMARY KEY (`name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='项目目录注册表';

-- 触发路由：某业务场景 → 项目 / 会话策略 / 能力档
CREATE TABLE IF NOT EXISTS `bz_routes` (
  `route_key`         VARCHAR(64)  NOT NULL COMMENT '触发场景标识，业务调用时传，如 ticket-triage',
  `name`              VARCHAR(128) NOT NULL COMMENT '人类可读名称',
  `enabled`           TINYINT      NOT NULL DEFAULT 1,
  `target`            VARCHAR(32)  NOT NULL DEFAULT 'llm' COMMENT '发给哪个 AI/通道（「调度目标」注册表中的 target 名）',
  `target_config`     JSON         DEFAULT NULL COMMENT 'target 专属参数（llm:{credential,model,system_prompt}）',
  `project`           VARCHAR(64)  DEFAULT NULL COMMENT '目标项目（注册表标 needs_project 的目标需要）',
  `profile`           VARCHAR(64)  NOT NULL DEFAULT 'readonly' COMMENT '能力档',
  `session_policy`    VARCHAR(16)  NOT NULL DEFAULT 'new' COMMENT 'new / fixed / per_key',
  `session_fixed_id`  CHAR(36)     DEFAULT NULL COMMENT 'policy=fixed 时固定续聊的会话 id',
  `session_key_field` VARCHAR(64)  DEFAULT NULL COMMENT 'policy=per_key 时取 metadata 的哪个字段做会话键，如 ticket_id',
  `default_callback_url` VARCHAR(512) DEFAULT NULL,
  `description`       VARCHAR(255) DEFAULT NULL,
  `created_at`        DATETIME     NOT NULL,
  `updated_at`        DATETIME     NOT NULL,
  PRIMARY KEY (`route_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='触发路由配置';

-- 路由会话映射（会话一致性：同一 route + 同一 scope_key → 同一个 Claude 会话）
CREATE TABLE IF NOT EXISTS `bz_sessions` (
  `id`           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `route_key`    VARCHAR(64)  NOT NULL,
  `scope_key`    VARCHAR(191) NOT NULL COMMENT 'per_key 的键值 / fixed 用 __singleton__',
  `session_id`   CHAR(36)     NOT NULL COMMENT 'Claude 会话 uuid',
  `created_at`   DATETIME     NOT NULL,
  `last_used_at` DATETIME     NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uk_route_scope` (`route_key`, `scope_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='路由会话映射（会话一致性）';
