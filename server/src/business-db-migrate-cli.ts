import path from 'node:path';

import { migrateSqliteBusinessDatabaseToPostgres } from './business-database-provisioning.js';

function readRequiredEnv(name: string) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

async function main() {
  const sourceDbPath = path.resolve(readRequiredEnv('APP_MIGRATION_SOURCE_DB_PATH'));
  const targetPostgresUrl = readRequiredEnv('APP_MIGRATION_TARGET_POSTGRES_URL');
  const targetSchema = process.env.APP_MIGRATION_TARGET_SCHEMA?.trim() || 'public';
  const truncateBeforeLoad = process.env.APP_MIGRATION_TRUNCATE !== 'false';

  const result = await migrateSqliteBusinessDatabaseToPostgres({
    sourceDbPath,
    targetPostgresUrl,
    targetSchema,
    truncateBeforeLoad,
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
}

main().catch((error) => {
  console.error(
    JSON.stringify(
      {
        ok: false,
        message: error instanceof Error ? error.message : 'Business database migration failed.',
      },
      null,
      2,
    ),
  );
  process.exit(1);
});
