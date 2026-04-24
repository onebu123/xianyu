import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

export function ensureExists(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`缺少文件：${filePath}`);
  }
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function fetchJson(url, options = {}) {
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

export async function waitForHealth(baseUrl) {
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

export async function shutdown(childProcess) {
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

export function createSmokeRuntime(prefix) {
  const smokeRoot = fs.mkdtempSync(path.join(os.tmpdir(), `${prefix}-`));
  const logs = [];

  return {
    smokeRoot,
    logs,
    collectLogs(childProcess) {
      childProcess.stdout.on('data', (chunk) => {
        logs.push(String(chunk));
      });
      childProcess.stderr.on('data', (chunk) => {
        logs.push(String(chunk));
      });
    },
    dumpLogs() {
      return logs.join('').trim();
    },
    cleanup() {
      fs.rmSync(smokeRoot, { recursive: true, force: true });
    },
  };
}

export function spawnServer({ repoRoot, serverEntry, env }) {
  return spawn(process.execPath, [serverEntry], {
    cwd: repoRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}
