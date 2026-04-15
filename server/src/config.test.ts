import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  getRuntimeConfigIssues,
  getRuntimeConfigSummary,
  getRuntimeStartupIssues,
  type ResolvedAppConfig,
} from './config.js';

function createConfig(overrides: Partial<ResolvedAppConfig> = {}): ResolvedAppConfig {
  return {
    runtimeMode: 'prod',
    envProfile: 'production',
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
      envFileLoaded: true,
      requestLoggingEnabled: true,
      metricsEnabled: true,
      logLevel: 'info',
    });
    expect(summary.envFilesLoaded).toHaveLength(2);
  });
});
