# Core v0.10.1 升级指南

[English](UPGRADE_v0.10.1.en.md)

本指南面向 Core 0.10.0 → 0.10.1，以及业务侧声明生成 SDK 的配套更新。ACC 规范 1.0.6 与声明 `version: 1` 不变，MCP / Agent Client SDK、DSH 不因本补丁另行发版。更早的 Core 来源仍按[0.10.0 升级指南](UPGRADE_v0.10.0.md)及原迁移链核对。

## 1. 固定身份与保留原材料

记录源/目标 Tag、精确提交、运行包或镜像摘要；业务 SDK 另外保存原文件清单、候选包 SHA-256 和更新前的生成声明。不要以文件名相同或“都是 PHP7”代替制品核对。

Core 升级按原部署流程备份配置、数据库/JSONL、迁移账本、原 operation/invocation 与审批记录，停止新接单并排空。相对 0.10.0 **无新增 SQL，也不修改历史 SQL 或迁移器**；不需要手写迁移账本。保留原制品与声明用于差异分析和受控回退。

## 2. 业务负责人核对声明差异

生成器现在保留过去省略的显式 risk、readonly 和 idempotent。先在非生产环境重建声明，逐条比较变化：

- **显式 low 的非只读 POST**：此前可能因字段丢失而得到 medium；现在按原作者的明确声明得到 low。确认该标注确实合理；不要为消除差异把所有写操作设为 low。
- **GET + 显式 readonly=false**：现在保持非只读；未声明 risk 时为 medium。检查它是否真的修改业务状态，以及 GET 的接口设计是否符合业务实际。
- **GET + 显式 idempotent=false**：现在保留该提示。核对调用方不得依赖旧的 GET 一律幂等推断；这不是自动重试或恰好一次执行的承诺。
- **未设置字段**：继续省略，GET 的原只读缺省及非只读 POST 的 medium 缺省不变。
- **审批与授权**：显式 low 不会删除 `approval.required`、`approval.when`、主体要求或业务系统最终权限。保留这些规则并核对配置，不因风险值变化绕过审批。

JSON、ETag、声明摘要和工具发现修订可能变化。按原流程刷新工具源与客户端发现结果，只为新的调用使用新声明；原 invocation、冻结参数和审批记录保持原身份，修订不匹配按既有准备/恢复流程处理。不要改写历史记录或自动重放业务。

## 3. 生成器兼容性

| SDK | 未设置 risk 的中间表示 | 接入注意 |
| --- | --- | --- |
| PHP7 | `ToolDef` 未调用 risk 时不创建该选项 | 方法签名不变，继续兼容 PHP 7.3；显式 boolean false 不再丢失 |
| PHP8 | `AiTool::$risk` 是 `?string`，默认 `null` | 构造参数顺序/名称不变；直接读取该属性的自定义代码需接受 null |
| Node.js | 未设置值不再补成 `'low'` | 自行读取 `tool()` 返回对象的代码应处理未设置状态 |
| Python | 未设置值不再补成 `'low'` | 自行读取中间字典的代码应处理未设置状态 |
| Go | 空字符串表示未设置；布尔字段仍为指针 | 原结构类型不变，非空显式 risk 与 bool 指针值均保留 |
| Java | `Tool.risk` 默认 `null` | 直接读取字段的代码应处理 null；readonly/idempotent 仍为可空 Boolean |
| .NET | `Tool.Risk` 默认空字符串 | 保持 string 类型，空字符串表示省略；布尔字段仍可空 |

这些是业务侧 SDK，不要求对 MCP / Agent Client SDK 0.8.0 或 DSH 0.8.0 做版本替换。使用其他消费者的项目需独立验证其优先级；不能仅凭 ACC 参考检查器通过就宣称整条业务链已验收。

## 4. 配套包与验收

从同一发行身份取得 `web/connect/bailing-connect-php7.tgz` 或 `bailing-connect-php.tgz`，核对发布清单中的包 SHA-256。源码检出后可运行：

```bash
node scripts/check-php-sdk-artifacts.mjs
# 使用实际 PHP 7.3 可执行程序核对 PHP7 源码及解包内容：
node scripts/check-php-sdk-artifacts.mjs --sdk php7 --php /path/to/php7.3
```

验包工具检查完整文件集合、逐文件 SHA-256 和真实生成器回归，不只验证文件存在。两侧 driver 也支持把解包根目录作为第一个参数：

```bash
php sdk/php7/tests/declaration-serialization.php /path/to/bailing-connect-php7
php sdk/php/tests/declaration-serialization.php /path/to/bailing-connect-php
```

分别核对：24种风险/只读组合、6种幂等组合、显式 low 不删除审批/主体，以及 Core 消费相同声明后的 readonly、idempotent、risk。先用合成接口确认；接入方审阅自己的全量声明差异，不为升级验收执行真实写业务。部署后另核精确版本与 `/health/ready`，合成回归不代替部署或实际业务验收。

Core 与生成器应配套验证。若暂时只能更新其中一层，明确记录尚未修复的另一层；不要通过省略 false、改 HTTP 方法或统一调整风险来掩盖缺口。

## 5. 依赖维护与回退

本版对开发/构建链中的 `fast-uri 3.1.9`、`Vite 6.4.5` 做限定补丁更新；保持安装锁文件，运行相应构建与依赖审计。它们不是新的业务协议，也不表示已经证实生产受到攻击。

回退前停止新接单、排空并保存新产生的记录及声明修订。旧 SDK 会再次省略相应显式值，旧 Core 会再次覆盖 GET 的显式 false；因此回退不是仅换版本号。应在隔离环境核对旧生成声明与旧消费者组合，必要时停用有歧义的能力，保留人工核查路径。不要删除审批、unknown 状态、原调用或账本；恢复备份不能撤销已经发生的外部业务动作。

[版本说明](RELEASE_NOTES_v0.10.1.md) · [兼容策略](兼容性与升级.md) · [运维](OPERATIONS.md)
