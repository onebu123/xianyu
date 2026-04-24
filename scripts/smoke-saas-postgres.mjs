import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { repoRoot, resolvePostgresTarget, run } from './postgres-smoke-runtime.mjs';

const baseScript = path.join(path.dirname(fileURLToPath(import.meta.url)), 'smoke-saas-release.mjs');

const target = await resolvePostgresTarget({
  envUrlNames: ['APP_CONTROL_PLANE_POSTGRES_URL', 'SMOKE_POSTGRES_URL'],
  portBase: 55432,
  databaseName: 'sale_compass',
  dataDirPrefix: 'sale-compass-control-plane-pglite-',
});

try {
  await run(process.execPath, [baseScript], {
    cwd: repoRoot,
    env: {
      ...process.env,
      APP_CONTROL_PLANE_DB_ENGINE: 'postgres',
      APP_CONTROL_PLANE_POSTGRES_URL: target.connectionString,
    },
  });

  console.log(
    JSON.stringify(
      {
        ok: true,
        checkedAt: new Date().toISOString(),
        backend: target.backend,
        connectionString: target.connectionString,
      },
      null,
      2,
    ),
  );
} finally {
  await target.cleanup();
}
