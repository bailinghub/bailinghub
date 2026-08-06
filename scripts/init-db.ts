// 显式初始化 mysql 状态库。Kernel 启动不会隐式执行结构迁移。
// 迁移语义由公开的 Kernel API v1 统一提供，外部宿主与 CLI 不再各自复制一套实现。
import { loadConfig, migrateBailingHubCoreSchema } from '../src/kernel-api/v1';

const cfg = loadConfig();
if (cfg.state.backend !== 'mysql') {
  console.error(`当前 backend=${cfg.state.backend}。本脚本仅初始化 mysql 状态库，请先在 config.json 设 state.backend=mysql。`);
  process.exit(1);
}

const m = cfg.state.mysql;
console.log(`准备同步 ${m.host}:${m.port}/${m.database}（user=${m.user}）`);
const result = await migrateBailingHubCoreSchema({
  mysql: m,
  logger: console,
});
console.log(
  `\n数据库结构同步完成：本次执行 ${result.appliedFiles.length} 个文件，` +
  `账本已记录跳过 ${result.skippedFiles.length} 个，` +
  `旧账本摘要补录 ${result.checksumBackfilledFiles.length} 个。`,
);
