-- 百灵中枢 · 工具源自动刷新（spec_source=url 定时拉取 + 变更对账）
-- 业务系统按约定路径发布 spec（推荐 /.well-known/bailing/tools.json），中枢定时签名拉取；
-- 工具清单有增删/风险变化 → 审计 + 告警，防止"业务侧单方面扩大 AI 可调面"无人知晓。
-- database: bailinghub。初始化：npm run db:init（逐句幂等，可重复执行）

ALTER TABLE `bz_tool_providers` ADD COLUMN `auto_refresh_min` INT NOT NULL DEFAULT 0 COMMENT '自动刷新间隔（分钟）；0=关闭，仅 spec_source=url 生效' AFTER `rate_limit_per_min`;
