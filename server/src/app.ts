// @ts-nocheck
import fs from 'node:fs';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { z, ZodError } from 'zod';
import { canAccessRoles, canManageWorkspaceFeature, canViewWorkspaceFeature, routeAccessPolicy, } from './access-control.js';
import { createAiBargainRuntime } from './ai-bargain-runtime.js';
import { createAiServiceRuntime } from './ai-service-runtime.js';
import QRCode from 'qrcode';
import { comparePassword, decryptSecret, encryptSecret, needsPasswordRehash, hashPassword } from './auth.js';
import { createAutoBackupJob } from './background-jobs.js';
import { assertValidRuntimeConfig, appConfig, ensureRuntimeDirectories, getEnvProfileForRuntimeMode, } from './config.js';
import { createControlPlaneStore } from './control-plane-store.js';
import { createDatabaseFacade, DatabaseProvider } from './database-provider.js';
import { StatisticsDatabase } from './database.js';
import { registerExternalFulfillmentCallbackRoutes } from './external-fulfillment-callback-routes.js';
import { createFulfillmentQueueBackend } from './fulfillment-queue-backend.js';
import { registerFulfillmentConfigRoutes } from './fulfillment-config-routes.js';
import { registerOpenPlatformRoutes } from './open-platform-routes.js';
import { registerOrdersRoutes } from './orders-routes.js';
import { registerStoreRoutes } from './store-routes.js';
import { registerWorkspaceAiBargainRoutes } from './workspace-ai-bargain-routes.js';
import { registerWorkspaceAiServiceRoutes } from './workspace-ai-service-routes.js';
import { registerWorkspaceFundRoutes } from './workspace-fund-routes.js';
import { registerWorkspaceFulfillmentRoutes } from './workspace-fulfillment-routes.js';
import { registerWorkspaceRoutes } from './workspace-routes.js';
import { AppMetricsCollector, createAppLogger, createRequestId, resolveRouteLabel, sanitizeUrlForLog, summarizeRequestForLog, } from './observability.js';
import { StoreAuthLiveStreamManager } from './store-auth-live-stream.js';
import { getRequestContext, runWithRequestContext } from './request-context.js';
import { getRuntimeDependencyChecks } from './runtime-dependency-checks.js';
import { createStoreHealthRuntime } from './store-health-runtime.js';
import { createXianyuDataSyncRuntime } from './xianyu-data-sync-runtime.js';
import * as xianyuWebSessionService from './xianyu-web-session.js';
import { loginSchema, mfaVerifySchema, platformMfaConfirmSchema, changePasswordSchema, tenantSelectSchema, platformTenantCreateSchema, platformTenantMembershipSchema, platformTenantStatusSchema, baseFilterSchema, listQuerySchema, storeAuthProviderCallbackSchema, xianyuProductSyncSchema, xianyuOrderSyncSchema, systemUserCreateSchema, systemUserRoleSchema, systemUserStatusSchema, secureSettingUpsertSchema, } from './schemas.js';
import { buildTotpOtpAuthUrl, generateTotpSecret, verifyTotpCode } from './totp.js';
const AUTH_COOKIE_NAME = 'goofish-statistics-auth';
function parseCookieHeader(cookieHeader) {
    const source = Array.isArray(cookieHeader) ? cookieHeader.join(';') : cookieHeader ?? '';
    return source
        .split(';')
        .map((entry) => entry.trim())
        .filter(Boolean)
        .reduce((cookies, entry) => {
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
function shouldUseSecureAuthCookie(request, trustProxy) {
    if (request.protocol === 'https') {
        return true;
    }
    if (!trustProxy) {
        return false;
    }
    const forwardedProtoHeader = request.headers['x-forwarded-proto'];
    const forwardedProto = typeof forwardedProtoHeader === 'string'
        ? forwardedProtoHeader.split(',')[0]?.trim().toLowerCase()
        : '';
    return forwardedProto === 'https';
}
function buildAuthCookie(token, request, maxAgeSeconds, trustProxy) {
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
function buildExpiredAuthCookie(request, trustProxy) {
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
function resolveRequestAuthToken(request) {
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
const APP_VERSION = process.env.APP_VERSION?.trim() || '2.0.0';
function sanitizeUser(user) {
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
function sanitizePlatformUser(user) {
    return {
        id: user.id,
        username: user.username,
        displayName: user.displayName,
        role: user.role,
        status: user.status,
        createdAt: user.createdAt,
        updatedAt: user.updatedAt,
        lastLoginAt: user.lastLoginAt,
        passwordChangedAt: user.passwordChangedAt,
    };
}
function sanitizeTenant(tenant) {
    return {
        id: tenant.id,
        tenantKey: tenant.tenantKey,
        tenantName: tenant.tenantName,
        displayName: tenant.displayName,
        status: tenant.status,
        businessDbPath: tenant.businessDbPath,
        createdAt: tenant.createdAt,
        updatedAt: tenant.updatedAt,
        provisionedAt: tenant.provisionedAt,
        suspendedAt: tenant.suspendedAt,
    };
}
function sanitizeTenantMembership(membership) {
    return {
        id: membership.id,
        tenantId: membership.tenantId,
        platformUserId: membership.platformUserId,
        membershipRole: membership.membershipRole,
        systemRole: membership.systemRole,
        status: membership.status,
        createdAt: membership.createdAt,
        updatedAt: membership.updatedAt,
    };
}
function resolveRequestIp(request) {
    // Fastify 的 trustProxy 配置已正确处理 x-forwarded-for
    // 直接使用 request.ip 避免客户端伪造 IP 绕过限流
    return request.ip;
}
function resolveBooleanEnv(value, fallback) {
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
export async function createApp(options: any = undefined) {
    const deploymentMode = options?.deploymentMode ?? appConfig.deploymentMode;
    const runtimeMode = options?.runtimeMode ?? appConfig.runtimeMode;
    const seedDemoData = options?.seedDemoData ?? (options?.runtimeMode ? runtimeMode === 'demo' : appConfig.seedDemoData);
    const runtimeConfig = {
        ...appConfig,
        deploymentMode,
        runtimeMode,
        backgroundJobsMode: options?.backgroundJobsMode ?? appConfig.backgroundJobsMode,
        envProfile: getEnvProfileForRuntimeMode(runtimeMode),
        seedDemoData,
        dbPath: options?.dbPath ?? appConfig.dbPath,
        controlPlaneDbPath: options?.controlPlaneDbPath ?? appConfig.controlPlaneDbPath,
        tenantDatabaseRoot: options?.tenantDatabaseRoot ?? appConfig.tenantDatabaseRoot,
        bootstrapAdmin: options?.bootstrapAdmin ?? appConfig.bootstrapAdmin,
    };
    assertValidRuntimeConfig(runtimeConfig);
    ensureRuntimeDirectories(runtimeConfig);
    const logger = createAppLogger(runtimeConfig);
    const metrics = new AppMetricsCollector();
    const embeddedAutoBackupJob = createAutoBackupJob({
        config: runtimeConfig,
        logger,
        scheduleMode: 'embedded',
    });
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
    const databaseProvider = new DatabaseProvider({
        privateDbPath: runtimeConfig.dbPath,
        tenantDatabaseRoot: runtimeConfig.tenantDatabaseRoot,
        businessDatabaseEngine: runtimeConfig.businessDatabaseEngine,
        businessPostgresUrl: runtimeConfig.businessPostgresUrl,
        tenantBusinessDatabaseEngine: runtimeConfig.tenantBusinessDatabaseEngine,
        tenantBusinessPostgresUrlTemplate: runtimeConfig.tenantBusinessPostgresUrlTemplate,
        forceReseed: options?.forceReseed,
        runtimeMode,
        seedDemoData,
        bootstrapAdmin: runtimeConfig.bootstrapAdmin,
    });
    databaseProvider.initializePrivateDatabase();
    const db = createDatabaseFacade(databaseProvider);
    const privateDb = databaseProvider.getPrivateDatabase();
    const fulfillmentQueueBackend = createFulfillmentQueueBackend({
        config: runtimeConfig,
        db,
        logger,
    });
    await fulfillmentQueueBackend.ensureReady();
    const aiServiceRuntime = createAiServiceRuntime({
        config: runtimeConfig,
        db,
        logger,
    });
    const aiBargainRuntime = createAiBargainRuntime({
        config: runtimeConfig,
        db,
        logger,
    });
    const xianyuDataSyncRuntime = createXianyuDataSyncRuntime({
        config: runtimeConfig,
        db,
        logger,
    });
    const storeHealthRuntime = createStoreHealthRuntime({
        config: runtimeConfig,
        db,
        logger,
    });
    const { syncAiServiceStoreTarget, sendAiServiceXianyuMessage, tryLlmReply } = aiServiceRuntime;
    const { syncAiBargainStoreTarget } = aiBargainRuntime;
    const { runStoreHealthCheck, runBatchStoreHealthChecks, verifyManagedStoreCredential, renewManagedStoreCredentialViaBrowser, } = storeHealthRuntime;
    const embeddedAiServiceAutoSyncJob = aiServiceRuntime.createAutoSyncJob({
        scheduleMode: 'embedded',
    });
    const embeddedAiBargainAutoSyncJob = aiBargainRuntime.createAutoSyncJob({
        scheduleMode: 'embedded',
    });
    const embeddedXianyuDataAutoSyncJob = xianyuDataSyncRuntime.createAutoSyncJob({
        scheduleMode: 'embedded',
    });
    const embeddedStoreHealthAutoCheckJob = storeHealthRuntime.createAutoHealthCheckJob({
        scheduleMode: 'embedded',
    });
    const embeddedStoreBrowserAutoRenewJob = storeHealthRuntime.createAutoBrowserRenewJob({
        scheduleMode: 'embedded',
    });
    const controlPlaneDb = runtimeConfig.deploymentMode === 'saas'
        ? await createControlPlaneStore({
            engine: runtimeConfig.controlPlaneDatabaseEngine,
            sqliteDbPath: runtimeConfig.controlPlaneDbPath,
            postgresUrl: runtimeConfig.controlPlanePostgresUrl,
        })
        : null;
    if (controlPlaneDb) {
        await controlPlaneDb.initialize({
            forceReseed: options?.forceReseed,
            runtimeMode,
            bootstrapAdmin: runtimeConfig.bootstrapAdmin,
            tenantResolver: databaseProvider.getTenantResolver(),
            migrationRunner: databaseProvider.getMigrationRunner(),
            seedDemoData,
        });
    }
    const storeAuthLiveStreamManager = new StoreAuthLiveStreamManager();
    const runtimeDependencies = await getRuntimeDependencyChecks(runtimeConfig);
    const publishFulfillmentQueueTask = async (payload) => {
        const queueTaskId = Number(payload?.queueTaskId);
        if (!Number.isInteger(queueTaskId) || queueTaskId <= 0) {
            return;
        }
        try {
            await fulfillmentQueueBackend.enqueue(queueTaskId);
        }
        catch (error) {
            logger.error('fulfillment_queue_publish_failed', '履约任务发布到队列后端失败', {
                queueBackend: runtimeConfig.queueBackend,
                queueTaskId,
                message: error instanceof Error ? error.message : 'unknown',
            });
        }
    };
    logger.info('app_bootstrap', '应用实例初始化完成', {
        dbPath: runtimeConfig.dbPath,
        deploymentMode: runtimeConfig.deploymentMode,
        runtimeMode,
        envProfile: runtimeConfig.envProfile,
        businessDatabaseEngine: runtimeConfig.businessDatabaseEngine,
        tenantBusinessDatabaseEngine: runtimeConfig.tenantBusinessDatabaseEngine,
        controlPlaneDatabaseEngine: runtimeConfig.controlPlaneDatabaseEngine,
        queueBackend: runtimeConfig.queueBackend,
        metricsEnabled: runtimeConfig.metricsEnabled,
        businessDatabaseRuntime: databaseProvider.getRuntimeSummary(),
        fulfillmentQueueRuntime: fulfillmentQueueBackend.getRuntimeStatus(),
        runtimeDependencies,
    });
    const rateLimits = new Map();
    const hitRateLimit = (key, limit, windowMinutes) => {
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
    const buildTenantScopedUser = (platformUser, membership) => ({
        id: platformUser.id,
        username: platformUser.username,
        displayName: platformUser.displayName,
        role: membership.systemRole,
        status: platformUser.status === 'active' && membership.status === 'active' ? 'active' : 'disabled',
        createdAt: platformUser.createdAt,
        updatedAt: platformUser.updatedAt,
        lastLoginAt: platformUser.lastLoginAt,
        tokenVersion: platformUser.tokenVersion ?? 0,
    });
    const createSignedAuthSession = async (request, reply, claims) => {
        const expiresAt = new Date(Date.now() + runtimeConfig.jwtExpiresMinutes * 60 * 1000).toISOString();
        const token = await reply.jwtSign(claims);
        reply.header('set-cookie', buildAuthCookie(token, request, runtimeConfig.jwtExpiresMinutes * 60, runtimeConfig.trustProxy));
        return { token, expiresAt };
    };
    const createPrivateAuthSession = async (request, reply, user) => {
        const session = await createSignedAuthSession(request, reply, {
            sub: user.id,
            username: user.username,
            displayName: user.displayName,
            role: user.role,
            status: user.status,
            ver: user.tokenVersion ?? 0,
            scope: 'private',
        });
        return {
            ...session,
            scope: 'private',
            user: sanitizeUser(user),
        };
    };
    const createAuthSession = createPrivateAuthSession;
    const createPlatformAuthSession = async (request, reply, user) => {
        const session = await createSignedAuthSession(request, reply, {
            sub: user.id,
            username: user.username,
            displayName: user.displayName,
            role: user.role,
            status: user.status,
            ver: user.tokenVersion ?? 0,
            scope: 'platform',
        });
        return {
            ...session,
            scope: 'platform',
            user: sanitizePlatformUser(user),
        };
    };
    const buildPlatformMfaRefKey = (userId, stage) => `platform-mfa:${stage}:${userId}`;
    const resolvePlatformMfaSecret = async (user) => {
        if (!controlPlaneDb || !user?.mfaSecretRefId) {
            return null;
        }
        const secretRef = await controlPlaneDb.getSecretRefById(user.mfaSecretRefId);
        if (!secretRef?.cipherText) {
            return null;
        }
        return {
            secretRef,
            secret: decryptSecret(secretRef.cipherText, runtimeConfig.secureConfigSecret),
        };
    };
    const createPlatformMfaChallenge = async (user) => {
        const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
        const challengeToken = await app.jwt.sign({
            sub: user.id,
            username: user.username,
            displayName: user.displayName,
            ver: user.tokenVersion ?? 0,
            purpose: 'platform_mfa',
        }, {
            expiresIn: '5m',
        });
        return {
            scope: 'platform_mfa',
            challengeToken,
            expiresAt,
            user: sanitizePlatformUser(user),
            nextStep: 'verify_mfa',
        };
    };
    const createTenantAuthSession = async (request, reply, platformUser, tenant, membership) => {
        const tenantUser = buildTenantScopedUser(platformUser, membership);
        const session = await createSignedAuthSession(request, reply, {
            sub: platformUser.id,
            username: platformUser.username,
            displayName: platformUser.displayName,
            role: membership.systemRole,
            status: tenantUser.status,
            ver: platformUser.tokenVersion ?? 0,
            scope: 'tenant',
            tenantId: tenant.id,
            membershipRole: membership.membershipRole,
            systemRole: membership.systemRole,
        });
        return {
            ...session,
            scope: 'tenant',
            user: sanitizeUser(tenantUser),
            tenant: sanitizeTenant(tenant),
            membership: sanitizeTenantMembership(membership),
        };
    };
    const legacyRequireCurrentUser = async (request, reply) => {
        const requestUrlForLog = sanitizeUrlForLog(request.url);
        const shouldAuditMissingAuth = !(request.method === 'POST' && requestUrlForLog === '/api/auth/refresh');
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
        let tokenPayload;
        try {
            tokenPayload = await app.jwt.verify(authToken);
        }
        catch {
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
    const legacyAuthenticate = async (request, reply) => {
        await legacyRequireCurrentUser(request, reply);
    };
    const legacyAuthorizeRoles = (allowedRoles, targetType, actionLabel) => async (request, reply) => {
        const currentUser = await legacyRequireCurrentUser(request, reply);
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
    const legacyAuthorizeWorkspace = (mode) => async (request, reply) => {
        const currentUser = await legacyRequireCurrentUser(request, reply);
        if (!currentUser) {
            return;
        }
        const featureKey = request.params?.featureKey?.trim() ?? '';
        const allowed = mode === 'view'
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
    const recordPlatformAudit = (input) => {
        if (controlPlaneDb) {
            void controlPlaneDb.recordAuditLog(input);
            return;
        }
        privateDb.recordAuditLog({
            action: input.action,
            targetType: input.targetType,
            targetId: input.targetId ?? null,
            detail: input.detail,
            result: input.result,
            ipAddress: input.ipAddress ?? undefined,
        });
    };
    const resolveVerifiedAuthClaims = async (request, reply, options = {}) => {
        const requestUrlForLog = sanitizeUrlForLog(request.url);
        const shouldAuditMissingAuth = !options.allowMissingForRefresh ||
            !(request.method === 'POST' && requestUrlForLog === '/api/auth/refresh');
        const authToken = resolveRequestAuthToken(request);
        if (!authToken) {
            if (shouldAuditMissingAuth) {
                if (runtimeConfig.deploymentMode === 'saas') {
                    recordPlatformAudit({
                        action: 'unauthorized_access',
                        targetType: options.auditTargetType ?? 'api',
                        targetId: requestUrlForLog,
                        detail: `未登录访问 ${request.method} ${requestUrlForLog}。`,
                        result: 'blocked',
                        ipAddress: resolveRequestIp(request),
                    });
                }
                else {
                    privateDb.recordAuditLog({
                        action: 'unauthorized_access',
                        targetType: options.auditTargetType ?? 'api',
                        targetId: requestUrlForLog,
                        detail: `未登录访问 ${request.method} ${requestUrlForLog}。`,
                        result: 'blocked',
                        ipAddress: resolveRequestIp(request),
                    });
                }
            }
            reply.code(401).send({ message: '登录已失效，请重新登录' });
            return null;
        }
        try {
            const claims = await app.jwt.verify(authToken);
            request.authClaims = claims;
            request.authScope = claims.scope;
            return claims;
        }
        catch {
            if (runtimeConfig.deploymentMode === 'saas') {
                recordPlatformAudit({
                    action: 'unauthorized_access',
                    targetType: options.auditTargetType ?? 'api',
                    targetId: requestUrlForLog,
                    detail: `无效会话访问 ${request.method} ${requestUrlForLog}。`,
                    result: 'blocked',
                    ipAddress: resolveRequestIp(request),
                });
            }
            else {
                privateDb.recordAuditLog({
                    action: 'unauthorized_access',
                    targetType: options.auditTargetType ?? 'api',
                    targetId: requestUrlForLog,
                    detail: `无效会话访问 ${request.method} ${requestUrlForLog}。`,
                    result: 'blocked',
                    ipAddress: resolveRequestIp(request),
                });
            }
            reply.code(401).send({ message: '登录已失效，请重新登录' });
            return null;
        }
    };
    const requirePlatformUser = async (request, reply) => {
        if (!controlPlaneDb) {
            reply.code(404).send({ message: '当前部署模式未启用平台控制面。' });
            return null;
        }
        const claims = await resolveVerifiedAuthClaims(request, reply, { auditTargetType: 'platform' });
        if (!claims) {
            return null;
        }
        const userId = Number(claims.sub ?? 0);
        if (!userId) {
            reply.code(401).send({ message: '登录状态无效，请重新登录' });
            return null;
        }
        const user = await controlPlaneDb.getPlatformUserById(userId);
        if (!user) {
            recordPlatformAudit({
                action: 'unauthorized_access',
                targetType: 'platform',
                targetId: String(userId),
                detail: '平台令牌对应的账号不存在。',
                result: 'blocked',
                ipAddress: resolveRequestIp(request),
            });
            reply.code(401).send({ message: '账号不存在，请重新登录' });
            return null;
        }
        if (Number(claims.ver ?? 0) !== (user.tokenVersion ?? 0)) {
            recordPlatformAudit({
                action: 'unauthorized_access',
                targetType: 'platform',
                targetId: String(user.id),
                detail: '平台令牌版本已失效。',
                result: 'blocked',
                operatorUserId: user.id,
                ipAddress: resolveRequestIp(request),
            });
            reply.code(401).send({ message: '登录状态已失效，请重新登录' });
            return null;
        }
        if (user.status !== 'active') {
            recordPlatformAudit({
                action: 'login_blocked',
                targetType: 'platform_user',
                targetId: String(user.id),
                detail: `停用平台账号 ${user.username} 尝试访问平台接口。`,
                result: 'blocked',
                operatorUserId: user.id,
                ipAddress: resolveRequestIp(request),
            });
            reply.code(403).send({ message: '当前账号已停用' });
            return null;
        }
        request.currentPlatformUser = user;
        const context = getRequestContext();
        if (context) {
            context.platformUser = user;
            context.scope = claims.scope === 'platform' ? 'platform' : context.scope;
        }
        return user;
    };
    const requireCurrentUser = async (request, reply) => {
        if (runtimeConfig.deploymentMode === 'private') {
            const claims = await resolveVerifiedAuthClaims(request, reply, {
                auditTargetType: 'api',
                allowMissingForRefresh: true,
            });
            if (!claims) {
                return null;
            }
            const userId = Number(claims.sub ?? 0);
            if (!userId) {
                reply.code(401).send({ message: '登录状态无效，请重新登录' });
                return null;
            }
            const user = privateDb.getUserById(userId);
            if (!user) {
                privateDb.recordAuditLog({
                    action: 'unauthorized_access',
                    targetType: 'auth',
                    targetId: String(userId),
                    detail: '令牌用户不存在，访问已拒绝。',
                    result: 'blocked',
                    ipAddress: resolveRequestIp(request),
                });
                reply.code(401).send({ message: '账号不存在，请重新登录' });
                return null;
            }
            if (Number(claims.ver ?? 0) !== (user.tokenVersion ?? 0)) {
                privateDb.recordAuditLog({
                    action: 'unauthorized_access',
                    targetType: 'auth',
                    targetId: String(user.id),
                    detail: '令牌已失效，访问已拒绝。',
                    result: 'blocked',
                    ipAddress: resolveRequestIp(request),
                });
                reply.code(401).send({ message: '登录状态已失效，请重新登录' });
                return null;
            }
            if (user.status !== 'active') {
                privateDb.recordAuditLog({
                    action: 'login_blocked',
                    targetType: 'user',
                    targetId: String(user.id),
                    detail: `停用账号 ${user.username} 尝试访问接口。`,
                    result: 'blocked',
                    operator: user,
                    ipAddress: resolveRequestIp(request),
                });
                reply.code(403).send({ message: '当前账号已停用' });
                return null;
            }
            request.currentUser = user;
            const context = getRequestContext();
            if (context) {
                context.scope = 'private';
                context.businessDb = privateDb;
            }
            return user;
        }
        const platformUser = await requirePlatformUser(request, reply);
        if (!platformUser) {
            return null;
        }
        if (request.authClaims?.scope !== 'tenant') {
            recordPlatformAudit({
                action: 'unauthorized_access',
                targetType: 'tenant_api',
                targetId: sanitizeUrlForLog(request.url),
                detail: `${platformUser.displayName} 尝试使用平台会话访问租户业务接口。`,
                result: 'blocked',
                operatorUserId: platformUser.id,
                ipAddress: resolveRequestIp(request),
            });
            reply.code(403).send({ message: '当前会话尚未选择租户，请先完成租户切换。' });
            return null;
        }
        const tenantId = Number(request.authClaims.tenantId ?? 0);
        if (!tenantId) {
            reply.code(401).send({ message: '租户会话无效，请重新选择租户。' });
            return null;
        }
        const tenant = controlPlaneDb ? await controlPlaneDb.getTenantById(tenantId) : null;
        if (!tenant) {
            recordPlatformAudit({
                action: 'unauthorized_access',
                targetType: 'tenant',
                targetId: String(tenantId),
                detail: '租户令牌对应的租户不存在。',
                result: 'blocked',
                operatorUserId: platformUser.id,
                ipAddress: resolveRequestIp(request),
            });
            reply.code(401).send({ message: '租户不存在，请重新选择租户。' });
            return null;
        }
        if (tenant.status !== 'active') {
            recordPlatformAudit({
                action: 'tenant_access_blocked',
                targetType: 'tenant',
                targetId: String(tenant.id),
                detail: `${platformUser.displayName} 访问了非激活租户 ${tenant.tenantKey}。`,
                result: 'blocked',
                operatorUserId: platformUser.id,
                tenantId: tenant.id,
                ipAddress: resolveRequestIp(request),
            });
            reply.code(403).send({ message: '当前租户未激活或已暂停。' });
            return null;
        }
        const membership = controlPlaneDb
            ? await controlPlaneDb.getTenantMembership(platformUser.id, tenant.id)
            : null;
        if (!membership || membership.status !== 'active') {
            recordPlatformAudit({
                action: 'tenant_access_blocked',
                targetType: 'tenant_membership',
                targetId: tenant.tenantKey,
                detail: `${platformUser.displayName} 不是租户 ${tenant.tenantKey} 的有效成员。`,
                result: 'blocked',
                operatorUserId: platformUser.id,
                tenantId: tenant.id,
                ipAddress: resolveRequestIp(request),
            });
            reply.code(403).send({ message: '当前账号无权访问该租户。' });
            return null;
        }
        const tenantDb = databaseProvider.ensureTenantDatabase(tenant);
        const tenantUser = buildTenantScopedUser(platformUser, membership);
        request.currentPlatformUser = platformUser;
        request.currentTenant = tenant;
        request.currentMembership = membership;
        request.currentUser = tenantUser;
        const context = getRequestContext();
        if (context) {
            context.scope = 'tenant';
            context.businessDb = tenantDb;
            context.tenant = tenant;
            context.platformUser = platformUser;
            context.membership = membership;
        }
        return tenantUser;
    };
    const authenticate = async (request, reply) => {
        await requireCurrentUser(request, reply);
    };
    const authenticateSaasSession = async (request, reply) => {
        if (runtimeConfig.deploymentMode !== 'saas') {
            reply.code(404).send({ message: '当前部署模式未启用租户切换。' });
            return;
        }
        await requirePlatformUser(request, reply);
    };
    const authenticatePlatform = async (request, reply) => {
        const user = await requirePlatformUser(request, reply);
        if (!user) {
            return;
        }
        if (request.authClaims?.scope !== 'platform') {
            recordPlatformAudit({
                action: 'unauthorized_access',
                targetType: 'platform',
                targetId: sanitizeUrlForLog(request.url),
                detail: `${user.displayName} 尝试使用租户会话访问平台接口。`,
                result: 'blocked',
                operatorUserId: user.id,
                tenantId: request.authClaims?.tenantId ?? null,
                ipAddress: resolveRequestIp(request),
            });
            reply.code(403).send({ message: '平台接口仅接受平台作用域会话。' });
        }
    };
    const authorizePlatformAdmin = async (request, reply) => {
        const user = await requirePlatformUser(request, reply);
        if (!user) {
            return;
        }
        if (request.authClaims?.scope !== 'platform') {
            recordPlatformAudit({
                action: 'unauthorized_access',
                targetType: 'platform',
                targetId: sanitizeUrlForLog(request.url),
                detail: `${user.displayName} 尝试使用租户会话执行平台管理员操作。`,
                result: 'blocked',
                operatorUserId: user.id,
                tenantId: request.authClaims?.tenantId ?? null,
                ipAddress: resolveRequestIp(request),
            });
            reply.code(403).send({ message: '平台接口仅接受平台作用域会话。' });
            return;
        }
        if (user.role === 'platform_admin') {
            return;
        }
        recordPlatformAudit({
            action: 'unauthorized_access',
            targetType: 'platform',
            targetId: sanitizeUrlForLog(request.url),
            detail: `${user.displayName} 尝试执行平台管理员操作。`,
            result: 'blocked',
            operatorUserId: user.id,
            ipAddress: resolveRequestIp(request),
        });
        reply.code(403).send({ message: '当前平台账号无权执行该操作' });
    };
    const authorizeRoles = (allowedRoles, targetType, actionLabel) => async (request, reply) => {
        const currentUser = await requireCurrentUser(request, reply);
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
    const authorizeWorkspaceFeature = (featureKey, mode, actionLabel) => async (request, reply) => {
        const currentUser = await requireCurrentUser(request, reply);
        if (!currentUser) {
            return;
        }
        const allowed = mode === 'view'
            ? canViewWorkspaceFeature(currentUser.role, featureKey)
            : canManageWorkspaceFeature(currentUser.role, featureKey);
        if (allowed) {
            return;
        }
        db.recordAuditLog({
            action: 'unauthorized_access',
            targetType: 'workspace',
            targetId: featureKey,
            detail: `${currentUser.displayName} 尝试${mode === 'view' ? '查看' : '操作'}工作台模块 ${featureKey}：${actionLabel}。`,
            result: 'blocked',
            operator: currentUser,
            ipAddress: resolveRequestIp(request),
        });
        reply.code(403).send({ message: '当前账号无权访问该模块' });
    };
    const authorizeWorkspace = (mode) => async (request, reply) => {
        const currentUser = await requireCurrentUser(request, reply);
        if (!currentUser) {
            return;
        }
        const featureKey = request.params?.featureKey?.trim() ?? '';
        const allowed = mode === 'view'
            ? canViewWorkspaceFeature(currentUser.role, featureKey)
            : canManageWorkspaceFeature(currentUser.role, featureKey);
        if (allowed) {
            return;
        }
        db.recordAuditLog({
            action: 'unauthorized_access',
            targetType: 'workspace',
            targetId: featureKey || sanitizeUrlForLog(request.url),
            detail: `${currentUser.displayName} 尝试${mode === 'view' ? '查看' : '操作'}工作台模块 ${featureKey}。`,
            result: 'blocked',
            operator: currentUser,
            ipAddress: resolveRequestIp(request),
        });
        reply.code(403).send({ message: '当前账号无权访问该模块' });
    };
    const ensurePrivilegedWriteAllowed = (request, reply, currentUser, actionLabel) => {
        const limited = hitRateLimit(`privileged:${currentUser.id}`, runtimeConfig.privilegedWriteLimit, runtimeConfig.privilegedWriteWindowMinutes);
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
    const buildStoreAuthSessionLiveSnapshot = (sessionId) => {
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
    const publishStoreAuthSessionLiveSnapshot = (sessionId) => {
        const snapshot = buildStoreAuthSessionLiveSnapshot(sessionId);
        if (!snapshot) {
            return;
        }
        storeAuthLiveStreamManager.publishSnapshot(sessionId, snapshot);
    };
    const unsubscribeQrLoginSnapshots = xianyuWebSessionService.xianyuQrLoginManager.subscribe((snapshot) => {
        publishStoreAuthSessionLiveSnapshot(snapshot.authSessionId);
    });
    const processStoreAuthProviderCallback = async (request, reply, input) => {
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
    app.addHook('onRequest', (request, reply, done) => {
        runWithRequestContext({
            scope: runtimeConfig.deploymentMode === 'private' ? 'private' : null,
            businessDb: privateDb,
            tenant: null,
            platformUser: null,
            membership: null,
        }, () => {
            const appRequest = request;
            appRequest.requestStartedAt = metrics.startRequest();
            reply.header('x-request-id', request.id);
            done();
        });
    });
    app.addHook('onResponse', async (request, reply) => {
        const appRequest = request;
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
        const statusCode = typeof error.statusCode === 'number'
            ? Number(error.statusCode)
            : 500;
        logger[statusCode >= 500 ? 'error' : 'warn']('request_error', statusCode >= 500 ? '接口处理异常' : '接口请求被拒绝', {
            requestId: request.id,
            method: request.method,
            url: sanitizeUrlForLog(request.url),
            statusCode,
            errorMessage: error instanceof Error ? error.message : 'unknown',
        });
        if (statusCode >= 500) {
            return reply.code(500).send({ message: '服务暂时不可用，请稍后重试' });
        }
        const safeMessage = error instanceof Error ? error.message : '请求处理失败';
        return reply.code(statusCode).send({ message: safeMessage || '请求处理失败' });
    });
    if (runtimeConfig.backgroundJobsMode === 'embedded') {
        embeddedAutoBackupJob.start();
        embeddedAiServiceAutoSyncJob.start();
        embeddedAiBargainAutoSyncJob.start();
        embeddedXianyuDataAutoSyncJob.start();
        embeddedStoreHealthAutoCheckJob.start();
        embeddedStoreBrowserAutoRenewJob.start();
    }
    app.addHook('onClose', async () => {
        embeddedAutoBackupJob.stop();
        embeddedAiServiceAutoSyncJob.stop();
        embeddedAiBargainAutoSyncJob.stop();
        embeddedXianyuDataAutoSyncJob.stop();
        embeddedStoreHealthAutoCheckJob.stop();
        embeddedStoreBrowserAutoRenewJob.stop();
        unsubscribeQrLoginSnapshots();
        storeAuthLiveStreamManager.closeAll();
        logger.info('app_shutdown', '应用实例已关闭', { dbPath: runtimeConfig.dbPath });
        await fulfillmentQueueBackend.close();
        await controlPlaneDb?.close();
        await databaseProvider.closeAll();
    });
    const authorizeMetricsAccess = async (request, reply) => {
        if (!runtimeConfig.metricsEnabled) {
            reply.code(404).send({ message: '指标接口未启用' });
            return false;
        }
        const configuredToken = runtimeConfig.metricsToken?.trim();
        if (configuredToken) {
            const requestToken = typeof request.headers['x-metrics-token'] === 'string'
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
        const currentUser = await requireCurrentUser(request, reply);
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
    const resolveMetricsHealthSnapshot = async (request, reply) => {
        let currentTenant = request.currentTenant;
        if (!currentTenant &&
            runtimeConfig.deploymentMode === 'saas' &&
            typeof request.headers.authorization === 'string' &&
            request.headers.authorization.trim()) {
            const currentUser = await requireCurrentUser(request, reply);
            if (!currentUser) {
                return null;
            }
            currentTenant = request.currentTenant;
        }
        let fallbackHealthSnapshot = null;
        let fallbackDetail = null;
        const getFallbackHealthSnapshot = () => {
            if (!fallbackHealthSnapshot) {
                fallbackHealthSnapshot = db.getSystemHealthSnapshot();
            }
            return fallbackHealthSnapshot;
        };
        const getFallbackDetail = () => {
            if (!fallbackDetail) {
                fallbackDetail = db.getWorkspaceBusinessDetail('system-monitoring', {});
            }
            return fallbackDetail;
        };
        if (!currentTenant || !databaseProvider.isTenantBusinessPostgresEnabled()) {
            return getFallbackHealthSnapshot();
        }
        const tenantAdapter = databaseProvider.getTenantBusinessReadAdapter(currentTenant);
        if (!tenantAdapter) {
            return getFallbackHealthSnapshot();
        }
        const adapter = tenantAdapter;
        const adapterRuntime = adapter;
        if (typeof adapterRuntime.getSystemHealthSnapshot === 'function') {
            try {
                const payload = await adapterRuntime.getSystemHealthSnapshot();
                if (payload) {
                    return payload;
                }
            }
            catch {
            }
        }
        if (typeof adapterRuntime.getSystemMonitoringDetail !== 'function') {
            return getFallbackHealthSnapshot();
        }
        const fallbackMonitoringDetail = getFallbackDetail();
        if (!fallbackMonitoringDetail) {
            return getFallbackHealthSnapshot();
        }
        const detail = await adapterRuntime.getSystemMonitoringDetail(fallbackMonitoringDetail);
        if (!detail) {
            return getFallbackHealthSnapshot();
        }
        const fallbackSnapshot = getFallbackHealthSnapshot();
        const fulfillmentGroupKeys = new Set(['card-delivery', 'direct-charge', 'source-supply']);
        const activeAlertCount = detail.alerts.filter((item) => item.status !== 'resolved').length;
        const criticalAlertCount = detail.alerts.filter((item) => item.status !== 'resolved' && item.severity === 'critical').length;
        const jobCounts = detail.jobMonitors
            .filter((item) => fulfillmentGroupKeys.has(item.groupKey))
            .reduce((summary, item) => {
            summary.pendingCount += Number(item.pendingCount ?? 0);
            summary.failedCount += Number(item.failedCount ?? 0);
            if (item.groupKey === 'direct-charge' || item.groupKey === 'source-supply') {
                summary.failedCount += Number(item.manualCount ?? 0);
            }
            return summary;
        }, { pendingCount: 0, failedCount: 0 });
        return {
            ...fallbackSnapshot,
            database: {
                ...fallbackSnapshot.database,
                sizeBytes: Number(detail.health?.databaseSizeBytes ?? fallbackSnapshot.database?.sizeBytes ?? 0),
            },
            alerts: {
                activeCount: activeAlertCount,
                criticalCount: criticalAlertCount,
            },
            jobs: jobCounts,
            backups: {
                ...fallbackSnapshot.backups,
                successCount: detail.backups.filter((item) => item.runStatus === 'success').length,
                latestBackupAt: detail.health?.latestBackupAt ?? fallbackSnapshot.backups?.latestBackupAt ?? null,
            },
        };
    };
    app.get('/api/health', async () => ({
        status: 'ok',
        service: 'goofish-sale-statistics',
        version: APP_VERSION,
        deploymentMode,
        runtimeMode,
        businessDatabase: databaseProvider.getRuntimeSummary(),
        fulfillmentQueue: fulfillmentQueueBackend.getRuntimeStatus(),
        runtimeDependencies: await getRuntimeDependencyChecks(runtimeConfig),
        timestamp: new Date().toISOString(),
    }));
    app.get('/api/metrics', async (request, reply) => {
        const allowed = await authorizeMetricsAccess(request, reply);
        if (!allowed) {
            return;
        }
        const healthSnapshot = await resolveMetricsHealthSnapshot(request, reply);
        if (!healthSnapshot && reply.sent) {
            return;
        }
        const payload = metrics.renderPrometheus({
            config: runtimeConfig,
            version: APP_VERSION,
            healthSnapshot: healthSnapshot ?? undefined,
        });
        reply.header('content-type', 'text/plain; version=0.0.4; charset=utf-8');
        return reply.send(payload);
    });
    app.post('/api/auth/login', async (request, reply) => {
        const payload = loginSchema.parse(request.body);
        const requestIp = resolveRequestIp(request);
        const limited = hitRateLimit(`login:${requestIp}`, runtimeConfig.loginMaxAttempts, runtimeConfig.loginWindowMinutes);
        if (!limited.allowed) {
            if (runtimeConfig.deploymentMode === 'saas') {
                recordPlatformAudit({
                    action: 'rate_limited',
                    targetType: 'platform_auth',
                    targetId: payload.username,
                    detail: `平台登录触发限流，用户名 ${payload.username}。`,
                    result: 'blocked',
                    ipAddress: requestIp,
                });
            }
            else {
                privateDb.recordAuditLog({
                    action: 'rate_limited',
                    targetType: 'auth',
                    targetId: payload.username,
                    detail: `登录限流触发，用户名 ${payload.username}。`,
                    result: 'blocked',
                    ipAddress: requestIp,
                });
            }
            return reply.code(429).send({ message: '登录尝试过于频繁，请稍后再试' });
        }
        if (runtimeConfig.deploymentMode === 'saas') {
            const platformUser = controlPlaneDb ? await controlPlaneDb.getPlatformUserByUsername(payload.username) : null;
            if (!platformUser || !comparePassword(payload.password, platformUser.passwordHash ?? '')) {
                recordPlatformAudit({
                    action: 'platform_login_failure',
                    targetType: 'platform_auth',
                    targetId: payload.username,
                    detail: `平台用户 ${payload.username} 登录失败。`,
                    result: 'failure',
                    ipAddress: requestIp,
                });
                return reply.code(401).send({ message: '用户名或密码错误' });
            }
            if (platformUser.status !== 'active') {
                recordPlatformAudit({
                    action: 'platform_login_failure',
                    targetType: 'platform_user',
                    targetId: String(platformUser.id),
                    detail: `停用平台账号 ${platformUser.username} 尝试登录。`,
                    result: 'blocked',
                    operatorUserId: platformUser.id,
                    ipAddress: requestIp,
                });
                return reply.code(403).send({ message: '当前账号已停用' });
            }
            const platformMfaSecret = await resolvePlatformMfaSecret(platformUser);
            if (platformMfaSecret) {
                recordPlatformAudit({
                    action: 'platform_login_mfa_required',
                    targetType: 'platform_user',
                    targetId: String(platformUser.id),
                    detail: `${platformUser.displayName} 通过口令校验，等待完成 MFA 二次验证。`,
                    result: 'warning',
                    operatorUserId: platformUser.id,
                    ipAddress: requestIp,
                });
                return createPlatformMfaChallenge(platformUser);
            }
            if (controlPlaneDb) {
                await controlPlaneDb.touchPlatformUserLastLogin(platformUser.id);
            }
            const refreshedPlatformUser = controlPlaneDb
                ? await controlPlaneDb.getPlatformUserById(platformUser.id) ?? platformUser
                : platformUser;
            const memberships = controlPlaneDb
                ? (await controlPlaneDb.listAccessibleTenantsForUser(refreshedPlatformUser.id)).map((item) => ({
                    membership: sanitizeTenantMembership(item.membership),
                    tenant: sanitizeTenant(item.tenant),
                }))
                : [];
            recordPlatformAudit({
                action: 'platform_login_success',
                targetType: 'platform_user',
                targetId: String(refreshedPlatformUser.id),
                detail: `${refreshedPlatformUser.displayName} 登录平台控制面成功。`,
                result: 'success',
                operatorUserId: refreshedPlatformUser.id,
                ipAddress: requestIp,
            });
            const session = await createPlatformAuthSession(request, reply, refreshedPlatformUser);
            return {
                ...session,
                memberships,
                nextStep: 'select_tenant',
            };
        }
        const user = privateDb.getUserByUsername(payload.username);
        if (!user || !comparePassword(payload.password, user.passwordHash ?? '')) {
            privateDb.recordAuditLog({
                action: 'login_failure',
                targetType: 'auth',
                targetId: payload.username,
                detail: `用户 ${payload.username} 登录失败。`,
                result: 'failure',
                ipAddress: requestIp,
            });
            return reply.code(401).send({ message: '用户名或密码错误' });
        }
        if (user.passwordHash && needsPasswordRehash(user.passwordHash)) {
            try {
                const newHash = hashPassword(payload.password);
                privateDb.updateUserPasswordHash(user.id, newHash);
                logger.info('password_rehash', '已自动将用户密码升级为 scrypt 哈希', {
                    userId: user.id,
                    username: user.username,
                });
            }
            catch (rehashError) {
                logger.warn('password_rehash_failed', '密码哈希迁移失败（不影响登录）', {
                    userId: user.id,
                    message: rehashError instanceof Error ? rehashError.message : 'unknown',
                });
            }
        }
        if (user.status !== 'active') {
            privateDb.recordAuditLog({
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
        privateDb.touchUserLastLogin(user.id);
        const refreshedUser = privateDb.getUserById(user.id) ?? user;
        privateDb.recordAuditLog({
            action: 'login_success',
            targetType: 'user',
            targetId: String(refreshedUser.id),
            detail: `${refreshedUser.displayName} 登录后台成功。`,
            result: 'success',
            operator: refreshedUser,
            ipAddress: requestIp,
        });
        return createPrivateAuthSession(request, reply, refreshedUser);
    });
    app.post('/api/auth/verify-mfa', async (request, reply) => {
        if (runtimeConfig.deploymentMode !== 'saas' || !controlPlaneDb) {
            return reply.code(404).send({ message: '当前部署模式未启用 MFA 验证。' });
        }
        const payload = mfaVerifySchema.parse(request.body);
        const requestIp = resolveRequestIp(request);
        let challengeClaims;
        try {
            challengeClaims = await app.jwt.verify(payload.challengeToken);
        }
        catch {
            return reply.code(401).send({ message: 'MFA 验证会话已失效，请重新登录。' });
        }
        if (challengeClaims?.purpose !== 'platform_mfa') {
            return reply.code(401).send({ message: 'MFA 验证会话无效。' });
        }
        const platformUser = await controlPlaneDb.getPlatformUserById(Number(challengeClaims.sub ?? 0));
        if (!platformUser || platformUser.status !== 'active') {
            return reply.code(401).send({ message: '平台账号状态已变化，请重新登录。' });
        }
        if (Number(challengeClaims.ver ?? 0) !== (platformUser.tokenVersion ?? 0)) {
            return reply.code(401).send({ message: 'MFA 验证会话已失效，请重新登录。' });
        }
        const platformMfaSecret = await resolvePlatformMfaSecret(platformUser);
        if (!platformMfaSecret) {
            return reply.code(400).send({ message: '当前账号未启用 MFA。' });
        }
        if (!verifyTotpCode({ secret: platformMfaSecret.secret, code: payload.code })) {
            recordPlatformAudit({
                action: 'platform_login_mfa_failure',
                targetType: 'platform_user',
                targetId: String(platformUser.id),
                detail: `${platformUser.displayName} MFA 验证失败。`,
                result: 'failure',
                operatorUserId: platformUser.id,
                ipAddress: requestIp,
            });
            return reply.code(401).send({ message: '动态验证码错误，请重试。' });
        }
        await controlPlaneDb.touchPlatformUserLastLogin(platformUser.id);
        const refreshedPlatformUser = await controlPlaneDb.getPlatformUserById(platformUser.id) ?? platformUser;
        const memberships = (await controlPlaneDb.listAccessibleTenantsForUser(refreshedPlatformUser.id)).map((item) => ({
            membership: sanitizeTenantMembership(item.membership),
            tenant: sanitizeTenant(item.tenant),
        }));
        recordPlatformAudit({
            action: 'platform_login_success',
            targetType: 'platform_user',
            targetId: String(refreshedPlatformUser.id),
            detail: `${refreshedPlatformUser.displayName} 完成 MFA 验证并登录平台控制面。`,
            result: 'success',
            operatorUserId: refreshedPlatformUser.id,
            ipAddress: requestIp,
        });
        const session = await createPlatformAuthSession(request, reply, refreshedPlatformUser);
        return {
            ...session,
            memberships,
            nextStep: 'select_tenant',
        };
    });
    app.post('/api/auth/select-tenant', { preHandler: [authenticateSaasSession] }, async (request, reply) => {
        if (runtimeConfig.deploymentMode !== 'saas' || !controlPlaneDb) {
            return reply.code(404).send({ message: '当前部署模式未启用租户切换。' });
        }
        const body = tenantSelectSchema.parse(request.body);
        const platformUser = request.currentPlatformUser;
        if (!platformUser) {
            return reply.code(401).send({ message: '平台登录状态已失效，请重新登录' });
        }
        const tenant = await controlPlaneDb.getTenantById(body.tenantId);
        if (!tenant) {
            return reply.code(404).send({ message: '租户不存在' });
        }
        const membership = await controlPlaneDb.getTenantMembership(platformUser.id, tenant.id);
        if (!membership || membership.status !== 'active') {
            recordPlatformAudit({
                action: 'tenant_selection_blocked',
                targetType: 'tenant',
                targetId: String(tenant.id),
                detail: `${platformUser.displayName} 尝试选择未授权租户 ${tenant.tenantKey}。`,
                result: 'blocked',
                operatorUserId: platformUser.id,
                tenantId: tenant.id,
                ipAddress: resolveRequestIp(request),
            });
            return reply.code(403).send({ message: '当前账号无权进入该租户' });
        }
        if (tenant.status !== 'active') {
            return reply.code(403).send({ message: '当前租户未激活或已暂停' });
        }
        databaseProvider.ensureTenantDatabase(tenant);
        recordPlatformAudit({
            action: 'tenant_selected',
            targetType: 'tenant',
            targetId: String(tenant.id),
            detail: `${platformUser.displayName} 选择了租户 ${tenant.tenantKey}。`,
            result: 'success',
            operatorUserId: platformUser.id,
            tenantId: tenant.id,
            ipAddress: resolveRequestIp(request),
        });
        return createTenantAuthSession(request, reply, platformUser, tenant, membership);
    });
    app.post('/api/auth/refresh', async (request, reply) => {
        const claims = await resolveVerifiedAuthClaims(request, reply, {
            auditTargetType: 'auth',
            allowMissingForRefresh: true,
        });
        if (!claims) {
            return;
        }
        if (runtimeConfig.deploymentMode === 'saas') {
            const platformUser = await requirePlatformUser(request, reply);
            if (!platformUser) {
                return;
            }
            if (claims.scope === 'platform') {
                recordPlatformAudit({
                    action: 'token_refresh',
                    targetType: 'platform_auth',
                    targetId: String(platformUser.id),
                    detail: `${platformUser.displayName} 完成平台会话续期。`,
                    result: 'success',
                    operatorUserId: platformUser.id,
                    ipAddress: resolveRequestIp(request),
                });
                return createPlatformAuthSession(request, reply, platformUser);
            }
            const currentUser = await requireCurrentUser(request, reply);
            const currentTenant = request.currentTenant;
            const currentMembership = request.currentMembership;
            if (!currentUser || !currentTenant || !currentMembership) {
                return;
            }
            recordPlatformAudit({
                action: 'token_refresh',
                targetType: 'tenant_auth',
                targetId: String(currentTenant.id),
                detail: `${platformUser.displayName} 完成租户会话续期。`,
                result: 'success',
                operatorUserId: platformUser.id,
                tenantId: currentTenant.id,
                ipAddress: resolveRequestIp(request),
            });
            return createTenantAuthSession(request, reply, platformUser, currentTenant, currentMembership);
        }
        const currentUser = await requireCurrentUser(request, reply);
        if (!currentUser) {
            return;
        }
        privateDb.recordAuditLog({
            action: 'token_refresh',
            targetType: 'auth',
            targetId: String(currentUser.id),
            detail: `${currentUser.displayName} 已完成令牌续期。`,
            result: 'success',
            operator: currentUser,
            ipAddress: resolveRequestIp(request),
        });
        return createPrivateAuthSession(request, reply, currentUser);
    });
    app.post('/api/auth/logout', async (request, reply) => {
        const authToken = resolveRequestAuthToken(request);
        if (authToken) {
            try {
                const tokenPayload = await app.jwt.verify(authToken);
                const userId = Number(tokenPayload.sub ?? 0);
                if (runtimeConfig.deploymentMode === 'saas' && controlPlaneDb) {
                    const user = userId ? await controlPlaneDb.getPlatformUserById(userId) : null;
                    if (user && Number(tokenPayload.ver ?? 0) === (user.tokenVersion ?? 0)) {
                        await controlPlaneDb.bumpPlatformUserTokenVersion(user.id);
                        recordPlatformAudit({
                            action: 'logout_success',
                            targetType: tokenPayload.scope === 'tenant' ? 'tenant_auth' : 'platform_auth',
                            targetId: String(user.id),
                            detail: `${user.displayName} 已退出登录。`,
                            result: 'success',
                            operatorUserId: user.id,
                            tenantId: tokenPayload.tenantId ?? null,
                            ipAddress: resolveRequestIp(request),
                        });
                    }
                }
                else {
                    const user = userId ? privateDb.getUserById(userId) : null;
                    if (user && Number(tokenPayload.ver ?? 0) === (user.tokenVersion ?? 0)) {
                        privateDb.bumpUserTokenVersion(user.id);
                        privateDb.recordAuditLog({
                            action: 'logout_success',
                            targetType: 'auth',
                            targetId: String(user.id),
                            detail: `${user.displayName} 已退出后台登录。`,
                            result: 'success',
                            operator: user,
                            ipAddress: resolveRequestIp(request),
                        });
                    }
                }
            }
            catch {
                // 无效或过期令牌不阻断登出，仍继续清理浏览器 Cookie。
            }
        }
        reply.header('set-cookie', buildExpiredAuthCookie(request, runtimeConfig.trustProxy));
        return { success: true };
    });
    app.get('/api/auth/profile', async (request, reply) => {
        if (runtimeConfig.deploymentMode === 'saas') {
            const platformUser = await requirePlatformUser(request, reply);
            if (!platformUser) {
                return;
            }
            const memberships = controlPlaneDb
                ? (await controlPlaneDb.listAccessibleTenantsForUser(platformUser.id)).map((item) => ({
                    membership: sanitizeTenantMembership(item.membership),
                    tenant: sanitizeTenant(item.tenant),
                }))
                : [];
            if (request.authClaims?.scope === 'tenant') {
                const currentUser = await requireCurrentUser(request, reply);
                const currentTenant = request.currentTenant;
                const currentMembership = request.currentMembership;
                if (!currentUser || !currentTenant || !currentMembership) {
                    return;
                }
                return {
                    scope: 'tenant',
                    user: sanitizeUser(currentUser),
                    platformUser: sanitizePlatformUser(platformUser),
                    tenant: sanitizeTenant(currentTenant),
                    membership: sanitizeTenantMembership(currentMembership),
                    memberships,
                };
            }
            return {
                scope: 'platform',
                user: sanitizePlatformUser(platformUser),
                memberships,
            };
        }
        const currentUser = await requireCurrentUser(request, reply);
        if (!currentUser) {
            return;
        }
        return {
            scope: 'private',
            user: sanitizeUser(currentUser),
        };
    });
    app.post('/api/auth/change-password', {
        preHandler: [
            async (request, reply) => {
                if (runtimeConfig.deploymentMode === 'saas') {
                    await authenticatePlatform(request, reply);
                    return;
                }
                await authenticate(request, reply);
            },
        ],
    }, async (request, reply) => {
        const payload = changePasswordSchema.parse(request.body);
        if (payload.currentPassword === payload.newPassword) {
            return reply.code(400).send({ message: '新密码不能与当前密码相同' });
        }
        if (runtimeConfig.deploymentMode === 'saas') {
            const currentUser = request.currentPlatformUser;
            const user = controlPlaneDb ? await controlPlaneDb.getPlatformUserById(currentUser.id) : null;
            if (!user || !comparePassword(payload.currentPassword, user.passwordHash ?? '')) {
                return reply.code(400).send({ message: '当前密码不正确' });
            }
            const newHash = hashPassword(payload.newPassword);
            if (controlPlaneDb) {
                await controlPlaneDb.updatePlatformUserPasswordHash(currentUser.id, newHash);
            }
            recordPlatformAudit({
                action: 'password_changed',
                targetType: 'platform_user',
                targetId: String(currentUser.id),
                detail: `平台用户 ${currentUser.username} 修改了密码。`,
                result: 'success',
                operatorUserId: currentUser.id,
                ipAddress: resolveRequestIp(request),
            });
            logger.info('password_changed', '平台用户成功修改密码', {
                userId: currentUser.id,
                username: currentUser.username,
            });
            return { success: true, message: '密码已更新，请重新登录所有会话。' };
        }
        const currentUser = request.currentUser;
        const user = privateDb.getUserById(currentUser.id);
        if (!user || !comparePassword(payload.currentPassword, user.passwordHash ?? '')) {
            return reply.code(400).send({ message: '当前密码不正确' });
        }
        const newHash = hashPassword(payload.newPassword);
        privateDb.updateUserPasswordHash(currentUser.id, newHash);
        privateDb.recordAuditLog({
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
    });
    app.post('/api/_legacy/auth/login', async (request, reply) => {
        const payload = loginSchema.parse(request.body);
        const requestIp = resolveRequestIp(request);
        const limited = hitRateLimit(`login:${requestIp}`, runtimeConfig.loginMaxAttempts, runtimeConfig.loginWindowMinutes);
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
            }
            catch (rehashError) {
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
    app.post('/api/_legacy/auth/refresh', { preHandler: [authenticate] }, async (request, reply) => {
        const currentUser = request.currentUser;
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
    app.post('/api/_legacy/auth/logout', async (request, reply) => {
        const authToken = resolveRequestAuthToken(request);
        if (authToken) {
            try {
                const tokenPayload = await app.jwt.verify(authToken);
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
            }
            catch {
                // 无效或过期令牌不阻断登出；仍继续清理浏览器 Cookie。
            }
        }
        reply.header('set-cookie', buildExpiredAuthCookie(request, runtimeConfig.trustProxy));
        return { success: true };
    });
    app.get('/api/_legacy/auth/profile', { preHandler: [authenticate] }, async (request) => ({
        user: sanitizeUser(request.currentUser),
    }));
    // ── 修改密码 ────────────────────────────────────────────
    app.post('/api/_legacy/auth/change-password', { preHandler: [authenticate] }, async (request, reply) => {
        const currentUser = request.currentUser;
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
    });
    app.get('/api/platform/tenants', { preHandler: [authorizePlatformAdmin] }, async () => {
        if (!controlPlaneDb) {
            return { list: [] };
        }
        return {
            list: (await controlPlaneDb.listTenants()).map((tenant) => sanitizeTenant(tenant)),
        };
    });
    app.get('/api/platform/users', { preHandler: [authorizePlatformAdmin] }, async () => {
        if (!controlPlaneDb) {
            return { list: [] };
        }
        return {
            list: (await controlPlaneDb.listPlatformUsers()).map((user) => sanitizePlatformUser(user)),
        };
    });
    app.get('/api/platform/security/mfa', { preHandler: [authenticatePlatform] }, async (request, reply) => {
        if (!controlPlaneDb) {
            return reply.code(404).send({ message: '当前部署模式未启用平台控制面。' });
        }
        const platformUser = request.currentPlatformUser;
        const activeSecret = platformUser?.mfaSecretRefId
            ? await controlPlaneDb.getSecretRefById(platformUser.mfaSecretRefId)
            : null;
        return {
            enabled: Boolean(activeSecret),
            user: sanitizePlatformUser(platformUser),
            secretRefId: activeSecret?.id ?? null,
            updatedAt: activeSecret?.updatedAt ?? null,
        };
    });
    app.post('/api/platform/security/mfa/setup', { preHandler: [authenticatePlatform] }, async (request, reply) => {
        if (!controlPlaneDb) {
            return reply.code(404).send({ message: '当前部署模式未启用平台控制面。' });
        }
        const platformUser = request.currentPlatformUser;
        const secret = generateTotpSecret();
        const pendingRefKey = buildPlatformMfaRefKey(platformUser.id, 'pending');
        const pendingSecret = await controlPlaneDb.upsertSecretRef({
            provider: 'local',
            refKey: pendingRefKey,
            cipherText: encryptSecret(secret, runtimeConfig.secureConfigSecret),
            description: `${platformUser.username} 的待确认 MFA 密钥`,
        });
        const otpAuthUrl = buildTotpOtpAuthUrl({
            issuer: 'Sale Compass',
            accountName: platformUser.username,
            secret,
        });
        const qrCodeDataUrl = await QRCode.toDataURL(otpAuthUrl, {
            margin: 1,
            width: 240,
        });
        recordPlatformAudit({
            action: 'platform_mfa_setup_started',
            targetType: 'platform_user',
            targetId: String(platformUser.id),
            detail: `${platformUser.displayName} 创建了新的 MFA 配置草稿。`,
            result: 'success',
            operatorUserId: platformUser.id,
            ipAddress: resolveRequestIp(request),
        });
        return {
            enabled: Boolean(platformUser.mfaSecretRefId),
            pendingSecretRefId: pendingSecret?.id ?? null,
            otpAuthUrl,
            manualEntryKey: secret,
            qrCodeDataUrl,
        };
    });
    app.post('/api/platform/security/mfa/confirm', { preHandler: [authenticatePlatform] }, async (request, reply) => {
        if (!controlPlaneDb) {
            return reply.code(404).send({ message: '当前部署模式未启用平台控制面。' });
        }
        const platformUser = request.currentPlatformUser;
        const body = platformMfaConfirmSchema.parse(request.body);
        const pendingSecretRef = await controlPlaneDb.getSecretRefByRefKey(buildPlatformMfaRefKey(platformUser.id, 'pending'));
        if (!pendingSecretRef) {
            return reply.code(409).send({ message: '未找到待确认的 MFA 配置，请重新生成。' });
        }
        const pendingSecret = decryptSecret(pendingSecretRef.cipherText, runtimeConfig.secureConfigSecret);
        if (!verifyTotpCode({ secret: pendingSecret, code: body.code })) {
            return reply.code(400).send({ message: '动态验证码错误，请重新输入。' });
        }
        const activeSecretRef = await controlPlaneDb.upsertSecretRef({
            provider: 'local',
            refKey: buildPlatformMfaRefKey(platformUser.id, 'active'),
            cipherText: pendingSecretRef.cipherText,
            description: `${platformUser.username} 的平台 MFA 密钥`,
        });
        await controlPlaneDb.updatePlatformUserMfaSecretRef(platformUser.id, activeSecretRef?.id ?? null);
        await controlPlaneDb.deleteSecretRef(pendingSecretRef.id);
        recordPlatformAudit({
            action: 'platform_mfa_enabled',
            targetType: 'platform_user',
            targetId: String(platformUser.id),
            detail: `${platformUser.displayName} 已启用 MFA。`,
            result: 'success',
            operatorUserId: platformUser.id,
            ipAddress: resolveRequestIp(request),
        });
        return {
            enabled: true,
            updatedAt: activeSecretRef?.updatedAt ?? null,
        };
    });
    app.post('/api/platform/security/mfa/disable', { preHandler: [authenticatePlatform] }, async (request, reply) => {
        if (!controlPlaneDb) {
            return reply.code(404).send({ message: '当前部署模式未启用平台控制面。' });
        }
        const platformUser = request.currentPlatformUser;
        const body = platformMfaConfirmSchema.parse(request.body);
        const activeSecret = await resolvePlatformMfaSecret(platformUser);
        if (!activeSecret) {
            return reply.code(409).send({ message: '当前账号尚未启用 MFA。' });
        }
        if (!verifyTotpCode({ secret: activeSecret.secret, code: body.code })) {
            return reply.code(400).send({ message: '动态验证码错误，无法关闭 MFA。' });
        }
        await controlPlaneDb.updatePlatformUserMfaSecretRef(platformUser.id, null);
        await controlPlaneDb.deleteSecretRef(activeSecret.secretRef.id);
        const pendingSecretRef = await controlPlaneDb.getSecretRefByRefKey(buildPlatformMfaRefKey(platformUser.id, 'pending'));
        if (pendingSecretRef) {
            await controlPlaneDb.deleteSecretRef(pendingSecretRef.id);
        }
        recordPlatformAudit({
            action: 'platform_mfa_disabled',
            targetType: 'platform_user',
            targetId: String(platformUser.id),
            detail: `${platformUser.displayName} 已关闭 MFA。`,
            result: 'warning',
            operatorUserId: platformUser.id,
            ipAddress: resolveRequestIp(request),
        });
        return {
            enabled: false,
        };
    });
    app.post('/api/platform/tenants', { preHandler: [authorizePlatformAdmin] }, async (request, reply) => {
        if (!controlPlaneDb) {
            return reply.code(404).send({ message: '当前部署模式未启用平台控制面。' });
        }
        const body = platformTenantCreateSchema.parse(request.body);
        const currentPlatformUser = request.currentPlatformUser;
        try {
            const created = await controlPlaneDb.createTenant({
                tenantKey: body.tenantKey,
                tenantName: body.tenantName,
                displayName: body.displayName ?? body.tenantName,
                ownerUserId: body.initialAdminUserId ?? currentPlatformUser.id,
                ownerSystemRole: body.initialAdminRole ?? 'admin',
                bootstrapAdmin: runtimeConfig.bootstrapAdmin,
                seedDemoData,
            }, {
                forceReseed: false,
                runtimeMode,
                bootstrapAdmin: runtimeConfig.bootstrapAdmin,
                tenantResolver: databaseProvider.getTenantResolver(),
                migrationRunner: databaseProvider.getMigrationRunner(),
                seedDemoData,
            });
            recordPlatformAudit({
                action: 'tenant_created',
                targetType: 'tenant',
                targetId: String(created.tenant?.id ?? ''),
                detail: `${currentPlatformUser.displayName} 创建租户 ${body.tenantKey}。`,
                result: 'success',
                operatorUserId: currentPlatformUser.id,
                tenantId: created.tenant?.id ?? null,
                ipAddress: resolveRequestIp(request),
            });
            return {
                tenant: created.tenant ? sanitizeTenant(created.tenant) : null,
                provisioningJob: created.job,
            };
        }
        catch (error) {
            const message = error instanceof Error ? error.message : '创建租户失败';
            recordPlatformAudit({
                action: 'tenant_created',
                targetType: 'tenant',
                targetId: body.tenantKey,
                detail: `${currentPlatformUser.displayName} 创建租户失败：${message}`,
                result: 'failure',
                operatorUserId: currentPlatformUser.id,
                ipAddress: resolveRequestIp(request),
            });
            return reply.code(400).send({ message });
        }
    });
    app.post('/api/platform/tenants/:tenantId/status', { preHandler: [authorizePlatformAdmin] }, async (request, reply) => {
        if (!controlPlaneDb) {
            return reply.code(404).send({ message: '当前部署模式未启用平台控制面。' });
        }
        const params = z.object({ tenantId: z.coerce.number().int().positive() }).parse(request.params);
        const body = platformTenantStatusSchema.parse(request.body);
        const currentPlatformUser = request.currentPlatformUser;
        const tenant = await controlPlaneDb.updateTenantStatus(params.tenantId, body.status);
        if (!tenant) {
            return reply.code(404).send({ message: '租户不存在' });
        }
        recordPlatformAudit({
            action: 'tenant_status_updated',
            targetType: 'tenant',
            targetId: String(tenant.id),
            detail: `${currentPlatformUser.displayName} 将租户 ${tenant.tenantKey} 状态更新为 ${body.status}。`,
            result: 'success',
            operatorUserId: currentPlatformUser.id,
            tenantId: tenant.id,
            ipAddress: resolveRequestIp(request),
        });
        return { tenant: sanitizeTenant(tenant) };
    });
    app.get('/api/platform/tenants/:tenantId/memberships', { preHandler: [authorizePlatformAdmin] }, async (request, reply) => {
        if (!controlPlaneDb) {
            return reply.code(404).send({ message: '当前部署模式未启用平台控制面。' });
        }
        const params = z.object({ tenantId: z.coerce.number().int().positive() }).parse(request.params);
        const tenant = await controlPlaneDb.getTenantById(params.tenantId);
        if (!tenant) {
            return reply.code(404).send({ message: '租户不存在' });
        }
        return {
            tenant: sanitizeTenant(tenant),
            list: (await controlPlaneDb.listTenantMemberships(tenant.id)).map((item) => ({
                membership: sanitizeTenantMembership(item.membership),
                user: item.user,
            })),
        };
    });
    app.post('/api/platform/tenants/:tenantId/memberships', { preHandler: [authorizePlatformAdmin] }, async (request, reply) => {
        if (!controlPlaneDb) {
            return reply.code(404).send({ message: '当前部署模式未启用平台控制面。' });
        }
        const params = z.object({ tenantId: z.coerce.number().int().positive() }).parse(request.params);
        const body = platformTenantMembershipSchema.parse(request.body);
        const currentPlatformUser = request.currentPlatformUser;
        const membership = await controlPlaneDb.assignTenantMembership({
            tenantId: params.tenantId,
            platformUserId: body.platformUserId,
            membershipRole: body.membershipRole,
            systemRole: body.systemRole,
            status: body.status ?? 'active',
        });
        if (!membership) {
            return reply.code(404).send({ message: '租户或平台账号不存在' });
        }
        recordPlatformAudit({
            action: 'tenant_membership_updated',
            targetType: 'tenant_membership',
            targetId: String(membership.id),
            detail: `${currentPlatformUser.displayName} 更新了租户 ${params.tenantId} 的成员关系。`,
            result: 'success',
            operatorUserId: currentPlatformUser.id,
            tenantId: params.tenantId,
            ipAddress: resolveRequestIp(request),
        });
        return { membership: sanitizeTenantMembership(membership) };
    });
    app.get('/api/platform/provisioning-jobs', { preHandler: [authorizePlatformAdmin] }, async (request) => {
        if (!controlPlaneDb) {
            return { list: [] };
        }
        const query = z.object({ tenantId: z.coerce.number().int().positive().optional() }).parse(request.query);
        return {
            list: await controlPlaneDb.listProvisioningJobs(query.tenantId),
        };
    });
    app.post('/api/platform/provisioning-jobs/:jobId/retry', { preHandler: [authorizePlatformAdmin] }, async (request, reply) => {
        if (!controlPlaneDb) {
            return reply.code(404).send({ message: '当前部署模式未启用平台控制面。' });
        }
        const params = z.object({ jobId: z.coerce.number().int().positive() }).parse(request.params);
        const currentPlatformUser = request.currentPlatformUser;
        try {
            const retried = await controlPlaneDb.retryProvisioningJob(params.jobId, {
                forceReseed: false,
                runtimeMode,
                bootstrapAdmin: runtimeConfig.bootstrapAdmin,
                tenantResolver: databaseProvider.getTenantResolver(),
                migrationRunner: databaseProvider.getMigrationRunner(),
                seedDemoData,
            });
            if (!retried) {
                return reply.code(404).send({ message: '开通任务不存在' });
            }
            recordPlatformAudit({
                action: 'tenant_provisioning_retried',
                targetType: 'tenant_provisioning_job',
                targetId: String(params.jobId),
                detail: `${currentPlatformUser.displayName} 重新执行了租户开通任务 ${params.jobId}。`,
                result: 'success',
                operatorUserId: currentPlatformUser.id,
                tenantId: retried.tenant?.id ?? null,
                ipAddress: resolveRequestIp(request),
            });
            return retried;
        }
        catch (error) {
            const message = error instanceof Error ? error.message : '重试租户开通失败';
            recordPlatformAudit({
                action: 'tenant_provisioning_retried',
                targetType: 'tenant_provisioning_job',
                targetId: String(params.jobId),
                detail: `${currentPlatformUser.displayName} 重试租户开通任务失败：${message}`,
                result: 'failure',
                operatorUserId: currentPlatformUser.id,
                ipAddress: resolveRequestIp(request),
            });
            return reply.code(400).send({ message });
        }
    });
    app.get('/api/system/users', { preHandler: [authorizeRoles(routeAccessPolicy.manageUsers, 'user', '账号管理列表')] }, async () => ({
        list: db.listSystemUsers().map((row) => sanitizeUser(row)),
    }));
    app.post('/api/system/users', { preHandler: [authorizeRoles(routeAccessPolicy.manageUsers, 'user', '创建账号')] }, async (request, reply) => {
        const currentUser = request.currentUser;
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
        }
        catch (error) {
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
    });
    app.post('/api/system/users/:userId/role', { preHandler: [authorizeRoles(routeAccessPolicy.manageUsers, 'user', '修改账号角色')] }, async (request, reply) => {
        const currentUser = request.currentUser;
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
        }
        catch (error) {
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
    });
    app.post('/api/system/users/:userId/status', { preHandler: [authorizeRoles(routeAccessPolicy.manageUsers, 'user', '修改账号状')] }, async (request, reply) => {
        const currentUser = request.currentUser;
        if (!ensurePrivilegedWriteAllowed(request, reply, currentUser, '修改账号状')) {
            return;
        }
        const params = z.object({ userId: z.coerce.number().int().positive() }).parse(request.params);
        const body = systemUserStatusSchema.parse(request.body);
        try {
            const updatedUser = db.updateSystemUserStatus(params.userId, body.status);
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
        }
        catch (error) {
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
    });
    app.post('/api/system/secure-settings/:settingKey', {
        preHandler: [
            authorizeRoles(routeAccessPolicy.manageSecureSettings, 'security', '更新敏感配置'),
        ],
    }, async (request, reply) => {
        const currentUser = request.currentUser;
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
        const setting = db.upsertSecureSetting(params.settingKey, body.description, body.value, currentUser.id);
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
    });
    registerOpenPlatformRoutes({
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
    });
    const missingTenantBusinessReadCapabilities = new Set();
    const resolveTenantBusinessRead = async (request, capability, args, fallback) => {
        const tenant = request.currentTenant;
        if (!tenant || !databaseProvider.isTenantBusinessPostgresEnabled()) {
            return fallback();
        }
        const adapter = databaseProvider.getTenantBusinessReadAdapter(tenant);
        if (!adapter) {
            return fallback();
        }
        const adapterRuntime = adapter;
        const adapterMethod = adapterRuntime?.[capability];
        if (typeof adapterMethod !== 'function') {
            const capabilityKey = `${tenant.id}:${capability}`;
            if (!missingTenantBusinessReadCapabilities.has(capabilityKey)) {
                missingTenantBusinessReadCapabilities.add(capabilityKey);
                logger.warn('tenant_business_read_adapter_capability_missing', 'Tenant PostgreSQL read adapter missing route capability, falling back to sqlite shadow storage.', {
                    tenantId: tenant.id,
                    tenantKey: tenant.tenantKey,
                    capability,
                    route: resolveRouteLabel(request),
                });
            }
            return fallback();
        }
        return adapterMethod.apply(adapter, args);
    };
    app.get('/api/options', { preHandler: [authenticate] }, async (request) => {
        const tenant = request.currentTenant;
        if (tenant && databaseProvider.isTenantBusinessPostgresEnabled()) {
            const adapter = databaseProvider.getTenantBusinessReadAdapter(tenant);
            if (adapter) {
                return adapter.getFilterOptions(db.getFilterOptions());
            }
        }
        return db.getFilterOptions();
    });
    app.get('/api/dashboard', { preHandler: [authorizeRoles(routeAccessPolicy.dashboard, 'dashboard', '查看统计面板')] }, async (request) => {
        const query = baseFilterSchema.parse(request.query);
        const tenant = request.currentTenant;
        if (tenant && databaseProvider.isTenantBusinessPostgresEnabled()) {
            const adapter = databaseProvider.getTenantBusinessReadAdapter(tenant);
            if (adapter) {
                return adapter.getDashboard(query, db.getDashboard(query));
            }
        }
        return db.getDashboard(query);
    });
    app.get('/api/reports', { preHandler: [authorizeRoles(routeAccessPolicy.reports, 'reports', '查看经营报表')] }, async (request) => {
        const query = baseFilterSchema.parse(request.query);
        return resolveTenantBusinessRead(request, 'getBusinessReports', [query], () => db.getBusinessReports(query));
    });
    app.get('/api/reports/export', { preHandler: [authorizeRoles(routeAccessPolicy.reports, 'reports', '导出经营报表')] }, async (request, reply) => {
        const currentUser = request.currentUser;
        const query = baseFilterSchema.parse(request.query);
        const csv = await resolveTenantBusinessRead(request, 'exportBusinessReportsCsv', [query], () => db.exportBusinessReportsCsv(query));
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
    });
    registerOrdersRoutes({
        app,
        db,
        databaseProvider,
        runtimeConfig,
        authorizeRoles,
        ensurePrivilegedWriteAllowed,
        resolveRequestIp,
        publishFulfillmentQueueTask,
    });
    app.post('/api/orders/xianyu-web-sync', { preHandler: [authorizeRoles(routeAccessPolicy.manageStores, 'orders', '同步闲鱼真实成交单')] }, async (request, reply) => {
        const currentUser = request.currentUser;
        if (!ensurePrivilegedWriteAllowed(request, reply, currentUser, '同步闲鱼真实成交单')) {
            return;
        }
        const body = xianyuOrderSyncSchema.parse(request.body ?? {});
        const tenantAdapter = request.currentTenant && databaseProvider.isTenantBusinessPostgresEnabled()
            ? databaseProvider.getTenantBusinessReadAdapter(request.currentTenant)
            : null;
        const targets = typeof (tenantAdapter?.listManagedStoreOrderSyncTargets) === 'function'
            ? await tenantAdapter.listManagedStoreOrderSyncTargets(body.storeIds)
            : db.listManagedStoreOrderSyncTargets(body.storeIds);
        if (targets.length === 0) {
            return reply.code(409).send({ message: '当前没有可同步的已激活闲鱼网页登录态店铺。' });
        }
        const maxOrdersPerStore = Math.max(1, Math.min(100, Math.trunc(body.maxOrdersPerStore ?? 30)));
        const results = [];
        for (const target of targets) {
            try {
                const fetched = await xianyuWebSessionService.fetchXianyuWebSessionSellerCompletedTrades({
                    cookieText: target.cookieText,
                    userId: target.providerUserId,
                    maxPages: Math.max(1, Math.ceil(maxOrdersPerStore / 20)),
                });
                const selectedTrades = fetched.items.slice(0, maxOrdersPerStore);
                const detailFailures = [];
                const detailedOrders = [];
                for (const trade of selectedTrades) {
                    try {
                        const detail = await xianyuWebSessionService.fetchXianyuWebSessionCompletedOrderDetail({
                            cookieText: target.cookieText,
                            tradeId: trade.tradeId,
                        });
                        detailedOrders.push(detail);
                    }
                    catch (error) {
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
                        message: detailFailures[0]?.message ?? '拉取闲鱼真实成交单失败，未获取到可写入的订单详情。',
                    });
                    continue;
                }
                const syncInput = {
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
                };
                const synced = typeof (tenantAdapter?.syncManagedStoreOrders) === 'function'
                    ? await tenantAdapter.syncManagedStoreOrders(syncInput)
                    : db.syncManagedStoreOrders(syncInput);
                if (synced && typeof (tenantAdapter?.syncManagedStoreOrders) === 'function') {
                    try {
                        db.syncManagedStoreOrders(syncInput);
                    }
                    catch (error) {
                        request.log.warn({ err: error, route: request.url, storeId: target.storeId, operation: 'syncManagedStoreOrders' }, 'Tenant PostgreSQL order sync succeeded but SQLite shadow mirror failed.');
                    }
                }
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
                    message: detailFailures.length > 0 ? `有 ${detailFailures.length} 笔成交单详情拉取失败，已跳过。` : undefined,
                });
            }
            catch (error) {
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
    });
    app.get('/api/products', { preHandler: [authorizeRoles(routeAccessPolicy.products, 'products', '查看商品统计')] }, async (request) => {
        const query = baseFilterSchema.parse(request.query);
        return resolveTenantBusinessRead(request, 'getProductsView', [query], () => db.getProductsView(query));
    });
    app.post('/api/products/xianyu-web-sync', { preHandler: [authorizeRoles(routeAccessPolicy.products, 'products', '同步闲鱼商品')] }, async (request, reply) => {
        const currentUser = request.currentUser;
        if (!ensurePrivilegedWriteAllowed(request, reply, currentUser, '同步闲鱼商品')) {
            return;
        }
        const body = xianyuProductSyncSchema.parse(request.body ?? {});
        const tenantAdapter = request.currentTenant && databaseProvider.isTenantBusinessPostgresEnabled()
            ? databaseProvider.getTenantBusinessReadAdapter(request.currentTenant)
            : null;
        const targets = typeof (tenantAdapter?.listManagedStoreProductSyncTargets) === 'function'
            ? await tenantAdapter.listManagedStoreProductSyncTargets(body.storeIds)
            : db.listManagedStoreProductSyncTargets(body.storeIds);
        if (targets.length === 0) {
            return reply.code(409).send({ message: '当前没有可同步的已激活闲鱼网页登录态店铺。' });
        }
        const results = [];
        for (const target of targets) {
            try {
                const fetched = await xianyuWebSessionService.fetchXianyuWebSessionProducts({
                    cookieText: target.cookieText,
                    userId: target.providerUserId,
                });
                const syncInput = {
                    storeId: target.storeId,
                    items: fetched.items.map((item) => ({
                        id: item.id,
                        title: item.title,
                        categoryLabel: item.categoryLabel,
                        price: item.price,
                        stock: item.stock,
                    })),
                };
                const synced = typeof (tenantAdapter?.syncManagedStoreProducts) === 'function'
                    ? await tenantAdapter.syncManagedStoreProducts(syncInput)
                    : db.syncManagedStoreProducts(syncInput);
                if (synced && typeof (tenantAdapter?.syncManagedStoreProducts) === 'function') {
                    try {
                        db.syncManagedStoreProducts(syncInput);
                    }
                    catch (error) {
                        request.log.warn({ err: error, route: request.url, storeId: target.storeId, operation: 'syncManagedStoreProducts' }, 'Tenant PostgreSQL product sync succeeded but SQLite shadow mirror failed.');
                    }
                }
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
            }
            catch (error) {
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
    });
    app.get('/api/customers', { preHandler: [authorizeRoles(routeAccessPolicy.customers, 'customers', '查看客户统计')] }, async (request) => {
        const query = baseFilterSchema.parse(request.query);
        return resolveTenantBusinessRead(request, 'getCustomersView', [query], () => db.getCustomersView(query));
    });
    registerStoreRoutes({
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
    });
    registerWorkspaceRoutes({
        app,
        db,
        databaseProvider,
        authorizeWorkspace,
        ensurePrivilegedWriteAllowed,
        resolveRequestIp,
    });
    registerWorkspaceFulfillmentRoutes({
        app,
        db,
        databaseProvider,
        authorizeWorkspace,
        backgroundJobsMode: runtimeConfig.backgroundJobsMode,
        publishFulfillmentQueueTask,
    });
    registerWorkspaceFundRoutes({
        app,
        db,
        databaseProvider,
        authorizeWorkspace,
        ensurePrivilegedWriteAllowed,
        resolveRequestIp,
    });
    registerWorkspaceAiServiceRoutes({
        app,
        db,
        databaseProvider,
        authorizeWorkspace,
        ensurePrivilegedWriteAllowed,
        resolveRequestIp,
        syncAiServiceStoreTarget,
        sendAiServiceXianyuMessage,
        tryLlmReply,
    });
    registerWorkspaceAiBargainRoutes({
        app,
        db,
        databaseProvider,
        authorizeWorkspace,
        ensurePrivilegedWriteAllowed,
        resolveRequestIp,
        syncAiBargainStoreTarget,
    });
    registerExternalFulfillmentCallbackRoutes({
        app,
        db,
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
    registerFulfillmentConfigRoutes({
        app,
        db,
        authorizeRoles,
        ensurePrivilegedWriteAllowed,
        resolveRequestIp,
    });
    return app;
}

