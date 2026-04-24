import type { StatisticsDatabase } from './database.js';
import type { ResolvedAppConfig } from './config.js';
import type { BackgroundJobController } from './background-jobs.js';
import { createAppLogger } from './observability.js';
import * as xianyuWebSessionService from './xianyu-web-session.js';

type AppLogger = Pick<ReturnType<typeof createAppLogger>, 'info' | 'warn' | 'error'>;

const AUTO_DATA_SYNC_INITIAL_DELAY_MS = 15_000;

function resolveBooleanEnv(value: string | undefined, fallback: boolean) {
  if (!value?.trim()) {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }
  return fallback;
}

function canRunAutoDataSync(config: ResolvedAppConfig) {
  return (
    config.deploymentMode === 'private' &&
    config.runtimeMode !== 'demo' &&
    config.storeAuthMode === 'xianyu_web_session' &&
    !process.env.VITEST &&
    resolveBooleanEnv(process.env.APP_XIANYU_AUTO_DATA_SYNC_ENABLED, false)
  );
}

export interface XianyuDataSyncRuntime {
  createAutoSyncJob(input: {
    scheduleMode: 'embedded' | 'worker';
    initialDelayMs?: number;
  }): BackgroundJobController;
}

export function createXianyuDataSyncRuntime(input: {
  config: ResolvedAppConfig;
  db: StatisticsDatabase;
  logger: AppLogger;
}): XianyuDataSyncRuntime {
  const autoDataSyncIntervalMs =
    Math.max(Number(process.env.APP_XIANYU_AUTO_DATA_SYNC_INTERVAL_SECONDS ?? 300), 60) * 1000;
  const autoDataSyncMaxOrdersPerStore = Math.max(
    1,
    Math.min(100, Math.trunc(Number(process.env.APP_XIANYU_AUTO_DATA_SYNC_MAX_ORDERS_PER_STORE ?? 10))),
  );

  const syncProductTargets = async (stopped: () => boolean) => {
    const productTargets = input.db.listManagedStoreProductSyncTargets();
    for (const target of productTargets) {
      if (stopped()) {
        break;
      }

      try {
        const fetched = await xianyuWebSessionService.fetchXianyuWebSessionProducts({
          cookieText: target.cookieText,
          userId: target.providerUserId,
        });
        input.db.syncManagedStoreProducts({
          storeId: target.storeId,
          items: fetched.items.map((item) => ({
            id: item.id,
            title: item.title,
            categoryLabel: item.categoryLabel,
            price: item.price,
            stock: item.stock,
          })),
        });
        input.logger.info('auto_data_sync_products', '店铺商品自动同步完成', {
          storeId: target.storeId,
          fetchedCount: fetched.items.length,
        });
      } catch (error) {
        input.logger.warn('auto_data_sync_products_error', '店铺商品自动同步失败', {
          storeId: target.storeId,
          message: error instanceof Error ? error.message : 'unknown',
        });
      }
    }
  };

  const syncOrderTargets = async (stopped: () => boolean) => {
    const orderTargets = input.db.listManagedStoreOrderSyncTargets();
    for (const target of orderTargets) {
      if (stopped()) {
        break;
      }

      try {
        const fetchedList = await xianyuWebSessionService.fetchXianyuWebSessionSellerCompletedTrades({
          cookieText: target.cookieText,
          userId: target.providerUserId,
          maxPages: Math.max(1, Math.ceil(autoDataSyncMaxOrdersPerStore / 20)),
        });

        const detailedOrders: Array<
          Awaited<ReturnType<typeof xianyuWebSessionService.fetchXianyuWebSessionCompletedOrderDetail>>
        > = [];

        for (const trade of fetchedList.items.slice(0, autoDataSyncMaxOrdersPerStore)) {
          if (stopped()) {
            break;
          }

          try {
            const detail = await xianyuWebSessionService.fetchXianyuWebSessionCompletedOrderDetail({
              cookieText: target.cookieText,
              tradeId: trade.tradeId,
            });
            detailedOrders.push(detail);
          } catch (error) {
            input.logger.warn('auto_data_sync_orders_detail_error', '订单详情拉取失败，已跳过当前订单', {
              storeId: target.storeId,
              tradeId: trade.tradeId,
              message: error instanceof Error ? error.message : 'unknown',
            });
          }
        }

        if (detailedOrders.length > 0) {
          input.db.syncManagedStoreOrders({
            storeId: target.storeId,
            orders: detailedOrders,
          });
        }

        input.logger.info('auto_data_sync_orders', '店铺订单自动同步完成', {
          storeId: target.storeId,
          fetchedCount: fetchedList.items.length,
          syncedCount: detailedOrders.length,
        });
      } catch (error) {
        input.logger.warn('auto_data_sync_orders_error', '店铺订单自动同步失败', {
          storeId: target.storeId,
          message: error instanceof Error ? error.message : 'unknown',
        });
      }
    }
  };

  const runAutoDataSyncCycle = async (stopped: () => boolean) => {
    await syncProductTargets(stopped);
    if (stopped()) {
      return;
    }
    await syncOrderTargets(stopped);
  };

  const createAutoSyncJob: XianyuDataSyncRuntime['createAutoSyncJob'] = ({ scheduleMode, initialDelayMs }) => {
    const enabled = canRunAutoDataSync(input.config);
    let timer: ReturnType<typeof setTimeout> | null = null;
    let running = false;
    let stopped = false;

    const scheduleNext = (delayMs: number) => {
      if (stopped) {
        return;
      }

      timer = setTimeout(() => {
        void executeCycle();
      }, delayMs);
    };

    const executeCycle = async () => {
      if (!enabled || stopped || running) {
        return;
      }

      running = true;
      try {
        await runAutoDataSyncCycle(() => stopped);
      } catch (error) {
        input.logger.error('auto_data_sync_fatal', '真实数据自动同步后台作业出现未捕获异常', {
          message: error instanceof Error ? error.message : 'unknown',
          scheduleMode,
        });
      } finally {
        running = false;
        timer = null;
        if (!stopped) {
          scheduleNext(autoDataSyncIntervalMs);
        }
      }
    };

    return {
      name: 'xianyu-data-auto-sync',
      enabled,
      start() {
        if (!enabled || stopped || timer) {
          return;
        }

        input.logger.info('auto_data_sync_scheduled', '已启用闲鱼真实数据自动同步后台作业', {
          intervalMs: autoDataSyncIntervalMs,
          maxOrdersPerStore: autoDataSyncMaxOrdersPerStore,
          scheduleMode,
          backgroundJobsMode: input.config.backgroundJobsMode,
        });
        scheduleNext(Math.max(initialDelayMs ?? AUTO_DATA_SYNC_INITIAL_DELAY_MS, 0));
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
    createAutoSyncJob,
  };
}
