-- 工具源的工具检索 embedding 坐标系：按名引用 bz_credentials（kind embedding/both），无硬编码默认。
-- 三者齐备且该源被某路由放行的工具数 > 内联阈值时，派发自动按用户问题召回相关工具内联（见 tools-index.ts / llm.ts）；
-- 任一为空 = 不开工具检索，退回「目录 + find_tools」渐进披露（零回归）。模型/维度跟索引锁定，改它=整源重算。
ALTER TABLE bz_tool_providers
  ADD COLUMN embed_credential VARCHAR(64) NULL COMMENT '工具检索 embedding 凭证名（bz_credentials，kind embedding/both）；空=不开检索' AFTER description,
  ADD COLUMN embed_model VARCHAR(64) NULL COMMENT 'embedding 模型（坐标系，跟索引锁定）' AFTER embed_credential,
  ADD COLUMN embed_dim INT NULL COMMENT '向量维度（坐标系）' AFTER embed_model;
