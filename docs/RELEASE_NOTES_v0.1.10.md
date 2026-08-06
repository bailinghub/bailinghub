# BailingHub v0.1.10：实例品牌设置与生态接入完善

`v0.1.10` 让自托管部署可以直接在控制台维护实例品牌信息，而不必修改前端源码；同时改善模型标识诊断，并补齐 DeepSeek 与阿里云百炼的可复现接入配方。

## 主要变化

### 实例品牌设置

具有 `admins:manage` 权限的管理员可在控制台“系统设置”中维护：

- 网站名称与浏览器标题；
- 网站描述与关键词；
- 登录页主标题与副标题；
- Logo 与 favicon。

设置保存在中枢自己的 `bz_instance_branding` 表中，升级代码、重启服务或重新构建控制台不会覆盖已保存内容。公开 `GET /branding` 只返回展示所需数据；Logo 与 favicon 通过独立公开资源端点提供，不暴露管理来源或平台元数据。

图片按实际文件头识别类型，不信任浏览器声明的 MIME：

- Logo 支持 PNG、JPEG、WebP，最大 512 KiB；
- favicon 支持 PNG、ICO，最大 128 KiB。

### 为未来平台版保留明确接管边界

控制台与公开展示只依赖稳定的 `InstanceBrandingProvider` 契约。开源版默认使用本地 Provider；未来由外部平台统一管理时，可以替换 Provider，使实例内设置自动转为只读并指向平台管理入口。

升级只允许一次性迁移后由单一来源接管，不采用本地与平台双写，避免两个后台互相覆盖。

### 模型标识诊断

模型验证失败时，如果模型 ID 含空白字符，控制台会提示用户检查是否误填了平台展示名称，并建议从官方文档或 `/models` 复制精确 ID。

腾讯云 TokenHub 已加入平台预设：

```text
base_url: https://tokenhub.tencentmaas.com/v1
model: kimi-k3
```

这是一项诊断和易用性改进，不把“无空格”定义成通用协议限制。确实使用自定义别名的部署仍可填写自己的模型 ID。

### DeepSeek 与阿里云百炼配方

新增并维护：

- DeepSeek V4 文本、流式输出、工具调用和完整中枢 E2E 验证配方；
- 阿里云百炼远程 MCP 接入的中英文配置、验证步骤和检查脚本。

这些配方属于可选生态接入文档，不改变 BailingHub 核心 Client API、执行器协议或 ACC 语义。

## 数据库迁移

新增：

```text
sql/051_instance_branding.sql
```

官方 Docker 入口会自动执行迁移。直接从源码运行、使用自定义启动入口或跳过官方 entrypoint 的部署，升级后必须执行：

```bash
npm run db:init
```

迁移只新增单例品牌设置表，不修改既有任务、审批、审计、工具或账号数据。

## 兼容性边界

- 现有部署升级后默认显示原有 BailingHub 品牌，不要求立即配置；
- 不修改 Client API、执行器协议、工具签名、审批语义或 ACC；
- 新增公开品牌接口只提供展示信息，不参与鉴权或授权；
- 模型 ID 提示不会阻止合法自定义别名；
- 平台接管能力是可替换扩展边界，开源版不包含外部平台的托管逻辑。

## 验证

发布前执行：

```bash
npm run typecheck
npm test
npm run web-admin:check
npm run docs:check
npm run security:scan
npm run release:check
```

升级后建议确认：

1. `npm run db:init` 完成，迁移账本包含 `051_instance_branding.sql`；
2. `/health/ready` 返回就绪；
3. `GET /branding` 返回默认或已保存的实例品牌；
4. 管理员保存品牌设置后，重启服务仍保持原值；
5. 非图片内容、超限图片和不支持的格式会被拒绝；
6. 既有任务、审批、审计与执行器路径继续正常工作。

## 相关文档

- [兼容性与升级](兼容性与升级.md)
- [DeepSeek 接入配方](integrations/deepseek/README.md)
- [阿里云百炼 MCP 配方](integrations/bailian/README.md)
- [发布记录](CHANGELOG.md)
