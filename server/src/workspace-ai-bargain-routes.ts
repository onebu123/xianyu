// @ts-nocheck
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import type { DatabaseProvider } from './database-provider.js';
import type { StatisticsDatabase } from './database.js';
import {
  aiBargainManualDecisionSchema,
  aiBargainSettingsSchema,
  aiBargainStrategySchema,
  aiBargainSyncSchema,
  aiBargainTakeoverSchema,
  aiServiceEnabledSchema,
} from './schemas.js';
import * as xianyuWebSessionService from './xianyu-web-session.js';

interface WorkspaceAiBargainRouteDeps {
  app: FastifyInstance;
  db: StatisticsDatabase;
  databaseProvider?: DatabaseProvider;
  authorizeWorkspace: (mode: 'view' | 'manage') => unknown;
  ensurePrivilegedWriteAllowed: (
    request: FastifyRequest,
    reply: FastifyReply,
    currentUser: any,
    actionLabel: string,
  ) => boolean;
  resolveRequestIp: (request: FastifyRequest) => string;
  syncAiBargainStoreTarget: (target: any, operator: any, options: any) => Promise<any>;
}

export function registerWorkspaceAiBargainRoutes({
  app,
  db,
  databaseProvider,
  authorizeWorkspace,
  ensurePrivilegedWriteAllowed,
  resolveRequestIp,
  syncAiBargainStoreTarget,
}: WorkspaceAiBargainRouteDeps) {
  const resolveTenantBusinessAdapter = (request: FastifyRequest) => {
    const tenant = request.currentTenant;
    if (!tenant || !databaseProvider?.isTenantBusinessPostgresEnabled()) {
      return null;
    }
    return databaseProvider.getTenantBusinessReadAdapter(tenant);
  };

  const mirrorShadowWrite = (request: FastifyRequest, operation: string, action: () => unknown) => {
    try {
      return action();
    } catch (error) {
      request.log.warn(
        { err: error, operation },
        'Tenant PostgreSQL AI bargain write completed but SQLite shadow mirror failed.',
      );
      return null;
    }
  };

  const recordTenantAwareAuditLog = async (
    request: FastifyRequest,
    input: Parameters<StatisticsDatabase['recordAuditLog']>[0],
  ) => {
    const tenantAdapter = resolveTenantBusinessAdapter(request);
    if (tenantAdapter && typeof tenantAdapter.recordAuditLog === 'function') {
      await tenantAdapter.recordAuditLog(input);
      mirrorShadowWrite(request, `audit:${input.action}`, () => db.recordAuditLog(input));
      return;
    }
    db.recordAuditLog(input);
  };

  app.post('/api/workspaces/:featureKey/bargain-sync', { preHandler: [authorizeWorkspace('manage')] }, async (request, reply) => {
    const currentUser = request.currentUser;
    if (!ensurePrivilegedWriteAllowed(request, reply, currentUser, '同步 AI 议价真实会话')) {
      return;
    }

    const params = z.object({ featureKey: z.string().min(1) }).parse(request.params);
    const body = aiBargainSyncSchema.parse(request.body ?? {});
    const tenantAdapter = resolveTenantBusinessAdapter(request);
    const canUseTenantAdapter =
      tenantAdapter &&
      typeof tenantAdapter.listManagedStoreAiBargainSyncTargets === 'function' &&
      typeof tenantAdapter.syncAiBargainSessionsFromXianyuIm === 'function';
    const targets = canUseTenantAdapter
      ? await tenantAdapter.listManagedStoreAiBargainSyncTargets(body.storeIds)
      : db.listManagedStoreAiBargainSyncTargets(body.storeIds);
    if (targets.length === 0) {
      return reply.code(409).send({ message: '当前没有可同步的已激活闲鱼网页登录态店铺。' });
    }

    const maxSessionsPerStore = Math.max(1, Math.min(50, Math.trunc(body.maxSessionsPerStore ?? 20)));
    const maxMessagesPerSession = Math.max(1, Math.min(50, Math.trunc(body.maxMessagesPerSession ?? 20)));
    const results = [];
    for (const target of targets) {
      try {
        if (canUseTenantAdapter) {
          const canRenewManagedStoreCredential =
            typeof tenantAdapter.markManagedStoreCredentialRenew === 'function';
          const canSaveAuthCache =
            typeof tenantAdapter.saveManagedStoreXianyuImAuthCache === 'function';
          const canClearAuthCache =
            typeof tenantAdapter.clearManagedStoreXianyuImAuthCache === 'function';
          const fetched = await xianyuWebSessionService.fetchXianyuWebSessionBargainSessions({
            cookieText: target.cookieText,
            maxSessions: maxSessionsPerStore,
            maxMessagesPerSession,
            cachedSocketAuth: target.cachedSocketAuth ?? null,
          });

          if (fetched.refreshedCookieText && fetched.refreshedCookieText !== target.cookieText) {
            if (canRenewManagedStoreCredential) {
              await tenantAdapter.markManagedStoreCredentialRenew(target.storeId, {
                cookieText: fetched.refreshedCookieText,
                detail: 'AI bargain manual sync refreshed the Xianyu web-session credential.',
                renewed: true,
              });
            }
            mirrorShadowWrite(request, 'markManagedStoreCredentialRenew', () =>
              db.markManagedStoreCredentialRenew(target.storeId, {
                cookieText: fetched.refreshedCookieText,
                detail: 'AI bargain manual sync refreshed the Xianyu web-session credential.',
                renewed: true,
              }),
            );
          }
          if (fetched.socketAuthCache) {
            if (canSaveAuthCache) {
              await tenantAdapter.saveManagedStoreXianyuImAuthCache(
                target.storeId,
                fetched.socketAuthCache,
                'ai_bargain_sync',
              );
            }
            mirrorShadowWrite(request, 'saveManagedStoreXianyuImAuthCache', () =>
              db.saveManagedStoreXianyuImAuthCache(
                target.storeId,
                fetched.socketAuthCache,
                'ai_bargain_sync',
              ),
            );
          } else if (fetched.socketAuthCacheRejected) {
            if (canClearAuthCache) {
              await tenantAdapter.clearManagedStoreXianyuImAuthCache(target.storeId);
            }
            mirrorShadowWrite(request, 'clearManagedStoreXianyuImAuthCache', () =>
              db.clearManagedStoreXianyuImAuthCache(target.storeId),
            );
          }

          const synced = await tenantAdapter.syncAiBargainSessionsFromXianyuIm({
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
              message: 'AI bargain sync is unavailable for this tenant module.',
            });
            continue;
          }

          mirrorShadowWrite(request, 'syncAiBargainSessionsFromXianyuIm', () =>
            db.syncAiBargainSessionsFromXianyuIm({
              featureKey: params.featureKey,
              storeId: target.storeId,
              sessions: fetched.sessions,
              operator: {
                id: currentUser.id,
                displayName: currentUser.displayName,
              },
            }),
          );

          results.push({
            ...synced,
            providerUserId: target.providerUserId,
            success: true,
            message:
              synced.candidateSessionCount === 0
                ? 'No buyer sessions qualified for AI bargain import in this run.'
                : undefined,
          });
          continue;
        }

        results.push(
          await syncAiBargainStoreTarget(
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
      } catch (error) {
        if (error instanceof Error && 'socketAuthCacheRejected' in error && error.socketAuthCacheRejected) {
          if (
            canUseTenantAdapter &&
            typeof tenantAdapter.clearManagedStoreXianyuImAuthCache === 'function'
          ) {
            await tenantAdapter.clearManagedStoreXianyuImAuthCache(target.storeId);
          }
          mirrorShadowWrite(request, 'clearManagedStoreXianyuImAuthCache', () =>
            db.clearManagedStoreXianyuImAuthCache(target.storeId),
          );
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
    await recordTenantAwareAuditLog(request, {
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
  });

  app.post('/api/workspaces/:featureKey/bargain-sessions/:sessionId/evaluate', { preHandler: [authorizeWorkspace('manage')] }, async (request, reply) => {
    const currentUser = request.currentUser;
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
  });

  app.post('/api/workspaces/:featureKey/bargain-sessions/:sessionId/takeover', { preHandler: [authorizeWorkspace('manage')] }, async (request, reply) => {
    const currentUser = request.currentUser;
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
    const payload = db.updateAiBargainSessionTakeover(params.featureKey, params.sessionId, body.action, body.note, {
      id: currentUser.id,
      displayName: currentUser.displayName,
    });
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
  });

  app.post('/api/workspaces/:featureKey/bargain-sessions/:sessionId/manual-decision', { preHandler: [authorizeWorkspace('manage')] }, async (request, reply) => {
    const currentUser = request.currentUser;
    if (!ensurePrivilegedWriteAllowed(request, reply, currentUser, '发送人工议价结果')) {
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
  });

  app.post('/api/workspaces/:featureKey/bargain-settings', { preHandler: [authorizeWorkspace('manage')] }, async (request, reply) => {
    const currentUser = request.currentUser;
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
  });

  app.post('/api/workspaces/:featureKey/bargain-strategies/:strategyId', { preHandler: [authorizeWorkspace('manage')] }, async (request, reply) => {
    const currentUser = request.currentUser;
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
  });

  app.post('/api/workspaces/:featureKey/bargain-templates/:templateId/enabled', { preHandler: [authorizeWorkspace('manage')] }, async (request, reply) => {
    const currentUser = request.currentUser;
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
    const payload = db.updateAiBargainTemplateEnabled(params.featureKey, params.templateId, body.enabled);
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
  });

  app.post('/api/workspaces/:featureKey/bargain-blacklist/:blacklistId/enabled', { preHandler: [authorizeWorkspace('manage')] }, async (request, reply) => {
    const currentUser = request.currentUser;
    if (!ensurePrivilegedWriteAllowed(request, reply, currentUser, '启停议价黑名单')) {
      return;
    }

    const params = z
      .object({
        featureKey: z.string().min(1),
        blacklistId: z.coerce.number().int().positive(),
      })
      .parse(request.params);
    const body = aiServiceEnabledSchema.parse(request.body ?? {});
    const payload = db.updateAiBargainBlacklistEnabled(params.featureKey, params.blacklistId, body.enabled);
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
  });
}
