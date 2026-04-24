import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { chromium } from 'playwright';

import {
  createSmokeRuntime,
  ensureExists,
  shutdown,
  spawnServer,
  waitForHealth,
} from './smoke-web-lib.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverEntry = path.join(repoRoot, 'server', 'dist', 'server.js');
const webIndex = path.join(repoRoot, 'web', 'dist', 'index.html');

ensureExists(serverEntry);
ensureExists(webIndex);

const runtime = createSmokeRuntime('sale-compass-web-private');
const port = 5200 + Math.floor(Math.random() * 200);
const adminPassword = 'SmokeWebAdmin@20260417';
const childProcess = spawnServer({
  repoRoot,
  serverEntry,
  env: {
    ...process.env,
    HOST: '127.0.0.1',
    PORT: String(port),
    APP_RUNTIME_MODE: 'prod',
    APP_ENABLE_DEMO_DATA: 'false',
    APP_DATA_ROOT: runtime.smokeRoot,
    APP_DB_PATH: path.join(runtime.smokeRoot, 'app.db'),
    APP_LOG_ROOT: path.join(runtime.smokeRoot, 'logs'),
    APP_BACKUP_ROOT: path.join(runtime.smokeRoot, 'backups'),
    APP_UPLOAD_ROOT: path.join(runtime.smokeRoot, 'uploads'),
    JWT_SECRET: 'smoke-web-private-jwt-secret-20260417-abcdef',
    APP_CONFIG_CIPHER_SECRET: 'smoke-web-private-config-secret-20260417-abcdef',
    APP_INIT_ADMIN_USERNAME: 'smoke-web-admin',
    APP_INIT_ADMIN_PASSWORD: adminPassword,
    APP_INIT_ADMIN_DISPLAY_NAME: '浏览器烟测管理员',
    APP_METRICS_ENABLED: 'true',
    APP_METRICS_TOKEN: 'smoke-web-private-metrics-token',
    APP_LOG_LEVEL: 'info',
    APP_REQUEST_LOGGING_ENABLED: 'true',
    APP_TRUST_PROXY: 'false',
  },
});
runtime.collectLogs(childProcess);

const baseUrl = `http://127.0.0.1:${port}`;
let browser;

try {
  await waitForHealth(baseUrl);

  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });

  await page.goto(`${baseUrl}/login`, { waitUntil: 'networkidle' });
  await page.locator('input[autocomplete="username"]').fill('smoke-web-admin');
  await page.locator('input[autocomplete="current-password"]').fill(adminPassword);
  await page.locator('button[type="submit"]').click();

  await page.waitForURL(/\/dashboard$/, { timeout: 10000 });
  await page.waitForLoadState('networkidle');

  if (!page.url().endsWith('/dashboard')) {
    throw new Error(`登录后未进入仪表盘：${page.url()}`);
  }

  await page.waitForSelector('[data-testid="app-shell"]', { timeout: 10000 });
  await page.waitForSelector('[data-testid="functional-dashboard"]', { timeout: 10000 });

  const shellVisible = await page.locator('[data-testid="app-shell"]').first().isVisible();
  const dashboardVisible = await page
    .locator('[data-testid="functional-dashboard"]')
    .first()
    .isVisible();

  if (!shellVisible || !dashboardVisible) {
    throw new Error('登录后未渲染业务工作台首页');
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        checkedAt: new Date().toISOString(),
        baseUrl,
        loginVerified: true,
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
      screenshotPath = path.join(runtime.smokeRoot, 'private-smoke-failed.png');
      await page.screenshot({ path: screenshotPath, fullPage: true }).catch(() => {});
    }
  }

  console.error(
    JSON.stringify(
      {
        ok: false,
        checkedAt: new Date().toISOString(),
        message: error instanceof Error ? error.message : '私有化浏览器烟测失败',
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
