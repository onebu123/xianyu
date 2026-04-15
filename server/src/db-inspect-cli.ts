import { inspectSqliteDatabase } from './db-ops.js';

function readArg(flag: string) {
  const index = process.argv.indexOf(flag);
  if (index < 0) {
    return undefined;
  }
  return process.argv[index + 1];
}

try {
  const result = inspectSqliteDatabase({
    dbPath: readArg('--db'),
  });

  console.log(
    JSON.stringify(
      {
        ok: true,
        checkedAt: new Date().toISOString(),
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
        checkedAt: new Date().toISOString(),
        message: error instanceof Error ? error.message : '数据库巡检失败',
      },
      null,
      2,
    ),
  );
  process.exitCode = 1;
}
