-- 工具调用幂等账本（job 内防重复副作用）
-- 同一 job 内（job_id + tool + args_hash）已执行过的"副作用工具"调用（非只读、非声明幂等，含内置 send_message），
-- 在 job 重试 / 崩溃恢复整单重跑时直接返回上次结果、不再重复执行——根治"send_message 重发 / 写操作重复扣款"。
-- 只在同一 job 内去重（按 job_id），不跨 job；网络失败(status=0)不登记，允许重试。
CREATE TABLE IF NOT EXISTS `bz_tool_calls` (
  `id` BIGINT AUTO_INCREMENT PRIMARY KEY,
  `job_id` VARCHAR(191) NOT NULL,
  `tool` VARCHAR(191) NOT NULL,
  `args_hash` CHAR(64) NOT NULL,
  `ok` TINYINT(1) NOT NULL DEFAULT 0,
  `status` INT NOT NULL DEFAULT 0,
  `result_json` MEDIUMTEXT,
  `created_at` DATETIME NOT NULL,
  UNIQUE KEY `uk_job_tool_args` (`job_id`,`tool`,`args_hash`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='工具调用幂等账本（job 内防重复副作用）';
