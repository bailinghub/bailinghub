-- 百灵中枢 · 知识库入库插座（v1.9）
-- 业务数据库内容（帮助中心/工单流程等）入知识库的正道：业务侧自己把数据渲染成 markdown，
-- 凭接入方 token 推给中枢（PUT /kb/:kb_id/docs/:source_key 幂等 upsert）。
-- source_key = 业务侧的幂等键（如 help_article_123）：同 key 再推 = 覆盖更新并重算向量。
-- 未来"数据源连接器"模块（开源自部署形态下中枢直连业务库定时拉取）复用同一条 upsert 流水线。

ALTER TABLE `bz_kb_docs` ADD COLUMN `source_key` VARCHAR(128) DEFAULT NULL COMMENT '外部源幂等键（接入方推送/连接器同步用；控制台手工添加为 NULL）' AFTER `kb_id`;
ALTER TABLE `bz_kb_docs` ADD UNIQUE KEY `uk_kb_source` (`kb_id`, `source_key`);

-- 可写接入方白名单：哪些接入方能往这个库推/删文档（JSON 数组 app_id；NULL/空 = 仅控制台可写）
ALTER TABLE `bz_kb_bases` ADD COLUMN `writers` JSON DEFAULT NULL COMMENT '可写接入方 app_id 白名单' AFTER `description`;
