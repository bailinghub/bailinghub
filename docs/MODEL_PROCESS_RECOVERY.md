# 模型请求进程崩溃与确认丢失回归

[English](MODEL_PROCESS_RECOVERY.en.md)

本页说明 Core 0.9.2 纳入的专项测试。正式 `v0.9.1` 已有原请求恢复与 usage 后台排空，但该历史 Tag 不包含本页新增的进程测试。测试源码、实际执行、正式发行和生产验收分别核对。

## 验证的窗口

专项以两个不同 PID 的真实 Kernel 子进程、专用 MySQL 和独立合成供应商核对以下边界：

- 准入事务提交前后；派发事务提交前后。
- 供应商已收到请求、尚未返回结果；结果已收到、持久结果尚未提交。
- 结果提交完成但异步结算尚未完成；普通文本结果已保存但 HTTP 回复丢失。
- MySQL 已提交派发、结果或结算事务，但协议代理扣留实际 COMMIT OK 回包。

子进程实际收到 `SIGKILL`，随后以新 PID 连接同一合成 schema。断言检查原 `operation_id`、原请求记录、供应商实际调用次数、已保存结果及 hash、美元账本条数与当期消耗。已保存结果的恢复不再次调用供应商；结算恢复不产生重复扣款。持久派发边界之后结果未知仍保留原 ID 核对，不能换 ID 或凭网络错误重新生成。

准入提交前被杀、数据库没有原请求记录的场景与已持久准入分开。尚未派发的持久请求不会因重启自动重新派发，可按原请求取消。成功恢复允许留下 pending/unknown；不是所有记录必须自动 settled。

## 运行

需要 Node.js 22 或更高、Docker，以及下面的固定公开测试镜像。先拉镜像，再显式启用专项：

```bash
docker pull mysql:8.4@sha256:85b9bf2e29cf836ecb8c2a15a935d4ba0c606631dff1dd79531a11983c638f2a
BAILING_USAGE_PROCESS_CRASH_TEST=1 npm run test:model-process-recovery
```

未设置开关时，本专项明确 skip，不创建 Docker、数据库或子进程；显式启用但缺少 Docker/固定镜像时失败，不回退为跳过。普通默认测试的成功不能代表专项已经执行。

测试自行创建带任务标签的独立容器，MySQL 端口仅随机映射到 `127.0.0.1`，每个场景使用随机 schema。测试不读取部署配置、继承部署数据库参数或使用真实模型凭据。清理按保存的完整容器 ID 和标签核对，仅移除自有容器、子进程与临时数据。请勿将测试夹点或协议代理用于实际部署。

## 范围

这些断言不证明真实供应商的重试或计费语义、主机断电、数据库服务器故障切换、跨地域容灾或外部业务 exactly-once。它们也不代表生产数据库恢复演练。独立宿主的实例管理与租户隔离、本地客户端的任务与交付分别由对应项目验证。

[专项测试](../src/app/kernel-model-process-crash.mysql.test.ts) · [隔离子进程夹点](../src/test-support/model-process-crash-child.ts) · [原调用回执](INVOCATION_RECEIPTS.md) · [能力与公开证据索引](IMPLEMENTATION_STATUS.md)
