-- 百灵中枢 · 状态库表结构（database: bailinghub）
-- 解耦硬边界：独立库、bz_ 前缀，绝不与业务库混用。
-- 本文件只建表，连接时应已选定该库，故不含 CREATE DATABASE / USE。
-- 初始化（可重复执行，IF NOT EXISTS）：npm run db:init

-- 调查任务（单一真值源）
CREATE TABLE IF NOT EXISTS `bz_jobs` (
  `job_id`        CHAR(36)     NOT NULL COMMENT 'UUID',
  `request_id`    VARCHAR(128) NOT NULL COMMENT '业务幂等键',
  `status`        VARCHAR(16)  NOT NULL DEFAULT 'queued' COMMENT 'queued/running/done/error/rejected',
  `profile`       VARCHAR(64)  NOT NULL COMMENT '能力档',
  `target`        VARCHAR(32)  DEFAULT NULL COMMENT '发给哪个 target: llm/executor/custom',
  `project`       VARCHAR(128) NOT NULL DEFAULT '' COMMENT '目标项目名（llm 可空）',
  `source`        VARCHAR(32)  NOT NULL DEFAULT 'unknown' COMMENT '来源 ticket/manual/device',
  `session_id`    CHAR(36)     DEFAULT NULL COMMENT '模型或执行器会话 id，可用于续聊',
  `input_preview` VARCHAR(512) NOT NULL DEFAULT '' COMMENT '输入摘要（审计用，非完整 input）',
  `report`        JSON         DEFAULT NULL COMMENT '结构化报告',
  `result`        JSON         DEFAULT NULL COMMENT '适配器统一输出 {text}/{report}',
  `raw_result`    MEDIUMTEXT   DEFAULT NULL COMMENT '报告解析失败时的原始输出',
  `usage`         JSON         DEFAULT NULL COMMENT '耗时/回合/成本',
  `error`         VARCHAR(1024) DEFAULT NULL,
  `metadata`      JSON         DEFAULT NULL COMMENT '业务透传',
  `callback_url`  VARCHAR(512) DEFAULT NULL,
  `claimed_at`    DATETIME     DEFAULT NULL COMMENT '最近一次被 worker/executor 原子认领的时间',
  `lease_until`   DATETIME     DEFAULT NULL COMMENT '当前认领租约到期时间；到期未续租则可恢复回队列',
  `created_at`    DATETIME     NOT NULL,
  `updated_at`    DATETIME     NOT NULL,
  PRIMARY KEY (`job_id`),
  UNIQUE KEY `uk_request_id` (`request_id`),
  KEY `idx_status` (`status`),
  KEY `idx_job_lease` (`status`, `lease_until`),
  KEY `idx_project_created` (`project`, `created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='中枢调查任务';

-- 审计流水（谁触发、读了什么、做了什么、依据什么）
CREATE TABLE IF NOT EXISTS `bz_audit` (
  `id`         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `ts`         DATETIME     NOT NULL,
  `job_id`     CHAR(36)     DEFAULT NULL,
  `request_id` VARCHAR(128) DEFAULT NULL,
  `event`      VARCHAR(64)  NOT NULL COMMENT 'received/started/finished/rejected/callback/...',
  `stage`      VARCHAR(32)  NOT NULL DEFAULT 'system' COMMENT 'launch/context/execution/tool/approval/delivery/summary/recovery/channel/config/system',
  `severity`   VARCHAR(16)  NOT NULL DEFAULT 'info' COMMENT 'info/warning/error',
  `title`      VARCHAR(128) NOT NULL DEFAULT '' COMMENT '面向人展示的事件标题',
  `summary`    VARCHAR(512) NOT NULL DEFAULT '' COMMENT '面向人展示的一行摘要',
  `detail`     JSON         DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_job` (`job_id`),
  KEY `idx_stage` (`stage`, `severity`),
  KEY `idx_ts` (`ts`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='中枢审计流水';

-- 审批队列（P2 启用：分级动作网关的人工环节）
CREATE TABLE IF NOT EXISTS `bz_approvals` (
  `id`          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `job_id`      CHAR(36)     NOT NULL,
  `action`      JSON         NOT NULL COMMENT '提议动作（含 risk/reversible）',
  `status`      VARCHAR(16)  NOT NULL DEFAULT 'pending' COMMENT 'pending/approved/rejected/expired',
  `decided_by`  VARCHAR(128) DEFAULT NULL COMMENT '审批人（业务侧身份）',
  `channel`     VARCHAR(32)  DEFAULT NULL COMMENT '审批渠道 wecom/web',
  `created_at`  DATETIME     NOT NULL,
  `decided_at`  DATETIME     DEFAULT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_job` (`job_id`),
  KEY `idx_status` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='中枢动作审批队列（P2）';
