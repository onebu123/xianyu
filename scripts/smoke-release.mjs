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

const smokeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sale-compass-smoke-'));
const port = 4600 + Math.floor(Math.random() * 200);
const metricsToken = `metrics-token-${Date.now()}`;
const adminPassword = 'SmokeAdmin@20260312';
const serverLogs = [];

const childProcess = spawn(process.execPath, [serverEntry], {
  cwd: repoRoot,
  env: {
    ...process.env,
    HOST: '127.0.0.1',
    PORT: String(port),
    APP_RUNTIME_MODE: 'prod',
    APP_ENABLE_DEMO_DATA: 'false',
    APP_DATA_ROOT: smokeRoot,
    APP_DB_PATH: path.join(smokeRoot, 'app.db'),
    APP_LOG_ROOT: path.join(smokeRoot, 'logs'),
    APP_BACKUP_ROOT: path.join(smokeRoot, 'backups'),
    APP_UPLOAD_ROOT: path.join(smokeRoot, 'uploads'),
    JWT_SECRET: 'smoke-release-jwt-secret-20260312-abcdef',
    APP_CONFIG_CIPHER_SECRET: 'smoke-release-config-secret-20260312-abcdef',
    APP_INIT_ADMIN_USERNAME: 'smoke-admin',
    APP_INIT_ADMIN_PASSWORD: adminPassword,
    APP_INIT_ADMIN_DISPLAY_NAME: '烟测管理员',
    APP_METRICS_ENABLED: 'true',
    APP_METRICS_TOKEN: metricsToken,
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
    throw new Error('前端登录页未正确返回构建产物');
  }

  const loginResponse = await fetchJson(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    timeoutMs: 5000,
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      username: 'smoke-admin',
      password: adminPassword,
    }),
  });
  if (loginResponse.status !== 200 || !loginResponse.json?.token) {
    throw new Error(`管理员登录失败：${loginResponse.text}`);
  }

  const metricsResponse = await fetch(`${baseUrl}/api/metrics`, {
    headers: {
      'x-metrics-token': metricsToken,
    },
  });
  const metricsText = await metricsResponse.text();
  if (
    metricsResponse.status !== 200 ||
    !metricsText.includes('sale_compass_http_requests_total') ||
    !metricsText.includes('sale_compass_info')
  ) {
    throw new Error('指标接口返回不符合预期');
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        checkedAt: new Date().toISOString(),
        baseUrl,
        runtimeMode: health.runtimeMode,
        envProfile: health.configuration?.envProfile ?? null,
        metricsVerified: true,
        loginVerified: true,
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
        message: error instanceof Error ? error.message : '发布烟测失败',
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
