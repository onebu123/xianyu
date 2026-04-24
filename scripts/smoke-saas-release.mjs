import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverEntry = path.join(repoRoot, 'server', 'dist', 'server.js');
const webIndex = path.join(repoRoot, 'web', 'dist', 'index.html');

function ensureExists(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`缺少文件：${filePath}`);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 5000);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        ...(options.headers || {}),
      },
    });
    const text = await response.text();
    return {
      status: response.status,
      headers: response.headers,
      text,
      json: text ? JSON.parse(text) : null,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function waitForHealth(baseUrl) {
  let lastError = null;
  for (let attempt = 1; attempt <= 30; attempt += 1) {
    try {
      const response = await fetchJson(`${baseUrl}/api/health`, { timeoutMs: 3000 });
      if (response.status === 200 && response.json?.status === 'ok') {
        return response.json;
      }
      lastError = new Error(`健康检查返回 ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await sleep(1000);
  }
  throw lastError ?? new Error('健康检查超时');
}

async function shutdown(childProcess) {
  if (childProcess.exitCode !== null) {
    return;
  }

  childProcess.kill('SIGTERM');
  await new Promise((resolve) => {
    const timeout = setTimeout(() => {
      if (childProcess.exitCode === null) {
        childProcess.kill('SIGKILL');
      }
      resolve();
    }, 5000);
    childProcess.once('exit', () => {
      clearTimeout(timeout);
      resolve();
    });
  });
}

ensureExists(serverEntry);
ensureExists(webIndex);

const smokeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sale-compass-saas-smoke-'));
const port = 4800 + Math.floor(Math.random() * 200);
const adminPassword = 'SmokePlatform@20260312';
const serverLogs = [];

const childProcess = spawn(process.execPath, [serverEntry], {
  cwd: repoRoot,
  env: {
    ...process.env,
    HOST: '127.0.0.1',
    PORT: String(port),
    APP_DEPLOYMENT_MODE: 'saas',
    APP_RUNTIME_MODE: 'staging',
    APP_ENABLE_DEMO_DATA: 'false',
    APP_DATA_ROOT: smokeRoot,
    APP_DB_PATH: path.join(smokeRoot, 'private-app.db'),
    APP_CONTROL_PLANE_DB_PATH: path.join(smokeRoot, 'control-plane.db'),
    APP_TENANT_DB_ROOT: path.join(smokeRoot, 'tenants'),
    APP_LOG_ROOT: path.join(smokeRoot, 'logs'),
    APP_BACKUP_ROOT: path.join(smokeRoot, 'backups'),
    APP_UPLOAD_ROOT: path.join(smokeRoot, 'uploads'),
    JWT_SECRET: 'saas-smoke-jwt-secret-20260416-abcdef',
    APP_CONFIG_CIPHER_SECRET: 'saas-smoke-config-secret-20260416-abcdef',
    APP_INIT_ADMIN_USERNAME: 'platform-admin',
    APP_INIT_ADMIN_PASSWORD: adminPassword,
    APP_INIT_ADMIN_DISPLAY_NAME: 'SaaS烟测管理员',
    APP_METRICS_ENABLED: 'true',
    APP_METRICS_TOKEN: 'saas-smoke-metrics-token-20260416',
    APP_LOG_LEVEL: 'info',
    APP_REQUEST_LOGGING_ENABLED: 'true',
    APP_TRUST_PROXY: 'false',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

childProcess.stdout.on('data', (chunk) => {
  serverLogs.push(String(chunk));
});
childProcess.stderr.on('data', (chunk) => {
  serverLogs.push(String(chunk));
});

const baseUrl = `http://127.0.0.1:${port}`;

try {
  const health = await waitForHealth(baseUrl);

  const loginPage = await fetch(`${baseUrl}/login`);
  const loginPageText = await loginPage.text();
  if (loginPage.status !== 200 || !/<!doctype html>/i.test(loginPageText)) {
    throw new Error('SaaS 登录页未正确返回构建产物');
  }

  const loginResponse = await fetchJson(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    timeoutMs: 5000,
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      username: 'platform-admin',
      password: adminPassword,
    }),
  });
  if (loginResponse.status !== 200 || loginResponse.json?.scope !== 'platform' || !loginResponse.json?.token) {
    throw new Error(`平台管理员登录失败：${loginResponse.text}`);
  }

  const platformToken = loginResponse.json.token;
  const platformHeaders = {
    authorization: `Bearer ${platformToken}`,
    'content-type': 'application/json',
  };

  const usersResponse = await fetchJson(`${baseUrl}/api/platform/users`, {
    headers: platformHeaders,
  });
  if (usersResponse.status !== 200 || !Array.isArray(usersResponse.json?.list) || usersResponse.json.list.length < 1) {
    throw new Error(`平台用户列表校验失败：${usersResponse.text}`);
  }

  const deniedBusinessResponse = await fetchJson(`${baseUrl}/api/dashboard?preset=last30Days`, {
    headers: {
      authorization: `Bearer ${platformToken}`,
    },
  });
  if (deniedBusinessResponse.status !== 403) {
    throw new Error(`平台会话未正确阻断业务接口：${deniedBusinessResponse.text}`);
  }

  const tenantCreateResponse = await fetchJson(`${baseUrl}/api/platform/tenants`, {
    method: 'POST',
    headers: platformHeaders,
    body: JSON.stringify({
      tenantKey: 'smoke-tenant',
      tenantName: 'Smoke Tenant',
      displayName: 'Smoke Tenant',
    }),
  });
  if (tenantCreateResponse.status !== 200 || !tenantCreateResponse.json?.tenant?.id) {
    throw new Error(`创建租户失败：${tenantCreateResponse.text}`);
  }

  const tenantId = tenantCreateResponse.json.tenant.id;
  const selectTenantResponse = await fetchJson(`${baseUrl}/api/auth/select-tenant`, {
    method: 'POST',
    headers: platformHeaders,
    body: JSON.stringify({ tenantId }),
  });
  if (selectTenantResponse.status !== 200 || selectTenantResponse.json?.scope !== 'tenant' || !selectTenantResponse.json?.token) {
    throw new Error(`切换租户失败：${selectTenantResponse.text}`);
  }

  const tenantToken = selectTenantResponse.json.token;
  const tenantHeaders = {
    authorization: `Bearer ${tenantToken}`,
  };

  const profileResponse = await fetchJson(`${baseUrl}/api/auth/profile`, {
    headers: tenantHeaders,
  });
  if (
    profileResponse.status !== 200 ||
    profileResponse.json?.scope !== 'tenant' ||
    profileResponse.json?.tenant?.id !== tenantId
  ) {
    throw new Error(`租户会话资料校验失败：${profileResponse.text}`);
  }

  const dashboardResponse = await fetchJson(`${baseUrl}/api/dashboard?preset=last30Days`, {
    headers: tenantHeaders,
  });
  if (dashboardResponse.status !== 200) {
    throw new Error(`租户工作台接口不可用：${dashboardResponse.text}`);
  }

  const deniedPlatformResponse = await fetchJson(`${baseUrl}/api/platform/tenants`, {
    headers: tenantHeaders,
  });
  if (deniedPlatformResponse.status !== 403) {
    throw new Error(`租户会话未正确阻断平台接口：${deniedPlatformResponse.text}`);
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        checkedAt: new Date().toISOString(),
        baseUrl,
        runtimeMode: health.runtimeMode,
        deploymentMode: health.deploymentMode,
        platformLoginVerified: true,
        tenantSwitchVerified: true,
        crossScopeIsolationVerified: true,
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(
    JSON.stringify(
      {
        ok: false,
        checkedAt: new Date().toISOString(),
        message: error instanceof Error ? error.message : 'SaaS 发布烟测失败',
        logs: serverLogs.join('').trim(),
      },
      null,
      2,
    ),
  );
  process.exitCode = 1;
} finally {
  await shutdown(childProcess);
  fs.rmSync(smokeRoot, { recursive: true, force: true });
}
