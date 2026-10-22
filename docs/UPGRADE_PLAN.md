# 离线只读升级计划

[English](UPGRADE_PLAN.en.md)

`doctor --upgrade-plan` 比较显式提供的当前制品、目标制品及脱敏数据库快照，帮助整理升级步骤与证据缺口。它不会连接数据库、读取 `.env` / `config.json`、启动 Core、执行任何制品代码、运行 SQL、迁移、回退或改写输入文件。

它与 [部署诊断](OPERATIONS.md) 的 `doctor --deployment` 分开：部署诊断可检查公开 HTTP 元数据和 readiness；本工具不访问网络，也不把离线输入称作线上实测。未知信息保留为 `incomplete`。

## 1. 准备两个可信制品与官方 manifest

保留实际正在运行的版本和计划部署的版本，分别解压到独立目录。先按对应发行说明核对 Tag/提交、npm 包或镜像摘要；不要用随意修改版本号的工作目录替代正式制品。

现有发行包中的 `BAILINGHUB_CORE_ARTIFACT_V1` 是运行时导出对象，**没有预先生成的 manifest JSON 文件**。在每个已经信任、安装好运行依赖的制品根目录，使用官方模块导出文件，保存在制品目录之外：

```bash
node --import tsx --input-type=module -e 'import { BAILINGHUB_CORE_ARTIFACT_V1 } from "./src/kernel-api/v1/artifact.ts"; console.log(JSON.stringify(BAILINGHUB_CORE_ARTIFACT_V1, null, 2));' > /absolute/evidence/from-manifest.json
```

在目标制品目录重复一次，输出 `to-manifest.json`。此准备命令由操作员运行，导入的是已信任制品的官方只读 manifest 模块；升级计划工具本身不动态导入外部目录，也不会替你安装依赖或运行导出命令。旧制品如果不支持该 manifest，缺口必须另行确认，不能套用新版退役迁移清单伪造一份“旧 manifest”。

工具验证的内容：

- `packageName`、精确版本、完整 SQL 文件清单、每个活动 SQL 的 SHA-256、整体 manifest 摘要；格式复用 [Kernel Host API](KERNEL_HOST_API.md) 的 v1 manifest。
- 活动迁移文件名/编号、退役迁移 `replay: never`、是否遗漏或篡改已发布迁移证据。历史活动迁移不能直接改成退役，历史退役迁移不能放回活动 SQL；退役记录的摘要、字节长度与 `replay` 必须保持一致，即使重新计算 manifest 摘要也不能绕过。
- 升级/同版本/降级方向，包含 SemVer 数字比较和预发行版本；同版本不同 manifest 会阻断。

manifest 只标识版本与迁移集合，**不是整个包、源码或容器的签名证明**。如果有人同时改写 SQL、manifest 和摘要，离线自洽不能证明发行真实性；该项始终是 `release_authenticity: not_verified`，仍须核对可信发行来源。工具拒绝制品内 SQL/目录符号链接和路径穿越，不运行制品的 npm scripts。

## 2. 采集脱敏快照

这一版不提供自动数据库 collector。操作员在授权范围内使用现有只读连接，确认**实际有效**的状态仓储、配置仓储和它们的数据库身份；不能只从示例配置或目录名称推测。默认开源 MySQL 部署通常共库，扩展宿主可以分库；JSONL 状态也不能证明配置库不存在。

在每个实际 MySQL Schema 内，通过已有工具读取：

```sql
SELECT DATABASE() AS database_name, @@server_uuid AS server_uuid;
SELECT COLUMN_NAME FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME = 'bz_schema_migrations'
  AND COLUMN_NAME = 'checksum_sha256';
SELECT filename, checksum_sha256 FROM bz_schema_migrations ORDER BY filename;
```

最后一条适用于存在摘要列的账本；旧库无该列时只读取 `filename`，在快照中将摘要填为 `null`、`checksum_column` 填为 `absent`。不要为了生成计划而补账本或运行迁移。表不存在、读权限不足或无法确认读取完整性时，不能填写空数组并声称是完整账本。

采集时避免并发迁移，并使用一致性只读快照或记录停写窗口。数据库真实标识只留在受限操作记录中；为此次计划给每个经过确认的逻辑库生成一个随机 64 位小写十六进制代号，同库复用同一代号，分库使用不同代号。例如 `node -e 'console.log(require("node:crypto").randomBytes(32).toString("hex"))'` 只生成代号，不识别数据库。复制库不能因为内容相同就使用同一代号；复制集/代理连接须由操作员确认是否为同一逻辑 Schema。**代号不是数据库身份的独立证明。**

`snapshot.json` 定义：

