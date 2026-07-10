-- 百灵中枢 · 工具审批车道（鉴权执行层）—— 设计见 docs/TOOLS_DESIGN.md §4.5
-- 语义：命中 confirm-required / risk=high 的调用先撤单留痕，
-- 审批人批准后任务自动重跑；批准范围锁定"当时那个具体调用快照"（job + tool + args_hash 精确匹配），重跑不允许换动作。
-- database: bailinghub。初始化：npm run db:init（逐句幂等，可重复执行）

CREATE TABLE IF NOT EXISTS `bz_tool_approvals` (
  `id`           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `job_id`       CHAR(36)     NOT NULL COMMENT '哪个任务里发起的调用',
  `request_id`   VARCHAR(191) NOT NULL,
  `provider`     VARCHAR(64)  NOT NULL COMMENT '工具源名',
  `tool`         VARCHAR(64)  NOT NULL,
  `scope`        VARCHAR(128) NOT NULL,
  `risk`         VARCHAR(16)  NOT NULL COMMENT 'ACC risk.level 快照',
  `method`       VARCHAR(8)   DEFAULT NULL,
  `path`         VARCHAR(512) DEFAULT NULL,
  `args_json`    MEDIUMTEXT   COMMENT '调用参数全量快照（批准的就是这一份，不是"这类操作"）',
  `args_hash`    CHAR(64)     NOT NULL COMMENT 'sha256(canonical args)，重跑时精确匹配',
  `on_behalf_of` VARCHAR(191) DEFAULT NULL COMMENT '代表谁调用（metadata[subject_field] 快照）',
  `status`       VARCHAR(16)  NOT NULL DEFAULT 'pending' COMMENT 'pending / approved / denied',
  `decided_by`   VARCHAR(64)  DEFAULT NULL COMMENT '审批人（控制台账号 / token）',
  `decided_at`   DATETIME     DEFAULT NULL,
  `used_at`      DATETIME     DEFAULT NULL COMMENT '批准后被消费的时刻；一单一次，防重放',
  `created_at`   DATETIME     NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_job` (`job_id`),
  KEY `idx_status` (`status`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='工具调用审批单（确认车道：先撤再来）';
