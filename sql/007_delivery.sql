-- 百灵中枢 · ⑤送达层（路由级投递配置）
-- 任务 done 后，中枢按路由 delivery 配置派生"投递子任务"（target=wecom-notify），
-- 复用现有 claim 通道由执行器认领，经部署方配置的发送命令直发到人。
-- database: bailinghub。初始化：npm run db:init（逐句幂等，可重复执行）

ALTER TABLE `bz_routes` ADD COLUMN `delivery` JSON DEFAULT NULL
  COMMENT '送达配置 {type:"wecom", to_field:"metadata取收件人的字段", to:"固定收件人(后备)", account:"企微账号id(可选)"}'
  AFTER `default_callback_url`;
