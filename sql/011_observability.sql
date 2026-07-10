-- 百灵中枢 · 可观测性：执行器心跳注册表
-- 执行器每轮 claim 长轮询都算一次心跳（中枢侧 30s 节流落库）；控制台据此显示在线/离线，自监控据此告警。
-- database: bailinghub。初始化：npm run db:init（逐句幂等，可重复执行）

CREATE TABLE IF NOT EXISTS `bz_executors` (
  `executor_id`  VARCHAR(64)  NOT NULL,
  `targets`      JSON         DEFAULT NULL COMMENT '该执行器认领的 target 列表',
  `last_seen_at` DATETIME     NOT NULL COMMENT '最近一次 claim 轮询',
  `created_at`   DATETIME     NOT NULL,
  PRIMARY KEY (`executor_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='执行器心跳（在线状态与离线告警依据）';
