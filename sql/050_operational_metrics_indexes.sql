-- 百灵中枢 · OpenMetrics 运维聚合查询索引。
-- 只增加索引，不修改任务、审批或执行器协议语义。

ALTER TABLE `bz_jobs`
  ADD KEY `idx_job_status_updated` (`status`, `updated_at`);

ALTER TABLE `bz_executors`
  ADD KEY `idx_executor_last_seen` (`last_seen_at`);
