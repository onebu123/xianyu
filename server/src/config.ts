import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { BootstrapAdminConfig, RuntimeMode, StoreAuthIntegrationMode } from './types.js';

type EnvProfile = 'development' | 'staging' | 'production';
type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const currentDir = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(currentDir, '../..');
const originalEnvKeys = new Set(Object.keys(process.env));
const loadedEnvFiles: string[] = [];
const loadedEnvKeys = new Set<string>();

export interface ResolvedAppConfig {
  runtimeMode: RuntimeMode;
  envProfile: EnvProfile;
  port: number;
  host: string;
  trustProxy: boolean;
  logLevel: LogLevel;
  requestLoggingEnabled: boolean;
  metricsEnabled: boolean;
  metricsToken: string | null;
  jwtSecret: string;
  jwtExpiresMinutes: number;
  secureConfigSecret: string;
  loginMaxAttempts: number;
  loginWindowMinutes: number;
  privilegedWriteLimit: number;
  privilegedWriteWindowMinutes: number;
  dataRoot: string;
  dbPath: string;
  logDir: string;
  backupDir: string;
  uploadDir: string;
  seedDemoData: boolean;
  bootstrapAdmin: BootstrapAdminConfig | null;
  storeAuthMode: StoreAuthIntegrationMode;
  xianyuAppKey: string | null;
  xianyuAppSecret: string | null;
  xianyuCallbackBaseUrl: string | null;
  xianyuAuthorizeBaseUrl: string;
  xianyuForceAuth: boolean;
  webDistPath: string;
  envFilePath: string | null;
  envFileLoaded: boolean;
  envFilesLoaded: string[];
}

export interface RuntimeConfigIssue {
  field: string;
  message: string;
}

function parseBoolean(value: string | undefined) {
  if (!value) {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }
  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }
  return undefined;
}

function normalizeLogLevel(value: string | undefined): LogLevel {
  if (value === 'debug' || value === 'info' || value === 'warn' || value === 'error') {
    return value;
  }
  return 'info';
}

function resolveAppPath(value: string | undefined, fallback: string) {
  if (!value?.trim()) {
    return fallback;
  }

  return path.isAbsolute(value) ? value : path.resolve(appRoot, value);
}

function resolveRuntimeMode(value: string | undefined): RuntimeMode {
  if (value === 'demo' || value === 'staging' || value === 'prod') {
    return value;
  }
  return 'prod';
}

function resolveStoreAuthMode(value: string | undefined): StoreAuthIntegrationMode {
  if (value === 'simulated' || value === 'xianyu_browser_oauth' || value === 'xianyu_web_session') {
    return value;
  }
  return 'simulated';
}

function resolveEnvProfile(runtimeMode: RuntimeMode): EnvProfile {
  if (runtimeMode === 'demo') {
    return 'development';
  }
  if (runtimeMode === 'staging') {
    return 'staging';
  }
  return 'production';
}

export function getEnvProfileForRuntimeMode(runtimeMode: RuntimeMode) {
  return resolveEnvProfile(runtimeMode);
}

