-- 审计流水升级为结构化 trace：写入时固化 stage/severity/title/summary，不再由前端按 event/detail 猜。
ALTER TABLE `bz_audit`
  ADD COLUMN `stage` VARCHAR(32) NOT NULL DEFAULT 'system' COMMENT 'launch/context/execution/tool/approval/delivery/summary/recovery/channel/config/system' AFTER `event`;

ALTER TABLE `bz_audit`
  ADD COLUMN `severity` VARCHAR(16) NOT NULL DEFAULT 'info' COMMENT 'info/warning/error' AFTER `stage`;

ALTER TABLE `bz_audit`
  ADD COLUMN `title` VARCHAR(128) NOT NULL DEFAULT '' COMMENT '面向人展示的事件标题' AFTER `severity`;

ALTER TABLE `bz_audit`
  ADD COLUMN `summary` VARCHAR(512) NOT NULL DEFAULT '' COMMENT '面向人展示的一行摘要' AFTER `title`;

ALTER TABLE `bz_audit`
  ADD KEY `idx_stage` (`stage`, `severity`);
