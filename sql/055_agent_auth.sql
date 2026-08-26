-- 055: 本地 Agent 基于业务系统网页授权的可撤销持久会话。
-- 只建身份与授权账本；不包含套餐、付费、权益或用量语义。

ALTER TABLE `bz_clients`
  ADD COLUMN `agent_authorize_url` VARCHAR(2048) DEFAULT NULL COMMENT '业务侧 Agent 网页授权入口' AFTER `token`;

ALTER TABLE `bz_jobs`
  ADD COLUMN `agent_session_id` CHAR(36) DEFAULT NULL COMMENT '受信本地 Agent 会话归属' AFTER `client_app_id`;

ALTER TABLE `bz_jobs`
  ADD COLUMN `on_behalf_of` VARCHAR(191) DEFAULT NULL COMMENT '业务侧批准的操作主体' AFTER `agent_session_id`;

ALTER TABLE `bz_jobs`
  ADD KEY `idx_agent_session` (`agent_session_id`, `created_at`);

CREATE TABLE IF NOT EXISTS `bz_agent_authorizations` (
  `authorization_id` CHAR(36)      NOT NULL,
  `client_app_id`    VARCHAR(64)   NOT NULL,
  `redirect_uri`     VARCHAR(2048) NOT NULL COMMENT '创建时锁定的 loopback redirect',
  `state_value`      VARCHAR(512)  NOT NULL,
  `requested_routes` JSON         NOT NULL,
  `device_label`     VARCHAR(128)  NOT NULL,
  `code_challenge`   CHAR(43)      NOT NULL COMMENT 'PKCE S256 base64url digest',
  `status`           VARCHAR(16)   NOT NULL DEFAULT 'pending',
  `principal_json`   JSON          DEFAULT NULL,
  `on_behalf_of`     VARCHAR(191)  DEFAULT NULL,
  `allowed_routes`   JSON          DEFAULT NULL,
  `code_hash`        CHAR(64)      DEFAULT NULL COMMENT '一次性 authorization code SHA-256',
  `code_expires_at`  DATETIME      DEFAULT NULL COMMENT '批准后的短时兑换截止时间',
  `session_id`       CHAR(36)      DEFAULT NULL,
  `created_at`       DATETIME      NOT NULL,
  `expires_at`       DATETIME      NOT NULL,
  `approved_at`      DATETIME      DEFAULT NULL,
  `consumed_at`      DATETIME      DEFAULT NULL,
  PRIMARY KEY (`authorization_id`),
  UNIQUE KEY `uk_agent_auth_code_hash` (`code_hash`),
  KEY `idx_agent_auth_client` (`client_app_id`, `created_at`),
  KEY `idx_agent_auth_expires` (`status`, `expires_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='本地 Agent 一次性网页授权请求';

CREATE TABLE IF NOT EXISTS `bz_agent_sessions` (
  `session_id`          CHAR(36)      NOT NULL,
  `client_app_id`       VARCHAR(64)   NOT NULL,
  `device_label`        VARCHAR(128)  NOT NULL,
  `principal_json`      JSON          NOT NULL,
  `on_behalf_of`        VARCHAR(191)  NOT NULL,
  `allowed_routes`      JSON          NOT NULL,
  `access_token_hash`   CHAR(64)      NOT NULL COMMENT '当前 access token SHA-256',
  `access_expires_at`   DATETIME      NOT NULL,
  `refresh_expires_at`  DATETIME      NOT NULL,
  `created_at`          DATETIME      NOT NULL,
  `updated_at`          DATETIME      NOT NULL,
  `last_seen_at`        DATETIME      DEFAULT NULL,
  `revoked_at`          DATETIME      DEFAULT NULL,
  PRIMARY KEY (`session_id`),
  UNIQUE KEY `uk_agent_access_hash` (`access_token_hash`),
  KEY `idx_agent_session_client` (`client_app_id`, `created_at`),
  KEY `idx_agent_session_refresh_exp` (`refresh_expires_at`),
  KEY `idx_agent_session_revoked` (`revoked_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='可撤销本地 Agent 会话';

CREATE TABLE IF NOT EXISTS `bz_agent_refresh_tokens` (
  `token_hash`    CHAR(64)    NOT NULL COMMENT 'refresh token SHA-256',
  `session_id`    CHAR(36)    NOT NULL,
  `status`        VARCHAR(16) NOT NULL DEFAULT 'active' COMMENT 'active|used|replayed|revoked',
  `created_at`    DATETIME    NOT NULL,
  `expires_at`    DATETIME    NOT NULL,
  `used_at`       DATETIME    DEFAULT NULL,
  PRIMARY KEY (`token_hash`),
  KEY `idx_agent_refresh_session` (`session_id`, `created_at`),
  KEY `idx_agent_refresh_expires` (`status`, `expires_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Agent refresh token 轮换与重放检测账本';
