-- 百灵中枢 · 页面登记表（页面上下文「寻址」层）
-- 架构:寻址(URL→哪个页面)用精确/模式匹配=本表;内容(页面→该看哪些文档)用知识库语义检索。
-- 组件每条消息自动抓 location(path+hash,去 query) → 中枢按本表模式匹配 → 命中则把页面说明注入 AI 提示，
-- 并落 metadata.page_context(控制台任务详情可见，方便精准定位"用户从哪个页面来")。未命中=退化为原始路径弱线索。
-- 业务方只维护本表声明(数据非代码)，且只声明在意的页面，其余自动兜底；几百上千路由也不必逐个写 setContext。
-- kb_tag 预留给 P2:检索时对该标签文档加权(阿里/腾讯"当前页优先出本页文档")。scope 到 entry_key,各接入方隔离。
-- database: bailinghub。初始化:npm run db:init（逐句幂等）

CREATE TABLE IF NOT EXISTS `bz_page_contexts` (
  `id`          BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `entry_key`   VARCHAR(32)  NOT NULL COMMENT '所属聊天入口(各接入方页面图隔离)',
  `url_pattern` VARCHAR(255) NOT NULL COMMENT 'URL 模式(* 通配)，匹配组件抓到的 path+hash',
  `page_key`    VARCHAR(64)  DEFAULT NULL COMMENT '语义页面标识，如 member.list(可选，供显式声明/引用)',
  `page_name`   VARCHAR(128) DEFAULT NULL COMMENT '页面名，如 会员列表',
  `description` VARCHAR(1000) DEFAULT NULL COMMENT '页面承载的功能说明(注入给 AI 的内容)',
  `kb_tag`      VARCHAR(64)  DEFAULT NULL COMMENT 'P2 预留:关联知识库标签，检索时对本页文档加权',
  `priority`    INT          NOT NULL DEFAULT 0 COMMENT '多条命中时的优先级(高者先；同级按模式长度更具体者胜)',
  `enabled`     TINYINT      NOT NULL DEFAULT 1,
  `created_at`  DATETIME     NOT NULL,
  `updated_at`  DATETIME     NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_entry` (`entry_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='页面登记表(页面上下文寻址)';
