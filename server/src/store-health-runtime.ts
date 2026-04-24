import type { StatisticsDatabase } from './database.js';
import type { ResolvedAppConfig } from './config.js';
import type { BackgroundJobController } from './background-jobs.js';
import { createAppLogger } from './observability.js';
import type { SystemUserRecord } from './types.js';
import * as xianyuWebSessionService from './xianyu-web-session.js';

type AppLogger = Pick<ReturnType<typeof createAppLogger>, 'info' | 'warn' | 'error'>;
type StoreHealthStatus = 'healthy' | 'warning' | 'offline' | 'abnormal' | 'skipped';
type StoreConnectionStatus = 'active' | 'pending_activation' | 'offline' | 'abnormal';
type StoreHealthTriggerMode = 'manual' | 'batch';
type ManagedStoreRecord = ReturnType<StatisticsDatabase['getStoreManagementOverview']>['stores'][number];

const AUTO_STORE_HEALTH_CHECK_INITIAL_DELAY_MS = 30_000;
const AUTO_STORE_BROWSER_RENEW_INITIAL_DELAY_MS = 45_000;

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

function canRunAutoStoreHealthCheck(config: ResolvedAppConfig) {
  return (
    config.deploymentMode === 'private' &&
    config.runtimeMode !== 'demo' &&
    config.storeAuthMode === 'xianyu_web_session' &&
    !process.env.VITEST &&
    resolveBooleanEnv(process.env.APP_XIANYU_STORE_HEALTH_AUTO_CHECK_ENABLED, false)
  );
}

function canRunAutoStoreBrowserRenew(config: ResolvedAppConfig) {
  return (
    config.deploymentMode === 'private' &&
    config.runtimeMode !== 'demo' &&
    config.storeAuthMode === 'xianyu_web_session' &&
    !process.env.VITEST &&
    resolveBooleanEnv(process.env.APP_XIANYU_STORE_BROWSER_RENEW_AUTO_ENABLED, false)
  );
}

function normalizeRiskLevel(riskLevel: string) {
  if (riskLevel === 'healthy' || riskLevel === 'warning' || riskLevel === 'offline') {
    return riskLevel;
  }
  if (riskLevel === 'pending') {
    return 'warning' as const;
  }
  return 'abnormal' as const;
}

function mapRiskLevelToHealthContext(riskLevel: string, detail: string) {
  const normalizedRiskLevel = normalizeRiskLevel(riskLevel);
  const statusMap: Record<
    'healthy' | 'warning' | 'offline' | 'abnormal',
    {
      status: Exclude<StoreHealthStatus, 'skipped'>;
      nextConnectionStatus: StoreConnectionStatus;
    }
  > = {
    healthy: { status: 'healthy', nextConnectionStatus: 'active' },
    warning: { status: 'warning', nextConnectionStatus: 'active' },
    offline: { status: 'offline', nextConnectionStatus: 'offline' },
    abnormal: { status: 'abnormal', nextConnectionStatus: 'abnormal' },
  };
  const mapped = statusMap[normalizedRiskLevel];

  return {
    status: mapped.status,
    detail,
    nextConnectionStatus: mapped.nextConnectionStatus,
    nextHealthStatus: mapped.status,
  };
}

