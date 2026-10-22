# 模型输出预算契约

AIaaS 模型服务将“新请求默认使用多少 token”和“服务最多允许请求多少 token”分开配置。适用范围为 `/usage/v1/model/models` 与对话模型网关，不改变嵌入聊天的知识库装配、图片模型工具、计量或请求恢复机制。

## 服务配置与目录

| 后台配置 | 模型目录 | 含义 |
| --- | --- | --- |
| `maxOutputTokens` | `max_output_tokens` | 运营设置的服务请求上限，正整数，平台当前允许 1–131072；不是供应商模型能力声明 |
| `defaultOutputTokens` | `default_output_tokens` | 新请求未指定输出预算时使用的默认值，正整数且不超过服务上限 |
| `outputTokenParameter` | `output_token_parameter` | 当前供应商路由实际采用的参数：`max_tokens` 或 `max_completion_tokens` |
| `outputBudgetScope` | `output_budget_scope` | `completion_total` 表示思考与答案共享总预算；`final_answer` 表示只限制最终答案 |
| `modelMaxOutputTokens` | `model_max_output_tokens` | 可选，已核实的供应商对当前参数和 scope 支持的最大值；未知时省略，服务上限不能超过它 |

默认值、参数、scope 必须一起显式配置，不能只填一部分。本方契约限定 `max_completion_tokens` 必须使用 `completion_total`；`max_tokens` 可配两种 scope，具体取决于实际供应商路由。元数据不负责探测或保证供应商能力，不能按模型名称猜测。更换模型、供应商凭据或路由后，应重新核对参数、scope 和供应商最大值。

`modelMaxOutputTokens` 只允许与显式策略一起提供，平台接受其正整数范围为 1–10000000；即使供应商模型能力更高，也不会放宽 `maxOutputTokens` 的平台有界限制。上下文窗口、输出预算、输入字节限制和超时是不同约束，仍独立生效。目录不会透露凭据别名、providerScope、供应商 URL 或请求内容。

显式配置示例（仅展示字段语义，不是任何真实模型的推荐值）：

```json
{
  "maxOutputTokens": 65536,
  "defaultOutputTokens": 32768,
  "outputTokenParameter": "max_completion_tokens",
  "outputBudgetScope": "completion_total",
  "modelMaxOutputTokens": 131072
}
```

对应目录包含 `max_output_tokens: 65536`、`default_output_tokens: 32768`、`output_token_parameter: "max_completion_tokens"`、`output_budget_scope: "completion_total"`、`model_max_output_tokens: 131072`。`provider_options` 只声明所选输出参数，其他既有可透传选项保持原样。网关 capabilities 通过 `output_budget` 下的 `bailing.model-output-budget.v1` 声明支持该契约。

## 请求派发与拒绝

显式策略下，省略输出参数会使用独立默认值和已配置参数；使用匹配参数时允许请求到服务上限，精确上限可通过，超过 1 token 仍拒绝。客户端不能同时传两种输出参数。使用另一种参数会得到 HTTP 400 `USAGE_OUTPUT_PARAMETER_MISMATCH`，不会被静默重命名，因为两种字段可能具有不同预算含义。

```json
{
  "error": "USAGE_OUTPUT_PARAMETER_MISMATCH",
  "dispatch": "not_dispatched",
  "feedback": {
    "output_budget": {
      "expected_parameter": "max_completion_tokens",
      "scope": "completion_total"
    }
  }
}
```

超过服务上限返回 HTTP 413 `USAGE_OUTPUT_LIMIT`，`feedback.output_limit` 包含 `actual`、`allowed`、`parameter` 以及已知时的 `scope`。这些都是非敏感标量，不包含消息、完整请求、供应商配置或凭据。两类拒绝均发生在本次 operation 受理和供应商派发之前；不会自动缩减预算、重试或收费。

`thinking.budget_tokens`、`reasoning_effort` 等既有参数继续透传，Core 不擅自分割或叠加思考预算。供应商 usage 中的 reasoning token 子集不重复加到 completion token 上计费；传输完成也不保证答案未被供应商 token 限制截断。

## 旧服务与原请求

三项策略均未配置的旧服务保持既有行为：目录不产生独立默认、scope 或供应商最大值；未显式传输出参数时继续以服务上限作为默认 `max_tokens`，原来允许的两种输出字段仍可二选一。后台只修改名称或其他字段不应悄悄启用新策略。旧图片工具配置中的 `maxOutputTokens` 残留不会被解释为图片 token 上限，新增对话预算字段不允许写入图片工具。

已受理的 operation 通过原 ID 和原请求 hash 核对并恢复，优先于当前模型策略检查；后续策略变化不会改写其 service snapshot、intent、计量或再次派发。客户端保留原 operation、digest 和恢复流程。

已经在客户端准备、但尚未被 Core 受理的旧请求不享有旧配置快照。启用新策略后，原参数可能被明确拒绝。此时应刷新目录、说明变化并显式准备新 operation；不能改写原 intent、复用原 operation 内容重试，或将参数错误当作网络错误自动重发。

客户端应分别消费默认预算和上限，并按目录字段构造新请求，不能把所有服务重新写死为 8192，也不能把默认预算当作允许的最大值。SDK 提供解析和新请求构造帮助函数；现存 prepared 请求不经过此构造函数重写。部署本契约不自动更改旧服务配置，生产预算调整和真实模型长输出验收需分别完成。

## 本地验证

- `node --import tsx --test src/modules/usage/output-budget.test.ts`：成组校验、旧目录兼容、默认/上限边界、参数语义、非敏感回执、本地 HTTP provider 实际请求以及 reasoning 计量。
- 有专用合成本地 MySQL（`127.0.0.1:16307`）时：`BAILING_USAGE_TEST_MYSQL=1 node --import tsx --test src/modules/usage/output-budget.mysql.test.ts`。每个用例只创建并移除随机测试数据库；验证持久化、目录到派发、已受理原请求恢复、未受理旧 intent 拒绝及不重复收费。不读取真实部署配置或调用真实供应商。
