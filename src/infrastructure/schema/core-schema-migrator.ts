import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MysqlConfig } from '../../core/config/config';
import { assertOfficialMigrationFilenames } from './migration-files';
import { BAILINGHUB_RETIRED_CORE_MIGRATIONS_V1 } from './retired-migrations';

const IDEMPOTENT_MYSQL_ERRNOS = new Set([1060, 1061]);
const DEFAULT_LOCK_TIMEOUT_SECONDS = 30;
const BAILINGHUB_CORE_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

const CREATE_LEDGER_SQL =
  'CREATE TABLE IF NOT EXISTS `bz_schema_migrations` (' +
    '`filename` VARCHAR(190) NOT NULL PRIMARY KEY,' +
    '`checksum_sha256` CHAR(64) NULL,' +
    '`applied_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP' +
  ') ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COMMENT=\'已应用的 sql 结构文件账本\'';

const ADD_LEDGER_CHECKSUM_SQL =
  'ALTER TABLE `bz_schema_migrations` ' +
  'ADD COLUMN `checksum_sha256` CHAR(64) NULL AFTER `filename`';

export interface CoreSchemaMigrationConnectionV1 {
  query(sql: string, params?: unknown[]): Promise<[unknown, unknown]>;
  end(): Promise<void>;
}

export type CoreSchemaMigrationConnectionFactoryV1 = (
  mysql: MysqlConfig,
) => Promise<CoreSchemaMigrationConnectionV1>;

export interface CoreSchemaMigrationLoggerV1 {
  log(message: string): void;
  warn(message: string): void;
}

export interface MigrateBailingHubCoreSchemaInputV1 {
  mysql: MysqlConfig;
  /** 测试或受控宿主可注入单连接；传入后连接生命周期仍由调用方负责。 */
  connection?: CoreSchemaMigrationConnectionV1;
  /** 未直接注入连接时可替换连接工厂；生产缺省使用 mysql2/promise。 */
  connectionFactory?: CoreSchemaMigrationConnectionFactoryV1;
  lockName?: string;
  lockTimeoutSeconds?: number;
  logger?: CoreSchemaMigrationLoggerV1;
}

export interface BailingHubCoreSchemaMigrationResultV1 {
  sourceDirectory: string;
  lockName: string;
  totalFiles: number;
  appliedFiles: string[];
  skippedFiles: string[];
  checksumBackfilledFiles: string[];
  executedStatements: number;
  toleratedStatements: number;
}

interface MigrationFile {
  filename: string;
  checksum: string;
  statements: string[];
}

interface LedgerRow {
  filename: string;
  checksum_sha256: string | null;
}

/**
 * 显式同步 BailingHub Core 状态库结构。
 *
 * 该函数不会被 Kernel 启动隐式调用；宿主或运维命令必须在自己的发布阶段主动调用。
 * 业务结构的唯一来源始终是 Core 自带的 sql/*.sql，账本表仅是迁移器自举元数据。
 */