export interface StoreHealthRuntime {
  runStoreHealthCheck(
    storeId: number,
    input: {
      triggeredByUserId: number | null;
      triggerMode?: StoreHealthTriggerMode;
      ignoreVerifyErrors?: boolean;
    },
  ): Promise<ReturnType<StatisticsDatabase['runStoreHealthCheck']>>;
  runBatchStoreHealthChecks(
    storeIds: number[],
    triggeredByUserId: number | null,
  ): Promise<Array<NonNullable<ReturnType<StatisticsDatabase['runStoreHealthCheck']>>>>;
  verifyManagedStoreCredential(
    storeId: number,
    input: {
      operatorUserId: number | null;
      triggerMode?: StoreHealthTriggerMode;
    },
  ): Promise<
    | null
    | (NonNullable<ReturnType<StatisticsDatabase['saveManagedStoreCredentialCheckResult']>> & {
        rawRet: string[];
      })
  >;
  renewManagedStoreCredentialViaBrowser(
    storeId: number,
    input: {
      operatorUserId: number | null;
      showBrowser?: boolean;
      executablePath?: string | null;
      triggerMode?: StoreHealthTriggerMode;
    },
  ): Promise<
    | null
    | (NonNullable<ReturnType<StatisticsDatabase['saveManagedStoreCredentialCheckResult']>> & {
        renewed: boolean;
        renewDetail: string;
        currentUrl: string | null;
        pageTitle: string | null;
        rawRet: string[];
      })
  >;
  createAutoHealthCheckJob(input: {
    scheduleMode: 'embedded' | 'worker';
    initialDelayMs?: number;
  }): BackgroundJobController;
  createAutoBrowserRenewJob(input: {
    scheduleMode: 'embedded' | 'worker';
    initialDelayMs?: number;
  }): BackgroundJobController;
}

