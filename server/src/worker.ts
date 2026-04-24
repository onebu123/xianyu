import { setTimeout as sleep } from 'node:timers/promises';

import { createAiBargainRuntime } from './ai-bargain-runtime.js';
import { createAiServiceRuntime } from './ai-service-runtime.js';
import { createWorkerBackgroundJobs } from './background-jobs.js';
import {
  appConfig,
  assertValidRuntimeConfig,
  ensureRuntimeDirectories,
  getRuntimeConfigSummary,
} from './config.js';
import { createDatabaseFacade, DatabaseProvider } from './database-provider.js';
import { createAppLogger } from './observability.js';
import { createFulfillmentRuntime } from './fulfillment-runtime.js';
import { createFulfillmentQueueBackend } from './fulfillment-queue-backend.js';
import { getRuntimeDependencyChecks } from './runtime-dependency-checks.js';
import { createStoreHealthRuntime } from './store-health-runtime.js';
import { createXianyuDataSyncRuntime } from './xianyu-data-sync-runtime.js';

const logger = createAppLogger(appConfig);

function parseArgs(argv: string[]) {
  return {
    once: argv.includes('--once'),
  };
}

async function runWorker() {
  ensureRuntimeDirectories(appConfig);
  assertValidRuntimeConfig(appConfig);

  const args = parseArgs(process.argv.slice(2));
  const summary = getRuntimeConfigSummary(appConfig);
  const runtimeDependencies = await getRuntimeDependencyChecks(appConfig);
  const databaseProvider = new DatabaseProvider({
    privateDbPath: appConfig.dbPath,
    tenantDatabaseRoot: appConfig.tenantDatabaseRoot,
    businessDatabaseEngine: appConfig.businessDatabaseEngine,
    businessPostgresUrl: appConfig.businessPostgresUrl,
    tenantBusinessDatabaseEngine: appConfig.tenantBusinessDatabaseEngine,
    tenantBusinessPostgresUrlTemplate: appConfig.tenantBusinessPostgresUrlTemplate,
    runtimeMode: appConfig.runtimeMode,
    seedDemoData: appConfig.seedDemoData,
    bootstrapAdmin: appConfig.bootstrapAdmin,
  });
  databaseProvider.initializePrivateDatabase();
  const db = createDatabaseFacade(databaseProvider);
  const fulfillmentQueueBackend = createFulfillmentQueueBackend({
    config: appConfig,
    db,
    logger,
  });
  await fulfillmentQueueBackend.ensureReady();

  const aiServiceRuntime = createAiServiceRuntime({
    config: appConfig,
    db,
    logger,
  });
  const aiBargainRuntime = createAiBargainRuntime({
    config: appConfig,
    db,
    logger,
  });
  const xianyuDataSyncRuntime = createXianyuDataSyncRuntime({
    config: appConfig,
    db,
    logger,
  });
  const storeHealthRuntime = createStoreHealthRuntime({
    config: appConfig,
    db,
    logger,
  });
  const fulfillmentRuntime = createFulfillmentRuntime({
    config: appConfig,
    db,
    logger,
    queueBackend: fulfillmentQueueBackend,
  });

  const backgroundJobs = [
    ...createWorkerBackgroundJobs({
      config: appConfig,
      logger,
    }),
    aiServiceRuntime.createAutoSyncJob({
      scheduleMode: 'worker',
    }),
    aiBargainRuntime.createAutoSyncJob({
      scheduleMode: 'worker',
    }),
    xianyuDataSyncRuntime.createAutoSyncJob({
      scheduleMode: 'worker',
    }),
    storeHealthRuntime.createAutoHealthCheckJob({
      scheduleMode: 'worker',
    }),
    storeHealthRuntime.createAutoBrowserRenewJob({
      scheduleMode: 'worker',
    }),
    fulfillmentRuntime.createAutoDispatchJob({
      scheduleMode: 'worker',
    }),
  ];
  const enabledBackgroundJobs = backgroundJobs.filter((job) => job.enabled).map((job) => job.name);

  const stopWorkerResources = async () => {
    backgroundJobs.forEach((job) => job.stop());
    await fulfillmentQueueBackend.close();
    await databaseProvider.closeAll();
  };

  logger.info('worker_bootstrap_complete', '后台 Worker 启动完成', {
    deploymentMode: appConfig.deploymentMode,
    runtimeMode: appConfig.runtimeMode,
    backgroundJobsMode: appConfig.backgroundJobsMode,
    queueBackend: appConfig.queueBackend,
    once: args.once,
    metricsEnabled: appConfig.metricsEnabled,
    enabledBackgroundJobs,
    fulfillmentQueueRuntime: fulfillmentQueueBackend.getRuntimeStatus(),
    runtimeDependencies,
    summary,
  });

  if (args.once) {
    logger.info('worker_bootstrap_once', '后台 Worker 已完成单次启动检查', {
      deploymentMode: appConfig.deploymentMode,
      backgroundJobsMode: appConfig.backgroundJobsMode,
      enabledBackgroundJobs,
    });
    await stopWorkerResources();
    return;
  }

  if (appConfig.backgroundJobsMode === 'worker') {
    backgroundJobs.forEach((job) => job.start());
    logger.info('worker_background_jobs_started', 'Worker 已接管后台作业调度', {
      deploymentMode: appConfig.deploymentMode,
      enabledBackgroundJobs,
    });
  } else {
    logger.info('worker_idle_wait', '当前后台作业未切换到 Worker，进程进入待机模式', {
      deploymentMode: appConfig.deploymentMode,
      backgroundJobsMode: appConfig.backgroundJobsMode,
    });
  }

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) {
      return;
    }

    shuttingDown = true;
    await stopWorkerResources();
    logger.info('worker_shutdown_signal', '后台 Worker 收到停止信号，准备退出', { signal });
    await sleep(50);
    logger.info('worker_shutdown_complete', '后台 Worker 已退出', { signal });
    process.exit(0);
  };

  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });

  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });

  while (!shuttingDown) {
    await sleep(30_000);
    logger.debug('worker_heartbeat', '后台 Worker 待机中', {
      deploymentMode: appConfig.deploymentMode,
      runtimeMode: appConfig.runtimeMode,
      backgroundJobsMode: appConfig.backgroundJobsMode,
    });
  }
}

try {
  await runWorker();
} catch (error) {
  logger.error('worker_bootstrap_failed', '后台 Worker 启动失败', {
    message: error instanceof Error ? error.message : 'unknown',
  });
  process.exit(1);
}
