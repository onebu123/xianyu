import fs from 'node:fs';

import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import { z, ZodError } from 'zod';

import {
  canAccessRoles,
  canManageWorkspaceFeature,
  canViewWorkspaceFeature,
  routeAccessPolicy,
  systemUserRoles,
} from './access-control.js';
import { comparePassword, needsPasswordRehash, hashPassword } from './auth.js';
import { createSqliteBackup } from './backup-utils.js';
import {
  assertValidRuntimeConfig,
  appConfig,
  ensureRuntimeDirectories,
  getEnvProfileForRuntimeMode,
  getRuntimeConfigSummary,
  type ResolvedAppConfig,
} from './config.js';
import { StatisticsDatabase } from './database.js';
import {
  AppMetricsCollector,
  createAppLogger,
  createRequestId,
  resolveRouteLabel,
  sanitizeUrlForLog,
  summarizeRequestForLog,
} from './observability.js';
import { StoreAuthLiveStreamManager } from './store-auth-live-stream.js';
import type {
  BootstrapAdminConfig,
  RuntimeMode,
  SystemUserRecord,
  SystemUserRole,
  SystemUserStatus,
} from './types.js';
import * as xianyuWebSessionService from './xianyu-web-session.js';
import {
  resolveLlmConfig,
  callLlmChatCompletion,
  buildAiServiceSystemPrompt,
  buildLlmMessagesFromHistory,
  type LlmCallResult,
} from './llm-service.js';

import {
  loginSchema,
  changePasswordSchema,
  baseFilterSchema,
  listQuerySchema,
  workspaceTaskStatusSchema,
  workspaceWithdrawalStatusSchema,
  workspaceWithdrawalCreateSchema,
  fundReconciliationStatusSchema,
  aiServiceTakeoverSchema,
  aiServiceManualReplySchema,
  aiServiceSettingsSchema,
  aiServiceEnabledSchema,
  aiBargainTakeoverSchema,
  aiBargainManualDecisionSchema,
  aiBargainSettingsSchema,
  aiBargainStrategySchema,
  cardImportSchema,
  cardRecycleSchema,
  directChargeManualReviewSchema,
  directChargeCallbackSchema,
  supplySourceSyncSchema,
  supplySourceManualReviewSchema,
  supplySourceCallbackSchema,
  supplySourceRefundSchema,
  fulfillmentReasonSchema,
  fulfillmentNoteSchema,
  afterSaleRefundActionSchema,
  afterSaleResendActionSchema,
  afterSaleDisputeActionSchema,
  afterSaleNoteSchema,
  storeAuthSessionSchema,
  storeAuthCompleteSchema,
  storeAuthProviderCallbackSchema,
  storeAuthProfileSyncSchema,
  storeAuthWebSessionSyncSchema,
  storeBrowserRenewSchema,
  xianyuProductSyncSchema,
  xianyuOrderSyncSchema,
  aiBargainSyncSchema,
  aiServiceSyncSchema,
  storeMetaUpdateSchema,
  storeEnabledSchema,
  storeBatchStatusSchema,
  storeBatchHealthCheckSchema,
  systemUserCreateSchema,
  systemUserRoleSchema,
  systemUserStatusSchema,
  secureSettingUpsertSchema,
  systemAlertStatusSchema,
} from './schemas.js';

interface CreateAppOptions {
  dbPath?: string;
  forceReseed?: boolean;
  runtimeMode?: RuntimeMode;
  seedDemoData?: boolean;
  bootstrapAdmin?: BootstrapAdminConfig | null;
}

type AppRequest = FastifyRequest & {
  currentUser?: SystemUserRecord;
  requestStartedAt?: bigint;
};

const AUTH_COOKIE_NAME = 'goofish-statistics-auth';

function parseCookieHeader(cookieHeader: string | string[] | undefined) {
  const source = Array.isArray(cookieHeader) ? cookieHeader.join(';') : cookieHeader ?? '';
  return source
    .split(';')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .reduce<Record<string, string>>((cookies, entry) => {
      const separatorIndex = entry.indexOf('=');
      if (separatorIndex <= 0) {
        return cookies;
      }

      const name = entry.slice(0, separatorIndex).trim();
      const value = entry.slice(separatorIndex + 1).trim();
      if (!name) {
        return cookies;
      }

      cookies[name] = decodeURIComponent(value);
      return cookies;
    }, {});
}

function shouldUseSecureAuthCookie(request: FastifyRequest, trustProxy: boolean) {
  if (request.protocol === 'https') {
    return true;
  }
  if (!trustProxy) {
    return false;
  }
  const forwardedProtoHeader = request.headers['x-forwarded-proto'];
  const forwardedProto =
    typeof forwardedProtoHeader === 'string'
      ? forwardedProtoHeader.split(',')[0]?.trim().toLowerCase()
      : '';
  return forwardedProto === 'https';
}

function buildAuthCookie(token: string, request: FastifyRequest, maxAgeSeconds: number, trustProxy: boolean) {
  const parts = [
    `${AUTH_COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`,
  ];

  if (shouldUseSecureAuthCookie(request, trustProxy)) {
    parts.push('Secure');
  }

  return parts.join('; ');
}

