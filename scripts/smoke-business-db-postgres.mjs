import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

import { resolvePostgresTarget, run } from './postgres-smoke-runtime.mjs';

const { Pool } = pg;
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sale-compass-business-migration-'));
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tsxCliPath = path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const npmCliPath =
  process.env.npm_execpath || path.join(repoRoot, 'node_modules', 'npm', 'bin', 'npm-cli.js');

const target = await resolvePostgresTarget({
  envUrlNames: ['APP_MIGRATION_TARGET_POSTGRES_URL', 'SMOKE_POSTGRES_URL'],
  portBase: 56432,
  databaseName: 'sale_compass',
  dataDirPrefix: 'sale-compass-business-pglite-',
});

try {
  const sourceDbPath = path.join(tempRoot, 'business.db');

  await run(process.execPath, [
    tsxCliPath,
    '-e',
    `
      import { StatisticsDatabase } from './server/src/database.ts';
      const db = new StatisticsDatabase(${JSON.stringify(sourceDbPath)});
      db.initialize({ runtimeMode: 'demo', seedDemoData: true });
      db.close();
    `,
  ]);

  await run(process.execPath, [npmCliPath, 'run', 'business-db:migrate:postgres', '-w', 'server'], {
    env: {
      ...process.env,
      APP_MIGRATION_SOURCE_DB_PATH: sourceDbPath,
      APP_MIGRATION_TARGET_POSTGRES_URL: target.connectionString,
      APP_MIGRATION_TARGET_SCHEMA: 'public',
    },
  });

  const pool = new Pool({
    connectionString: target.connectionString,
    max: 2,
  });

  try {
    const tableCheck = await pool.query(`
      SELECT COUNT(*)::int AS count
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN ('users', 'orders', 'products', 'managed_stores')
    `);
    if ((tableCheck.rows[0]?.count ?? 0) < 4) {
      throw new Error('PostgreSQL business database is missing required tables.');
    }

    const usersCount = await pool.query('SELECT COUNT(*)::int AS count FROM public.users');
    const ordersCount = await pool.query('SELECT COUNT(*)::int AS count FROM public.orders');
    const productsCount = await pool.query('SELECT COUNT(*)::int AS count FROM public.products');

    if ((usersCount.rows[0]?.count ?? 0) < 1) {
      throw new Error('PostgreSQL business database did not receive users rows.');
    }
    if ((ordersCount.rows[0]?.count ?? 0) < 1) {
      throw new Error('PostgreSQL business database did not receive orders rows.');
    }
    if ((productsCount.rows[0]?.count ?? 0) < 1) {
      throw new Error('PostgreSQL business database did not receive products rows.');
    }

    const workspaceModule = await pool.query(
      `SELECT feature_key AS "featureKey" FROM public.workspace_modules ORDER BY feature_key ASC LIMIT 1`,
    );
    const workspaceFeatureKey = String(workspaceModule.rows[0]?.featureKey ?? '');
    if (!workspaceFeatureKey) {
      throw new Error('PostgreSQL business database did not receive workspace module rows.');
    }

    const workspaceLogInsert = await pool.query(
      `
        INSERT INTO public.workspace_logs (feature_key, log_type, title, detail, created_at)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id
      `,
      [
        workspaceFeatureKey,
        'smoke',
        'Sequence smoke log',
        'Validates migrated PostgreSQL identity columns.',
        new Date().toISOString().slice(0, 19).replace('T', ' '),
      ],
    );
    const workspaceLogId = Number(workspaceLogInsert.rows[0]?.id ?? 0);
    if (workspaceLogId < 1) {
      throw new Error('PostgreSQL business database failed to auto-generate workspace_logs.id.');
    }

    console.log(
      JSON.stringify(
        {
          ok: true,
          backend: target.backend,
          connectionString: target.connectionString,
          sourceDbPath,
          migratedTables: tableCheck.rows[0]?.count ?? 0,
          usersCount: usersCount.rows[0]?.count ?? 0,
          ordersCount: ordersCount.rows[0]?.count ?? 0,
          productsCount: productsCount.rows[0]?.count ?? 0,
          workspaceLogId,
        },
        null,
        2,
      ),
    );
  } finally {
    await pool.end();
  }
} finally {
  await target.cleanup();
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
