// @ts-nocheck
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import type { ResolvedAppConfig } from './config.js';
import type { ControlPlaneStore } from './control-plane-store.js';
import type { DatabaseProvider } from './database-provider.js';
import type { StatisticsDatabase } from './database.js';
import {
  openPlatformAppCreateSchema,
  openPlatformAppStatusSchema,
  openPlatformSettingsSchema,
  openPlatformWhitelistEnabledSchema,
  openPlatformWhitelistRuleCreateSchema,
} from './schemas.js';

interface OpenPlatformRouteDeps {
  app: FastifyInstance;
  db: StatisticsDatabase;
  privateDb: StatisticsDatabase;
  controlPlaneDb: ControlPlaneStore | null;
  databaseProvider: DatabaseProvider;
  runtimeConfig: ResolvedAppConfig;
  authorizeWorkspaceFeature: (featureKey: string, mode: string, actionLabel: string) => unknown;
  ensurePrivilegedWriteAllowed: (
    request: FastifyRequest,
    reply: FastifyReply,
    currentUser: any,
    actionLabel: string,
  ) => boolean;
  resolveRequestIp: (request: FastifyRequest) => string;
  recordPlatformAudit: (input: {
    action: string;
    targetType: string;
    targetId: string;
    detail: string;
    result: 'success' | 'failure' | 'blocked';
    tenantId?: number | null;
    ipAddress?: string | null;
  }) => void;
}

