# DOCX 解析依赖与来源校验

[English](DOCX_DEPENDENCY.en.md)

Core 文件上下文使用 `extractRawText`，自带控制台知识库导入使用 `convertToHtml` 后转 Markdown。这两个既有入口继续使用 Mammoth 1.12.0 的原始解析代码；从 Core v0.9.4 起改用下述库分发。

## 库分发边界

`vendor/mammoth-library` 是有明确修改标记的库分发，包名为 `@bailinghub/mammoth-library`，版本为 `1.12.0-bailinghub.1`。它保留上游 `lib` / `browser` 的解析源码、类型和 BSD-2-Clause 许可证，移除 CLI 入口、CLI 输出处理文件和 `argparse` 依赖；不提供 Mammoth 命令行工具。上游原始 manifest 仅作来源记录，不参与依赖安装。

Core 与控制台通过同一个仓内 `.tgz` 安装，运行依赖分别进入各自锁文件。Core 的 npm 制品同时捆绑该库及其运行依赖，独立 npm 消费者不依赖根项目的 `overrides` 或开发目录。源码导出保留仓内归档与锁文件，不携带 `node_modules`；Docker 在执行 `npm ci` 前复制 `vendor`。

这移除了 [GHSA-hp3w-g68c-fv3c](https://github.com/advisories/GHSA-hp3w-g68c-fv3c) 所在的 `argparse → sprintf-js` CLI 依赖链。原限时例外已经退役，没有延期或替换为新的漏洞豁免。此变更不代表上游 `sprintf-js` 已修复，也不保证任意 DOCX 或未来依赖均安全。

## 可复现与审计

安装归档有固定完整性值；不同平台的 npm/gzip 可能生成字节不同、内容相同的压缩包。验证以完整解包清单及逐文件内容为准，不要求重新压缩后的字节跨平台相同。

- [SOURCE.json](../vendor/mammoth-library/SOURCE.json) 固定官方 tarball、SHA-512 完整性和逐文件 SHA-256；[许可证](../vendor/mammoth-library/LICENSE) 完整保留。
- `npm run docx:vendor:check` 检查源码清单、修改范围、依赖声明和捆绑设置，并解包核对完整清单及逐文件内容，确认安装归档与已审源码一致。
- `npm run docx:vendor:verify-upstream` 从固定官方 tarball 重验保留源码和实际归档内容。该检查与解析回归纳入 CI / `release:check`。
- `npm run audit:deps` 要求 Core 和控制台原始 npm 审计均为零发现；新增发现、无效响应、计数不符或重新引入 CLI 链都会阻断。定制包名不会自动继承上游安全公告，因此门禁另以原名 `mammoth@1.12.0` 查询官方 npm 直接公告，任意发现或查询失败均阻断。普通运行依赖仍由两棵锁树正常审计。
- `npm run docx:test` 验证 Core 实际入口、中文、段落和空白、标题/列表/表格/链接/图片，以及空文档和损坏包。原始文本沿用上游语义：段落用双换行分隔，Word 软换行不额外输出字符。
- 先构建控制台，再执行 `npm run docx:browser:test`，验证实际浏览器 bundle 和既有图片占位行为；`npm run package:artifact:check` 验证真实 npm 消费者的两个库 API、依赖链和零原始审计。

维护者更新上游版本时，先修改来源固定值与定制版本，复核变化，再重建归档与两棵锁树，更新第三方清单并完整运行上述门禁。`node scripts/vendor-mammoth.mjs --refresh` 仅重建当前固定来源，不自动追踪 latest；已安装实例只有升级到含此改动的 BailingHub 制品后才会获得修复；发行不自动升级具体环境。