function buildExpiredAuthCookie(request: FastifyRequest, trustProxy: boolean) {
  const parts = [
    `${AUTH_COOKIE_NAME}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
  ];

  if (shouldUseSecureAuthCookie(request, trustProxy)) {
    parts.push('Secure');
  }

  return parts.join('; ');
}

function resolveRequestAuthToken(request: FastifyRequest) {
  const cookies = parseCookieHeader(request.headers.cookie);
  const cookieToken = cookies[AUTH_COOKIE_NAME];
  if (cookieToken) {
    return cookieToken;
  }

  const authorization = request.headers.authorization;
  if (typeof authorization === 'string') {
    const [scheme, credentials] = authorization.split(/\s+/, 2);
    if (scheme?.toLowerCase() === 'bearer' && credentials) {
      return credentials.trim();
    }
  }
  return null;
}

interface RateLimitBucket {
  count: number;
  resetAt: number;
}

const APP_VERSION = process.env.APP_VERSION?.trim() || '1.0.0';

function sanitizeUser(user: SystemUserRecord) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    role: user.role,
    status: user.status,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    lastLoginAt: user.lastLoginAt,
  };
}

function resolveRequestIp(request: FastifyRequest) {
  // Fastify 的 trustProxy 配置已正确处理 x-forwarded-for
  // 直接使用 request.ip 避免客户端伪造 IP 绕过限流
  return request.ip;
}

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

function extractUrlFromText(value: string) {
  const match = value.match(/https?:\/\/[^\s"'<>]+/i);
  if (!match) {
    return null;
  }
  return match[0].replace(/[),.;!?]+$/, '');
}

function resolveXianyuImRiskFromError(error: unknown) {
  if (!(error instanceof Error)) {
    return null;
  }

  const detail = error.message.trim();
  if (!detail) {
    return null;
  }

  const verificationUrl = extractUrlFromText(detail);
  if (verificationUrl || /风控|验证码|验证|captcha|verify/i.test(detail)) {
    return {
      riskLevel: 'warning' as const,
      detail,
      verificationUrl,
    };
  }

  if (
    /登录态|过期|失效|_m_h5_tk|token|accessToken|IM 长连|illegal access|session expired/i.test(detail)
  ) {
    return {
      riskLevel: 'offline' as const,
      detail,
      verificationUrl: null,
    };
  }

  return null;
}

export async function createApp(options?: CreateAppOptions) {
  const runtimeMode = options?.runtimeMode ?? appConfig.runtimeMode;
  const seedDemoData =
    options?.seedDemoData ?? (options?.runtimeMode ? runtimeMode === 'demo' : appConfig.seedDemoData);
  const runtimeConfig: ResolvedAppConfig = {
    ...appConfig,
    runtimeMode,
    envProfile: getEnvProfileForRuntimeMode(runtimeMode),
    seedDemoData,
    dbPath: options?.dbPath ?? appConfig.dbPath,
    bootstrapAdmin: options?.bootstrapAdmin ?? appConfig.bootstrapAdmin,
  };

  assertValidRuntimeConfig(runtimeConfig);
  ensureRuntimeDirectories(runtimeConfig);

  const logger = createAppLogger(runtimeConfig);
  const metrics = new AppMetricsCollector();
  const app = Fastify({
    logger: false,
    trustProxy: runtimeConfig.trustProxy,
    requestIdHeader: 'x-request-id',
    disableRequestLogging: true,
    genReqId(request) {
      const headerValue = request.headers['x-request-id'];
      if (typeof headerValue === 'string' && headerValue.trim()) {
        return headerValue.trim().slice(0, 64);
      }
      return createRequestId();
    },
  });
  const db = new StatisticsDatabase(runtimeConfig.dbPath);
  db.initialize({
    forceReseed: options?.forceReseed,
    runtimeMode,
    seedDemoData,
    bootstrapAdmin: runtimeConfig.bootstrapAdmin,
  });
  const storeAuthLiveStreamManager = new StoreAuthLiveStreamManager();

  logger.info('app_bootstrap', '应用实例初始化完成', {
    dbPath: runtimeConfig.dbPath,
    runtimeMode,
    envProfile: runtimeConfig.envProfile,
    metricsEnabled: runtimeConfig.metricsEnabled,
  });

  const rateLimits = new Map<string, RateLimitBucket>();

  const hitRateLimit = (key: string, limit: number, windowMinutes: number) => {
    const now = Date.now();
    const windowMs = windowMinutes * 60 * 1000;
    const current = rateLimits.get(key);
    if (!current || current.resetAt <= now) {
      rateLimits.set(key, { count: 1, resetAt: now + windowMs });
      return { allowed: true, remaining: Math.max(limit - 1, 0) };
    }

    current.count += 1;
    rateLimits.set(key, current);
    return {
      allowed: current.count <= limit,
      remaining: Math.max(limit - current.count, 0),
    };
  };

  const createAuthSession = async (
    request: FastifyRequest,
    reply: FastifyReply,
    user: SystemUserRecord,
  ) => {
    const expiresAt = new Date(
      Date.now() + runtimeConfig.jwtExpiresMinutes * 60 * 1000,
    ).toISOString();
    const token = await reply.jwtSign({
      sub: user.id,
      username: user.username,
      displayName: user.displayName,
      role: user.role,
      status: user.status,
      ver: user.tokenVersion ?? 0,
    });
    reply.header(
      'set-cookie',
      buildAuthCookie(token, request, runtimeConfig.jwtExpiresMinutes * 60, runtimeConfig.trustProxy),
    );

    return {
      token,
      expiresAt,
      user: sanitizeUser(user),
    };
  };

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

    return db.markManagedStoreXianyuImRisk(storeId, {
      ...risk,
      source,
      operatorUserId: operatorUserId ?? null,
    });
  };

  const sendAiServiceXianyuMessage = async (input: {
    featureKey: string;
    conversationId: number;
    content: string;
  }) => {
    const dispatchTarget = db.getAiServiceConversationDispatchTarget(
      input.featureKey,
      input.conversationId,
    );
    if (!dispatchTarget) {
      return { delivered: false as const };
    }

    const storeTarget = db.getManagedStoreXianyuImSyncTarget(dispatchTarget.storeId);
    if (!storeTarget) {
      throw new Error('当前会话所属店铺缺少可用的闲鱼网页登录态，无法发送真实消息。');
    }

    let sendResult;
    try {
      sendResult = await xianyuWebSessionService.sendXianyuWebSessionTextMessage({
        cookieText: storeTarget.cookieText,
        sessionId: dispatchTarget.sessionId,
        conversationCid: dispatchTarget.conversationCid,
        content: input.content,
        cachedSocketAuth: storeTarget.cachedSocketAuth ?? null,
      });
    } catch (error) {
      if (
        error instanceof Error &&
        'socketAuthCacheRejected' in error &&
        (error as Error & { socketAuthCacheRejected?: boolean }).socketAuthCacheRejected
      ) {
        db.clearManagedStoreXianyuImAuthCache(dispatchTarget.storeId);
      }
      recordManagedStoreXianyuImRisk(dispatchTarget.storeId, 'ai_service_dispatch', error);
      throw error;
    }

    if (sendResult.refreshedCookieText && sendResult.refreshedCookieText !== storeTarget.cookieText) {
      db.markManagedStoreCredentialRenew(dispatchTarget.storeId, {
        cookieText: sendResult.refreshedCookieText,
        detail: 'AI客服发信已刷新闲鱼网页登录态。',
        renewed: true,
      });
    }
    if (sendResult.socketAuthCache) {
      db.saveManagedStoreXianyuImAuthCache(
        dispatchTarget.storeId,
        sendResult.socketAuthCache,
        'ai_service_dispatch',
      );
    } else if (sendResult.socketAuthCacheRejected) {
      db.clearManagedStoreXianyuImAuthCache(dispatchTarget.storeId);
    }

    return {
      delivered: true as const,
      sendResult,
    };
  };

  const autoAiServiceSyncEnabled =
    runtimeConfig.runtimeMode !== 'demo' &&
    runtimeConfig.storeAuthMode === 'xianyu_web_session' &&
    !process.env.VITEST &&
    resolveBooleanEnv(process.env.APP_XIANYU_AI_SERVICE_AUTO_SYNC_ENABLED, false);
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
  let autoAiServiceSyncTimer: ReturnType<typeof setTimeout> | null = null;
  let autoAiServiceSyncRunning = false;
  let autoAiServiceSyncStopped = false;

  /**
   * 尝试调用 LLM 大模型生成 AI 客服回复。
   * 如果 LLM 未配置或调用失败，返回 null，由调用方降级到本地规则引擎。
   */
  const tryLlmReply = async (
    featureKey: string,
    conversationId: number,
    operator: { id: number; displayName: string },
  ): Promise<{ content: string; llmResult: LlmCallResult } | null> => {
    const llmContext = db.getAiServiceLlmContext(conversationId);
    if (!llmContext) {
      return null;
    }

    const llmConfig = resolveLlmConfig(llmContext.dbApiKey);
    if (!llmConfig) {
      return null; // LLM 未配置，降级到规则引擎
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
      logger.warn('llm_reply_failed', 'LLM 大模型回复失败，降级到本地规则引擎', {
        conversationId,
        model: llmResult.model,
        error: llmResult.error,
      });
      return null;
    }

    // 将 LLM 回复写入数据库
    const writeResult = db.writeAiServiceLlmReply(
      featureKey,
      conversationId,
      llmResult.content,
      operator,
    );
    if (!writeResult) {
      return null;
    }

    logger.info('llm_reply_success', 'LLM 大模型回复成功', {
      conversationId,
      model: llmResult.model,
      usage: llmResult.usage,
      contentLength: llmResult.content.length,
    });

    return { content: llmResult.content, llmResult };
  };

  const pickAiServiceAutomationOperator = () =>
    db
      .listSystemUsers()
      .find(
        (user) =>
          user.status === 'active' &&
          (user.role === 'admin' || user.role === 'operator' || user.role === 'support'),
      ) ?? null;

  const syncAiServiceStoreTarget = async (
    target: ReturnType<typeof db.listManagedStoreAiBargainSyncTargets>[number],
    operator: { id: number; displayName: string },
    input: {
      featureKey: string;
      syncSource: 'manual' | 'auto';
      maxSessionsPerStore: number;
      maxMessagesPerSession: number;
    },
  ) => {
    try {
      const fetched = await xianyuWebSessionService.fetchXianyuWebSessionBargainSessions({
        cookieText: target.cookieText,
        maxSessions: input.maxSessionsPerStore,
        maxMessagesPerSession: input.maxMessagesPerSession,
        cachedSocketAuth: target.cachedSocketAuth ?? null,
      });
    if (fetched.refreshedCookieText && fetched.refreshedCookieText !== target.cookieText) {
      db.markManagedStoreCredentialRenew(target.storeId, {
        cookieText: fetched.refreshedCookieText,
        detail:
          input.syncSource === 'auto'
            ? 'AI 客服自动同步已刷新闲鱼网页登录态。'
            : 'AI 客服真实会话同步已刷新闲鱼网页登录态。',
        renewed: true,
      });
    }
    if (fetched.socketAuthCache) {
      db.saveManagedStoreXianyuImAuthCache(
        target.storeId,
        fetched.socketAuthCache,
        input.syncSource === 'auto' ? 'ai_service_auto_sync' : 'ai_service_sync',
      );
    } else if (fetched.socketAuthCacheRejected) {
      db.clearManagedStoreXianyuImAuthCache(target.storeId);
    }

    const synced = db.syncAiServiceConversationsFromXianyuIm({
      featureKey: input.featureKey,
      storeId: target.storeId,
      sessions: fetched.sessions,
      operator,
      syncSource: input.syncSource,
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
        db.clearManagedStoreXianyuImAuthCache(target.storeId);
      }
      recordManagedStoreXianyuImRisk(
        target.storeId,
        input.syncSource === 'auto' ? 'ai_service_auto_sync' : 'ai_service_sync',
        error,
        operator.id,
      );
      throw error;
    }
  };

  const runAiServiceAutoReplyQueue = async (storeId: number, operator: SystemUserRecord) => {
    const pendingConversationIds = db.listAiServicePendingAutoReplyConversationIds('ai-service', {
      storeId,
      limit: autoAiServiceAutoReplyBatchLimit,
    });
    if (pendingConversationIds.length === 0) {
      return;
    }

    for (const conversationId of pendingConversationIds) {
      // 先尝试 LLM 大模型回复
      const llmReply = await tryLlmReply('ai-service', conversationId, {
        id: operator.id,
        displayName: operator.displayName,
      });

      let replyContent: string;
      if (llmReply) {
        // LLM 成功，使用 LLM 生成的内容
        replyContent = llmReply.content;
      } else {
        // LLM 不可用或失败，降级到本地规则引擎
        const payload = db.generateAiServiceReply('ai-service', conversationId, {
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
        db.updateAiServiceLatestOutboundMessageStatus('ai-service', conversationId, 'ai', 'sent');
      } catch (error) {
        db.updateAiServiceLatestOutboundMessageStatus('ai-service', conversationId, 'ai', 'failed');
        logger.warn('ai_service_auto_reply_failed', 'AI 客服自动回复失败', {
          conversationId,
          storeId,
          message: error instanceof Error ? error.message : 'unknown',
        });
      }
    }
  };

  const scheduleAutoAiServiceSync = (delayMs: number) => {
    if (!autoAiServiceSyncEnabled || autoAiServiceSyncStopped) {
      return;
    }

    if (autoAiServiceSyncTimer) {
      clearTimeout(autoAiServiceSyncTimer);
    }
    autoAiServiceSyncTimer = setTimeout(() => {
      void runAutoAiServiceSyncCycle();
    }, Math.max(delayMs, 1000));
  };

  const runAutoAiServiceSyncCycle = async () => {
    if (!autoAiServiceSyncEnabled || autoAiServiceSyncStopped || autoAiServiceSyncRunning) {
      return;
    }

    autoAiServiceSyncRunning = true;
    try {
      const operator = pickAiServiceAutomationOperator();
      if (!operator) {
        logger.warn('ai_service_auto_sync_skipped', 'AI 客服自动同步未找到可用操作账号', {
          dbPath: runtimeConfig.dbPath,
        });
        return;
      }

      const targets = db.listManagedStoreAiBargainSyncTargets();
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
          if (
            error instanceof Error &&
            'socketAuthCacheRejected' in error &&
            (error as Error & { socketAuthCacheRejected?: boolean }).socketAuthCacheRejected
          ) {
            db.clearManagedStoreXianyuImAuthCache(target.storeId);
          }
          logger.warn('ai_service_auto_sync_store_failed', 'AI 客服自动同步失败', {
            storeId: target.storeId,
            shopName: target.shopName,
            message: error instanceof Error ? error.message : 'unknown',
          });
        }
      }
    } finally {
      autoAiServiceSyncRunning = false;
      scheduleAutoAiServiceSync(autoAiServiceSyncIntervalMs);
    }
  };

  if (autoAiServiceSyncEnabled) {
    logger.info('ai_service_auto_sync_enabled', 'AI 客服自动同步已启用', {
      intervalMs: autoAiServiceSyncIntervalMs,
      maxSessionsPerStore: autoAiServiceSyncMaxSessions,
      maxMessagesPerSession: autoAiServiceSyncMaxMessages,
      autoReplyBatchLimit: autoAiServiceAutoReplyBatchLimit,
    });
    scheduleAutoAiServiceSync(5_000);
  }

  const requireCurrentUser = async (
    request: AppRequest,
    reply: FastifyReply,
  ): Promise<SystemUserRecord | null> => {
    const requestUrlForLog = sanitizeUrlForLog(request.url);
    const shouldAuditMissingAuth =
      !(request.method === 'POST' && requestUrlForLog === '/api/auth/refresh');
    const authToken = resolveRequestAuthToken(request);
    if (!authToken) {
      if (shouldAuditMissingAuth) {
        db.recordAuditLog({
          action: 'unauthorized_access',
          targetType: 'api',
          targetId: requestUrlForLog,
          detail: `未登录访问 ${request.method} ${requestUrlForLog}。`,
          result: 'blocked',
          ipAddress: resolveRequestIp(request),
        });
      }
      reply.code(401).send({ message: '登录已失效，请重新登录' });
      return null;
    }

    let tokenPayload: { sub?: number | string; ver?: number };
    try {
      tokenPayload = await app.jwt.verify<{ sub?: number | string; ver?: number }>(authToken);
    } catch {
      db.recordAuditLog({
        action: 'unauthorized_access',
        targetType: 'api',
        targetId: requestUrlForLog,
        detail: `未登录访${request.method} ${requestUrlForLog}`,
        result: 'blocked',
        ipAddress: resolveRequestIp(request),
      });
      reply.code(401).send({ message: '登录已失效，请重新登录' });
      return null;
    }

    const userId = Number(tokenPayload.sub ?? 0);
    if (!userId) {
      reply.code(401).send({ message: '登录态无效，请重新登录' });
      return null;
    }

    const user = db.getUserById(userId);
    if (!user) {
      db.recordAuditLog({
        action: 'unauthorized_access',
        targetType: 'auth',
        targetId: String(userId),
        detail: '令牌用户不存在，访问已拒绝',
        result: 'blocked',
        ipAddress: resolveRequestIp(request),
      });
      reply.code(401).send({ message: '账号不存在，请重新登录' });
      return null;
    }

    const tokenVersion = Number(tokenPayload.ver ?? 0);
    if (tokenVersion !== (user.tokenVersion ?? 0)) {
      db.recordAuditLog({
        action: 'unauthorized_access',
        targetType: 'auth',
        targetId: String(userId),
        detail: '令牌已失效，访问已拒绝。',
        result: 'blocked',
        ipAddress: resolveRequestIp(request),
      });
      reply.code(401).send({ message: '登录态已失效，请重新登录' });
      return null;
    }

    if (user.status !== 'active') {
      db.recordAuditLog({
        action: 'login_blocked',
        targetType: 'user',
        targetId: String(user.id),
        detail: `停用账号 ${user.username} 访问接口被拒绝。`,
        result: 'blocked',
        operator: user,
        ipAddress: resolveRequestIp(request),
      });
      reply.code(403).send({ message: '当前账号已停用' });
      return null;
    }

    request.currentUser = user;
    return user;
  };

  const authenticate = async (request: FastifyRequest, reply: FastifyReply) => {
    await requireCurrentUser(request as AppRequest, reply);
  };

  const authorizeRoles =
    (allowedRoles: readonly SystemUserRole[], targetType: string, actionLabel: string) =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      const currentUser = await requireCurrentUser(request as AppRequest, reply);
      if (!currentUser) {
        return;
      }

      if (canAccessRoles(currentUser.role, allowedRoles)) {
        return;
      }

      db.recordAuditLog({
        action: 'unauthorized_access',
        targetType,
        targetId: sanitizeUrlForLog(request.url),
        detail: `${currentUser.displayName} 尝试访问 ${actionLabel}，角色为 ${currentUser.role}。`,
        result: 'blocked',
        operator: currentUser,
        ipAddress: resolveRequestIp(request),
      });
      reply.code(403).send({ message: '当前账号无权执行该操作' });
    };

  const authorizeWorkspace =
    (mode: 'view' | 'manage') =>
    async (request: FastifyRequest, reply: FastifyReply) => {
      const currentUser = await requireCurrentUser(request as AppRequest, reply);
      if (!currentUser) {
        return;
      }

      const featureKey =
        (request.params as { featureKey?: string } | undefined)?.featureKey?.trim() ?? '';
      const allowed =
        mode === 'view'
          ? canViewWorkspaceFeature(currentUser.role, featureKey)
          : canManageWorkspaceFeature(currentUser.role, featureKey);

      if (allowed) {
        return;
      }

      db.recordAuditLog({
        action: 'unauthorized_access',
        targetType: 'workspace',
        targetId: featureKey || sanitizeUrlForLog(request.url),
        detail: `${currentUser.displayName} 尝试${mode === 'view' ? '查看' : '操作'}工作台模${featureKey}。`,
        result: 'blocked',
        operator: currentUser,
        ipAddress: resolveRequestIp(request),
      });
      reply.code(403).send({ message: '当前账号无权访问该模块' });
    };

  const ensurePrivilegedWriteAllowed = (
    request: FastifyRequest,
    reply: FastifyReply,
    currentUser: SystemUserRecord,
    actionLabel: string,
  ) => {
    const limited = hitRateLimit(
      `privileged:${currentUser.id}`,
      runtimeConfig.privilegedWriteLimit,
      runtimeConfig.privilegedWriteWindowMinutes,
    );
    if (limited.allowed) {
      return true;
    }

    db.recordAuditLog({
      action: 'rate_limited',
      targetType: 'security',
      targetId: sanitizeUrlForLog(request.url),
      detail: `${currentUser.displayName} 触发高风险写操作限流{actionLabel}。`,
      result: 'blocked',
      operator: currentUser,
      ipAddress: resolveRequestIp(request),
    });
    reply.code(429).send({ message: '操作过于频繁，请稍后再试' });
    return false;
  };

  const buildStoreAuthSessionLiveSnapshot = (sessionId: string) => {
    const sessionDetail = db.getStoreAuthSessionDetail(sessionId);
    if (!sessionDetail) {
      return null;
    }

    return {
      sessionId,
      sessionDetail,
      qrSession: xianyuWebSessionService.xianyuQrLoginManager.getByAuthSessionId(sessionId),
      credentialEvents: db.getStoreCredentialEventsBySession(sessionId)?.events ?? [],
    };
  };

  const publishStoreAuthSessionLiveSnapshot = (sessionId: string) => {
    const snapshot = buildStoreAuthSessionLiveSnapshot(sessionId);
    if (!snapshot) {
      return;
    }

    storeAuthLiveStreamManager.publishSnapshot(sessionId, snapshot);
  };

  const unsubscribeQrLoginSnapshots = xianyuWebSessionService.xianyuQrLoginManager.subscribe(
    (snapshot) => {
      publishStoreAuthSessionLiveSnapshot(snapshot.authSessionId);
    },
  );

  const processStoreAuthProviderCallback = async (
    request: FastifyRequest,
    reply: FastifyReply,
    input: {
      operator?: SystemUserRecord | null;
      sourceLabel: string;
    },
  ) => {
    const params = z.object({ sessionId: z.string().uuid() }).parse(request.params);
    const body = storeAuthProviderCallbackSchema.parse(request.body);
    const payload = db.receiveStoreAuthProviderCallback({
      sessionId: params.sessionId,
      accessToken: body.accessToken,
      tokenType: body.tokenType ?? null,
      expiresInSeconds: body.expiresInSeconds ?? null,
      state: body.state,
      rawCallback: body.rawCallback,
    });

    if (!payload.accepted) {
      db.recordAuditLog({
        action: 'store_auth_provider_callback_received',
        targetType: 'store_auth_session',
        targetId: params.sessionId,
        detail: `${input.sourceLabel} 接收店铺真实授权回调失败：${payload.message}`,
        result: 'failure',
        operator: input.operator ?? undefined,
        ipAddress: resolveRequestIp(request),
      });
      return reply.code(payload.statusCode).send({ message: payload.message });
    }

    db.recordAuditLog({
      action: 'store_auth_provider_callback_received',
      targetType: 'store_auth_session',
      targetId: params.sessionId,
      detail: `${input.sourceLabel} 接收并保存了店铺真实授权回调。`,
      result: 'success',
      operator: input.operator ?? undefined,
      ipAddress: resolveRequestIp(request),
    });
    publishStoreAuthSessionLiveSnapshot(params.sessionId);
    return payload;
  };

  await app.register(cors, {
    origin: runtimeConfig.runtimeMode === 'demo',
    credentials: true,
  });

  await app.register(jwt, {
    secret: runtimeConfig.jwtSecret,
    sign: {
      expiresIn: `${runtimeConfig.jwtExpiresMinutes}m`,
    },
  });

  app.addHook('onRequest', async (request, reply) => {
    const appRequest = request as AppRequest;
    appRequest.requestStartedAt = metrics.startRequest();
    reply.header('x-request-id', request.id);
  });

  app.addHook('onResponse', async (request, reply) => {
    const appRequest = request as AppRequest;
    const startedAt = appRequest.requestStartedAt;
    if (!startedAt) {
      return;
    }

    const route = resolveRouteLabel(request);
    const { durationSeconds } = metrics.finishRequest({
      method: request.method,
      route,
      statusCode: reply.statusCode,
      startedAt,
    });

    if (!runtimeConfig.requestLoggingEnabled) {
      return;
    }

    const logPayload = summarizeRequestForLog({
      request,
      reply,
      route,
      durationSeconds,
    });
    if (reply.statusCode >= 500) {
      logger.error('http_request', '请求处理失败', logPayload);
      return;
    }
    if (reply.statusCode >= 400) {
      logger.warn('http_request', '请求处理完成', logPayload);
      return;
    }
    logger.info('http_request', '请求处理完成', logPayload);
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({ message: '请求参数不合法' });
    }

    const statusCode =
      typeof (error as { statusCode?: number }).statusCode === 'number'
        ? Number((error as { statusCode?: number }).statusCode)
        : 500;

    logger[statusCode >= 500 ? 'error' : 'warn'](
      'request_error',
      statusCode >= 500 ? '接口处理异常' : '接口请求被拒绝',
      {
        requestId: request.id,
        method: request.method,
        url: sanitizeUrlForLog(request.url),
        statusCode,
        errorMessage: error instanceof Error ? error.message : 'unknown',
      },
    );

    if (statusCode >= 500) {
      return reply.code(500).send({ message: '服务暂时不可用，请稍后重试' });
    }

    const safeMessage = error instanceof Error ? error.message : '请求处理失败';
    return reply.code(statusCode).send({ message: safeMessage || '请求处理失败' });
  });

  // ── 数据库定时自动备份（每 6 小时）──────────────────────
  const AUTO_BACKUP_INTERVAL_MS = 6 * 60 * 60 * 1000;
  let autoBackupTimer: ReturnType<typeof setInterval> | null = null;

  if (runtimeConfig.runtimeMode !== 'demo' && !process.env.VITEST) {
    const runAutoBackup = () => {
      try {
        const result = createSqliteBackup({
          sourceDbPath: runtimeConfig.dbPath,
          outputDir: runtimeConfig.backupDir,
          prefix: 'auto',
        });
        logger.info('auto_backup_success', '数据库自动备份完成', {
          fileName: result.fileName,
          fileSize: result.fileSize,
        });
      } catch (backupError) {
        logger.error('auto_backup_failed', '数据库自动备份失败', {
          message: backupError instanceof Error ? backupError.message : 'unknown',
        });
      }
    };

    // 启动后延迟 5 分钟执行第一次备份，之后每 6 小时一次
    setTimeout(() => {
      runAutoBackup();
      autoBackupTimer = setInterval(runAutoBackup, AUTO_BACKUP_INTERVAL_MS);
    }, 5 * 60 * 1000);

    logger.info('auto_backup_scheduled', '已启用数据库定时备份', {
      intervalHours: 6,
      backupRoot: runtimeConfig.backupDir,
    });
  }

  app.addHook('onClose', async () => {
    autoAiServiceSyncStopped = true;
    if (autoAiServiceSyncTimer) {
      clearTimeout(autoAiServiceSyncTimer);
      autoAiServiceSyncTimer = null;
    }
    if (autoBackupTimer) {
      clearInterval(autoBackupTimer);
      autoBackupTimer = null;
    }
    unsubscribeQrLoginSnapshots();
    storeAuthLiveStreamManager.closeAll();
    logger.info('app_shutdown', '应用实例已关闭', { dbPath: runtimeConfig.dbPath });
    db.close();
  });

  const authorizeMetricsAccess = async (request: FastifyRequest, reply: FastifyReply) => {
    if (!runtimeConfig.metricsEnabled) {
      reply.code(404).send({ message: '指标接口未启用' });
      return false;
    }

    const configuredToken = runtimeConfig.metricsToken?.trim();
    if (configuredToken) {
      const requestToken =
        typeof request.headers['x-metrics-token'] === 'string'
          ? request.headers['x-metrics-token'].trim()
          : '';
      if (requestToken === configuredToken) {
        return true;
      }

      db.recordAuditLog({
        action: 'unauthorized_access',
        targetType: 'metrics',
        targetId: sanitizeUrlForLog(request.url),
        detail: '指标接口令牌校验失败。',
        result: 'blocked',
        ipAddress: resolveRequestIp(request),
      });
      reply.code(401).send({ message: '指标访问令牌无效' });
      return false;
    }

    const currentUser = await requireCurrentUser(request as AppRequest, reply);
    if (!currentUser) {
      return false;
    }

    if (currentUser.role !== 'admin') {
      db.recordAuditLog({
        action: 'unauthorized_access',
        targetType: 'metrics',
        targetId: sanitizeUrlForLog(request.url),
        detail: `${currentUser.displayName} 尝试访问指标接口。`,
        result: 'blocked',
        operator: currentUser,
        ipAddress: resolveRequestIp(request),
      });
      reply.code(403).send({ message: '仅管理员可访问指标接口' });
      return false;
    }

    return true;
  };

  app.get('/api/health', async () => ({
    status: 'ok',
    service: 'goofish-sale-statistics',
    version: APP_VERSION,
    runtimeMode,
    timestamp: new Date().toISOString(),
  }));

  app.get('/api/metrics', async (request, reply) => {
    const allowed = await authorizeMetricsAccess(request, reply);
    if (!allowed) {
      return;
    }

    const payload = metrics.renderPrometheus({
      config: runtimeConfig,
      version: APP_VERSION,
      healthSnapshot: db.getSystemHealthSnapshot(),
    });

    reply.header('content-type', 'text/plain; version=0.0.4; charset=utf-8');
    return reply.send(payload);
  });

  app.post('/api/auth/login', async (request, reply) => {
    const payload = loginSchema.parse(request.body);
    const requestIp = resolveRequestIp(request);
    const limited = hitRateLimit(
      `login:${requestIp}`,
      runtimeConfig.loginMaxAttempts,
      runtimeConfig.loginWindowMinutes,
    );
    if (!limited.allowed) {
      db.recordAuditLog({
        action: 'rate_limited',
        targetType: 'auth',
        targetId: payload.username,
        detail: `登录限流触发，用户名 ${payload.username}。`,
        result: 'blocked',
        ipAddress: requestIp,
      });
      return reply.code(429).send({ message: '登录尝试过于频繁，请稍后再试' });
    }

    const user = db.getUserByUsername(payload.username);
    if (!user || !comparePassword(payload.password, user.passwordHash ?? '')) {
      db.recordAuditLog({
        action: 'login_failure',
        targetType: 'auth',
        targetId: payload.username,
        detail: `用户${payload.username} 登录失败。`,
        result: 'failure',
        ipAddress: requestIp,
      });
      return reply.code(401).send({ message: '用户名或密码错误' });
    }

    // 自动迁移旧格式 (sha256) 密码哈希到新格式 (scrypt)
    if (user.passwordHash && needsPasswordRehash(user.passwordHash)) {
      try {
        const newHash = hashPassword(payload.password);
        db.updateUserPasswordHash(user.id, newHash);
        logger.info('password_rehash', '已自动将用户密码升级为 scrypt 哈希', {
          userId: user.id,
          username: user.username,
        });
      } catch (rehashError) {
        logger.warn('password_rehash_failed', '密码哈希迁移失败（不影响登录）', {
          userId: user.id,
          message: rehashError instanceof Error ? rehashError.message : 'unknown',
        });
      }
    }

    if (user.status !== 'active') {
      db.recordAuditLog({
        action: 'login_failure',
        targetType: 'user',
        targetId: String(user.id),
        detail: `停用账号 ${user.username} 尝试登录。`,
        result: 'blocked',
        operator: user,
        ipAddress: requestIp,
      });
      return reply.code(403).send({ message: '当前账号已停用' });
    }

    db.touchUserLastLogin(user.id);
    db.recordAuditLog({
      action: 'login_success',
      targetType: 'user',
      targetId: String(user.id),
      detail: `${user.displayName} 登录后台成功。`,
      result: 'success',
      operator: user,
      ipAddress: requestIp,
    });

    return createAuthSession(request, reply, db.getUserById(user.id) ?? user);
  });

  app.post('/api/auth/refresh', { preHandler: [authenticate] }, async (request, reply) => {
    const currentUser = (request as AppRequest).currentUser;
    if (!currentUser) {
      return reply.code(401).send({ message: '登录已失效，请重新登录' });
    }

    db.recordAuditLog({
      action: 'token_refresh',
      targetType: 'auth',
      targetId: String(currentUser.id),
      detail: `${currentUser.displayName} 已完成令牌续期。`,
      result: 'success',
      operator: currentUser,
      ipAddress: resolveRequestIp(request),
    });

    return createAuthSession(request, reply, currentUser);
  });

  app.post('/api/auth/logout', async (request, reply) => {
    const authToken = resolveRequestAuthToken(request);
    if (authToken) {
      try {
        const tokenPayload = await app.jwt.verify<{ sub?: number | string; ver?: number }>(authToken);
        const userId = Number(tokenPayload.sub ?? 0);
        const user = userId ? db.getUserById(userId) : null;
        if (user && Number(tokenPayload.ver ?? 0) === (user.tokenVersion ?? 0)) {
          db.bumpUserTokenVersion(user.id);
          db.recordAuditLog({
            action: 'logout_success',
            targetType: 'auth',
            targetId: String(user.id),
            detail: `${user.displayName} 已退出后台登录。`,
            result: 'success',
            operator: user,
            ipAddress: resolveRequestIp(request),
          });
        }
      } catch {
        // 无效或过期令牌不阻断登出；仍继续清理浏览器 Cookie。
      }
    }

    reply.header('set-cookie', buildExpiredAuthCookie(request, runtimeConfig.trustProxy));
    return { success: true };
  });

  app.get('/api/auth/profile', { preHandler: [authenticate] }, async (request) => ({
    user: sanitizeUser((request as AppRequest).currentUser!),
  }));

  // ── 修改密码 ────────────────────────────────────────────
  app.post(
    '/api/auth/change-password',
    { preHandler: [authenticate] },
    async (request, reply) => {
      const currentUser = (request as AppRequest).currentUser!;
      const payload = changePasswordSchema.parse(request.body);

      const user = db.getUserById(currentUser.id);
      if (!user || !comparePassword(payload.currentPassword, user.passwordHash ?? '')) {
        return reply.code(400).send({ message: '当前密码不正确' });
      }

      if (payload.currentPassword === payload.newPassword) {
        return reply.code(400).send({ message: '新密码不能与当前密码相同' });
      }

      const newHash = hashPassword(payload.newPassword);
      db.updateUserPasswordHash(currentUser.id, newHash);

      db.recordAuditLog({
        action: 'password_changed',
        targetType: 'user',
        targetId: String(currentUser.id),
        detail: `用户 ${currentUser.username} 修改了密码。`,
        result: 'success',
        operator: currentUser,
        ipAddress: resolveRequestIp(request),
      });

      logger.info('password_changed', '用户成功修改密码', {
        userId: currentUser.id,
        username: currentUser.username,
      });

      return { success: true, message: '密码已更新，下次登录请使用新密码。' };
    },
  );


  app.get(
    '/api/system/users',
    { preHandler: [authorizeRoles(routeAccessPolicy.manageUsers, 'user', '账号管理列表')] },
    async () => ({
      list: db.listSystemUsers().map((row) => sanitizeUser(row)),
    }),
  );

  app.post(
    '/api/system/users',
    { preHandler: [authorizeRoles(routeAccessPolicy.manageUsers, 'user', '创建账号')] },
    async (request, reply) => {
      const currentUser = (request as AppRequest).currentUser!;
      if (!ensurePrivilegedWriteAllowed(request, reply, currentUser, '创建账号')) {
        return;
      }

      try {
        const body = systemUserCreateSchema.parse(request.body);
        const createdUser = db.createSystemUser(body);
        db.recordAuditLog({
          action: 'user_created',
          targetType: 'user',
          targetId: String(createdUser?.id ?? ''),
          detail: `${currentUser.displayName} 创建账号 ${body.username}，角${body.role}。`,
          result: 'success',
          operator: currentUser,
          ipAddress: resolveRequestIp(request),
        });
        return { user: createdUser ? sanitizeUser(createdUser) : null };
      } catch (error) {
        const message = error instanceof Error ? error.message : '创建账号失败';
        db.recordAuditLog({
          action: 'user_created',
          targetType: 'user',
          detail: `${currentUser.displayName} 创建账号失败{message}`,
          result: 'failure',
          operator: currentUser,
          ipAddress: resolveRequestIp(request),
        });
        return reply.code(400).send({ message });
      }
    },
  );

  app.post(
    '/api/system/users/:userId/role',
    { preHandler: [authorizeRoles(routeAccessPolicy.manageUsers, 'user', '修改账号角色')] },
    async (request, reply) => {
      const currentUser = (request as AppRequest).currentUser!;
      if (!ensurePrivilegedWriteAllowed(request, reply, currentUser, '修改账号角色')) {
        return;
      }

      const params = z.object({ userId: z.coerce.number().int().positive() }).parse(request.params);
      const body = systemUserRoleSchema.parse(request.body);

      try {
        const updatedUser = db.updateSystemUserRole(params.userId, body.role);
        db.recordAuditLog({
          action: 'user_role_updated',
          targetType: 'user',
          targetId: String(params.userId),
          detail: `${currentUser.displayName} 将账号角色调整为 ${body.role}。`,
          result: 'success',
          operator: currentUser,
          ipAddress: resolveRequestIp(request),
        });
        return { user: updatedUser ? sanitizeUser(updatedUser) : null };
      } catch (error) {
        const message = error instanceof Error ? error.message : '修改角色失败';
        db.recordAuditLog({
          action: 'user_role_updated',
          targetType: 'user',
          targetId: String(params.userId),
          detail: `${currentUser.displayName} 修改账号角色失败{message}`,
          result: 'failure',
          operator: currentUser,
          ipAddress: resolveRequestIp(request),
        });
        return reply.code(400).send({ message });
      }
    },
  );

  app.post(
    '/api/system/users/:userId/status',
    { preHandler: [authorizeRoles(routeAccessPolicy.manageUsers, 'user', '修改账号状')] },
    async (request, reply) => {
      const currentUser = (request as AppRequest).currentUser!;
      if (!ensurePrivilegedWriteAllowed(request, reply, currentUser, '修改账号状')) {
        return;
      }

      const params = z.object({ userId: z.coerce.number().int().positive() }).parse(request.params);
      const body = systemUserStatusSchema.parse(request.body);

      try {
        const updatedUser = db.updateSystemUserStatus(params.userId, body.status as SystemUserStatus);
        db.recordAuditLog({
          action: 'user_status_updated',
          targetType: 'user',
          targetId: String(params.userId),
          detail: `${currentUser.displayName} 将账号状态调整为 ${body.status}。`,
          result: 'success',
          operator: currentUser,
          ipAddress: resolveRequestIp(request),
        });
        return { user: updatedUser ? sanitizeUser(updatedUser) : null };
      } catch (error) {
        const message = error instanceof Error ? error.message : '修改账号状态失败';
        db.recordAuditLog({
          action: 'user_status_updated',
          targetType: 'user',
          targetId: String(params.userId),
          detail: `${currentUser.displayName} 修改账号状态失败：${message}`,
          result: 'failure',
          operator: currentUser,
          ipAddress: resolveRequestIp(request),
        });
        return reply.code(400).send({ message });
      }
    },
  );

  app.post(
    '/api/system/secure-settings/:settingKey',
    {
      preHandler: [
        authorizeRoles(routeAccessPolicy.manageSecureSettings, 'security', '更新敏感配置'),
      ],
    },
    async (request, reply) => {
      const currentUser = (request as AppRequest).currentUser!;
      if (!ensurePrivilegedWriteAllowed(request, reply, currentUser, '更新敏感配置')) {
        return;
      }

      const params = z
        .object({
          settingKey: z
            .string()
            .min(2)
            .max(60)
            .regex(/^[a-zA-Z0-9._-]+$/, '配置键名不合法'),
        })
        .parse(request.params);
      const body = secureSettingUpsertSchema.parse(request.body);

      const setting = db.upsertSecureSetting(
        params.settingKey,
        body.description,
        body.value,
        currentUser.id,
      );
      db.recordAuditLog({
        action: 'secure_setting_updated',
        targetType: 'security',
        targetId: params.settingKey,
        detail: `${currentUser.displayName} 更新了敏感配${params.settingKey}，仅保留脱敏${setting.maskedValue}。`,
        result: 'success',
        operator: currentUser,
        ipAddress: resolveRequestIp(request),
      });

      return { setting };
    },
  );

  app.get('/api/options', { preHandler: [authenticate] }, async () => db.getFilterOptions());

  app.get(
    '/api/dashboard',
    { preHandler: [authorizeRoles(routeAccessPolicy.dashboard, 'dashboard', '查看统计面板')] },
    async (request) => {
      const query = baseFilterSchema.parse(request.query);
      return db.getDashboard(query);
    },
  );

  app.get(
    '/api/reports',
    { preHandler: [authorizeRoles(routeAccessPolicy.reports, 'reports', '查看经营报表')] },
    async (request) => {
      const query = baseFilterSchema.parse(request.query);
      return db.getBusinessReports(query);
    },
  );

  app.get(
    '/api/reports/export',
    { preHandler: [authorizeRoles(routeAccessPolicy.reports, 'reports', '导出经营报表')] },
    async (request, reply) => {
      const currentUser = (request as AppRequest).currentUser!;
      const query = baseFilterSchema.parse(request.query);
      const csv = db.exportBusinessReportsCsv(query);

      db.recordAuditLog({
        action: 'reports_exported',
        targetType: 'reports',
        targetId: 'csv',
        detail: `${currentUser.displayName} 导出了经营报CSV。`,
        result: 'success',
        operator: currentUser,
        ipAddress: resolveRequestIp(request),
      });

      reply.header('Content-Type', 'text/csv; charset=utf-8');
      reply.header('Content-Disposition', 'attachment; filename="business-report.csv"');
      return `\uFEFF${csv}`;
    },
  );

  app.get(
    '/api/orders/overview',
    { preHandler: [authorizeRoles(routeAccessPolicy.orders, 'orders', '查看订单概览')] },
    async (request) => {
      const query = baseFilterSchema.parse(request.query);
      return db.getOrdersOverview(query);
    },
  );

  app.get(
    '/api/orders',
    { preHandler: [authorizeRoles(routeAccessPolicy.orders, 'orders', '查看订单列表')] },
    async (request) => {
      const query = listQuerySchema.parse(request.query);
      return db.getOrdersList(query, { page: query.page, pageSize: query.pageSize });
    },
  );

  app.get(
    '/api/orders/:orderId',
    { preHandler: [authorizeRoles(routeAccessPolicy.orders, 'orders', '查看订单详情')] },
    async (request, reply) => {
      const params = z.object({ orderId: z.coerce.number().int().positive() }).parse(request.params);
      const payload = db.getOrderDetail(params.orderId);
      if (!payload) {
        return reply.code(404).send({ message: '订单不存在' });
      }
      return payload;
    },
  );

  app.get(
    '/api/orders/workbench/fulfillment',
    { preHandler: [authorizeRoles(routeAccessPolicy.orders, 'orders', '查看履约工作')] },
    async (request) => {
      const query = baseFilterSchema.parse(request.query);
      return db.getOrderFulfillmentWorkbench(query);
    },
  );

  app.post(
    '/api/orders/:orderId/fulfillment/retry',
    { preHandler: [authorizeRoles(routeAccessPolicy.manageFulfillment, 'orders', '重试履约任务')] },
    async (request, reply) => {
      const currentUser = (request as AppRequest).currentUser!;
      if (!ensurePrivilegedWriteAllowed(request, reply, currentUser, '重试履约任务')) {
        return;
      }

      const params = z.object({ orderId: z.coerce.number().int().positive() }).parse(request.params);
      const payload = db.retryOrderFulfillment(params.orderId);
      if (!payload) {
        db.recordAuditLog({
          action: 'fulfillment_retried',
          targetType: 'order',
          targetId: String(params.orderId),
          detail: `${currentUser.displayName} 重试履约失败，订单不支持该动作。`,
          result: 'failure',
          operator: currentUser,
          ipAddress: resolveRequestIp(request),
        });
        return reply.code(404).send({ message: '订单不存在或当前状态不可重试' });
      }

      db.recordAuditLog({
        action: 'fulfillment_retried',
        targetType: 'order',
        targetId: String(params.orderId),
        detail: `${currentUser.displayName} 重试了订单履约。`,
        result: 'success',
        operator: currentUser,
        ipAddress: resolveRequestIp(request),
      });
      return payload;
    },
  );

  app.post(
    '/api/orders/:orderId/fulfillment/resend',
    { preHandler: [authorizeRoles(routeAccessPolicy.manageFulfillment, 'orders', '补发履约结果')] },
    async (request, reply) => {
      const currentUser = (request as AppRequest).currentUser!;
      if (!ensurePrivilegedWriteAllowed(request, reply, currentUser, '补发履约结果')) {
        return;
      }

      const params = z.object({ orderId: z.coerce.number().int().positive() }).parse(request.params);
      const payload = db.resendOrderFulfillment(params.orderId);
      if (!payload) {
        db.recordAuditLog({
          action: 'fulfillment_resent',
          targetType: 'order',
          targetId: String(params.orderId),
          detail: `${currentUser.displayName} 补发履约失败，订单不支持该动作。`,
          result: 'failure',
          operator: currentUser,
          ipAddress: resolveRequestIp(request),
        });
        return reply.code(404).send({ message: '订单不存在或当前状态不可补发' });
      }

      db.recordAuditLog({
        action: 'fulfillment_resent',
        targetType: 'order',
        targetId: String(params.orderId),
        detail: `${currentUser.displayName} 执行了订单补发。`,
        result: 'success',
        operator: currentUser,
        ipAddress: resolveRequestIp(request),
      });
      return payload;
    },
  );

  app.post(
    '/api/orders/:orderId/fulfillment/terminate',
    { preHandler: [authorizeRoles(routeAccessPolicy.manageFulfillment, 'orders', '终止履约')] },
    async (request, reply) => {
      const currentUser = (request as AppRequest).currentUser!;
      if (!ensurePrivilegedWriteAllowed(request, reply, currentUser, '终止履约')) {
        return;
      }

      const params = z.object({ orderId: z.coerce.number().int().positive() }).parse(request.params);
      const body = fulfillmentReasonSchema.parse(request.body ?? {});
      const payload = db.terminateOrderFulfillment(
        params.orderId,
        body.reason,
        currentUser.displayName,
      );
      if (!payload) {
        db.recordAuditLog({
          action: 'fulfillment_terminated',
          targetType: 'order',
          targetId: String(params.orderId),
          detail: `${currentUser.displayName} 终止履约失败，订单不存在或已关闭。`,
          result: 'failure',
          operator: currentUser,
          ipAddress: resolveRequestIp(request),
        });
        return reply.code(404).send({ message: '订单不存在或当前状态不可终止' });
      }

      db.recordAuditLog({
        action: 'fulfillment_terminated',
        targetType: 'order',
        targetId: String(params.orderId),
        detail: `${currentUser.displayName} 终止了订单履约，原因{body.reason}。`,
        result: 'success',
        operator: currentUser,
        ipAddress: resolveRequestIp(request),
      });
      return payload;
    },
  );

  app.post(
    '/api/orders/:orderId/fulfillment/note',
    { preHandler: [authorizeRoles(routeAccessPolicy.manageFulfillment, 'orders', '记录履约备注')] },
    async (request, reply) => {
      const currentUser = (request as AppRequest).currentUser!;
      if (!ensurePrivilegedWriteAllowed(request, reply, currentUser, '记录履约备注')) {
        return;
      }

      const params = z.object({ orderId: z.coerce.number().int().positive() }).parse(request.params);
      const body = fulfillmentNoteSchema.parse(request.body ?? {});
      const payload = db.noteOrderFulfillment(params.orderId, body.note, currentUser.displayName);
      if (!payload) {
        db.recordAuditLog({
          action: 'fulfillment_noted',
          targetType: 'order',
          targetId: String(params.orderId),
          detail: `${currentUser.displayName} 记录履约备注失败，订单不存在。`,
          result: 'failure',
          operator: currentUser,
          ipAddress: resolveRequestIp(request),
        });
        return reply.code(404).send({ message: '订单不存在' });
      }

      db.recordAuditLog({
        action: 'fulfillment_noted',
        targetType: 'order',
        targetId: String(params.orderId),
        detail: `${currentUser.displayName} 更新了订单履约备注。`,
        result: 'success',
        operator: currentUser,
        ipAddress: resolveRequestIp(request),
      });
      return payload;
    },
  );

  app.get(
    '/api/after-sales/workbench',
    { preHandler: [authorizeRoles(routeAccessPolicy.afterSale, 'after-sale', '查看售后工作')] },
    async (request) => {
      const query = baseFilterSchema.parse(request.query);
      return db.getAfterSaleWorkbench(query);
    },
  );

  app.get(
    '/api/after-sales',
    { preHandler: [authorizeRoles(routeAccessPolicy.afterSale, 'after-sale', '查看售后列表')] },
    async (request) => {
      const query = listQuerySchema.parse(request.query);
      return db.getAfterSaleCases(query, query);
    },
  );

  app.get(
    '/api/after-sales/:caseId',
    { preHandler: [authorizeRoles(routeAccessPolicy.afterSale, 'after-sale', '查看售后详情')] },
    async (request, reply) => {
      const params = z.object({ caseId: z.coerce.number().int().positive() }).parse(request.params);
      const payload = db.getAfterSaleDetail(params.caseId);
      if (!payload) {
        return reply.code(404).send({ message: '售后单不存在' });
      }
      return payload;
    },
  );

  app.post(
    '/api/after-sales/:caseId/refund/review',
    { preHandler: [authorizeRoles(routeAccessPolicy.manageAfterSale, 'after-sale', '处理退款售')] },
    async (request, reply) => {
      const currentUser = (request as AppRequest).currentUser!;
      if (!ensurePrivilegedWriteAllowed(request, reply, currentUser, '处理退款售')) {
        return;
      }

      const params = z.object({ caseId: z.coerce.number().int().positive() }).parse(request.params);
      const body = afterSaleRefundActionSchema.parse(request.body ?? {});
      const payload = db.reviewAfterSaleRefund(
        params.caseId,
        body.decision,
        body.approvedAmount,
        body.note,
        currentUser.displayName,
      );
      if (!payload) {
        db.recordAuditLog({
          action: 'after_sale_refund_reviewed',
          targetType: 'after_sale',
          targetId: String(params.caseId),
          detail: `${currentUser.displayName} 处理退款售后失败，售后单不存在或状态不允许当前动作。`,
          result: 'failure',
          operator: currentUser,
          ipAddress: resolveRequestIp(request),
        });
        return reply.code(404).send({ message: '售后单不存在或当前状态不允许该动作' });
      }

      db.recordAuditLog({
        action: 'after_sale_refund_reviewed',
        targetType: 'after_sale',
        targetId: String(params.caseId),
        detail: `${currentUser.displayName} 执行退款售后动作：${body.decision}。`,
        result: 'success',
        operator: currentUser,
        ipAddress: resolveRequestIp(request),
      });
      return payload;
    },
  );

  app.post(
    '/api/after-sales/:caseId/resend/execute',
    { preHandler: [authorizeRoles(routeAccessPolicy.manageAfterSale, 'after-sale', '处理补发售后')] },
    async (request, reply) => {
      const currentUser = (request as AppRequest).currentUser!;
      if (!ensurePrivilegedWriteAllowed(request, reply, currentUser, '处理补发售后')) {
        return;
      }

      const params = z.object({ caseId: z.coerce.number().int().positive() }).parse(request.params);
      const body = afterSaleResendActionSchema.parse(request.body ?? {});
      const payload = db.executeAfterSaleResend(
        params.caseId,
        body.decision,
        body.note,
        currentUser.displayName,
      );
      if (!payload) {
        db.recordAuditLog({
          action: 'after_sale_resend_executed',
          targetType: 'after_sale',
          targetId: String(params.caseId),
          detail: `${currentUser.displayName} 处理补发售后失败，售后单不存在或状态不允许当前动作。`,
          result: 'failure',
          operator: currentUser,
          ipAddress: resolveRequestIp(request),
        });
        return reply.code(404).send({ message: '售后单不存在或当前状态不允许该动作' });
      }

      db.recordAuditLog({
        action: 'after_sale_resend_executed',
        targetType: 'after_sale',
        targetId: String(params.caseId),
        detail: `${currentUser.displayName} 执行补发售后动作{body.decision}。`,
        result: 'success',
        operator: currentUser,
        ipAddress: resolveRequestIp(request),
      });
      return payload;
    },
  );

  app.post(
    '/api/after-sales/:caseId/dispute/conclude',
    { preHandler: [authorizeRoles(routeAccessPolicy.manageAfterSale, 'after-sale', '登记争议结论')] },
    async (request, reply) => {
      const currentUser = (request as AppRequest).currentUser!;
      if (!ensurePrivilegedWriteAllowed(request, reply, currentUser, '登记争议结论')) {
        return;
      }

      const params = z.object({ caseId: z.coerce.number().int().positive() }).parse(request.params);
      const body = afterSaleDisputeActionSchema.parse(request.body ?? {});
      const payload = db.concludeAfterSaleDispute(
        params.caseId,
        body.decision,
        body.note,
        body.compensationAmount,
        currentUser.displayName,
      );
      if (!payload) {
        db.recordAuditLog({
          action: 'after_sale_dispute_concluded',
          targetType: 'after_sale',
          targetId: String(params.caseId),
          detail: `${currentUser.displayName} 登记争议结论失败，售后单不存在或状态不允许当前动作。`,
          result: 'failure',
          operator: currentUser,
          ipAddress: resolveRequestIp(request),
        });
        return reply.code(404).send({ message: '售后单不存在或当前状态不允许该动作' });
      }

      db.recordAuditLog({
        action: 'after_sale_dispute_concluded',
        targetType: 'after_sale',
        targetId: String(params.caseId),
        detail: `${currentUser.displayName} 登记争议结论{body.decision}。`,
        result: 'success',
        operator: currentUser,
        ipAddress: resolveRequestIp(request),
      });
      return payload;
    },
  );

  app.post(
    '/api/after-sales/:caseId/note',
    { preHandler: [authorizeRoles(routeAccessPolicy.manageAfterSale, 'after-sale', '记录售后备注')] },
    async (request, reply) => {
      const currentUser = (request as AppRequest).currentUser!;
      if (!ensurePrivilegedWriteAllowed(request, reply, currentUser, '记录售后备注')) {
        return;
      }

      const params = z.object({ caseId: z.coerce.number().int().positive() }).parse(request.params);
      const body = afterSaleNoteSchema.parse(request.body ?? {});
      const payload = db.noteAfterSaleCase(params.caseId, body.note, currentUser.displayName);
      if (!payload) {
        db.recordAuditLog({
          action: 'after_sale_noted',
          targetType: 'after_sale',
          targetId: String(params.caseId),
          detail: `${currentUser.displayName} 记录售后备注失败，售后单不存在。`,
          result: 'failure',
          operator: currentUser,
          ipAddress: resolveRequestIp(request),
        });
        return reply.code(404).send({ message: '售后单不存在' });
      }

      db.recordAuditLog({
        action: 'after_sale_noted',
        targetType: 'after_sale',
        targetId: String(params.caseId),
        detail: `${currentUser.displayName} 已记录售后备注。`,
        result: 'success',
        operator: currentUser,
        ipAddress: resolveRequestIp(request),
      });
      return payload;
    },
  );

  app.get(
    '/api/orders/export',
    { preHandler: [authorizeRoles(routeAccessPolicy.exportOrders, 'orders', '导出订单报表')] },
    async (request, reply) => {
      const currentUser = (request as AppRequest).currentUser!;
      const query = listQuerySchema.parse(request.query);
      const csv = db.exportOrdersCsv(query);

      db.recordAuditLog({
        action: 'orders_exported',
        targetType: 'orders',
        targetId: 'csv',
        detail: `${currentUser.displayName} 导出了订CSV。`,
        result: 'success',
        operator: currentUser,
        ipAddress: resolveRequestIp(request),
      });

      reply.header('Content-Type', 'text/csv; charset=utf-8');
      reply.header('Content-Disposition', 'attachment; filename="orders-report.csv"');
      return `\uFEFF${csv}`;
    },
  );

  app.post(
    '/api/orders/xianyu-web-sync',
    { preHandler: [authorizeRoles(routeAccessPolicy.manageStores, 'orders', '同步闲鱼真实成交单')] },
    async (request, reply) => {
      const currentUser = (request as AppRequest).currentUser!;
      if (!ensurePrivilegedWriteAllowed(request, reply, currentUser, '同步闲鱼真实成交单')) {
        return;
      }

      const body = xianyuOrderSyncSchema.parse(request.body ?? {});
      const targets = db.listManagedStoreOrderSyncTargets(body.storeIds);
      if (targets.length === 0) {
        return reply.code(409).send({ message: '当前没有可同步的已激活闲鱼网页登录态店铺。' });
      }

      const maxOrdersPerStore = Math.max(1, Math.min(100, Math.trunc(body.maxOrdersPerStore ?? 30)));
      const results: Array<{
        storeId: number;
        shopName: string;
        providerUserId: string;
        success: boolean;
        fetchedCount?: number;
        syncedCount?: number;
        skippedCount?: number;
        failedTradeCount?: number;
        syncedAt?: string;
        message?: string;
      }> = [];

      for (const target of targets) {
        try {
          const fetched = await xianyuWebSessionService.fetchXianyuWebSessionSellerCompletedTrades({
            cookieText: target.cookieText,
            userId: target.providerUserId,
            maxPages: Math.max(1, Math.ceil(maxOrdersPerStore / 20)),
          });
          const selectedTrades = fetched.items.slice(0, maxOrdersPerStore);
          const detailFailures: Array<{ tradeId: string; message: string }> = [];
          const detailedOrders: Array<
            Awaited<ReturnType<typeof xianyuWebSessionService.fetchXianyuWebSessionCompletedOrderDetail>>
          > = [];

          for (const trade of selectedTrades) {
            try {
              const detail = await xianyuWebSessionService.fetchXianyuWebSessionCompletedOrderDetail({
                cookieText: target.cookieText,
                tradeId: trade.tradeId,
              });
              detailedOrders.push(detail);
            } catch (error) {
              detailFailures.push({
                tradeId: trade.tradeId,
                message: error instanceof Error ? error.message : '拉取成交单详情失败',
              });
            }
          }

          if (detailedOrders.length === 0 && selectedTrades.length > 0) {
            results.push({
              storeId: target.storeId,
              shopName: target.shopName,
              providerUserId: target.providerUserId,
              success: false,
              fetchedCount: selectedTrades.length,
              failedTradeCount: detailFailures.length,
              message:
                detailFailures[0]?.message ?? '拉取闲鱼真实成交单失败，未获取到可写入的订单详情。',
            });
            continue;
          }

          const synced = db.syncManagedStoreOrders({
            storeId: target.storeId,
            orders: detailedOrders.map((order) => ({
              orderNo: order.orderNo,
              buyerUserId: order.buyerUserId,
              buyerName: order.buyerName,
              itemId: order.itemId,
              itemTitle: order.itemTitle,
              quantity: order.quantity,
              unitPrice: order.unitPrice,
              paidAmount: order.paidAmount,
              discountAmount: order.discountAmount,
              refundAmount: order.refundAmount,
              paymentNo: order.paymentNo,
              orderStatusName: order.orderStatusName,
              paidAt: order.paidAt,
              shippedAt: order.shippedAt,
              completedAt: order.completedAt,
              events: order.events,
            })),
          });

          if (!synced) {
            results.push({
              storeId: target.storeId,
              shopName: target.shopName,
              providerUserId: target.providerUserId,
              success: false,
              message: '店铺不存在或已被删除。',
            });
            continue;
          }

          results.push({
            storeId: target.storeId,
            shopName: target.shopName,
            providerUserId: target.providerUserId,
            success: true,
            fetchedCount: selectedTrades.length,
            syncedCount: synced.syncedCount,
            skippedCount: synced.skippedCount,
            failedTradeCount: detailFailures.length,
            syncedAt: synced.syncedAt,
            message:
              detailFailures.length > 0 ? `有 ${detailFailures.length} 笔成交单详情拉取失败，已跳过。` : undefined,
          });
        } catch (error) {
          results.push({
            storeId: target.storeId,
            shopName: target.shopName,
            providerUserId: target.providerUserId,
            success: false,
            message: error instanceof Error ? error.message : '同步闲鱼真实成交单失败。',
          });
        }
      }

      const successCount = results.filter((item) => item.success).length;
      db.recordAuditLog({
        action: 'xianyu_orders_synced',
        targetType: 'orders',
        targetId: body.storeIds?.length ? body.storeIds.join(',') : 'all-active-xianyu',
        detail: `${currentUser.displayName} 执行了闲鱼真实成交单同步，成功 ${successCount}/${results.length} 家店铺。`,
        result: successCount > 0 ? 'success' : 'failure',
        operator: currentUser,
        ipAddress: resolveRequestIp(request),
      });

      if (successCount === 0) {
        return reply.code(502).send({
          message: '闲鱼真实成交单同步失败，请检查登录态或风控状态。',
          successCount,
          totalCount: results.length,
          results,
        });
      }

      return {
        successCount,
        totalCount: results.length,
        results,
      };
    },
  );

  app.get(
    '/api/products',
    { preHandler: [authorizeRoles(routeAccessPolicy.products, 'products', '查看商品统计')] },
    async (request) => {
      const query = baseFilterSchema.parse(request.query);
      return db.getProductsView(query);
    },
  );

  app.post(
    '/api/products/xianyu-web-sync',
    { preHandler: [authorizeRoles(routeAccessPolicy.products, 'products', '同步闲鱼商品')] },
    async (request, reply) => {
      const currentUser = (request as AppRequest).currentUser!;
      if (!ensurePrivilegedWriteAllowed(request, reply, currentUser, '同步闲鱼商品')) {
        return;
      }

      const body = xianyuProductSyncSchema.parse(request.body ?? {});
      const targets = db.listManagedStoreProductSyncTargets(body.storeIds);
      if (targets.length === 0) {
        return reply.code(409).send({ message: '当前没有可同步的已激活闲鱼网页登录态店铺。' });
      }

      const results: Array<{
        storeId: number;
        shopName: string;
        providerUserId: string;
        success: boolean;
        fetchedCount?: number;
        syncedCount?: number;
        skippedCount?: number;
        syncedAt?: string;
        message?: string;
      }> = [];

      for (const target of targets) {
        try {
          const fetched = await xianyuWebSessionService.fetchXianyuWebSessionProducts({
            cookieText: target.cookieText,
            userId: target.providerUserId,
          });
          const synced = db.syncManagedStoreProducts({
            storeId: target.storeId,
            items: fetched.items.map((item) => ({
              id: item.id,
              title: item.title,
              categoryLabel: item.categoryLabel,
              price: item.price,
              stock: item.stock,
            })),
          });

          if (!synced) {
            results.push({
              storeId: target.storeId,
              shopName: target.shopName,
              providerUserId: target.providerUserId,
              success: false,
              message: '店铺不存在或已被删除。',
            });
            continue;
          }

          results.push({
            storeId: target.storeId,
            shopName: target.shopName,
            providerUserId: target.providerUserId,
            success: true,
            fetchedCount: fetched.items.length,
            syncedCount: synced.syncedCount,
            skippedCount: synced.skippedCount,
            syncedAt: synced.syncedAt,
          });
        } catch (error) {
          results.push({
            storeId: target.storeId,
            shopName: target.shopName,
            providerUserId: target.providerUserId,
            success: false,
            message: error instanceof Error ? error.message : '同步闲鱼商品失败。',
          });
        }
      }

      const successCount = results.filter((item) => item.success).length;
      db.recordAuditLog({
        action: 'xianyu_products_synced',
        targetType: 'product',
        targetId: body.storeIds?.length ? body.storeIds.join(',') : 'all-active-xianyu',
        detail: `${currentUser.displayName} 执行了闲鱼真实商品同步，成功 ${successCount}/${results.length} 家店铺。`,
        result: successCount > 0 ? 'success' : 'failure',
        operator: currentUser,
        ipAddress: resolveRequestIp(request),
      });

      if (successCount === 0) {
        return reply.code(502).send({
          message: '闲鱼真实商品同步失败，请检查登录态或风控状态。',
          successCount,
          totalCount: results.length,
          results,
        });
      }

      return {
        successCount,
        totalCount: results.length,
        results,
      };
    },
  );

  app.get(
    '/api/customers',
    { preHandler: [authorizeRoles(routeAccessPolicy.customers, 'customers', '查看客户统计')] },
    async (request) => {
      const query = baseFilterSchema.parse(request.query);
      return db.getCustomersView(query);
    },
  );

  app.get(
    '/api/stores/management',
    { preHandler: [authorizeRoles(routeAccessPolicy.stores, 'stores', '查看店铺管理')] },
    async () => db.getStoreManagementOverview(),
  );

  app.post(
    '/api/stores/auth-sessions',
    { preHandler: [authorizeRoles(routeAccessPolicy.manageStores, 'stores', '创建店铺授权')] },
    async (request, reply) => {
      const currentUser = (request as AppRequest).currentUser!;
      if (!ensurePrivilegedWriteAllowed(request, reply, currentUser, '创建店铺授权')) {
        return;
      }

      const body = storeAuthSessionSchema.parse(request.body);
      const payload = db.createStoreAuthSession({
        platform: body.platform,
        source: body.source,
        authType: body.authType,
        storeId: body.storeId,
        createdByUserId: currentUser.id,
      });
      db.recordAuditLog({
        action: 'store_auth_session_created',
        targetType: 'store_auth_session',
        targetId: payload.sessionId,
        detail: body.storeId
          ? `${currentUser.displayName} 为店${body.storeId} 发起了重新授权会话。`
          : `${currentUser.displayName} 发起${body.platform} 店铺授权。`,
        result: 'success',
        operator: currentUser,
        ipAddress: resolveRequestIp(request),
      });
      return payload;
    },
  );

  app.get(
    '/api/stores/auth-sessions/:sessionId',
    { preHandler: [authorizeRoles(routeAccessPolicy.manageStores, 'stores', '查看店铺授权会话')] },
    async (request, reply) => {
      const params = z.object({ sessionId: z.string().uuid() }).parse(request.params);
      const payload = db.getStoreAuthSessionDetail(params.sessionId);
      if (!payload) {
        return reply.code(404).send({ message: '授权会话不存在。' });
      }

      return payload;
    },
  );

  app.post(
    '/api/stores/auth-sessions/:sessionId/complete',
    { preHandler: [authorizeRoles(routeAccessPolicy.manageStores, 'stores', '完成店铺授权')] },
    async (request, reply) => {
      const currentUser = (request as AppRequest).currentUser!;
      if (!ensurePrivilegedWriteAllowed(request, reply, currentUser, '完成店铺授权')) {
        return;
      }

      const params = z.object({ sessionId: z.string().uuid() }).parse(request.params);
      const body = storeAuthCompleteSchema.parse(request.body);
      const payload = db.completeStoreAuthSession(params.sessionId, body, currentUser.id);
      if (!payload) {
        db.recordAuditLog({
          action: 'store_auth_completed',
          targetType: 'store_auth_session',
          targetId: params.sessionId,
          detail: `${currentUser.displayName} 完成店铺授权失败，授权会话不存在。`,
          result: 'failure',
          operator: currentUser,
          ipAddress: resolveRequestIp(request),
        });
        return reply.code(404).send({ message: '授权会话不存在或已失效' });
      }

      db.recordAuditLog({
        action: 'store_auth_completed',
        targetType: 'store',
        targetId: String(payload.storeId),
        detail: payload.reauthorized
          ? `${currentUser.displayName} 完成店铺重新授权，店${payload.shopName} 已恢复授权。`
          : `${currentUser.displayName} 完成店铺授权，店${payload.shopName} 已入库。`,
        result: 'success',
        operator: currentUser,
        ipAddress: resolveRequestIp(request),
      });
      return payload;
    },
  );

  app.post(
    '/api/public/stores/auth-sessions/:sessionId/provider-callback',
    async (request, reply) => {
      // 公共路由限流：每 IP 每分钟最多 5 次回调尝试
      const requestIp = resolveRequestIp(request);
      const limited = hitRateLimit(`provider-callback:${requestIp}`, 5, 1);
      if (!limited.allowed) {
        db.recordAuditLog({
          action: 'rate_limited',
          targetType: 'store_auth_session',
          targetId: (request.params as { sessionId?: string }).sessionId ?? 'unknown',
          detail: `公共授权回调限流触发（${requestIp}）。`,
          result: 'blocked',
          ipAddress: requestIp,
        });
        return reply.code(429).send({ message: '回调请求过于频繁，请稍后再试' });
      }
      return processStoreAuthProviderCallback(request, reply, {
        sourceLabel: '公共授权回调页',
      });
    },
  );

  app.post(
    '/api/stores/auth-sessions/:sessionId/provider-callback',
    { preHandler: [authorizeRoles(routeAccessPolicy.manageStores, 'stores', '接收店铺授权回调')] },
    async (request, reply) => {
      const currentUser = (request as AppRequest).currentUser!;
      if (!ensurePrivilegedWriteAllowed(request, reply, currentUser, '接收店铺授权回调')) {
        return;
      }
      return processStoreAuthProviderCallback(request, reply, {
        operator: currentUser,
        sourceLabel: currentUser.displayName,
      });
    },
  );

  app.post(
    '/api/stores/auth-sessions/:sessionId/profile-sync',
    { preHandler: [authorizeRoles(routeAccessPolicy.manageStores, 'stores', '同步店铺资料')] },
    async (request, reply) => {
      const currentUser = (request as AppRequest).currentUser!;
      if (!ensurePrivilegedWriteAllowed(request, reply, currentUser, '同步店铺资料')) {
        return;
      }

      const params = z.object({ sessionId: z.string().uuid() }).parse(request.params);
      const body = storeAuthProfileSyncSchema.parse(request.body);
      const payload = db.syncStoreAuthSessionProfile(params.sessionId, body, currentUser.id);
      if (!payload) {
        db.recordAuditLog({
          action: 'store_auth_profile_synced',
          targetType: 'store_auth_session',
          targetId: params.sessionId,
          detail: `${currentUser.displayName} 同步店铺资料失败，授权会话不存在。`,
          result: 'failure',
          operator: currentUser,
          ipAddress: resolveRequestIp(request),
        });
        return reply.code(404).send({ message: '授权会话不存在或已失效' });
      }

      db.recordAuditLog({
        action: 'store_auth_profile_synced',
        targetType: 'store',
        targetId: String(payload.storeId),
        detail: `${currentUser.displayName} 完成了店铺资料同步与绑店：${payload.shopName}。`,
        result: 'success',
        operator: currentUser,
        ipAddress: resolveRequestIp(request),
      });
      publishStoreAuthSessionLiveSnapshot(params.sessionId);
      return payload;
    },
  );

  app.post(
    '/api/stores/auth-sessions/:sessionId/web-session-sync',
    { preHandler: [authorizeRoles(routeAccessPolicy.manageStores, 'stores', '录入网页登录态')] },
    async (request, reply) => {
      const currentUser = (request as AppRequest).currentUser!;
      if (!ensurePrivilegedWriteAllowed(request, reply, currentUser, '录入网页登录态')) {
        return;
      }

      const params = z.object({ sessionId: z.string().uuid() }).parse(request.params);
      const body = storeAuthWebSessionSyncSchema.parse(request.body);
      const payload = db.syncStoreAuthSessionWebSession(params.sessionId, body, currentUser.id);
      if (!payload) {
        db.recordAuditLog({
          action: 'store_auth_web_session_synced',
          targetType: 'store_auth_session',
          targetId: params.sessionId,
          detail: `${currentUser.displayName} 录入网页登录态失败，授权会话不存在。`,
          result: 'failure',
          operator: currentUser,
          ipAddress: resolveRequestIp(request),
        });
        return reply.code(404).send({ message: '授权会话不存在或已失效' });
      }

      db.recordAuditLog({
        action: 'store_auth_web_session_synced',
        targetType: 'store',
        targetId: String(payload.storeId),
        detail: payload.reauthorized
          ? `${currentUser.displayName} 完成店铺网页登录态更新，店${payload.shopName} 已恢复接入。`
          : `${currentUser.displayName} 录入网页登录态并完成店铺接入，店${payload.shopName} 已入库。`,
        result: 'success',
        operator: currentUser,
        ipAddress: resolveRequestIp(request),
      });
      publishStoreAuthSessionLiveSnapshot(params.sessionId);
      return payload;
    },
  );

  app.post(
    '/api/stores/auth-sessions/:sessionId/web-session-detect-profile',
    { preHandler: [authorizeRoles(routeAccessPolicy.manageStores, 'stores', '自动探测网页登录态资料')] },
    async (request, reply) => {
      const currentUser = (request as AppRequest).currentUser!;
      if (!ensurePrivilegedWriteAllowed(request, reply, currentUser, '自动探测网页登录态资料')) {
        return;
      }

      const params = z.object({ sessionId: z.string().uuid() }).parse(request.params);
      const body = storeBrowserRenewSchema.parse(request.body ?? {});

      let credential: ReturnType<typeof db.getStoreAuthSessionWebSessionCredential> | null = null;
      try {
        credential = db.getStoreAuthSessionWebSessionCredential(params.sessionId);
      } catch (error) {
        const statusCode =
          error instanceof Error && 'statusCode' in error && typeof error.statusCode === 'number'
            ? error.statusCode
            : 409;
        return reply
          .code(statusCode)
          .send({ message: error instanceof Error ? error.message : '当前会话不支持自动探测网页登录态资料。' });
      }

      if (!credential) {
        return reply.code(404).send({ message: '授权会话不存在或已失效。' });
      }

      try {
        const detected = await xianyuWebSessionService.detectXianyuWebSessionProfileViaBrowser({
          cookieText: credential.cookieText,
          showBrowser: body.showBrowser,
          executablePath: body.executablePath ?? null,
        });

        let verification:
          | Awaited<ReturnType<typeof xianyuWebSessionService.verifyXianyuWebSessionCookie>>
          | null = null;
        const refreshedCookieText =
          detected.cookieText && detected.cookieText !== credential.cookieText ? detected.cookieText : null;

        if (refreshedCookieText) {
          try {
            verification = await xianyuWebSessionService.verifyXianyuWebSessionCookie(refreshedCookieText);
          } catch {
            verification = null;
          }

          db.receiveStoreAuthSessionWebCredential(params.sessionId, {
            cookieText: refreshedCookieText,
            source: 'browser_renew',
            riskLevel: verification?.riskLevel ?? 'pending',
            riskReason: verification?.detail ?? detected.detail,
            verificationUrl: verification?.verificationUrl ?? detected.verificationUrl ?? null,
          });
        }

        db.recordAuditLog({
          action: 'store_auth_web_session_profile_detected',
          targetType: 'store_auth_session',
          targetId: params.sessionId,
          detail: detected.detected
            ? `${currentUser.displayName} 自动探测到了网页登录态资料。`
            : `${currentUser.displayName} 执行了网页登录态资料探测，但未拿到完整资料。`,
          result: detected.detected ? 'success' : 'failure',
          operator: currentUser,
          ipAddress: resolveRequestIp(request),
        });
        publishStoreAuthSessionLiveSnapshot(params.sessionId);

        const { cookieText: _ignoredCookieText, ...detectedSafePayload } = detected;

        return {
          ...detectedSafePayload,
          credentialUpdated: Boolean(refreshedCookieText),
          riskLevel: verification?.riskLevel ?? null,
          verificationUrl: verification?.verificationUrl ?? detected.verificationUrl ?? null,
          rawRet: verification?.rawRet ?? [],
        };
      } catch (error) {
        db.recordAuditLog({
          action: 'store_auth_web_session_profile_detected',
          targetType: 'store_auth_session',
          targetId: params.sessionId,
          detail: `${currentUser.displayName} 自动探测网页登录态资料失败。`,
          result: 'failure',
          operator: currentUser,
          ipAddress: resolveRequestIp(request),
        });
        return reply
          .code(502)
          .send({ message: error instanceof Error ? error.message : '自动探测网页登录态资料失败。' });
      }
    },
  );

  app.post(
    '/api/stores/auth-sessions/:sessionId/qr-login/generate',
    { preHandler: [authorizeRoles(routeAccessPolicy.manageStores, 'stores', '生成闲鱼扫码登录二维码')] },
    async (request, reply) => {
      const currentUser = (request as AppRequest).currentUser!;
      if (!ensurePrivilegedWriteAllowed(request, reply, currentUser, '生成闲鱼扫码登录二维码')) {
        return;
      }

      const params = z.object({ sessionId: z.string().uuid() }).parse(request.params);
      const sessionDetail = db.getStoreAuthSessionDetail(params.sessionId);
      if (!sessionDetail) {
        return reply.code(404).send({ message: '授权会话不存在或已失效' });
      }

      if (
        sessionDetail.platform !== 'xianyu' ||
        sessionDetail.integrationMode !== 'xianyu_web_session'
      ) {
        return reply.code(409).send({ message: '当前会话不支持闲鱼扫码登录' });
      }

      const refreshedWindow = db.refreshStoreAuthSessionWindow(params.sessionId, {
        minutes: 15,
        reviveExpiredWebSession: true,
      });
      if (!refreshedWindow?.refreshed) {
        return reply.code(409).send({ message: '授权会话已失效，请重新发起接入。' });
      }

      try {
        const payload = await xianyuWebSessionService.xianyuQrLoginManager.create(params.sessionId);
        db.recordStoreCredentialEvent({
          sessionId: params.sessionId,
          eventType: 'qr_login_started',
          status: 'info',
          detail: '已生成闲鱼扫码登录二维码，等待扫码确认。',
          source: 'qr_login',
          operatorUserId: currentUser.id,
        });
        db.recordAuditLog({
          action: 'store_auth_qr_login_generated',
          targetType: 'store_auth_session',
          targetId: params.sessionId,
          detail: `${currentUser.displayName} 为授权会话 ${params.sessionId} 生成了闲鱼扫码登录二维码。`,
          result: 'success',
          operator: currentUser,
          ipAddress: resolveRequestIp(request),
        });
        publishStoreAuthSessionLiveSnapshot(params.sessionId);
        return payload;
      } catch (error) {
        db.recordStoreCredentialEvent({
          sessionId: params.sessionId,
          eventType: 'qr_login_started',
          status: 'error',
          detail: error instanceof Error ? error.message : '生成扫码登录二维码失败。',
          source: 'qr_login',
          operatorUserId: currentUser.id,
        });
        db.recordAuditLog({
          action: 'store_auth_qr_login_generated',
          targetType: 'store_auth_session',
          targetId: params.sessionId,
          detail: `${currentUser.displayName} 生成闲鱼扫码登录二维码失败。`,
          result: 'failure',
          operator: currentUser,
          ipAddress: resolveRequestIp(request),
        });
        publishStoreAuthSessionLiveSnapshot(params.sessionId);
        return reply
          .code(502)
          .send({ message: error instanceof Error ? error.message : '生成扫码登录二维码失败' });
      }
    },
  );

  app.get(
    '/api/stores/auth-sessions/:sessionId/qr-login',
    { preHandler: [authorizeRoles(routeAccessPolicy.manageStores, 'stores', '查看闲鱼扫码登录状态')] },
    async (request, reply) => {
      const params = z.object({ sessionId: z.string().uuid() }).parse(request.params);
      const sessionDetail = db.getStoreAuthSessionDetail(params.sessionId);
      if (!sessionDetail) {
        return reply.code(404).send({ message: '授权会话不存在或已失效' });
      }

      if (
        sessionDetail.platform !== 'xianyu' ||
        sessionDetail.integrationMode !== 'xianyu_web_session'
      ) {
        return reply.code(409).send({ message: '当前会话不支持闲鱼扫码登录' });
      }

      const payload = xianyuWebSessionService.xianyuQrLoginManager.getByAuthSessionId(params.sessionId);
      if (!payload) {
        return reply.code(404).send({ message: '当前会话尚未生成扫码登录二维码' });
      }

      return payload;
    },
  );

  app.get(
    '/api/stores/auth-sessions/:sessionId/credential-events',
    { preHandler: [authorizeRoles(routeAccessPolicy.manageStores, 'stores', '查看授权会话凭据时间线')] },
    async (request, reply) => {
      const params = z.object({ sessionId: z.string().uuid() }).parse(request.params);
      const payload = db.getStoreCredentialEventsBySession(params.sessionId);
      if (!payload) {
        return reply.code(404).send({ message: '授权会话不存在或已失效。' });
      }
      return payload;
    },
  );

  app.post(
    '/api/stores/auth-sessions/:sessionId/live-stream-token',
    { preHandler: [authorizeRoles(routeAccessPolicy.manageStores, 'stores', '订阅授权会话实时流')] },
    async (request, reply) => {
      const currentUser = (request as AppRequest).currentUser!;
      const params = z.object({ sessionId: z.string().uuid() }).parse(request.params);
      const sessionDetail = db.getStoreAuthSessionDetail(params.sessionId);
      if (!sessionDetail) {
        return reply.code(404).send({ message: '授权会话不存在或已失效' });
      }

      return storeAuthLiveStreamManager.issueToken({
        sessionId: params.sessionId,
        userId: currentUser.id,
      });
    },
  );

  app.get('/api/stores/auth-sessions/:sessionId/live-stream', async (request, reply) => {
    const params = z.object({ sessionId: z.string().uuid() }).parse(request.params);
    const query = z.object({ streamToken: z.string().uuid() }).parse(request.query);
    const tokenRecord = storeAuthLiveStreamManager.resolveToken(params.sessionId, query.streamToken);
    if (!tokenRecord) {
      return reply.code(401).send({ message: '实时流令牌无效或已过期' });
    }

    const user = db.getUserById(tokenRecord.userId);
    if (!user || user.status !== 'active') {
      return reply.code(403).send({ message: '当前账号无权订阅该实时流' });
    }

    const snapshot = buildStoreAuthSessionLiveSnapshot(params.sessionId);
    if (!snapshot) {
      return reply.code(404).send({ message: '授权会话不存在或已失效' });
    }

    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });

    const sendSnapshot = (payload: unknown) => {
      reply.raw.write(`event: snapshot\ndata: ${JSON.stringify(payload)}\n\n`);
    };

    const closeStream = () => {
      if (!reply.raw.writableEnded) {
        reply.raw.end();
      }
    };

    sendSnapshot(snapshot);

    const unsubscribe = storeAuthLiveStreamManager.subscribe(params.sessionId, {
      sendSnapshot,
      close: closeStream,
    });

    const keepAlive = setInterval(() => {
      if (!reply.raw.writableEnded) {
        reply.raw.write(': keepalive\n\n');
      }
    }, 15_000);

    const cleanup = () => {
      clearInterval(keepAlive);
      unsubscribe();
    };

    request.raw.once('close', cleanup);
    reply.raw.once('close', cleanup);
  });

  app.post(
    '/api/stores/auth-sessions/:sessionId/qr-login/accept',
    { preHandler: [authorizeRoles(routeAccessPolicy.manageStores, 'stores', '接收闲鱼扫码登录态')] },
    async (request, reply) => {
      const currentUser = (request as AppRequest).currentUser!;
      if (!ensurePrivilegedWriteAllowed(request, reply, currentUser, '接收闲鱼扫码登录态')) {
        return;
      }

      const params = z.object({ sessionId: z.string().uuid() }).parse(request.params);
      const sessionDetail = db.getStoreAuthSessionDetail(params.sessionId);
      if (!sessionDetail) {
        return reply.code(404).send({ message: '授权会话不存在或已失效' });
      }

      if (
        sessionDetail.platform !== 'xianyu' ||
        sessionDetail.integrationMode !== 'xianyu_web_session'
      ) {
        return reply.code(409).send({ message: '当前会话不支持闲鱼扫码登录' });
      }

      const qrPayload = xianyuWebSessionService.xianyuQrLoginManager.consumeSuccessCookies(
        params.sessionId,
      );
      if (!qrPayload) {
        return reply.code(409).send({ message: '扫码登录尚未成功，暂不能接收登录态' });
      }

      // 自动补全 _m_h5_tk：扫码登录拿到的 Cookie 通常缺少 MTOP 签名令牌，
      // 用 Playwright 访问闲鱼页面可以自动获取该令牌。
      let finalCookieText = qrPayload.cookieText;
      try {
        const enrichResult = await xianyuWebSessionService.enrichQrCookiesViaBrowser(qrPayload.cookieText);
        if (enrichResult.enriched) {
          finalCookieText = enrichResult.enrichedCookieText;
          request.log.info({ detail: enrichResult.detail }, '扫码 Cookie 已自动补全 _m_h5_tk');
        } else {
          request.log.warn({ detail: enrichResult.detail }, '扫码 Cookie 自动补全未成功');
        }
      } catch (enrichError) {
        request.log.warn({ error: enrichError }, '扫码 Cookie 自动补全过程异常，使用原始 Cookie');
      }

      let verification:
        | Awaited<ReturnType<typeof xianyuWebSessionService.verifyXianyuWebSessionCookie>>
        | null = null;
      try {
        verification = await xianyuWebSessionService.verifyXianyuWebSessionCookie(finalCookieText);
      } catch {
        verification = null;
      }

      const payload = db.receiveStoreAuthSessionWebCredential(params.sessionId, {
        cookieText: finalCookieText,
        source: 'qr_login',
        riskLevel: verification?.riskLevel ?? 'pending',
        riskReason: verification?.detail ?? '扫码登录成功，待补齐卖家与店铺资料。',
        verificationUrl: verification?.verificationUrl ?? null,
      });

      db.recordAuditLog({
        action: 'store_auth_qr_login_accepted',
        targetType: 'store_auth_session',
        targetId: params.sessionId,
        detail: `${currentUser.displayName} 已接收闲鱼扫码登录态，等待后续绑店。`,
        result: 'success',
        operator: currentUser,
        ipAddress: resolveRequestIp(request),
      });
      publishStoreAuthSessionLiveSnapshot(params.sessionId);

      return {
        ...payload,
        verification: verification
          ? {
              riskLevel: verification.riskLevel,
              detail: verification.detail,
              verificationUrl: verification.verificationUrl,
              rawRet: verification.rawRet,
            }
          : null,
      };
    },
  );


  // ======================== 浏览器扫码登录（Playwright 真实浏览器）========================

  app.post(
    '/api/stores/auth-sessions/:sessionId/qr-login/browser-start',
    { preHandler: [authorizeRoles(routeAccessPolicy.manageStores, 'stores', '启动浏览器扫码登录')] },
    async (request, reply) => {
      const currentUser = (request as AppRequest).currentUser!;
      if (!ensurePrivilegedWriteAllowed(request, reply, currentUser, '启动浏览器扫码登录')) {
        return;
      }

      const params = z.object({ sessionId: z.string().uuid() }).parse(request.params);
      const sessionDetail = db.getStoreAuthSessionDetail(params.sessionId);
      if (!sessionDetail) {
        return reply.code(404).send({ message: '授权会话不存在或已失效' });
      }

      if (sessionDetail.platform !== 'xianyu' || sessionDetail.integrationMode !== 'xianyu_web_session') {
        return reply.code(409).send({ message: '当前会话不支持闲鱼扫码登录' });
      }

      const refreshedWindow = db.refreshStoreAuthSessionWindow(params.sessionId, {
        minutes: 15,
        reviveExpiredWebSession: true,
      });
      if (!refreshedWindow?.refreshed) {
        return reply.code(409).send({ message: '授权会话已失效，请重新发起接入。' });
      }

      try {
        const result = await xianyuWebSessionService.xianyuQrLoginManager.startBrowserQrLogin(params.sessionId);
        db.recordStoreCredentialEvent({
          sessionId: params.sessionId,
          eventType: 'browser_qr_login_started',
          status: result.status === 'waiting' ? 'info' : 'error',
          detail: result.status === 'waiting'
            ? '已启动浏览器扫码登录，等待用户扫码。'
            : `浏览器扫码启动失败：${result.failureReason}`,
          source: 'browser_qr_login',
          operatorUserId: currentUser.id,
        });
        return result;
      } catch (error) {
        request.log.error({ error }, '启动浏览器扫码登录失败');
        return reply.code(500).send({
          message: error instanceof Error ? error.message : '启动浏览器扫码失败',
        });
      }
    },
  );

  app.get(
    '/api/stores/auth-sessions/:sessionId/qr-login/browser-status',
    { preHandler: [authorizeRoles(routeAccessPolicy.manageStores, 'stores', '查询浏览器扫码状态')] },
    async (request, reply) => {
      const params = z.object({ sessionId: z.string().uuid() }).parse(request.params);
      return xianyuWebSessionService.xianyuQrLoginManager.getBrowserQrStatus(params.sessionId);
    },
  );

  app.post(
    '/api/stores/auth-sessions/:sessionId/qr-login/browser-accept',
    { preHandler: [authorizeRoles(routeAccessPolicy.manageStores, 'stores', '接收浏览器扫码登录态')] },
    async (request, reply) => {
      const currentUser = (request as AppRequest).currentUser!;
      if (!ensurePrivilegedWriteAllowed(request, reply, currentUser, '接收浏览器扫码登录态')) {
        return;
      }

      const params = z.object({ sessionId: z.string().uuid() }).parse(request.params);
      const sessionDetail = db.getStoreAuthSessionDetail(params.sessionId);
      if (!sessionDetail) {
        return reply.code(404).send({ message: '授权会话不存在或已失效' });
      }

      const browserPayload = xianyuWebSessionService.xianyuQrLoginManager.consumeBrowserQrCookies(params.sessionId);
      if (!browserPayload) {
        return reply.code(409).send({ message: '浏览器扫码登录尚未成功，暂不能接收登录态' });
      }

      // 浏览器扫码拿到的 Cookie 已包含 _m_h5_tk，无需额外补全
      let verification:
        | Awaited<ReturnType<typeof xianyuWebSessionService.verifyXianyuWebSessionCookie>>
        | null = null;
      try {
        verification = await xianyuWebSessionService.verifyXianyuWebSessionCookie(browserPayload.cookieText);
      } catch {
        verification = null;
      }

      const payload = db.receiveStoreAuthSessionWebCredential(params.sessionId, {
        cookieText: browserPayload.cookieText,
        source: 'browser_qr_login',
        riskLevel: verification?.riskLevel ?? 'pending',
        riskReason: verification?.detail ?? '浏览器扫码登录成功，待补齐卖家与店铺资料。',
        verificationUrl: verification?.verificationUrl ?? null,
      });

      db.recordStoreCredentialEvent({
        sessionId: params.sessionId,
        eventType: 'browser_qr_login_accepted',
        status: 'success',
        detail: '已通过浏览器扫码获取完整登录态（含 _m_h5_tk），Cookie 已写入凭据仓。',
        source: 'browser_qr_login',
        operatorUserId: currentUser.id,
      });

      db.recordAuditLog({
        action: 'store_auth_browser_qr_login_accepted',
        targetType: 'store_auth_session',
        targetId: params.sessionId,
        detail: `${currentUser.displayName} 已通过浏览器扫码接收闲鱼登录态。`,
        result: 'success',
        operator: currentUser,
        ipAddress: resolveRequestIp(request),
      });
      publishStoreAuthSessionLiveSnapshot(params.sessionId);

      return {
        ...payload,
        verification: verification
          ? {
              riskLevel: verification.riskLevel,
              detail: verification.detail,
              verificationUrl: verification.verificationUrl,
              rawRet: verification.rawRet,
            }
          : null,
      };
    },
  );

  app.post(
    '/api/stores/:storeId/activate',
    { preHandler: [authorizeRoles(routeAccessPolicy.manageStores, 'stores', '激活店')] },
    async (request, reply) => {
      const currentUser = (request as AppRequest).currentUser!;
      if (!ensurePrivilegedWriteAllowed(request, reply, currentUser, '激活店')) {
        return;
      }

      const params = z
        .object({
          storeId: z.coerce.number().int().positive(),
        })
        .parse(request.params);
      const payload = db.activateManagedStore(params.storeId);
      if (!payload) {
        db.recordAuditLog({
          action: 'store_activated',
          targetType: 'store',
          targetId: String(params.storeId),
          detail: `${currentUser.displayName} 激活店铺失败，目标店铺不存在。`,
          result: 'failure',
          operator: currentUser,
          ipAddress: resolveRequestIp(request),
        });
        return reply.code(404).send({ message: '店铺不存在' });
      }

      db.recordAuditLog({
        action: 'store_activated',
        targetType: 'store',
        targetId: String(params.storeId),
        detail: `${currentUser.displayName} 激活了店铺 ${payload.shopName}。`,
        result: 'success',
        operator: currentUser,
        ipAddress: resolveRequestIp(request),
      });
      return payload;
    },
  );

  app.post(
    '/api/stores/:storeId/meta',
    { preHandler: [authorizeRoles(routeAccessPolicy.manageStores, 'stores', '编辑店铺信息')] },
    async (request, reply) => {
      const currentUser = (request as AppRequest).currentUser!;
      if (!ensurePrivilegedWriteAllowed(request, reply, currentUser, '编辑店铺信息')) {
        return;
      }

      const params = z.object({ storeId: z.coerce.number().int().positive() }).parse(request.params);
      const body = storeMetaUpdateSchema.parse(request.body);

      try {
        const payload = db.updateManagedStoreMeta(params.storeId, body);
        db.recordAuditLog({
          action: 'store_metadata_updated',
          targetType: 'store',
          targetId: String(params.storeId),
          detail: `${currentUser.displayName} 更新了店${params.storeId} 的分组、标签和备注。`,
          result: 'success',
          operator: currentUser,
          ipAddress: resolveRequestIp(request),
        });
        return { store: payload };
      } catch (error) {
        const message = error instanceof Error ? error.message : '更新店铺信息失败';
        db.recordAuditLog({
          action: 'store_metadata_updated',
          targetType: 'store',
          targetId: String(params.storeId),
          detail: `${currentUser.displayName} 更新店铺信息失败{message}`,
          result: 'failure',
          operator: currentUser,
          ipAddress: resolveRequestIp(request),
        });
        return reply.code(400).send({ message });
      }
    },
  );

  app.post(
    '/api/stores/:storeId/enabled',
    { preHandler: [authorizeRoles(routeAccessPolicy.manageStores, 'stores', '启停店铺')] },
    async (request, reply) => {
      const currentUser = (request as AppRequest).currentUser!;
      if (!ensurePrivilegedWriteAllowed(request, reply, currentUser, '启停店铺')) {
        return;
      }

      const params = z.object({ storeId: z.coerce.number().int().positive() }).parse(request.params);
      const body = storeEnabledSchema.parse(request.body);

      try {
        const payload = db.setManagedStoreEnabled(params.storeId, body.enabled);
        db.recordAuditLog({
          action: 'store_enabled_updated',
          targetType: 'store',
          targetId: String(params.storeId),
          detail: `${currentUser.displayName} 将店${params.storeId} 调整{body.enabled ? '启用' : '停用'}。`,
          result: 'success',
          operator: currentUser,
          ipAddress: resolveRequestIp(request),
        });
        return { store: payload };
      } catch (error) {
        const message = error instanceof Error ? error.message : '更新店铺状态失败';
        db.recordAuditLog({
          action: 'store_enabled_updated',
          targetType: 'store',
          targetId: String(params.storeId),
          detail: `${currentUser.displayName} 更新店铺启停状态失败：${message}`,
          result: 'failure',
          operator: currentUser,
          ipAddress: resolveRequestIp(request),
        });
        return reply.code(400).send({ message });
      }
    },
  );

  app.post(
    '/api/stores/batch/enabled',
    { preHandler: [authorizeRoles(routeAccessPolicy.manageStores, 'stores', '批量启停店铺')] },
    async (request, reply) => {
      const currentUser = (request as AppRequest).currentUser!;
      if (!ensurePrivilegedWriteAllowed(request, reply, currentUser, '批量启停店铺')) {
        return;
      }

      const body = storeBatchStatusSchema.parse(request.body);
      const payload = db.batchSetManagedStoreEnabled(body.storeIds, body.enabled);
      db.recordAuditLog({
        action: 'store_batch_enabled_updated',
        targetType: 'store_batch',
        targetId: body.storeIds.join(','),
        detail: `${currentUser.displayName} 批量${body.storeIds.length} 家店铺调整为${body.enabled ? '启用' : '停用'}。`,
        result: 'success',
        operator: currentUser,
        ipAddress: resolveRequestIp(request),
      });
      return { stores: payload };
    },
  );

  app.post(
    '/api/stores/:storeId/health-check',
    { preHandler: [authorizeRoles(routeAccessPolicy.manageStores, 'stores', '执行店铺健康检')] },
    async (request, reply) => {
      const currentUser = (request as AppRequest).currentUser!;
      const params = z.object({ storeId: z.coerce.number().int().positive() }).parse(request.params);
      let realStatusContext;
      const store = db.getStoreManagementOverview().stores.find((row) => row.id === params.storeId);
      if (store && store.platform === 'xianyu' && store.credentialType === 'web_session' && store.enabled) {
        let credential;
        try {
          credential = db.getManagedStoreWebSessionCredential(store.id);
        } catch {
          // ignore error if unsupported
        }
        if (credential) {
          const verifyResult = await xianyuWebSessionService.verifyXianyuWebSessionCookie(credential.cookieText);
          const statusMap: Record<string, any> = {
            healthy: { status: 'healthy', nextConnectionStatus: 'active' },
            warning: { status: 'warning', nextConnectionStatus: 'active' },
            offline: { status: 'offline', nextConnectionStatus: 'offline' },
            abnormal: { status: 'abnormal', nextConnectionStatus: 'abnormal' },
          };
          const mapped = statusMap[verifyResult.riskLevel] || statusMap['abnormal'];
          realStatusContext = {
            status: mapped.status,
            detail: verifyResult.detail,
            nextConnectionStatus: mapped.nextConnectionStatus,
            nextHealthStatus: mapped.status,
          };
        }
      }

      const payload = db.runStoreHealthCheck(params.storeId, currentUser.id, 'manual', realStatusContext as any);
      if (!payload) {
        db.recordAuditLog({
          action: 'store_health_checked',
          targetType: 'store',
          targetId: String(params.storeId),
          detail: `${currentUser.displayName} 对店${params.storeId} 执行健康检查失败，目标店铺不存在。`,
          result: 'failure',
          operator: currentUser,
          ipAddress: resolveRequestIp(request),
        });
        return reply.code(404).send({ message: '店铺不存在' });
      }
      db.recordAuditLog({
        action: 'store_health_checked',
        targetType: 'store',
        targetId: String(params.storeId),
        detail: `${currentUser.displayName} 对店${params.storeId} 执行了健康检查，结果${payload.status}。`,
        result: 'success',
        operator: currentUser,
        ipAddress: resolveRequestIp(request),
      });
      return payload;
    },
  );

  app.post(
    '/api/stores/:storeId/credential-verify',
    { preHandler: [authorizeRoles(routeAccessPolicy.manageStores, 'stores', '校验店铺登录态')] },
    async (request, reply) => {
      const currentUser = (request as AppRequest).currentUser!;
      if (!ensurePrivilegedWriteAllowed(request, reply, currentUser, '校验店铺登录态')) {
        return;
      }

      const params = z.object({ storeId: z.coerce.number().int().positive() }).parse(request.params);

      let credential: ReturnType<typeof db.getManagedStoreWebSessionCredential> | null = null;
      try {
        credential = db.getManagedStoreWebSessionCredential(params.storeId);
      } catch (error) {
        const statusCode =
          error instanceof Error && 'statusCode' in error && typeof error.statusCode === 'number'
            ? error.statusCode
            : 409;
        return reply
          .code(statusCode)
          .send({ message: error instanceof Error ? error.message : '当前店铺不支持登录态校验' });
      }

      if (!credential) {
        return reply.code(404).send({ message: '店铺不存在' });
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
        const riskLevel = result.riskLevel === 'pending' ? 'warning' : result.riskLevel;
        const payload = db.saveManagedStoreCredentialCheckResult(
          params.storeId,
          {
            riskLevel,
            detail: result.detail,
            verificationUrl: result.verificationUrl,
            refreshedCookieText: result.refreshedCookieText,
          },
          currentUser.id,
          'manual',
        );

        if (!payload) {
          return reply.code(404).send({ message: '店铺不存在' });
        }

        db.recordAuditLog({
          action: 'store_web_credential_verified',
          targetType: 'store',
          targetId: String(params.storeId),
          detail: `${currentUser.displayName} 校验了店铺 ${params.storeId} 的网页登录态，结果为 ${riskLevel}。`,
          result: 'success',
          operator: currentUser,
          ipAddress: resolveRequestIp(request),
        });

        return {
          ...payload,
          rawRet: result.rawRet,
        };
      } catch (error) {
        db.recordStoreCredentialEvent({
          storeId: params.storeId,
          credentialId: credential.credentialId,
          eventType: 'credential_verified',
          status: 'error',
          detail: error instanceof Error ? error.message : '登录态校验失败。',
          source: 'manual',
          operatorUserId: currentUser.id,
        });
        db.recordAuditLog({
          action: 'store_web_credential_verified',
          targetType: 'store',
          targetId: String(params.storeId),
          detail: `${currentUser.displayName} 校验店铺 ${params.storeId} 的网页登录态失败。`,
          result: 'failure',
          operator: currentUser,
          ipAddress: resolveRequestIp(request),
        });
        return reply
          .code(502)
          .send({ message: error instanceof Error ? error.message : '登录态校验失败' });
      }
    },
  );

  /*
  app.get(
    '/api/stores/:storeId/credential-events',
    { preHandler: [authorizeRoles(routeAccessPolicy.manageStores, 'stores', '查看店铺凭据时间线')] },
    async (request, reply) => {
      const params = z.object({ storeId: z.coerce.number().int().positive() }).parse(request.params);
      const payload = db.getStoreCredentialEvents(params.storeId);
      if (!payload) {
        return reply.code(404).send({ message: '搴楅摵涓嶅瓨鍦? });
      }
      return payload;
    },
  );

  */

  app.get(
    '/api/stores/:storeId/credential-events',
    { preHandler: [authorizeRoles(routeAccessPolicy.manageStores, 'stores', '查看店铺凭据时间线')] },
    async (request, reply) => {
      const params = z.object({ storeId: z.coerce.number().int().positive() }).parse(request.params);
      const payload = db.getStoreCredentialEvents(params.storeId);
      if (!payload) {
        return reply.code(404).send({ message: '店铺不存在。' });
      }
      return payload;
    },
  );

  app.post(
    '/api/stores/:storeId/browser-renew',
    { preHandler: [authorizeRoles(routeAccessPolicy.manageStores, 'stores', '执行浏览器续登')] },
    async (request, reply) => {
      const currentUser = (request as AppRequest).currentUser!;
      if (!ensurePrivilegedWriteAllowed(request, reply, currentUser, '执行浏览器续登')) {
        return;
      }

      const params = z.object({ storeId: z.coerce.number().int().positive() }).parse(request.params);
      const body = storeBrowserRenewSchema.parse(request.body ?? {});

      let credential: ReturnType<typeof db.getManagedStoreWebSessionCredential> | null = null;
      try {
        credential = db.getManagedStoreWebSessionCredential(params.storeId);
      } catch (error) {
        const statusCode =
          error instanceof Error && 'statusCode' in error && typeof error.statusCode === 'number'
            ? error.statusCode
            : 409;
        return reply
          .code(statusCode)
          .send({ message: error instanceof Error ? error.message : '当前店铺不支持浏览器续登' });
      }

      if (!credential) {
        return reply.code(404).send({ message: '店铺不存在' });
      }

      try {
        const renewResult = await xianyuWebSessionService.renewXianyuWebSessionCookieViaBrowser({
          cookieText: credential.cookieText,
          showBrowser: body.showBrowser,
          executablePath: body.executablePath ?? null,
        });

        db.markManagedStoreCredentialRenew(params.storeId, {
          cookieText: renewResult.cookieText,
          detail: renewResult.detail,
          renewed: renewResult.renewed,
          verificationUrl: renewResult.verificationUrl,
        });

        let verifyResult:
          | Awaited<ReturnType<typeof xianyuWebSessionService.verifyXianyuWebSessionCookie>>
          | null = null;
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
            : verifyResult?.riskLevel ??
              (renewResult.verificationUrl ? 'warning' : renewResult.renewed ? 'healthy' : 'offline');
        const payload = db.saveManagedStoreCredentialCheckResult(
          params.storeId,
          {
            riskLevel,
            detail: verifyResult?.detail ?? renewResult.detail,
            verificationUrl: verifyResult?.verificationUrl ?? renewResult.verificationUrl,
            refreshedCookieText: verifyResult?.refreshedCookieText ?? renewResult.cookieText,
          },
          currentUser.id,
          'manual',
        );

        if (!payload) {
          return reply.code(404).send({ message: '店铺不存在' });
        }

        db.recordAuditLog({
          action: 'store_web_credential_renewed',
          targetType: 'store',
          targetId: String(params.storeId),
          detail: `${currentUser.displayName} 对店铺 ${params.storeId} 执行了浏览器续登。`,
          result: 'success',
          operator: currentUser,
          ipAddress: resolveRequestIp(request),
        });

        return {
          ...payload,
          renewed: renewResult.renewed,
          renewDetail: renewResult.detail,
          currentUrl: renewResult.currentUrl,
          pageTitle: renewResult.pageTitle,
          rawRet: verifyResult?.rawRet ?? [],
        };
      } catch (error) {
        db.recordStoreCredentialEvent({
          storeId: params.storeId,
          credentialId: credential.credentialId,
          eventType: 'browser_renewed',
          status: 'error',
          detail: error instanceof Error ? error.message : '浏览器续登失败。',
          source: 'browser_renew',
          operatorUserId: currentUser.id,
        });
        db.recordAuditLog({
          action: 'store_web_credential_renewed',
          targetType: 'store',
          targetId: String(params.storeId),
          detail: `${currentUser.displayName} 对店铺 ${params.storeId} 执行浏览器续登失败。`,
          result: 'failure',
          operator: currentUser,
          ipAddress: resolveRequestIp(request),
        });
        return reply
          .code(502)
          .send({ message: error instanceof Error ? error.message : '浏览器续登失败' });
      }
    },
  );

  app.post(
    '/api/stores/batch/health-check',
    { preHandler: [authorizeRoles(routeAccessPolicy.manageStores, 'stores', '批量执行店铺健康检')] },
    async (request) => {
      const currentUser = (request as AppRequest).currentUser!;
      const body = storeBatchHealthCheckSchema.parse(request.body);
      const payload: any[] = [];
      const uniqueStoreIds = Array.from(new Set(body.storeIds.filter((id) => Number.isInteger(id) && id > 0)));

      for (const storeId of uniqueStoreIds) {
        let realStatusContext;
        const store = db.getStoreManagementOverview().stores.find((row) => row.id === storeId);
        if (store && store.platform === 'xianyu' && store.credentialType === 'web_session' && store.enabled) {
          let credential;
          try {
            credential = db.getManagedStoreWebSessionCredential(store.id);
          } catch {
            // ignore
          }
          if (credential) {
            const verifyResult = await xianyuWebSessionService.verifyXianyuWebSessionCookie(credential.cookieText);
            const statusMap: Record<string, any> = {
              healthy: { status: 'healthy', nextConnectionStatus: 'active' },
              warning: { status: 'warning', nextConnectionStatus: 'active' },
              offline: { status: 'offline', nextConnectionStatus: 'offline' },
              abnormal: { status: 'abnormal', nextConnectionStatus: 'abnormal' },
            };
            const mapped = statusMap[verifyResult.riskLevel] || statusMap['abnormal'];
            realStatusContext = {
              status: mapped.status,
              detail: verifyResult.detail,
              nextConnectionStatus: mapped.nextConnectionStatus,
              nextHealthStatus: mapped.status,
            };
          }
        }
        const chk = db.runStoreHealthCheck(storeId, currentUser.id, 'batch', realStatusContext as any);
        if (chk) payload.push(chk);
      }
      db.recordAuditLog({
        action: 'store_batch_health_checked',
        targetType: 'store_batch',
        targetId: body.storeIds.join(','),
        detail: `${currentUser.displayName} 批量${body.storeIds.length} 家店铺执行了健康检查。`,
        result: 'success',
        operator: currentUser,
        ipAddress: resolveRequestIp(request),
      });
      return { checks: payload };
    },
  );

  app.get(
    '/api/workspaces/:featureKey',
    { preHandler: [authorizeWorkspace('view')] },
    async (request, reply) => {
      const params = z.object({ featureKey: z.string().min(1) }).parse(request.params);
      const payload = db.getWorkspaceOverview(params.featureKey);
      if (!payload) {
        return reply.code(404).send({ message: '功能模块不存在' });
      }
      return payload;
    },
  );

  app.get(
    '/api/workspaces/:featureKey/detail',
    { preHandler: [authorizeWorkspace('view')] },
    async (request, reply) => {
      const params = z.object({ featureKey: z.string().min(1) }).parse(request.params);
      const query = baseFilterSchema.parse(request.query);
      const payload = db.getWorkspaceBusinessDetail(params.featureKey, query);
      if (!payload) {
        return reply.code(404).send({ message: '功能模块不存在' });
      }
      return payload;
    },
  );

  app.post(
    '/api/workspaces/:featureKey/alerts/:alertId/status',
    { preHandler: [authorizeWorkspace('manage')] },
    async (request, reply) => {
      const currentUser = (request as AppRequest).currentUser!;
      if (!ensurePrivilegedWriteAllowed(request, reply, currentUser, '处理系统告警')) {
        return;
      }

      const params = z
        .object({
          featureKey: z.string().min(1),
          alertId: z.coerce.number().int().positive(),
        })
        .parse(request.params);
      const body = systemAlertStatusSchema.parse(request.body ?? {});
      const payload = db.updateSystemAlertStatus(params.featureKey, params.alertId, body.status);
      if (!payload) {
        return reply.code(404).send({ message: '系统告警不存在' });
      }

      db.recordAuditLog({
        action: 'system_alert_updated',
        targetType: 'ops_alert',
        targetId: String(params.alertId),
        detail: `${currentUser.displayName} 将系统告警状态更新为 ${body.status}。`,
        result: 'success',
        operator: currentUser,
        ipAddress: resolveRequestIp(request),
      });
      return payload;
    },
  );

  app.post(
    '/api/workspaces/:featureKey/backups/run',
    { preHandler: [authorizeWorkspace('manage')] },
    async (request, reply) => {
      const currentUser = (request as AppRequest).currentUser!;
      if (!ensurePrivilegedWriteAllowed(request, reply, currentUser, '执行数据库备份')) {
        return;
      }

      const params = z.object({ featureKey: z.string().min(1) }).parse(request.params);
      const payload = db.runSystemBackup(params.featureKey, currentUser.displayName);
      if (!payload) {
        return reply.code(404).send({ message: '当前工作台不支持数据库备份' });
      }
      if (payload.runStatus === 'failed') {
        return reply.code(500).send({ message: payload.detail });
      }

      db.recordAuditLog({
        action: 'system_backup_run',
        targetType: 'ops_backup',
        targetId: payload.backupNo,
        detail: `${currentUser.displayName} 执行了数据库备份 ${payload.backupNo}。`,
        result: 'success',
        operator: currentUser,
        ipAddress: resolveRequestIp(request),
      });
      return payload;
    },
  );

  app.post(
    '/api/workspaces/:featureKey/log-archives/run',
    { preHandler: [authorizeWorkspace('manage')] },
    async (request, reply) => {
      const currentUser = (request as AppRequest).currentUser!;
      if (!ensurePrivilegedWriteAllowed(request, reply, currentUser, '执行日志归档')) {
        return;
      }

      const params = z.object({ featureKey: z.string().min(1) }).parse(request.params);
      const payload = db.runSystemLogArchive(params.featureKey, currentUser.displayName);
      if (!payload) {
        return reply.code(404).send({ message: '当前工作台不支持日志归档' });
      }

      db.recordAuditLog({
        action: 'system_log_archive_run',
        targetType: 'ops_archive',
        targetId: payload.archiveNo,
        detail: `${currentUser.displayName} 生成了日志归档 ${payload.archiveNo}。`,
        result: 'success',
        operator: currentUser,
        ipAddress: resolveRequestIp(request),
      });
      return payload;
    },
  );

  app.post(
    '/api/workspaces/:featureKey/recovery-drills/run',
    { preHandler: [authorizeWorkspace('manage')] },
    async (request, reply) => {
      const currentUser = (request as AppRequest).currentUser!;
      if (!ensurePrivilegedWriteAllowed(request, reply, currentUser, '执行恢复演练')) {
        return;
      }

      const params = z.object({ featureKey: z.string().min(1) }).parse(request.params);
      const payload = db.runSystemRecoveryDrill(params.featureKey, currentUser.displayName);
      if (!payload) {
        return reply.code(404).send({ message: '当前工作台不支持恢复演练' });
      }
      if (payload.status === 'failed') {
        return reply.code(500).send({ message: payload.detail });
      }

      db.recordAuditLog({
        action: 'system_recovery_drill_run',
        targetType: 'ops_recovery',
        targetId: payload.drillNo,
        detail: `${currentUser.displayName} 完成了恢复演练 ${payload.drillNo}。`,
        result: 'success',
        operator: currentUser,
        ipAddress: resolveRequestIp(request),
      });
      return payload;
    },
  );

  app.post(
    '/api/workspaces/:featureKey/actions/:actionId/run',
    { preHandler: [authorizeWorkspace('manage')] },
    async (request, reply) => {
      const params = z
        .object({
          featureKey: z.string().min(1),
          actionId: z.coerce.number().int().positive(),
        })
        .parse(request.params);
      const payload = db.runWorkspaceAction(params.featureKey, params.actionId);
      if (!payload) {
        return reply.code(404).send({ message: '动作不存在' });
      }
      return payload;
    },
  );

  app.post(
    '/api/workspaces/:featureKey/rules/:ruleId/toggle',
    { preHandler: [authorizeWorkspace('manage')] },
    async (request, reply) => {
      const params = z
        .object({
          featureKey: z.string().min(1),
          ruleId: z.coerce.number().int().positive(),
        })
        .parse(request.params);
      const payload = db.toggleWorkspaceRule(params.featureKey, params.ruleId);
      if (!payload) {
        return reply.code(404).send({ message: '规则不存在' });
      }
      return payload;
    },
  );

  app.post(
    '/api/workspaces/:featureKey/tasks/:taskId/status',
    { preHandler: [authorizeWorkspace('manage')] },
    async (request, reply) => {
      const params = z
        .object({
          featureKey: z.string().min(1),
          taskId: z.coerce.number().int().positive(),
        })
        .parse(request.params);
      const body = workspaceTaskStatusSchema.parse(request.body);
      const payload = db.updateWorkspaceTaskStatus(params.featureKey, params.taskId, body.status);
      if (!payload) {
        return reply.code(404).send({ message: '任务不存在' });
      }
      return payload;
    },
  );

  app.post(
    '/api/workspaces/:featureKey/suppliers/:supplierId/toggle',
    { preHandler: [authorizeWorkspace('manage')] },
    async (request, reply) => {
      const params = z
        .object({
          featureKey: z.string().min(1),
          supplierId: z.coerce.number().int().positive(),
        })
        .parse(request.params);
      const payload = db.toggleDirectChargeSupplierStatus(params.featureKey, params.supplierId);
      if (!payload) {
        return reply.code(404).send({ message: '供应商不存在' });
      }
      return payload;
    },
  );

  app.post(
    '/api/workspaces/:featureKey/suppliers/:supplierId/token/rotate',
    { preHandler: [authorizeWorkspace('manage')] },
    async (request, reply) => {
      const params = z
        .object({
          featureKey: z.string().min(1),
          supplierId: z.coerce.number().int().positive(),
        })
        .parse(request.params);
      const payload = db.rotateDirectChargeSupplierToken(params.featureKey, params.supplierId);
      if (!payload) {
        return reply.code(404).send({ message: '供应商不存在' });
      }
      return payload;
    },
  );

  app.post(
    '/api/workspaces/:featureKey/direct-charge-jobs/:jobId/dispatch',
    { preHandler: [authorizeWorkspace('manage')] },
    async (request, reply) => {
      const params = z
        .object({
          featureKey: z.string().min(1),
          jobId: z.coerce.number().int().positive(),
        })
        .parse(request.params);
      const payload = db.dispatchDirectChargeJob(params.featureKey, params.jobId);
      if (!payload) {
        return reply.code(404).send({ message: '直充任务不存在' });
      }
      return payload;
    },
  );

  app.post(
    '/api/workspaces/:featureKey/direct-charge-jobs/:jobId/retry',
    { preHandler: [authorizeWorkspace('manage')] },
    async (request, reply) => {
      const params = z
        .object({
          featureKey: z.string().min(1),
          jobId: z.coerce.number().int().positive(),
        })
        .parse(request.params);
      const payload = db.retryDirectChargeJob(params.featureKey, params.jobId);
      if (!payload) {
        return reply.code(404).send({ message: '直充任务不存在' });
      }
      return payload;
    },
  );

  app.post(
    '/api/workspaces/:featureKey/direct-charge-jobs/:jobId/manual-review',
    { preHandler: [authorizeWorkspace('manage')] },
    async (request, reply) => {
      const params = z
        .object({
          featureKey: z.string().min(1),
          jobId: z.coerce.number().int().positive(),
        })
        .parse(request.params);
      const body = directChargeManualReviewSchema.parse(request.body ?? {});
      const payload = db.markDirectChargeJobManualReview(
        params.featureKey,
        params.jobId,
        body.reason,
      );
      if (!payload) {
        return reply.code(404).send({ message: '直充任务不存在或当前状态不可转人工' });
      }
      return payload;
    },
  );

  app.post(
    '/api/workspaces/:featureKey/source-systems/:systemId/toggle',
    { preHandler: [authorizeWorkspace('manage')] },
    async (request, reply) => {
      const params = z
        .object({
          featureKey: z.string().min(1),
          systemId: z.coerce.number().int().positive(),
        })
        .parse(request.params);
      const payload = db.toggleSupplySourceSystemStatus(params.featureKey, params.systemId);
      if (!payload) {
        return reply.code(404).send({ message: '\\u8d27\\u6e90\\u7cfb\\u7edf\\u4e0d\\u5b58\\u5728\\u3002' });
      }
      return payload;
    },
  );

  app.post(
    '/api/workspaces/:featureKey/source-systems/:systemId/token/rotate',
    { preHandler: [authorizeWorkspace('manage')] },
    async (request, reply) => {
      const params = z
        .object({
          featureKey: z.string().min(1),
          systemId: z.coerce.number().int().positive(),
        })
        .parse(request.params);
      const payload = db.rotateSupplySourceSystemToken(params.featureKey, params.systemId);
      if (!payload) {
        return reply.code(404).send({ message: '\\u8d27\\u6e90\\u7cfb\\u7edf\\u4e0d\\u5b58\\u5728\\u3002' });
      }
      return payload;
    },
  );

  app.post(
    '/api/workspaces/:featureKey/source-systems/:systemId/sync',
    { preHandler: [authorizeWorkspace('manage')] },
    async (request, reply) => {
      const params = z
        .object({
          featureKey: z.string().min(1),
          systemId: z.coerce.number().int().positive(),
        })
        .parse(request.params);
      const body = supplySourceSyncSchema.parse(request.body ?? {});
      const payload = db.runSupplySourceSync(params.featureKey, params.systemId, body.syncType);
      if (!payload) {
        return reply.code(404).send({ message: '\\u8d27\\u6e90\\u7cfb\\u7edf\\u4e0d\\u5b58\\u5728\\u6216\\u5f53\\u524d\\u4e0d\\u652f\\u6301\\u540c\\u6b65\\u3002' });
      }
      return payload;
    },
  );

  app.post(
    '/api/workspaces/:featureKey/source-sync-runs/:runId/retry',
    { preHandler: [authorizeWorkspace('manage')] },
    async (request, reply) => {
      const params = z
        .object({
          featureKey: z.string().min(1),
          runId: z.coerce.number().int().positive(),
        })
        .parse(request.params);
      const payload = db.retrySupplySourceSyncRun(params.featureKey, params.runId);
      if (!payload) {
        return reply.code(404).send({ message: '\\u540c\\u6b65\\u8bb0\\u5f55\\u4e0d\\u5b58\\u5728\\u6216\\u5f53\\u524d\\u4e0d\\u652f\\u6301\\u91cd\\u8bd5\\u3002' });
      }
      return payload;
    },
  );

  app.post(
    '/api/workspaces/:featureKey/source-orders/:sourceOrderId/dispatch',
    { preHandler: [authorizeWorkspace('manage')] },
    async (request, reply) => {
      const params = z
        .object({
          featureKey: z.string().min(1),
          sourceOrderId: z.coerce.number().int().positive(),
        })
        .parse(request.params);
      const payload = db.dispatchSupplySourceOrder(params.featureKey, params.sourceOrderId);
      if (!payload) {
        return reply.code(404).send({ message: '\\u8d27\\u6e90\\u8ba2\\u5355\\u4e0d\\u5b58\\u5728\\u3002' });
      }
      return payload;
    },
  );

  app.post(
    '/api/workspaces/:featureKey/source-orders/:sourceOrderId/retry',
    { preHandler: [authorizeWorkspace('manage')] },
    async (request, reply) => {
      const params = z
        .object({
          featureKey: z.string().min(1),
          sourceOrderId: z.coerce.number().int().positive(),
        })
        .parse(request.params);
      const payload = db.retrySupplySourceOrder(params.featureKey, params.sourceOrderId);
      if (!payload) {
        return reply.code(404).send({ message: '\\u8d27\\u6e90\\u8ba2\\u5355\\u4e0d\\u5b58\\u5728\\u3002' });
      }
      return payload;
    },
  );

  app.post(
    '/api/workspaces/:featureKey/source-orders/:sourceOrderId/manual-review',
    { preHandler: [authorizeWorkspace('manage')] },
    async (request, reply) => {
      const params = z
        .object({
          featureKey: z.string().min(1),
          sourceOrderId: z.coerce.number().int().positive(),
        })
        .parse(request.params);
      const body = supplySourceManualReviewSchema.parse(request.body ?? {});
      const payload = db.markSupplySourceOrderManualReview(
        params.featureKey,
        params.sourceOrderId,
        body.reason,
      );
      if (!payload) {
        return reply.code(404).send({ message: '\\u8d27\\u6e90\\u8ba2\\u5355\\u4e0d\\u5b58\\u5728\\u6216\\u5f53\\u524d\\u72b6\\u6001\\u4e0d\\u53ef\\u8f6c\\u4eba\\u5de5\\u3002' });
      }
      return payload;
    },
  );

  app.post(
    '/api/workspaces/:featureKey/delivery-items/:deliveryId/toggle',
    { preHandler: [authorizeWorkspace('manage')] },
    async (request, reply) => {
      const params = z
        .object({
          featureKey: z.string().min(1),
          deliveryId: z.coerce.number().int().positive(),
        })
        .parse(request.params);
      const payload = db.toggleCardDeliveryItem(params.featureKey, params.deliveryId);
      if (!payload) {
        return reply.code(404).send({ message: '发货设置不存在' });
      }
      return payload;
    },
  );

  app.post(
    '/api/workspaces/:featureKey/combos/:comboId/toggle',
    { preHandler: [authorizeWorkspace('manage')] },
    async (request, reply) => {
      const params = z
        .object({
          featureKey: z.string().min(1),
          comboId: z.coerce.number().int().positive(),
        })
        .parse(request.params);
      const payload = db.toggleCardComboStatus(params.featureKey, params.comboId);
      if (!payload) {
        return reply.code(404).send({ message: '组合不存在' });
      }
      return payload;
    },
  );

  app.post(
    '/api/workspaces/:featureKey/templates/:templateId/random-toggle',
    { preHandler: [authorizeWorkspace('manage')] },
    async (request, reply) => {
      const params = z
        .object({
          featureKey: z.string().min(1),
          templateId: z.coerce.number().int().positive(),
        })
        .parse(request.params);
      const payload = db.toggleCardTemplateRandom(params.featureKey, params.templateId);
      if (!payload) {
        return reply.code(404).send({ message: '模板不存在' });
      }
      return payload;
    },
  );

  app.post(
    '/api/workspaces/:featureKey/card-types/:cardTypeId/restore',
    { preHandler: [authorizeWorkspace('manage')] },
    async (request, reply) => {
      const params = z
        .object({
          featureKey: z.string().min(1),
          cardTypeId: z.coerce.number().int().positive(),
        })
        .parse(request.params);
      const payload = db.restoreCardType(params.featureKey, params.cardTypeId);
      if (!payload) {
        return reply.code(404).send({ message: '卡种不存在' });
      }
      return payload;
    },
  );

  app.post(
    '/api/workspaces/:featureKey/card-types/:cardTypeId/import',
    { preHandler: [authorizeWorkspace('manage')] },
    async (request, reply) => {
      const params = z
        .object({
          featureKey: z.string().min(1),
          cardTypeId: z.coerce.number().int().positive(),
        })
        .parse(request.params);
      const body = cardImportSchema.parse(request.body ?? {});
      const payload = db.importCardInventory(params.featureKey, params.cardTypeId, body.lines);
      if (!payload) {
        return reply.code(404).send({ message: '卡种不存在或当前模块不支持导入' });
      }
      return payload;
    },
  );

  app.post(
    '/api/workspaces/:featureKey/card-types/:cardTypeId/inventory-sample/toggle',
    { preHandler: [authorizeWorkspace('manage')] },
    async (request, reply) => {
      const params = z
        .object({
          featureKey: z.string().min(1),
          cardTypeId: z.coerce.number().int().positive(),
        })
        .parse(request.params);
      const payload = db.toggleCardInventorySample(params.featureKey, params.cardTypeId);
      if (!payload) {
        return reply.code(404).send({ message: '可切换的样卡不存在' });
      }
      return payload;
    },
  );

  app.post(
    '/api/workspaces/:featureKey/orders/:orderId/fulfill',
    { preHandler: [authorizeWorkspace('manage')] },
    async (request, reply) => {
      const params = z
        .object({
          featureKey: z.string().min(1),
          orderId: z.coerce.number().int().positive(),
        })
        .parse(request.params);
      const payload = db.fulfillCardOrder(params.featureKey, params.orderId);
      if (!payload) {
        return reply.code(404).send({ message: '订单不存在或未接入卡密发货' });
      }
      return payload;
    },
  );

  app.post(
    '/api/workspaces/:featureKey/jobs/:jobId/run',
    { preHandler: [authorizeWorkspace('manage')] },
    async (request, reply) => {
      const params = z
        .object({
          featureKey: z.string().min(1),
          jobId: z.coerce.number().int().positive(),
        })
        .parse(request.params);
      const payload = db.runCardDeliveryJob(params.featureKey, params.jobId);
      if (!payload) {
        return reply.code(404).send({ message: '发货任务不存在' });
      }
      return payload;
    },
  );

  app.post(
    '/api/workspaces/:featureKey/outbound-records/:outboundRecordId/resend',
    { preHandler: [authorizeWorkspace('manage')] },
    async (request, reply) => {
      const params = z
        .object({
          featureKey: z.string().min(1),
          outboundRecordId: z.coerce.number().int().positive(),
        })
        .parse(request.params);
      const payload = db.resendCardOutbound(params.featureKey, params.outboundRecordId);
      if (!payload) {
        return reply.code(404).send({ message: '出库记录不存在或当前状态不可补发' });
      }
      return payload;
    },
  );

  app.post(
    '/api/workspaces/:featureKey/outbound-records/:outboundRecordId/recycle',
    { preHandler: [authorizeWorkspace('manage')] },
    async (request, reply) => {
      const params = z
        .object({
          featureKey: z.string().min(1),
          outboundRecordId: z.coerce.number().int().positive(),
        })
        .parse(request.params);
      const body = cardRecycleSchema.parse(request.body ?? {});
      const payload = db.recycleCardOutbound(params.featureKey, params.outboundRecordId, body.action);
      if (!payload) {
        return reply.code(404).send({ message: '出库记录不存在或当前状态不可回收' });
      }
      return payload;
    },
  );

  app.post('/api/direct-charge/callbacks/:supplierKey', async (request, reply) => {
    const params = z
      .object({
        supplierKey: z.string().min(1),
      })
      .parse(request.params);
    const body = directChargeCallbackSchema.parse(request.body ?? {});
    const payload = db.processDirectChargeCallback(params.supplierKey, body);
    if (!payload) {
      return reply.code(404).send({ message: '供应商不存在' });
    }
    return payload;
  });

  app.post('/api/source-supply/callbacks/:systemKey', async (request, reply) => {
    const params = z
      .object({
        systemKey: z.string().min(1),
      })
      .parse(request.params);
    const body = supplySourceCallbackSchema.parse(request.body ?? {});
    const payload = db.processSupplySourceCallback(params.systemKey, body);
    if (!payload) {
      return reply.code(404).send({ message: '\\u8d27\\u6e90\\u7cfb\\u7edf\\u4e0d\\u5b58\\u5728\\u3002' });
    }
    return payload;
  });

  app.post('/api/source-supply/refunds/:systemKey', async (request, reply) => {
    const params = z
      .object({
        systemKey: z.string().min(1),
      })
      .parse(request.params);
    const body = supplySourceRefundSchema.parse(request.body ?? {});
    const payload = db.processSupplySourceRefundNotice(params.systemKey, body);
    if (!payload) {
      return reply.code(404).send({ message: '\\u8d27\\u6e90\\u7cfb\\u7edf\\u4e0d\\u5b58\\u5728\\u3002' });
    }
    return payload;
  });

  /*
  app.post(
    '/api/workspaces/:featureKey/withdrawals',
    { preHandler: [authorizeWorkspace('manage')] },
    async (request, reply) => {
      const currentUser = (request as AppRequest).currentUser!;
      if (!ensurePrivilegedWriteAllowed(request, reply, currentUser, '鎻愪氦鎻愮幇鐢宠')) {
        return;
      }

      const params = z.object({ featureKey: z.string().min(1) }).parse(request.params);
      const body = workspaceWithdrawalCreateSchema.parse(request.body);
      const payload = db.createFundWithdrawal({
        featureKey: params.featureKey,
        amount: body.amount,
        storeId: body.storeId,
        method: body.method,
        receivingAccount: body.receivingAccount,
      });
      if (!payload) {
        return reply.code(400).send({ message: '鎻愮幇鐢宠鍒涘缓澶辫触锛岃妫€鏌ユ彁鐜伴噾棰濅笌鍙敤浣欓' });
      }

      db.recordAuditLog({
        action: 'withdrawal_created',
        targetType: 'withdrawal',
        targetId: params.featureKey,
        detail: `${currentUser.displayName} 鎻愪氦浜嗘彁鐜扮敵璇凤紝閲戦${body.amount} 鍏冦€俙,
        result: 'success',
        operator: currentUser,
        ipAddress: resolveRequestIp(request),
      });
      return payload;
    },
  );

  app.post(
    '/api/workspaces/:featureKey/withdrawals/:withdrawalId/status',
    { preHandler: [authorizeWorkspace('manage')] },
    async (request, reply) => {
      const currentUser = (request as AppRequest).currentUser!;
      if (!ensurePrivilegedWriteAllowed(request, reply, currentUser, '审核提现')) {
        return;
      }

      const params = z
        .object({
          featureKey: z.string().min(1),
          withdrawalId: z.coerce.number().int().positive(),
        })
        .parse(request.params);
      const body = workspaceWithdrawalStatusSchema.parse(request.body);
      const payload = db.updateFundWithdrawalStatus(
        params.featureKey,
        params.withdrawalId,
        body.status,
      );
      if (!payload) {
        db.recordAuditLog({
          action: 'withdrawal_reviewed',
          targetType: 'withdrawal',
          targetId: String(params.withdrawalId),
          detail: `${currentUser.displayName} 审核提现失败，记录不存在。`,
          result: 'failure',
          operator: currentUser,
          ipAddress: resolveRequestIp(request),
        });
        return reply.code(404).send({ message: '提现记录不存在 });
      }

      db.recordAuditLog({
        action: 'withdrawal_reviewed',
        targetType: 'withdrawal',
        targetId: String(params.withdrawalId),
        detail: `${currentUser.displayName} 将提现状态更新为 ${body.status}。`,
        result: 'success',
        operator: currentUser,
        ipAddress: resolveRequestIp(request),
      });
      return payload;
    },
  );

  app.post(
    '/api/workspaces/:featureKey/reconciliations/:reconciliationId/status',
    { preHandler: [authorizeWorkspace('manage')] },
    async (request, reply) => {
      const currentUser = (request as AppRequest).currentUser!;
      if (!ensurePrivilegedWriteAllowed(request, reply, currentUser, '鏇存柊瀵硅处鐘舵€?')) {
        return;
      }

      const params = z
        .object({
          featureKey: z.string().min(1),
          reconciliationId: z.coerce.number().int().positive(),
        })
        .parse(request.params);
      const body = fundReconciliationStatusSchema.parse(request.body);
      const payload = db.updateFundReconciliationStatus(
        params.featureKey,
        params.reconciliationId,
        body.status,
        body.note,
      );
      if (!payload) {
        return reply.code(404).send({ message: '瀵硅处璁板綍涓嶅瓨鍦ㄣ€? });
      }

      db.recordAuditLog({
        action: 'reconciliation_updated',
        targetType: 'reconciliation',
        targetId: String(params.reconciliationId),
        detail: `${currentUser.displayName} 灏嗗璐︾姸鎬佹洿鏂颁负 ${body.status}銆俙,
        result: 'success',
        operator: currentUser,
        ipAddress: resolveRequestIp(request),
      });
      return payload;
    },
  );

  */

  app.post(
    '/api/workspaces/:featureKey/withdrawals',
    { preHandler: [authorizeWorkspace('manage')] },
    async (request, reply) => {
      const currentUser = (request as AppRequest).currentUser!;
      if (!ensurePrivilegedWriteAllowed(request, reply, currentUser, '提交提现申请')) {
        return;
      }

      const params = z.object({ featureKey: z.string().min(1) }).parse(request.params);
      const body = workspaceWithdrawalCreateSchema.parse(request.body);
      const payload = db.createFundWithdrawal({
        featureKey: params.featureKey,
        amount: body.amount,
        storeId: body.storeId,
        method: body.method,
        receivingAccount: body.receivingAccount,
      });
      if (!payload) {
        return reply
          .code(400)
          .send({ message: '提现申请创建失败，请检查提现金额与可用余额' });
      }

      db.recordAuditLog({
        action: 'withdrawal_created',
        targetType: 'withdrawal',
        targetId: params.featureKey,
        detail: `${currentUser.displayName} 提交了提现申请，金额 ${body.amount} 元。`,
        result: 'success',
        operator: currentUser,
        ipAddress: resolveRequestIp(request),
      });
      return payload;
    },
  );

  app.post(
    '/api/workspaces/:featureKey/withdrawals/:withdrawalId/status',
    { preHandler: [authorizeWorkspace('manage')] },
    async (request, reply) => {
      const currentUser = (request as AppRequest).currentUser!;
      if (!ensurePrivilegedWriteAllowed(request, reply, currentUser, '审核提现')) {
        return;
      }

      const params = z
        .object({
          featureKey: z.string().min(1),
          withdrawalId: z.coerce.number().int().positive(),
        })
        .parse(request.params);
      const body = workspaceWithdrawalStatusSchema.parse(request.body);
      const payload = db.updateFundWithdrawalStatus(
        params.featureKey,
        params.withdrawalId,
        body.status,
      );
      if (!payload) {
        db.recordAuditLog({
          action: 'withdrawal_reviewed',
          targetType: 'withdrawal',
          targetId: String(params.withdrawalId),
          detail: `${currentUser.displayName} 审核提现失败，记录不存在。`,
          result: 'failure',
          operator: currentUser,
          ipAddress: resolveRequestIp(request),
        });
        return reply.code(404).send({ message: '提现记录不存在' });
      }

      db.recordAuditLog({
        action: 'withdrawal_reviewed',
        targetType: 'withdrawal',
        targetId: String(params.withdrawalId),
        detail: `${currentUser.displayName} 将提现状态更新为 ${body.status}。`,
        result: 'success',
        operator: currentUser,
        ipAddress: resolveRequestIp(request),
      });
      return payload;
    },
  );

  app.post(
    '/api/workspaces/:featureKey/reconciliations/:reconciliationId/status',
    { preHandler: [authorizeWorkspace('manage')] },
    async (request, reply) => {
      const currentUser = (request as AppRequest).currentUser!;
      if (!ensurePrivilegedWriteAllowed(request, reply, currentUser, '更新对账状')) {
        return;
      }

      const params = z
        .object({
          featureKey: z.string().min(1),
          reconciliationId: z.coerce.number().int().positive(),
        })
        .parse(request.params);
      const body = fundReconciliationStatusSchema.parse(request.body);
      const payload = db.updateFundReconciliationStatus(
        params.featureKey,
        params.reconciliationId,
        body.status,
        body.note,
      );
      if (!payload) {
        return reply.code(404).send({ message: '对账记录不存在' });
      }

      db.recordAuditLog({
        action: 'reconciliation_updated',
        targetType: 'reconciliation',
        targetId: String(params.reconciliationId),
        detail: `${currentUser.displayName} 将对账状态更新为 ${body.status}。`,
        result: 'success',
        operator: currentUser,
        ipAddress: resolveRequestIp(request),
      });
      return payload;
    },
  );

  app.post(
    '/api/workspaces/:featureKey/service-sync',
    { preHandler: [authorizeWorkspace('manage')] },
    async (request, reply) => {
      const currentUser = (request as AppRequest).currentUser!;
      if (!ensurePrivilegedWriteAllowed(request, reply, currentUser, '同步 AI 客服真实会话')) {
        return;
      }

      const params = z.object({ featureKey: z.string().min(1) }).parse(request.params);
      const body = aiServiceSyncSchema.parse(request.body ?? {});
      const targets = db.listManagedStoreAiBargainSyncTargets(body.storeIds);
      if (targets.length === 0) {
        return reply.code(409).send({ message: '当前没有可同步的已激活闲鱼网页登录态店铺。' });
      }

      const maxSessionsPerStore = Math.max(1, Math.min(50, Math.trunc(body.maxSessionsPerStore ?? 50)));
      const maxMessagesPerSession = Math.max(1, Math.min(50, Math.trunc(body.maxMessagesPerSession ?? 50)));
      const results: Array<{
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
      }> = [];

      for (const target of targets) {
        try {
          results.push(
            await syncAiServiceStoreTarget(
              target,
              {
                id: currentUser.id,
                displayName: currentUser.displayName,
              },
              {
                featureKey: params.featureKey,
                syncSource: 'manual',
                maxSessionsPerStore,
                maxMessagesPerSession,
              },
            ),
          );
          continue;
          const fetched = await xianyuWebSessionService.fetchXianyuWebSessionBargainSessions({
            cookieText: target.cookieText,
            maxSessions: maxSessionsPerStore,
            maxMessagesPerSession,
            cachedSocketAuth: target.cachedSocketAuth ?? null,
          });
          if (fetched.refreshedCookieText && fetched.refreshedCookieText !== target.cookieText) {
            db.markManagedStoreCredentialRenew(target.storeId, {
              cookieText: fetched.refreshedCookieText,
              detail: 'AI客服真实会话同步已刷新闲鱼网页登录态。',
              renewed: true,
            });
          }
          if (fetched.socketAuthCache) {
            db.saveManagedStoreXianyuImAuthCache(
              target.storeId,
              fetched.socketAuthCache!,
              'ai_service_sync',
            );
          } else if (fetched.socketAuthCacheRejected) {
            db.clearManagedStoreXianyuImAuthCache(target.storeId);
          }

          const synced = db.syncAiServiceConversationsFromXianyuIm({
            featureKey: params.featureKey,
            storeId: target.storeId,
            sessions: fetched.sessions,
            operator: {
              id: currentUser.id,
              displayName: currentUser.displayName,
            },
          });
          if (!synced) {
            results.push({
              storeId: target.storeId,
              shopName: target.shopName,
              providerUserId: target.providerUserId,
              success: false,
              message: 'AI 客服模块不可用或店铺不存在。',
            });
            continue;
          }

          results.push({
            storeId: target.storeId,
            shopName: target.shopName,
            providerUserId: target.providerUserId,
            success: true,
            fetchedSessionCount: synced!.fetchedSessionCount,
            candidateSessionCount: synced!.candidateSessionCount,
            syncedConversationCount: synced!.syncedConversationCount,
            skippedCount: synced!.skippedCount,
            createdConversationCount: synced!.createdConversationCount,
            updatedConversationCount: synced!.updatedConversationCount,
            createdMessageCount: synced!.createdMessageCount,
            syncedAt: synced!.syncedAt,
            message:
              synced!.candidateSessionCount === 0
                ? '本轮未发现可写入 AI 客服工作台的真实买家会话。'
                : undefined,
          });
        } catch (error) {
          if (
            error instanceof Error &&
            'socketAuthCacheRejected' in error &&
            (error as Error & { socketAuthCacheRejected?: boolean }).socketAuthCacheRejected
          ) {
            db.clearManagedStoreXianyuImAuthCache(target.storeId);
          }
          results.push({
            storeId: target.storeId,
            shopName: target.shopName,
            providerUserId: target.providerUserId,
            success: false,
            message: error instanceof Error ? error.message : '同步真实 AI 客服会话失败。',
          });
        }
      }

      const successCount = results.filter((item) => item.success).length;
      db.recordAuditLog({
        action: 'xianyu_ai_service_synced',
        targetType: 'ai_service',
        targetId: body.storeIds?.length ? body.storeIds.join(',') : 'all-active-xianyu',
        detail: `${currentUser.displayName} 执行了闲鱼真实 AI 客服会话同步，成功 ${successCount}/${results.length} 家店铺。`,
        result: successCount > 0 ? 'success' : 'failure',
        operator: currentUser,
        ipAddress: resolveRequestIp(request),
      });

      if (successCount === 0) {
        return reply.code(502).send({
          message: '闲鱼真实 AI 客服会话同步失败，请检查网页登录态或 IM 接口状态。',
          successCount,
          totalCount: results.length,
          results,
        });
      }

      return {
        successCount,
        totalCount: results.length,
        results,
      };
    },
  );

  app.post(
    '/api/workspaces/:featureKey/conversations/:conversationId/ai-reply',
    { preHandler: [authorizeWorkspace('manage')] },
    async (request, reply) => {
      const currentUser = (request as AppRequest).currentUser!;
      if (!ensurePrivilegedWriteAllowed(request, reply, currentUser, '触发 AI 客服回复')) {
        return;
      }

      const params = z
        .object({
          featureKey: z.string().min(1),
          conversationId: z.coerce.number().int().positive(),
        })
        .parse(request.params);
      // 先尝试 LLM 大模型回复
      const llmReply = await tryLlmReply(
        params.featureKey,
        params.conversationId,
        { id: currentUser.id, displayName: currentUser.displayName },
      );

      let payload: {
        reused: boolean;
        replyType: string;
        conversationStatus: string;
        aiStatus: string;
        content: string;
      } | null;

      if (llmReply) {
        // LLM 成功
        payload = {
          reused: false,
          replyType: 'ai',
          conversationStatus: 'open',
          aiStatus: 'auto_replied',
          content: llmReply.content,
        };
      } else {
        // LLM 不可用，降级到本地规则引擎
        payload = db.generateAiServiceReply(params.featureKey, params.conversationId, {
          id: currentUser.id,
          displayName: currentUser.displayName,
        });
      }

      if (!payload) {
        return reply.code(404).send({ message: '会话不存在或当前模块不支持 AI 回复。' });
      }

      if (!payload.reused && payload.replyType === 'ai') {
        try {
          await sendAiServiceXianyuMessage({
            featureKey: params.featureKey,
            conversationId: params.conversationId,
            content: payload.content,
          });
          db.updateAiServiceLatestOutboundMessageStatus(
            params.featureKey,
            params.conversationId,
            'ai',
            'sent',
          );
        } catch (error) {
          db.updateAiServiceLatestOutboundMessageStatus(
            params.featureKey,
            params.conversationId,
            'ai',
            'failed',
          );
          return reply.code(502).send({
            message: error instanceof Error ? error.message : 'AI 客服真实发信失败。',
          });
        }
      }

      db.recordAuditLog({
        action: 'ai_service_reply_generated',
        targetType: 'ai_service',
        targetId: String(params.conversationId),
        detail: `${currentUser.displayName} 触发AI 客服回复（${llmReply ? 'LLM大模型' : '规则引擎'}），类型 ${payload.replyType}。`,
        result: 'success',
        operator: currentUser,
        ipAddress: resolveRequestIp(request),
      });
      return payload;
    },
  );

  app.post(
    '/api/workspaces/:featureKey/conversations/:conversationId/takeover',
    { preHandler: [authorizeWorkspace('manage')] },
    async (request, reply) => {
      const currentUser = (request as AppRequest).currentUser!;
      if (!ensurePrivilegedWriteAllowed(request, reply, currentUser, '人工接管 AI 会话')) {
        return;
      }

      const params = z
        .object({
          featureKey: z.string().min(1),
          conversationId: z.coerce.number().int().positive(),
        })
        .parse(request.params);
      const body = aiServiceTakeoverSchema.parse(request.body ?? {});
      const payload = db.updateAiServiceConversationTakeover(
        params.featureKey,
        params.conversationId,
        body.action,
        body.note,
        {
          id: currentUser.id,
          displayName: currentUser.displayName,
        },
      );
      if (!payload) {
        return reply.code(404).send({ message: '会话不存在' });
      }

      db.recordAuditLog({
        action: 'ai_service_takeover_updated',
        targetType: 'ai_service',
        targetId: String(params.conversationId),
        detail: `${currentUser.displayName}${body.action === 'takeover' ? '接管' : '释放'}AI 客服会话。`,
        result: 'success',
        operator: currentUser,
        ipAddress: resolveRequestIp(request),
      });
      return payload;
    },
  );

  app.post(
    '/api/workspaces/:featureKey/conversations/:conversationId/manual-reply',
    { preHandler: [authorizeWorkspace('manage')] },
    async (request, reply) => {
      const currentUser = (request as AppRequest).currentUser!;
      if (!ensurePrivilegedWriteAllowed(request, reply, currentUser, '发送人工纠偏回')) {
        return;
      }

      const params = z
        .object({
          featureKey: z.string().min(1),
          conversationId: z.coerce.number().int().positive(),
        })
        .parse(request.params);
      const body = aiServiceManualReplySchema.parse(request.body ?? {});
      try {
        await sendAiServiceXianyuMessage({
          featureKey: params.featureKey,
          conversationId: params.conversationId,
          content: body.content,
        });
      } catch (error) {
        return reply.code(502).send({
          message: error instanceof Error ? error.message : '人工回复真实发信失败。',
        });
      }
      const payload = db.sendAiServiceManualReply(
        params.featureKey,
        params.conversationId,
        body.content,
        body.closeConversation,
        {
          id: currentUser.id,
          displayName: currentUser.displayName,
        },
      );
      if (!payload) {
        return reply.code(404).send({ message: '会话不存在' });
      }

      db.recordAuditLog({
        action: 'ai_service_manual_reply_sent',
        targetType: 'ai_service',
        targetId: String(params.conversationId),
        detail: `${currentUser.displayName} 发送了人工纠偏回复。`,
        result: 'success',
        operator: currentUser,
        ipAddress: resolveRequestIp(request),
      });
      return payload;
    },
  );

  app.post(
    '/api/workspaces/:featureKey/settings',
    { preHandler: [authorizeWorkspace('manage')] },
    async (request, reply) => {
      const currentUser = (request as AppRequest).currentUser!;
      if (!ensurePrivilegedWriteAllowed(request, reply, currentUser, '更新 AI 客服策略')) {
        return;
      }

      const params = z.object({ featureKey: z.string().min(1) }).parse(request.params);
      const body = aiServiceSettingsSchema.parse(request.body ?? {});
      const payload = db.updateAiServiceSettings(params.featureKey, body, {
        id: currentUser.id,
        displayName: currentUser.displayName,
      });
      if (!payload) {
        return reply.code(404).send({ message: 'AI 客服策略不存在' });
      }

      db.recordAuditLog({
        action: 'ai_service_settings_updated',
        targetType: 'ai_service',
        targetId: params.featureKey,
        detail: `${currentUser.displayName} 更新AI 客服策略。`,
        result: 'success',
        operator: currentUser,
        ipAddress: resolveRequestIp(request),
      });
      return { settings: payload };
    },
  );

  app.post(
    '/api/workspaces/:featureKey/knowledge-items/:knowledgeItemId/enabled',
    { preHandler: [authorizeWorkspace('manage')] },
    async (request, reply) => {
      const currentUser = (request as AppRequest).currentUser!;
      if (!ensurePrivilegedWriteAllowed(request, reply, currentUser, '启停 AI 知识库条')) {
        return;
      }

      const params = z
        .object({
          featureKey: z.string().min(1),
          knowledgeItemId: z.coerce.number().int().positive(),
        })
        .parse(request.params);
      const body = aiServiceEnabledSchema.parse(request.body ?? {});
      const payload = db.updateAiServiceKnowledgeItemEnabled(
        params.featureKey,
        params.knowledgeItemId,
        body.enabled,
      );
      if (!payload) {
        return reply.code(404).send({ message: '知识库条目不存在' });
      }

      db.recordAuditLog({
        action: 'ai_service_knowledge_updated',
        targetType: 'ai_service',
        targetId: String(params.knowledgeItemId),
        detail: `${currentUser.displayName}${body.enabled ? '启用' : '停用'}AI 知识库条目。`,
        result: 'success',
        operator: currentUser,
        ipAddress: resolveRequestIp(request),
      });
      return payload;
    },
  );

  app.post(
    '/api/workspaces/:featureKey/reply-templates/:templateId/enabled',
    { preHandler: [authorizeWorkspace('manage')] },
    async (request, reply) => {
      const currentUser = (request as AppRequest).currentUser!;
      if (!ensurePrivilegedWriteAllowed(request, reply, currentUser, '启停 AI 话术模板')) {
        return;
      }

      const params = z
        .object({
          featureKey: z.string().min(1),
          templateId: z.coerce.number().int().positive(),
        })
        .parse(request.params);
      const body = aiServiceEnabledSchema.parse(request.body ?? {});
      const payload = db.updateAiServiceReplyTemplateEnabled(
        params.featureKey,
        params.templateId,
        body.enabled,
      );
      if (!payload) {
        return reply.code(404).send({ message: '话术模板不存在' });
      }

      db.recordAuditLog({
        action: 'ai_service_template_updated',
        targetType: 'ai_service',
        targetId: String(params.templateId),
        detail: `${currentUser.displayName}${body.enabled ? '启用' : '停用'}AI 话术模板。`,
        result: 'success',
        operator: currentUser,
        ipAddress: resolveRequestIp(request),
      });
      return payload;
    },
  );

  app.post(
    '/api/workspaces/:featureKey/bargain-sync',
    { preHandler: [authorizeWorkspace('manage')] },
    async (request, reply) => {
      const currentUser = (request as AppRequest).currentUser!;
      if (!ensurePrivilegedWriteAllowed(request, reply, currentUser, '同步 AI 议价真实会话')) {
        return;
      }

      const params = z.object({ featureKey: z.string().min(1) }).parse(request.params);
      const body = aiBargainSyncSchema.parse(request.body ?? {});
      const targets = db.listManagedStoreAiBargainSyncTargets(body.storeIds);
      if (targets.length === 0) {
        return reply.code(409).send({ message: '当前没有可同步的已激活闲鱼网页登录态店铺。' });
      }

      const maxSessionsPerStore = Math.max(1, Math.min(50, Math.trunc(body.maxSessionsPerStore ?? 20)));
      const maxMessagesPerSession = Math.max(1, Math.min(50, Math.trunc(body.maxMessagesPerSession ?? 20)));
      const results: Array<{
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
      }> = [];

      for (const target of targets) {
        try {
          const fetched = await xianyuWebSessionService.fetchXianyuWebSessionBargainSessions({
            cookieText: target.cookieText,
            maxSessions: maxSessionsPerStore,
            maxMessagesPerSession,
            cachedSocketAuth: target.cachedSocketAuth ?? null,
          });
          if (fetched.refreshedCookieText && fetched.refreshedCookieText !== target.cookieText) {
            db.markManagedStoreCredentialRenew(target.storeId, {
              cookieText: fetched.refreshedCookieText,
              detail: 'AI议价同步已刷新闲鱼网页登录态。',
              renewed: true,
            });
          }
          if (fetched.socketAuthCache) {
            db.saveManagedStoreXianyuImAuthCache(
              target.storeId,
              fetched.socketAuthCache,
              'ai_bargain_sync',
            );
          } else if (fetched.socketAuthCacheRejected) {
            db.clearManagedStoreXianyuImAuthCache(target.storeId);
          }
          const synced = db.syncAiBargainSessionsFromXianyuIm({
            featureKey: params.featureKey,
            storeId: target.storeId,
            sessions: fetched.sessions,
            operator: {
              id: currentUser.id,
              displayName: currentUser.displayName,
            },
          });
          if (!synced) {
            results.push({
              storeId: target.storeId,
              shopName: target.shopName,
              providerUserId: target.providerUserId,
              success: false,
              message: 'AI 议价模块不可用或店铺不存在。',
            });
            continue;
          }

          results.push({
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
              synced.candidateSessionCount === 0
                ? '本轮未发现带议价意图的真实买家会话。'
                : undefined,
          });
        } catch (error) {
          if (
            error instanceof Error &&
            'socketAuthCacheRejected' in error &&
            (error as Error & { socketAuthCacheRejected?: boolean }).socketAuthCacheRejected
          ) {
            db.clearManagedStoreXianyuImAuthCache(target.storeId);
          }
          results.push({
            storeId: target.storeId,
            shopName: target.shopName,
            providerUserId: target.providerUserId,
            success: false,
            message: error instanceof Error ? error.message : '同步真实 AI 议价会话失败。',
          });
        }
      }

      const successCount = results.filter((item) => item.success).length;
      db.recordAuditLog({
        action: 'xianyu_ai_bargain_synced',
        targetType: 'ai_bargain',
        targetId: body.storeIds?.length ? body.storeIds.join(',') : 'all-active-xianyu',
        detail: `${currentUser.displayName} 执行了闲鱼真实议价会话同步，成功 ${successCount}/${results.length} 家店铺。`,
        result: successCount > 0 ? 'success' : 'failure',
        operator: currentUser,
        ipAddress: resolveRequestIp(request),
      });

      if (successCount === 0) {
        return reply.code(502).send({
          message: '闲鱼真实议价会话同步失败，请检查网页登录态或 IM 接口状态。',
          successCount,
          totalCount: results.length,
          results,
        });
      }

      return {
        successCount,
        totalCount: results.length,
        results,
      };
    },
  );

  app.post(
    '/api/workspaces/:featureKey/bargain-sessions/:sessionId/evaluate',
    { preHandler: [authorizeWorkspace('manage')] },
    async (request, reply) => {
      const currentUser = (request as AppRequest).currentUser!;
      if (!ensurePrivilegedWriteAllowed(request, reply, currentUser, '触发 AI 议价评估')) {
        return;
      }

      const params = z
        .object({
          featureKey: z.string().min(1),
          sessionId: z.coerce.number().int().positive(),
        })
        .parse(request.params);
      const payload = db.evaluateAiBargainSession(params.featureKey, params.sessionId, {
        id: currentUser.id,
        displayName: currentUser.displayName,
      });
      if (!payload) {
        return reply.code(404).send({ message: '议价会话不存在或当前模块不支持自动议价' });
      }

      db.recordAuditLog({
        action: 'ai_bargain_evaluated',
        targetType: 'ai_bargain',
        targetId: String(params.sessionId),
        detail: `${currentUser.displayName} 触发AI 议价评估，结${payload.outcome}。`,
        result: 'success',
        operator: currentUser,
        ipAddress: resolveRequestIp(request),
      });
      return payload;
    },
  );

  app.post(
    '/api/workspaces/:featureKey/bargain-sessions/:sessionId/takeover',
    { preHandler: [authorizeWorkspace('manage')] },
    async (request, reply) => {
      const currentUser = (request as AppRequest).currentUser!;
      if (!ensurePrivilegedWriteAllowed(request, reply, currentUser, '人工接管议价会话')) {
        return;
      }

      const params = z
        .object({
          featureKey: z.string().min(1),
          sessionId: z.coerce.number().int().positive(),
        })
        .parse(request.params);
      const body = aiBargainTakeoverSchema.parse(request.body ?? {});
      const payload = db.updateAiBargainSessionTakeover(
        params.featureKey,
        params.sessionId,
        body.action,
        body.note,
        {
          id: currentUser.id,
          displayName: currentUser.displayName,
        },
      );
      if (!payload) {
        return reply.code(404).send({ message: '议价会话不存在' });
      }

      db.recordAuditLog({
        action: 'ai_bargain_takeover_updated',
        targetType: 'ai_bargain',
        targetId: String(params.sessionId),
        detail: `${currentUser.displayName}${body.action === 'takeover' ? '接管' : '释放'}AI 议价会话。`,
        result: 'success',
        operator: currentUser,
        ipAddress: resolveRequestIp(request),
      });
      return payload;
    },
  );

  app.post(
    '/api/workspaces/:featureKey/bargain-sessions/:sessionId/manual-decision',
    { preHandler: [authorizeWorkspace('manage')] },
    async (request, reply) => {
      const currentUser = (request as AppRequest).currentUser!;
      if (!ensurePrivilegedWriteAllowed(request, reply, currentUser, '发送人工议价结')) {
        return;
      }

      const params = z
        .object({
          featureKey: z.string().min(1),
          sessionId: z.coerce.number().int().positive(),
        })
        .parse(request.params);
      const body = aiBargainManualDecisionSchema.parse(request.body ?? {});
      const payload = db.sendAiBargainManualDecision(
        params.featureKey,
        params.sessionId,
        body.content,
        body.action,
        body.offerPrice ?? null,
        {
          id: currentUser.id,
          displayName: currentUser.displayName,
        },
      );
      if (!payload) {
        return reply.code(404).send({ message: '议价会话不存在' });
      }

      db.recordAuditLog({
        action: 'ai_bargain_manual_decision_sent',
        targetType: 'ai_bargain',
        targetId: String(params.sessionId),
        detail: `${currentUser.displayName} 提交了人工议价结${body.action}。`,
        result: 'success',
        operator: currentUser,
        ipAddress: resolveRequestIp(request),
      });
      return payload;
    },
  );

  app.post(
    '/api/workspaces/:featureKey/bargain-settings',
    { preHandler: [authorizeWorkspace('manage')] },
    async (request, reply) => {
      const currentUser = (request as AppRequest).currentUser!;
      if (!ensurePrivilegedWriteAllowed(request, reply, currentUser, '更新 AI 议价策略')) {
        return;
      }

      const params = z.object({ featureKey: z.string().min(1) }).parse(request.params);
      const body = aiBargainSettingsSchema.parse(request.body ?? {});
      const payload = db.updateAiBargainSettings(params.featureKey, body, {
        id: currentUser.id,
        displayName: currentUser.displayName,
      });
      if (!payload) {
        return reply.code(404).send({ message: 'AI 议价策略不存在' });
      }

      db.recordAuditLog({
        action: 'ai_bargain_settings_updated',
        targetType: 'ai_bargain',
        targetId: params.featureKey,
        detail: `${currentUser.displayName} 更新AI 议价策略。`,
        result: 'success',
        operator: currentUser,
        ipAddress: resolveRequestIp(request),
      });
      return { settings: payload };
    },
  );

  app.post(
    '/api/workspaces/:featureKey/bargain-strategies/:strategyId',
    { preHandler: [authorizeWorkspace('manage')] },
    async (request, reply) => {
      const currentUser = (request as AppRequest).currentUser!;
      if (!ensurePrivilegedWriteAllowed(request, reply, currentUser, '更新议价商品策略')) {
        return;
      }

      const params = z
        .object({
          featureKey: z.string().min(1),
          strategyId: z.coerce.number().int().positive(),
        })
        .parse(request.params);
      const body = aiBargainStrategySchema.parse(request.body ?? {});
      const payload = db.updateAiBargainStrategy(params.featureKey, params.strategyId, body);
      if (!payload) {
        return reply.code(404).send({ message: '议价策略不存在' });
      }

      db.recordAuditLog({
        action: 'ai_bargain_strategy_updated',
        targetType: 'ai_bargain',
        targetId: String(params.strategyId),
        detail: `${currentUser.displayName} 更新了议价商品策略。`,
        result: 'success',
        operator: currentUser,
        ipAddress: resolveRequestIp(request),
      });
      return payload;
    },
  );

  app.post(
    '/api/workspaces/:featureKey/bargain-templates/:templateId/enabled',
    { preHandler: [authorizeWorkspace('manage')] },
    async (request, reply) => {
      const currentUser = (request as AppRequest).currentUser!;
      if (!ensurePrivilegedWriteAllowed(request, reply, currentUser, '启停 AI 议价模板')) {
        return;
      }

      const params = z
        .object({
          featureKey: z.string().min(1),
          templateId: z.coerce.number().int().positive(),
        })
        .parse(request.params);
      const body = aiServiceEnabledSchema.parse(request.body ?? {});
      const payload = db.updateAiBargainTemplateEnabled(
        params.featureKey,
        params.templateId,
        body.enabled,
      );
      if (!payload) {
        return reply.code(404).send({ message: '议价模板不存在' });
      }

      db.recordAuditLog({
        action: 'ai_bargain_template_updated',
        targetType: 'ai_bargain',
        targetId: String(params.templateId),
        detail: `${currentUser.displayName}${body.enabled ? '启用' : '停用'}AI 议价模板。`,
        result: 'success',
        operator: currentUser,
        ipAddress: resolveRequestIp(request),
      });
      return payload;
    },
  );

  app.post(
    '/api/workspaces/:featureKey/bargain-blacklist/:blacklistId/enabled',
    { preHandler: [authorizeWorkspace('manage')] },
    async (request, reply) => {
      const currentUser = (request as AppRequest).currentUser!;
      if (!ensurePrivilegedWriteAllowed(request, reply, currentUser, '启停议价黑名')) {
        return;
      }

      const params = z
        .object({
          featureKey: z.string().min(1),
          blacklistId: z.coerce.number().int().positive(),
        })
        .parse(request.params);
      const body = aiServiceEnabledSchema.parse(request.body ?? {});
      const payload = db.updateAiBargainBlacklistEnabled(
        params.featureKey,
        params.blacklistId,
        body.enabled,
      );
      if (!payload) {
        return reply.code(404).send({ message: '议价黑名单条目不存在' });
      }

      db.recordAuditLog({
        action: 'ai_bargain_blacklist_updated',
        targetType: 'ai_bargain',
        targetId: String(params.blacklistId),
        detail: `${currentUser.displayName}${body.enabled ? '启用' : '停用'}了议价黑名单条目。`,
        result: 'success',
        operator: currentUser,
        ipAddress: resolveRequestIp(request),
      });
      return payload;
    },
  );

  if (fs.existsSync(runtimeConfig.webDistPath)) {
    await app.register(fastifyStatic, {
      root: runtimeConfig.webDistPath,
      prefix: '/',
    });


    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api')) {
        return reply.code(404).send({ message: '接口不存在' });
      }

      return reply.sendFile('index.html');
    });
  }

  // --- 第 17 轮：真实订单/商品数据后台定时同步串联 ---
  const autoDataSyncEnabled =
    runtimeConfig.runtimeMode !== 'demo' &&
    runtimeConfig.storeAuthMode === 'xianyu_web_session' &&
    !process.env.VITEST &&
    resolveBooleanEnv(process.env.APP_XIANYU_AUTO_DATA_SYNC_ENABLED, false);

  const autoDataSyncIntervalMs =
    Math.max(Number(process.env.APP_XIANYU_AUTO_DATA_SYNC_INTERVAL_SECONDS ?? 300), 60) * 1000;

  let autoDataSyncTimer: ReturnType<typeof setTimeout> | null = null;
  let autoDataSyncRunning = false;
  let autoDataSyncStopped = false;

  const runAutoDataSyncJob = async () => {
    if (autoDataSyncStopped || autoDataSyncRunning) {
      return;
    }

    autoDataSyncRunning = true;
    try {
      // 1. 同步商品
      const productTargets = db.listManagedStoreProductSyncTargets();
      for (const target of productTargets) {
        if (autoDataSyncStopped) break;
        try {
          const fetched = await xianyuWebSessionService.fetchXianyuWebSessionProducts({
            cookieText: target.cookieText,
            userId: target.providerUserId,
          });
          db.syncManagedStoreProducts({
            storeId: target.storeId,
            items: fetched.items.map((item) => ({
              id: item.id,
              title: item.title,
              categoryLabel: item.categoryLabel,
              price: item.price,
              stock: item.stock,
            })),
          });
          logger.info('auto_data_sync_products', `店铺 ${target.storeId} 商品同步完成`, { count: fetched.items.length });
        } catch (e) {
          logger.warn('auto_data_sync_products_error', `店铺 ${target.storeId} 商品同步失败`, { error: e });
        }
      }

      // 2. 同步订单
      const orderTargets = db.listManagedStoreOrderSyncTargets();
      for (const target of orderTargets) {
        if (autoDataSyncStopped) break;
        try {
          const fetchedList = await xianyuWebSessionService.fetchXianyuWebSessionSellerCompletedTrades({
            cookieText: target.cookieText,
            userId: target.providerUserId,
            maxPages: 1,
          });

          const detailedOrders = [];
          for (const trade of fetchedList.items.slice(0, 10)) { // 每次轮询最多只查最近的10单来保护接口
            try {
              const detail = await xianyuWebSessionService.fetchXianyuWebSessionCompletedOrderDetail({
                cookieText: target.cookieText,
                tradeId: trade.tradeId,
              });
              detailedOrders.push(detail);
            } catch (err) {
              logger.warn('auto_data_sync_orders_detail_error', `获取详情失败 ${trade.tradeId}`, { error: err });
            }
          }

          if (detailedOrders.length > 0) {
            db.syncManagedStoreOrders({
              storeId: target.storeId,
              orders: detailedOrders,
            });
            logger.info('auto_data_sync_orders', `店铺 ${target.storeId} 订单同步完成`, { count: detailedOrders.length });
          }
        } catch (e) {
          logger.warn('auto_data_sync_orders_error', `店铺 ${target.storeId} 订单列同步失败`, { error: e });
        }
      }
    } catch (error) {
      logger.error('auto_data_sync_fatal', '后台自动同步任务发生未捕获异常', { error });
    } finally {
      autoDataSyncRunning = false;
      if (!autoDataSyncStopped) {
        autoDataSyncTimer = setTimeout(() => {
          void runAutoDataSyncJob();
        }, autoDataSyncIntervalMs);
      }
    }
  };

  if (autoDataSyncEnabled) {
    logger.info('auto_data_sync_start', '已开启真实数据自动同步服务（商品与订单）', { intervalMs: autoDataSyncIntervalMs });
    autoDataSyncTimer = setTimeout(() => {
      void runAutoDataSyncJob();
    }, 15000); // 启动后 15 秒首次执行
  }

  app.addHook('onClose', async () => {
    autoDataSyncStopped = true;
    if (autoDataSyncTimer) {
      clearTimeout(autoDataSyncTimer);
      autoDataSyncTimer = null;
    }
  });

  // --- 第 21 轮：自动发货闭环建设配置接口 ---
  app.get(
    '/api/fulfillment/adapters',
    { preHandler: [authorizeRoles(routeAccessPolicy.products, 'products', '查看发货适配器配置')] },
    async () => {
      return {
        directChargeAdapters: [{ key: 'sim-topup', label: '标准模拟直充供应商' }],
        sourceSystemAdapters: [{ key: 'sim-own-supply', label: '标准模拟自有货源系统' }],
      };
    },
  );

  app.get(
    '/api/products/:productId/fulfillment-rule',
    { preHandler: [authorizeRoles(routeAccessPolicy.products, 'products', '查看发货规则')] },
    async (request) => {
      const params = z.object({ productId: z.coerce.number().int().positive() }).parse(request.params);
      return db.getProductFulfillmentRule(params.productId);
    },
  );

  const productFulfillmentRuleSchema = z
    .object({
      fulfillmentType: z.enum(['standard', 'direct_charge', 'source_system']),
      supplierId: z.string().trim().min(1).nullable().optional(),
      externalSku: z.string().trim().min(1).nullable().optional(),
    })
    .superRefine((value, ctx) => {
      if (value.fulfillmentType !== 'standard' && !value.supplierId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: '请选择供应通道',
          path: ['supplierId'],
        });
      }
      if (value.fulfillmentType === 'source_system' && !value.externalSku) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: '请输入外部 SKU',
          path: ['externalSku'],
        });
      }
    });

  app.post(
    '/api/products/:productId/fulfillment-rule',
    { preHandler: [authorizeRoles(routeAccessPolicy.products, 'products', '配置商品发货规则')] },
    async (request, reply) => {
      const currentUser = (request as AppRequest).currentUser!;
      if (!ensurePrivilegedWriteAllowed(request, reply, currentUser, '配置商品发货规则')) {
        return;
      }
      const params = z.object({ productId: z.coerce.number().int().positive() }).parse(request.params);
      const body = productFulfillmentRuleSchema.parse(request.body);

      db.upsertProductFulfillmentRule(params.productId, {
        fulfillmentType: body.fulfillmentType,
        supplierId: body.fulfillmentType === 'standard' ? null : body.supplierId ?? null,
        externalSku: body.fulfillmentType === 'source_system' ? body.externalSku ?? null : null,
      });

      db.recordAuditLog({
        action: 'product_fulfillment_rule_updated',
        targetType: 'product',
        targetId: String(params.productId),
        detail: `${currentUser.displayName} 为商品 ${params.productId} 修改发货规则为：${body.fulfillmentType}。`,
        result: 'success',
        operator: currentUser,
        ipAddress: resolveRequestIp(request),
      });

      return { success: true };
    },
  );
  // ------------------------------------------

  // --- 第 22 轮：发卡（卡密履约）专属模块 API ---
  app.get(
    '/api/cards/inventory',
    { preHandler: [authorizeRoles(routeAccessPolicy.manageFulfillment, 'manageFulfillment', '查看卡密库存')] },
    async (request) => {
      const sqlite = (db as any).db;
      // 联表查询：商品信息、卡密品类信息及库存数量
      const rows = sqlite.prepare(`
        SELECT p.id as productId, p.name as productName, p.category, 
               c.id as typeId, c.card_type_name as typeName,
               c.status as typeStatus,
               (SELECT COUNT(*) FROM card_inventory_items WHERE card_type_id = c.id AND item_status='unused') as unusedCount,
               (SELECT COUNT(*) FROM card_inventory_items WHERE card_type_id = c.id AND item_status='used') as usedCount
        FROM card_types c
        LEFT JOIN card_delivery_items cdi ON cdi.card_type_id = c.id
        LEFT JOIN products p ON cdi.product_id = p.id
        ORDER BY unusedCount ASC
      `).all();
      return { list: rows };
    }
  );

  app.post(
    '/api/cards/upload',
    { preHandler: [authorizeRoles(routeAccessPolicy.manageFulfillment, 'manageFulfillment', '导入卡密')] },
    async (request, reply) => {
      const currentUser = (request as AppRequest).currentUser!;
      if (!ensurePrivilegedWriteAllowed(request, reply, currentUser, '导入卡密')) return;
      const body = z.object({
        typeId: z.number().int().positive(),
        cards: z.array(z.object({
          no: z.string(),
          secret: z.string(),
        }))
      }).parse(request.body);

      const sqlite = (db as any).db;
      sqlite.transaction(() => {
        const batchStmt = sqlite.prepare(`INSERT INTO card_batches (card_type_id, import_batch_no, imported_count, imported_by_user_id, status, created_at) VALUES (?, ?, ?, ?, ?, datetime('now', 'localtime'))`);
        const batchInfo = batchStmt.run(body.typeId, 'BATCH-' + Date.now(), body.cards.length, currentUser.id, 'success');
        
        const insertStmt = sqlite.prepare(`INSERT INTO card_inventory_items (card_type_id, batch_id, card_no, card_secret, card_masked, item_status) VALUES (?, ?, ?, ?, ?, ?)`);
        for (const c of body.cards) {
          const masked = c.secret.length > 4 ? '***' + c.secret.slice(-4) : '***';
          insertStmt.run(body.typeId, batchInfo.lastInsertRowid, c.no, c.secret, masked, 'unused');
        }
      })();

      db.recordAuditLog({ action: 'card_inventory_imported', targetType: 'card', targetId: String(body.typeId), detail: `导入了 ${body.cards.length} 张卡密。 `, result: 'success', operator: currentUser, ipAddress: resolveRequestIp(request) });
      return { success: true, count: body.cards.length };
    }
  );
  // ------------------------------------------

  return app;
}
