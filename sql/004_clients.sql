-- 百灵中枢 · 接入方（per-caller 凭证与策略）
-- 开放接入模型：每个业务系统一把可单独吊销的钥匙 + 路由白名单 + 限速。
-- database: bailinghub。初始化：npm run db:init（逐句幂等，可重复执行）

CREATE TABLE IF NOT EXISTS `bz_clients` (
  `app_id`             VARCHAR(64)  NOT NULL COMMENT '接入方标识，如 server-tickets',
  `name`               VARCHAR(128) NOT NULL COMMENT '人类可读名称，如 示例业务·工单系统',
  `token`              CHAR(32)     NOT NULL COMMENT '调用凭证（服务端生成，可换钥）',
  `allowed_routes`     JSON         DEFAULT NULL COMMENT '可调路由白名单，["*"] 表示全部',
  `rate_limit_per_min` INT          NOT NULL DEFAULT 60 COMMENT '每分钟限速，0=不限',
  `enabled`            TINYINT      NOT NULL DEFAULT 1,
  `description`        VARCHAR(255) DEFAULT NULL,
  `last_used_at`       DATETIME     DEFAULT NULL COMMENT '最近一次成功调用',
  `created_at`         DATETIME     NOT NULL,
  `updated_at`         DATETIME     NOT NULL,
  PRIMARY KEY (`app_id`),
  UNIQUE KEY `uk_token` (`token`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='接入方（业务系统）凭证与策略';

-- 任务记录触发方：可观测/审计/将来按接入方计量
ALTER TABLE `bz_jobs` ADD COLUMN `client_app_id` VARCHAR(64) DEFAULT NULL COMMENT '触发方 app_id（admin token 触发为 NULL）' AFTER `source`;
ALTER TABLE `bz_jobs` ADD KEY `idx_client` (`client_app_id`, `created_at`);
