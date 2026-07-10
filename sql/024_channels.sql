-- 入站消息渠道注册表（通用）：把"外部平台消息进中枢"做成后台可配的活配置，替代 config.json 写死。
-- kind 区分平台（wecom 企微 / 未来 feishu 飞书 等，各自的回调协议由对应 handler 实现）；
-- config 放该平台专属参数（含密钥，API 层掩码）；route_key 绑定到哪条路由（大脑）——入站与下发彻底解耦。
-- name 即回调 URL 路径段：企微回调地址 = https://<中枢域名>/wecom/<name>。
CREATE TABLE IF NOT EXISTS bz_channels (
  name        VARCHAR(64)  NOT NULL,
  kind        VARCHAR(32)  NOT NULL DEFAULT 'wecom',
  route_key   VARCHAR(64)  NOT NULL,
  config      JSON,
  enabled     TINYINT      NOT NULL DEFAULT 1,
  description VARCHAR(255) DEFAULT NULL,
  created_at  DATETIME     DEFAULT NULL,
  updated_at  DATETIME     DEFAULT NULL,
  PRIMARY KEY (name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='入站消息渠道注册表';
