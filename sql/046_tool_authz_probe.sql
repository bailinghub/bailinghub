-- 百灵中枢 · 工具源授权探针结果
-- 记录最近一次注册期 / 刷新期 authorize 探针结论，控制台直接展示。

ALTER TABLE `bz_tool_providers`
  ADD COLUMN `authz_probe_json` JSON DEFAULT NULL COMMENT '最近一次授权探针结果（pass/suspect/inconclusive/skipped）' AFTER `spec_refreshed_at`;