export async function migrateBailingHubCoreSchema(
  input: MigrateBailingHubCoreSchemaInputV1,
): Promise<BailingHubCoreSchemaMigrationResultV1> {
  if (input.connection && input.connectionFactory) {
    throw new Error('connection 与 connectionFactory 只能传入一个');
  }

  const files = loadOfficialMigrationFiles();
  const sourceDirectory = join(BAILINGHUB_CORE_ROOT, 'sql');
  const lockName = resolveLockName(input);
  const lockTimeoutSeconds = resolveLockTimeout(input.lockTimeoutSeconds);
  const ownsConnection = !input.connection;
  const factory = input.connectionFactory ?? defaultConnectionFactory;
  const connection = input.connection ?? await factory(input.mysql);
  let lockAcquired = false;
  let failed = false;

  try {
    const [lockPayload] = await connection.query(
      'SELECT GET_LOCK(?, ?) AS `acquired`',
      [lockName, lockTimeoutSeconds],
    );
    if (numericField(firstRow(lockPayload), 'acquired') !== 1) {
      throw new Error(`无法在 ${lockTimeoutSeconds} 秒内取得 Core Schema 迁移锁`);
    }
    lockAcquired = true;

    await ensureChecksumLedger(connection);
    const ledger = await loadLedger(connection);
    const retiredMigrations = BAILINGHUB_RETIRED_CORE_MIGRATIONS_V1;
    const knownMigrations = [
      ...files.map((file) => ({ filename: file.filename, checksum: file.checksum })),
      ...retiredMigrations.map((file) => ({
        filename: file.filename,
        checksum: file.checksumSha256,
      })),
    ].sort((left, right) => left.filename.localeCompare(right.filename));
    const knownFiles = new Set(knownMigrations.map((file) => file.filename));
    if (knownFiles.size !== knownMigrations.length) {
      throw new Error('Core Schema 活动迁移与退役迁移证据存在重名文件');
    }
    const unknownFiles = [...ledger.keys()].filter((filename) => !knownFiles.has(filename)).sort();
    if (unknownFiles.length > 0) {
      throw new Error(
        `Core Schema 账本包含当前 artifact 不认识的迁移：${unknownFiles.join(', ')}；` +
        '拒绝用较旧或错误的 Core artifact 启动/迁移',
      );
    }

    // 先校验所有已有非空摘要，再做补录或新迁移；发现发布文件漂移时不产生后续写入。
    for (const file of knownMigrations) {
      const recorded = ledger.get(file.filename);
      if (recorded === undefined || recorded === null) continue;
      if (normalizeChecksum(recorded) !== file.checksum) {
        throw new Error(
          `Core Schema 校验失败：${file.filename} 与账本摘要不一致；` +
          '已发布的 sql 文件不可修改，请新增编号迁移文件',
        );
      }
    }

    const checksumBackfilledFiles: string[] = [];
    for (const file of knownMigrations) {
      if (ledger.get(file.filename) !== null) continue;
      await connection.query(
        'UPDATE `bz_schema_migrations` SET `checksum_sha256`=? ' +
        'WHERE `filename`=? AND `checksum_sha256` IS NULL',
        [file.checksum, file.filename],
      );
      const verified = await loadSingleLedgerChecksum(connection, file.filename);
      if (normalizeChecksum(verified) !== file.checksum) {
        throw new Error(`旧迁移账本摘要补录失败：${file.filename}`);
      }
      ledger.set(file.filename, file.checksum);
      checksumBackfilledFiles.push(file.filename);
      input.logger?.log(`↺ ${file.filename}（旧账本摘要已安全补录，不重放 SQL）`);
    }

    const appliedFiles: string[] = [];
    const skippedFiles: string[] = [];
    let executedStatements = 0;
    let toleratedStatements = 0;

    for (const file of files) {
      if (ledger.has(file.filename)) {
        skippedFiles.push(file.filename);
        continue;
      }

      let fileExecuted = 0;
      let fileTolerated = 0;
      for (const statement of file.statements) {
        try {
          await connection.query(statement);
          fileExecuted++;
          executedStatements++;
        } catch (error) {
          if (
            IDEMPOTENT_MYSQL_ERRNOS.has(mysqlErrno(error))
            && await verifyDuplicateObject(connection, statement, mysqlErrno(error))
          ) {
            fileTolerated++;
            toleratedStatements++;
            continue;
          }
          throw migrationStatementError(file.filename, statement, error);
        }
      }

      await connection.query(
        'INSERT INTO `bz_schema_migrations` (`filename`, `checksum_sha256`) VALUES (?, ?)',
        [file.filename, file.checksum],
      );
      ledger.set(file.filename, file.checksum);
      appliedFiles.push(file.filename);
      input.logger?.log(
        `✓ ${file.filename}（执行 ${fileExecuted}，过渡容错跳过 ${fileTolerated}）→ 已记账`,
      );
    }

    return {
      sourceDirectory,
      lockName,
      totalFiles: files.length,
      appliedFiles,
      skippedFiles,
      checksumBackfilledFiles,
      executedStatements,
      toleratedStatements,
    };
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    let cleanupError: unknown;
    if (lockAcquired) {
      try {
        const [releasePayload] = await connection.query(
          'SELECT RELEASE_LOCK(?) AS `released`',
          [lockName],
        );
        if (numericField(firstRow(releasePayload), 'released') !== 1) {
          throw new Error('Core Schema 迁移锁释放结果异常');
        }
      } catch (error) {
        cleanupError = error;
        if (failed) input.logger?.warn(`迁移失败后的锁释放也失败：${errorMessage(error)}`);
      }
    }
    if (ownsConnection) {
      try {
        await connection.end();
      } catch (error) {
        cleanupError ??= error;
        if (failed) input.logger?.warn(`迁移失败后的数据库连接关闭也失败：${errorMessage(error)}`);
      }
    }
    if (!failed && cleanupError !== undefined) throw cleanupError;
  }
}

