# Core v0.9.1 补丁升级指南

[English](UPGRADE_v0.9.1.en.md)

从公开 Core 0.9.0 升级到 0.9.1，目标是补齐 usage 后台工作关闭等待，并取得公开能力索引与通用安全治理更新。没有新增 API、SQL、套餐规则或客户端功能；MCP / Agent Client SDK 与 DSH 继续使用既有 0.7.0。

## 保留数据与原调用

保留数据库、实例配置和凭据、附件存储、旧制品以及宿主的会话/原调用持久记录。停止目标实例的新工作，协调共享状态库的写入方，核对已经派发的原请求；不要通过新 `operation_id` 代替结果恢复。

0.9.0 的 `close()` 没有显式排空 usage 后台 continuation。因此，升级前不能只凭旧版 HTTP 已结束或旧 `close()` 已返回，就认定图片完成、结算或价格写入已经结束。应按原请求核对在途工作，再替换制品。

## 版本与数据库

- 使用正式 `v0.9.1` 源码、npm 包或镜像，核对实际版本、来源 Tag/提交和制品摘要；安装器与预构建镜像 Compose 的默认版本同步为 0.9.1。
- 相对 0.9.0 没有新增迁移，不修改已有 SQL，也不要求清表或重置套餐/额度。更早版本按正式迁移器应用其全部未执行文件，仍可参考 [0.9.0 升级指南](UPGRADE_v0.9.0.md)。
- 嵌入式宿主使用 `BAILINGHUB_CORE_ARTIFACT_V1` 重新核对完整制品 manifest。版本变更会改变 manifest 身份，即使活动 SQL 名称与摘要不变；不要只比较最后一个迁移文件。
- 本补丁不要求升级 SDK/DSH 的版本声明，也不改变业务后端的声明、验签、权限或审批。

## 关闭与验收

正常部署先验证 `/health`、控制台和原有业务 smoke。使用 usage 网关的部署另核对原请求结果、计费状态和额度，不把结果 complete 等同于已 settled。

嵌入式宿主继续公平调用 `tick()`，在淘汰、升级或退出时调用 `close(drainMs)`。0.9.1 在原关闭预算内等待模型完成、结算、清理/核对和价格刷新。**usage 排空阶段超时**会保留原实例依赖和 closing 状态；等待原工作后，在同一实例重试或告警，不强行关闭其数据库，也不把超时解释为重派许可。该描述不扩大为任何资源关闭失败都能原封不动回退。

可在专用测试环境复现公开回归：

```bash
node --import tsx --test src/modules/usage/background-work.test.ts
BAILING_USAGE_TEST_MYSQL=1 node --import tsx --test src/app/kernel-usage-lifecycle.mysql.test.ts
```

数据库用例使用 fixture 要求的隔离测试 MySQL、合成供应商和数据。没有该环境或用例被跳过时，应明确记录数据库验证未执行；这些用例不需要真实模型调用，也不替代真实供应商或部署验收。完整覆盖与限制见 [Kernel Host API](KERNEL_HOST_API.md) 和 [能力索引](IMPLEMENTATION_STATUS.md)。

## 回退边界

本版没有新增 schema，但回退到 0.9.0 会重新失去 usage 后台关闭等待。先停止新工作并保留原结果、账本、配置和回滚制品，核对在途操作后再决定回退。不要删账本、重发原请求或把备份恢复当作撤销备份后业务效果的办法。

[版本说明](RELEASE_NOTES_v0.9.1.md) · [兼容策略](兼容性与升级.md)
