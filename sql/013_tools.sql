-- 百灵中枢 · 工具插座（鉴权执行层）—— 设计见 docs/TOOLS_DESIGN.md
-- 业务系统在自己的 OpenAPI 上标 x-agent-capability 声明可调接口，注册为"工具源"；路由挂 allow 白名单后 Agent 即可经中枢统一出口调用。
-- database: bailinghub。初始化：npm run db:init（逐句幂等，可重复执行）

CREATE TABLE IF NOT EXISTS `bz_tool_providers` (
  `name`             VARCHAR(64)  NOT NULL COMMENT '工具源名，路由引用',
  `base_url`         VARCHAR(512) NOT NULL COMMENT '调用前缀，如 https://server.example.com',
  `spec_source`      VARCHAR(8)   NOT NULL DEFAULT 'inline' COMMENT 'url=从 spec_url 拉取 / inline=直接粘贴',
  `spec_url`         VARCHAR(512) DEFAULT NULL,
  `spec_json`        MEDIUMTEXT   COMMENT 'OpenAPI spec（url 拉取后的缓存 / inline 原文）',
  `spec_refreshed_at` DATETIME    DEFAULT NULL,
  `secret`           VARCHAR(128) NOT NULL COMMENT '调用签名密钥（sha256=），与触发方 token/server token 解耦，单独轮换',
  `log_payload`      TINYINT      NOT NULL DEFAULT 1 COMMENT '审计记参数全量值（≤4KB 截断）；0=只记键名',
  `timeout_ms`       INT          NOT NULL DEFAULT 10000 COMMENT '单次工具调用超时',
  `rate_limit_per_min` INT        NOT NULL DEFAULT 120 COMMENT '该源总闸（次/分钟）；0=不限',
  `enabled`          TINYINT      NOT NULL DEFAULT 1,
  `description`      VARCHAR(255) DEFAULT NULL,
  `created_at`       DATETIME     NOT NULL,
  `updated_at`       DATETIME     NOT NULL,
  PRIMARY KEY (`name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='工具源注册表（业务系统的 Agent 可调接口清单）';

-- 路由挂工具：{"provider":"x","allow":["tenant.staff.read","store.*"],"max_calls":5,"subject_field":"operator_uid"}
ALTER TABLE `bz_routes` ADD COLUMN `tools` JSON DEFAULT NULL COMMENT '工具白名单配置' AFTER `retry`;
