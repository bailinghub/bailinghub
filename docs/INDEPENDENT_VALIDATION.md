# 独立验证任务卡

这张任务卡用于回答一个具体问题：**一位此前不了解 BailingHub 的开发者，能否仅凭公开资料，在非生产环境独立部署并验证一次受治理的业务操作闭环？**

它不是认证、性能测试或生产采用证明。跑通本任务只说明公开安装路径和 demo 治理链路可以被独立复现；不代表验证者已把 BailingHub 接入真实业务。

## 验证范围

- 验证对象：BailingHub 开源版 Docker demo；
- 稳定基线：`v0.1.8`；
- 数据范围：仓库自带的 demo 订单、工单、退款和故障工具；
- 预计用时：镜像和依赖下载完成后约 20 分钟；
- 不需要：真实大模型 Key、生产 API、生产凭据或真实业务数据。

Dify、n8n、MCP 和执行器/OpenClaw 验证都属于可选扩展，不属于本任务的通过条件。请先完成核心 Docker demo，再按需继续扩展验证。

## 前置条件

请选择下面一种路径：

- **全新服务器一键安装（推荐）**：非生产 Ubuntu/Debian、`curl`、可用的 `sudo` 或 root 权限；安装脚本会检查并安装 Docker 与 Compose；
- **本地源码复现**：macOS 或 Linux、Git、`curl`、OpenSSL、Docker Engine 或 Docker Desktop、Docker Compose v2（`docker compose`）。

两条路径验证的是同一个 demo 治理闭环。请不要在生产主机、生产网络或已有重要数据的 Docker 环境中运行本任务。

## 1. 安装稳定版本

### 路径 A：全新 Ubuntu/Debian 服务器（推荐）

```bash
curl -fsSL https://www.bailinghub.com/install.sh | sh
cd "$HOME/bailinghub"
```

脚本默认拉取 `v0.1.8` 官方镜像，生成随机 Token 与后台密码，启动服务并自动运行基础体检。首次管理员只在数据库管理员表为空时创建；对同一持久化数据库进行重启、升级、容器重建或重新安装，不会覆盖已经修改的管理员密码。请保留终端输出中的版本、安装模式、耗时和“常用命令”，但不要把密码或 Token 写入反馈。新安装 Docker 后，当前非 root 会话通常仍需使用脚本打印的 `sudo docker compose ...` 命令；重新登录后 Docker 组权限才可能生效。

如果默认目录已被占用，请使用一个新的空目录，不要覆盖现有部署：

```bash
curl -fsSL https://www.bailinghub.com/install.sh | env \
  BAILING_INSTALL_DIR="$HOME/bailinghub-validation" \
  sh
cd "$HOME/bailinghub-validation"
```

### 路径 B：本地源码复现

```bash
git clone --depth 1 --branch v0.1.8 https://github.com/bailinghub/bailinghub.git
cd bailinghub
git rev-parse HEAD
export BAILING_TOKEN="$(openssl rand -hex 32)"
docker compose up -d --build
```

请保留提交号，并在后续命令中沿用同一终端和同一个 `BAILING_TOKEN`。所有写操作只会作用于本地 demo 数据。

## 2. 检查服务与控制台

路径 A 请使用安装器“常用命令”中打印的完整 Compose 前缀；在刚安装 Docker 的非 root 会话中通常是：

```bash
sudo docker compose -f docker-compose.images.yml ps
```

路径 B 使用：

```bash
docker compose ps
```

两条路径都检查：

```bash
curl -fsS http://localhost:18900/health
```

控制台地址为 <http://localhost:18900/console/>：

- 路径 A 使用安装完成时打印的随机后台密码；密码也保存在安装目录的 `.env`，不得提交到 Issue；
- 路径 B 使用默认 demo 账号 `admin / bailing-demo-admin`。

## 3. 运行基础体检

路径 A 使用安装器打印的命令，通常是：

```bash
sudo docker compose -f docker-compose.images.yml exec -T bailinghub npm run smoke
```

路径 B 使用：

```bash
docker compose exec -T bailinghub npm run smoke
```

通过标准：命令退出码为 `0`，最终汇总中的失败数为 `0`。

## 4. 运行完整业务闭环

路径 A 使用安装器打印的命令，通常是：

```bash
sudo docker compose -f docker-compose.images.yml exec -T bailinghub npm run demo:e2e
```

路径 B 使用：

```bash
docker compose exec -T bailinghub npm run demo:e2e
```

该命令会真实经过本地 demo 的以下路径：

1. 查询订单并创建售后工单；
2. 高风险退款生成业务侧审批意图；
3. demo 业务系统批准后，中枢只放行已批准的调用；
4. 故障工具返回 5xx，任务仍可在 trace 中追踪。

通过标准：命令退出码为 `0`，末尾出现：

```text
结果：demo e2e passed
```

## 5. 记录结果

请记录以下四个检查点：

| 检查点 | PASS 标准 |
|---|---|
| 服务启动 | `docker compose ps` 中服务正常，`/health` 可访问 |
| 控制台 | 可以登录并看到 demo 配置 |
| 基础体检 | `npm run smoke` 退出码为 0，失败数为 0 |
| 业务闭环 | `npm run demo:e2e` 退出码为 0，并输出 `结果：demo e2e passed` |

无论 PASS、部分通过还是失败，都欢迎使用 [独立验证报告模板](https://github.com/bailinghub/bailinghub/issues/new?template=independent_validation.yml) 反馈。报告建议包含：

- BailingHub 版本、安装路径，以及源码复现时的提交号；
- 操作系统、CPU 架构、Docker 与 Compose 版本；
- 四个检查点的结果；
- 镜像下载之外的实际耗时；
- 第一个阻塞点和脱敏日志；
- 是否只依赖公开文档，哪一步最不清楚。

**不要提交** `BAILING_TOKEN`、Client Token、执行器 Token、管理员凭据、模型 Key、完整 `.env`、个人信息或生产业务数据。

## 可选扩展

核心任务通过后，可以继续验证：

- [生态接入总览与首次成功标准](https://www.bailinghub.com/integrations)；
- [Dify 最小接入配方](integrations/dify/README.md)；
- [n8n 社区节点](https://github.com/bailinghub/bailinghub-n8n-node)；
- [MCP Server](https://github.com/bailinghub/bailinghub-mcp-server)；
- [执行器接入与 OpenClaw 适配](https://github.com/bailinghub/bailinghub-openclaw-skill)。
- [网页聊天真实流式输出与可重连 SSE](RELEASE_NOTES_v0.1.4.md)。
- [一键安装参数可靠性与全新服务器兼容性](RELEASE_NOTES_v0.1.5.md)。
- [独立验证路径与安装后权限提示](RELEASE_NOTES_v0.1.6.md)。
- [版本化 Client API 与跨生态兼容门禁](RELEASE_NOTES_v0.1.7.md)。
- [首次管理员只创建一次与重启安全](RELEASE_NOTES_v0.1.8.md)。

扩展验证请在同一 Issue 模板中选择对应路径，并说明是否获得过维护者的直接帮助。

## 清理本地 demo

确认不再需要本地测试数据后，可在本仓目录执行：

```bash
# 路径 A：沿用安装器打印的 Compose 前缀
sudo docker compose -f docker-compose.images.yml down -v

# 路径 B
docker compose down -v
```

如果路径 A 由 root 用户执行，或当前用户已经拥有 Docker socket 权限，请去掉 `sudo`。只运行与你选择的路径对应的一条清理命令。

该命令会删除本次 demo 创建的容器和本地数据卷。
