import type { StatisticsDatabase } from './database.js';
import type { ResolvedAppConfig } from './config.js';
import { createAppLogger } from './observability.js';
import type { SystemUserRecord } from './types.js';
import type { BackgroundJobController } from './background-jobs.js';
import * as xianyuWebSessionService from './xianyu-web-session.js';
import {
  buildAiServiceSystemPrompt,
  buildLlmMessagesFromHistory,
  callLlmChatCompletion,
  resolveLlmConfig,
  type LlmCallResult,
} from './llm-service.js';

type AppLogger = Pick<ReturnType<typeof createAppLogger>, 'info' | 'warn' | 'error'>;
type AiServiceSyncTarget = ReturnType<StatisticsDatabase['listManagedStoreAiBargainSyncTargets']>[number];

const AUTO_AI_SERVICE_SYNC_INITIAL_DELAY_MS = 5_000;

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

function resolveXianyuImRiskFromError(error: unknown) {
  const verificationUrl =
    error &&
    typeof error === 'object' &&
    'verificationUrl' in error &&
    typeof (error as { verificationUrl?: unknown }).verificationUrl === 'string'
      ? ((error as { verificationUrl: string }).verificationUrl ?? null)
      : null;

  if (error instanceof Error) {
    const code = String(
      'code' in error && typeof (error as Error & { code?: unknown }).code === 'string'
        ? (error as Error & { code: string }).code
        : '',
    ).trim();
    const message = error.message.trim();
    const detail = message || '闲鱼 IM 同步或发信失败';
    if (code === 'XIANYU_BROWSER_LOGIN_REQUIRED') {
      return {
        riskLevel: 'offline' as const,
        detail,
        verificationUrl,
      };
    }
    if (code === 'XIANYU_BROWSER_VERIFICATION_REQUIRED') {
      return {
        riskLevel: 'abnormal' as const,
        detail,
        verificationUrl,
      };
    }
  }

  return null;
}

function canRunAutoAiServiceSync(config: ResolvedAppConfig) {
  return (
    config.deploymentMode === 'private' &&
    config.runtimeMode !== 'demo' &&
    config.storeAuthMode === 'xianyu_web_session' &&
    !process.env.VITEST &&
    resolveBooleanEnv(process.env.APP_XIANYU_AI_SERVICE_AUTO_SYNC_ENABLED, false)
  );
}

export interface AiServiceRuntime {
  syncAiServiceStoreTarget(
    target: AiServiceSyncTarget,
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
    syncedConversationCount?: number;
    skippedCount?: number;
    createdConversationCount?: number;
    updatedConversationCount?: number;
    createdMessageCount?: number;
    syncedAt?: string;
    message?: string;
  }>;
  tryLlmReply(
    featureKey: string,
    conversationId: number,
    operator: { id: number; displayName: string },
  ): Promise<{ content: string; llmResult: LlmCallResult } | null>;
  sendAiServiceXianyuMessage(input: {
    featureKey: string;
    conversationId: number;
    content: string;
  }): Promise<
    | { delivered: false }
    | {
        delivered: true;
        sendResult: Awaited<ReturnType<typeof xianyuWebSessionService.sendXianyuWebSessionTextMessage>>;
      }
  >;
  createAutoSyncJob(input: {
    scheduleMode: 'embedded' | 'worker';
    initialDelayMs?: number;
  }): BackgroundJobController;
}

type AiServiceRuntimeSyncResult = Awaited<ReturnType<AiServiceRuntime['syncAiServiceStoreTarget']>>;

interface AiServiceRuntimeHooks {
  listManagedStoreAiServiceSyncTargets?: (storeIds?: number[]) => Promise<AiServiceSyncTarget[]> | AiServiceSyncTarget[];
  syncAiServiceStoreTarget?: (
    target: AiServiceSyncTarget,
    operator: { id: number; displayName: string },
    input: {
      featureKey: string;
      syncSource: 'manual' | 'auto';
      maxSessionsPerStore: number;
      maxMessagesPerSession: number;
    },
  ) => Promise<AiServiceRuntimeSyncResult | null> | AiServiceRuntimeSyncResult | null;
}