| 字段 | 内容 |
| --- | --- |
| `schema` | 固定 `bailing.upgrade-snapshot.v1` |
| `captured_at` | 实际采集 UTC 时间，例如 `2026-10-21T04:00:00Z` |
| `source_manifest_sha256` | 从实际当前制品导出的 manifest 中原样取值，用于发现快照与来源选错；这仍是操作员声明 |
| `state` | `backend` 为 `mysql` 或 `jsonl`；MySQL 必须给 `database_id`，JSONL 为 `null` |
| `configuration` | `backend` 为 `mysql` 或 `file`；`file` 表示无数据库配置仓储、使用本地配置文件；身份规则同上 |
| `databases` | 实际涉及的 0–2 个逻辑库，每库一条，必须恰好覆盖两个角色需要的库 |
| `databases[].id` | 64 位小写十六进制代号，与角色的 `database_id` 对应 |
| `ledger_complete` | 是否完整读取该库全部账本；不完整填 `false`，工具不会据此伪造确定的 pending 清单 |
| `checksum_column` | `present` 或 `absent` |
| `rows` | 全部 `{ "filename": "001_….sql", "checksum_sha256": "64位小写摘要或null" }`；不得填业务记录 |

以下只是**故意不完整**的 JSONL + MySQL 配置库结构示例，不能直接当作环境验收证据。替换时间、真实当前 manifest 摘要、库代号与完整账本后才能进行有意义的比较：

```json
{
  "schema": "bailing.upgrade-snapshot.v1",
  "captured_at": "2026-10-21T04:00:00Z",
  "source_manifest_sha256": "0000000000000000000000000000000000000000000000000000000000000000",
  "state": { "backend": "jsonl", "database_id": null },
  "configuration": {
    "backend": "mysql",
    "database_id": "1111111111111111111111111111111111111111111111111111111111111111"
  },
  "databases": [{
    "id": "1111111111111111111111111111111111111111111111111111111111111111",
    "ledger_complete": false,
    "checksum_column": "present",
    "rows": []
  }]
}
```

不要将密码、连接串、账号、业务数据、主机地址或未脱敏 SQL 错误放进输入。输出只保留已定义的安全字段，不回显输入路径和解析错误正文。已保存的快照不是实时保证；部署、配置或账本有变化后重新采集，不能仅凭文件时间较近就认定有效。

## 3. 生成计划

```bash
npm run --silent doctor -- --upgrade-plan \
  --from-artifact /absolute/core-current \
  --from-manifest /absolute/evidence/from-manifest.json \
  --to-artifact /absolute/core-target \
  --to-manifest /absolute/evidence/to-manifest.json \
  --snapshot /absolute/evidence/snapshot.json \
  --json > /absolute/evidence/upgrade-plan.json
```

等价专用入口：`npm run --silent doctor:upgrade-plan -- ...`。`--help` 不读取输入。没有隐式路径、数据库发现或网络目标；缺少文件参数返回 `incomplete`，指定了不可读/无效文件则返回 `blocked`。

| 退出码 / 结果 | 含义 |
| --- | --- |
| `0 / reviewable` | 所给离线证据可比较、无已知冲突；**不是可以上线、备份恢复已验证或实测通过** |
| `1 / blocked` | 观察到制品/摘要/版本方向/快照冲突，或未知迁移；先查明原因 |
| `2 / incomplete` | 缺少来源、完整账本、数据库角色或历史摘要等证据 |
| `64 / invalid_arguments` | 参数错误或混用部署诊断参数 |

共库只输出一个迁移计划，分库逐一比较。旧账本摘要缺失不会自动补录，退役迁移不会列入待执行序列。当前制品应有但库里没有的迁移会标为不完整；账本含当前或目标制品不认识的迁移会阻断。`pending` 是完整快照相对目标活动序列的差集，不是 SQL 表/索引存在性检查。

## 4. 计划之后仍需人工执行与验收

输出固定列出制品身份确认、一致备份及隔离恢复演练、停止新工作与所有写入方、排空、分库显式迁移、验收和回退限制。`npm run db:init` 只覆盖 `state.mysql`；独立配置 MySQL 由部署方通过官方 `migrateBailingHubCoreSchema({ mysql: configurationDatabase })` 单独迁移，共库只执行一次。

只读计划不生成可直接执行的带连接参数命令，也不授权升级。涉及未知业务结果、审批、通知、死信的记录和原 ID 必须保留。新迁移不被旧 manifest 认识时，标记 `rollback_after_migration: blocked_by_old_manifest`；其他情况仍须验证，绝不标为“可安全降级”。数据库恢复不能撤销外部退款或已发送消息。

参考 [0.9.4 升级与回退指南](UPGRADE_v0.9.4.md)、[运维](OPERATIONS.md)及[兼容策略](兼容性与升级.md)。当前没有实际 DB 身份、schema 对象、运行中版本、备份恢复或跨版本业务回归的验证结果；这些仍由目标环境演练提供。

## 开发验证

```bash
npm run doctor:upgrade-plan:typecheck
npm run doctor:upgrade-plan:test
```

这些检查已接入 `release:check` 和 CI 的基础检查任务。测试使用合成制品与脱敏快照，并检查当前官方 manifest 格式；不连接数据库，不代替真实升级、备份恢复或生产验收。
