import { runSqliteDoctor } from './db-ops.js';

function readArg(flag: string) {
  const index = process.argv.indexOf(flag);
  if (index < 0) {
    return undefined;
  }
  return process.argv[index + 1];
}

const strictArg = readArg('--strict');

try {
  const result = runSqliteDoctor({
    dbPath: readArg('--db'),
    strict: strictArg === 'true',
  });

  console.log(
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        ...result,
      },
      null,
      2,
    ),
  );

  if (!result.ok) {
    process.exitCode = 1;
  }
} catch (error) {
  console.error(
    JSON.stringify(
      {
        ok: false,
        checkedAt: new Date().toISOString(),
        message: error instanceof Error ? error.message : '数据库诊断失败',
      },
      null,
      2,
    ),
  );
  process.exitCode = 1;
}
