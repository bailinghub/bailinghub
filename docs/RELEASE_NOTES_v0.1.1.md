# v0.1.1 发布说明

百灵中枢 `v0.1.1` 是首个公开版本后的兼容性更新，重点补齐聊天组件的运营控制，并收紧 OpenAPI 工具编译边界。现有 `/run`、工具签名、审批、SDK 和数据库结构不需要迁移。

## 主要变化

- **聊天入口可随时暂停与恢复**：控制台可直接切换入口状态。入口停用后，业务页面无需删除嵌入脚本，悬浮按钮和聊天窗口会静默隐藏；消息、历史、上传和评价端点仍在服务端拒绝访问。
- **组件品牌标识可配置**：每个聊天入口都可以显示、隐藏或自定义底部品牌文案。旧入口默认继续显示当前中枢品牌，不改变既有页面效果。
- **公开配置具有明确状态**：聊天配置接口对已停用入口返回 `{ "enabled": false }`，组件在配置不可达或状态未知时按 fail-closed 原则不展示。
- **OpenAPI 编译边界更严格**：仅接受 `query`、`path`、`header` 参数位置；`cookie`、未知或缺失位置会产生稳定诊断并跳过对应 operation。带引号的字符串 `timeout_ms` 会给出明确类型提示，不再被含糊处理。
- **分发与社区入口完善**：应用镜像同时发布到阿里云 ACR 和 GHCR；GitHub 主线与发布标签自动镜像到 Gitee；README 图片兼容 GitHub/Gitee；新增社区衍生与生态合作原则。

## 对接影响

- 现有聊天入口默认保持启用，`powered_by_visible` 默认保持 `true`，无需修改原有配置。
- 自定义品牌文案存放在聊天入口现有的 `appearance` JSON 中，不新增数据库迁移。
- 使用不受支持 OpenAPI 参数位置的工具源需要调整为受支持位置，或通过业务侧适配层转换请求。
- 其余公开 HTTP 契约、ACC 字段、SDK 调用方式和签名格式保持不变。

## 升级与验证

源码部署更新到 `v0.1.1` 后执行：

```bash
npm install
npm run typecheck
npm test
npm --prefix web-admin run build
```

镜像部署使用：

```text
crpi-xm97pbcjrmf5in3s.cn-shanghai.personal.cr.aliyuncs.com/bailinghub/bailinghub:0.1.1
ghcr.io/bailinghub/bailinghub:0.1.1
```

完整变更记录见 [CHANGELOG.md](CHANGELOG.md)，部署与回滚纪律见 [兼容性与升级.md](兼容性与升级.md)。
