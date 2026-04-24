import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  getEnterpriseLaunchIssues,
  getRuntimeConfigIssues,
  getRuntimeConfigSummary,
  getRuntimeStartupIssues,
  type ResolvedAppConfig,
} from './config.js';
import {
  createDatabaseProviderRuntimeSummary,
  type DatabaseProviderRuntimeSummary,
} from './database-provider.js';

function createConfig(overrides: Partial<ResolvedAppConfig> = {}): ResolvedAppConfig {
  return {
    deploymentMode: 'private',
    runtimeMode: 'prod',
    envProfile: 'production',
    backgroundJobsMode: 'embedded',
    queueBackend: 'sqlite',
    businessDatabaseEngine: 'sqlite',
    tenantBusinessDatabaseEngine: 'sqlite',
    controlPlaneDatabaseEngine: 'sqlite',
    port: 4300,
    host: '0.0.0.0',
    trustProxy: true,
    logLevel: 'info',
    requestLoggingEnabled: true,
    metricsEnabled: true,
    metricsToken: 'metrics-token-20260312',
    jwtSecret: 'prod-jwt-secret-1234567890-abcdef',
    jwtExpiresMinutes: 480,
    secureConfigSecret: 'prod-cipher-secret-abcdef-1234567890',
    loginMaxAttempts: 10,
    loginWindowMinutes: 10,
    privilegedWriteLimit: 60,
    privilegedWriteWindowMinutes: 10,
    dataRoot: path.join(os.tmpdir(), 'sale-compass-config', 'data'),
    dbPath: path.join(os.tmpdir(), 'sale-compass-config', 'data', 'app.db'),
    businessPostgresUrl: null,
    controlPlaneDbPath: path.join(os.tmpdir(), 'sale-compass-config', 'data', 'control-plane.db'),
    controlPlanePostgresUrl: null,
    tenantDatabaseRoot: path.join(os.tmpdir(), 'sale-compass-config', 'data', 'tenants'),
    tenantBusinessPostgresUrlTemplate: null,
    redisUrl: null,
    redisPrefix: 'sale-compass',
    logDir: path.join(os.tmpdir(), 'sale-compass-config', 'data', 'logs'),
    backupDir: path.join(os.tmpdir(), 'sale-compass-config', 'data', 'backups'),
    uploadDir: path.join(os.tmpdir(), 'sale-compass-config', 'data', 'uploads'),
    seedDemoData: false,
    bootstrapAdmin: {
      username: 'admin.owner',
      password: 'SaleCompass@20260312',
      displayName: '系统管理员',
    },
    storeAuthMode: 'simulated',
    xianyuAppKey: null,
    xianyuAppSecret: null,
    xianyuCallbackBaseUrl: null,
    xianyuAuthorizeBaseUrl: 'https://open.api.goofish.com/authorize',
    xianyuForceAuth: true,
    webDistPath: path.join(os.tmpdir(), 'sale-compass-config', 'web', 'dist'),
    envFilePath: null,
    envFileLoaded: false,
    envFilesLoaded: [],
    ...overrides,
  };
}

