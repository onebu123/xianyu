import type { StatisticsDatabase } from './database.js';
import type { ResolvedAppConfig } from './config.js';
import type { BackgroundJobController } from './background-jobs.js';
import { createAppLogger } from './observability.js';
import type { SystemUserRecord } from './types.js';
import * as xianyuWebSessionService from './xianyu-web-session.js';

type AppLogger = Pick<ReturnType<typeof createAppLogger>, 'info' | 'warn' | 'error'>;
type AiBargainSyncTarget = ReturnType<StatisticsDatabase['listManagedStoreAiBargainSyncTargets']>[number];

const AUTO_AI_BARGAIN_SYNC_INITIAL_DELAY_MS = 10_000;

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

function canRunAutoAiBargainSync(config: ResolvedAppConfig) {
  return (
    config.deploymentMode === 'private' &&
    config.runtimeMode !== 'demo' &&
    config.storeAuthMode === 'xianyu_web_session' &&
    !process.env.VITEST &&
    resolveBooleanEnv(process.env.APP_XIANYU_AI_BARGAIN_AUTO_SYNC_ENABLED, false)
  );
}

export interface AiBargainRuntime {
  syncAiBargainStoreTarget(
    target: AiBargainSyncTarget,
    operator: { id: number; displayName: string },
    input: {
      featureKey: string;
      syncSource: 'manual' | 'auto';
      maxSessionsPerStore: number;
      maxMessagesPerSession: number;
    },
  ): Promise<{
    storeId: number;
    shopName: string;
    providerUserId: string;
    success: boolean;
    fetchedSessionCount?: number;
    candidateSessionCount?: number;
    syncedSessionCount?: number;
    skippedCount?: number;
    createdSessionCount?: number;
    updatedSessionCount?: number;
    createdLogCount?: number;
    createdStrategyCount?: number;
    autoEvaluatedCount?: number;
    syncedAt?: string;
    message?: string;
  }>;
  createAutoSyncJob(input: {
    scheduleMode: 'embedded' | 'worker';
    initialDelayMs?: number;
  }): BackgroundJobController;
}

type AiBargainRuntimeSyncResult = Awaited<ReturnType<AiBargainRuntime['syncAiBargainStoreTarget']>>;

interface AiBargainRuntimeHooks {
  listManagedStoreAiBargainSyncTargets?: (storeIds?: number[]) => Promise<AiBargainSyncTarget[]> | AiBargainSyncTarget[];
  syncAiBargainStoreTarget?: (
    target: AiBargainSyncTarget,
    operator: { id: number; displayName: string },
    input: {
      featureKey: string;
      syncSource: 'manual' | 'auto';
      maxSessionsPerStore: number;
      maxMessagesPerSession: number;
    },
  ) => Promise<AiBargainRuntimeSyncResult | null> | AiBargainRuntimeSyncResult | null;
}

