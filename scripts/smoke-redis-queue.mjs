import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const backendModulePath = path.join(repoRoot, 'server', 'dist', 'fulfillment-queue-backend.js');

if (!fs.existsSync(backendModulePath)) {
  throw new Error('缺少 server/dist/fulfillment-queue-backend.js，请先执行 npm run build');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomPort(base) {
  return base + Math.floor(Math.random() * 400);
}

function waitForPort(port, host = '127.0.0.1', timeoutMs = 20000) {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = net.createConnection({ port, host });
      socket.once('connect', () => {
        socket.destroy();
        resolve();
      });
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() - startedAt > timeoutMs) {
          reject(new Error(`Redis 端口 ${port} 在 ${timeoutMs}ms 内未就绪`));
          return;
        }
        setTimeout(attempt, 500);
      });
    };
    attempt();
  });
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...options,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.once('exit', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error(`${command} ${args.join(' ')} 执行失败，退出码 ${code}\n${stderr || stdout}`));
    });
  });
}

async function canUseDocker() {
  try {
    await run('docker', ['version']);
    return true;
  } catch {
    return false;
  }
}

function startRedisWithDocker(port) {
  return new Promise(async (resolve, reject) => {
    try {
      const result = await run('docker', [
        'run',
        '--rm',
        '-d',
        '-p',
        `${port}:6379`,
        'redis:7-alpine',
      ]);
      resolve({
        kind: 'docker',
        handle: result.stdout.trim(),
      });
    } catch (error) {
      reject(error);
    }
  });
}

function startRedisWithBinary(port) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sale-compass-redis-smoke-'));
  const child = spawn(
    'redis-server',
    ['--save', '', '--appendonly', 'no', '--port', String(port), '--dir', tempRoot],
    {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let stderr = '';
  child.stderr.on('data', (chunk) => {
    stderr += String(chunk);
  });
  return {
    kind: 'binary',
    handle: child,
    cleanupDir: tempRoot,
    getStderr: () => stderr,
  };
}

async function cleanupRedis(instance) {
  if (!instance) {
    return;
  }
  if (instance.kind === 'docker') {
    try {
      await run('docker', ['rm', '-f', instance.handle]);
    } catch {
      // ignore
    }
    return;
  }
  if (instance.handle.exitCode === null) {
    instance.handle.kill('SIGTERM');
    await sleep(500);
    if (instance.handle.exitCode === null) {
      instance.handle.kill('SIGKILL');
    }
  }
  if (instance.cleanupDir) {
    fs.rmSync(instance.cleanupDir, { recursive: true, force: true });
  }
}

let redisInstance = null;
let redisUrl = process.env.APP_REDIS_URL?.trim() || process.env.SMOKE_REDIS_URL?.trim() || null;

try {
  if (!redisUrl) {
    const port = randomPort(56379);
    if (await canUseDocker()) {
      try {
        redisInstance = await startRedisWithDocker(port);
      } catch {
        redisInstance = startRedisWithBinary(port);
      }
    } else {
      redisInstance = startRedisWithBinary(port);
    }

    await waitForPort(port);
    await sleep(1000);
    redisUrl = `redis://127.0.0.1:${port}`;
  }

  const { createFulfillmentQueueBackend } = await import(pathToFileURL(backendModulePath).href);
  let pendingIds = [101, 102];
  const backend = createFulfillmentQueueBackend({
    config: {
      queueBackend: 'redis',
      redisUrl,
      redisPrefix: `sale-compass-smoke-${Date.now()}`,
    },
    db: {
      listPendingFulfillmentQueueTaskIds(limit) {
        const result = pendingIds.slice(0, limit);
        pendingIds = pendingIds.slice(limit);
        return result;
      },
    },
    logger: {
      info() {},
      warn() {},
      error() {},
    },
  });

  await backend.ensureReady();
  await backend.enqueue(201);
  const reserved = await backend.reserveDueTaskIds(4);
  const runtimeStatus = backend.getRuntimeStatus();
  await backend.close();

  const expected = [101, 102, 201];
  const missing = expected.filter((id) => !reserved.includes(id));
  if (missing.length > 0) {
    throw new Error(`Redis 队列联调失败，未取到任务：${missing.join(', ')}`);
  }

  console.log(
    JSON.stringify(
      {
        ok: true,
        checkedAt: new Date().toISOString(),
        backend: 'redis',
        redisUrl,
        runtimeStatus,
        reservedTaskIds: reserved,
      },
      null,
      2,
    ),
  );
} finally {
  await cleanupRedis(redisInstance);
}
