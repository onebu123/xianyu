import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, describe, expect, it } from 'vitest';

import { createApp } from './app.js';
import { CURRENT_SCHEMA_VERSION, inspectSqliteDatabase, runSqliteDoctor } from './db-ops.js';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sale-compass-dbops-'));
const dbPath = path.join(tempDir, 'doctor.db');

const app = await createApp({
  dbPath,
  forceReseed: true,
  runtimeMode: 'demo',
  seedDemoData: true,
});

afterAll(async () => {
  await app.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('数据库运维诊断', () => {
  it('数据库巡检可以返回核心元数据', () => {
    const inspection = inspectSqliteDatabase({ dbPath });

    expect(inspection.exists).toBe(true);
    expect(inspection.userVersion).toBeGreaterThanOrEqual(CURRENT_SCHEMA_VERSION);
    expect(inspection.tableCount).toBeGreaterThan(10);
    expect(inspection.counts.orders).toBeGreaterThan(0);
    expect(inspection.tables.some((table) => table.name === 'orders')).toBe(true);
  });

  it('数据库诊断通过时会返回 pass 或 warn', () => {
    const result = runSqliteDoctor({ dbPath });

    expect(result.ok).toBe(true);
    expect(['pass', 'warn']).toContain(result.status);
    expect(result.checks.some((check) => check.name === 'required_columns')).toBe(true);
  });
});
