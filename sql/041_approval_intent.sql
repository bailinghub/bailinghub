-- 工具审批意图结构化：审批单从技术快照升级为业务可读的 ApprovalIntent
-- policy/reason/summary 是高频展示字段；intent_json 是控制台、业务 webhook、trace 可共用的完整意图快照。

ALTER TABLE `bz_tool_approvals`
  ADD COLUMN `policy` VARCHAR(64) DEFAULT NULL COMMENT '审批策略来源：risk_high / confirm_required / confirm_when' AFTER `risk`;

ALTER TABLE `bz_tool_approvals`
  ADD COLUMN `reason` VARCHAR(512) DEFAULT NULL COMMENT '进入审批的原因（给审批人和 trace 看）' AFTER `policy`;

ALTER TABLE `bz_tool_approvals`
  ADD COLUMN `summary` VARCHAR(512) DEFAULT NULL COMMENT '审批动作摘要（通常由 ACC approval.prompt 渲染）' AFTER `path`;

ALTER TABLE `bz_tool_approvals`
  ADD COLUMN `intent_json` JSON DEFAULT NULL COMMENT '标准 ApprovalIntent 快照，锁定审批上下文' AFTER `args_hash`;
