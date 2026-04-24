import { createApp } from './app.js';
import {
  appConfig,
  assertEnterpriseLaunchReadiness,
  assertRuntimeStartupReadiness,
  assertValidRuntimeConfig,
  ensureRuntimeDirectories,
} from './config.js';
import { createDatabaseProviderRuntimeSummary } from './database-provider.js';
import { createAppLogger } from './observability.js';

ensureRuntimeDirectories(appConfig);

const logger = createAppLogger(appConfig);

assertValidRuntimeConfig(appConfig);
assertRuntimeStartupReadiness(appConfig, { requireWebBuild: true });
if (appConfig.deploymentMode === 'saas' && appConfig.runtimeMode === 'prod') {
  assertEnterpriseLaunchReadiness(
    appConfig,
    createDatabaseProviderRuntimeSummary({
      privateDbPath: appConfig.dbPath,
      tenantDatabaseRoot: appConfig.tenantDatabaseRoot,
      businessDatabaseEngine: appConfig.businessDatabaseEngine,
      businessPostgresUrl: appConfig.businessPostgresUrl,
      tenantBusinessDatabaseEngine: appConfig.tenantBusinessDatabaseEngine,
      tenantBusinessPostgresUrlTemplate: appConfig.tenantBusinessPostgresUrlTemplate,
    }),
  );
}

const app = await createApp();

const shutdown = async (signal: string) => {
  logger.info('server_shutdown_signal', '收到停止信号，准备优雅停机', { signal });
  try {
    await app.close();
    logger.info('server_shutdown_complete', '服务已完成优雅停机', { signal });
    process.exit(0);
  } catch (error) {
    logger.error('server_shutdown_failed', '服务停机失败', {
      signal,
      message: error instanceof Error ? error.message : 'unknown',
    });
    process.exit(1);
  }
};

try {
  await app.listen({
    host: appConfig.host,
    port: appConfig.port,
  });

  logger.info('server_listening', '服务启动成功', {
    host: appConfig.host,
    port: appConfig.port,
    runtimeMode: appConfig.runtimeMode,
    envProfile: appConfig.envProfile,
  });
} catch (error) {
  logger.error('server_start_failed', '服务启动失败', {
    host: appConfig.host,
    port: appConfig.port,
    message: error instanceof Error ? error.message : 'unknown',
  });
  process.exit(1);
}

process.on('SIGINT', () => {
  void shutdown('SIGINT');
});

process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});