describe('运行配置预检', () => {
  it('prod 模式禁止启用演示数据并要求强密钥', () => {
    const issues = getRuntimeConfigIssues(
      createConfig({
        seedDemoData: true,
        jwtSecret: 'change-me-in-production',
        secureConfigSecret: 'replace-with-a-second-random-secret',
      }),
    );

    expect(issues.some((issue) => issue.field === 'APP_ENABLE_DEMO_DATA')).toBe(true);
    expect(issues.some((issue) => issue.field === 'JWT_SECRET')).toBe(true);
    expect(issues.some((issue) => issue.field === 'APP_CONFIG_CIPHER_SECRET')).toBe(true);
  });

  it('prod 模式要求初始化管理员和分离密钥', () => {
    const issues = getRuntimeConfigIssues(
      createConfig({
        bootstrapAdmin: null,
        secureConfigSecret: 'prod-jwt-secret-1234567890-abcdef',
      }),
    );

    expect(
      issues.some(
        (issue) => issue.field === 'APP_INIT_ADMIN_USERNAME, APP_INIT_ADMIN_PASSWORD',
      ),
    ).toBe(true);
    expect(issues.some((issue) => issue.field === 'JWT_SECRET, APP_CONFIG_CIPHER_SECRET')).toBe(
      true,
    );
  });

  it('demo 模式允许使用演示数据且不强制初始化管理员', () => {
    const issues = getRuntimeConfigIssues(
      createConfig({
        runtimeMode: 'demo',
        envProfile: 'development',
        seedDemoData: true,
        jwtSecret: 'goofish-sale-statistics-secret',
        secureConfigSecret: 'goofish-sale-statistics-secret',
        bootstrapAdmin: null,
      }),
    );

    expect(issues).toHaveLength(0);
  });

  it('启动就绪检查会阻断缺失的前端构建产物', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sale-compass-config-ready-'));
    const issues = getRuntimeStartupIssues(
      createConfig({
        dataRoot: path.join(tempRoot, 'data'),
        dbPath: path.join(tempRoot, 'data', 'app.db'),
        logDir: path.join(tempRoot, 'data', 'logs'),
        backupDir: path.join(tempRoot, 'data', 'backups'),
        uploadDir: path.join(tempRoot, 'data', 'uploads'),
        webDistPath: path.join(tempRoot, 'web', 'dist'),
      }),
      { requireWebBuild: true },
    );

    expect(issues.some((issue) => issue.field === 'web/dist')).toBe(true);
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it('配置摘要包含环境分层与可观测开关', () => {
    const summary = getRuntimeConfigSummary(
      createConfig({
        envFileLoaded: true,
        envFilePath: path.join(os.tmpdir(), 'sale-compass-config', '.env'),
        envFilesLoaded: [
          path.join(os.tmpdir(), 'sale-compass-config', '.env.production'),
          path.join(os.tmpdir(), 'sale-compass-config', '.env'),
        ],
      }),
    );

    expect(summary).toMatchObject({
      strictMode: true,
      envProfile: 'production',
      backgroundJobsMode: 'embedded',
      queueBackend: 'sqlite',
      businessDatabaseEngine: 'sqlite',
      tenantBusinessDatabaseEngine: 'sqlite',
      controlPlaneDatabaseEngine: 'sqlite',
      businessPostgresConfigured: false,
      controlPlanePostgresConfigured: false,
      tenantBusinessPostgresTemplateConfigured: false,
      redisConfigured: false,
      envFileLoaded: true,
      requestLoggingEnabled: true,
      metricsEnabled: true,
      logLevel: 'info',
    });
    expect(summary.envFilesLoaded).toHaveLength(2);
  });

  it('tenant business runtime 摘要基于 capability checklist 生成而不是无条件写死', () => {
    const runtimeSummary = createDatabaseProviderRuntimeSummary({
      privateDbPath: path.join(os.tmpdir(), 'sale-compass-config', 'data', 'app.db'),
      tenantDatabaseRoot: path.join(os.tmpdir(), 'sale-compass-config', 'data', 'tenants'),
      businessDatabaseEngine: 'sqlite',
      businessPostgresUrl: null,
      tenantBusinessDatabaseEngine: 'postgres',
      tenantBusinessPostgresUrlTemplate: 'postgres://tenant/{tenantId}',
    });

    expect(runtimeSummary.tenantDatabase.runtimeEngine).toBe('hybrid');
    expect(runtimeSummary.tenantDatabase.runtimeReady).toBe(false);
    expect(runtimeSummary.tenantDatabase.readyCapabilities.length).toBeGreaterThan(5);
    expect(runtimeSummary.tenantDatabase.readyCapabilities).toContain('store auth session writes');
    expect(runtimeSummary.tenantDatabase.pendingCapabilities).toContain(
      'ai-service auto-sync runtime wiring',
    );
    expect(runtimeSummary.tenantDatabase.pendingCapabilities).toContain(
      'ai-bargain auto-sync runtime wiring',
    );
    expect(runtimeSummary.tenantDatabase.runtimeBlockedReason).toContain(
      'Remaining SQLite-primary capabilities',
    );
  });

  it('配置摘要会透出 business runtime capability 清单，供 preflight 直接消费', () => {
    const runtimeSummary = createDatabaseProviderRuntimeSummary({
      privateDbPath: path.join(os.tmpdir(), 'sale-compass-config', 'data', 'app.db'),
      tenantDatabaseRoot: path.join(os.tmpdir(), 'sale-compass-config', 'data', 'tenants'),
      businessDatabaseEngine: 'sqlite',
      businessPostgresUrl: null,
      tenantBusinessDatabaseEngine: 'postgres',
      tenantBusinessPostgresUrlTemplate: 'postgres://tenant/{tenantId}',
    });
    const summary = getRuntimeConfigSummary(createConfig(), runtimeSummary);

    expect(summary.databaseRuntime).toBeTruthy();
    expect(summary.databaseRuntime?.tenantDatabase.runtimeEngine).toBe('hybrid');
    expect(summary.databaseRuntime?.tenantDatabase.readyCapabilities.length).toBeGreaterThan(5);
    expect(summary.databaseRuntime?.tenantDatabase.readyCapabilities).toContain(
      'open-platform management writes',
    );
    expect(summary.databaseRuntime?.tenantDatabase.readyCapabilities).toContain(
      'open-platform public verify/call log',
    );
  });

  it('启用 Redis 队列时必须显式提供连接地址', () => {
    const issues = getRuntimeConfigIssues(
      createConfig({
        queueBackend: 'redis',
        redisUrl: null,
      }),
    );

    expect(issues.some((issue) => issue.field === 'APP_REDIS_URL')).toBe(true);
  });

  it('SaaS 控制面切到 PostgreSQL 时必须提供连接地址', () => {
    const issues = getRuntimeConfigIssues(
      createConfig({
        deploymentMode: 'saas',
        controlPlaneDatabaseEngine: 'postgres',
        controlPlanePostgresUrl: null,
      }),
    );

    expect(issues.some((issue) => issue.field === 'APP_CONTROL_PLANE_POSTGRES_URL')).toBe(true);
  });

  it('鍚敤 PostgreSQL 业务库目标时必须提供连接配置', () => {
    const privateIssues = getRuntimeConfigIssues(
      createConfig({
        businessDatabaseEngine: 'postgres',
        businessPostgresUrl: null,
      }),
    );
    const tenantIssues = getRuntimeConfigIssues(
      createConfig({
        deploymentMode: 'saas',
        tenantBusinessDatabaseEngine: 'postgres',
        tenantBusinessPostgresUrlTemplate: null,
      }),
    );

    expect(privateIssues.some((issue) => issue.field === 'APP_BUSINESS_POSTGRES_URL')).toBe(true);
    expect(
      tenantIssues.some((issue) => issue.field === 'APP_TENANT_BUSINESS_POSTGRES_URL_TEMPLATE'),
    ).toBe(true);
  });
  it('SaaS prod 企业级上线门槛会拦截未完成的正式版基线', () => {
    const issues = getEnterpriseLaunchIssues(
      createConfig({
        deploymentMode: 'saas',
        runtimeMode: 'prod',
        envProfile: 'production',
        storeAuthMode: 'simulated',
        controlPlaneDatabaseEngine: 'sqlite',
        queueBackend: 'sqlite',
        metricsToken: null,
        backgroundJobsMode: 'embedded',
        tenantBusinessDatabaseEngine: 'postgres',
      }),
    );

    expect(issues.some((issue) => issue.field === 'APP_CONTROL_PLANE_DB_ENGINE')).toBe(true);
    expect(issues.some((issue) => issue.field === 'APP_QUEUE_BACKEND')).toBe(true);
    expect(issues.some((issue) => issue.field === 'APP_METRICS_TOKEN')).toBe(true);
    expect(issues.some((issue) => issue.field === 'APP_STORE_AUTH_MODE')).toBe(true);
    expect(issues.some((issue) => issue.field === 'business_database_runtime')).toBe(true);
  });

  it('SaaS prod 在租户业务库 runtime 已正式切到 PostgreSQL 时不再报 runtime 门禁', () => {
    const runtimeSummary: DatabaseProviderRuntimeSummary = {
      privateDatabase: {
        configuredEngine: 'sqlite',
        runtimeEngine: 'sqlite',
        sqlitePath: path.join(os.tmpdir(), 'sale-compass-config', 'data', 'app.db'),
        postgresConfigured: false,
        runtimeReady: true,
        runtimeBlockedReason: null,
        readyCapabilities: [],
        pendingCapabilities: [],
      },
      tenantDatabase: {
        configuredEngine: 'postgres',
        runtimeEngine: 'postgres',
        sqliteRootPath: path.join(os.tmpdir(), 'sale-compass-config', 'data', 'tenants'),
        postgresTemplateConfigured: true,
        postgresConfigured: true,
        runtimeReady: true,
        runtimeBlockedReason: null,
        readyCapabilities: ['tenant runtime fully migrated'],
        pendingCapabilities: [],
      },
    };

    const issues = getEnterpriseLaunchIssues(
      createConfig({
        deploymentMode: 'saas',
        runtimeMode: 'prod',
        envProfile: 'production',
        storeAuthMode: 'xianyu_web_session',
        controlPlaneDatabaseEngine: 'postgres',
        controlPlanePostgresUrl: 'postgres://control-plane',
        queueBackend: 'redis',
        redisUrl: 'redis://127.0.0.1:6379/0',
        backgroundJobsMode: 'worker',
        tenantBusinessDatabaseEngine: 'postgres',
        tenantBusinessPostgresUrlTemplate: 'postgres://tenant/{tenantId}',
      }),
      runtimeSummary,
    );

    expect(issues.some((issue) => issue.field === 'business_database_runtime')).toBe(false);
  });
});
