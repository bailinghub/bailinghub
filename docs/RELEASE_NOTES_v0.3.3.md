# BailingHub v0.3.3：npm 发布元数据纠偏

`v0.3.3` 是 `v0.3.2` 的仅发布元数据修正版。`v0.3.2` 的 npm 制品内容与完整性校验均正常，但 npm Registry 缺少用于核对源码提交的 `gitHead` 字段，因此没有通过 BailingHub 的完整发布就绪门禁。该不可变版本保留为历史事实；维护者没有覆盖、移动或重新发布它。

## 这次修正了什么

- 从独立完整 Git clone 的精确 Tag 目录发布 npm 包，使 Registry 中的 `gitHead`、Git Tag 提交与公开源码可以被一致核对。
- 将默认安装器、镜像标签、独立验证基线和当前发布说明统一到 `v0.3.3`。
- 保留 `v0.3.2` 引入的受管演示数据导入、刷新和清理能力，不改变运行时行为。

## 兼容性与升级

- `src/`、`sql/`、`web/`、`web-admin/`、`demo/` 与 `sdk/` 的运行时内容相对 `v0.3.2` 没有变化。
- 不新增数据库迁移；最新迁移仍为 `054_demo_dataset_state.sql`。
- Client API、Kernel Host API v1、聊天协议、Executor Protocol、ACC、工具签名、审批语义和业务系统最终授权保持不变。
- 正在使用 `v0.3.2` 的部署可以按普通补丁版本升级到 `v0.3.3`；新部署应直接使用 `v0.3.3`。

## 验证

本版本继续执行完整 `npm run release:check`，并在发布后核对 npm Registry 的版本、完整性摘要、Tarball 与精确 Git 提交。只有发布就绪门禁全部通过后，才创建 GitHub Release 并同步公开安装分发。

## 相关文档

- [v0.3.2 受管演示数据引导](RELEASE_NOTES_v0.3.2.md)
- [Docker Demo](DEMO.md)
- [SQL 迁移纪律](../sql/README.md)
- [兼容性与升级](兼容性与升级.md)
- [English release notes](RELEASE_NOTES_v0.3.3.en.md)
