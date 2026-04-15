import {
  appConfig,
  assertRuntimeStartupReadiness,
  assertValidRuntimeConfig,
  ensureRuntimeDirectories,
  getRuntimeConfigSummary,
  getRuntimeStartupIssues,
} from './config.js';

try {
  ensureRuntimeDirectories(appConfig);
  assertValidRuntimeConfig(appConfig);
  assertRuntimeStartupReadiness(appConfig, { requireWebBuild: true });

  console.log(
    JSON.stringify(
      {
        ok: true,
        service: 'goofish-sale-statistics',
        checkedAt: new Date().toISOString(),
        configuration: getRuntimeConfigSummary(appConfig),
        startupReadiness: {
          requireWebBuild: true,
          issues: [],
        },
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
        message: error instanceof Error ? error.message : '启动前检查失败',
        startupReadiness: {
          requireWebBuild: true,
          issues: getRuntimeStartupIssues(appConfig, { requireWebBuild: true }),
        },
      },
      null,
      2,
    ),
  );
  process.exit(1);
}
