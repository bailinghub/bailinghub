-- 单实例品牌设置。外部平台可通过 BrandingProvider 接管，本表保留为升级迁移来源。
CREATE TABLE IF NOT EXISTS `bz_instance_branding` (
  `singleton_id` TINYINT UNSIGNED NOT NULL,
  `site_name` VARCHAR(64) NOT NULL,
  `browser_title` VARCHAR(120) NOT NULL,
  `site_description` VARCHAR(255) NOT NULL DEFAULT '',
  `site_keywords` VARCHAR(512) NOT NULL DEFAULT '[]',
  `login_heading` VARCHAR(160) NOT NULL,
  `login_subheading` VARCHAR(512) NOT NULL DEFAULT '',
  `logo_content_type` VARCHAR(32) NULL,
  `logo_data` MEDIUMBLOB NULL,
  `favicon_content_type` VARCHAR(32) NULL,
  `favicon_data` MEDIUMBLOB NULL,
  `created_at` DATETIME NOT NULL,
  `updated_at` DATETIME NOT NULL,
  PRIMARY KEY (`singleton_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='实例品牌设置（单例）';
