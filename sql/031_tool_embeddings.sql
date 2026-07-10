-- 工具语义检索索引：工具源的每个 AI 工具（名+描述+scope）→ embedding，派发时按用户输入余弦召回 top-K 内联给大脑。
-- 解决「工具一多（> 内联阈值）就藏到 find_tools 后面、模型不主动翻菜单」的结构性失败：由中枢替模型选相关工具，
-- 工具总数随便涨到上千，大脑每轮只看到一小撮高度相关、直接可调的定义。复刻 008_kb.sql 的向量存法（float32 L2 归一化，余弦=点积，整源载内存暴力扫）。
-- 量级账：1000 工具 × 1024 维 × 4 字节 = 4MB 内存、全扫 <1ms——几千工具都还没到要上向量库的程度。
-- 坐标系（model+dim）跟索引走：换模型/维度 = 整源重算（reindexProvider 检测到不一致会整源重建）。
CREATE TABLE IF NOT EXISTS `bz_tool_embeddings` (
  `id`         BIGINT       NOT NULL AUTO_INCREMENT,
  `provider`   VARCHAR(64)  NOT NULL COMMENT '工具源名（bz_tool_providers.name）',
  `tool_name`  VARCHAR(64)  NOT NULL COMMENT '工具名（ToolDef.name = operationId）；检索后仍按路由白名单/主体闸复核',
  `scope`      VARCHAR(128) NOT NULL DEFAULT '' COMMENT 'ACC scope，随行便于调试，治理不依赖它',
  `text`       TEXT         NOT NULL COMMENT '参与 embedding 的语义文本（名+描述+类别），可读便于排查召回',
  `text_hash`  CHAR(32)     NOT NULL COMMENT 'md5(text)，增量重嵌：未变跳过、变了重嵌',
  `model`      VARCHAR(64)  NOT NULL COMMENT 'embedding 模型（坐标系，跟索引锁定）',
  `dim`        INT          NOT NULL COMMENT '向量维度（坐标系）',
  `embedding`  MEDIUMBLOB   NOT NULL COMMENT 'float32[dim] L2 归一化（余弦=点积）',
  `updated_at` DATETIME     NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_provider_tool` (`provider`, `tool_name`),
  KEY `idx_provider` (`provider`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='工具语义检索索引（工具RAG）';
