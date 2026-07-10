# brain/ — 大脑配置（能力档 / agent 提示词 / runbook）

这里是 **executor 类大脑**（Claude Code 等远端执行器）的配置：

| 文件 | 作用 |
|---|---|
| `profiles.json` | 能力档：每个档声明模型 / 最大轮次 / 超时 / 权限模式 / 工具白名单·黑名单 / 追加系统提示词文件 |
| `agents/*.md` | 角色系统提示词（被能力档的 `appendSystemPromptFile` 引用） |
| `runbooks/*.md` | 排查清单（同上，按场景挂载） |

> llm（inhub 进程内大脑）的配置不在这里——它走 DB（`bz_targets` / `bz_routes`），在控制台配。

## 定制不要直接改这些文件 —— 用 `.local` 叠加层

这些是**仓库跟踪的默认文件**。如果你直接编辑它们，下次 `git pull` 升级会跟我们的改动撞 merge 冲突。

正确做法：把你的定制写进**同名 `.local` 兄弟文件**（已 gitignore，升级永不被碰）：

| 想改 | 新建（不要动原文件） | 生效规则 |
|---|---|---|
| 能力档 | `profiles.local.json` | 按档名整档覆盖：同名档替换默认、新名档追加；其余默认档不变 |
| 某个 agent 提示词 | `agents/<名>.local.md` | 该档引用此 md 时，存在 `.local.md` 就读它、否则读默认 `.md` |
| 某个 runbook | `runbooks/<名>.local.md` | 同上 |

示例——只想换 `triage` 档用的模型、别的不动：

```json
// brain/profiles.local.json
{
  "triage": {
    "description": "我司定制分诊档",
    "model": "我自己的模型名",
    "maxTurns": 8,
    "timeoutMs": 120000,
    "permissionMode": "default",
    "allowedTools": ["Read", "Grep"],
    "disallowedTools": [],
    "appendSystemPromptFile": "agents/triage.local.md"
  }
}
```

新建 `brain/agents/triage.local.md` 写你的提示词即可。`profiles.json` 里其它档（如 `code-review`）继续用仓库默认，升级时自动拿到我们的改进，零冲突。

> 这是 [docs/兼容性与升级.md](../docs/兼容性与升级.md) 里「文件级配置走叠加层」纪律的落地：**默认可升级、定制不冲突**。
