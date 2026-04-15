import fs from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';
import { format } from 'date-fns';

function escapeSqlitePath(filePath: string) {
  return filePath.replace(/'/g, "''");
}

function ensureParentDir(filePath: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

export function createSqliteBackup(input: {
  sourceDbPath: string;
  outputDir: string;
  prefix?: string;
  createdAt?: Date;
}) {
  const createdAt = input.createdAt ?? new Date();
  const timestamp = format(createdAt, 'yyyyMMdd-HHmmss');
  const prefix = input.prefix?.trim() || 'backup';
  const fileName = `${prefix}-${timestamp}.sqlite`;
  const filePath = path.join(input.outputDir, fileName);

  fs.mkdirSync(input.outputDir, { recursive: true });
  if (fs.existsSync(filePath)) {
    fs.rmSync(filePath, { force: true });
  }

  const db = new Database(input.sourceDbPath);
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.exec(`VACUUM INTO '${escapeSqlitePath(filePath)}'`);
  } finally {
    db.close();
  }

  const fileSize = fs.statSync(filePath).size;
  const manifestPath = `${filePath}.json`;
  const manifest = {
    sourceDbPath: path.resolve(input.sourceDbPath),
    fileName,
    filePath: path.resolve(filePath),
    fileSize,
    createdAt: createdAt.toISOString(),
  };
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');

  return {
    fileName,
    filePath: path.resolve(filePath),
    fileSize,
    manifestPath: path.resolve(manifestPath),
    createdAt: createdAt.toISOString(),
  };
}

export function restoreSqliteBackup(input: { backupFilePath: string; targetDbPath: string }) {
  const backupFilePath = path.resolve(input.backupFilePath);
  const targetDbPath = path.resolve(input.targetDbPath);

  if (!fs.existsSync(backupFilePath)) {
    throw new Error(`备份文件不存在：${backupFilePath}`);
  }

  ensureParentDir(targetDbPath);
  fs.copyFileSync(backupFilePath, targetDbPath);

  const verifyDb = new Database(targetDbPath, { readonly: true });
  try {
    const tableCount = verifyDb
      .prepare(`SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`)
      .get() as { count: number };
    const orderCount = verifyDb.prepare('SELECT COUNT(*) AS count FROM orders').get() as { count: number };
    const userCount = verifyDb.prepare('SELECT COUNT(*) AS count FROM users').get() as { count: number };

    return {
      targetDbPath,
      fileSize: fs.statSync(targetDbPath).size,
      tableCount: Number(tableCount.count ?? 0),
      orderCount: Number(orderCount.count ?? 0),
      userCount: Number(userCount.count ?? 0),
    };
  } finally {
    verifyDb.close();
  }
}
