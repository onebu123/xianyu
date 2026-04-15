import path from 'node:path';

import { restoreSqliteBackup } from './backup-utils.js';
import { appConfig, ensureRuntimeDirectories } from './config.js';

function readArg(flag: string) {
  const index = process.argv.indexOf(flag);
  if (index < 0) {
    return undefined;
  }
  return process.argv[index + 1];
}

try {
  ensureRuntimeDirectories();

  const backupFilePath = readArg('--backup');
  if (!backupFilePath) {
    throw new Error('请通过 --backup 指定备份文件路径');
  }

  const defaultTarget = path.join(
    appConfig.backupDir,
    'restore-preview',
    `restored-${Date.now()}.db`,
  );
  const targetDbPath = readArg('--target') ?? defaultTarget;

  const result = restoreSqliteBackup({
    backupFilePath,
    targetDbPath,
  });

  console.log(
    JSON.stringify(
      {
        ok: true,
        ...result,
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(
    JSON.stringify(
      {
        ok: false,
        message: error instanceof Error ? error.message : '数据库恢复失败',
      },
      null,
      2,
    ),
  );
  process.exitCode = 1;
}
