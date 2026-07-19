# 独立验证任务卡

这张任务卡用于回答一个具体问题：**一位此前不了解 BailingHub 的开发者，能否仅凭公开资料，在非生产环境独立部署并验证一次受治理的业务操作闭环？**

它不是认证、性能测试或生产采用证明。跑通本任务只说明公开安装路径和 demo 治理链路可以被独立复现；不代表验证者已把 BailingHub 接入真实业务。

## 验证范围

- 验证对象：BailingHub 开源版 Docker demo；
- 稳定基线：`v0.1.3`；
- 数据范围：仓库自带的 demo 订单、工单、退款和故障工具；
- 预计用时：镜像和依赖下载完成后约 20 分钟；
- 不需要：真实大模型 Key、生产 API、生产凭据或真实业务数据。

可选的 Dify 和执行器验证不属于本任务的通过条件。请先完成核心 Docker demo，再按需继续扩展验证。

## 前置条件

- macOS 或 Linux；
- Git、`curl` 和 OpenSSL；
- Docker Engine 或 Docker Desktop；
- Docker Compose v2（`docker compose`）。

## 1. 获取稳定版本

```bash
git clone --depth 1 --branch v0.1.3 https://github.com/bailinghub/bailinghub.git
cd bailinghub
git rev-parse HEAD
```

请保留最后一条命令输出的提交号，反馈时填写。

## 2. 启动本地 demo

```bash
export BAILING_TOKEN="$(openssl rand -hex 32)"
docker compose up -d --build
docker compose ps
```

请在后续命令中沿用同一终端和同一个 `BAILING_TOKEN`。所有写操作只会作用于本地 demo 数据。

等待容器就绪后检查：

```bash
curl -fsS http://localhost:18900/health
```

控制台地址为 <http://localhost:18900/console/>，默认账号为 `admin / bailing-demo-admin`。

## 3. 运行基础体检

```bash
docker compose exec bailinghub npm run smoke
```

通过标准：命令退出码为 `0`，最终汇总中的失败数为 `0`。

## 4. 运行完整业务闭环

```bash
docker compose exec bailinghub npm run demo:e2e
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

- BailingHub 版本和提交号；
- 操作系统、CPU 架构、Docker 与 Compose 版本；
- 四个检查点的结果；
- 镜像下载之外的实际耗时；
- 第一个阻塞点和脱敏日志；
- 是否只依赖公开文档，哪一步最不清楚。

**不要提交** `BAILING_TOKEN`、Client Token、执行器 Token、管理员凭据、模型 Key、完整 `.env`、个人信息或生产业务数据。

## 可选扩展

核心任务通过后，可以继续验证：

- [Dify 最小接入配方](integrations/dify/README.md)；
- [执行器接入与 OpenClaw 适配](RELEASE_NOTES_v0.1.3.md)。

扩展验证请在同一 Issue 模板中选择对应路径，并说明是否获得过维护者的直接帮助。

## 清理本地 demo

确认不再需要本地测试数据后，可在本仓目录执行：

```bash
docker compose down -v
```

该命令会删除本次 demo 创建的容器和本地数据卷。
