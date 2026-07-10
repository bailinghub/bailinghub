-- 百灵中枢 · 后台角色（RBAC 固定角色先行：admin 全能 / kb_editor 知识库维护 / viewer 只读任务）
-- 角色→权限集映射在代码里（server.ts ROLE_PERMS）；将来要细粒度/自定义角色，再把权限集搬进库，结构不用动。
-- database: bailinghub。初始化：npm run db:init（逐句幂等，可重复执行）

ALTER TABLE `bz_admins` ADD COLUMN `role` VARCHAR(32) NOT NULL DEFAULT 'admin' COMMENT '角色：admin / kb_editor / viewer' AFTER `display_name`;
