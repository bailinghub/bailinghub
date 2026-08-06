# BailingHub v0.3.0：可组合 Core 与 Kernel Host API v1

`v0.3.0` 把原来只能作为单体服务运行的开源 BailingHub，进一步整理成既可独立部署、也可由其他宿主按正式接口装配的同一套 Core。外部产品、托管平台或其他部署系统可以精确依赖公开 npm 制品，通过 `bailinghub/kernel-api/v1` 创建并挂载 Kernel，而不需要复制或分叉 Core 的路由、工具、任务、消息、审批和审计实现。

普通自托管用户的启动方式、控制台和公开 HTTP 契约保持不变。本版本新增的是组合边界，不是把托管平台或多租户实现放进开源 Core。

## 主要变化

- 新增稳定导出 `bailinghub/kernel-api/v1`，提供 Kernel 创建、生命周期、HTTP 挂载、Core Schema 迁移与精确制品身份。
- 同一进程可以创建多个彼此独立的 Kernel 实例；宿主必须为每个实例提供独立状态库、运行目录、配置和请求前缀，并继续承担租户身份、授权、套餐及生命周期管理。
- HTTP 挂载支持前缀路径，不依赖全局单例或固定根路径。开源版原有服务入口也改为装配同一个 Kernel，避免“独立部署一套实现、被宿主使用又是一套实现”。
- 挂载前缀同时用于内建自检；`runtimeRoot` 会承接历史默认暂停文件，Kernel 关闭时还会销毁自己的瞬时渠道凭证缓存。
- 注入 `identityProvider` 后，人类账号和改密明确归宿主身份域管理；Core 不再展示或接受无法被宿主登录流程使用的本地账号。
- Core 内部的配置、状态、运行时和路由依赖通过窄接口注入；未列入 `kernel-api/v1` 的内部模块仍不是公共扩展契约。
- npm 包会携带 Kernel API、官方 SQL、控制台静态产物和制品校验所需文件；发布门禁会从真实 `.tgz` 安装并验证稳定导出。

## 官方 Schema Migrator

宿主不能依靠 Kernel 启动时隐式改库。部署或升级必须显式调用官方迁移器，并在成功后再启动或恢复流量。

迁移账本现在增加 `checksum_sha256`：

- 新 Schema 只执行当前 49 条活动迁移，并为每条迁移写入摘要；
- 旧部署会为已有账本安全补录摘要，不重放已记账 SQL；
- 三条只存在于早期部署历史中的迁移 `020_provider_sign_version.sql`、`021_drop_provider_sign_version.sql` 和 `037_route_tools_shape.sql` 被登记为 `replay: never` 的退役证据；旧账本可以识别并补录其原始摘要，新 Schema 永不执行或插入它们；
- 任一已发布迁移摘要漂移，或账本出现当前制品不认识的迁移，都会在补录摘要和执行新迁移前失败关闭。

这次没有新增业务表或业务字段。独立部署升级仍运行：

```bash
npm run db:init
# 成功后再重启 BailingHub
```

首次从旧迁移器升级时，看到已有文件被“摘要补录”属于预期；不应手工删除历史账本或把退役 SQL 放回 `sql/`。

## 精确制品与宿主要求

宿主应使用精确版本和锁文件，不使用 `latest`、SemVer 范围、Git 分支或本地软链接作为正式环境来源：

```bash
npm install --save-exact bailinghub@0.3.0
```

运行前应核对安装版本、lockfile 中的 HTTPS `.tgz` 地址与 sha512 `integrity`。`BAILINGHUB_CORE_ARTIFACT_V1` 同时暴露当前版本、活动迁移、退役证据和整体摘要，供宿主在启动、租户开通与升级编排中做一致性检查。

## 兼容性与边界

- 独立部署的公开页面、Client API、聊天协议、Executor Protocol、工具签名、审批语义和业务系统最终授权均未改变。
- ACC 规范没有变化；生态适配器仍只消费既有 Client API 或 Executor Protocol，不需要因 Kernel Host API 升级包版本。
- Kernel Host API 不提供平台账号、租户目录、注册、计费、套餐或跨租户路由。这些属于宿主产品自己的控制面。
- `kernel-api/v1` 是本版本承诺的组合入口；直接导入 `src/app`、`src/routes`、仓储实现或其他内部文件不属于兼容承诺。
- 镜像发布策略新增可执行门禁：预发布标签永远不能更新 `latest`，稳定标签才可按发布配置更新稳定通道。

## 验证

```bash
npm run release:check
npm pack --dry-run
```

重点覆盖：

- 独立服务与宿主挂载使用同一个 Kernel 组合路径；
- 多实例状态、配置、运行目录和请求前缀隔离；
- Kernel 启停、请求排空和资源释放；
- 新旧迁移账本、摘要补录、退役迁移与未知迁移失败关闭；
- 真实 npm tarball 的导出、静态资源、SQL 和制品描述完整性；
- 预发布镜像不能覆盖 `latest`。

## 相关文档

- [Kernel Host API v1](KERNEL_HOST_API.md)
- [SQL 迁移纪律](../sql/README.md)
- [架构说明](ARCHITECTURE.md)
- [兼容性与升级](兼容性与升级.md)
- [English release notes](RELEASE_NOTES_v0.3.0.en.md)
