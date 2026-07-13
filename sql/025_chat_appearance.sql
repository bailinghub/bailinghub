-- 百灵中枢 · 聊天入口「外观」配置（窗口尺寸 / 标题对齐 / 气泡位置与偏移 / 头像 / 自定义气泡图标）
-- 一个可扩展的 JSON 列承载所有外观项，新增样式项不再加列（与 bz_channels.config 同思路）。
-- 形态：{ width, height, title_align:'center'|'left', position:'right'|'left', offset_x, offset_y, avatar, launcher_icon, resizable, ai_notice, powered_by_visible, powered_by_text }
-- 缺省（列为 NULL 或缺键）走组件内置默认值，老入口零感知。
-- database: bailinghub。初始化：npm run db:init（ADD COLUMN 已存在报 1060 被幂等吞掉）

ALTER TABLE `bz_chat_entries` ADD COLUMN `appearance` JSON DEFAULT NULL COMMENT '外观配置（尺寸/对齐/位置/头像/气泡图标，缺省走组件默认）';