export function createStoreHealthRuntime(input: {
  config: ResolvedAppConfig;
  db: StatisticsDatabase;
  logger: AppLogger;
}): StoreHealthRuntime {
  const autoStoreHealthCheckIntervalMs =
    Math.max(Number(process.env.APP_XIANYU_STORE_HEALTH_AUTO_CHECK_INTERVAL_SECONDS ?? 900), 60) *
    1000;
  const autoStoreBrowserRenewIntervalMs =
    Math.max(Number(process.env.APP_XIANYU_STORE_BROWSER_RENEW_AUTO_INTERVAL_SECONDS ?? 1800), 120) *
    1000;
  const autoStoreBrowserRenewShowBrowser = resolveBooleanEnv(
    process.env.APP_XIANYU_STORE_BROWSER_RENEW_AUTO_SHOW_BROWSER,
    false,
  );

  const getManagedStore = (storeId: number) =>
    input.db.getStoreManagementOverview().stores.find((row) => row.id === storeId) ?? null;

  const pickAutomationOperator = () =>
    input.db.listSystemUsers().find(
      (user) =>
        user.status === 'active' &&
        (user.role === 'admin' || user.role === 'operator' || user.role === 'support'),
    ) ?? null;

  const shouldAutoRenewManagedStore = (store: ManagedStoreRecord) => {
    if (
      store.platform !== 'xianyu' ||
      store.credentialType !== 'web_session' ||
      !store.enabled ||
      store.connectionStatus === 'pending_activation'
    ) {
      return false;
    }

    return (
      store.connectionStatus === 'offline' ||
      store.connectionStatus === 'abnormal' ||
      store.healthStatus === 'offline' ||
      store.healthStatus === 'abnormal' ||
      store.credentialRiskLevel === 'offline' ||
      store.credentialRiskLevel === 'abnormal'
    );
  };

  const resolveManagedStoreRealStatusContext = async (
    store: ManagedStoreRecord,
    options: { ignoreVerifyErrors?: boolean } = {},
  ) => {
    if (
      store.platform !== 'xianyu' ||
      store.credentialType !== 'web_session' ||
      !store.enabled
    ) {
      return null;
    }

    let credential: ReturnType<StatisticsDatabase['getManagedStoreWebSessionCredential']> | null = null;
    try {
      credential = input.db.getManagedStoreWebSessionCredential(store.id);
    } catch (error) {
      if (options.ignoreVerifyErrors) {
        input.logger.warn('store_health_check_credential_skipped', '店铺自动巡检跳过了不可校验凭据', {
          storeId: store.id,
          message: error instanceof Error ? error.message : 'unknown',
        });
        return null;
      }
      throw error;
    }

    if (!credential) {
      return null;
    }

    try {
      const verifyResult = await xianyuWebSessionService.verifyXianyuWebSessionCookie(
        credential.cookieText,
      );
      return mapRiskLevelToHealthContext(verifyResult.riskLevel, verifyResult.detail);
    } catch (error) {
      if (options.ignoreVerifyErrors) {
        input.logger.warn('store_health_check_verify_failed', '店铺自动巡检的凭据探活失败，已回退到本地状态机', {
          storeId: store.id,
          message: error instanceof Error ? error.message : 'unknown',
        });
        return null;
      }
      throw error;
    }
  };

  const runStoreHealthCheck: StoreHealthRuntime['runStoreHealthCheck'] = async (storeId, options) => {
    const store = getManagedStore(storeId);
    const realStatusContext = store
      ? await resolveManagedStoreRealStatusContext(store, {
          ignoreVerifyErrors: options.ignoreVerifyErrors,
        })
      : undefined;

    return input.db.runStoreHealthCheck(
      storeId,
      options.triggeredByUserId,
      options.triggerMode ?? 'manual',
      realStatusContext ?? undefined,
    );
  };

  const runBatchStoreHealthChecks: StoreHealthRuntime['runBatchStoreHealthChecks'] = async (
    storeIds,
    triggeredByUserId,
  ) => {
    const uniqueStoreIds = Array.from(
      new Set(storeIds.filter((storeId) => Number.isInteger(storeId) && storeId > 0)),
    );
    const checks: Array<NonNullable<ReturnType<StatisticsDatabase['runStoreHealthCheck']>>> = [];

    for (const storeId of uniqueStoreIds) {
      const payload = await runStoreHealthCheck(storeId, {
        triggeredByUserId,
        triggerMode: 'batch',
      });
      if (payload) {
        checks.push(payload);
      }
    }

    return checks;
  };

  const verifyManagedStoreCredential: StoreHealthRuntime['verifyManagedStoreCredential'] = async (
    storeId,
    options,
  ) => {
    const credential = input.db.getManagedStoreWebSessionCredential(storeId);
    if (!credential) {
      return null;
    }

    try {
      let result: Awaited<ReturnType<typeof xianyuWebSessionService.verifyXianyuWebSessionCookie>>;
      try {
        result = await xianyuWebSessionService.verifyXianyuWebSessionCookie(credential.cookieText);
      } catch (error) {
        if (credential.providerUserId?.trim()) {
          const probe = await xianyuWebSessionService.fetchXianyuWebSessionSellerCompletedTrades({
            cookieText: credential.cookieText,
            userId: credential.providerUserId,
            pageSize: 1,
            maxPages: 1,
          });
          result = {
            riskLevel: 'healthy',
            detail: `登录态主校验接口请求失败，但真实成交单接口调用成功，按可用处理。原始错误：${
              error instanceof Error ? error.message : '未知错误'
            }`,
            verificationUrl: null,
            refreshedCookieText: null,
            rawRet: probe.rawRet,
          };
        } else {
          throw error;
        }
      }

      const riskLevel = normalizeRiskLevel(result.riskLevel);
      const payload = input.db.saveManagedStoreCredentialCheckResult(
        storeId,
        {
          riskLevel,
          detail: result.detail,
          verificationUrl: result.verificationUrl,
          refreshedCookieText: result.refreshedCookieText,
        },
        options.operatorUserId,
        options.triggerMode ?? 'manual',
      );

      if (!payload) {
        return null;
      }

      return {
        ...payload,
        rawRet: result.rawRet,
      };
    } catch (error) {
      input.db.recordStoreCredentialEvent({
        storeId,
        credentialId: credential.credentialId,
        eventType: 'credential_verified',
        status: 'error',
        detail: error instanceof Error ? error.message : '登录态校验失败。',
        source: options.triggerMode === 'batch' ? 'auto_health_check' : 'manual',
        operatorUserId: options.operatorUserId ?? null,
      });
      throw error;
    }
  };

  const renewManagedStoreCredentialViaBrowser: StoreHealthRuntime['renewManagedStoreCredentialViaBrowser'] = async (
    storeId,
    options,
  ) => {
    const credential = input.db.getManagedStoreWebSessionCredential(storeId);
    if (!credential) {
      return null;
    }

    try {
      const renewResult = await xianyuWebSessionService.renewXianyuWebSessionCookieViaBrowser({
        cookieText: credential.cookieText,
        showBrowser: options.showBrowser,
        executablePath: options.executablePath ?? null,
      });

      input.db.markManagedStoreCredentialRenew(storeId, {
        cookieText: renewResult.cookieText,
        detail: renewResult.detail,
        renewed: renewResult.renewed,
        verificationUrl: renewResult.verificationUrl,
      });

      let verifyResult: Awaited<
        ReturnType<typeof xianyuWebSessionService.verifyXianyuWebSessionCookie>
      > | null = null;
      if (renewResult.cookieText) {
        try {
          verifyResult = await xianyuWebSessionService.verifyXianyuWebSessionCookie(
            renewResult.cookieText,
          );
        } catch {
          verifyResult = null;
        }
      }

      const riskLevel =
        verifyResult?.riskLevel === 'pending'
          ? 'warning'
          : normalizeRiskLevel(
              verifyResult?.riskLevel ??
                (renewResult.verificationUrl ? 'warning' : renewResult.renewed ? 'healthy' : 'offline'),
            );

      const payload = input.db.saveManagedStoreCredentialCheckResult(
        storeId,
        {
          riskLevel,
          detail: verifyResult?.detail ?? renewResult.detail,
          verificationUrl: verifyResult?.verificationUrl ?? renewResult.verificationUrl,
          refreshedCookieText: verifyResult?.refreshedCookieText ?? renewResult.cookieText,
        },
        options.operatorUserId,
        options.triggerMode ?? 'manual',
      );

      if (!payload) {
        return null;
      }

      return {
        ...payload,
        renewed: renewResult.renewed,
        renewDetail: renewResult.detail,
        currentUrl: renewResult.currentUrl,
        pageTitle: renewResult.pageTitle,
        rawRet: verifyResult?.rawRet ?? [],
      };
    } catch (error) {
      input.db.recordStoreCredentialEvent({
        storeId,
        credentialId: credential.credentialId,
        eventType: 'browser_renewed',
        status: 'error',
        detail: error instanceof Error ? error.message : '浏览器续登失败。',
        source: options.triggerMode === 'batch' ? 'auto_browser_renew' : 'browser_renew',
        operatorUserId: options.operatorUserId ?? null,
      });
      throw error;
    }
  };

  const runAutoHealthCheckCycle = async () => {
    const operator = pickAutomationOperator();
    if (!operator) {
      input.logger.warn('store_health_check_auto_skipped', '店铺自动巡检未找到可用操作账号', {
        dbPath: input.config.dbPath,
      });
      return;
    }

    const stores = input.db.getStoreManagementOverview().stores.filter((store) => store.enabled);
    for (const store of stores) {
      try {
        const payload = await runStoreHealthCheck(store.id, {
          triggeredByUserId: operator.id,
          triggerMode: 'batch',
          ignoreVerifyErrors: true,
        });

        if (!payload) {
          continue;
        }

        input.db.recordAuditLog({
          action: 'store_health_auto_checked',
          targetType: 'store',
          targetId: String(store.id),
          detail: `${operator.displayName} 通过后台巡检校验了店铺 ${store.id}，结果为 ${payload.status}。`,
          result: 'success',
          operator,
          ipAddress: 'worker',
        });
      } catch (error) {
        input.db.recordAuditLog({
          action: 'store_health_auto_checked',
          targetType: 'store',
          targetId: String(store.id),
          detail: `${operator.displayName} 通过后台巡检校验店铺 ${store.id} 失败：${
            error instanceof Error ? error.message : '未知错误'
          }`,
          result: 'failure',
          operator,
          ipAddress: 'worker',
        });
        input.logger.warn('store_health_check_auto_failed', '店铺自动巡检执行失败', {
          storeId: store.id,
          message: error instanceof Error ? error.message : 'unknown',
        });
      }
    }
  };

  const runAutoBrowserRenewCycle = async () => {
    const operator = pickAutomationOperator();
    if (!operator) {
      input.logger.warn('store_browser_renew_auto_skipped', '店铺自动续登未找到可用操作账号', {
        dbPath: input.config.dbPath,
      });
      return;
    }

    const stores = input.db
      .getStoreManagementOverview()
      .stores.filter((store) => shouldAutoRenewManagedStore(store));

    for (const store of stores) {
      try {
        const payload = await renewManagedStoreCredentialViaBrowser(store.id, {
          operatorUserId: operator.id,
          showBrowser: autoStoreBrowserRenewShowBrowser,
          triggerMode: 'batch',
        });

        if (!payload) {
          continue;
        }

        input.db.recordAuditLog({
          action: 'store_browser_auto_renewed',
          targetType: 'store',
          targetId: String(store.id),
          detail: `${operator.displayName} 通过后台作业执行了店铺 ${store.id} 的浏览器续登，结果为 ${payload.riskLevel}。`,
          result: payload.renewed || payload.riskLevel === 'healthy' ? 'success' : 'failure',
          operator,
          ipAddress: 'worker',
        });
      } catch (error) {
        input.db.recordAuditLog({
          action: 'store_browser_auto_renewed',
          targetType: 'store',
          targetId: String(store.id),
          detail: `${operator.displayName} 通过后台作业执行店铺 ${store.id} 的浏览器续登失败：${
            error instanceof Error ? error.message : '未知错误'
          }`,
          result: 'failure',
          operator,
          ipAddress: 'worker',
        });
        input.logger.warn('store_browser_renew_auto_failed', '店铺自动续登执行失败', {
          storeId: store.id,
          message: error instanceof Error ? error.message : 'unknown',
        });
      }
    }
  };

  const createAutoHealthCheckJob: StoreHealthRuntime['createAutoHealthCheckJob'] = ({
    scheduleMode,
    initialDelayMs,
  }) => {
    const enabled = canRunAutoStoreHealthCheck(input.config);
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
        await runAutoHealthCheckCycle();
      } finally {
        running = false;
        scheduleNext(autoStoreHealthCheckIntervalMs);
      }
    };

    return {
      name: 'store-health-auto-check',
      enabled,
      start() {
        if (!enabled || stopped || timer) {
          return;
        }

        input.logger.info('store_health_check_auto_enabled', '店铺自动巡检后台作业已启用', {
          intervalMs: autoStoreHealthCheckIntervalMs,
          scheduleMode,
          backgroundJobsMode: input.config.backgroundJobsMode,
        });
        scheduleNext(Math.max(initialDelayMs ?? AUTO_STORE_HEALTH_CHECK_INITIAL_DELAY_MS, 0));
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

  const createAutoBrowserRenewJob: StoreHealthRuntime['createAutoBrowserRenewJob'] = ({
    scheduleMode,
    initialDelayMs,
  }) => {
    const enabled = canRunAutoStoreBrowserRenew(input.config);
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
        await runAutoBrowserRenewCycle();
      } finally {
        running = false;
        scheduleNext(autoStoreBrowserRenewIntervalMs);
      }
    };

    return {
      name: 'store-browser-auto-renew',
      enabled,
      start() {
        if (!enabled || stopped || timer) {
          return;
        }

        input.logger.info('store_browser_renew_auto_enabled', '店铺自动浏览器续登后台作业已启用', {
          intervalMs: autoStoreBrowserRenewIntervalMs,
          showBrowser: autoStoreBrowserRenewShowBrowser,
          scheduleMode,
          backgroundJobsMode: input.config.backgroundJobsMode,
        });
        scheduleNext(Math.max(initialDelayMs ?? AUTO_STORE_BROWSER_RENEW_INITIAL_DELAY_MS, 0));
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
    runStoreHealthCheck,
    runBatchStoreHealthChecks,
    verifyManagedStoreCredential,
    renewManagedStoreCredentialViaBrowser,
    createAutoHealthCheckJob,
    createAutoBrowserRenewJob,
  };
}