export function createAiServiceRuntime(input: {
  config: ResolvedAppConfig;
  db: StatisticsDatabase;
  logger: AppLogger;
  runtimeHooks?: AiServiceRuntimeHooks;
}): AiServiceRuntime {
  const autoAiServiceSyncIntervalMs =
    Math.max(Number(process.env.APP_XIANYU_AI_SERVICE_AUTO_SYNC_INTERVAL_SECONDS ?? 20), 10) *
    1000;
  const autoAiServiceSyncMaxSessions = Math.max(
    1,
    Math.min(50, Math.trunc(Number(process.env.APP_XIANYU_AI_SERVICE_AUTO_SYNC_MAX_SESSIONS ?? 20))),
  );
  const autoAiServiceSyncMaxMessages = Math.max(
    1,
    Math.min(50, Math.trunc(Number(process.env.APP_XIANYU_AI_SERVICE_AUTO_SYNC_MAX_MESSAGES ?? 20))),
  );
  const autoAiServiceAutoReplyBatchLimit = Math.max(
    1,
    Math.min(50, Math.trunc(Number(process.env.APP_XIANYU_AI_SERVICE_AUTO_REPLY_BATCH_LIMIT ?? 20))),
  );

  const recordManagedStoreXianyuImRisk = (
    storeId: number,
    source: 'ai_service_sync' | 'ai_service_auto_sync' | 'ai_service_dispatch',
    error: unknown,
    operatorUserId?: number | null,
  ) => {
    const risk = resolveXianyuImRiskFromError(error);
    if (!risk) {
      return null;
    }

    return input.db.markManagedStoreXianyuImRisk(storeId, {
      ...risk,
      source,
      operatorUserId: operatorUserId ?? null,
    });
  };

  const sendAiServiceXianyuMessage: AiServiceRuntime['sendAiServiceXianyuMessage'] = async (
    payload,
  ) => {
    const dispatchTarget = input.db.getAiServiceConversationDispatchTarget(
      payload.featureKey,
      payload.conversationId,
    );
    if (!dispatchTarget) {
      return { delivered: false };
    }

    const storeTarget = input.db.getManagedStoreXianyuImSyncTarget(dispatchTarget.storeId);
    if (!storeTarget) {
      throw new Error('当前会话所属店铺缺少可用的闲鱼网页登录态，无法发送真实消息。');
    }

    let sendResult;
    try {
      sendResult = await xianyuWebSessionService.sendXianyuWebSessionTextMessage({
        cookieText: storeTarget.cookieText,
        sessionId: dispatchTarget.sessionId,
        conversationCid: dispatchTarget.conversationCid,
        content: payload.content,
        cachedSocketAuth: storeTarget.cachedSocketAuth ?? null,
      });
    } catch (error) {
      if (
        error instanceof Error &&
        'socketAuthCacheRejected' in error &&
        (error as Error & { socketAuthCacheRejected?: boolean }).socketAuthCacheRejected
      ) {
        input.db.clearManagedStoreXianyuImAuthCache(dispatchTarget.storeId);
      }
      recordManagedStoreXianyuImRisk(dispatchTarget.storeId, 'ai_service_dispatch', error);
      throw error;
    }

    if (sendResult.refreshedCookieText && sendResult.refreshedCookieText !== storeTarget.cookieText) {
      input.db.markManagedStoreCredentialRenew(dispatchTarget.storeId, {
        cookieText: sendResult.refreshedCookieText,
        detail: 'AI 客服发信已刷新闲鱼网页登录态。',
        renewed: true,
      });
    }
    if (sendResult.socketAuthCache) {
      input.db.saveManagedStoreXianyuImAuthCache(
        dispatchTarget.storeId,
        sendResult.socketAuthCache,
        'ai_service_dispatch',
      );
    } else if (sendResult.socketAuthCacheRejected) {
      input.db.clearManagedStoreXianyuImAuthCache(dispatchTarget.storeId);
    }

    return {
      delivered: true as const,
      sendResult,
    };
  };

  const tryLlmReply: AiServiceRuntime['tryLlmReply'] = async (
    featureKey,
    conversationId,
    operator,
  ) => {
    const llmContext = input.db.getAiServiceLlmContext(conversationId);
    if (!llmContext) {
      return null;
    }

    const llmConfig = resolveLlmConfig(llmContext.dbApiKey);
    if (!llmConfig) {
      return null;
    }

    const systemPrompt = buildAiServiceSystemPrompt({
      storeName: llmContext.storeName,
      boundaryNote: llmContext.boundaryNote,
      sensitiveWords: llmContext.sensitiveWords,
      knowledgeItems: llmContext.knowledgeItems,
    });

    const llmMessages = buildLlmMessagesFromHistory(systemPrompt, llmContext.messages);
    const llmResult = await callLlmChatCompletion(llmConfig, llmMessages);

    if (!llmResult.success || !llmResult.content) {
      input.logger.warn('llm_reply_failed', 'LLM 大模型回复失败，已降级到本地规则引擎', {
        conversationId,
        model: llmResult.model,
        error: llmResult.error,
      });
      return null;
    }

    const writeResult = input.db.writeAiServiceLlmReply(
      featureKey,
      conversationId,
      llmResult.content,
      operator,
    );
    if (!writeResult) {
      return null;
    }

    input.logger.info('llm_reply_success', 'LLM 大模型回复成功', {
      conversationId,
      model: llmResult.model,
      usage: llmResult.usage,
      contentLength: llmResult.content.length,
    });

    return { content: llmResult.content, llmResult };
  };

  const pickAiServiceAutomationOperator = () =>
    input.db
      .listSystemUsers()
      .find(
        (user) =>
          user.status === 'active' &&
          (user.role === 'admin' || user.role === 'operator' || user.role === 'support'),
      ) ?? null;

  const syncAiServiceStoreTarget: AiServiceRuntime['syncAiServiceStoreTarget'] = async (
    target: AiServiceSyncTarget,
    operator: { id: number; displayName: string },
    jobInput,
  ) => {
    if (input.runtimeHooks?.syncAiServiceStoreTarget) {
      const delegated = await input.runtimeHooks.syncAiServiceStoreTarget(target, operator, jobInput);
      if (delegated) {
        return delegated;
      }
    }

    try {
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
              ? 'AI 客服自动同步已刷新闲鱼网页登录态。'
              : 'AI 客服真实会话同步已刷新闲鱼网页登录态。',
          renewed: true,
        });
      }
      if (fetched.socketAuthCache) {
        input.db.saveManagedStoreXianyuImAuthCache(
          target.storeId,
          fetched.socketAuthCache,
          jobInput.syncSource === 'auto' ? 'ai_service_auto_sync' : 'ai_service_sync',
        );
      } else if (fetched.socketAuthCacheRejected) {
        input.db.clearManagedStoreXianyuImAuthCache(target.storeId);
      }

      const synced = input.db.syncAiServiceConversationsFromXianyuIm({
        featureKey: jobInput.featureKey,
        storeId: target.storeId,
        sessions: fetched.sessions,
        operator,
        syncSource: jobInput.syncSource,
      });
      if (!synced) {
        return {
          storeId: target.storeId,
          shopName: target.shopName,
          providerUserId: target.providerUserId,
          success: false as const,
          message: 'AI 客服模块不可用或店铺不存在。',
        };
      }

      return {
        storeId: target.storeId,
        shopName: target.shopName,
        providerUserId: target.providerUserId,
        success: true as const,
        fetchedSessionCount: synced.fetchedSessionCount,
        candidateSessionCount: synced.candidateSessionCount,
        syncedConversationCount: synced.syncedConversationCount,
        skippedCount: synced.skippedCount,
        createdConversationCount: synced.createdConversationCount,
        updatedConversationCount: synced.updatedConversationCount,
        createdMessageCount: synced.createdMessageCount,
        syncedAt: synced.syncedAt,
        message:
          synced.candidateSessionCount === 0
            ? '本轮未发现可写入 AI 客服工作台的真实买家会话。'
            : undefined,
      };
    } catch (error) {
      if (
        error instanceof Error &&
        'socketAuthCacheRejected' in error &&
        (error as Error & { socketAuthCacheRejected?: boolean }).socketAuthCacheRejected
      ) {
        input.db.clearManagedStoreXianyuImAuthCache(target.storeId);
      }
      recordManagedStoreXianyuImRisk(
        target.storeId,
        jobInput.syncSource === 'auto' ? 'ai_service_auto_sync' : 'ai_service_sync',
        error,
        operator.id,
      );
      throw error;
    }
  };

  const runAiServiceAutoReplyQueue = async (storeId: number, operator: SystemUserRecord) => {
    const pendingConversationIds = input.db.listAiServicePendingAutoReplyConversationIds(
      'ai-service',
      {
        storeId,
        limit: autoAiServiceAutoReplyBatchLimit,
      },
    );
    if (pendingConversationIds.length === 0) {
      return;
    }

    for (const conversationId of pendingConversationIds) {
      const llmReply = await tryLlmReply('ai-service', conversationId, {
        id: operator.id,
        displayName: operator.displayName,
      });

      let replyContent: string;
      if (llmReply) {
        replyContent = llmReply.content;
      } else {
        const payload = input.db.generateAiServiceReply('ai-service', conversationId, {
          id: operator.id,
          displayName: operator.displayName,
        });
        if (!payload || payload.reused || payload.replyType !== 'ai') {
          continue;
        }
        replyContent = payload.content;
      }

      try {
        await sendAiServiceXianyuMessage({
          featureKey: 'ai-service',
          conversationId,
          content: replyContent,
        });
        input.db.updateAiServiceLatestOutboundMessageStatus(
          'ai-service',
          conversationId,
          'ai',
          'sent',
        );
      } catch (error) {
        input.db.updateAiServiceLatestOutboundMessageStatus(
          'ai-service',
          conversationId,
          'ai',
          'failed',
        );
        input.logger.warn('ai_service_auto_reply_failed', 'AI 客服自动回复失败', {
          conversationId,
          storeId,
          message: error instanceof Error ? error.message : 'unknown',
        });
      }
    }
  };

  const runAutoAiServiceSyncCycle = async () => {
    const operator = pickAiServiceAutomationOperator();
    if (!operator) {
      input.logger.warn('ai_service_auto_sync_skipped', 'AI 客服自动同步未找到可用操作账号', {
        dbPath: input.config.dbPath,
      });
      return;
    }

    const targets = input.runtimeHooks?.listManagedStoreAiServiceSyncTargets
      ? await input.runtimeHooks.listManagedStoreAiServiceSyncTargets()
      : input.db.listManagedStoreAiBargainSyncTargets();
    for (const target of targets) {
      try {
        const syncResult = await syncAiServiceStoreTarget(target, operator, {
          featureKey: 'ai-service',
          syncSource: 'auto',
          maxSessionsPerStore: autoAiServiceSyncMaxSessions,
          maxMessagesPerSession: autoAiServiceSyncMaxMessages,
        });

        if (syncResult.success) {
          await runAiServiceAutoReplyQueue(target.storeId, operator);
        }
      } catch (error) {
        input.logger.warn('ai_service_auto_sync_store_failed', 'AI 客服自动同步失败', {
          storeId: target.storeId,
          shopName: target.shopName,
          message: error instanceof Error ? error.message : 'unknown',
        });
      }
    }
  };

  const createAutoSyncJob: AiServiceRuntime['createAutoSyncJob'] = ({ scheduleMode, initialDelayMs }) => {
    const enabled = canRunAutoAiServiceSync(input.config);
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
        await runAutoAiServiceSyncCycle();
      } finally {
        running = false;
        scheduleNext(autoAiServiceSyncIntervalMs);
      }
    };

    return {
      name: 'ai-service-auto-sync',
      enabled,
      start() {
        if (!enabled || stopped || timer) {
          return;
        }

        input.logger.info('ai_service_auto_sync_enabled', 'AI 客服自动同步已启用', {
          intervalMs: autoAiServiceSyncIntervalMs,
          maxSessionsPerStore: autoAiServiceSyncMaxSessions,
          maxMessagesPerSession: autoAiServiceSyncMaxMessages,
          autoReplyBatchLimit: autoAiServiceAutoReplyBatchLimit,
          scheduleMode,
          backgroundJobsMode: input.config.backgroundJobsMode,
        });
        scheduleNext(Math.max(initialDelayMs ?? AUTO_AI_SERVICE_SYNC_INITIAL_DELAY_MS, 0));
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
    syncAiServiceStoreTarget,
    tryLlmReply,
    sendAiServiceXianyuMessage,
    createAutoSyncJob,
  };
}