function loadLocalEnvFile(filePath: string, options?: { overrideLoadedValues?: boolean }) {
  if (!fs.existsSync(filePath)) {
    return false;
  }

  const content = fs.readFileSync(filePath, 'utf8');
  for (const rawLine of content.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const separatorIndex = rawLine.indexOf('=');
    if (separatorIndex <= 0) {
      continue;
    }

    const key = rawLine.slice(0, separatorIndex).trim();
    if (!key) {
      continue;
    }

    const hasSystemValue = originalEnvKeys.has(key);
    if (hasSystemValue) {
      continue;
    }

    const currentValue = process.env[key];
    const canOverrideLoadedValue = options?.overrideLoadedValues && loadedEnvKeys.has(key);
    if (currentValue !== undefined && !canOverrideLoadedValue) {
      continue;
    }

    let value = rawLine.slice(separatorIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    process.env[key] = value;
    loadedEnvKeys.add(key);
  }

  loadedEnvFiles.push(filePath);
  return true;
}

const defaultEnvFilePath = path.join(appRoot, '.env');
const defaultEnvFileLoaded = loadLocalEnvFile(defaultEnvFilePath, { overrideLoadedValues: true });
if (!defaultEnvFileLoaded) {
  const initialRuntimeMode = resolveRuntimeMode(process.env.APP_RUNTIME_MODE);
  const initialProfileEnvFilePath = path.join(
    appRoot,
    `.env.${resolveEnvProfile(initialRuntimeMode)}`,
  );
  if (initialProfileEnvFilePath !== defaultEnvFilePath) {
    loadLocalEnvFile(initialProfileEnvFilePath);
  }
}

function resolveBootstrapAdmin(env: NodeJS.ProcessEnv) {
  const bootstrapAdminUsername = env.APP_INIT_ADMIN_USERNAME?.trim();
  const bootstrapAdminPassword = env.APP_INIT_ADMIN_PASSWORD?.trim();
  const bootstrapAdminDisplayName = env.APP_INIT_ADMIN_DISPLAY_NAME?.trim() || '系统管理员';

  if (!bootstrapAdminUsername || !bootstrapAdminPassword) {
    return null;
  }

  return {
    username: bootstrapAdminUsername,
    password: bootstrapAdminPassword,
    displayName: bootstrapAdminDisplayName,
  };
}

function buildAppConfig(env: NodeJS.ProcessEnv): ResolvedAppConfig {
  const runtimeMode = resolveRuntimeMode(env.APP_RUNTIME_MODE);
  const envProfile = resolveEnvProfile(runtimeMode);
  const dataRoot = resolveAppPath(env.APP_DATA_ROOT, path.resolve(currentDir, '../data'));
  const dbPath = resolveAppPath(env.APP_DB_PATH ?? env.DB_PATH, path.resolve(dataRoot, 'app.db'));
  const logDir = resolveAppPath(env.APP_LOG_ROOT, path.resolve(dataRoot, 'logs'));
  const backupDir = resolveAppPath(env.APP_BACKUP_ROOT, path.resolve(dataRoot, 'backups'));
  const uploadDir = resolveAppPath(env.APP_UPLOAD_ROOT, path.resolve(dataRoot, 'uploads'));
  const seedDemoData = parseBoolean(env.APP_ENABLE_DEMO_DATA) ?? runtimeMode === 'demo';
  const storeAuthMode = resolveStoreAuthMode(env.APP_STORE_AUTH_MODE);

  return {
    runtimeMode,
    envProfile,
    port: Number(env.PORT ?? 4300),
    host: env.HOST?.trim() || '0.0.0.0',
    trustProxy: parseBoolean(env.APP_TRUST_PROXY) ?? runtimeMode !== 'demo',
    logLevel: normalizeLogLevel(env.APP_LOG_LEVEL),
    requestLoggingEnabled: parseBoolean(env.APP_REQUEST_LOGGING_ENABLED) ?? true,
    metricsEnabled: parseBoolean(env.APP_METRICS_ENABLED) ?? true,
    metricsToken: env.APP_METRICS_TOKEN?.trim() || null,
    jwtSecret: env.JWT_SECRET?.trim() || 'goofish-sale-statistics-secret',
    jwtExpiresMinutes: Math.max(Number(env.APP_JWT_EXPIRES_MINUTES ?? 480), 30),
    secureConfigSecret:
      env.APP_CONFIG_CIPHER_SECRET?.trim() ||
      env.JWT_SECRET?.trim() ||
      'goofish-sale-statistics-secret',
    loginMaxAttempts: Math.max(Number(env.APP_LOGIN_MAX_ATTEMPTS ?? 10), 3),
    loginWindowMinutes: Math.max(Number(env.APP_LOGIN_WINDOW_MINUTES ?? 10), 1),
    privilegedWriteLimit: Math.max(Number(env.APP_PRIVILEGED_WRITE_LIMIT ?? 60), 10),
    privilegedWriteWindowMinutes: Math.max(
      Number(env.APP_PRIVILEGED_WRITE_WINDOW_MINUTES ?? 10),
      1,
    ),
    dataRoot,
    dbPath,
    logDir,
    backupDir,
    uploadDir,
    seedDemoData,
    bootstrapAdmin: resolveBootstrapAdmin(env),
    storeAuthMode,
    xianyuAppKey: env.APP_XIANYU_APP_KEY?.trim() || null,
    xianyuAppSecret: env.APP_XIANYU_APP_SECRET?.trim() || null,
    xianyuCallbackBaseUrl: env.APP_XIANYU_CALLBACK_BASE_URL?.trim().replace(/\/+$/, '') || null,
    xianyuAuthorizeBaseUrl:
      env.APP_XIANYU_AUTHORIZE_BASE_URL?.trim() || 'https://open.api.goofish.com/authorize',
    xianyuForceAuth: parseBoolean(env.APP_XIANYU_FORCE_AUTH) ?? true,
    webDistPath: path.resolve(currentDir, '../../web/dist'),
    envFilePath: loadedEnvFiles[0] ?? null,
    envFileLoaded: loadedEnvFiles.length > 0,
    envFilesLoaded: [...loadedEnvFiles],
  };
}

function isPlaceholderSecret(value: string) {
  const normalized = value.trim();
  const knownPlaceholders = new Set([
    '',
    'goofish-sale-statistics-secret',
    'change-me-in-production',
    'change-me-too',
    'replace-with-a-random-production-secret',
    'replace-with-a-second-random-secret',
    'replace-with-a-random-demo-secret',
    'replace-with-a-second-demo-secret',
  ]);

  return knownPlaceholders.has(normalized) || normalized.length < 24;
}

function isWeakAdminPassword(value: string, username: string) {
  const normalized = value.trim();
  const lower = normalized.toLowerCase();
  const weakPasswords = new Set([
    'Admin@123456',
    'Operator@123456',
    'Support@123456',
    'Finance@123456',
    'password',
    'password123',
    '12345678',
  ]);

  return (
    normalized.length < 12 ||
    weakPasswords.has(normalized) ||
    lower.includes('replace-with') ||
    lower.includes('change-me') ||
    lower.includes(username.toLowerCase())
  );
}

function canWriteDirectory(targetPath: string) {
  try {
    fs.mkdirSync(targetPath, { recursive: true });
    const tempFile = path.join(targetPath, `.write-test-${process.pid}-${Date.now()}.tmp`);
    fs.writeFileSync(tempFile, 'ok', 'utf8');
    fs.rmSync(tempFile, { force: true });
    return true;
  } catch {
    return false;
  }
}

function getLatestFileMtimeMs(targetPath: string): number {
  try {
    const stat = fs.statSync(targetPath);
    if (!stat.isDirectory()) {
      return stat.mtimeMs;
    }

    return fs
      .readdirSync(targetPath, { withFileTypes: true })
      .reduce(
        (latest, entry) =>
          Math.max(latest, getLatestFileMtimeMs(path.join(targetPath, entry.name))),
        stat.mtimeMs,
      );
  } catch {
    return 0;
  }
}

function getLatestWebSourceMtimeMs(webRootPath: string) {
  return [
    'src',
    'index.html',
    'package.json',
    'tsconfig.json',
    'tsconfig.app.json',
    'vite.config.ts',
  ]
    .map((entry) => path.join(webRootPath, entry))
    .reduce((latest, candidatePath) => Math.max(latest, getLatestFileMtimeMs(candidatePath)), 0);
}

export function getRuntimeConfigIssues(config: ResolvedAppConfig): RuntimeConfigIssue[] {
  const issues: RuntimeConfigIssue[] = [];
  const strictMode = config.runtimeMode !== 'demo';
  const normalizedDbPath = path.resolve(config.dbPath);
  const directoryEntries = [
    ['APP_DATA_ROOT', path.resolve(config.dataRoot)],
    ['APP_LOG_ROOT', path.resolve(config.logDir)],
    ['APP_BACKUP_ROOT', path.resolve(config.backupDir)],
    ['APP_UPLOAD_ROOT', path.resolve(config.uploadDir)],
  ] as const;
  const duplicatePathMap = new Map<string, string[]>();

  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
    issues.push({ field: 'PORT', message: '端口必须是 1 到 65535 之间的整数。' });
  }

  if (!config.host.trim()) {
    issues.push({ field: 'HOST', message: '监听地址不能为空。' });
  }

  if (
    config.storeAuthMode === 'xianyu_browser_oauth' &&
    !/^https:\/\/.+/i.test(config.xianyuAuthorizeBaseUrl)
  ) {
    issues.push({
      field: 'APP_XIANYU_AUTHORIZE_BASE_URL',
      message: '闲鱼授权地址必须使用 https。',
    });
  }

  directoryEntries.forEach(([field, targetPath]) => {
    const rows = duplicatePathMap.get(targetPath) ?? [];
    rows.push(field);
    duplicatePathMap.set(targetPath, rows);
  });

  duplicatePathMap.forEach((fields) => {
    if (fields.length > 1) {
      issues.push({
        field: fields.join(', '),
        message: `目录配置重复，${fields.join('、')} 指向了同一路径。`,
      });
    }
  });

  if (directoryEntries.some(([, targetPath]) => targetPath === normalizedDbPath)) {
    issues.push({
      field: 'APP_DB_PATH',
      message: '数据库文件路径不能与数据、日志、备份或上传目录相同。',
    });
  }

  if (strictMode) {
    if (config.seedDemoData) {
      issues.push({
        field: 'APP_ENABLE_DEMO_DATA',
        message: `${config.runtimeMode} 模式禁止启用演示数据。`,
      });
    }

    if (isPlaceholderSecret(config.jwtSecret)) {
      issues.push({
        field: 'JWT_SECRET',
        message: 'JWT_SECRET 仍是占位值或长度过短，不能用于预发或生产环境。',
      });
    }

    if (isPlaceholderSecret(config.secureConfigSecret)) {
      issues.push({
        field: 'APP_CONFIG_CIPHER_SECRET',
        message: 'APP_CONFIG_CIPHER_SECRET 仍是占位值或长度过短，不能用于预发或生产环境。',
      });
    }

    if (config.jwtSecret === config.secureConfigSecret) {
      issues.push({
        field: 'JWT_SECRET, APP_CONFIG_CIPHER_SECRET',
        message: '鉴权密钥与敏感配置加密密钥必须分离，不能使用同一个值。',
      });
    }

    if (!config.bootstrapAdmin) {
      issues.push({
        field: 'APP_INIT_ADMIN_USERNAME, APP_INIT_ADMIN_PASSWORD',
        message: `${config.runtimeMode} 模式必须显式配置初始化管理员账号与密码。`,
      });
    }
  }

  if (strictMode && config.storeAuthMode === 'xianyu_browser_oauth') {
    if (!config.xianyuAppKey) {
      issues.push({
        field: 'APP_XIANYU_APP_KEY',
        message: '启用真实闲鱼授权时必须配置 APP_XIANYU_APP_KEY。',
      });
    }

    if (!config.xianyuAppSecret) {
      issues.push({
        field: 'APP_XIANYU_APP_SECRET',
        message: '启用真实闲鱼授权时必须配置 APP_XIANYU_APP_SECRET。',
      });
    }

    if (!config.xianyuCallbackBaseUrl) {
      issues.push({
        field: 'APP_XIANYU_CALLBACK_BASE_URL',
        message: '启用真实闲鱼授权时必须配置 APP_XIANYU_CALLBACK_BASE_URL。',
      });
    } else if (!/^https:\/\/.+/i.test(config.xianyuCallbackBaseUrl)) {
      issues.push({
        field: 'APP_XIANYU_CALLBACK_BASE_URL',
        message: '生产或预发环境的闲鱼授权回调基址必须使用 https。',
      });
    }
  }

  if (config.bootstrapAdmin) {
    if (!/^[a-zA-Z0-9._-]{3,32}$/.test(config.bootstrapAdmin.username)) {
      issues.push({
        field: 'APP_INIT_ADMIN_USERNAME',
        message: '初始化管理员用户名只允许 3 到 32 位字母、数字、点、下划线和中划线。',
      });
    }

    if (
      config.bootstrapAdmin.displayName.trim().length < 2 ||
      config.bootstrapAdmin.displayName.trim().length > 32
    ) {
      issues.push({
        field: 'APP_INIT_ADMIN_DISPLAY_NAME',
        message: '初始化管理员显示名长度必须在 2 到 32 个字符之间。',
      });
    }

    if (
      strictMode &&
      isWeakAdminPassword(config.bootstrapAdmin.password, config.bootstrapAdmin.username)
    ) {
      issues.push({
        field: 'APP_INIT_ADMIN_PASSWORD',
        message: '初始化管理员密码强度不足，请使用至少 12 位且非默认口令的强密码。',
      });
    }
  }

  return issues;
}

