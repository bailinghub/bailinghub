-- 业务侧审批决策协议：保存业务审批系统的幂等键与备注，支持 webhook 安全重试。
-- 字段拆开加，避免私有部署部分字段已存在时整条 ALTER 跳过。

ALTER TABLE `bz_tool_approvals`
  ADD COLUMN `decision_id` VARCHAR(128) DEFAULT NULL COMMENT '业务侧审批决策幂等键' AFTER `status`;

ALTER TABLE `bz_tool_approvals`
  ADD COLUMN `decision_comment` VARCHAR(1000) DEFAULT NULL COMMENT '业务侧审批备注' AFTER `decided_by`;

ALTER TABLE `bz_tool_approvals`
  ADD UNIQUE KEY `uk_decision_id` (`decision_id`);
