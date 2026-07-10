-- 路由权限档：只读 / 可写 / 全开（readonly / readwrite / full）。
-- 中枢按本字段在派发时给任务正文前置一段【权限】提示词指导执行器；属"提示词指导"非硬性沙箱
-- （执行器是否遵守由其自身决定，中枢不保证强制）。NULL/空 = 不加限制（等同 full）。
-- 与既有 profile（角色/技能档，后续并入云端 skill）相互独立、互不替代。
ALTER TABLE bz_routes ADD COLUMN permission VARCHAR(16) NULL AFTER profile;
