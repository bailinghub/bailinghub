# BailingHub v0.1.5：一键安装参数可靠性与全新服务器兼容性

`v0.1.5` 是一个安装与分发可靠性补丁。它不改变 BailingHub 的运行时 HTTP 契约、SDK、签名格式或数据库结构。

## 为什么需要这个补丁

此前部分自定义安装示例采用下面的形式：

```bash
BAILING_INSTALL_MODE=source curl -fsSL <installer-url> | sh
```

在 shell 管道中，这个环境变量只属于 `curl` 进程，不会自动传给右侧执行安装器的 `sh`。命令可能看起来执行成功，但安装模式、端口、公开地址或镜像覆盖等自定义意图会被静默忽略。

正确形式是把变量绑定到安装器进程：

```bash
curl -fsSL https://www.bailinghub.com/install.sh | env BAILING_INSTALL_MODE=source sh
```

## 本次变化

- 修正 README、Quick Start、Demo 和安装器错误提示中的全部自定义参数示例；
- 安装器会先检测 apt 软件源提供的是 `docker-compose-plugin` 还是 `docker-compose-v2`，再安装可用包；
- 公网地址探测失败时不再展示私网地址，并明确说明远程访问时如何替换 `localhost`；
- GitHub 发布演练新增命令形态检查，防止错误的环境变量绑定方式重新进入公开版本。

## 兼容性与升级

- 默认命令仍然是：

  ```bash
  curl -fsSL https://www.bailinghub.com/install.sh | sh
  ```

- 只有需要自定义安装模式、端口、公开地址、镜像或源码来源时，才需要使用 `curl ... | env ... sh`；
- 已运行的 `v0.1.4` 实例不需要数据库迁移；
- 此补丁主要影响新安装和重新安装路径，不改变现有业务接入行为。

## 验证

发布前完成：

- `sh -n scripts/install.sh`；
- `npm run docs:check`；
- `npm run release:check`；
- 全新 Ubuntu 24.04 服务器默认镜像安装；
- 自定义安装模式、端口和公开地址的独立安装；
- 10 项 smoke、完整 demo E2E、重启与配置持久性验证。
