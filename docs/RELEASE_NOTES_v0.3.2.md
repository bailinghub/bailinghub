# BailingHub v0.3.2：受管演示数据引导

`v0.3.2` 将空实例的演示数据导入正式收敛为 BailingHub Core 自己拥有的上手能力。管理员可以从控制台导入一组确定性的目标、工具源、路由和接入方，完成浏览或真实 smoke 后再精确清理，而不需要依赖某个外部数据分叉或隐藏的初始化脚本。

## 谁适合升级

- 希望新用户在空实例中快速理解目标、工具源、路由和接入方关系的部署；
- 需要从控制台重复导入、刷新或清理官方演示配置的自托管环境；
- 通过 Kernel Host API 承载多个隔离 Core，并希望为每个租户提供相同上手心智的宿主。

已有实例不会自动导入任何演示对象。只有配置了 Demo Business、且当前账号具备聚合写权限时，控制台才会显示导入入口。

## 主要变化

- 新增 `GET /admin/api/demo-dataset/status`、`POST /admin/api/demo-dataset/import` 和 `DELETE /admin/api/demo-dataset`。
- 空实例首次进入控制台时可以看到导入提示；设置页提供导入、刷新和清理操作。
- Core 使用持久 ownership manifest 与固定资源指纹记录自己创建的演示对象。名称已被占用、对象已被用户修改或已被外部配置引用时返回 `409`，不会猜测所有权或覆盖用户配置。
- 导入和清理运行在事务与演示数据集互斥锁内；首次创建使用冲突关闭式写入，避免并发请求覆盖同名对象。
- 清理只删除仍由 manifest 证明拥有、且未被修改和引用的演示配置。任务、消息、Trace 与审计是实际运行历史，不随配置清理删除。
- `demo-business` 支持两个明确 profile：
  - `full-local` 保留 Docker demo 的查单、工单、退款审批和故障演示；
  - `stateless-readonly` 只允许 loopback 监听，只提供签名查单与故障探针，不保存请求状态、不提供业务写入或审批回调。

## 数据库与升级

新增迁移 `054_demo_dataset_state.sql`，创建 `bz_demo_datasets`，只保存 Core 明确拥有的演示数据集版本、资源 manifest、指纹与时间。升级时先执行官方迁移器：

```bash
npm run db:init
```

迁移成功后再按现有方式重启服务。通过 Kernel Host API 组合 Core 的宿主继续使用既有显式 migration 与排空流程。

## 配置

需要控制台导入能力时，由部署环境提供：

```bash
DEMO_BUSINESS_URL=http://127.0.0.1:19080
DEMO_TOOL_SECRET=<independent-random-secret>
DEMO_PROFILE=stateless-readonly
```

共享或宿主式环境必须使用 `stateless-readonly`、回环地址和独立随机签名材料。该签名材料会进入租户自己的演示工具源，具备相应管理权限的租户管理员可以显式读取，因此不能与平台、租户或真实业务密钥复用。

## 兼容性与验证

- Client API、Kernel Host API v1、聊天协议、Executor Protocol、ACC、工具签名、审批语义和业务系统最终授权保持兼容。
- 未配置 Demo Business 的生产实例行为不变，演示数据状态返回不可用，控制台不会展示导入动作。
- 发布验证覆盖完整 `npm run release:check`、Docker demo、npm tarball、并发与冲突测试，以及空实例的人工导入、浏览和清理。

## 相关文档

- [Docker Demo](DEMO.md)
- [SQL 迁移纪律](../sql/README.md)
- [兼容性与升级](兼容性与升级.md)
- [English release notes](RELEASE_NOTES_v0.3.2.en.md)
