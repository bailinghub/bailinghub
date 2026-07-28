-- 将“成功后才登记”的幂等缓存升级为副作用工具执行日志。
-- 请求发出前先写 dispatching；任何未完成状态都必须人工对账，恢复调度器不得自动重放。
ALTER TABLE `bz_tool_calls`
  ADD COLUMN `scope` VARCHAR(191) NOT NULL DEFAULT '' AFTER `tool`;

ALTER TABLE `bz_tool_calls`
  ADD COLUMN `state` VARCHAR(32) NOT NULL DEFAULT 'completed' AFTER `args_hash`;

ALTER TABLE `bz_tool_calls`
  ADD COLUMN `idempotency_key` CHAR(64) NULL AFTER `state`;

ALTER TABLE `bz_tool_calls`
  ADD COLUMN `error` VARCHAR(500) NULL AFTER `result_json`;

ALTER TABLE `bz_tool_calls`
  ADD COLUMN `updated_at` DATETIME NULL AFTER `created_at`;

ALTER TABLE `bz_tool_calls`
  ADD KEY `idx_tool_calls_state_updated` (`state`,`updated_at`);
