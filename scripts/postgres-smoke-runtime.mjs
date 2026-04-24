import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { PGlite } from '@electric-sql/pglite';
import { LogLevel, createServer as createPgliteServer } from 'pglite-server';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function randomPort(base) {
  return base + Math.floor(Math.random() * 400);
}

export function waitForPort(port, host = '127.0.0.1', timeoutMs = 30000) {
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
          reject(new Error(`PostgreSQL port ${port} did not become ready within ${timeoutMs}ms.`));
          return;
        }
        setTimeout(attempt, 800);
      });
    };
    attempt();
  });
}

export function run(command, args, options = {}) {
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
      process.stdout.write(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
      process.stderr.write(chunk);
    });
    child.once('exit', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }
      reject(new Error(`${command} ${args.join(' ')} exited with code ${code}\n${stderr || stdout}`));
    });
    child.once('error', (error) => {
      reject(error);
    });
  });
}

function runQuiet(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      stdio: 'ignore',
      ...options,
    });
    child.once('exit', (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} ${args.join(' ')} exited with code ${code}`));
    });
    child.once('error', (error) => reject(error));
  });
}

async function canUseDocker() {
  try {
    await runQuiet('docker', ['version']);
    return true;
  } catch {
    return false;
  }
}

async function startDockerPostgresInstance({ port, databaseName, user, password }) {
  const runResult = await run('docker', [
    'run',
    '--rm',
    '-d',
    '-e',
    `POSTGRES_DB=${databaseName}`,
    '-e',
    `POSTGRES_USER=${user}`,
    '-e',
    `POSTGRES_PASSWORD=${password}`,
    '-p',
    `${port}:5432`,
    'postgres:16-alpine',
  ]);
  const containerId = runResult.stdout.trim();
  await waitForPort(port);
  await sleep(2000);

  return {
    backend: 'docker',
    connectionString: `postgres://${user}:${password}@127.0.0.1:${port}/${databaseName}`,
    async cleanup() {
      if (!containerId) {
        return;
      }
      try {
        await run('docker', ['rm', '-f', containerId]);
      } catch {
        // Ignore cleanup failures so the original smoke-test result is preserved.
      }
    },
  };
}

async function startPglitePostgresInstance({ port, databaseName, dataDirPrefix }) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), dataDirPrefix));
  const db = new PGlite(path.join(tempRoot, 'pgdata'));
  await db.waitReady;

  const server = createPgliteServer(db, {
    logLevel: LogLevel.Error,
  });
  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });
  await waitForPort(port);

  return {
    backend: 'pglite',
    connectionString: `postgres://postgres:postgres@127.0.0.1:${port}/${databaseName}`,
    async cleanup() {
      await new Promise((resolve) => {
        server.close(() => resolve());
      });
      await db.close();
      fs.rmSync(tempRoot, { recursive: true, force: true });
    },
  };
}

export async function resolvePostgresTarget({
  envUrlNames = [],
  portBase,
  databaseName = 'postgres',
  user = 'postgres',
  password = 'postgres',
  dataDirPrefix = 'sale-compass-pglite-',
}) {
  for (const envName of envUrlNames) {
    const configuredUrl = process.env[envName]?.trim();
    if (!configuredUrl) {
      continue;
    }

    return {
      backend: 'external',
      connectionString: configuredUrl,
      async cleanup() {},
    };
  }

  const port = randomPort(portBase);
  if (await canUseDocker()) {
    return startDockerPostgresInstance({
      port,
      databaseName,
      user,
      password,
    });
  }

  return startPglitePostgresInstance({
    port,
    databaseName,
    dataDirPrefix,
  });
}
