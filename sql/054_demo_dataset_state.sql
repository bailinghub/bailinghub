-- BailingHub · Core 内置演示数据所有权标记。
-- 演示配置可以反复刷新和一键清理，但绝不能仅凭名字删除用户自建对象。
-- manifest_json 只记录 Core 已声明拥有的固定演示资源；运行账本不属于演示配置清理范围。

CREATE TABLE IF NOT EXISTS `bz_demo_datasets` (
  `dataset_key`   VARCHAR(64)  NOT NULL COMMENT '内置演示数据集稳定标识',
  `version`       INT UNSIGNED NOT NULL COMMENT '演示数据定义版本',
  `manifest_json` JSON         NOT NULL COMMENT 'Core 拥有且允许刷新/清理的固定资源清单',
  `imported_at`   DATETIME     NOT NULL,
  `updated_at`    DATETIME     NOT NULL,
  PRIMARY KEY (`dataset_key`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT='Core 内置演示数据持久所有权标记';
