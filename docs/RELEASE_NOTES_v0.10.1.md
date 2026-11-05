# Core v0.10.1：保留业务系统明确声明的风险与执行语义

[English](RELEASE_NOTES_v0.10.1.en.md)

业务后端明确把一个 POST 操作标为低风险，导出的声明却省略了 `risk.level`；另一个 GET 明确标为非只读，消费时仍被当作只读。Core 0.10.1 修复业务接入 SDK 的显式值丢失，并让 Core 在读取声明时正确区分“未设置”和 `false`。

这是相对 Core 0.10.0 的补丁。**ACC 规范仍为 1.0.6，声明仍为 `version: 1`；MCP / Agent Client SDK 0.8.0、DSH 0.8.0 本轮不另行升级。** 本次修复的是 Core 仓库内的业务侧声明生成器及消费逻辑，不是这些独立客户端包。相对 0.10.0 无新增 SQL、认证协议或业务权限接口。

## 修复行为

PHP 7.3 builder、PHP 8 注解版、Node.js、Python、Go、Java、.NET 七种 SDK 生成器保留显式 `readonly: false/true`、`idempotent: false/true` 及 `risk.level: low/medium/high`。未设置的字段继续省略，不为所有写接口补上 low。

Core 读取布尔值时保留 `false`，只在字段未设置时使用 GET 的原缺省信号。有效风险先采用显式 risk，否则依据已经解析的只读性推导；HTTP 方法不能再次覆盖显式非只读声明。

| 声明 | 修复后的解释 |
| --- | --- |
| GET，未设置 readonly 和 risk | 保持只读、low 的缺省解释 |
| GET，`readonly: false`，未设置 risk | 非只读、medium |
| POST，未设置 readonly 和 risk | 保持非只读、medium |
| POST，显式 `risk: low` | 保留 low；既有审批、主体和业务授权要求继续独立生效 |
| GET，显式 `idempotent: false` | 保留非幂等提示，不被 GET 缺省覆盖 |

**修复会改变此前被错误省略或覆盖的声明的有效解释。** 业务负责人应确认显式 low 和 false 确实符合接口行为。特别是原先因 low 丢失而被解释成 medium 的写操作，更新后会恢复为声明的 low；不能把此变化视为无需核对的文本整理。

## 分发与验证

两个 PHP tgz 配套包随 Core 制品更新。新增验包工具比较 SDK 源码与归档的完整文件集合、逐文件内容和 SHA-256，再针对源码及解包目录分别运行实际生成器测试；缺文件、额外文件、摘要不一致或回归失败都不能通过。PHP7 保持 7.3 语法，PHP8 版要求仍为 PHP 8.1 及以上。

各生成器新增 GET/POST × readonly 未设置/false/true × risk 未设置/low/medium/high 的 24 组合回归，另测幂等显式值与缺省值。Core 回归检查字段优先级和有效风险；PHP 回归还核对显式 low 不删除审批与主体要求。验证使用合成能力，不调用真实业务，也不能替代接入方自己的声明审阅。

PHP8 的 `AiTool::$risk` 从默认 `'low'` 改为可空字符串、默认 `null`；Java 的未设置 risk 也为 null，.NET 使用空字符串，Node.js/Python 不再把未设置值补成 low。读取中间工具对象的自定义代码应处理未设置状态，详见[升级指南](UPGRADE_v0.10.1.md)。

本版同时将限定的开发/构建依赖更新到 `fast-uri 3.1.9` 与 `Vite 6.4.5`，用于通过本次发行审计门禁。该依赖维护本身不构成已发现生产利用或生产漏洞的结论。

## 升级边界

部署方更新 Core 与业务侧 SDK、重新生成和核对声明，再刷新工具源。**只换 SDK 不能修复旧 Core 对 GET 显式 false 的覆盖；只换 Core 也无法恢复旧生成器已经丢失的字段。** 对使用现成 OpenAPI 文件或其他 runtime 的接入方，分别核对声明内容和消费者行为。

原业务授权、签名、审批条件、原请求恢复和计量规则不在本次修改范围。不要为验收重放原业务，也不要改写已保存的原调用或批准参数。公开发行不代表任何现有部署、私有 Host 或下游系统已自动升级。

[升级指南](UPGRADE_v0.10.1.md) · [业务接入](第三方对接指南.md) · [CHANGELOG](CHANGELOG.md) · [上一版本](RELEASE_NOTES_v0.10.0.md)
