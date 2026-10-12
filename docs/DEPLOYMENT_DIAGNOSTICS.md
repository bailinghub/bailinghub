# 只读部署诊断

部署诊断沿用 `npm run doctor`，增加一个面向已安装 Core 的独立模式。原有不带参数的 doctor 继续检查源码、文档、示例和开源边界；部署模式只核对指定实例的公开健康与版本信息，不执行原有 doctor 的检查脚本。

英文版见 [DEPLOYMENT_DIAGNOSTICS.en.md](DEPLOYMENT_DIAGNOSTICS.en.md)。部署与恢复步骤见 [OPERATIONS.md](OPERATIONS.md)，能力和证据范围见 [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md)。

## 使用

在 Core 源码、源码安装目录或已解包的 npm 制品目录执行：

```bash
npm run --silent doctor -- --deployment --url http://127.0.0.1:18900 --json
```

URL 必须由操作者显式提供，不从 `.env`、`config.json` 或 smoke 环境变量猜测目标。支持受控的 Core 挂载前缀，例如 `https://hub.example.com/core`；输出不显示这个前缀。URL 不能包含用户名、密码、query 或 fragment，诊断不接收 Token 参数，也不自动登录。

默认仅发送 `GET /health` 和 `GET /version`。它不连接数据库、不读配置内容、不调用模型，也不执行迁移、安装、升级、回滚、容器或服务操作。仅检查 `config.json` 和 `.env` 是否存在；文件缺失可能表示由环境或宿主注入配置，因此有效配置仍标为 `unknown`。凭据安全性标为 `not_checked`，不会假装完成默认 Token 或数据库连接串检查。

容器部署可在容器中已安装的 Core 目录执行相同命令，也可在外部解包的 Core 制品目录诊断公开 URL。工具不会运行 `docker inspect`、读取容器环境或推断正在运行的镜像 digest；容器启动、权限和 digest 须由部署流程另行核对。

若本地目录不是要对照的制品，可显式指定受信任发行记录中的版本和提交：

```bash
npm run --silent doctor -- --deployment --url https://hub.example.com \
  --expect-version 0.9.1 --expect-commit f37df6042b390405a5f7b1630636d3017607db9f --json
```

本地身份来自 `package.json` 与 Git HEAD；无 Git 时才使用 `build-info.json` 的提交。默认比较本地版本与提交，提交可按至少 12 位十六进制前缀匹配。Git 工作树另行只读检查并标为 `clean`、`dirty` 或 `not_checked`，不会输出文件名，也会禁用 fsmonitor hook 与可选 index 写入。默认对照本地源码时，dirty 或无法检查的 Git 工作树保留不完整结果，不把未提交内容当作 HEAD 对应制品。

安装目录没有可用提交元数据时，source 保留 `unknown`，退出码为 2；显式期待值也不会补造本地源码身份。工具仍会输出已取得的公开结果，后续由部署流程提供缺失的制品证据。

显式期待值只改变对照对象，不将另一个本地制品的 SQL 列表强行视为运行实例的列表。source 的依据是 `local_metadata`，runtime 的依据是 `reported_metadata`；两者的 `artifact_integrity` 均为 `not_checked`。即使工作树 clean、版本和提交完全匹配，也只证明声明一致，不能证明部署制品的内容、签名或 digest。正式升级仍须核验制品清单、完整性、备份和兼容性。

## 健康、readiness 与数据库身份

| 证据 | 默认行为 | 能说明什么 |
|---|---|---|
| `/health` | 读取 | 实例响应、暂停标记与公开应用身份；暂停标记不等于进程死亡。 |
| `/version` | 读取 | 实例声明的应用版本、构建提交与制品所带 SQL 最新文件和数量。 |
| `/health/ready` | `not_checked` | 只有显式 `--readiness` 才读取；服务端会只读检查数据库及迁移账本。 |
| `/admin/api/version`、`/admin/api/status` | `not_checked`，不发送请求 | 受保护状态和已应用迁移明细需另行取得授权证据。 |

显式检查 readiness：

```bash
npm run --silent doctor -- --deployment --url http://127.0.0.1:18900 --readiness --json
```

此选项会让服务端执行 `SELECT 1` 和迁移账本读取，不应称为“无数据库访问”。工具本身仍不直接连接数据库。报告中 `migrations.readiness` 仅记录服务端公开摘要；`migrations.identity` 始终是 `not_checked`，不会以 pending 为零证明实际数据库身份、全量 checksum 或 SQL 升降级兼容。JSONL 后端跳过数据库检查时保留 `unknown`，不会写成数据库已验证。

公开端点返回 401/403 时记录 `authentication_required` 和 `not_checked`，不尝试绕过权限或调用管理员端点。health 和 version 声明不一致、期待提交不符或 readiness 不就绪均作为失败证据。

## JSON 与退出码

JSON 的 `schema` 为 `bailing.deployment-diagnostics.v1`，包含 source、runtime、comparison、configuration、database、migrations、protected_endpoints、upgrade、checks 和请求 scope。身份状态区分 `verified`、`mismatch`、`unknown`、`not_checked`；`verified` 表示取得且核对了对应声明，不是密码学制品认证或生产采用证明。

| 退出码 | 含义 |
|---|---|
| `0` | 本次选择的检查通过；配置、直接数据库连接、已应用迁移身份和受保护端点仍可能未检查。 |
| `1` | 实际失败、不可达、非预期响应、拒绝的 URL 或身份不一致。 |
| `2` | 证据不完整，例如未提供 URL、版本/提交缺失、所选公开端点需认证，或 readiness 跳过数据库。 |
| `64` | CLI 参数无效。 |

`upgrade.state` 始终是 `not_checked`。退出 0 不允许工具自行升级或回滚，也不替代暂停、排空、备份、迁移审批和上线验收。Core 诊断只核对指定 Core 的公开声明；宿主实例管理与客户端任务编排由各自项目负责。

每个请求默认限时 5000 ms，可用 `--timeout-ms 100` 至 `--timeout-ms 30000` 调整；包含响应体读取，最多读取 64 KiB 解码后的内容。所有重定向均拒绝，包括同 origin 跳转，使用最终 Core URL 重试。请求只携带 JSON Accept，不携带登录 Cookie、Authorization 或配置凭据。输出只保留固定白名单字段和原因码，不输出异常正文、响应正文、重定向目标或输入中的凭据；错误 URL 不会原样打印。

不带 `--json` 时输出简短可读结果。自动化应使用 `npm run --silent` 得到纯 JSON，并同时检查退出码与报告范围；`BAILING_DOCTOR_FULL`、`BAILING_DOCTOR_SMOKE` 和 smoke 的 URL/Token 环境变量不影响部署模式。

## 本地验证

```bash
node --import tsx --test scripts/doctor-deployment.test.ts
```

测试使用临时目录、临时 loopback HTTP 服务和现有公共路由，覆盖方法与路径白名单、身份不一致、权限、readiness 区分、超时、响应大小、重定向和凭据脱敏。测试不连接真实数据库、模型或生产服务。测试通过只说明这些诊断边界通过验证，不能替代目标部署的验收。
