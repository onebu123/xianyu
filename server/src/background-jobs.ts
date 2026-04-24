import { createSqliteBackup } from './backup-utils.js';
import type { ResolvedAppConfig } from './config.js';
import { createAppLogger } from './observability.js';

const AUTO_BACKUP_INTERVAL_MS = 6 * 60 * 60 * 1000;
const AUTO_BACKUP_INITIAL_DELAY_MS = 5 * 60 * 1000;

type AppLogger = Pick<ReturnType<typeof createAppLogger>, 'info' | 'warn' | 'error'>;

export interface BackgroundJobController {
  readonly name: string;
  readonly enabled: boolean;
  start(): void;
  stop(): void;
}

function canRunAutoBackup(config: ResolvedAppConfig) {
  return config.deploymentMode === 'private' && config.runtimeMode !== 'demo' && !process.env.VITEST;
}

export function createAutoBackupJob(input: {
  config: ResolvedAppConfig;
  logger: AppLogger;
  scheduleMode: 'embedded' | 'worker';
  initialDelayMs?: number;
}) {
  let initialTimer: ReturnType<typeof setTimeout> | null = null;
  let intervalTimer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;

  const initialDelayMs = Math.max(input.initialDelayMs ?? AUTO_BACKUP_INITIAL_DELAY_MS, 0);
  const enabled = canRunAutoBackup(input.config);

  const runBackup = () => {
    try {
      const result = createSqliteBackup({
        sourceDbPath: input.config.dbPath,
        outputDir: input.config.backupDir,
        prefix: 'auto',
      });
      input.logger.info('auto_backup_success', '数据库自动备份完成', {
        fileName: result.fileName,
        fileSize: result.fileSize,
        scheduleMode: input.scheduleMode,
      });
    } catch (error) {
      input.logger.error('auto_backup_failed', '数据库自动备份失败', {
        message: error instanceof Error ? error.message : 'unknown',
        scheduleMode: input.scheduleMode,
      });
    }
  };

  return {
    name: 'auto-backup',
    enabled,
    start() {
      if (!enabled || stopped || initialTimer || intervalTimer) {
        return;
      }

      input.logger.info('auto_backup_scheduled', '已启用数据库定时备份', {
        intervalHours: 6,
        backupRoot: input.config.backupDir,
        scheduleMode: input.scheduleMode,
        backgroundJobsMode: input.config.backgroundJobsMode,
      });

      initialTimer = setTimeout(() => {
        if (stopped) {
          return;
        }

        runBackup();
        intervalTimer = setInterval(runBackup, AUTO_BACKUP_INTERVAL_MS);
      }, initialDelayMs);
    },
    stop() {
      stopped = true;
      if (initialTimer) {
        clearTimeout(initialTimer);
        initialTimer = null;
      }
      if (intervalTimer) {
        clearInterval(intervalTimer);
        intervalTimer = null;
      }
    },
  } satisfies BackgroundJobController;
}

export function createWorkerBackgroundJobs(input: {
  config: ResolvedAppConfig;
  logger: AppLogger;
}) {
  return [createAutoBackupJob({ ...input, scheduleMode: 'worker' })];
}