async function verifyDuplicateObject(
  connection: CoreSchemaMigrationConnectionV1,
  statement: string,
  errno: number,
): Promise<boolean> {
  const table = /\bALTER\s+TABLE\s+`?([a-zA-Z0-9_]+)`?/i.exec(statement)?.[1];
  if (!table) return false;
  if (errno === 1060) return await verifyDuplicateColumns(connection, table, statement);
  if (errno === 1061) return await verifyDuplicateIndexes(connection, table, statement);
  return false;
}

async function verifyDuplicateColumns(
  connection: CoreSchemaMigrationConnectionV1,
  table: string,
  statement: string,
): Promise<boolean> {
  const additions = [...statement.matchAll(
    /\bADD\s+COLUMN\s+`?([a-zA-Z0-9_]+)`?\s+([\s\S]*?)(?=,\s*ADD\s+COLUMN\b|$)/gi,
  )];
  if (additions.length === 0) return false;
  const [payload] = await connection.query(`SHOW FULL COLUMNS FROM \`${table}\``);
  const columns = new Map(rows(payload).map((row) => [String(row['Field'] ?? row['field'] ?? ''), row]));
  return additions.every((addition) => {
    const name = addition[1]!;
    const definition = addition[2]!.trim();
    const actual = columns.get(name);
    if (!actual) return false;
    const expectedType = /^([a-zA-Z]+(?:\s*\([^)]*\))?(?:\s+UNSIGNED)?)/i.exec(definition)?.[1];
    if (!expectedType) return false;
    if (normalizeSqlType(actual['Type'] ?? actual['type']) !== normalizeSqlType(expectedType)) return false;
    const expectedNull = /\bNOT\s+NULL\b/i.test(definition) ? 'NO' : 'YES';
    if (String(actual['Null'] ?? actual['null'] ?? '').toUpperCase() !== expectedNull) return false;
    const defaultMatch = /\bDEFAULT\s+(NULL|'(?:''|[^'])*'|[^\s,]+)/i.exec(definition);
    if (!defaultMatch) return true;
    return normalizeSqlDefault(actual['Default'] ?? actual['default']) === normalizeSqlDefault(defaultMatch[1]);
  });
}

async function verifyDuplicateIndexes(
  connection: CoreSchemaMigrationConnectionV1,
  table: string,
  statement: string,
): Promise<boolean> {
  const additions = [...statement.matchAll(
    /\bADD\s+(UNIQUE\s+)?(?:KEY|INDEX)\s+`?([a-zA-Z0-9_]+)`?\s*\(([^)]+)\)/gi,
  )];
  if (additions.length === 0) return false;
  for (const addition of additions) {
    const unique = Boolean(addition[1]);
    const name = addition[2]!;
    const expectedColumns = addition[3]!.split(',').map((part) => part.replace(/`/g, '').trim().split(/\s+/)[0]!);
    const [payload] = await connection.query(`SHOW INDEX FROM \`${table}\` WHERE Key_name = ?`, [name]);
    const indexRows = rows(payload).sort((a, b) => Number(a['Seq_in_index'] ?? 0) - Number(b['Seq_in_index'] ?? 0));
    if (indexRows.length !== expectedColumns.length) return false;
    if (indexRows.some((row) => Number(row['Non_unique'] ?? 1) !== (unique ? 0 : 1))) return false;
    if (indexRows.some((row, index) => String(row['Column_name'] ?? '') !== expectedColumns[index])) return false;
  }
  return true;
}

function normalizeSqlType(value: unknown): string {
  return String(value ?? '').toLowerCase().replace(/\s+/g, ' ').replace(/\s*\(\s*/g, '(').replace(/\s*\)/g, ')').trim();
}

function normalizeSqlDefault(value: unknown): string {
  if (value === null || value === undefined || String(value).toUpperCase() === 'NULL') return 'null';
  const text = String(value);
  if (text.startsWith("'") && text.endsWith("'")) return text.slice(1, -1).replace(/''/g, "'");
  return text;
}

function loadOfficialMigrationFiles(): MigrationFile[] {
  const directory = join(BAILINGHUB_CORE_ROOT, 'sql');
  let filenames: string[];
  try {
    filenames = readdirSync(directory).filter((name) => name.endsWith('.sql')).sort();
    assertOfficialMigrationFilenames(filenames);
  } catch (error) {
    throw new Error(`无法读取 Core 官方迁移目录：${directory}`, { cause: error });
  }
  if (filenames.length === 0) {
    throw new Error(`Core 官方迁移目录中没有 sql 文件：${directory}`);
  }
  return filenames.map((filename) => {
    const content = readFileSync(join(directory, filename), 'utf8');
    return {
      filename,
      checksum: createHash('sha256').update(content, 'utf8').digest('hex'),
      statements: splitStatements(content),
    };
  });
}

