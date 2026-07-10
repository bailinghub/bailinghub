-- 百灵中枢 · 知识库数据源连接器（v2.0）
-- 拉取式入库：后台配数据库连接 + 取数 SQL + 字段映射，中枢定时拉业务库渲染成文档，
-- 复用入库 upsert 管道（source_key = ds{ds_id}:{主键}，与控制台手工/API 推送的文档互不干扰）。
-- 开源自部署形态下的标配能力：部署方连的是自己的库，无跨主体耦合。

CREATE TABLE IF NOT EXISTS `bz_kb_datasources` (
  `ds_id`            BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `kb_id`            VARCHAR(64)  NOT NULL COMMENT '目标知识库',
  `name`             VARCHAR(128) NOT NULL,
  `db_host`          VARCHAR(255) NOT NULL,
  `db_port`          INT          NOT NULL DEFAULT 3306,
  `db_user`          VARCHAR(128) NOT NULL COMMENT '建议只读账号',
  `db_password`      VARCHAR(255) NOT NULL,
  `db_database`      VARCHAR(128) NOT NULL,
  `query_sql`        TEXT         NOT NULL COMMENT '取数 SELECT（只读硬校验，≤5000 行）',
  `key_field`        VARCHAR(64)  NOT NULL COMMENT '幂等键字段（如主键 id）',
  `title_field`      VARCHAR(64)  NOT NULL COMMENT '标题字段',
  `content_template` TEXT         NOT NULL COMMENT '内容模板，${字段} 占位渲染 markdown',
  `interval_min`     INT          NOT NULL DEFAULT 60 COMMENT '同步间隔分钟；0=仅手动',
  `enabled`          TINYINT      NOT NULL DEFAULT 1,
  `last_sync_at`     DATETIME     DEFAULT NULL,
  `last_status`      VARCHAR(16)  DEFAULT NULL COMMENT 'running / ok / error',
  `last_error`       VARCHAR(500) DEFAULT NULL,
  `last_stats`       VARCHAR(255) DEFAULT NULL COMMENT '上次同步统计 JSON {rows,upserted,skipped,deleted,errors,ms}',
  `created_at`       DATETIME     NOT NULL,
  `updated_at`       DATETIME     NOT NULL,
  PRIMARY KEY (`ds_id`),
  KEY `idx_kb` (`kb_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='知识库数据源连接器';

-- 内容指纹：同步/重推时内容未变 → 跳过重算向量（embedding 花的是真钱；每小时全量重嵌是事故）
ALTER TABLE `bz_kb_docs` ADD COLUMN `content_hash` CHAR(32) DEFAULT NULL COMMENT 'md5(title+content)，未变更跳过重嵌' AFTER `content`;
