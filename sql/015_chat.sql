-- 百灵中枢 · 聊天入口（网页聊天组件的公开插座）—— 契约见 docs/CONTRACT.md §1.1
-- 类网站统计的接入模式：控制台建入口 → 拿一行 <script> 贴进任何网页。entry_key 设计为可公开（页面源码里能看到），
-- 防滥用靠：Origin 白名单 + 按 IP 限速 + 可随时停用/删除。落点是「触发路由」——背后是 llm 还是执行器智能体，入口无感。
-- 身份纪律：网页访客=匿名主体，组件只能带 visitor_id（会话连续性用），永远带不了业务操作主体（on-behalf-of 恒空，写工具业务侧自然拒）。
-- database: bailinghub。初始化：npm run db:init（逐句幂等，可重复执行）

CREATE TABLE IF NOT EXISTS `bz_chat_entries` (
  `entry_key`        VARCHAR(32)  NOT NULL COMMENT '公开入口钥（pub_<16hex>，服务端生成）',
  `name`             VARCHAR(64)  NOT NULL COMMENT '后台管理名',
  `route_key`        VARCHAR(64)  NOT NULL COMMENT '绑定的触发路由（决定大脑/知识库/工具）',
  `enabled`          TINYINT      NOT NULL DEFAULT 1,
  `allowed_origins`  JSON         DEFAULT NULL COMMENT '允许嵌入的站点 Origin 白名单（空=不限，试用模式）',
  `rate_limit_per_min` INT        NOT NULL DEFAULT 20 COMMENT '按访客 IP 限速（次/分钟）',
  `title`            VARCHAR(64)  DEFAULT NULL COMMENT '组件标题（缺省用 name）',
  `greeting`         VARCHAR(255) DEFAULT NULL COMMENT '开场白（组件首条气泡）',
  `color`            VARCHAR(16)  DEFAULT NULL COMMENT '组件主色（hex，缺省暖棕）',
  `description`      VARCHAR(255) DEFAULT NULL,
  `created_at`       DATETIME     NOT NULL,
  `updated_at`       DATETIME     NOT NULL,
  PRIMARY KEY (`entry_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='聊天入口（网页组件的公开插座，绑路由不绑大脑）';
