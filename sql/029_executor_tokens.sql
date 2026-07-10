-- 029: 执行器接入令牌。把执行器通道(claim/result)的鉴权从「中枢管理员 token」收窄为
-- 可吊销、按 target 白名单授权、可审计的专用令牌——第三方挂执行器不再需要交出管理员 token。drop-in 新表。
CREATE TABLE IF NOT EXISTS `bz_executor_tokens` (
  `name`            VARCHAR(64)  NOT NULL PRIMARY KEY COMMENT '人可读标识，如 mac-claude / partner-codex',
  `token`           VARCHAR(128) NOT NULL COMMENT '实际令牌（随机串，执行器 claim/result 用）',
  `allowed_targets` JSON         NOT NULL COMMENT '可认领的 target 白名单：["*"] 或 ["llm","my-agent"]',
  `enabled`         TINYINT      NOT NULL DEFAULT 1,
  `last_seen_at`    DATETIME     NULL COMMENT '最近一次用此令牌 claim（观测/审计）',
  `description`     VARCHAR(255) NULL,
  `created_at`      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`      DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY `uk_token` (`token`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='执行器接入令牌（claim/result 鉴权，替代共享管理员 token）';
