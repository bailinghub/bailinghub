# Docker Demo：20 分钟跑通 Agent 调业务工具闭环

这个 demo 面向第一次拿到项目的开发者：不需要真实大模型 key，也不需要已有业务系统。

它会启动三件东西：

- `bailinghub`：中枢服务与控制台；
- `mysql`：中枢状态库；
- `demo-business`：一个极小业务系统，暴露订单、工单、退款审批、故障排障四类 Agent 工具。

## 启动

推荐先用透明的 Docker Compose 方式启动，便于你看清楚每个容器和配置项：

```bash
export BAILING_TOKEN="${BAILING_TOKEN:-$(openssl rand -hex 32)}"
docker compose up --build
```

后续 Compose 命令请沿用同一个 `BAILING_TOKEN`，或把它保存到本机 `.env`。一键安装脚本会自动生成随机值。

如果是在一台全新的 Ubuntu/Debian 服务器上快速体验，也可以使用一键安装脚本。脚本会安装 Docker、下载官网提供的开源分发包、生成 `.env`、启动 demo，并打印后台账号密码：

```bash
curl -fsSL https://www.bailinghub.com/install.sh | sh
```

一键安装默认使用官方预构建镜像，减少首次构建和依赖安装耗时。镜像拉取受网络影响时，可以显式切到源码构建：

```bash
BAILING_INSTALL_MODE=source curl -fsSL https://www.bailinghub.com/install.sh | sh
```

镜像模式会使用：

```text
crpi-xm97pbcjrmf5in3s.cn-shanghai.personal.cr.aliyuncs.com/bailinghub/bailinghub:<version>
crpi-xm97pbcjrmf5in3s.cn-shanghai.personal.cr.aliyuncs.com/bailinghub/bailing-demo-business:<version>
```

如果你使用自己的镜像仓库：

```bash
BAILING_INSTALL_MODE=image \
BAILINGHUB_IMAGE=<registry>/<namespace>/bailinghub:<tag> \
BAILING_DEMO_BUSINESS_IMAGE=<registry>/<namespace>/bailing-demo-business:<tag> \
curl -fsSL https://www.bailinghub.com/install.sh | sh
```

如果已经发布到 GitHub，或你想从自己的 fork 安装，可以显式指定仓库地址、分支或安装目录：

```bash
curl -fsSL https://www.bailinghub.com/install.sh | \
  BAILING_REPO=https://github.com/bailinghub/bailinghub.git \
  BAILING_REF=main \
  BAILING_INSTALL_DIR=$HOME/bailinghub \
  sh
```

启动后访问：

- 中枢健康检查：http://localhost:18900/health
- 控制台：http://localhost:18900/console/
- demo 业务系统：http://localhost:19080/
- demo 业务工具源：http://localhost:19080/.well-known/bailing/tools.json

默认控制台账号：

- 用户名：`admin`
- 密码：`bailing-demo-admin`

如果使用一键安装脚本，密码会写入安装目录下的 `.env`，同时在安装完成时打印；脚本不会覆盖已有 `.env`。

默认 demo 接入方：

- `app_id`：`demo-app`
- token：`bailing-demo-client-token`
- 可调用路由：`demo_support`

## 触发一条任务

```bash
curl -sS http://localhost:18900/run \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer bailing-demo-client-token' \
  -d '{
    "request_id": "demo-001",
    "route": "demo_support",
    "source": "quickstart",
    "input": "帮我查一下订单 SO-1001 的状态，并创建一个售后工单说明需要人工跟进",
    "metadata": {
      "visitor_uid": "visitor-001",
      "operator_uid": "demo-user-001"
    }
  }'
```

返回里会有 `job_id`。稍等一两秒后查看结果：

```bash
curl -sS "http://localhost:18900/jobs/<job_id>?token=bailing-demo-client-token"
```

你会看到：

- 中枢通过 `demo_support` 路由派发任务；
- `demo-agent` 调用 `list_demo_orders` 查询订单；
- 用户要求工单时，继续调用 `create_demo_ticket`；
- demo 业务系统验证 `sha256=` 签名与 `X-Bailing-On-Behalf-Of`；
- 任务审计里留下 `tool_call` / `tool_result`。

也可以打开 http://localhost:19080/ 查看 demo 业务系统里的订单、工单、退款申请和业务侧审批意图。

## 为什么不用真实 LLM

开源第一体验不应该卡在模型 key、模型兼容性或网络额度上。`demo-agent` 是一个确定性的 inhub target：它不调用外部 LLM，但完整消费中枢的工具运行时，所以白名单、主体、签名、限流、审计、审批车道这些治理路径都是真实路径。

生产接入时，把路由 target 从 `demo-agent` 换成 `llm`，配置模型凭证即可。

## demo 工具

`demo-business` 暴露的 OpenAPI 工具：

- `list_demo_orders`：只读，`scope=demo.order.read`，需要主体；
- `create_demo_ticket`：中风险写操作，`scope=demo.ticket.create`，需要主体；
- `request_demo_refund`：高风险写操作，`scope=demo.refund.request`，需要审批。
- `demo_failure_probe`：故障排障示例，固定返回业务侧 5xx，用来观察 trace 如何记录失败。

中枢 seed 的路由工具配置：

```json
{
  "sources": [{
    "provider": "demo-business",
    "allow": ["demo.order.*", "demo.ticket.*", "demo.refund.*", "demo.failure.*"],
    "subject_field": "operator_uid"
  }],
  "max_calls": 5,
  "approval": {
    "type": "business_webhook",
    "url": "http://demo-business:19080/approvals"
  }
}
```