export function registerOpenPlatformRoutes({
  app,
  db,
  privateDb,
  controlPlaneDb,
  databaseProvider,
  runtimeConfig,
  authorizeWorkspaceFeature,
  ensurePrivilegedWriteAllowed,
  resolveRequestIp,
  recordPlatformAudit,
}: OpenPlatformRouteDeps) {
  const resolveTenantBusinessRead = async (
    request: FastifyRequest,
    capability: string,
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

    return adapter[capability]();
  };
  const resolveTenantBusinessWrite = async (
    request: FastifyRequest,
    capability: string,
    args: unknown[],
    fallback: () => unknown,
    mirror?: () => unknown,
  ) => {
    const tenant = request.currentTenant;
    if (!tenant || !databaseProvider.isTenantBusinessPostgresEnabled()) {
      return fallback();
    }

    const adapter = databaseProvider.getTenantBusinessReadAdapter(tenant);
    if (!adapter || typeof adapter[capability] !== 'function') {
      app.log.warn(
        {
          event: 'tenant_business_write_adapter_capability_missing',
          capability,
          tenantId: tenant.id,
          route: request.url,
        },
        'Tenant PostgreSQL write capability missing, falling back to SQLite shadow storage.',
      );
      return fallback();
    }

    const payload = await adapter[capability](...args);
    if (payload != null && mirror) {
      try {
        await mirror();
      } catch (error) {
        app.log.warn(
          {
            event: 'tenant_business_write_shadow_mirror_failed',
            capability,
            tenantId: tenant.id,
            route: request.url,
            error,
          },
          'Tenant PostgreSQL primary write succeeded, but SQLite shadow mirror failed.',
        );
      }
    }

    return payload;
  };
  const recordTenantAwareAuditLog = async (
    request: FastifyRequest,
    input: Parameters<StatisticsDatabase['recordAuditLog']>[0],
  ) => {
    const tenant = request.currentTenant;
    if (tenant && databaseProvider.isTenantBusinessPostgresEnabled()) {
      const adapter = databaseProvider.getTenantBusinessReadAdapter(tenant);
      if (adapter && typeof adapter.recordAuditLog === 'function') {
        await adapter.recordAuditLog(input);
        try {
          db.recordAuditLog(input);
        } catch (error) {
          app.log.warn(
            {
              event: 'tenant_business_write_shadow_mirror_failed',
              capability: `audit:${input.action}`,
              tenantId: tenant.id,
              route: request.url,
              error,
            },
            'Tenant PostgreSQL audit write succeeded, but SQLite shadow mirror failed.',
          );
        }
        return;
      }
    }

    db.recordAuditLog(input);
  };

  const resolveTenantPublicTarget = async (tenantKey: string) => {
    if (runtimeConfig.deploymentMode !== 'saas') {
      return {
        tenant: null,
        tenantId: null,
        targetDb: privateDb,
        targetAdapter: null,
      };
    }

    if (!controlPlaneDb) {
      return {
        error: { statusCode: 404, message: '褰撳墠閮ㄧ讲妯″紡鏈惎鐢?SaaS 鎺у埗闈€?' },
      };
    }

    const tenant = (await controlPlaneDb.listTenants()).find((item) => item.tenantKey === tenantKey) ?? null;
    if (!tenant || tenant.status !== 'active') {
      return {
        error: { statusCode: 404, message: '绉熸埛涓嶅瓨鍦ㄦ垨鏈惎鐢ㄣ€?' },
      };
    }

    const adapter = databaseProvider.isTenantBusinessPostgresEnabled()
      ? databaseProvider.getTenantBusinessReadAdapter(tenant)
      : null;

    return {
      tenant,
      tenantId: tenant.id,
      targetDb: databaseProvider.ensureTenantDatabase(tenant),
      targetAdapter: adapter,
    };
  };
  app.get(
    '/api/open-platform/apps',
    { preHandler: [authorizeWorkspaceFeature('open-apps', 'view', '查看开放应用')] },
    async (request) =>
      resolveTenantBusinessRead(request, 'getOpenPlatformAppsDetail', () =>
        db.openPlatformGetAppsDetail(),
      ),
  );

  app.post(
    '/api/open-platform/apps',
    { preHandler: [authorizeWorkspaceFeature('open-apps', 'manage', '创建开放应用')] },
    async (request, reply) => {
      const currentUser = request.currentUser;
      if (!ensurePrivilegedWriteAllowed(request, reply, currentUser, '创建开放应用')) {
        return;
      }

      const body = openPlatformAppCreateSchema.parse(request.body ?? {});
      const payload = await resolveTenantBusinessWrite(
        request,
        'createOpenPlatformApp',
        [
          {
            appName: body.appName,
            ownerName: body.ownerName,
            contactName: body.contactName,
            callbackUrl: body.callbackUrl,
            scopes: body.scopes,
            rateLimitPerMinute: body.rateLimitPerMinute,
            updatedByUserId: currentUser.id,
          },
        ],
        () =>
          db.openPlatformCreateApp({
            appName: body.appName,
            ownerName: body.ownerName,
            contactName: body.contactName,
            callbackUrl: body.callbackUrl,
            scopes: body.scopes,
            rateLimitPerMinute: body.rateLimitPerMinute,
            updatedByUserId: currentUser.id,
          }),
        () =>
          db.openPlatformCreateApp({
            appName: body.appName,
            ownerName: body.ownerName,
            contactName: body.contactName,
            callbackUrl: body.callbackUrl,
            scopes: body.scopes,
            rateLimitPerMinute: body.rateLimitPerMinute,
            updatedByUserId: currentUser.id,
          }),
      );

      await recordTenantAwareAuditLog(request, {
        action: 'open_platform_app_created',
        targetType: 'open_platform_app',
        targetId: payload?.appKey ?? body.appName,
        detail: `${currentUser.displayName} 创建了开放应用 ${body.appName}。`,
        result: payload ? 'success' : 'failure',
        operator: currentUser,
        ipAddress: resolveRequestIp(request),
      });
      return payload;
    },
  );

  app.post(
    '/api/open-platform/apps/:appId/status',
    { preHandler: [authorizeWorkspaceFeature('open-apps', 'manage', '调整开放应用状态')] },
    async (request, reply) => {
      const currentUser = request.currentUser;
      if (!ensurePrivilegedWriteAllowed(request, reply, currentUser, '调整开放应用状态')) {
        return;
      }

      const params = z.object({ appId: z.coerce.number().int().positive() }).parse(request.params);
      const body = openPlatformAppStatusSchema.parse(request.body ?? {});
      const payload = await resolveTenantBusinessWrite(
        request,
        'updateOpenPlatformAppStatus',
        [params.appId, body.status],
        () => db.openPlatformUpdateAppStatus(params.appId, body.status),
        () => db.openPlatformUpdateAppStatus(params.appId, body.status),
      );
      if (!payload) {
        return reply.code(404).send({ message: '开放应用不存在' });
      }

      await recordTenantAwareAuditLog(request, {
        action: 'open_platform_app_status_updated',
        targetType: 'open_platform_app',
        targetId: String(params.appId),
        detail: `${currentUser.displayName} 将开放应用 ${payload.appKey} 状态调整为 ${body.status}。`,
        result: 'success',
        operator: currentUser,
        ipAddress: resolveRequestIp(request),
      });
      return { app: payload };
    },
  );

  app.post(
    '/api/open-platform/apps/:appId/secret/rotate',
    { preHandler: [authorizeWorkspaceFeature('open-apps', 'manage', '轮换开放应用密钥')] },
    async (request, reply) => {
      const currentUser = request.currentUser;
      if (!ensurePrivilegedWriteAllowed(request, reply, currentUser, '轮换开放应用密钥')) {
        return;
      }

      const params = z.object({ appId: z.coerce.number().int().positive() }).parse(request.params);
      const payload = await resolveTenantBusinessWrite(
        request,
        'rotateOpenPlatformAppSecret',
        [params.appId, currentUser.id],
        () => db.openPlatformRotateAppSecret(params.appId, currentUser.id),
        () => db.openPlatformRotateAppSecret(params.appId, currentUser.id),
      );
      if (!payload) {
        return reply.code(404).send({ message: '开放应用不存在' });
      }

      await recordTenantAwareAuditLog(request, {
        action: 'open_platform_secret_rotated',
        targetType: 'open_platform_app',
        targetId: String(params.appId),
        detail: `${currentUser.displayName} 轮换了开放应用 ${payload.appKey} 的签名密钥。`,
        result: 'success',
        operator: currentUser,
        ipAddress: resolveRequestIp(request),
      });
      return payload;
    },
  );

  app.get(
    '/api/open-platform/docs',
    { preHandler: [authorizeWorkspaceFeature('open-docs', 'view', '查看开放平台文档')] },
    async (request) =>
      resolveTenantBusinessRead(request, 'getOpenPlatformDocsDetail', () =>
        db.openPlatformGetDocsDetail(),
      ),
  );

  app.get(
    '/api/open-platform/settings',
    { preHandler: [authorizeWorkspaceFeature('open-settings', 'view', '查看开放平台设置')] },
    async (request) =>
      resolveTenantBusinessRead(request, 'getOpenPlatformSettingsDetail', () =>
        db.openPlatformGetSettingsDetail(),
      ),
  );

  app.post(
    '/api/open-platform/settings',
    { preHandler: [authorizeWorkspaceFeature('open-settings', 'manage', '更新开放平台设置')] },
    async (request, reply) => {
      const currentUser = request.currentUser;
      if (!ensurePrivilegedWriteAllowed(request, reply, currentUser, '更新开放平台设置')) {
        return;
      }

      const body = openPlatformSettingsSchema.parse(request.body ?? {});
      const payload = await resolveTenantBusinessWrite(
        request,
        'updateOpenPlatformSettings',
        [
          {
            ...body,
            updatedByUserId: currentUser.id,
          },
        ],
        () =>
          db.openPlatformUpdateSettings({
            ...body,
            updatedByUserId: currentUser.id,
          }),
        () =>
          db.openPlatformUpdateSettings({
            ...body,
            updatedByUserId: currentUser.id,
          }),
      );

      await recordTenantAwareAuditLog(request, {
        action: 'open_platform_settings_updated',
        targetType: 'open_platform_settings',
        targetId: 'default',
        detail: `${currentUser.displayName} 更新了开放平台设置。`,
        result: payload ? 'success' : 'failure',
        operator: currentUser,
        ipAddress: resolveRequestIp(request),
      });
      return { settings: payload };
    },
  );

  app.get(
    '/api/open-platform/whitelist',
    { preHandler: [authorizeWorkspaceFeature('open-whitelist', 'view', '查看开放平台白名单')] },
    async (request) =>
      resolveTenantBusinessRead(request, 'getOpenPlatformWhitelistDetail', () =>
        db.openPlatformGetWhitelistDetail(),
      ),
  );

  app.post(
    '/api/open-platform/whitelist',
    { preHandler: [authorizeWorkspaceFeature('open-whitelist', 'manage', '新增开放平台白名单')] },
    async (request, reply) => {
      const currentUser = request.currentUser;
      if (!ensurePrivilegedWriteAllowed(request, reply, currentUser, '新增开放平台白名单')) {
        return;
      }

      const body = openPlatformWhitelistRuleCreateSchema.parse(request.body ?? {});
      const payload = await resolveTenantBusinessWrite(
        request,
        'createOpenPlatformWhitelistRule',
        [
          {
            ruleType: body.ruleType,
            ruleValue: body.ruleValue,
            description: body.description,
            enabled: body.enabled,
            updatedByUserId: currentUser.id,
          },
        ],
        () =>
          db.openPlatformCreateWhitelistRule({
            ruleType: body.ruleType,
            ruleValue: body.ruleValue,
            description: body.description,
            enabled: body.enabled,
            updatedByUserId: currentUser.id,
          }),
        () =>
          db.openPlatformCreateWhitelistRule({
            ruleType: body.ruleType,
            ruleValue: body.ruleValue,
            description: body.description,
            enabled: body.enabled,
            updatedByUserId: currentUser.id,
          }),
      );

      await recordTenantAwareAuditLog(request, {
        action: 'open_platform_whitelist_created',
        targetType: 'open_platform_whitelist',
        targetId: payload ? String(payload.id) : body.ruleValue,
        detail: `${currentUser.displayName} 新增了开放平台白名单规则 ${body.ruleValue}。`,
        result: payload ? 'success' : 'failure',
        operator: currentUser,
        ipAddress: resolveRequestIp(request),
      });
      return { rule: payload };
    },
  );

  app.post(
    '/api/open-platform/whitelist/:ruleId/enabled',
    { preHandler: [authorizeWorkspaceFeature('open-whitelist', 'manage', '启停开放平台白名单')] },
    async (request, reply) => {
      const currentUser = request.currentUser;
      if (!ensurePrivilegedWriteAllowed(request, reply, currentUser, '启停开放平台白名单')) {
        return;
      }

      const params = z.object({ ruleId: z.coerce.number().int().positive() }).parse(request.params);
      const body = openPlatformWhitelistEnabledSchema.parse(request.body ?? {});
      const payload = await resolveTenantBusinessWrite(
        request,
        'updateOpenPlatformWhitelistRuleEnabled',
        [params.ruleId, body.enabled, currentUser.id],
        () => db.openPlatformUpdateWhitelistRuleEnabled(params.ruleId, body.enabled, currentUser.id),
        () => db.openPlatformUpdateWhitelistRuleEnabled(params.ruleId, body.enabled, currentUser.id),
      );
      if (!payload) {
        return reply.code(404).send({ message: '白名单规则不存在' });
      }

      await recordTenantAwareAuditLog(request, {
        action: 'open_platform_whitelist_updated',
        targetType: 'open_platform_whitelist',
        targetId: String(params.ruleId),
        detail: `${currentUser.displayName} ${body.enabled ? '启用' : '停用'}了开放平台白名单规则 ${payload.ruleValue}。`,
        result: 'success',
        operator: currentUser,
        ipAddress: resolveRequestIp(request),
      });
      return { rule: payload };
    },
  );

  app.get('/api/public/open-platform/:tenantKey/dashboard/summary', async (request, reply) => {
    const startedAt = Date.now();
    const params = z.object({ tenantKey: z.string().min(1).max(80) }).parse(request.params);
    const requestIp = resolveRequestIp(request);
    const appKey = typeof request.headers['x-open-app-key'] === 'string' ? request.headers['x-open-app-key'].trim() : '';
    const timestamp =
      typeof request.headers['x-open-timestamp'] === 'string' ? request.headers['x-open-timestamp'].trim() : '';
    const signature =
      typeof request.headers['x-open-signature'] === 'string'
        ? request.headers['x-open-signature'].trim().toLowerCase()
        : '';
    const routePath = request.url.split('?')[0] ?? request.url;

    let targetDb = privateDb;
    let targetAdapter = null;
    let tenantId = null;
    let appInfo = null;

    try {
      const targetResolution = await resolveTenantPublicTarget(params.tenantKey);
      if ('error' in targetResolution) {
        return reply.code(targetResolution.error.statusCode).send({ message: targetResolution.error.message });
      }
      tenantId = targetResolution.tenantId;
      targetDb = targetResolution.targetDb;
      targetAdapter = targetResolution.targetAdapter;

      if (false && runtimeConfig.deploymentMode === 'saas') {
        if (!controlPlaneDb) {
          return reply.code(404).send({ message: '当前部署模式未启用 SaaS 控制面。' });
        }

        const tenant = (await controlPlaneDb.listTenants()).find((item) => item.tenantKey === params.tenantKey) ?? null;
        if (!tenant || tenant.status !== 'active') {
          return reply.code(404).send({ message: '租户不存在或未启用。' });
        }
        tenantId = tenant.id;
        targetDb = databaseProvider.ensureTenantDatabase(tenant);
      }

      const targetClient =
        targetAdapter &&
        typeof targetAdapter.openPlatformVerifyRequest === 'function' &&
        typeof targetAdapter.openPlatformGetPublicDashboardSummary === 'function' &&
        typeof targetAdapter.openPlatformRecordCallLog === 'function'
          ? targetAdapter
          : targetDb;

      appInfo = await targetClient.openPlatformVerifyRequest({
        tenantKey: params.tenantKey,
        appKey,
        timestamp,
        signature,
        httpMethod: 'GET',
        routePath,
        requestIp,
        requiredScope: 'dashboard.read',
      });

      const payload = await targetClient.openPlatformGetPublicDashboardSummary();
      await targetClient.openPlatformRecordCallLog({
        appId: appInfo.id,
        appKey: appInfo.appKey,
        tenantKey: params.tenantKey,
        traceId: `opl_${request.id}`,
        httpMethod: 'GET',
        routePath,
        requestIp,
        statusCode: 200,
        callStatus: 'success',
        durationMs: Date.now() - startedAt,
        detail: '经营看板摘要读取成功',
      });
      return payload;
    } catch (error) {
      if (appInfo || appKey) {
        const logClient =
          targetAdapter && typeof targetAdapter.openPlatformRecordCallLog === 'function'
            ? targetAdapter
            : targetDb;
        await logClient.openPlatformRecordCallLog({
          appId: appInfo?.id ?? null,
          appKey: appInfo?.appKey ?? (appKey || 'unknown'),
          tenantKey: params.tenantKey,
          traceId: `opl_${request.id}`,
          httpMethod: 'GET',
          routePath,
          requestIp,
          statusCode: 403,
          callStatus: 'blocked',
          durationMs: Date.now() - startedAt,
          detail: error instanceof Error ? error.message : '开放平台访问被拒绝',
        });
      }

      if (tenantId && controlPlaneDb) {
        recordPlatformAudit({
          action: 'open_platform_public_access_blocked',
          targetType: 'tenant',
          targetId: params.tenantKey,
          detail: `开放平台公开接口访问被拒绝：${error instanceof Error ? error.message : 'unknown'}。`,
          result: 'blocked',
          tenantId,
          ipAddress: requestIp,
        });
      }

      return reply.code(403).send({ message: error instanceof Error ? error.message : '开放平台访问被拒绝' });
    }
  });

  app.get('/api/public/open-platform/:tenantKey/orders/overview', async (request, reply) => {
    const startedAt = Date.now();
    const params = z.object({ tenantKey: z.string().min(1).max(80) }).parse(request.params);
    const requestIp = resolveRequestIp(request);
    const appKey = typeof request.headers['x-open-app-key'] === 'string' ? request.headers['x-open-app-key'].trim() : '';
    const timestamp =
      typeof request.headers['x-open-timestamp'] === 'string' ? request.headers['x-open-timestamp'].trim() : '';
    const signature =
      typeof request.headers['x-open-signature'] === 'string'
        ? request.headers['x-open-signature'].trim().toLowerCase()
        : '';
    const routePath = request.url.split('?')[0] ?? request.url;

    let targetDb = privateDb;
    let targetAdapter = null;
    let appInfo = null;

    try {
      const targetResolution = await resolveTenantPublicTarget(params.tenantKey);
      if ('error' in targetResolution) {
        return reply.code(targetResolution.error.statusCode).send({ message: targetResolution.error.message });
      }
      targetDb = targetResolution.targetDb;
      targetAdapter = targetResolution.targetAdapter;

      if (false && runtimeConfig.deploymentMode === 'saas') {
        if (!controlPlaneDb) {
          return reply.code(404).send({ message: '当前部署模式未启用 SaaS 控制面。' });
        }
        const tenant = (await controlPlaneDb.listTenants()).find((item) => item.tenantKey === params.tenantKey) ?? null;
        if (!tenant || tenant.status !== 'active') {
          return reply.code(404).send({ message: '租户不存在或未启用。' });
        }
        targetDb = databaseProvider.ensureTenantDatabase(tenant);
      }

      const targetClient =
        targetAdapter &&
        typeof targetAdapter.openPlatformVerifyRequest === 'function' &&
        typeof targetAdapter.openPlatformGetPublicOrdersOverview === 'function' &&
        typeof targetAdapter.openPlatformRecordCallLog === 'function'
          ? targetAdapter
          : targetDb;

      appInfo = await targetClient.openPlatformVerifyRequest({
        tenantKey: params.tenantKey,
        appKey,
        timestamp,
        signature,
        httpMethod: 'GET',
        routePath,
        requestIp,
        requiredScope: 'orders.read',
      });

      const payload = await targetClient.openPlatformGetPublicOrdersOverview();
      await targetClient.openPlatformRecordCallLog({
        appId: appInfo.id,
        appKey: appInfo.appKey,
        tenantKey: params.tenantKey,
        traceId: `opl_${request.id}`,
        httpMethod: 'GET',
        routePath,
        requestIp,
        statusCode: 200,
        callStatus: 'success',
        durationMs: Date.now() - startedAt,
        detail: '订单中心概览读取成功',
      });
      return payload;
    } catch (error) {
      if (appInfo || appKey) {
        const logClient =
          targetAdapter && typeof targetAdapter.openPlatformRecordCallLog === 'function'
            ? targetAdapter
            : targetDb;
        await logClient.openPlatformRecordCallLog({
          appId: appInfo?.id ?? null,
          appKey: appInfo?.appKey ?? (appKey || 'unknown'),
          tenantKey: params.tenantKey,
          traceId: `opl_${request.id}`,
          httpMethod: 'GET',
          routePath,
          requestIp,
          statusCode: 403,
          callStatus: 'blocked',
          durationMs: Date.now() - startedAt,
          detail: error instanceof Error ? error.message : '开放平台访问被拒绝',
        });
      }

      return reply.code(403).send({ message: error instanceof Error ? error.message : '开放平台访问被拒绝' });
    }
  });
}