export function getRuntimeStartupIssues(
  config: ResolvedAppConfig,
  options: { requireWebBuild?: boolean } = {},
) {
  const issues: RuntimeConfigIssue[] = [];
  const requireWebBuild = options.requireWebBuild ?? false;

  if (requireWebBuild) {
    const indexFilePath = path.join(config.webDistPath, 'index.html');
    if (!fs.existsSync(indexFilePath)) {
      issues.push({
        field: 'web/dist',
        message: `缺少前端构建产物：${indexFilePath}，请先执行 npm run build。`,
      });
    } else {
      const distMtimeMs = getLatestFileMtimeMs(config.webDistPath);
      const latestSourceMtimeMs = getLatestWebSourceMtimeMs(path.dirname(config.webDistPath));

      if (latestSourceMtimeMs > distMtimeMs + 1000) {
        issues.push({
          field: 'web/dist',
          message: `前端构建产物已过期：${config.webDistPath} 早于 web 源码，请重新执行 npm run build。`,
        });
      }
    }
  }

  const writableTargets = [
    ['APP_DATA_ROOT', config.dataRoot],
    ['APP_LOG_ROOT', config.logDir],
    ['APP_BACKUP_ROOT', config.backupDir],
    ['APP_UPLOAD_ROOT', config.uploadDir],
    ['APP_DB_PATH', path.dirname(config.dbPath)],
  ] as const;

  writableTargets.forEach(([field, targetPath]) => {
    if (!canWriteDirectory(targetPath)) {
      issues.push({
        field,
        message: `目录不可写：${path.resolve(targetPath)}`,
      });
    }
  });

  return issues;
}

