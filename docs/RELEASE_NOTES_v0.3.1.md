# BailingHub v0.3.1：PDF 解析安全更新

`v0.3.1` 是基于 `v0.3.0` 的安全补丁版本。它升级服务端用于提取上传 PDF 文本的 `pdfjs-dist`，修复 [GHSA-hq66-cqwq-w95j](https://github.com/advisories/GHSA-hq66-cqwq-w95j) 所述的任意 JavaScript 执行风险，并适配 PDF.js 6 的资源释放接口。

## 谁需要升级

所有运行 `v0.3.0`、且允许用户或业务流程上传 PDF 的部署都应尽快升级。即使当前没有主动使用 PDF 上传，也建议统一升级，避免未来启用文件解析时继续携带已知风险版本。

## 主要变化

- `pdfjs-dist` 从 `5.7.284` 升级到 `6.2.108`。
- PDF 解析完成或失败后统一销毁 `PDFDocumentLoadingTask`，适配 PDF.js 6 并确保资源释放。
- 依赖审计恢复为 0 漏洞，第三方依赖清单同步到实际锁定版本。

## 兼容性与边界

- 没有新增数据库迁移或配置项。
- Client API、Kernel Host API v1、聊天协议、Executor Protocol、ACC、工具签名、审批语义和业务系统最终授权均未改变。
- 普通文本、Word 文档与其他既有文件处理路径不变。
- Node.js 运行要求没有因本补丁提高；依赖仍要求 Node.js `22.13.0` 或更高的受支持版本。

## 升级

Docker 部署应拉取 `0.3.1` 镜像并按既有流程重启。通过 npm 组合 Core 的宿主应精确更新版本和锁文件：

```bash
npm install --save-exact bailinghub@0.3.1
```

## 验证

```bash
npm audit --audit-level=low
npm run release:check
```

重点覆盖真实 PDF 文本抽取、失败路径资源释放、类型检查、依赖审计、OSS 边界、npm 制品和镜像版本一致性。

## 相关文档

- [v0.3.0 可组合 Core 与 Kernel Host API v1](RELEASE_NOTES_v0.3.0.md)
- [兼容性与升级](兼容性与升级.md)
- [安全策略](../SECURITY.md)
- [English release notes](RELEASE_NOTES_v0.3.1.en.md)
