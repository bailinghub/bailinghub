-- 百灵中枢 · 派活/执行器（database: bailinghub）
-- executor / custom 等本地或外部 target 不在中枢内跑，而是入队等执行器认领：
--   ① 业务 POST /run → 中枢建 job(queued) 留在队列
--   ② 执行器 POST /executor/claim（出站长轮询）原子认领 → job 转 dispatched
--   ③ 执行器本地执行后 POST /executor/result → job 转 done/error
-- 下列为对 bz_jobs 的增量加列（幂等由 init-db 运行器对"列/键已存在"错误的容错保证）。

ALTER TABLE `bz_jobs` ADD COLUMN `input`         MEDIUMTEXT DEFAULT NULL COMMENT '完整输入（远端执行器认领时回传）' AFTER `input_preview`;
ALTER TABLE `bz_jobs` ADD COLUMN `dispatch`      JSON       DEFAULT NULL COMMENT '远端执行快照 {target_config,is_continue}' AFTER `input`;
ALTER TABLE `bz_jobs` ADD COLUMN `executor_id`   VARCHAR(64) DEFAULT NULL COMMENT '认领该任务的执行器标识' AFTER `callback_url`;
ALTER TABLE `bz_jobs` ADD COLUMN `dispatched_at` DATETIME    DEFAULT NULL COMMENT '被认领派发的时间' AFTER `executor_id`;
ALTER TABLE `bz_jobs` ADD COLUMN `claim_token`   CHAR(36)    DEFAULT NULL COMMENT '原子认领标记' AFTER `dispatched_at`;

-- 认领查询走 status+target；created_at 决定 FIFO
ALTER TABLE `bz_jobs` ADD KEY `idx_claim` (`status`, `target`, `created_at`);
