# Kernel Host API v1

`bailinghub/kernel-api/v1` 是把完整 BailingHub Core 嵌入受信任宿主的版本化高层入口。它适合需要统一进程编排、独立身份提供方或多个相互隔离 Core 实例的发行版；普通单组织部署继续使用 `npm start`，不需要接触这个 API。

当前 Core npm 制品保留 TypeScript 源码作为运行入口，宿主必须通过随 Core 安装的 `tsx` 运行时启动（例如 `tsx host.ts` 或 `node --import tsx host.mjs`）；它不是可由纯 Node.js 无 Loader 直接导入的预编译 JavaScript 库。正式宿主应把 `tsx` 作为自己的直接运行依赖，避免依赖传递安装细节。

## 边界

- Kernel 自己装配原生配置仓储、运行账本、HTTP 路由、工具治理和生命周期。宿主不能复制或替代 `bz_*` 数据面。
- 每个实例必须使用独立 MySQL Schema 和独立、非空的绝对路径 `runtimeRoot`；`instanceKey` 必须来自宿主可信目录，不能直接相信终端用户输入。
- `identityProvider` 只能返回带显式权限的 `admin/session` 人类身份；一旦注入，人类账号与改密便归宿主身份域所有，Core 会隐藏并关闭本地账号/密码入口，避免产生无法登录的“死账号”。Core 会在运行时拒绝 Host 注入的 client、executor 或 admin token。Client Token、Executor Token、工具签名、审批与业务系统最终授权仍由 Core 原生链路验证。
- `launchGuard` 可以增加发行版策略，但只能在 Core 落单前故障关闭，不能绕过 Core 内部治理。
- `httpMountPath` 是同源路径前缀，例如 `/tenant/acme`；Core 会让控制台、Widget、聊天、媒体、回调 URL 和内建自检保留该前缀。
- 宿主只能依赖本入口，不应 import `src/app/*`、默认单例或其他内部源码路径。

## 生命周期

```ts
import {
  createBailingHubKernel,
  loadConfig,
} from 'bailinghub/kernel-api/v1';

const config = loadConfig({ mode: 'kernel-host' });
// Host 模式的 config.root 自动指向已安装 Core 制品，不读取或信任宿主 cwd。
config.runtimeRoot = '/var/lib/my-host/acme';
// 历史默认 root/.paused 会自动改用 runtimeRoot/.paused；
// 若宿主显式给出其他 killSwitchFile，Core 保留该值。
config.state.backend = 'mysql';
config.state.mysql = tenantScopedMysql;

const kernel = createBailingHubKernel({
  instanceKey: 'tenant:acme',
  config,
  schedulerMode: 'managed',
  httpMountPath: '/tenant/acme',
  bootstrapLocalAdmin: false,
  identityProvider,
});

await kernel.initialize();
await kernel.handle(req, res, trustedInnerUrl);
await kernel.tick(1);
await kernel.close(30_000);
```

`managed` 模式不为每个 Kernel 创建完整定时器组；宿主必须公平调用 `tick()`，并在淘汰、升级或进程退出时调用 `close()`。`close(drainMs)` 的 0~600000 毫秒时限覆盖初始化、在途维护/tick、HTTP、InHub 与执行队列排空；排空后还会清理 Kernel 自己的企微令牌等瞬时凭证缓存。超时会保留原实例依赖并报错，宿主应在同一实例上重试或告警。`close()` 开始后的新 `initialize()` / `tick()` 不会重开资源。

多个 Kernel 可以共享 `KernelExecutionQueueV1` 作为进程级并发上限。这个 v1 包装只向宿主暴露 `run()`；每个 Kernel 内部队列的接入、统计和排空仍由 Core 自己管理。当前同进程实例必须使用相同的 `display_tz` / `display_tz_label`。

## 制品与数据库升级

`BAILINGHUB_CORE_ARTIFACT_V1` 包含已安装包版本、官方活动迁移摘要、最新迁移名、退役迁移证据和整体 manifest 摘要。宿主应把这些值写入自己的实例目录，并在加载前逐项匹配。`migrations` 只是可在新 Schema 中执行的活动序列；`retiredMigrations` 只用于识别早期部署的历史账本，`replay: never` 表示不得恢复相应 SQL 文件或在新库中重放。

`migrateBailingHubCoreSchema()` 是显式迁移入口：它只执行当前 Core 制品自带的 `sql/*.sql`，使用命名锁、迁移账本和 SHA-256 检测历史文件漂移。已存在的退役迁移账本行可按固化证据补录摘要，但不进入执行或新库记账序列；任何未知历史文件或摘要不一致都会在新迁移前失败关闭。Kernel 启动不会隐式执行 DDL；宿主应先停止目标实例新流量、排空所有副本，再用短生命周期且仅限目标 Schema 的 DDL 身份迁移，最后通过新 Kernel readiness 后恢复流量。

## 不提供的能力

Kernel Host API 不提供租户注册、套餐、计费、平台后台、集群目录、数据库账号管理或多副本升级编排。这些属于独立宿主/发行版，不能以产品便利反向污染开源 Core 的单组织部署边界。
