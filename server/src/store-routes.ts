// @ts-nocheck
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { routeAccessPolicy } from './access-control.js';
import type { DatabaseProvider } from './database-provider.js';
import type { StatisticsDatabase } from './database.js';
import {
  storeAuthCompleteSchema,
  storeAuthProfileSyncSchema,
  storeAuthSessionSchema,
  storeAuthWebSessionSyncSchema,
  storeBatchHealthCheckSchema,
  storeBatchStatusSchema,
  storeBrowserRenewSchema,
  storeEnabledSchema,
  storeMetaUpdateSchema,
} from './schemas.js';

interface StoreRouteDeps {
  app: FastifyInstance;
  db: StatisticsDatabase;
  databaseProvider: DatabaseProvider;
  authorizeRoles: (requiredRoles: string[], resourceKey: string, actionLabel: string) => unknown;
  ensurePrivilegedWriteAllowed: (
    request: FastifyRequest,
    reply: FastifyReply,
    currentUser: any,
    actionLabel: string,
  ) => boolean;
  resolveRequestIp: (request: FastifyRequest) => string;
  hitRateLimit: (key: string, limit: number, windowMinutes: number) => { allowed: boolean };
  processStoreAuthProviderCallback: (
    request: FastifyRequest,
    reply: FastifyReply,
    input: { operator?: any; sourceLabel: string },
  ) => Promise<any>;
  buildStoreAuthSessionLiveSnapshot: (sessionId: string) => any;
  publishStoreAuthSessionLiveSnapshot: (sessionId: string) => void;
  storeAuthLiveStreamManager: any;
  xianyuWebSessionService: any;
  runStoreHealthCheck: (storeId: number, input: any) => Promise<any>;
  runBatchStoreHealthChecks: (storeIds: number[], operatorUserId: number) => Promise<any>;
  verifyManagedStoreCredential: (storeId: number, input: any) => Promise<any>;
  renewManagedStoreCredentialViaBrowser: (storeId: number, input: any) => Promise<any>;
}

const authSessionParamsSchema = z.object({ sessionId: z.string().uuid() });
const storeIdParamsSchema = z.object({ storeId: z.coerce.number().int().positive() });

