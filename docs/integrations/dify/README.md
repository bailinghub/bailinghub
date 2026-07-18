# Dify + BailingHub 最小接入配方

> 状态：维护者已于 2026-07-18 完成 Dify Cloud 真实导入和无副作用 E2E；外部独立复现仍待社区反馈。本文不代表 Dify 官方合作或认证。

[English](README.en.md)

## 适用场景

当 Dify Agent 或 Workflow 需要操作已有业务系统时，不要把受治理的业务 OpenAPI 和业务密钥直接交给 Dify。更小且边界清晰的接入方式是只向 Dify 暴露 BailingHub 控制面：

```text
Dify Agent / Workflow
  -> POST /run                 创建受治理任务
  -> GET /jobs/{job_id}       查询任务状态与结果
  -> BailingHub               路由、主体、风险、审批、审计
  -> business API             业务系统保留最终授权
```

这个配方具有三个重要性质：

1. Dify 不持有业务系统密钥，也不绕过 BailingHub 直接调用业务 API；
2. Dify 只能使用专用接入方被允许的 `route`，不能覆盖 `project` 或 `profile`；
3. 同一次业务请求重试时复用 `request_id`，由中枢在接入方范围内保证幂等。

## 前置准备

在自部署 BailingHub 中创建专用于 Dify 的接入方：

- 生成独立 Client Token，不使用管理员 Token 或执行器 Token；
- 只开放 Dify 实际需要的 route；
- 设置合理的每分钟限速；
- 不向 Dify 提供业务 API 密钥、主体凭据或生产管理凭据。

本配方要求 BailingHub 使用 MySQL 后端，因为接入方 route 白名单和 route 解析依赖持久化配置。

## 导入 Dify

1. 打开 [bailinghub-control-plane.openapi.json](bailinghub-control-plane.openapi.json)。
2. 将 `servers[0].url` 改为自部署 BailingHub 的 HTTPS 地址，不带末尾 `/`。
3. 在 Dify 工作区进入 `集成 -> 工具 -> Swagger API 作为工具 -> 添加 Swagger API 作为工具`。
4. 粘贴 OpenAPI JSON。
5. 鉴权方法选择 `请求头`：
   - 鉴权头部前缀：`Bearer`
   - 键：`Authorization`
   - 值：只填写 BailingHub Client Token，不重复填写 `Bearer ` 前缀
6. 保存后应出现两个工具：
   - `bailinghub_start_job`
   - `bailinghub_get_job`

## Agent / Workflow 使用约束

可以把下面这段作为 Dify Agent 的工具说明：

```text
需要操作业务系统时，只能先调用 bailinghub_start_job，不能直接调用业务 API。
request_id 必须对当前业务请求唯一；同一次请求重试时必须复用原 request_id。
保存返回的 job_id，并用 bailinghub_get_job 查询结果。
queued、running、dispatched 表示仍在执行；done 表示成功；error 或 rejected 表示失败并停止。
不得自行改变 route，不得把 BailingHub Token、业务密钥或主体凭据写入 input。
```

推荐由 Workflow 的确定性节点生成 `request_id`，不要让模型自由编写。例如：

```text
dify:<conversation-id>:<workflow-run-id>:<step-id>
```

## 状态处理

| 状态 | 含义 | Dify 下一步 |
| --- | --- | --- |
| `queued` | 已进入中枢队列 | 稍后查询同一 `job_id` |
| `running` | 中枢正在执行 | 稍后查询 |
| `dispatched` | 已派发给外部执行器 | 稍后查询 |
| `done` | 已完成 | 使用 `result` |
| `error` | 执行失败 | 展示 `error`，不要自动换参数重试 |
| `rejected` | 被治理或业务边界拒绝 | 展示 `error`，交由用户或管理员处理 |

## 已验证与未声称

已验证：

- OpenAPI 文件只暴露 BailingHub 的 `/run` 与 `/jobs/{job_id}`；
- 请求只包含 `request_id`、`route`、`input`，不暴露管理字段或业务凭据；
- Dify Cloud 的 Swagger API Tool 能创建两个工具并使用自定义 `Authorization` Header；
- 真实网络调用已完成 `queued -> done`；
- BailingHub 会校验接入方 route 白名单、限速、任务归属和幂等键。

未声称：

- 尚未证明任意模型都能稳定自主选工具并完成轮询；
- Dify Swagger API Tool 不会自动替使用者完成有界轮询，Agent 或 Workflow 需要显式处理状态；
- Dify 作为 BailingHub 外部执行器需要另一套 claim、heartbeat、tool proxy 和 result 适配，不属于本配方。

## 校验

结构校验不发起网络请求：

```bash
python3 verify_contract.py
```

成功输出：

```text
PASS: Dify -> BailingHub minimal integration contract is structurally valid.
```

在专用 Client Token 和无副作用测试 route 准备好后，可以复测真实链路：

```bash
BAILINGHUB_TOKEN='<dedicated client token>' \
python3 verify_e2e.py \
  --base-url 'https://hub.example.com' \
  --route 'dify-e2e'
```

校验器不会打印 Token。请勿对生产写操作 route 运行默认测试，也不要使用管理员 Token。

## 反馈

如果你完成了独立复现，欢迎提交 Issue，并附上 Dify 形态（Agent 或 Workflow）、BailingHub 版本、脱敏后的状态序列和遇到的问题。不要提交 Token、业务密钥或生产数据。

## 一手依据

- [Dify Tool Plugin](https://docs.dify.ai/en/develop-plugin/dev-guides-and-walkthroughs/tool-plugin)
- [Dify plugin type selection](https://docs.dify.ai/en/develop-plugin/getting-started/choose-plugin-type)
- [Dify Tool return values](https://docs.dify.ai/en/develop-plugin/features-and-specs/plugin-types/tool)
- [BailingHub HTTP contract](../../CONTRACT.md)
- BailingHub `src/routes/run.ts`
- BailingHub `src/routes/private.ts`
