# BailingHub v0.1.6：独立验证路径与安装后权限提示

`v0.1.6` 是一个安装体验与独立验证补丁。它不改变 BailingHub 的运行时 HTTP 契约、SDK、签名格式、ACC 语义或数据库结构。

## 为什么发布这个补丁

在全新 Ubuntu 24.04 服务器回归中，安装器能够在当前非 root 用户尚未获得 Docker socket 权限时，自动使用 `sudo docker` 完成部署；但安装结束页过去固定打印不带 `sudo` 的运维命令。部署本身是健康的，用户照抄命令却会立即得到权限错误，容易误判为安装失败。

同一轮复核还发现，公开独立验证任务把源码克隆和构建当作唯一核心路径，给只想验证产品闭环的开发者增加了不必要门槛。

## 本次变化

- 安装器按当前会话真实权限打印 `docker compose` 或 `sudo docker compose`；
- 全新 Ubuntu/Debian 一键安装成为推荐的核心独立验证路径；
- 本地源码复现保留为等价替代路径；
- 中英文任务卡明确非生产环境、凭据保护和清理边界；
- Issue 模板分别记录一键安装、源码 Docker、Dify 与执行器验证，源码提交号只在源码路径需要。

## 升级与兼容性

已有部署无需迁移。该补丁不新增数据库迁移，不修改工具签名、审批、审计、执行器、聊天或 SDK 契约，也不改变 ACC 的字段与解释。

新安装者继续使用原命令：

```bash
curl -fsSL https://www.bailinghub.com/install.sh | sh
```

安装完成后，应原样使用安装器“常用命令”中打印的 Compose 前缀。

## 验证

- `sh -n scripts/install.sh`；
- `npm run docs:check`；
- `npm run release:check`；
- 隔离 Ubuntu 24.04 安装回归；
- 非 root 当前会话正确打印 `sudo docker compose -f docker-compose.images.yml`；
- `/health`、10 项 smoke 和完整 `demo:e2e` 通过；
- 隔离容器、网络、数据卷、目录和含凭据日志完成清理，既有实例保持健康。

独立验证任务见 [INDEPENDENT_VALIDATION.md](INDEPENDENT_VALIDATION.md)。
