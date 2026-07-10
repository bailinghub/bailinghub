-- 百灵中枢 · 模型凭证 + 知识库（图书馆：只在资料路径，不在对话路径）
-- 自研轻 RAG：文档→切块→embedding→暴力余弦检索。
-- 量级账：客服工单域 ≈ 几千 chunk，1 万 chunk × 1024 维 × 4 字节 = 40MB 内存、全扫 <10ms，向量库是十万级以后的事。
-- database: bailinghub。初始化：npm run db:init（逐句幂等，可重复执行）

-- 模型凭证：后台可配（用户要求不硬编码）。对话(llm)与向量化(知识库)共用，按名引用。
-- key 只进库不回显：admin API 列表只出掩码，编辑时留空=保留原 key。
CREATE TABLE IF NOT EXISTS `bz_credentials` (
  `name`          VARCHAR(64)  NOT NULL COMMENT '凭证名，如 bailian / deepseek',
  `kind`          VARCHAR(16)  NOT NULL DEFAULT 'chat' COMMENT 'chat / embedding / both',
  `base_url`      VARCHAR(255) NOT NULL COMMENT 'OpenAI 兼容接口前缀，如 https://dashscope.aliyuncs.com/compatible-mode/v1',
  `api_key`       VARCHAR(255) NOT NULL,
  `default_model` VARCHAR(64)  DEFAULT NULL,
  `enabled`       TINYINT      NOT NULL DEFAULT 1,
  `description`   VARCHAR(255) DEFAULT NULL,
  `last_used_at`  DATETIME     DEFAULT NULL,
  `created_at`    DATETIME     NOT NULL,
  `updated_at`    DATETIME     NOT NULL,
  PRIMARY KEY (`name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='模型凭证（对话/向量化，后台可配）';

-- 知识库：embedding 模型跟库走（建库定模型，检索必须同模型同坐标系；换模型=全库重算）
CREATE TABLE IF NOT EXISTS `bz_kb_bases` (
  `kb_id`       VARCHAR(64)  NOT NULL COMMENT '知识库标识，如 cs-faq',
  `name`        VARCHAR(128) NOT NULL,
  `credential`  VARCHAR(64)  NOT NULL COMMENT 'embedding 凭证名（引用 bz_credentials / config llm_credentials）',
  `model`       VARCHAR(64)  NOT NULL DEFAULT 'text-embedding-v4',
  `dim`         INT          NOT NULL DEFAULT 1024 COMMENT '向量维度',
  `enabled`     TINYINT      NOT NULL DEFAULT 1,
  `description` VARCHAR(255) DEFAULT NULL,
  `created_at`  DATETIME     NOT NULL,
  `updated_at`  DATETIME     NOT NULL,
  PRIMARY KEY (`kb_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='知识库';

-- 文档：原文留底（重切块/换模型可全量重算）；向量化异步跑，状态落库
CREATE TABLE IF NOT EXISTS `bz_kb_docs` (
  `doc_id`      BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `kb_id`       VARCHAR(64)  NOT NULL,
  `title`       VARCHAR(191) NOT NULL,
  `content`     MEDIUMTEXT   NOT NULL,
  `status`      VARCHAR(16)  NOT NULL DEFAULT 'embedding' COMMENT 'embedding / ready / error',
  `error`       VARCHAR(500) DEFAULT NULL,
  `chunk_count` INT          NOT NULL DEFAULT 0,
  `created_at`  DATETIME     NOT NULL,
  `updated_at`  DATETIME     NOT NULL,
  PRIMARY KEY (`doc_id`),
  KEY `idx_kb` (`kb_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='知识库文档（原文留底）';

-- 切块：embedding 存 L2 归一化后的 float32 序列（余弦=点积）；检索时整库载内存暴力扫
CREATE TABLE IF NOT EXISTS `bz_kb_chunks` (
  `id`         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `kb_id`      VARCHAR(64)     NOT NULL,
  `doc_id`     BIGINT UNSIGNED NOT NULL,
  `seq`        INT             NOT NULL COMMENT '块在文档内的序号',
  `content`    TEXT            NOT NULL,
  `embedding`  MEDIUMBLOB      NOT NULL COMMENT 'float32[dim] L2 归一化',
  `created_at` DATETIME        NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_kb` (`kb_id`),
  KEY `idx_doc` (`doc_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='知识库切块+向量';

-- 路由知识注入：{kb_id, top_k?, min_score?}，派发前中枢检索注入【知识参考】块（图书馆故障不阻塞派活）
ALTER TABLE `bz_routes` ADD COLUMN `knowledge` JSON DEFAULT NULL COMMENT '知识注入配置' AFTER `delivery`;
