-- NULL preserves existing declarations. Overrides affect Hub scheduling only, never business authorization or approval.
ALTER TABLE `bz_tool_providers`
  ADD COLUMN `tool_rate_limits_json` JSON DEFAULT NULL COMMENT 'Hub tool limit default and per-operation overrides';
