import fs from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';

import { appConfig } from './config.js';

export const CURRENT_SCHEMA_VERSION = 2026031201;

const REQUIRED_TABLES = [
  'users',
  'orders',
  'products',
  'audit_logs',
  'secure_settings',
  'after_sale_cases',
  'system_alerts',
  'system_backup_runs',
  'system_log_archives',
  'system_recovery_drills',
  'workspace_modules',
] as const;

const REQUIRED_COLUMNS: Record<string, string[]> = {
  orders: ['main_status', 'payment_status', 'delivery_status'],
  order_items: ['delivery_status'],
  order_payments: ['payment_status'],
  fund_bills: ['store_id'],
  managed_stores: ['health_status', 'last_health_check_at', 'last_health_check_detail'],
  system_alerts: ['alert_key', 'status', 'severity'],
  system_backup_runs: ['backup_no', 'run_status', 'file_path'],
};

function resolveDbPath(inputPath: string | undefined) {
  return path.resolve(inputPath?.trim() || appConfig.dbPath);
}

function safeCount(db: Database.Database, tableName: string) {
  try {
    const row = db.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get() as { count: number };
    return Number(row.count ?? 0);
  } catch {
    return null;
  }
}

function listColumns(db: Database.Database, tableName: string) {
  try {
    const rows = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{ name: string }>;
    return rows.map((row) => row.name);
  } catch {
    return [];
  }
}

function getBackupDirectory(dbPath: string) {
  if (path.resolve(dbPath) === path.resolve(appConfig.dbPath)) {
    return path.resolve(appConfig.backupDir);
  }
  return path.resolve(path.join(path.dirname(dbPath), 'backups'));
}

export function inspectSqliteDatabase(input: { dbPath?: string } = {}) {
  const dbPath = resolveDbPath(input.dbPath);
  const exists = fs.existsSync(dbPath);
  const backupDir = getBackupDirectory(dbPath);
  const baseResult = {
    dbPath,
    exists,
    fileSize: exists ? fs.statSync(dbPath).size : 0,
    backupDir,
  };

  if (!exists) {
    return {
      ...baseResult,
      userVersion: 0,
      journalMode: 'unknown',
      integrityCheck: 'missing',
      tableCount: 0,
      tables: [] as Array<{ name: string; rowCount: number | null; columns: string[] }>,
      counts: {
        users: 0,
        stores: 0,
        products: 0,
        orders: 0,
        auditLogs: 0,
      },
      latestBackup: null as string | null,
    };
  }

  const db = new Database(dbPath, { readonly: true });
  try {
    const userVersionRow = db.pragma('user_version', { simple: true }) as number;
    const journalMode = String(db.pragma('journal_mode', { simple: true }) || 'unknown');
    const integrityRow = db.prepare('PRAGMA integrity_check').get() as { integrity_check?: string };
    const tableNames = (
      db
        .prepare(
          `
            SELECT name
            FROM sqlite_master
            WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
            ORDER BY name
          `,
        )
        .all() as Array<{ name: string }>
    ).map((row) => row.name);

    const tables = tableNames.map((tableName) => ({
      name: tableName,
      rowCount: safeCount(db, tableName),
      columns: listColumns(db, tableName),
    }));

    const backupFiles = fs.existsSync(backupDir)
      ? fs
          .readdirSync(backupDir, { withFileTypes: true })
          .filter((entry) => entry.isFile() && entry.name.endsWith('.sqlite'))
          .map((entry) => entry.name)
          .sort()
      : [];

    return {
      ...baseResult,
      userVersion: Number(userVersionRow ?? 0),
      journalMode,
      integrityCheck: integrityRow.integrity_check ?? 'unknown',
      tableCount: tables.length,
      tables,
      counts: {
        users: safeCount(db, 'users') ?? 0,
        stores: safeCount(db, 'managed_stores') ?? 0,
        products: safeCount(db, 'products') ?? 0,
        orders: safeCount(db, 'orders') ?? 0,
        auditLogs: safeCount(db, 'audit_logs') ?? 0,
      },
      latestBackup: backupFiles.at(-1) ?? null,
    };
  } finally {
    db.close();
  }
}

