# 阿里云百炼接入 BailingHub

本配方让阿里云百炼 Agent 或工作流通过自定义 MCP，把真实业务动作提交到自托管
BailingHub 治理控制面，而不是让模型直接持有业务凭证或自由调用业务 API。

这是一份用户工作空间内的自定义 MCP 接入配方，不是百炼 Marketplace 商品，也不表示
阿里云对 BailingHub 的认证、推荐、采用或合作。

## 架构与边界

```text
百炼 Agent / 工作流
    |
    | MCP 工具参数：request_id、input、job_id
    v
百炼托管的 bailinghub-mcp-server
    |
    | 固定 route + 路由级 Client Token
    v
自托管 BailingHub
    |
    | 白名单、风险、审批、幂等、审计、任务状态
    v
业务系统
    |
    +-- 解析可信主体并执行最终授权
```

`BAILINGHUB_BASE_URL`、`BAILINGHUB_CLIENT_TOKEN` 和 `BAILINGHUB_ROUTE`
是部署配置，不是模型可选择的 MCP 工具参数。适配器只使用稳定的公开 Client API：

- `POST /run`
- `GET /jobs/{job_id}`

它不会调用管理员、执行器、审批决策、工具代理或业务系统凭据接口。

## 前置条件

1. 一个可从阿里云函数计算访问的 HTTPS BailingHub 部署。
2. 一条专用于百炼的 BailingHub 路由，例如 `bailian_assistant`。
3. 一个只允许访问该路由的 BailingHub Client Token。
4. 首次验证时使用无副作用路由，不开放真实写操作。

不同百炼应用需要不同治理边界时，应使用不同路由、Client Token 和 MCP 服务实例。
不要复用管理员 token、执行器 token、业务系统凭据或其他生态入口的 Client Token。

## 1. 校验公开配方

```bash
python3 docs/integrations/bailian/verify_recipe.py
```

通过时输出：

```text
PASS: Bailian to BailingHub MCP recipe is structurally valid.
```

## 2. 创建百炼自定义 MCP

进入百炼 MCP 服务管理，选择“创建 MCP 服务”与“脚本部署”。百炼官方脚本部署支持
`npx` 启动 Node.js STDIO MCP，并由函数计算托管进程。

复制 [`bailian-mcp-config.json`](bailian-mcp-config.json)，只替换三个值：

```json
{
  "BAILINGHUB_BASE_URL": "https://your-bailinghub.example.com",
  "BAILINGHUB_CLIENT_TOKEN": "your-dedicated-route-scoped-client-token",
  "BAILINGHUB_ROUTE": "bailian_assistant"
}
```

保留以下启动参数不变，以便部署可复现：

```json
{
  "type": "stdio",
  "command": "npx",
  "args": ["-y", "bailinghub-mcp-server@0.1.0"]
}
```

根据延迟目标和成本预算选择百炼“基本模式”或“极速模式”，并选择靠近 BailingHub
部署的地域。脚本部署可能产生函数计算费用；费用和运行模式以百炼当前控制台与官方
文档为准。

配置中包含 Client Token。不要把已填写凭据的 JSON 提交到 Git、粘贴到公开 Issue、
截图或文章中。若凭据进入非受信环境，应立即在 BailingHub 轮换。

## 3. 测试三个 MCP 工具

部署完成后，百炼应发现：

| 工具 | 用途 |
| --- | --- |
| `submit_governed_job` | 通过运维固定的路由提交一个受治理任务 |
| `get_governed_job` | 查询该 Client 所属任务的当前公开状态 |
| `wait_for_governed_job` | 最多等待 60 秒，不重新提交业务动作 |

首次测试使用无副作用输入：

```text
request_id: bailian-e2e-<一个新的稳定标识>
input: Return exactly BAILIAN_BAILINGHUB_E2E_OK. Do not call business tools.
```

保存 `submit_governed_job` 返回的真实 `job_id`，再调用：

```text
wait_for_governed_job(job_id=<真实 job_id>, max_wait_seconds=20)
```

不要编造 `job_id`。同一个业务请求需要重试时，复用原始 `request_id` 和相同任务语义；
等待超时只表示当前未到终态，不应创建替代任务。

## 4. 接入百炼 Agent 或工作流

把已部署的 MCP 服务添加到 Agent 或工作流，并给模型明确的调用顺序：

```text
需要执行真实业务动作时：
1. 为同一业务请求生成并保留稳定 request_id。
2. 调用 submit_governed_job，不要传入主体凭据、token 或审批结论。
3. 保存返回的 job_id。
4. 使用 wait_for_governed_job 做有界等待；超时后用 get_governed_job 查询。
5. queued、running、dispatched 不是失败；done、error、rejected 是终态。
6. 不得把工具返回当作业务系统最终授权。
```

## 验收标准

一次最小验证只有同时满足以下条件才算通过：

- 百炼发现并调用三个 MCP 工具；
- 提交请求只能进入运维固定的 BailingHub 路由；
- 相同 `request_id` 不产生重复任务；
- 返回的同一 `job_id` 到达终态，或在有界等待后保留可继续查询的状态；
- BailingHub 保留所选路由实际产生的审批与审计状态；无副作用路由可以不触发审批；
- 百炼和模型没有获得管理员、执行器或业务系统凭据；
- 业务系统仍执行最终主体解析和授权。

发现问题时可使用
[独立验证 Issue 模板](https://github.com/bailinghub/bailinghub/issues/new?template=independent_validation.yml)
并选择 MCP 路径。不要提交 token、模型密钥、个人信息或生产业务数据。

## 当前验证状态

- 配方 JSON、固定包版本和凭据边界已由仓库校验器验证。
- `bailinghub-mcp-server@0.1.0` 是独立开源适配器，不修改 BailingHub Core。
- 2026-07-27，维护者在北京地域使用百炼自定义 MCP 脚本部署与付费极速模式完成了真实
  无副作用 E2E：平台发现全部三个工具，`submit_governed_job` 返回 `queued`，同一
  `job_id` 经 `wait_for_governed_job` 到达 `done`，结果为
  `BAILIAN_BAILINGHUB_E2E_OK`。
- 对应 BailingHub 调度流记录了固定路由 `bailian-e2e`、目标 `llm` 与终态 `done`；
  测试没有开放业务工具，也没有把业务凭据交给模型或百炼。
- 以上是维护者工作空间中的兼容性证据，不代表阿里云认证、推荐、采用、合作或公开市场
  收录。不同部署仍应使用自己的隔离路由和无副作用输入完成验证。

## 官方参考

- [百炼自定义 MCP](https://help.aliyun.com/zh/model-studio/custom-mcp)
- [百炼 MCP 介绍](https://help.aliyun.com/zh/model-studio/mcp-introduction/)
- [BailingHub MCP Server](https://github.com/bailinghub/bailinghub-mcp-server)
- [BailingHub MCP 集成入口](https://www.bailinghub.com/en/integrations#mcp)
