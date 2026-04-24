import type { StatisticsDatabase } from './database.js';
import type { ResolvedAppConfig } from './config.js';
import type { BackgroundJobController } from './background-jobs.js';
import type { FulfillmentQueueBackend } from './fulfillment-queue-backend.js';
import { createAppLogger } from './observability.js';

type AppLogger = Pick<ReturnType<typeof createAppLogger>, 'info' | 'warn' | 'error'>;

const AUTO_FULFILLMENT_INITIAL_DELAY_MS = 15_000;

function resolveNumberEnv(value: string | undefined, fallback: number, minimum: number) {
  const parsed = Number(value ?? '');
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(Math.floor(parsed), minimum);
}

function canRunFulfillmentWorker(config: ResolvedAppConfig) {
  return config.deploymentMode === 'private' && config.runtimeMode !== 'demo' && !process.env.VITEST;
}

export interface FulfillmentRuntime {
  runPendingQueueCycle(): Promise<{
    processedCardJobs: number;
    processedDirectChargeJobs: number;
    failedJobs: number;
  }>;
  createAutoDispatchJob(input: {
    scheduleMode: 'embedded' | 'worker';
    initialDelayMs?: number;
  }): BackgroundJobController;
}

export function createFulfillmentRuntime(input: {
  config: ResolvedAppConfig;
  db: StatisticsDatabase;
  logger: AppLogger;
  queueBackend: FulfillmentQueueBackend;
}): FulfillmentRuntime {
  const autoFulfillmentIntervalMs =
    resolveNumberEnv(process.env.APP_FULFILLMENT_WORKER_INTERVAL_SECONDS, 15, 5) * 1000;
  const maxBatchSize = resolveNumberEnv(process.env.APP_FULFILLMENT_WORKER_BATCH_SIZE, 20, 1);

  const handleTaskFailure = async (taskId: number, errorMessage: string) => {
    const failResult = input.db.failFulfillmentQueueTask(taskId, errorMessage);
    if (failResult?.taskStatus === 'pending') {
      await input.queueBackend.enqueue(taskId);
    }
  };

  const runPendingQueueCycle: FulfillmentRuntime['runPendingQueueCycle'] = async () => {
    let processedCardJobs = 0;
    let processedDirectChargeJobs = 0;
    let failedJobs = 0;

    const queueTaskIds = await input.queueBackend.reserveDueTaskIds(maxBatchSize);
    for (const taskId of queueTaskIds) {
      const task = input.db.claimFulfillmentQueueTask(taskId);
      if (!task) {
        continue;
      }

      try {
        let payload:
          | { success: boolean; errorMessage?: string | null; taskStatus?: string | null; idempotent?: boolean }
          | null = null;

        switch (task.taskType) {
          case 'card_delivery_job_run':
            payload = input.db.runCardDeliveryJob('card-delivery', task.refId);
            if (payload?.success) {
              processedCardJobs += 1;
              input.logger.info('fulfillment_card_job_success', '卡密履约任务执行完成', {
                taskId: task.id,
                jobId: task.refId,
                queueBackend: input.queueBackend.kind,
                idempotent: payload.idempotent ?? false,
              });
            }
            break;
          case 'direct_charge_dispatch':
            payload = input.db.dispatchDirectChargeJob('distribution-supply', task.refId);
            if (payload?.success) {
              processedDirectChargeJobs += 1;
              input.logger.info('fulfillment_direct_charge_job_success', '直充下发任务执行完成', {
                taskId: task.id,
                jobId: task.refId,
                queueBackend: input.queueBackend.kind,
                taskStatus: payload.taskStatus ?? null,
                idempotent: payload.idempotent ?? false,
              });
            }
            break;
          case 'direct_charge_retry':
            payload = input.db.retryDirectChargeJob('distribution-supply', task.refId);
            if (payload?.success) {
              processedDirectChargeJobs += 1;
              input.logger.info('fulfillment_direct_charge_retry_success', '直充重试任务执行完成', {
                taskId: task.id,
                jobId: task.refId,
                queueBackend: input.queueBackend.kind,
                taskStatus: payload.taskStatus ?? null,
                idempotent: payload.idempotent ?? false,
              });
            }
            break;
          case 'direct_charge_manual_review': {
            const reason =
              typeof task.payload?.reason === 'string' && task.payload.reason.trim()
                ? task.payload.reason.trim()
                : '系统转人工处理';
            payload = input.db.markDirectChargeJobManualReview(
              'distribution-supply',
              task.refId,
              reason,
            );
            if (payload?.success) {
              processedDirectChargeJobs += 1;
              input.logger.info(
                'fulfillment_direct_charge_manual_review_success',
                '直充人工接管任务执行完成',
                {
                  taskId: task.id,
                  jobId: task.refId,
                  queueBackend: input.queueBackend.kind,
                  reason,
                },
              );
            }
            break;
          }
          default:
            payload = {
              success: false,
              errorMessage: `unsupported_task_type:${String(task.taskType)}`,
            };
            break;
        }

        if (!payload || !payload.success) {
          failedJobs += 1;
          const errorMessage = payload?.errorMessage ?? 'job_not_found';
          await handleTaskFailure(task.id, errorMessage);
          input.logger.warn('fulfillment_queue_task_failed', '履约队列任务执行失败', {
            taskId: task.id,
            taskType: task.taskType,
            refId: task.refId,
            queueBackend: input.queueBackend.kind,
            detail: errorMessage,
          });
          continue;
        }

        input.db.completeFulfillmentQueueTask(task.id);
      } catch (error) {
        failedJobs += 1;
        const message = error instanceof Error ? error.message : 'unknown';
        await handleTaskFailure(task.id, message);
        input.logger.warn('fulfillment_queue_task_error', '履约队列任务执行异常', {
          taskId: task.id,
          taskType: task.taskType,
          refId: task.refId,
          queueBackend: input.queueBackend.kind,
          message,
        });
      }
    }

    if (processedCardJobs > 0 || processedDirectChargeJobs > 0 || failedJobs > 0) {
      input.logger.info('fulfillment_queue_cycle_complete', '履约队列本轮处理完成', {
        processedCardJobs,
        processedDirectChargeJobs,
        failedJobs,
        queueBackend: input.queueBackend.kind,
      });
    }

    return {
      processedCardJobs,
      processedDirectChargeJobs,
      failedJobs,
    };
  };

  const createAutoDispatchJob: FulfillmentRuntime['createAutoDispatchJob'] = ({
    scheduleMode,
    initialDelayMs,
  }) => {
    const enabled = canRunFulfillmentWorker(input.config);
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    let running = false;

    const scheduleNext = (delayMs: number) => {
      if (!enabled || stopped) {
        return;
      }
      if (timer) {
        clearTimeout(timer);
      }
      timer = setTimeout(() => {
        void executeCycle();
      }, Math.max(delayMs, 1_000));
    };

    const executeCycle = async () => {
      if (!enabled || stopped || running) {
        return;
      }

      running = true;
      try {
        await runPendingQueueCycle();
      } finally {
        running = false;
        scheduleNext(autoFulfillmentIntervalMs);
      }
    };

    return {
      name: 'fulfillment-task-dispatch',
      enabled,
      start() {
        if (!enabled || stopped || timer) {
          return;
        }

        input.logger.info('fulfillment_queue_worker_enabled', '履约任务后台作业已启用', {
          intervalMs: autoFulfillmentIntervalMs,
          maxBatchSize,
          scheduleMode,
          queueBackend: input.queueBackend.kind,
          backgroundJobsMode: input.config.backgroundJobsMode,
        });
        scheduleNext(Math.max(initialDelayMs ?? AUTO_FULFILLMENT_INITIAL_DELAY_MS, 0));
      },
      stop() {
        stopped = true;
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
      },
    };
  };

  return {
    runPendingQueueCycle,
    createAutoDispatchJob,
  };
}