export function runSqliteDoctor(input: { dbPath?: string; strict?: boolean } = {}) {
  const inspection = inspectSqliteDatabase(input);
  const checks: Array<{ name: string; status: 'pass' | 'warn' | 'fail'; detail: string }> = [];

  if (!inspection.exists) {
    checks.push({
      name: 'database_file',
      status: 'fail',
      detail: `数据库文件不存在：${inspection.dbPath}`,
    });
  } else {
    checks.push({
      name: 'database_file',
      status: 'pass',
      detail: `数据库文件存在，大小 ${inspection.fileSize} 字节。`,
    });
  }

  if (inspection.exists) {
    checks.push({
      name: 'integrity_check',
      status: inspection.integrityCheck === 'ok' ? 'pass' : 'fail',
      detail:
        inspection.integrityCheck === 'ok'
          ? 'SQLite 完整性检查通过。'
          : `SQLite 完整性检查失败：${inspection.integrityCheck}`,
    });

    checks.push({
      name: 'journal_mode',
      status: inspection.journalMode === 'wal' ? 'pass' : 'warn',
      detail: `当前 journal_mode 为 ${inspection.journalMode}。`,
    });

    checks.push({
      name: 'schema_version',
      status:
        inspection.userVersion >= CURRENT_SCHEMA_VERSION
          ? 'pass'
          : inspection.userVersion === 0
            ? 'warn'
            : 'fail',
      detail: `当前 schema 版本 ${inspection.userVersion}，期望不低于 ${CURRENT_SCHEMA_VERSION}。`,
    });

    const tableSet = new Set(inspection.tables.map((table) => table.name));
    const missingTables = REQUIRED_TABLES.filter((table) => !tableSet.has(table));
    checks.push({
      name: 'required_tables',
      status: missingTables.length === 0 ? 'pass' : 'fail',
      detail:
        missingTables.length === 0 ? '核心表完整。' : `缺少核心表：${missingTables.join('、')}`,
    });

    const columnIssues: string[] = [];
    Object.entries(REQUIRED_COLUMNS).forEach(([tableName, columns]) => {
      const table = inspection.tables.find((item) => item.name === tableName);
      if (!table) {
        columnIssues.push(`${tableName}.*`);
        return;
      }

      const columnSet = new Set(table.columns);
      columns.forEach((column) => {
        if (!columnSet.has(column)) {
          columnIssues.push(`${tableName}.${column}`);
        }
      });
    });

    checks.push({
      name: 'required_columns',
      status: columnIssues.length === 0 ? 'pass' : 'fail',
      detail:
        columnIssues.length === 0 ? '关键列完整。' : `缺少关键列：${columnIssues.join('、')}`,
    });
  }

  const backupDirExists = fs.existsSync(inspection.backupDir);
  checks.push({
    name: 'backup_directory',
    status: backupDirExists ? 'pass' : 'warn',
    detail: backupDirExists
      ? `备份目录可用：${inspection.backupDir}`
      : `备份目录不存在：${inspection.backupDir}`,
  });

  checks.push({
    name: 'latest_backup',
    status: inspection.latestBackup ? 'pass' : 'warn',
    detail: inspection.latestBackup
      ? `最近备份文件：${inspection.latestBackup}`
      : '尚未发现备份文件，建议先执行一次备份。',
  });

  const hasFailure = checks.some((check) => check.status === 'fail');
  const hasWarning = checks.some((check) => check.status === 'warn');
  const strictFailed = Boolean(input.strict && hasWarning);

  return {
    ok: !hasFailure && !strictFailed,
    status: hasFailure ? 'fail' : strictFailed ? 'fail' : hasWarning ? 'warn' : 'pass',
    expectedSchemaVersion: CURRENT_SCHEMA_VERSION,
    inspection,
    checks,
  };
}