export function registerStoreRoutes({
  app,
  db,
  databaseProvider,
  authorizeRoles,
  ensurePrivilegedWriteAllowed,
  resolveRequestIp,
  hitRateLimit,
  processStoreAuthProviderCallback,
  buildStoreAuthSessionLiveSnapshot,
  publishStoreAuthSessionLiveSnapshot,
  storeAuthLiveStreamManager,
  xianyuWebSessionService,
  runStoreHealthCheck,
  runBatchStoreHealthChecks,
  verifyManagedStoreCredential,
  renewManagedStoreCredentialViaBrowser,
}: StoreRouteDeps) {
  const resolveTenantBusinessRead = async (
    request: FastifyRequest,
    capability: string,
    args: unknown[],
    fallback: () => unknown,
  ) => {
    const tenant = request.currentTenant;
    if (!tenant || !databaseProvider.isTenantBusinessPostgresEnabled()) {
      return fallback();
    }

    const adapter = databaseProvider.getTenantBusinessReadAdapter(tenant);
    if (!adapter || typeof adapter[capability] !== 'function') {
      app.log.warn(
        {
          event: 'tenant_business_read_adapter_capability_missing',
          capability,
          tenantId: tenant.id,
          route: request.url,
        },
        'Tenant PostgreSQL read capability missing, falling back to SQLite shadow storage.',
      );
      return fallback();
    }

    try {
      return await adapter[capability](...args);
    } catch (error) {
      app.log.warn(
        {
          event: 'tenant_business_read_adapter_failed',
          capability,
          tenantId: tenant.id,
          route: request.url,
          error,
        },
        'Tenant PostgreSQL read capability failed, falling back to SQLite shadow storage.',
      );
      return fallback();
    }
  };

  const resolveTenantBusinessAdapter = (request: FastifyRequest) => {
    const tenant = request.currentTenant;
    if (!tenant || !databaseProvider.isTenantBusinessPostgresEnabled()) {
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
        'Tenant PostgreSQL store write completed but SQLite shadow mirror failed.',
      );
      return null;
    }
  };

  const resolveTenantBusinessWrite = async (
    request: FastifyRequest,
    capability: string,
    args: unknown[],
    fallback: () => unknown,
  ) => {
    const adapter = resolveTenantBusinessAdapter(request);
    if (!adapter || typeof adapter[capability] !== 'function') {
      return {
        payload: fallback(),
        tenantAdapter: null,
      };
    }

    try {
      return {
        payload: await adapter[capability](...args),
        tenantAdapter: adapter,
      };
    } catch (error) {
      app.log.warn(
        {
          event: 'tenant_business_write_adapter_failed',
          capability,
          tenantId: request.currentTenant?.id ?? null,
          route: request.url,
          error,
        },
        'Tenant PostgreSQL write failed, falling back to SQLite shadow storage.',
      );
      return {
        payload: fallback(),
        tenantAdapter: null,
      };
    }
  };

  const executeTenantBusinessWriteWithShadow = async (
    request: FastifyRequest,
    capability: string,
    args: unknown[],
    operation: string,
    fallback: () => unknown,
  ) => {
    const result = await resolveTenantBusinessWrite(request, capability, args, fallback);
    if (result.tenantAdapter && result.payload) {
      mirrorShadowWrite(request, operation, fallback);
    }
    return result.payload;
  };

  const recordTenantAwareAuditLog = async (
    request: FastifyRequest,
    input: Parameters<StatisticsDatabase['recordAuditLog']>[0],
  ) => {
    const adapter = resolveTenantBusinessAdapter(request);
    if (adapter && typeof adapter.recordAuditLog === 'function') {
      await adapter.recordAuditLog(input);
      mirrorShadowWrite(request, `audit:${input.action}`, () => db.recordAuditLog(input));
      return;
    }
    db.recordAuditLog(input);
  };

  const recordTenantAwareStoreCredentialEvent = async (
    request: FastifyRequest,
    input: Parameters<StatisticsDatabase['recordStoreCredentialEvent']>[0],
  ) => {
    const adapter = resolveTenantBusinessAdapter(request);
    if (adapter && typeof adapter.recordStoreCredentialEventEntry === 'function') {
      await adapter.recordStoreCredentialEventEntry(input);
      mirrorShadowWrite(request, `credential-event:${input.eventType}`, () =>
        db.recordStoreCredentialEvent(input),
      );
      return;
    }
    db.recordStoreCredentialEvent(input);
  };

  const buildTenantAwareStoreAuthSessionLiveSnapshot = async (
    request: FastifyRequest,
    sessionId: string,
  ) => {
    const fallbackSnapshot = buildStoreAuthSessionLiveSnapshot(sessionId);
    const tenant = request.currentTenant;
    if (!tenant || !databaseProvider.isTenantBusinessPostgresEnabled()) {
      return fallbackSnapshot;
    }

    const sessionDetail = await resolveTenantBusinessRead(
      request,
      'getStoreAuthSessionDetail',
      [sessionId],
      () => fallbackSnapshot?.sessionDetail ?? db.getStoreAuthSessionDetail(sessionId),
    );
    if (!sessionDetail) {
      return fallbackSnapshot;
    }

    const credentialEventsPayload = await resolveTenantBusinessRead(
      request,
      'getStoreCredentialEventsBySession',
      [sessionId],
      () =>
        fallbackSnapshot
          ? {
              sessionId,
              storeId: fallbackSnapshot.sessionDetail?.storeId ?? null,
              storeName: fallbackSnapshot.sessionDetail?.storeName ?? null,
              events: fallbackSnapshot.credentialEvents ?? [],
            }
          : db.getStoreCredentialEventsBySession(sessionId),
    );

    return {
      sessionId,
      sessionDetail,
      qrSession:
        fallbackSnapshot?.qrSession ?? xianyuWebSessionService.xianyuQrLoginManager.getByAuthSessionId(sessionId),
      credentialEvents: credentialEventsPayload?.events ?? fallbackSnapshot?.credentialEvents ?? [],
    };
  };

  app.get(
    '/api/stores/management',
    { preHandler: [authorizeRoles(routeAccessPolicy.stores, 'stores', '查看店铺管理')] },
    async (request) =>
      resolveTenantBusinessRead(request, 'getStoreManagementOverview', [], () =>
        db.getStoreManagementOverview(),
      ),
  );

  app.post(
    '/api/stores/auth-sessions',
    { preHandler: [authorizeRoles(routeAccessPolicy.manageStores, 'stores', '创建店铺授权')] },
    async (request, reply) => {
      const currentUser = request.currentUser;
      if (!ensurePrivilegedWriteAllowed(request, reply, currentUser, '创建店铺授权')) {
        return;
      }

      const body = storeAuthSessionSchema.parse(request.body);
      const createInput = {
        platform: body.platform,
        source: body.source,
        authType: body.authType,
        storeId: body.storeId,
        createdByUserId: currentUser.id,
      };
      const { payload, tenantAdapter } = await resolveTenantBusinessWrite(
        request,
        'createStoreAuthSession',
        [createInput],
        () => db.createStoreAuthSession(createInput),
      );
      const shadowPayload =
        tenantAdapter && payload?.shadowSeed
          ? mirrorShadowWrite(request, 'createStoreAuthSession', () =>
              db.createStoreAuthSession({
                ...createInput,
                seed: payload.shadowSeed,
              }),
            )
          : null;
      const responsePayload = shadowPayload ?? payload;
      if (responsePayload?.shadowSeed) {
        delete responsePayload.shadowSeed;
      }
      await recordTenantAwareAuditLog(request, {
        action: 'store_auth_session_created',
        targetType: 'store_auth_session',
        targetId: responsePayload.sessionId,
        detail: body.storeId
          ? `${currentUser.displayName} 为店铺 ${body.storeId} 发起了重新授权会话。`
          : `${currentUser.displayName} 发起了 ${body.platform} 店铺授权。`,
        result: 'success',
        operator: currentUser,
        ipAddress: resolveRequestIp(request),
      });
      return responsePayload;
    },
  );

  app.get(
    '/api/stores/auth-sessions/:sessionId',
    { preHandler: [authorizeRoles(routeAccessPolicy.manageStores, 'stores', '查看店铺授权会话')] },
    async (request, reply) => {
      const params = authSessionParamsSchema.parse(request.params);
      const payload = await resolveTenantBusinessRead(
        request,
        'getStoreAuthSessionDetail',
        [params.sessionId],
        () => db.getStoreAuthSessionDetail(params.sessionId),
      );
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
      const currentUser = request.currentUser;
      if (!ensurePrivilegedWriteAllowed(request, reply, currentUser, '完成店铺授权')) {
        return;
      }

      const params = authSessionParamsSchema.parse(request.params);
      const body = storeAuthCompleteSchema.parse(request.body);
      const payload = await executeTenantBusinessWriteWithShadow(
        request,
        'completeStoreAuthSession',
        [params.sessionId, body, currentUser.id],
        'completeStoreAuthSession',
        () => db.completeStoreAuthSession(params.sessionId, body, currentUser.id),
      );
      if (!payload) {
        await recordTenantAwareAuditLog(request, {
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

      await recordTenantAwareAuditLog(request, {
        action: 'store_auth_completed',
        targetType: 'store',
        targetId: String(payload.storeId),
        detail: payload.reauthorized
          ? `${currentUser.displayName} 完成店铺重新授权，店铺 ${payload.shopName} 已恢复授权。`
          : `${currentUser.displayName} 完成店铺授权，店铺 ${payload.shopName} 已入库。`,
        result: 'success',
        operator: currentUser,
        ipAddress: resolveRequestIp(request),
      });
      return payload;
    },
  );

  app.post('/api/public/stores/auth-sessions/:sessionId/provider-callback', async (request, reply) => {
    const requestIp = resolveRequestIp(request);
    const limited = hitRateLimit(`provider-callback:${requestIp}`, 5, 1);
    if (!limited.allowed) {
      await recordTenantAwareAuditLog(request, {
        action: 'rate_limited',
        targetType: 'store_auth_session',
        targetId: request.params.sessionId ?? 'unknown',
        detail: `公共授权回调限流触发（${requestIp}）。`,
        result: 'blocked',
        ipAddress: requestIp,
      });
      return reply.code(429).send({ message: '回调请求过于频繁，请稍后再试' });
    }

    return processStoreAuthProviderCallback(request, reply, {
      sourceLabel: '公共授权回调页',
    });
  });

  app.post(
    '/api/stores/auth-sessions/:sessionId/provider-callback',
    { preHandler: [authorizeRoles(routeAccessPolicy.manageStores, 'stores', '接收店铺授权回调')] },
    async (request, reply) => {
      const currentUser = request.currentUser;
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
      const currentUser = request.currentUser;
      if (!ensurePrivilegedWriteAllowed(request, reply, currentUser, '同步店铺资料')) {
        return;
      }

      const params = authSessionParamsSchema.parse(request.params);
      const body = storeAuthProfileSyncSchema.parse(request.body);
      const payload = await executeTenantBusinessWriteWithShadow(
        request,
        'syncStoreAuthSessionProfile',
        [params.sessionId, body, currentUser.id],
        'syncStoreAuthSessionProfile',
        () => db.syncStoreAuthSessionProfile(params.sessionId, body, currentUser.id),
      );
      if (!payload) {
        await recordTenantAwareAuditLog(request, {
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

      await recordTenantAwareAuditLog(request, {
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
      const currentUser = request.currentUser;
      if (!ensurePrivilegedWriteAllowed(request, reply, currentUser, '录入网页登录态')) {
        return;
      }

      const params = authSessionParamsSchema.parse(request.params);
      const body = storeAuthWebSessionSyncSchema.parse(request.body);
      const adapter = resolveTenantBusinessAdapter(request);
      let payload = null;
      let usedTenantAdapter = false;
      if (
        adapter &&
        typeof adapter.receiveStoreAuthSessionWebCredential === 'function' &&
        typeof adapter.syncStoreAuthSessionProfile === 'function'
      ) {
        usedTenantAdapter = true;
        try {
          const nextCookieText = body.cookieText?.trim() ?? '';
          if (nextCookieText) {
            await adapter.receiveStoreAuthSessionWebCredential(params.sessionId, {
              cookieText: nextCookieText,
              source: 'manual',
            });
          }
          payload = await adapter.syncStoreAuthSessionProfile(
            params.sessionId,
            {
              providerUserId: body.providerUserId,
              providerShopId: body.providerShopId,
              providerShopName: body.providerShopName,
              mobile: body.mobile,
              nickname: body.nickname,
              scopeText: body.scopeText,
              refreshToken: body.refreshToken,
            },
            currentUser.id,
          );
          if (payload) {
            mirrorShadowWrite(request, 'syncStoreAuthSessionWebSession', () =>
              db.syncStoreAuthSessionWebSession(params.sessionId, body, currentUser.id),
            );
          }
        } catch (error) {
          app.log.warn(
            {
              event: 'tenant_business_write_adapter_failed',
              capability: 'syncStoreAuthSessionWebSession',
              tenantId: request.currentTenant?.id ?? null,
              route: request.url,
              error,
            },
            'Tenant PostgreSQL web-session sync failed, falling back to SQLite shadow storage.',
          );
          usedTenantAdapter = false;
        }
      }
      if (!usedTenantAdapter) {
        payload = db.syncStoreAuthSessionWebSession(params.sessionId, body, currentUser.id);
      }
      if (!payload) {
        await recordTenantAwareAuditLog(request, {
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

      await recordTenantAwareAuditLog(request, {
        action: 'store_auth_web_session_synced',
        targetType: 'store',
        targetId: String(payload.storeId),
        detail: payload.reauthorized
          ? `${currentUser.displayName} 完成店铺网页登录态更新，店铺 ${payload.shopName} 已恢复接入。`
          : `${currentUser.displayName} 录入网页登录态并完成店铺接入，店铺 ${payload.shopName} 已入库。`,
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
      const currentUser = request.currentUser;
      if (!ensurePrivilegedWriteAllowed(request, reply, currentUser, '自动探测网页登录态资料')) {
        return;
      }

      const params = authSessionParamsSchema.parse(request.params);
      const body = storeBrowserRenewSchema.parse(request.body ?? {});
      let credential = null;
      try {
        credential = await resolveTenantBusinessRead(
          request,
          'getStoreAuthSessionWebSessionCredential',
          [params.sessionId],
          () => db.getStoreAuthSessionWebSessionCredential(params.sessionId),
        );
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
        let verification = null;
        const refreshedCookieText =
          detected.cookieText && detected.cookieText !== credential.cookieText ? detected.cookieText : null;
        if (refreshedCookieText) {
          try {
            verification = await xianyuWebSessionService.verifyXianyuWebSessionCookie(refreshedCookieText);
          } catch {
            verification = null;
          }
          await executeTenantBusinessWriteWithShadow(
            request,
            'receiveStoreAuthSessionWebCredential',
            [
              params.sessionId,
              {
                cookieText: refreshedCookieText,
                source: 'browser_renew',
                riskLevel: verification?.riskLevel ?? 'pending',
                riskReason: verification?.detail ?? detected.detail,
                verificationUrl: verification?.verificationUrl ?? detected.verificationUrl ?? null,
              },
            ],
            'receiveStoreAuthSessionWebCredential',
            () =>
              db.receiveStoreAuthSessionWebCredential(params.sessionId, {
                cookieText: refreshedCookieText,
                source: 'browser_renew',
                riskLevel: verification?.riskLevel ?? 'pending',
                riskReason: verification?.detail ?? detected.detail,
                verificationUrl: verification?.verificationUrl ?? detected.verificationUrl ?? null,
              }),
          );
        }

        await recordTenantAwareAuditLog(request, {
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
        await recordTenantAwareAuditLog(request, {
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
      const currentUser = request.currentUser;
      if (!ensurePrivilegedWriteAllowed(request, reply, currentUser, '生成闲鱼扫码登录二维码')) {
        return;
      }

      const params = authSessionParamsSchema.parse(request.params);
      const sessionDetail = await resolveTenantBusinessRead(
        request,
        'getStoreAuthSessionDetail',
        [params.sessionId],
        () => db.getStoreAuthSessionDetail(params.sessionId),
      );
      if (!sessionDetail) {
        return reply.code(404).send({ message: '授权会话不存在或已失效' });
      }
      if (sessionDetail.platform !== 'xianyu' || sessionDetail.integrationMode !== 'xianyu_web_session') {
        return reply.code(409).send({ message: '当前会话不支持闲鱼扫码登录' });
      }

      const refreshedWindow = await executeTenantBusinessWriteWithShadow(
        request,
        'refreshStoreAuthSessionWindow',
        [
          params.sessionId,
          {
            minutes: 15,
            reviveExpiredWebSession: true,
          },
        ],
        'refreshStoreAuthSessionWindow',
        () =>
          db.refreshStoreAuthSessionWindow(params.sessionId, {
            minutes: 15,
            reviveExpiredWebSession: true,
          }),
      );
      if (!refreshedWindow?.refreshed) {
        return reply.code(409).send({ message: '授权会话已失效，请重新发起接入。' });
      }

      try {
        const payload = await xianyuWebSessionService.xianyuQrLoginManager.create(params.sessionId);
        await recordTenantAwareStoreCredentialEvent(request, {
          sessionId: params.sessionId,
          eventType: 'qr_login_started',
          status: 'info',
          detail: '已生成闲鱼扫码登录二维码，等待扫码确认。',
          source: 'qr_login',
          operatorUserId: currentUser.id,
        });
        await recordTenantAwareAuditLog(request, {
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
        await recordTenantAwareStoreCredentialEvent(request, {
          sessionId: params.sessionId,
          eventType: 'qr_login_started',
          status: 'error',
          detail: error instanceof Error ? error.message : '生成扫码登录二维码失败。',
          source: 'qr_login',
          operatorUserId: currentUser.id,
        });
        await recordTenantAwareAuditLog(request, {
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
      const params = authSessionParamsSchema.parse(request.params);
      const sessionDetail = await resolveTenantBusinessRead(
        request,
        'getStoreAuthSessionDetail',
        [params.sessionId],
        () => db.getStoreAuthSessionDetail(params.sessionId),
      );
      if (!sessionDetail) {
        return reply.code(404).send({ message: '授权会话不存在或已失效' });
      }
      if (sessionDetail.platform !== 'xianyu' || sessionDetail.integrationMode !== 'xianyu_web_session') {
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
      const params = authSessionParamsSchema.parse(request.params);
      const payload = await resolveTenantBusinessRead(
        request,
        'getStoreCredentialEventsBySession',
        [params.sessionId],
        () => db.getStoreCredentialEventsBySession(params.sessionId),
      );
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
      const currentUser = request.currentUser;
      const params = authSessionParamsSchema.parse(request.params);
      const sessionDetail = await resolveTenantBusinessRead(
        request,
        'getStoreAuthSessionDetail',
        [params.sessionId],
        () => db.getStoreAuthSessionDetail(params.sessionId),
      );
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
    const params = authSessionParamsSchema.parse(request.params);
    const query = z.object({ streamToken: z.string().uuid() }).parse(request.query);
    const tokenRecord = storeAuthLiveStreamManager.resolveToken(params.sessionId, query.streamToken);
    if (!tokenRecord) {
      return reply.code(401).send({ message: '实时流令牌无效或已过期' });
    }

    const user = db.getUserById(tokenRecord.userId);
    if (!user || user.status !== 'active') {
      return reply.code(403).send({ message: '当前账号无权订阅该实时流' });
    }

    const snapshot = await buildTenantAwareStoreAuthSessionLiveSnapshot(request, params.sessionId);
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

    const sendSnapshot = (payload) => {
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
      const currentUser = request.currentUser;
      if (!ensurePrivilegedWriteAllowed(request, reply, currentUser, '接收闲鱼扫码登录态')) {
        return;
      }

      const params = authSessionParamsSchema.parse(request.params);
      const sessionDetail = await resolveTenantBusinessRead(
        request,
        'getStoreAuthSessionDetail',
        [params.sessionId],
        () => db.getStoreAuthSessionDetail(params.sessionId),
      );
      if (!sessionDetail) {
        return reply.code(404).send({ message: '授权会话不存在或已失效' });
      }
      if (sessionDetail.platform !== 'xianyu' || sessionDetail.integrationMode !== 'xianyu_web_session') {
        return reply.code(409).send({ message: '当前会话不支持闲鱼扫码登录' });
      }

      const qrPayload = xianyuWebSessionService.xianyuQrLoginManager.consumeSuccessCookies(params.sessionId);
      if (!qrPayload) {
        return reply.code(409).send({ message: '扫码登录尚未成功，暂不能接收登录态' });
      }

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

      let verification = null;
      try {
        verification = await xianyuWebSessionService.verifyXianyuWebSessionCookie(finalCookieText);
      } catch {
        verification = null;
      }

      const payload = await executeTenantBusinessWriteWithShadow(
        request,
        'receiveStoreAuthSessionWebCredential',
        [
          params.sessionId,
          {
            cookieText: finalCookieText,
            source: 'qr_login',
            riskLevel: verification?.riskLevel ?? 'pending',
            riskReason: verification?.detail ?? '扫码登录成功，待补齐卖家与店铺资料。',
            verificationUrl: verification?.verificationUrl ?? null,
          },
        ],
        'receiveStoreAuthSessionWebCredential',
        () =>
          db.receiveStoreAuthSessionWebCredential(params.sessionId, {
            cookieText: finalCookieText,
            source: 'qr_login',
            riskLevel: verification?.riskLevel ?? 'pending',
            riskReason: verification?.detail ?? '扫码登录成功，待补齐卖家与店铺资料。',
            verificationUrl: verification?.verificationUrl ?? null,
          }),
      );
      await recordTenantAwareAuditLog(request, {
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

  app.post(
    '/api/stores/auth-sessions/:sessionId/qr-login/browser-start',
    { preHandler: [authorizeRoles(routeAccessPolicy.manageStores, 'stores', '启动浏览器扫码登录')] },
    async (request, reply) => {
      const currentUser = request.currentUser;
      if (!ensurePrivilegedWriteAllowed(request, reply, currentUser, '启动浏览器扫码登录')) {
        return;
      }

      const params = authSessionParamsSchema.parse(request.params);
      const sessionDetail = await resolveTenantBusinessRead(
        request,
        'getStoreAuthSessionDetail',
        [params.sessionId],
        () => db.getStoreAuthSessionDetail(params.sessionId),
      );
      if (!sessionDetail) {
        return reply.code(404).send({ message: '授权会话不存在或已失效' });
      }
      if (sessionDetail.platform !== 'xianyu' || sessionDetail.integrationMode !== 'xianyu_web_session') {
        return reply.code(409).send({ message: '当前会话不支持闲鱼扫码登录' });
      }

      const refreshedWindow = await executeTenantBusinessWriteWithShadow(
        request,
        'refreshStoreAuthSessionWindow',
        [
          params.sessionId,
          {
            minutes: 15,
            reviveExpiredWebSession: true,
          },
        ],
        'refreshStoreAuthSessionWindow',
        () =>
          db.refreshStoreAuthSessionWindow(params.sessionId, {
            minutes: 15,
            reviveExpiredWebSession: true,
          }),
      );
      if (!refreshedWindow?.refreshed) {
        return reply.code(409).send({ message: '授权会话已失效，请重新发起接入。' });
      }

      try {
        const result = await xianyuWebSessionService.xianyuQrLoginManager.startBrowserQrLogin(params.sessionId);
        await recordTenantAwareStoreCredentialEvent(request, {
          sessionId: params.sessionId,
          eventType: 'browser_qr_login_started',
          status: result.status === 'waiting' ? 'info' : 'error',
          detail:
            result.status === 'waiting'
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
    async (request) => {
      const params = authSessionParamsSchema.parse(request.params);
      return xianyuWebSessionService.xianyuQrLoginManager.getBrowserQrStatus(params.sessionId);
    },
  );

  app.post(
    '/api/stores/auth-sessions/:sessionId/qr-login/browser-accept',
    { preHandler: [authorizeRoles(routeAccessPolicy.manageStores, 'stores', '接收浏览器扫码登录态')] },
    async (request, reply) => {
      const currentUser = request.currentUser;
      if (!ensurePrivilegedWriteAllowed(request, reply, currentUser, '接收浏览器扫码登录态')) {
        return;
      }

      const params = authSessionParamsSchema.parse(request.params);
      const sessionDetail = await resolveTenantBusinessRead(
        request,
        'getStoreAuthSessionDetail',
        [params.sessionId],
        () => db.getStoreAuthSessionDetail(params.sessionId),
      );
      if (!sessionDetail) {
        return reply.code(404).send({ message: '授权会话不存在或已失效' });
      }

      const browserPayload = xianyuWebSessionService.xianyuQrLoginManager.consumeBrowserQrCookies(params.sessionId);
      if (!browserPayload) {
        return reply.code(409).send({ message: '浏览器扫码登录尚未成功，暂不能接收登录态' });
      }

      let verification = null;
      try {
        verification = await xianyuWebSessionService.verifyXianyuWebSessionCookie(browserPayload.cookieText);
      } catch {
        verification = null;
      }

      const payload = await executeTenantBusinessWriteWithShadow(
        request,
        'receiveStoreAuthSessionWebCredential',
        [
          params.sessionId,
          {
            cookieText: browserPayload.cookieText,
            source: 'browser_qr_login',
            riskLevel: verification?.riskLevel ?? 'pending',
            riskReason: verification?.detail ?? '浏览器扫码登录成功，待补齐卖家与店铺资料。',
            verificationUrl: verification?.verificationUrl ?? null,
          },
        ],
        'receiveStoreAuthSessionWebCredential',
        () =>
          db.receiveStoreAuthSessionWebCredential(params.sessionId, {
            cookieText: browserPayload.cookieText,
            source: 'browser_qr_login',
            riskLevel: verification?.riskLevel ?? 'pending',
            riskReason: verification?.detail ?? '浏览器扫码登录成功，待补齐卖家与店铺资料。',
            verificationUrl: verification?.verificationUrl ?? null,
          }),
      );
      await recordTenantAwareStoreCredentialEvent(request, {
        sessionId: params.sessionId,
        eventType: 'browser_qr_login_accepted',
        status: 'success',
        detail: '已通过浏览器扫码获取完整登录态（含 _m_h5_tk），Cookie 已写入凭据仓。',
        source: 'browser_qr_login',
        operatorUserId: currentUser.id,
      });
      await recordTenantAwareAuditLog(request, {
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
    { preHandler: [authorizeRoles(routeAccessPolicy.manageStores, 'stores', '激活店铺')] },
    async (request, reply) => {
      const currentUser = request.currentUser;
      if (!ensurePrivilegedWriteAllowed(request, reply, currentUser, '激活店铺')) {
        return;
      }

      const params = storeIdParamsSchema.parse(request.params);
      const { payload, tenantAdapter } = await resolveTenantBusinessWrite(
        request,
        'activateManagedStore',
        [params.storeId],
        () => db.activateManagedStore(params.storeId),
      );
      if (tenantAdapter && payload) {
        mirrorShadowWrite(request, 'activateManagedStore', () => db.activateManagedStore(params.storeId));
      }
      if (!payload) {
        await recordTenantAwareAuditLog(request, {
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

      await recordTenantAwareAuditLog(request, {
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
      const currentUser = request.currentUser;
      if (!ensurePrivilegedWriteAllowed(request, reply, currentUser, '编辑店铺信息')) {
        return;
      }

      const params = storeIdParamsSchema.parse(request.params);
      const body = storeMetaUpdateSchema.parse(request.body);
      try {
        const { payload, tenantAdapter } = await resolveTenantBusinessWrite(
          request,
          'updateManagedStoreMeta',
          [params.storeId, body],
          () => db.updateManagedStoreMeta(params.storeId, body),
        );
        if (tenantAdapter && payload) {
          mirrorShadowWrite(request, 'updateManagedStoreMeta', () =>
            db.updateManagedStoreMeta(params.storeId, body),
          );
        }
        await recordTenantAwareAuditLog(request, {
          action: 'store_metadata_updated',
          targetType: 'store',
          targetId: String(params.storeId),
          detail: `${currentUser.displayName} 更新了店铺 ${params.storeId} 的分组、标签和备注。`,
          result: 'success',
          operator: currentUser,
          ipAddress: resolveRequestIp(request),
        });
        return { store: payload };
      } catch (error) {
        const message = error instanceof Error ? error.message : '更新店铺信息失败';
        await recordTenantAwareAuditLog(request, {
          action: 'store_metadata_updated',
          targetType: 'store',
          targetId: String(params.storeId),
          detail: `${currentUser.displayName} 更新店铺信息失败：${message}`,
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
      const currentUser = request.currentUser;
      if (!ensurePrivilegedWriteAllowed(request, reply, currentUser, '启停店铺')) {
        return;
      }

      const params = storeIdParamsSchema.parse(request.params);
      const body = storeEnabledSchema.parse(request.body);
      try {
        const { payload, tenantAdapter } = await resolveTenantBusinessWrite(
          request,
          'setManagedStoreEnabled',
          [params.storeId, body.enabled],
          () => db.setManagedStoreEnabled(params.storeId, body.enabled),
        );
        if (tenantAdapter && payload) {
          mirrorShadowWrite(request, 'setManagedStoreEnabled', () =>
            db.setManagedStoreEnabled(params.storeId, body.enabled),
          );
        }
        await recordTenantAwareAuditLog(request, {
          action: 'store_enabled_updated',
          targetType: 'store',
          targetId: String(params.storeId),
          detail: `${currentUser.displayName} 将店铺 ${params.storeId} 调整为${body.enabled ? '启用' : '停用'}。`,
          result: 'success',
          operator: currentUser,
          ipAddress: resolveRequestIp(request),
        });
        return { store: payload };
      } catch (error) {
        const message = error instanceof Error ? error.message : '更新店铺状态失败';
        await recordTenantAwareAuditLog(request, {
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
      const currentUser = request.currentUser;
      if (!ensurePrivilegedWriteAllowed(request, reply, currentUser, '批量启停店铺')) {
        return;
      }

      const body = storeBatchStatusSchema.parse(request.body);
      const { payload, tenantAdapter } = await resolveTenantBusinessWrite(
        request,
        'batchSetManagedStoreEnabled',
        [body.storeIds, body.enabled],
        () => db.batchSetManagedStoreEnabled(body.storeIds, body.enabled),
      );
      if (tenantAdapter && payload) {
        mirrorShadowWrite(request, 'batchSetManagedStoreEnabled', () =>
          db.batchSetManagedStoreEnabled(body.storeIds, body.enabled),
        );
      }
      await recordTenantAwareAuditLog(request, {
        action: 'store_batch_enabled_updated',
        targetType: 'store_batch',
        targetId: body.storeIds.join(','),
        detail: `${currentUser.displayName} 批量将 ${body.storeIds.length} 家店铺调整为${body.enabled ? '启用' : '停用'}。`,
        result: 'success',
        operator: currentUser,
        ipAddress: resolveRequestIp(request),
      });
      return { stores: payload };
    },
  );

  app.post(
    '/api/stores/:storeId/health-check',
    { preHandler: [authorizeRoles(routeAccessPolicy.manageStores, 'stores', '执行店铺健康检查')] },
    async (request, reply) => {
      const currentUser = request.currentUser;
      const params = storeIdParamsSchema.parse(request.params);
      const payload = await runStoreHealthCheck(params.storeId, {
        triggeredByUserId: currentUser.id,
        triggerMode: 'manual',
      });
      if (!payload) {
        db.recordAuditLog({
          action: 'store_health_checked',
          targetType: 'store',
          targetId: String(params.storeId),
          detail: `${currentUser.displayName} 对店铺 ${params.storeId} 执行健康检查失败，目标店铺不存在。`,
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
        detail: `${currentUser.displayName} 对店铺 ${params.storeId} 执行了健康检查，结果为 ${payload.status}。`,
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
      const currentUser = request.currentUser;
      if (!ensurePrivilegedWriteAllowed(request, reply, currentUser, '校验店铺登录态')) {
        return;
      }

      const params = storeIdParamsSchema.parse(request.params);
      let credential = null;
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
        const payload = await verifyManagedStoreCredential(params.storeId, {
          operatorUserId: currentUser.id,
          triggerMode: 'manual',
        });
        if (!payload) {
          return reply.code(404).send({ message: '店铺不存在' });
        }
        db.recordAuditLog({
          action: 'store_web_credential_verified',
          targetType: 'store',
          targetId: String(params.storeId),
          detail: `${currentUser.displayName} 校验了店铺 ${params.storeId} 的网页登录态，结果为 ${payload.riskLevel}。`,
          result: 'success',
          operator: currentUser,
          ipAddress: resolveRequestIp(request),
        });
        return payload;
      } catch (error) {
        db.recordAuditLog({
          action: 'store_web_credential_verified',
          targetType: 'store',
          targetId: String(params.storeId),
          detail: `${currentUser.displayName} 校验店铺 ${params.storeId} 的网页登录态失败。`,
          result: 'failure',
          operator: currentUser,
          ipAddress: resolveRequestIp(request),
        });
        return reply.code(502).send({ message: error instanceof Error ? error.message : '登录态校验失败' });
      }
    },
  );

  app.get(
    '/api/stores/:storeId/credential-events',
    { preHandler: [authorizeRoles(routeAccessPolicy.manageStores, 'stores', '查看店铺凭据时间线')] },
    async (request, reply) => {
      const params = storeIdParamsSchema.parse(request.params);
      const payload = await resolveTenantBusinessRead(
        request,
        'getStoreCredentialEvents',
        [params.storeId],
        () => db.getStoreCredentialEvents(params.storeId),
      );
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
      const currentUser = request.currentUser;
      if (!ensurePrivilegedWriteAllowed(request, reply, currentUser, '执行浏览器续登')) {
        return;
      }

      const params = storeIdParamsSchema.parse(request.params);
      const body = storeBrowserRenewSchema.parse(request.body ?? {});
      let credential = null;
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
        const payload = await renewManagedStoreCredentialViaBrowser(params.storeId, {
          operatorUserId: currentUser.id,
          triggerMode: 'manual',
          showBrowser: body.showBrowser,
          executablePath: body.executablePath ?? null,
        });
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
        return payload;
      } catch (error) {
        db.recordAuditLog({
          action: 'store_web_credential_renewed',
          targetType: 'store',
          targetId: String(params.storeId),
          detail: `${currentUser.displayName} 对店铺 ${params.storeId} 执行浏览器续登失败。`,
          result: 'failure',
          operator: currentUser,
          ipAddress: resolveRequestIp(request),
        });
        return reply.code(502).send({ message: error instanceof Error ? error.message : '浏览器续登失败' });
      }
    },
  );

  app.post(
    '/api/stores/batch/health-check',
    { preHandler: [authorizeRoles(routeAccessPolicy.manageStores, 'stores', '批量执行店铺健康检查')] },
    async (request) => {
      const currentUser = request.currentUser;
      const body = storeBatchHealthCheckSchema.parse(request.body);
      const payload = await runBatchStoreHealthChecks(body.storeIds, currentUser.id);
      db.recordAuditLog({
        action: 'store_batch_health_checked',
        targetType: 'store_batch',
        targetId: body.storeIds.join(','),
        detail: `${currentUser.displayName} 批量对 ${body.storeIds.length} 家店铺执行了健康检查。`,
        result: 'success',
        operator: currentUser,
        ipAddress: resolveRequestIp(request),
      });
      return { checks: payload };
    },
  );
}