export function assertValidRuntimeConfig(config: ResolvedAppConfig) {
  const issues = getRuntimeConfigIssues(config);
  if (issues.length === 0) {
    return;
  }

  throw new Error(
    ['启动前检查失败，请修正以下配置：', ...issues.map((issue) => `- ${issue.field}: ${issue.message}`)].join(
      '\n',
    ),
  );
}

export function assertRuntimeStartupReadiness(
  config: ResolvedAppConfig,
  options: { requireWebBuild?: boolean } = {},
) {
  const issues = getRuntimeStartupIssues(config, options);
  if (issues.length === 0) {
    return;
  }

  throw new Error(
    ['启动就绪检查失败，请修正以下问题：', ...issues.map((issue) => `- ${issue.field}: ${issue.message}`)].join(
      '\n',
    ),
  );
}

export function getRuntimeConfigSummary(config: ResolvedAppConfig) {
  return {
    strictMode: config.runtimeMode !== 'demo',
    envProfile: config.envProfile,
    envFileLoaded: config.envFileLoaded,
    envFilePath: config.envFilePath,
    envFilesLoaded: config.envFilesLoaded,
    demoDataEnabled: config.seedDemoData,
    bootstrapAdminConfigured: Boolean(config.bootstrapAdmin),
    requestLoggingEnabled: config.requestLoggingEnabled,
    metricsEnabled: config.metricsEnabled,
    logLevel: config.logLevel,
    trustProxy: config.trustProxy,
    storeAuthMode: config.storeAuthMode,
    xianyuRealAuthReady:
      config.storeAuthMode === 'xianyu_browser_oauth' &&
      Boolean(config.xianyuAppKey && config.xianyuAppSecret && config.xianyuCallbackBaseUrl),
    dataRoot: config.dataRoot,
    dbPath: config.dbPath,
  };
}

export function ensureRuntimeDirectories(config: ResolvedAppConfig = appConfig) {
  [config.dataRoot, path.dirname(config.dbPath), config.logDir, config.backupDir, config.uploadDir].forEach(
    (targetPath) => {
      fs.mkdirSync(targetPath, { recursive: true });
    },
  );
}

export const appConfig = buildAppConfig(process.env);
