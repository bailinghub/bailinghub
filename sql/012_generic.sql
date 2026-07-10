-- 百灵中枢 · 通用化对齐（存量库）：能力档列默认值从场景名 triage-readonly 改为出厂通用档 readonly。
-- 仅影响列默认值（新行不传 profile 时的兜底）；已存路由的 profile 值不变。
-- database: bailinghub。幂等：可重复执行。
ALTER TABLE `bz_routes` ALTER COLUMN `profile` SET DEFAULT 'readonly';
ALTER TABLE `bz_routes` ALTER COLUMN `target` SET DEFAULT 'llm';
