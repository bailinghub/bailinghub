-- 百灵中枢 · 聊天评价 + 签名访客票据（运营闭环两件套）—— 契约见 docs/CONTRACT.md §1.1
-- 评价：访客对每条回答点有用/没用，或提交文字反馈，知识库运营按反馈迭代（最小反馈闭环）。
-- 票据：业务后端用自己的接入方 token 给登录用户签短票，widget 携带 → 可信身份进 metadata（身份仍在服务端可信代码确立，总纲不破）。
-- database: bailinghub。初始化：npm run db:init（逐句幂等，可重复执行）

CREATE TABLE IF NOT EXISTS `bz_job_ratings` (
  `job_id`     CHAR(36)     NOT NULL COMMENT '评价的是哪次回答（一答一评，重评覆盖）',
  `entry_key`  VARCHAR(32)  NOT NULL COMMENT '来自哪个聊天入口',
  `visitor_id` VARCHAR(64)  NOT NULL COMMENT '谁评的（只能评自己问出来的）',
  `rating`     VARCHAR(8)   NOT NULL COMMENT 'up / down / note',
  `comment`    VARCHAR(500) DEFAULT NULL,
  `created_at` DATETIME     NOT NULL,
  `updated_at` DATETIME     NOT NULL,
  PRIMARY KEY (`job_id`),
  KEY `idx_entry` (`entry_key`, `updated_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='聊天回答评价（运营反馈闭环）';

-- 票据签发方：该入口接受哪个接入方 token 签出的访客票据（NULL=不启用票据，纯匿名）
ALTER TABLE `bz_chat_entries` ADD COLUMN `ticket_client` VARCHAR(64) DEFAULT NULL COMMENT '签发访客票据的接入方 app_id' AFTER `rate_limit_per_min`;
