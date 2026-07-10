-- 百灵中枢 · 记忆层升级：对话线索滚动摘要 + 路由级记忆配置
-- 设计：水位线(summary_upto_id) 把"已折叠进摘要"的消息与"逐字保留的最近尾巴"切开；
-- 超阈值时由轻模型异步把更早的批次增量压进 summary（结构化、抗失真），最初几轮也不被遗忘。
-- 装配 = summary(压缩的早期) + 最近逐字尾巴(id>水位线，受条数/字符预算约束)。
-- 路由级 memory(JSON) 配置窗口大小/预算/是否开摘要/触发阈值/保留逐字数/摘要模型；缺省=NULL 走组件内置默认(等同旧行为)。
-- database: bailinghub。初始化：npm run db:init（ADD COLUMN 已存在报 1060 被幂等吞掉）

ALTER TABLE `bz_threads` ADD COLUMN `summary_upto_id` BIGINT UNSIGNED NOT NULL DEFAULT 0 COMMENT '摘要水位线：id≤此值的消息已折叠进 summary';
ALTER TABLE `bz_threads` ADD COLUMN `summary_updated_at` DATETIME DEFAULT NULL COMMENT '摘要最近更新时间';
ALTER TABLE `bz_routes` ADD COLUMN `memory` JSON DEFAULT NULL COMMENT '记忆层配置（窗口/预算/滚动摘要）；NULL=走内置默认(旧行为)';
