import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

import {
  createSmokeRuntime,
  ensureExists,
  fetchJson,
  shutdown,
  spawnServer,
  waitForHealth,
} from './smoke-web-lib.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverEntry = path.join(repoRoot, 'server', 'dist', 'server.js');
const webIndex = path.join(repoRoot, 'web', 'dist', 'index.html');

ensureExists(serverEntry);
ensureExists(webIndex);

const runtime = createSmokeRuntime('sale-compass-web-saas');
const port = 5400 + Math.floor(Math.random() * 200);
const adminPassword = 'SmokeWebPlatform@20260417';
const childProcess = spawnServer({
  repoRoot,
  serverEntry,
  env: {
    ...process.env,
    HOST: '127.0.0.1',
    PORT: String(port),
    APP_DEPLOYMENT_MODE: 'saas',
    APP_RUNTIME_MODE: 'staging',
    APP_ENABLE_DEMO_DATA: 'false',
    APP_DATA_ROOT: runtime.smokeRoot,
    APP_DB_PATH: path.join(runtime.smokeRoot, 'private-app.db'),
    APP_CONTROL_PLANE_DB_PATH: path.join(runtime.smokeRoot, 'control-plane.db'),
    APP_TENANT_DB_ROOT: path.join(runtime.smokeRoot, 'tenants'),
    APP_LOG_ROOT: path.join(runtime.smokeRoot, 'logs'),
    APP_BACKUP_ROOT: path.join(runtime.smokeRoot, 'backups'),
    APP_UPLOAD_ROOT: path.join(runtime.smokeRoot, 'uploads'),
    JWT_SECRET: 'smoke-web-saas-jwt-secret-20260417-abcdef',
    APP_CONFIG_CIPHER_SECRET: 'smoke-web-saas-config-secret-20260417-abcdef',
    APP_INIT_ADMIN_USERNAME: 'platform-admin',
    APP_INIT_ADMIN_PASSWORD: adminPassword,
    APP_INIT_ADMIN_DISPLAY_NAME: '浏览器平台管理员',
    APP_METRICS_ENABLED: 'true',
    APP_METRICS_TOKEN: 'smoke-web-saas-metrics-token',
    APP_LOG_LEVEL: 'info',
    APP_REQUEST_LOGGING_ENABLED: 'true',
    APP_TRUST_PROXY: 'false',
  },
});
runtime.collectLogs(childProcess);

const baseUrl = `http://127.0.0.1:${port}`;
let browser;

async function bootstrapTenant() {
  const loginResponse = await fetchJson(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      username: 'platform-admin',
      password: adminPassword,
    }),
  });
  if (loginResponse.status !== 200 || !loginResponse.json?.token) {
    throw new Error(`SaaS 平台预创建租户登录失败：${loginResponse.text}`);
  }

  const tenantResponse = await fetchJson(`${baseUrl}/api/platform/tenants`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${loginResponse.json.token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      tenantKey: 'web-smoke-tenant',
      tenantName: 'Web Smoke Tenant',
      displayName: 'Web Smoke Tenant',
    }),
  });
  if (tenantResponse.status !== 200 || !tenantResponse.json?.tenant?.id) {
    throw new Error(`SaaS 平台预创建租户失败：${tenantResponse.text}`);
  }
}

try {
  await waitForHealth(baseUrl);
  await bootstrapTenant();

  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });

  await page.goto(`${baseUrl}/login`, { waitUntil: 'networkidle' });
  await page.locator('input[autocomplete="username"]').fill('platform-admin');
  await page.locator('input[autocomplete="current-password"]').fill(adminPassword);
  await page.locator('button[type="submit"]').click();

  await page.waitForURL(/\/auth\/select-tenant$/, { timeout: 10000 });
  await page.waitForLoadState('networkidle');

  await page.locator('.saas-tenant-card .ant-btn-primary').first().click();
  await page.waitForURL(/\/dashboard$/, { timeout: 10000 });
  await page.waitForLoadState('networkidle');

  if (!page.url().endsWith('/dashboard')) {
    throw new Error(`SaaS 租户切换后未进入仪表盘：${page.url()}`);
  }

  await page.waitForSelector('[data-testid="app-shell"]', { timeout: 10000 });
  await page.waitForSelector('[data-testid="functional-dashboard"]', { timeout: 10000 });

  const shellVisible = await page.locator('[data-testid="app-shell"]').first().isVisible();
  const dashboardVisible = await page
    .locator('[data-testid="functional-dashboard"]')
    .first()
    .isVisible();

  if (!shellVisible || !dashboardVisible) {
    throw new Error('SaaS 租户工作台首页未渲染');
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        checkedAt: new Date().toISOString(),
        baseUrl,
        platformLoginVerified: true,
        tenantSelectVerified: true,
        shellVerified: true,
        dashboardVerified: true,
      },
      null,
      2,
    ),
  );
} catch (error) {
  let screenshotPath = null;
  if (browser) {
    const page = browser.contexts()[0]?.pages()[0];
    if (page) {
      screenshotPath = path.join(runtime.smokeRoot, 'saas-smoke-failed.png');
      await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
    }
  }

  console.error(
    JSON.stringify(
      {
        ok: false,
        checkedAt: new Date().toISOString(),
        message: error instanceof Error ? error.message : 'SaaS 浏览器烟测失败',
        screenshotPath,
        logs: runtime.dumpLogs(),
      },
      null,
      2,
    ),
  );
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
  await shutdown(childProcess);
  runtime.cleanup();
}