export function createAiBargainRuntime(input: {
  config: ResolvedAppConfig;
  db: StatisticsDatabase;
  logger: AppLogger;
  runtimeHooks?: AiBargainRuntimeHooks;
}): AiBargainRuntime {
  const autoAiBargainSyncIntervalMs =
    Math.max(Number(process.env.APP_XIANYU_AI_BARGAIN_AUTO_SYNC_INTERVAL_SECONDS ?? 120), 30) *
    1000;
  const autoAiBargainSyncMaxSessions = Math.max(
    1,
    Math.min(50, Math.trunc(Number(process.env.APP_XIANYU_AI_BARGAIN_AUTO_SYNC_MAX_SESSIONS ?? 20))),
  );
  const autoAiBargainSyncMaxMessages = Math.max(
    1,
    Math.min(50, Math.trunc(Number(process.env.APP_XIANYU_AI_BARGAIN_AUTO_SYNC_MAX_MESSAGES ?? 20))),
  );

  const pickAiBargainAutomationOperator = (): SystemUserRecord | null =>
    input.db
      .listSystemUsers()
      .find(
        (user) =>
          user.status === 'active' &&
          (user.role === 'admin' || user.role === 'operator' || user.role === 'support'),
      ) ?? null;

  const syncAiBargainStoreTarget: AiBargainRuntime['syncAiBargainStoreTarget'] = async (
    target,
    operator,
    jobInput,
  ) => {
    if (input.runtimeHooks?.syncAiBargainStoreTarget) {
      const delegated = await input.runtimeHooks.syncAiBargainStoreTarget(target, operator, jobInput);
      if (delegated) {
        return delegated;
      }
    }

    const authCacheSource =
      jobInput.syncSource === 'auto' ? 'ai_bargain_auto_sync' : 'ai_bargain_sync';

    const fetched = await xianyuWebSessionService.fetchXianyuWebSessionBargainSessions({
      cookieText: target.cookieText,
      maxSessions: jobInput.maxSessionsPerStore,
      maxMessagesPerSession: jobInput.maxMessagesPerSession,
      cachedSocketAuth: target.cachedSocketAuth ?? null,
    });

    if (fetched.refreshedCookieText && fetched.refreshedCookieText !== target.cookieText) {
      input.db.markManagedStoreCredentialRenew(target.storeId, {
        cookieText: fetched.refreshedCookieText,
        detail:
          jobInput.syncSource === 'auto'
            ? 'AI 议价自动同步已刷新闲鱼网页登录态。'
            : 'AI 议价同步已刷新闲鱼网页登录态。',
        renewed: true,
      });
    }

    if (fetched.socketAuthCache) {
      input.db.saveManagedStoreXianyuImAuthCache(
        target.storeId,
        fetched.socketAuthCache,
        authCacheSource,
      );
    } else if (fetched.socketAuthCacheRejected) {
      input.db.clearManagedStoreXianyuImAuthCache(target.storeId);
    }

    const synced = input.db.syncAiBargainSessionsFromXianyuIm({
      featureKey: jobInput.featureKey,
      storeId: target.storeId,
      sessions: fetched.sessions,
      operator,
    });

    if (!synced) {
      return {
        storeId: target.storeId,
        shopName: target.shopName,
        providerUserId: target.providerUserId,
        success: false,
        message: 'AI 议价模块不可用或店铺不存在。',
      };
    }

    return {
      storeId: target.storeId,
      shopName: target.shopName,
      providerUserId: target.providerUserId,
      success: true,
      fetchedSessionCount: synced.fetchedSessionCount,
      candidateSessionCount: synced.candidateSessionCount,
      syncedSessionCount: synced.syncedSessionCount,
      skippedCount: synced.skippedCount,
      createdSessionCount: synced.createdSessionCount,
      updatedSessionCount: synced.updatedSessionCount,
      createdLogCount: synced.createdLogCount,
      createdStrategyCount: synced.createdStrategyCount,
      autoEvaluatedCount: synced.autoEvaluatedCount,
      syncedAt: synced.syncedAt,
      message:
        synced.candidateSessionCount === 0 ? '本轮未发现带议价意图的真实买家会话。' : undefined,
    };
  };

  const runAutoAiBargainSyncCycle = async () => {
    const operator = pickAiBargainAutomationOperator();
    if (!operator) {
      input.logger.warn('ai_bargain_auto_sync_skipped', 'AI 议价自动同步未找到可用操作账号', {
        dbPath: input.config.dbPath,
      });
      return;
    }

    const targets = input.runtimeHooks?.listManagedStoreAiBargainSyncTargets
      ? await input.runtimeHooks.listManagedStoreAiBargainSyncTargets()
      : input.db.listManagedStoreAiBargainSyncTargets();
    const results: Array<{ storeId: number; success: boolean }> = [];

    for (const target of targets) {
      try {
        const syncResult = await syncAiBargainStoreTarget(
          target,
          {
            id: operator.id,
            displayName: operator.displayName,
          },
          {
            featureKey: 'ai-bargain',
            syncSource: 'auto',
            maxSessionsPerStore: autoAiBargainSyncMaxSessions,
            maxMessagesPerSession: autoAiBargainSyncMaxMessages,
          },
        );
        results.push({
          storeId: target.storeId,
          success: syncResult.success,
        });
      } catch (error) {
        if (
          error instanceof Error &&
          'socketAuthCacheRejected' in error &&
          (error as Error & { socketAuthCacheRejected?: boolean }).socketAuthCacheRejected
        ) {
          input.db.clearManagedStoreXianyuImAuthCache(target.storeId);
        }
        results.push({
          storeId: target.storeId,
          success: false,
        });
        input.logger.warn('ai_bargain_auto_sync_store_failed', 'AI 议价自动同步失败', {
          storeId: target.storeId,
          shopName: target.shopName,
          message: error instanceof Error ? error.message : 'unknown',
        });
      }
    }

    if (results.length === 0) {
      return;
    }

    const successCount = results.filter((item) => item.success).length;
    input.db.recordAuditLog({
      action: 'xianyu_ai_bargain_auto_synced',
      targetType: 'ai_bargain',
      targetId: 'all-active-xianyu',
      detail: `${operator.displayName} 通过后台作业执行了闲鱼真实 AI 议价会话同步，成功 ${successCount}/${results.length} 家店铺。`,
      result: successCount > 0 ? 'success' : 'failure',
      operator,
      ipAddress: 'worker',
    });
  };

  const createAutoSyncJob: AiBargainRuntime['createAutoSyncJob'] = ({
    scheduleMode,
    initialDelayMs,
  }) => {
    const enabled = canRunAutoAiBargainSync(input.config);
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
        void runCycle();
      }, Math.max(delayMs, 1_000));
    };

    const runCycle = async () => {
      if (!enabled || stopped || running) {
        return;
      }

      running = true;
      try {
        await runAutoAiBargainSyncCycle();
      } finally {
        running = false;
        scheduleNext(autoAiBargainSyncIntervalMs);
      }
    };

    return {
      name: 'ai-bargain-auto-sync',
      enabled,
      start() {
        if (!enabled || stopped || timer) {
          return;
        }

        input.logger.info('ai_bargain_auto_sync_enabled', 'AI 议价自动同步后台作业已启用', {
          intervalMs: autoAiBargainSyncIntervalMs,
          maxSessionsPerStore: autoAiBargainSyncMaxSessions,
          maxMessagesPerSession: autoAiBargainSyncMaxMessages,
          scheduleMode,
          backgroundJobsMode: input.config.backgroundJobsMode,
        });
        scheduleNext(Math.max(initialDelayMs ?? AUTO_AI_BARGAIN_SYNC_INITIAL_DELAY_MS, 0));
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
    syncAiBargainStoreTarget,
    createAutoSyncJob,
  };
}
