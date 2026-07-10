-- 路由身份/Audience 策略：谁能进该路由，以及 route=auto 是否可分诊到该路由。

ALTER TABLE `bz_routes`
  ADD COLUMN `audience` JSON DEFAULT NULL COMMENT '身份/Audience 策略：clients/channels/tenants/roles/principals/audiences/keywords/auto/priority' AFTER `tools`;
