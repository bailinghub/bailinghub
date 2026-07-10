// 初始化 mysql 状态库（按文件名顺序执行 sql/*.sql）。用法：npm run db:init
//
// 幂等模型 = 「结构账本」为主 + 「错误码容错」兜底：
//   · bz_schema_migrations 记录每个已成功应用的 sql 文件名；已记账的文件直接跳过，永不二次执行。
//     这让只应执行一次的结构动作也安全——记账后下次同步不会重放、不会 abort。
//   · 错误码容错保留，专为既有部署的「过渡首跑」：升级到带账本的版本时账本是空的，会把历史 sql 再跑一遍，
//     CREATE TABLE IF NOT EXISTS 幂等、ALTER 加列/索引靠错误码（1050/1060/1061）吞掉"已存在"，跑完即记账，
//     此后这些文件永久走账本快路径。
//
// ⚠️ 发布后写新结构文件的纪律见 sql/README.md：只准新增编号文件、只准 CREATE/ADD ... DEFAULT；
//    禁改已发布文件、禁 RENAME/DROP（要删改走"新增 + 过渡窗 + 下个 major 删旧"，见 docs/兼容性与升级.md）。
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../src/core/config/config';

const cfg = loadConfig();
if (cfg.state.backend !== 'mysql') {
  console.error(`当前 backend=${cfg.state.backend}。本脚本仅初始化 mysql 状态库，请先在 config.json 设 state.backend=mysql。`);
  process.exit(1);
}

// 过渡首跑的幂等容错错误码：1050 表已存在 / 1060 列已存在 / 1061 索引已存在
const IDEMPOTENT_ERRNO = new Set([1050, 1060, 1061]);

// 本仓库 sql 文件里无字符串含分号、无存储过程，按 ; 拆语句安全。
function splitStatements(text: string): string[] {
  const noComments = text.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
  return noComments.split(';').map((s) => s.trim()).filter(Boolean);
}

const dir = join(cfg.root, 'sql');
const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();

const mysql = await import('mysql2/promise');
const m = cfg.state.mysql;
const conn = await mysql.createConnection({
  host: m.host, port: m.port, user: m.user, password: m.password, database: m.database,
});
console.log(`已连接 ${m.host}:${m.port}/${m.database}（user=${m.user}）`);

// 账本表自举：必须先于读取已应用集合而存在（不放进 sql/ 编号文件，避免循环依赖）。
await conn.query(
  'CREATE TABLE IF NOT EXISTS `bz_schema_migrations` (' +
    '`filename` VARCHAR(190) NOT NULL PRIMARY KEY,' +
    '`applied_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP' +
  ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT=\'已应用的 sql 结构文件账本\'',
);
const [appliedRows] = await conn.query('SELECT `filename` FROM `bz_schema_migrations`');
const applied = new Set((appliedRows as Array<{ filename: string }>).map((r) => r.filename));

let ran = 0, ledgerSkipped = 0;
for (const f of files) {
  if (applied.has(f)) { ledgerSkipped++; continue; } // 账本快路径：已应用，永不重放
  const stmts = splitStatements(readFileSync(join(dir, f), 'utf8'));
  let appliedStmts = 0, skipped = 0;
  for (const stmt of stmts) {
    try {
      await conn.query(stmt);
      appliedStmts++;
    } catch (e: any) {
      if (IDEMPOTENT_ERRNO.has(e?.errno)) { skipped++; continue; } // 过渡首跑容错
      console.error(`✗ ${f} 执行失败：${e?.message}\n  语句：${stmt.slice(0, 120)}…`);
      throw e;
    }
  }
  await conn.query('INSERT IGNORE INTO `bz_schema_migrations` (`filename`) VALUES (?)', [f]);
  ran++;
  console.log(`✓ ${f}（执行 ${appliedStmts}，过渡容错跳过 ${skipped}）→ 已记账`);
}
console.log(`\n数据库结构同步完成：本次执行 ${ran} 个文件，账本已记录跳过 ${ledgerSkipped} 个。`);

const [rows] = await conn.query('SHOW TABLES');
console.log('当前库内的表：');
console.table(rows);
await conn.end();
