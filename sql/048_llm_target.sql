-- 百灵中枢 · LLM 目标基线。
-- 目标名统一为 llm，表示 OpenAI 兼容模型目标；云厂商、本地模型、企业模型网关都通过模型凭证的 base_url 区分。

INSERT IGNORE INTO `bz_targets` (`name`,`kind`,`stateless`,`needs_project`,`timeout_ms`,`enabled`,`description`,`created_at`,`updated_at`) VALUES
  ('llm', 'inhub', 1, 0, 120000, 1, '中枢内直连 OpenAI 兼容模型端点（云厂商、本地模型或企业模型网关）', NOW(), NOW());

UPDATE `bz_targets`
  SET `kind`='inhub',
      `stateless`=1,
      `needs_project`=0,
      `timeout_ms`=120000,
      `enabled`=1,
      `description`='中枢内直连 OpenAI 兼容模型端点（云厂商、本地模型或企业模型网关）',
      `updated_at`=NOW()
  WHERE `name`='llm';

ALTER TABLE `bz_routes` ALTER COLUMN `target` SET DEFAULT 'llm';
