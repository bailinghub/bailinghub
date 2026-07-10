# brain/ - Executor Brain Configuration

This directory contains default configuration for executor-style brains such as remote code or investigation executors.

| File | Purpose |
|---|---|
| `profiles.json` | Capability profiles: model, max turns, timeout, permission mode, tool allow/deny lists, and appended prompt files. |
| `agents/*.md` | Agent system prompts referenced by profiles. |
| `runbooks/*.md` | Scenario-specific runbooks referenced by profiles. |

The in-hub OpenAI-compatible model target is not configured here. It is configured through database-backed targets and routes in the console.

## Do Not Edit Defaults For Local Customization

Tracked default files should remain upgradeable. Put local customization in `.local` sibling files that are ignored by Git.

| To customize | Create |
|---|---|
| Capability profile | `profiles.local.json` |
| Agent prompt | `agents/<name>.local.md` |
| Runbook | `runbooks/<name>.local.md` |

Local overlays avoid merge conflicts when upgrading the open-source repository.
