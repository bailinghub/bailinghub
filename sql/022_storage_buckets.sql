-- 百灵中枢 · 媒体存储登记（v2.6，2026-06-16）
-- 聊天组件上传的图片/语音进入「媒体存储」，得到永久 URL：① 完整聊天追溯（媒体不随会话清掉）② 多模态大脑随时读图/听音 ③ 业务要图片入参直接用该 URL。
-- 未配置登记时默认使用服务器本地 data/uploads；登记业务自己的 COS → URL 即业务 CDN 地址、加商品零改造；登记中枢自己的桶 → 中枢掌控留存。
-- 聊天入口按 name 引用一个存储；留空使用本地存储。知识库图片日后也可复用同一登记。
-- 凭证铁律：业务桶建议给「限定 path_prefix 前缀的子账号/RAM 策略或 STS 临时凭证」，别给整桶 AK/SK。
-- database: bailinghub。初始化：npm run db:init（逐句幂等，可重复执行）

CREATE TABLE IF NOT EXISTS `bz_storage_buckets` (
  `name`            VARCHAR(64)  NOT NULL COMMENT '登记名（引用键）',
  `kind`            VARCHAR(16)  NOT NULL DEFAULT 'cos' COMMENT '媒体存储类型：local / cos / oss / s3（当前实现 local/cos）',
  `region`          VARCHAR(64)  NOT NULL DEFAULT '' COMMENT '地域，如 ap-shanghai',
  `bucket`          VARCHAR(128) NOT NULL COMMENT '桶名（COS 带 appid 后缀，如 demo-bucket-1234567890）',
  `endpoint`        VARCHAR(255) DEFAULT NULL COMMENT '自定义 endpoint（留空按 kind+region 拼）',
  `access_key`      VARCHAR(255) NOT NULL COMMENT 'SecretId / AccessKeyId',
  `secret_key`      VARCHAR(255) NOT NULL COMMENT 'SecretKey / AccessKeySecret（不回显）',
  `public_base_url` VARCHAR(255) NOT NULL COMMENT '拼最终 URL 的公开域名前缀（桶默认域名或自定义 CDN 域，无尾斜杠）',
  `path_prefix`     VARCHAR(128) NOT NULL DEFAULT 'bailing/chat' COMMENT '写入对象键前缀',
  `enabled`         TINYINT      NOT NULL DEFAULT 1,
  `description`     VARCHAR(255) DEFAULT NULL,
  `created_at`      DATETIME     NOT NULL,
  `updated_at`      DATETIME     NOT NULL,
  PRIMARY KEY (`name`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='媒体存储登记（聊天图片/语音生成永久 URL，供追溯/vision/audio/业务图片入参）';

ALTER TABLE `bz_chat_entries` ADD COLUMN `bucket` VARCHAR(64) DEFAULT NULL COMMENT '关联的媒体存储登记名（留空走本地存储；URL 永久不清理供追溯）';
