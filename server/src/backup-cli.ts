import { createSqliteBackup } from './backup-utils.js';
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

  const outputDir = readArg('--output-dir') ?? appConfig.backupDir;
  const prefix = readArg('--prefix') ?? 'manual';
  const result = createSqliteBackup({
    sourceDbPath: appConfig.dbPath,
    outputDir,
    prefix,
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
        message: error instanceof Error ? error.message : '数据库备份失败',
      },
      null,
      2,
    ),
  );
  process.exitCode = 1;
}
