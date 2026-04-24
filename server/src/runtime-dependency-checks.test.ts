import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { ResolvedAppConfig } from './config.js';
import { getRuntimeDependencyChecks } from './runtime-dependency-checks.js';

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
    dataRoot: path.join(os.tmpdir(), 'sale-compass-runtime-checks', 'data'),
    dbPath: path.join(os.tmpdir(), 'sale-compass-runtime-checks', 'data', 'app.db'),
    businessPostgresUrl: null,
    controlPlaneDbPath: path.join(os.tmpdir(), 'sale-compass-runtime-checks', 'data', 'control-plane.db'),
    controlPlanePostgresUrl: null,
    tenantDatabaseRoot: path.join(os.tmpdir(), 'sale-compass-runtime-checks', 'data', 'tenants'),
    tenantBusinessPostgresUrlTemplate: null,
    redisUrl: null,
    redisPrefix: 'sale-compass',
    logDir: path.join(os.tmpdir(), 'sale-compass-runtime-checks', 'data', 'logs'),
    backupDir: path.join(os.tmpdir(), 'sale-compass-runtime-checks', 'data', 'backups'),
    uploadDir: path.join(os.tmpdir(), 'sale-compass-runtime-checks', 'data', 'uploads'),
    seedDemoData: false,
    bootstrapAdmin: {
      username: 'admin.owner',
      password: 'SaleCompass@20260312',
      displayName: '系统管理员',
    },
    storeAuthMode: 'xianyu_web_session',
    xianyuAppKey: null,
    xianyuAppSecret: null,
    xianyuCallbackBaseUrl: null,
    xianyuAuthorizeBaseUrl: 'https://open.api.goofish.com/authorize',
    xianyuForceAuth: true,
    webDistPath: path.join(os.tmpdir(), 'sale-compass-runtime-checks', 'web', 'dist'),
    envFilePath: null,
    envFileLoaded: false,
    envFilesLoaded: [],
    ...overrides,
  };
}

describe('运行时外部依赖探活', () => {
  it('在 sqlite 队列模式下返回 not_required', async () => {
    const result = await getRuntimeDependencyChecks(createConfig());

    expect(result.ok).toBe(true);
    expect(result.issues).toHaveLength(0);
    expect(result.checks).toHaveLength(4);
    expect(result.checks[0]).toMatchObject({
      name: 'redis',
      required: false,
      configured: false,
      reachable: null,
      message: 'not_required',
    });
    expect(result.checks[1]).toMatchObject({
      name: 'control-plane-postgres',
      required: false,
      message: 'not_required',
    });
    expect(result.checks[2]).toMatchObject({
      name: 'business-postgres',
      required: false,
      message: 'not_required',
    });
    expect(result.checks[3]).toMatchObject({
      name: 'tenant-business-postgres-template',
      required: false,
      message: 'not_required',
    });
  });

  it('在 redis 队列模式但未配置地址时直接失败', async () => {
    const result = await getRuntimeDependencyChecks(
      createConfig({
        queueBackend: 'redis',
        redisUrl: null,
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.issues).toHaveLength(1);
    expect(result.checks[0]).toMatchObject({
      name: 'redis',
      required: true,
      configured: false,
      reachable: false,
    });
    expect(result.issues[0]?.message).toContain('APP_REDIS_URL');
  });

  it('在 saas PostgreSQL 控制面和租户模板未配置时返回对应问题', async () => {
    const result = await getRuntimeDependencyChecks(
      createConfig({
        deploymentMode: 'saas',
        controlPlaneDatabaseEngine: 'postgres',
        controlPlanePostgresUrl: null,
        tenantBusinessDatabaseEngine: 'postgres',
        tenantBusinessPostgresUrlTemplate: null,
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.issues.some((issue) => issue.name === 'control-plane-postgres')).toBe(true);
    expect(
      result.issues.some((issue) => issue.name === 'tenant-business-postgres-template'),
    ).toBe(true);
  });

  it('在私有化 PostgreSQL 业务库未配置地址时返回对应问题', async () => {
    const result = await getRuntimeDependencyChecks(
      createConfig({
        businessDatabaseEngine: 'postgres',
        businessPostgresUrl: null,
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]?.name).toBe('business-postgres');
    expect(result.issues[0]?.message).toContain('APP_BUSINESS_POSTGRES_URL');
  });
});
