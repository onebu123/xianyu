import {
  appConfig,
  assertRuntimeStartupReadiness,
  assertValidRuntimeConfig,
  ensureRuntimeDirectories,
  getEnterpriseLaunchIssues,
  getRuntimeConfigSummary,
  getRuntimeStartupIssues,
} from './config.js';
import { createDatabaseProviderRuntimeSummary } from './database-provider.js';
import { getRuntimeDependencyChecks } from './runtime-dependency-checks.js';

function createDatabaseRuntimeSummary() {
  return createDatabaseProviderRuntimeSummary({
    privateDbPath: appConfig.dbPath,
    tenantDatabaseRoot: appConfig.tenantDatabaseRoot,
    businessDatabaseEngine: appConfig.businessDatabaseEngine,
    businessPostgresUrl: appConfig.businessPostgresUrl,
    tenantBusinessDatabaseEngine: appConfig.tenantBusinessDatabaseEngine,
    tenantBusinessPostgresUrlTemplate: appConfig.tenantBusinessPostgresUrlTemplate,
  });
}

try {
  ensureRuntimeDirectories(appConfig);
  const databaseRuntimeSummary = createDatabaseRuntimeSummary();
  const runtimeDependencies = await getRuntimeDependencyChecks(appConfig);
  assertValidRuntimeConfig(appConfig);
  assertRuntimeStartupReadiness(appConfig, { requireWebBuild: true });
  if (!runtimeDependencies.ok) {
    throw new Error(
      [
        'Runtime dependency checks failed. Resolve these issues before launch:',
        ...runtimeDependencies.issues.map((issue) => `- ${issue.name}: ${issue.message}`),
      ].join('\n'),
    );
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        service: 'goofish-sale-statistics',
        checkedAt: new Date().toISOString(),
        configuration: getRuntimeConfigSummary(appConfig, databaseRuntimeSummary),
        startupReadiness: {
          requireWebBuild: true,
          issues: [],
        },
        runtimeDependencies,
        enterpriseBaseline: {
          ready: getEnterpriseLaunchIssues(appConfig, databaseRuntimeSummary).length === 0,
          issues: getEnterpriseLaunchIssues(appConfig, databaseRuntimeSummary),
        },
      },
      null,
      2,
    ),
  );
} catch (error) {
  const databaseRuntimeSummary = createDatabaseRuntimeSummary();
  const runtimeDependencies = await getRuntimeDependencyChecks(appConfig);
  console.error(
    JSON.stringify(
      {
        ok: false,
        checkedAt: new Date().toISOString(),
        message: error instanceof Error ? error.message : 'Preflight checks failed.',
        configuration: getRuntimeConfigSummary(appConfig, databaseRuntimeSummary),
        startupReadiness: {
          requireWebBuild: true,
          issues: getRuntimeStartupIssues(appConfig, { requireWebBuild: true }),
        },
        runtimeDependencies,
        enterpriseBaseline: {
          ready: getEnterpriseLaunchIssues(appConfig, databaseRuntimeSummary).length === 0,
          issues: getEnterpriseLaunchIssues(appConfig, databaseRuntimeSummary),
        },
      },
      null,
      2,
    ),
  );
  process.exit(1);
}
