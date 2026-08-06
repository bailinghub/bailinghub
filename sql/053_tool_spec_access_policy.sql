-- BailingHub · URL 工具清单访问策略与验证结果
-- 历史 URL 工具源由读取层映射为 legacy_unverified，避免升级时把从未做过负向验证的地址误标为已保护。
-- 列默认保持 NULL，使 inline 工具源不持久化 URL 专用访问状态；两列分开追加，便于定制部署独立容错。

ALTER TABLE `bz_tool_providers`
  ADD COLUMN `spec_access_policy` VARCHAR(32) NULL DEFAULT NULL COMMENT 'URL spec 声明策略：signed_required/public_allowed；NULL=历史待确认' AFTER `spec_source`;

ALTER TABLE `bz_tool_providers`
  ADD COLUMN `spec_access_probe_json` JSON DEFAULT NULL COMMENT '最近一次 spec 正签/无签/错签访问探针结果' AFTER `spec_refreshed_at`;
