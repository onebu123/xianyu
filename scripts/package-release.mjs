import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const currentFile = fileURLToPath(import.meta.url);
const scriptDir = path.dirname(currentFile);
const repoRoot = path.resolve(scriptDir, '..');

const rootPackage = JSON.parse(
  fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'),
);

const now = new Date();
const timestamp = [
  now.getFullYear(),
  String(now.getMonth() + 1).padStart(2, '0'),
  String(now.getDate()).padStart(2, '0'),
].join('') +
  '-' +
  [
    String(now.getHours()).padStart(2, '0'),
    String(now.getMinutes()).padStart(2, '0'),
    String(now.getSeconds()).padStart(2, '0'),
  ].join('');

const version = String(rootPackage.version || '1.0.0');
const releaseName = `sale-compass-v${version}-${timestamp}`;
const releaseRoot = path.join(repoRoot, 'output', 'releases');
const releaseDir = path.join(releaseRoot, releaseName);

const requiredBuildOutputs = [
  path.join(repoRoot, 'server', 'dist', 'server.js'),
  path.join(repoRoot, 'web', 'dist', 'index.html'),
];

const includeEntries = [
  '.env.example',
  '.env.development',
  '.env.staging',
  '.env.production',
  'Dockerfile',
  'LICENSE',
  'README.md',
  'deploy',
  'docker-compose.yml',
  'docker-compose.vps.yml',
  'docs',
  'package-lock.json',
  'package.json',
  'server',
  'static',
  'web',
];

const mustHaveDocs = [
  'docs/deployment.md',
  'docs/backup-restore-runbook.md',
  'docs/database-operations-runbook.md',
  'docs/production-observability.md',
  'docs/production-readiness-roadmap.md',
  'docs/incident-response-runbook.md',
  'docs/production-acceptance.md',
  'docs/upgrade.md',
  'docs/rollback.md',
  'docs/customer-delivery-handbook.md',
  'docs/v1-release-notes.md',
  'docs/v1-scope-freeze.md',
  'docs/v1-support-boundary.md',
  'docs/v1-acceptance-checklist.md',
  'docs/v1-pilot-run.md',
  'docs/v1-known-issues.md',
];

function ensureExists(filePath, hint) {
  if (!fs.existsSync(filePath)) {
    throw new Error(hint || `缺少文件：${filePath}`);
  }
}

function shouldExclude(relativePath) {
  const normalized = relativePath.replace(/\\/g, '/');
  const segments = normalized.split('/');
  return (
    segments.includes('node_modules') ||
    segments.includes('.git') ||
    normalized.startsWith('server/data/') ||
    normalized.startsWith('server/logs/') ||
    normalized.startsWith('output/') ||
    normalized === 'realtime.log'
  );
}

function copyEntry(sourcePath, targetPath, relativePath) {
  if (shouldExclude(relativePath)) {
    return;
  }

  const stat = fs.statSync(sourcePath);
  if (stat.isDirectory()) {
    fs.mkdirSync(targetPath, { recursive: true });
    for (const entry of fs.readdirSync(sourcePath)) {
      copyEntry(
        path.join(sourcePath, entry),
        path.join(targetPath, entry),
        path.posix.join(relativePath.replace(/\\/g, '/'), entry),
      );
    }
    return;
  }

  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.copyFileSync(sourcePath, targetPath);
}

function collectFiles(dirPath, rootPath = dirPath) {
  const rows = [];
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const absolutePath = path.join(dirPath, entry.name);
    const relativePath = path.relative(rootPath, absolutePath).replace(/\\/g, '/');
    if (entry.isDirectory()) {
      rows.push(...collectFiles(absolutePath, rootPath));
      continue;
    }
    const content = fs.readFileSync(absolutePath);
    rows.push({
      path: relativePath,
      size: content.length,
      sha256: crypto.createHash('sha256').update(content).digest('hex'),
    });
  }
  return rows.sort((left, right) => left.path.localeCompare(right.path));
}

function tryCreateArchive() {
  if (process.platform === 'win32') {
    const archivePath = `${releaseDir}.zip`;
    const command = [
      'Compress-Archive',
      '-Path',
      `'${releaseDir.replace(/'/g, "''")}\\*'`,
      '-DestinationPath',
      `'${archivePath.replace(/'/g, "''")}'`,
      '-Force',
    ].join(' ');
    const result = spawnSync('powershell', ['-NoProfile', '-Command', command], {
      cwd: repoRoot,
      stdio: 'pipe',
      encoding: 'utf8',
    });
    if (result.status === 0 && fs.existsSync(archivePath)) {
      return archivePath;
    }
    return null;
  }

  const archivePath = `${releaseDir}.tar.gz`;
  const result = spawnSync('tar', ['-czf', archivePath, '-C', releaseRoot, releaseName], {
    cwd: repoRoot,
    stdio: 'pipe',
    encoding: 'utf8',
  });
  if (result.status === 0 && fs.existsSync(archivePath)) {
    return archivePath;
  }
  return null;
}

for (const required of requiredBuildOutputs) {
  ensureExists(required, `缺少构建产物：${required}，请先执行 npm run build`);
}

for (const docPath of mustHaveDocs) {
  ensureExists(path.join(repoRoot, docPath), `缺少交付文档：${docPath}`);
}

fs.mkdirSync(releaseRoot, { recursive: true });
if (fs.existsSync(releaseDir)) {
  fs.rmSync(releaseDir, { recursive: true, force: true });
}
fs.mkdirSync(releaseDir, { recursive: true });

for (const entry of includeEntries) {
  const sourcePath = path.join(repoRoot, entry);
  ensureExists(sourcePath);
  copyEntry(sourcePath, path.join(releaseDir, entry), entry);
}

const files = collectFiles(releaseDir);
const manifest = {
  releaseName,
  version,
  generatedAt: now.toISOString(),
  packageRoot: releaseDir,
  deliveryDocs: mustHaveDocs,
  installCommand: 'npm install',
  buildCommand: 'npm run build',
  startCommand: 'npm run start',
  fileCount: files.length,
  files,
};

fs.writeFileSync(
  path.join(releaseDir, 'release-manifest.json'),
  JSON.stringify(manifest, null, 2),
  'utf8',
);

const archivePath = tryCreateArchive();

console.log(
  JSON.stringify(
    {
      ok: true,
      releaseName,
      version,
      releaseDir,
      archivePath,
      fileCount: files.length,
      manifestPath: path.join(releaseDir, 'release-manifest.json'),
    },
    null,
    2,
  ),
);