这就是业务系统接入中枢的最小形态：业务提供工具声明和验签授权，中枢负责工具治理和调用出口；需要人工判断的高风险动作，以审批意图 webhook 回到业务系统，由业务侧自己的审批人和界面处理。

## 高风险审批演示

发起退款诉求：

```bash
curl -sS http://localhost:18900/run \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer bailing-demo-client-token' \
  -d '{
    "request_id": "demo-refund-001",
    "route": "demo_support",
    "source": "quickstart",
    "input": "帮 SO-1001 申请退款 199 元",
    "metadata": {
      "visitor_uid": "visitor-001",
      "operator_uid": "demo-user-001"
    }
  }'
```

中枢会创建工具审批单，并把审批意图签名推送到 `demo-business /approvals`。打开 http://localhost:19080/ 可以看到业务侧收到的审批意图，直接点击“批准”或“拒绝”即可由 demo 业务系统回调中枢 `/approvals/{approval_id}/decision`。

## 故障排障演示

发起故障诉求：

```bash
curl -sS http://localhost:18900/run \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer bailing-demo-client-token' \
  -d '{
    "request_id": "demo-failure-001",
    "route": "demo_support",
    "source": "quickstart",
    "input": "演示一次业务工具失败排障",
    "metadata": {
      "visitor_uid": "visitor-001",
      "operator_uid": "demo-user-001"
    }
  }'
```

`demo_failure_probe` 会固定返回 500。控制台「任务」里可以查看该 job 的 trace，确认请求、响应、错误正文和排障包脱敏结果。

## Docker 拉取排障

如果新服务器执行源码构建时卡在 `node:22-bookworm-slim` 拉取，优先判断为 Docker Hub 网络问题，不是项目初始化失败。

一键安装默认使用 `BAILING_INSTALL_MODE=image`：中枢主服务、demo 业务系统和 MySQL 都会从官方镜像仓库拉取，不再依赖 Docker Hub。

方式一：给 Docker 配置当前环境可用的 registry mirror，然后重试：

```bash
sudo mkdir -p /etc/docker
sudo tee /etc/docker/daemon.json >/dev/null <<'JSON'
{
  "registry-mirrors": [
    "https://mirror.ccs.tencentyun.com"
  ]
}
JSON
sudo systemctl restart docker
docker compose up -d --build
```

镜像源是否可用取决于服务器网络和云厂商环境；如果该地址不可用，请替换为所在环境可访问的镜像源。

如需源码构建，可显式指定可访问的 Node 基础镜像：

```bash
BAILING_INSTALL_MODE=source \
BAILING_NODE_IMAGE=<registry>/library/node:22-bookworm-slim \
curl -fsSL https://www.bailinghub.com/install.sh | sh
```

如企业环境需要使用内部 MySQL 镜像源，可额外设置 `BAILING_MYSQL_IMAGE=<registry>/library/mysql:8.4` 覆盖。

## 发布官方镜像

维护者可用以下命令构建官方镜像：

```bash
npm run images:build
```

推送前先登录阿里云镜像仓库：

```bash
docker login --username=<aliyun-account> crpi-xm97pbcjrmf5in3s.cn-shanghai.personal.cr.aliyuncs.com
npm run images:publish
```

默认会发布：

```text
crpi-xm97pbcjrmf5in3s.cn-shanghai.personal.cr.aliyuncs.com/bailinghub/bailinghub:<package version>
crpi-xm97pbcjrmf5in3s.cn-shanghai.personal.cr.aliyuncs.com/bailinghub/bailinghub:latest
crpi-xm97pbcjrmf5in3s.cn-shanghai.personal.cr.aliyuncs.com/bailinghub/bailing-demo-business:<package version>
crpi-xm97pbcjrmf5in3s.cn-shanghai.personal.cr.aliyuncs.com/bailinghub/bailing-demo-business:latest
```

MySQL 基础镜像单独同步，默认只发布版本化标签：

```bash
npm run images:publish-mysql
```

默认发布：

```text
crpi-xm97pbcjrmf5in3s.cn-shanghai.personal.cr.aliyuncs.com/bailinghub/bailing-mysql:8.4
```

可用 `BAILING_IMAGE_REGISTRY`、`BAILING_IMAGE_NAMESPACE`、`BAILING_IMAGE_TAG` 覆盖 registry、namespace 和 tag。

## 一键验证闭环

进入中枢容器运行：

```bash
docker compose exec bailinghub npm run smoke
```

demo 环境会自动使用 `demo-app` 和 `demo_support`，检查：

- `/health`、控制台入口和公开 schema；
- 后台版本、系统体检、`route=auto` 预演；
- `/run` 创建 demo 任务并等待终态；
- 按 `request_id` 追溯 `debug_bundle`；
- 确认导出的排障包默认声明并执行脱敏。

控制台也可以在「系统体检」点击「运行 smoke」，结果会以检查项面板展示；如果 smoke 创建了任务，可直接跳到「任务 → 追溯」查看该任务的时间线和脱敏排障包。

## 真实 demo 端到端自测

完整验证 demo 业务闭环：

```bash
docker compose exec bailinghub npm run demo:e2e
```

它会依次验证：

- 查单 + 建工单；
- 高风险退款工具生成业务侧审批意图；
- demo 业务系统回调中枢批准；
- 审批批准后在业务系统生成退款申请；
- 故障工具返回 5xx 后任务仍可追踪。
