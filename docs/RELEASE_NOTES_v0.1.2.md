# v0.1.2 发布说明

百灵中枢 `v0.1.2` 是一个安全加固补丁，修复服务端根 token 存在公开默认值和派生凭证固定 fallback 的问题。该版本不新增数据库迁移，也不改变公开 HTTP、SDK 或签名格式。

## 主要变化

- 任务级 `tool_token` 不再使用字面量 `bailing` 作为 HMAC fallback；未配置根 token 时拒绝签发。
- 任务回调和告警 webhook 签名不再使用固定 fallback；缺少密钥时 fail-closed。
- `development + 127.0.0.1/localhost/::1` 继续支持无 token 本地开发；生产模式或非回环监听必须配置强随机 `BAILING_TOKEN`。
- 生产或非回环部署会拒绝短于 24 字符的 token，以及仓库曾出现过的公开示例/占位值。
- `docker-compose.yml` 与 `docker-compose.images.yml` 不再内置可预测管理 token。
- 后台无 token 开发管理员回退同步限制为本机回环模式；安全扫描新增对应防回归规则。

## 升级前检查

生产、服务器或局域网部署必须先设置强随机 token：

```bash
export BAILING_TOKEN="$(openssl rand -hex 32)"
```

请把同一值保存到部署环境的 `.env`、容器编排密钥或密钥管理器；不要每次重启生成新值。使用官网一键安装脚本的部署已经由脚本自动生成并保存随机 token，无需手动修改，除非需要轮换。

## 兼容性

- 数据库迁移：无。
- 公开 HTTP/SDK 契约：无变化。
- HMAC 格式：无变化。
- 本机回环开发：保持零配置兼容。
- 生产或非回环部署：必须提供符合新安全基线的 `BAILING_TOKEN`。

## 验证

```bash
npm run typecheck
npm test
npm run security:scan
npm run release:check
```
