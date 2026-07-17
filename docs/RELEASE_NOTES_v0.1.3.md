# v0.1.3 发布说明

百灵中枢 `v0.1.3` 把“让另一个 Agent 成为执行器”从一段较长的人工说明，收敛为可复用的 Skill、短引导和代表性 OpenClaw 适配器。该版本不新增数据库迁移，也不改变公开 HTTP、SDK 或签名格式。

## 主要变化

### 1. 便携式执行器接入 Skill

公开提供 `connect-bailinghub-executor` Skill，内容包括：

- 如何判断使用通用命令包装器、OpenClaw 适配器或直连协议；
- 如何在本机安全输入和保存执行器令牌；
- 如何确认 `EXECUTOR_ID`、target 与运行时信息；
- 如何完成在线状态、认领、执行、回报与审计验收。

控制台复制给 Agent 的内容只保留中枢地址、target、路由上下文和 Skill 地址，不再内嵌整份协议说明。

### 2. OpenClaw stdio 适配器

新增 `web/connect/openclaw-stdio.mjs`：

- 通过 stdin 接收中枢任务；
- 将任务交给本地 OpenClaw agent；
- 映射并续接中枢会话；
- 只把最终回答写入 stdout，避免日志污染执行结果；
- 默认不把业务工具凭证转交给 OpenClaw 子进程。

### 3. 通用执行器加固

- 优先从 `BAILING_EXECUTOR_TOKEN` 环境变量读取令牌，避免令牌进入 shell 历史和进程参数；`--token` 继续兼容。
- 心跳与认领循环解耦，长任务执行期间仍持续上报存活。
- 回报结果时携带本次派发的 `claim_token`，中枢可以拒绝任务重排后原执行器迟到的过期结果。

## 升级前检查

1. Node.js 仍要求 `22+` 运行中枢；便携式通用执行器本身支持 Node.js `18+`。
2. 新接入建议把执行器令牌放入 `BAILING_EXECUTOR_TOKEN` 或本地密钥管理器。
3. 已使用 `--token` 的执行器无需立即修改，命令仍保持兼容。

## 兼容性

- 无数据库迁移；
- `/run`、SDK、业务工具签名和既有执行器 HTTP 端点不变；
- 新增的 Skill 与 OpenClaw 适配器均为可选接入能力；
- 不改变业务系统的最终授权责任边界。

## 验证

发布前通过：

- `npm run typecheck`
- `npm test`
- `npm --prefix web-admin run build`
- `npm run release:check`
- OpenClaw 代表性端到端执行验证
