# sql/ — 中枢状态库结构

中枢**独立**状态库（`bz_` 前缀，库默认 `bailinghub`）的 DDL，按编号顺序同步。用 `npm run db:init` 应用到当前结构版本。

## 怎么跑

```bash
npm run db:init     # 按文件名顺序应用所有未应用的结构文件
```

## Core 0.9.0：063/064 模型计费

`063_usage_model_billing.sql` 新建身份、账户、模型服务、USD 套餐、原请求账本与参考价格缓存，共 14 张表。不修改业务授权、审批或会话表。`064_period_plan_allowance.sql` 将已有周期计费配置和快照中缺失的 `periodAllowanceUsd` 补为各自原 `priceUsd`，保留原额度、请求哈希及账本；新安装的空计费表无数据回填。

只有一份美元账本：额度包显示 Credits，周期套餐显示百分比。原始 Token 独立保留，不作为额度限制。运行时不自动迁移；缺表或关键字段时明确不可用。公开 0.8.0 升级只需应用未执行迁移，保留真实数据，不要求清退测试结构；已部署计费预览的实例先协调停止旧写入并核对原快照。

完整规则见[模型服务与套餐计费](../docs/MODEL_BILLING.md)、[v0.9.0 升级指南](../docs/UPGRADE_v0.9.0.md)及[周期额度迁移](../docs/PERIOD_ALLOWANCE_UPGRADE.md)。这些迁移属于 Core 0.9.0 升级配套。

`scripts/init-db.ts` 的幂等模型：

- **账本为主**：`bz_schema_migrations` 记录每个已成功应用的文件名；**已记账的文件直接跳过、永不二次执行**。
  这让只应执行一次的结构动作也安全：记账后不会重放。
- **早期退役记录**：极少数只出现过在早期部署账本、但已从活动 SQL 序列退役的文件，只在 Core 的固化证据目录中保留文件名、原始字节摘要和长度。旧账本已有记录时可补录摘要；新库不执行、不记账，也不得把 SQL 文件放回本目录。
- **错误码容错兜底**：`IF NOT EXISTS` 自身幂等；加列/索引遇到 1060/1061 时，只有实际列/索引结构与官方语句一致才按已完成处理，跑完即记账，此后走账本快路径。
- **失败关闭**：账本出现既不属于活动序列、也不属于固化退役证据的文件，或者任一已记账摘要不匹配时，会在补录摘要或执行新迁移前拒绝继续。

## 058 跨系统归档成员绑定

`058_agent_conversation_member_bindings.sql` 在 Core 0.7.0 引入，只给已有归档增加
`membership_version`（默认 1），给成员增加 `client_app_id`、`route_key`、`client_name`（默认 NULL）。
057 保持原样；已应用 057 的实例不重复建表，也不回填或移动 Session、run、invocation、正文和旧成员身份。
旧记录按 v1 的共同绑定解释，NULL 不能冒充逐成员系统或路由证据。

Host 需把官方 SQL 一起打包，并通过现有迁移入口显式执行；运行时启动不自动迁移。
沿用上述迁移账本、摘要及结构核对，不引入另一套迁移引擎。仅有 057、缺少任一 058 新列，
或旧 Host 未实现可选跨绑定仓储方法时，能力探测不能返回跨绑定支持；旧 v1 功能保持兼容。
跨系统只在同一 Hub 和同一 Host 数据域内组合独立授权，不能跨租户拼库。
完整协议见 [Agent 对话审计](../docs/AGENT_CONVERSATION_AUDIT.md#未发布候选跨系统成员绑定)。

## 059 授权主体展示信息

`059_agent_subject_display.sql` 给 `bz_agent_authorizations` 和 `bz_agent_sessions`
各增加一个可空、默认 NULL 的 JSON 列 `subject_display`，独立保存授权主体的展示名称。
旧记录保留 NULL，表示名称待同步；不从设备名、用户备注或身份标识推断名称。
不改写 principal、授权范围、凭据、Session 或归档记录。业务后端以后可通过
[授权名称接口](../docs/AGENT_SUBJECT_DISPLAY.md) 为原会话补名。

使用这一能力前，先通过现有迁移入口显式应用 059；自定义 Host 也需打包官方 SQL，
并实现可选的名称更新仓储方法。旧 Host 不支持新命名操作时明确返回 unavailable，
仍可使用原不带名称的授权请求。迁移是否已应用，以目标实例的迁移账本为准。

## 写结构文件的铁律

结构文件是部署方数据安全的边界。守住这三条，发布后的结构同步才可预期。

1. **永远新增编号文件，绝不编辑已发布过的 `.sql`。**
   已部署实例会按账本跳过已应用文件；结构修正应新开一个编号文件承接。

2. **发布后只准这两类结构语句（纯增量、drop-in）：**
   - `CREATE TABLE IF NOT EXISTS ...`
   - `ALTER TABLE ... ADD COLUMN ... <类型> [NOT NULL] DEFAULT <值> ...`（加列**必须带 DEFAULT**，否则给已有数据的表加 NOT NULL 列会失败/填隐式默认）
   - 加索引（`ADD INDEX` / `ADD UNIQUE`）同理可幂等。
   - 种子数据用 `INSERT IGNORE` 或 `INSERT ... ON DUPLICATE KEY UPDATE`，**禁裸 `INSERT`**（重放会重复/报错）。
   - **禁** `UPDATE` 形态的一次性数据回填混在结构文件里；确需回填单开编号文件，靠账本保证只跑一次。

3. **禁破坏性语句：`RENAME` / `DROP COLUMN` / `DROP TABLE` / `MODIFY` 改列义。**
   要删列、改名、改类型 → 走 [docs/兼容性与升级.md](../docs/兼容性与升级.md) 第四节：
   使用新列名与过渡窗口，在 major 版本里完成移除。
   - `RENAME` 对重放状态敏感，能不用就不用。

## 命名

`NNN_简短描述.sql`，三位编号递增。编号只用于排序，**允许缺号**；新文件取当前最大编号 +1 即可。