// 官方迁移文件不包含存储过程，也不在字符串中使用分号；维持旧 init-db 的拆分语义。
function splitStatements(text: string): string[] {
  const withoutFullLineComments = text
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');
  return withoutFullLineComments.split(';').map((statement) => statement.trim()).filter(Boolean);
}

async function ensureChecksumLedger(connection: CoreSchemaMigrationConnectionV1): Promise<void> {
  await connection.query(CREATE_LEDGER_SQL);
  try {
    await connection.query(ADD_LEDGER_CHECKSUM_SQL);
  } catch (error) {
    if (!IDEMPOTENT_MYSQL_ERRNOS.has(mysqlErrno(error))) throw error;
  }
}

async function loadLedger(
  connection: CoreSchemaMigrationConnectionV1,
): Promise<Map<string, string | null>> {
  const [payload] = await connection.query(
    'SELECT `filename`, `checksum_sha256` FROM `bz_schema_migrations`',
  );
  const ledger = new Map<string, string | null>();
  for (const raw of rows(payload)) {
    const row = raw as Partial<LedgerRow>;
    const filename = String(row.filename ?? '').trim();
    if (!filename) continue;
    ledger.set(
      filename,
      row.checksum_sha256 === null || row.checksum_sha256 === undefined
        ? null
        : String(row.checksum_sha256),
    );
  }
  return ledger;
}

async function loadSingleLedgerChecksum(
  connection: CoreSchemaMigrationConnectionV1,
  filename: string,
): Promise<string | null | undefined> {
  const [payload] = await connection.query(
    'SELECT `checksum_sha256` FROM `bz_schema_migrations` WHERE `filename`=? LIMIT 1',
    [filename],
  );
  const row = firstRow(payload) as Partial<LedgerRow> | undefined;
  return row?.checksum_sha256;
}

function resolveLockName(input: MigrateBailingHubCoreSchemaInputV1): string {
  const explicit = input.lockName?.trim();
  if (explicit !== undefined) {
    if (!explicit || Buffer.byteLength(explicit, 'utf8') > 64) {
      throw new Error('Core Schema 迁移锁名称必须为 1~64 字节');
    }
    return explicit;
  }
  // GET_LOCK 的命名空间在 MySQL 服务器内；只按库名派生，确保同库经 IP/域名等不同主机别名连接仍竞争同一把锁。
  const identity = input.mysql.database;
  const digest = createHash('sha256').update(identity, 'utf8').digest('hex').slice(0, 40);
  return `bailinghub:core-schema:${digest}`;
}

function resolveLockTimeout(value: number | undefined): number {
  const timeout = value ?? DEFAULT_LOCK_TIMEOUT_SECONDS;
  if (!Number.isInteger(timeout) || timeout < 0 || timeout > 300) {
    throw new Error('lockTimeoutSeconds 必须是 0~300 的整数');
  }
  return timeout;
}

async function defaultConnectionFactory(
  mysqlConfig: MysqlConfig,
): Promise<CoreSchemaMigrationConnectionV1> {
  const mysql = await import('mysql2/promise');
  const raw = await mysql.createConnection({
    host: mysqlConfig.host,
    port: mysqlConfig.port,
    user: mysqlConfig.user,
    password: mysqlConfig.password,
    database: mysqlConfig.database,
  });
  return {
    async query(sql, params = []) {
      const [payload, fields] = await raw.query(sql, params);
      return [payload, fields];
    },
    async end() {
      await raw.end();
    },
  };
}

function rows(payload: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(payload)) return [];
  return payload.filter(
    (row): row is Record<string, unknown> => Boolean(row) && typeof row === 'object',
  );
}

function firstRow(payload: unknown): Record<string, unknown> | undefined {
  return rows(payload)[0];
}

function numericField(row: Record<string, unknown> | undefined, field: string): number {
  return Number(row?.[field]);
}

function normalizeChecksum(value: string | null | undefined): string | null | undefined {
  return value === null || value === undefined ? value : value.trim().toLowerCase();
}

function mysqlErrno(error: unknown): number {
  if (!error || typeof error !== 'object' || !('errno' in error)) return Number.NaN;
  return Number((error as { errno?: unknown }).errno);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function migrationStatementError(filename: string, statement: string, cause: unknown): Error {
  const preview = statement.replace(/\s+/g, ' ').slice(0, 120);
  return new Error(
    `${filename} 执行失败：${errorMessage(cause)}；语句：${preview}${statement.length > 120 ? '…' : ''}`,
    { cause },
  );
}
