// @ts-nocheck
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import type { DatabaseProvider } from './database-provider.js';
import type { StatisticsDatabase } from './database.js';
import {
  aiServiceEnabledSchema,
  aiServiceManualReplySchema,
  aiServiceSettingsSchema,
  aiServiceSyncSchema,
  aiServiceTakeoverSchema,
} from './schemas.js';
import * as xianyuWebSessionService from './xianyu-web-session.js';

interface WorkspaceAiServiceRouteDeps {
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
  syncAiServiceStoreTarget: (target: any, operator: any, options: any) => Promise<any>;
  sendAiServiceXianyuMessage: (payload: any) => Promise<void>;
  tryLlmReply: (featureKey: string, conversationId: number, operator: any) => Promise<any>;
}

export function registerWorkspaceAiServiceRoutes({
  app,
  db,
  databaseProvider,
  authorizeWorkspace,
  ensurePrivilegedWriteAllowed,
  resolveRequestIp,
  syncAiServiceStoreTarget,
  sendAiServiceXianyuMessage,
  tryLlmReply,
}: WorkspaceAiServiceRouteDeps) {
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
        'Tenant PostgreSQL AI service write completed but SQLite shadow mirror failed.',
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

  const sendTenantAwareAiServiceXianyuMessage = async (
    request: FastifyRequest,
    payload: {
      featureKey: string;
      conversationId: number;
      content: string;
    },
  ) => {
    const tenantAdapter = resolveTenantBusinessAdapter(request);
    const canUseTenantAdapter =
      tenantAdapter &&
      typeof tenantAdapter.getAiServiceConversationDispatchTarget === 'function' &&
      typeof tenantAdapter.getManagedStoreXianyuImSyncTarget === 'function' &&
      typeof tenantAdapter.markManagedStoreCredentialRenew === 'function' &&
      typeof tenantAdapter.saveManagedStoreXianyuImAuthCache === 'function' &&
      typeof tenantAdapter.clearManagedStoreXianyuImAuthCache === 'function';
    if (!canUseTenantAdapter) {
      return sendAiServiceXianyuMessage(payload);
    }

    const dispatchTarget = await tenantAdapter.getAiServiceConversationDispatchTarget(
      payload.featureKey,
      payload.conversationId,
    );
    if (!dispatchTarget) {
      return { delivered: false };
    }

    const storeTarget = await tenantAdapter.getManagedStoreXianyuImSyncTarget(dispatchTarget.storeId);
    if (!storeTarget) {
      throw new Error('The current conversation store does not have an available Xianyu web-session.');
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
        await tenantAdapter.clearManagedStoreXianyuImAuthCache(dispatchTarget.storeId);
        mirrorShadowWrite(request, 'clearManagedStoreXianyuImAuthCache', () =>
          db.clearManagedStoreXianyuImAuthCache(dispatchTarget.storeId),
        );
      }
      throw error;
    }

    if (sendResult.refreshedCookieText && sendResult.refreshedCookieText !== storeTarget.cookieText) {
      await tenantAdapter.markManagedStoreCredentialRenew(dispatchTarget.storeId, {
        cookieText: sendResult.refreshedCookieText,
        detail: 'AI service dispatch refreshed the Xianyu web-session credential.',
        renewed: true,
      });
      mirrorShadowWrite(request, 'markManagedStoreCredentialRenew', () =>
        db.markManagedStoreCredentialRenew(dispatchTarget.storeId, {
          cookieText: sendResult.refreshedCookieText,
          detail: 'AI service dispatch refreshed the Xianyu web-session credential.',
          renewed: true,
        }),
      );
    }
    if (sendResult.socketAuthCache) {
      await tenantAdapter.saveManagedStoreXianyuImAuthCache(
        dispatchTarget.storeId,
        sendResult.socketAuthCache,
        'ai_service_dispatch',
      );
      mirrorShadowWrite(request, 'saveManagedStoreXianyuImAuthCache', () =>
        db.saveManagedStoreXianyuImAuthCache(
          dispatchTarget.storeId,
          sendResult.socketAuthCache,
          'ai_service_dispatch',
        ),
      );
    } else if (sendResult.socketAuthCacheRejected) {
      await tenantAdapter.clearManagedStoreXianyuImAuthCache(dispatchTarget.storeId);
      mirrorShadowWrite(request, 'clearManagedStoreXianyuImAuthCache', () =>
        db.clearManagedStoreXianyuImAuthCache(dispatchTarget.storeId),
      );
    }

    return {
      delivered: true as const,
      sendResult,
    };
  };

  app.post(
    '/api/workspaces/:featureKey/service-sync',
    { preHandler: [authorizeWorkspace('manage')] },
    async (request, reply) => {
      const currentUser = request.currentUser;
      if (!ensurePrivilegedWriteAllowed(request, reply, currentUser, 'sync AI service conversations')) {
        return;
      }

      const params = z.object({ featureKey: z.string().min(1) }).parse(request.params);
      const body = aiServiceSyncSchema.parse(request.body ?? {});
      const tenantAdapter = resolveTenantBusinessAdapter(request);
      const canUseTenantAdapter =
        tenantAdapter &&
        typeof tenantAdapter.listManagedStoreAiBargainSyncTargets === 'function' &&
        typeof tenantAdapter.syncAiServiceConversationsFromXianyuIm === 'function';
      const targets = canUseTenantAdapter
        ? await tenantAdapter.listManagedStoreAiBargainSyncTargets(body.storeIds)
        : db.listManagedStoreAiBargainSyncTargets(body.storeIds);
      if (targets.length === 0) {
        return reply.code(409).send({ message: 'No active Xianyu web-session stores are available for sync.' });
      }

      const maxSessionsPerStore = Math.max(1, Math.min(50, Math.trunc(body.maxSessionsPerStore ?? 50)));
      const maxMessagesPerSession = Math.max(1, Math.min(50, Math.trunc(body.maxMessagesPerSession ?? 50)));
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
                  detail: 'AI service manual sync refreshed the Xianyu web-session credential.',
                  renewed: true,
                });
              }
              mirrorShadowWrite(request, 'markManagedStoreCredentialRenew', () =>
                db.markManagedStoreCredentialRenew(target.storeId, {
                  cookieText: fetched.refreshedCookieText,
                  detail: 'AI service manual sync refreshed the Xianyu web-session credential.',
                  renewed: true,
                }),
              );
            }
            if (fetched.socketAuthCache) {
              if (canSaveAuthCache) {
                await tenantAdapter.saveManagedStoreXianyuImAuthCache(
                  target.storeId,
                  fetched.socketAuthCache,
                  'ai_service_sync',
                );
              }
              mirrorShadowWrite(request, 'saveManagedStoreXianyuImAuthCache', () =>
                db.saveManagedStoreXianyuImAuthCache(
                  target.storeId,
                  fetched.socketAuthCache,
                  'ai_service_sync',
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

            const synced = await tenantAdapter.syncAiServiceConversationsFromXianyuIm({
              featureKey: params.featureKey,
              storeId: target.storeId,
              sessions: fetched.sessions,
              operator: {
                id: currentUser.id,
                displayName: currentUser.displayName,
              },
              syncSource: 'manual',
            });
            if (!synced) {
              results.push({
                storeId: target.storeId,
                shopName: target.shopName,
                providerUserId: target.providerUserId,
                success: false,
                message: 'AI service sync is unavailable for this tenant module.',
              });
              continue;
            }

            mirrorShadowWrite(request, 'syncAiServiceConversationsFromXianyuIm', () =>
              db.syncAiServiceConversationsFromXianyuIm({
                featureKey: params.featureKey,
                storeId: target.storeId,
                sessions: fetched.sessions,
                operator: {
                  id: currentUser.id,
                  displayName: currentUser.displayName,
                },
                syncSource: 'manual',
              }),
            );

            results.push({
              ...synced,
              providerUserId: target.providerUserId,
              success: true,
              message:
                synced.candidateSessionCount === 0
                  ? 'No buyer sessions qualified for AI service import in this run.'
                  : undefined,
            });
            continue;
          }

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
            message: error instanceof Error ? error.message : 'AI service sync failed.',
          });
        }
      }

      const successCount = results.filter((item) => item.success).length;
      await recordTenantAwareAuditLog(request, {
        action: 'xianyu_ai_service_synced',
        targetType: 'ai_service',
        targetId: body.storeIds?.length ? body.storeIds.join(',') : 'all-active-xianyu',
        detail: `${currentUser.displayName} ran AI service sync with ${successCount}/${results.length} successful stores.`,
        result: successCount > 0 ? 'success' : 'failure',
        operator: currentUser,
        ipAddress: resolveRequestIp(request),
      });

      if (successCount === 0) {
        return reply.code(502).send({
          message: 'AI service sync failed for all stores. Check the web-session or IM connection state.',
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
      const currentUser = request.currentUser;
      if (!ensurePrivilegedWriteAllowed(request, reply, currentUser, 'trigger AI service reply')) {
        return;
      }

      const params = z
        .object({
          featureKey: z.string().min(1),
          conversationId: z.coerce.number().int().positive(),
        })
        .parse(request.params);

      const tenantAdapter = resolveTenantBusinessAdapter(request);
      const llmReply = await tryLlmReply(params.featureKey, params.conversationId, {
        id: currentUser.id,
        displayName: currentUser.displayName,
      });

      const payload = llmReply
        ? tenantAdapter && typeof tenantAdapter.writeAiServiceLlmReply === 'function'
          ? (await tenantAdapter.writeAiServiceLlmReply(
              params.featureKey,
              params.conversationId,
              llmReply.content,
              {
                id: currentUser.id,
                displayName: currentUser.displayName,
              },
            )) ?? {
              reused: false,
              replyType: 'ai',
              conversationStatus: 'open',
              aiStatus: 'auto_replied',
              content: llmReply.content,
            }
          : {
              reused: false,
              replyType: 'ai',
              conversationStatus: 'open',
              aiStatus: 'auto_replied',
              content: llmReply.content,
            }
        : tenantAdapter && typeof tenantAdapter.generateAiServiceReply === 'function'
          ? (await tenantAdapter.generateAiServiceReply(params.featureKey, params.conversationId, {
              id: currentUser.id,
              displayName: currentUser.displayName,
            })) ??
            db.generateAiServiceReply(params.featureKey, params.conversationId, {
              id: currentUser.id,
              displayName: currentUser.displayName,
            })
          : db.generateAiServiceReply(params.featureKey, params.conversationId, {
              id: currentUser.id,
              displayName: currentUser.displayName,
            });

      if (!payload) {
        return reply.code(404).send({ message: 'Conversation not found or AI reply is unavailable for this module.' });
      }

      if (!llmReply && tenantAdapter && typeof tenantAdapter.generateAiServiceReply === 'function') {
        mirrorShadowWrite(request, 'generateAiServiceReply', () =>
          db.generateAiServiceReply(params.featureKey, params.conversationId, {
            id: currentUser.id,
            displayName: currentUser.displayName,
          }),
        );
      }

      if (!payload.reused && payload.replyType === 'ai') {
        try {
          await sendTenantAwareAiServiceXianyuMessage(request, {
            featureKey: params.featureKey,
            conversationId: params.conversationId,
            content: payload.content,
          });
          if (
            tenantAdapter &&
            typeof tenantAdapter.updateAiServiceLatestOutboundMessageStatus === 'function'
          ) {
            await tenantAdapter.updateAiServiceLatestOutboundMessageStatus(
              params.featureKey,
              params.conversationId,
              'ai',
              'sent',
            );
            mirrorShadowWrite(request, 'updateAiServiceLatestOutboundMessageStatus:sent', () =>
              db.updateAiServiceLatestOutboundMessageStatus(params.featureKey, params.conversationId, 'ai', 'sent'),
            );
          } else {
            db.updateAiServiceLatestOutboundMessageStatus(params.featureKey, params.conversationId, 'ai', 'sent');
          }
        } catch (error) {
          if (
            tenantAdapter &&
            typeof tenantAdapter.updateAiServiceLatestOutboundMessageStatus === 'function'
          ) {
            await tenantAdapter.updateAiServiceLatestOutboundMessageStatus(
              params.featureKey,
              params.conversationId,
              'ai',
              'failed',
            );
            mirrorShadowWrite(request, 'updateAiServiceLatestOutboundMessageStatus:failed', () =>
              db.updateAiServiceLatestOutboundMessageStatus(params.featureKey, params.conversationId, 'ai', 'failed'),
            );
          } else {
            db.updateAiServiceLatestOutboundMessageStatus(params.featureKey, params.conversationId, 'ai', 'failed');
          }
          return reply.code(502).send({
            message: error instanceof Error ? error.message : 'Failed to send the AI reply to Xianyu.',
          });
        }
      }

      await recordTenantAwareAuditLog(request, {
        action: 'ai_service_reply_generated',
        targetType: 'ai_service',
        targetId: String(params.conversationId),
        detail: `${currentUser.displayName} generated an AI service reply using ${
          llmReply ? 'llm' : 'rule-engine'
        } mode, reply type ${payload.replyType}.`,
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
      const currentUser = request.currentUser;
      if (!ensurePrivilegedWriteAllowed(request, reply, currentUser, 'take over AI conversation')) {
        return;
      }

      const params = z
        .object({
          featureKey: z.string().min(1),
          conversationId: z.coerce.number().int().positive(),
        })
        .parse(request.params);
      const body = aiServiceTakeoverSchema.parse(request.body ?? {});
      const tenantAdapter = resolveTenantBusinessAdapter(request);
      const canUseTenantAdapter =
        tenantAdapter && typeof tenantAdapter.updateAiServiceConversationTakeover === 'function';
      const payload = canUseTenantAdapter
        ? await tenantAdapter.updateAiServiceConversationTakeover(
            params.featureKey,
            params.conversationId,
            body.action,
            body.note,
            {
              id: currentUser.id,
              displayName: currentUser.displayName,
            },
          )
        : db.updateAiServiceConversationTakeover(
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
        return reply.code(404).send({ message: 'Conversation not found.' });
      }

      if (canUseTenantAdapter) {
        mirrorShadowWrite(request, 'updateAiServiceConversationTakeover', () =>
          db.updateAiServiceConversationTakeover(
            params.featureKey,
            params.conversationId,
            body.action,
            body.note,
            {
              id: currentUser.id,
              displayName: currentUser.displayName,
            },
          ),
        );
      }

      await recordTenantAwareAuditLog(request, {
        action: 'ai_service_takeover_updated',
        targetType: 'ai_service',
        targetId: String(params.conversationId),
        detail: `${currentUser.displayName} ${body.action === 'takeover' ? 'took over' : 'released'} an AI service conversation.`,
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
      const currentUser = request.currentUser;
      if (!ensurePrivilegedWriteAllowed(request, reply, currentUser, 'send manual AI reply')) {
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
        await sendTenantAwareAiServiceXianyuMessage(request, {
          featureKey: params.featureKey,
          conversationId: params.conversationId,
          content: body.content,
        });
      } catch (error) {
        return reply.code(502).send({
          message: error instanceof Error ? error.message : 'Failed to send the manual reply to Xianyu.',
        });
      }

      const tenantAdapter = resolveTenantBusinessAdapter(request);
      const canUseTenantAdapter =
        tenantAdapter && typeof tenantAdapter.sendAiServiceManualReply === 'function';
      const payload = canUseTenantAdapter
        ? await tenantAdapter.sendAiServiceManualReply(
            params.featureKey,
            params.conversationId,
            body.content,
            body.closeConversation,
            {
              id: currentUser.id,
              displayName: currentUser.displayName,
            },
          )
        : db.sendAiServiceManualReply(
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
        return reply.code(404).send({ message: 'Conversation not found.' });
      }

      if (canUseTenantAdapter) {
        mirrorShadowWrite(request, 'sendAiServiceManualReply', () =>
          db.sendAiServiceManualReply(
            params.featureKey,
            params.conversationId,
            body.content,
            body.closeConversation,
            {
              id: currentUser.id,
              displayName: currentUser.displayName,
            },
          ),
        );
      }

      await recordTenantAwareAuditLog(request, {
        action: 'ai_service_manual_reply_sent',
        targetType: 'ai_service',
        targetId: String(params.conversationId),
        detail: `${currentUser.displayName} sent a manual AI service reply.`,
        result: 'success',
        operator: currentUser,
        ipAddress: resolveRequestIp(request),
      });
      return payload;
    },
  );

  app.post('/api/workspaces/:featureKey/settings', { preHandler: [authorizeWorkspace('manage')] }, async (request, reply) => {
    const currentUser = request.currentUser;
    if (!ensurePrivilegedWriteAllowed(request, reply, currentUser, 'update AI service settings')) {
      return;
    }

    const params = z.object({ featureKey: z.string().min(1) }).parse(request.params);
    const body = aiServiceSettingsSchema.parse(request.body ?? {});
    const tenantAdapter = resolveTenantBusinessAdapter(request);
    const canUseTenantAdapter =
      tenantAdapter && typeof tenantAdapter.updateAiServiceSettings === 'function';
    const payload = canUseTenantAdapter
      ? await tenantAdapter.updateAiServiceSettings(params.featureKey, body, {
          id: currentUser.id,
          displayName: currentUser.displayName,
        })
      : db.updateAiServiceSettings(params.featureKey, body, {
          id: currentUser.id,
          displayName: currentUser.displayName,
        });
    if (!payload) {
      return reply.code(404).send({ message: 'AI service settings not found.' });
    }

    if (canUseTenantAdapter) {
      mirrorShadowWrite(request, 'updateAiServiceSettings', () =>
        db.updateAiServiceSettings(params.featureKey, body, {
          id: currentUser.id,
          displayName: currentUser.displayName,
        }),
      );
    }

    await recordTenantAwareAuditLog(request, {
      action: 'ai_service_settings_updated',
      targetType: 'ai_service',
      targetId: params.featureKey,
      detail: `${currentUser.displayName} updated AI service settings.`,
      result: 'success',
      operator: currentUser,
      ipAddress: resolveRequestIp(request),
    });
    return { settings: payload };
  });

  app.post(
    '/api/workspaces/:featureKey/knowledge-items/:knowledgeItemId/enabled',
    { preHandler: [authorizeWorkspace('manage')] },
    async (request, reply) => {
      const currentUser = request.currentUser;
      if (!ensurePrivilegedWriteAllowed(request, reply, currentUser, 'toggle AI knowledge item')) {
        return;
      }

      const params = z
        .object({
          featureKey: z.string().min(1),
          knowledgeItemId: z.coerce.number().int().positive(),
        })
        .parse(request.params);
      const body = aiServiceEnabledSchema.parse(request.body ?? {});
    const tenantAdapter = resolveTenantBusinessAdapter(request);
    const canUseTenantAdapter =
      tenantAdapter && typeof tenantAdapter.updateAiServiceKnowledgeItemEnabled === 'function';
    const payload = canUseTenantAdapter
      ? await tenantAdapter.updateAiServiceKnowledgeItemEnabled(
          params.featureKey,
          params.knowledgeItemId,
            body.enabled,
          )
        : db.updateAiServiceKnowledgeItemEnabled(params.featureKey, params.knowledgeItemId, body.enabled);
      if (!payload) {
        return reply.code(404).send({ message: 'Knowledge item not found.' });
      }

    if (canUseTenantAdapter) {
      mirrorShadowWrite(request, 'updateAiServiceKnowledgeItemEnabled', () =>
        db.updateAiServiceKnowledgeItemEnabled(params.featureKey, params.knowledgeItemId, body.enabled),
      );
      }

      await recordTenantAwareAuditLog(request, {
        action: 'ai_service_knowledge_updated',
        targetType: 'ai_service',
        targetId: String(params.knowledgeItemId),
        detail: `${currentUser.displayName} ${body.enabled ? 'enabled' : 'disabled'} an AI knowledge item.`,
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
      const currentUser = request.currentUser;
      if (!ensurePrivilegedWriteAllowed(request, reply, currentUser, 'toggle AI reply template')) {
        return;
      }

      const params = z
        .object({
          featureKey: z.string().min(1),
          templateId: z.coerce.number().int().positive(),
        })
        .parse(request.params);
      const body = aiServiceEnabledSchema.parse(request.body ?? {});
    const tenantAdapter = resolveTenantBusinessAdapter(request);
    const canUseTenantAdapter =
      tenantAdapter && typeof tenantAdapter.updateAiServiceReplyTemplateEnabled === 'function';
    const payload = canUseTenantAdapter
      ? await tenantAdapter.updateAiServiceReplyTemplateEnabled(
          params.featureKey,
          params.templateId,
            body.enabled,
          )
        : db.updateAiServiceReplyTemplateEnabled(params.featureKey, params.templateId, body.enabled);
      if (!payload) {
        return reply.code(404).send({ message: 'Reply template not found.' });
      }

    if (canUseTenantAdapter) {
      mirrorShadowWrite(request, 'updateAiServiceReplyTemplateEnabled', () =>
        db.updateAiServiceReplyTemplateEnabled(params.featureKey, params.templateId, body.enabled),
      );
      }

      await recordTenantAwareAuditLog(request, {
        action: 'ai_service_template_updated',
        targetType: 'ai_service',
        targetId: String(params.templateId),
        detail: `${currentUser.displayName} ${body.enabled ? 'enabled' : 'disabled'} an AI reply template.`,
        result: 'success',
        operator: currentUser,
        ipAddress: resolveRequestIp(request),
      });
      return payload;
    },
  );
}
