-- 百灵中枢 · 告警通知规则表（系统告警的「通知谁/什么事/走哪个渠道」可配，取代 config.json 写死）
-- 架构:告警/通知经通用出站原语 channelSend(渠道,收件人,正文) 推出去——复用「渠道」注册表(bz_channels)的凭证，
-- 不再建 wecom-notify 任务等执行器拉取(那正是积压自喂循环的根)。本表 = 内部告警的「路由规则」，是 channelSend 的第一个调用方；
-- 未来业务侧出站(带 token 调"发给渠道A用户A")是 channelSend 的另一个调用方，另配 client↔channel 授权，与本表无关、共用同一出站地基。
-- event_prefix:按告警 key 前缀匹配("=全部, executor_offline=所有执行器离线, queue_backlog=只积压)。
-- recipients:渠道原生收件人(如企微 userid)的 JSON 数组。channel:bz_channels.name。
-- database: bailinghub。初始化:npm run db:init（逐句幂等）；部署后按本部署的渠道/收件人在控制台建规则。

CREATE TABLE IF NOT EXISTS `bz_alert_rules` (
  `id`           BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `event_prefix` VARCHAR(64)   NOT NULL DEFAULT '' COMMENT '告警 key 前缀匹配；空串=匹配全部事件',
  `channel`      VARCHAR(64)   NOT NULL COMMENT '走哪个出站渠道(bz_channels.name)',
  `recipients`   TEXT          DEFAULT NULL COMMENT '收件人 JSON 数组(渠道原生 id，如企微 userid)',
  `cooldown_min` INT           NOT NULL DEFAULT 60 COMMENT '同一事件 key 的冷却分钟(去重防刷)',
  `enabled`      TINYINT       NOT NULL DEFAULT 1,
  `description`  VARCHAR(255)  DEFAULT NULL,
  `created_at`   DATETIME      NOT NULL,
  `updated_at`   DATETIME      NOT NULL,
  PRIMARY KEY (`id`),
  KEY `idx_enabled` (`enabled`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='告警通知规则(系统告警→渠道→收件人)';
