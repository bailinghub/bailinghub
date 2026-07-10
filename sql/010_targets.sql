-- 百灵中枢 · 调度目标插座化 + 重试语义
-- 设计原则：中枢是"插座板"，target 不该写死在代码里——新执行器(任何机器上任何 agent)=注册一行 + 自带执行器认领，
-- 中枢代码零改动。内核只认两类：inhub(中枢进程内适配器执行) / executor(远端执行器拉取认领)。
-- database: bailinghub。初始化：npm run db:init（逐句幂等，可重复执行）

CREATE TABLE IF NOT EXISTS `bz_targets` (
  `name`          VARCHAR(64)  NOT NULL COMMENT 'target 名，路由引用',
  `kind`          VARCHAR(16)  NOT NULL DEFAULT 'executor' COMMENT 'inhub / executor',
  `stateless`     TINYINT      NOT NULL DEFAULT 0 COMMENT '无状态大脑：派活时必从总账装配上下文',
  `needs_project` TINYINT      NOT NULL DEFAULT 0 COMMENT '需要 project（代码目录）',
  `timeout_ms`    INT          NOT NULL DEFAULT 0 COMMENT 'inhub 执行超时；0=默认 120000',
  `enabled`       TINYINT      NOT NULL DEFAULT 1,
  `description`   VARCHAR(255) DEFAULT NULL,
  `created_at`    DATETIME     NOT NULL,
  `updated_at`    DATETIME     NOT NULL,
  PRIMARY KEY (`name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='调度目标注册表（插座板）';

-- 出厂只种唯一内置目标 llm（开箱即用：填一个 OpenAI 兼容凭证即可跑通）。
-- 执行器类目标（本地智能体/通知渠道等）属于部署方自己的拓扑：控制台「调度目标」注册 + 自带执行器认领，不在出厂种子里。
INSERT IGNORE INTO `bz_targets` (`name`,`kind`,`stateless`,`needs_project`,`timeout_ms`,`enabled`,`description`,`created_at`,`updated_at`) VALUES
  ('llm', 'inhub', 1, 0, 120000, 1, '中枢内直连 OpenAI 兼容大模型（凭证按名引用「模型凭证」）', NOW(), NOW());

-- 路由级重试策略：{"max":2,"backoff_ms":5000}，只对"瞬时失败"(网络/超时/5xx/429)生效；投递子任务另有内置重试
ALTER TABLE `bz_routes` ADD COLUMN `retry` JSON DEFAULT NULL COMMENT '重试策略' AFTER `knowledge`;

-- 任务重试计数
ALTER TABLE `bz_jobs` ADD COLUMN `attempts` INT NOT NULL DEFAULT 0 COMMENT '已重试次数' AFTER `claim_token`;
