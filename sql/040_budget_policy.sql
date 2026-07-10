-- 成本预算闸：路由/接入方策略 JSON。运行时先读策略，再按 bz_jobs.usage 聚合窗口用量。
ALTER TABLE `bz_routes` ADD COLUMN `budget` JSON DEFAULT NULL COMMENT '成本预算闸配置（window/window_hours, hard_cost_usd, hard_tokens）' AFTER `memory`;
ALTER TABLE `bz_clients` ADD COLUMN `budget` JSON DEFAULT NULL COMMENT '成本预算闸配置（window/window_hours, hard_cost_usd, hard_tokens）' AFTER `rate_limit_per_min`;
