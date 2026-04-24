// @ts-nocheck
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from './app.js';
import { appConfig } from './config.js';
import { StatisticsDatabase } from './database.js';
import { createFulfillmentQueueBackend } from './fulfillment-queue-backend.js';
import { createFulfillmentRuntime } from './fulfillment-runtime.js';

process.env.APP_FULFILLMENT_WORKER_BATCH_SIZE = '200';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'goofish-fulfillment-worker-'));
const dbPath = path.join(tempDir, 'worker.db');

const app = await createApp({
  dbPath,
  forceReseed: true,
  runtimeMode: 'demo',
  seedDemoData: true,
  backgroundJobsMode: 'worker',
});

const runtimeDb = new StatisticsDatabase(dbPath);
runtimeDb.initialize({
  runtimeMode: 'production',
  seedDemoData: false,
});

const runtime = createFulfillmentRuntime({
  config: {
    ...appConfig,
    dbPath,
    deploymentMode: 'private',
    runtimeMode: 'production',
    backgroundJobsMode: 'worker',
  },
  db: runtimeDb,
  logger: {
    info() {},
    warn() {},
    error() {},
  },
  queueBackend: createFulfillmentQueueBackend({
    config: {
      ...appConfig,
      dbPath,
      deploymentMode: 'private',
      runtimeMode: 'production',
      backgroundJobsMode: 'worker',
    },
    db: runtimeDb,
    logger: {
      info() {},
      warn() {},
      error() {},
    },
  }),
});

let adminToken = '';

beforeAll(async () => {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: {
      username: 'admin',
      password: 'Admin@123456',
    },
  });
  adminToken = response.json().token;
});

afterAll(async () => {
  await app.close();
  runtimeDb.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('履约 Worker 队列', () => {
  it('卡密发货在 worker 模式下先入队，再由运行时消费完成', async () => {
    const deliveryDetailResponse = await app.inject({
      method: 'GET',
      url: '/api/workspaces/card-delivery/detail',
      headers: {
        authorization: `Bearer ${adminToken}`,
      },
    });
    expect(deliveryDetailResponse.statusCode).toBe(200);
    const pendingJob = deliveryDetailResponse
      .json()
      .jobs.find((job) => job.jobStatus === 'pending' && job.cardTypeName === '王者点券直充');
    expect(pendingJob).toBeTruthy();

    const queueResponse = await app.inject({
      method: 'POST',
      url: `/api/workspaces/card-delivery/orders/${pendingJob.orderId}/fulfill`,
      headers: {
        authorization: `Bearer ${adminToken}`,
      },
    });
    expect(queueResponse.statusCode).toBe(200);
    expect(queueResponse.json()).toMatchObject({
      success: true,
      accepted: true,
      queued: true,
      jobStatus: 'pending',
    });

    let delivered = false;
    let processedCardJobs = 0;
    for (let round = 0; round < 5; round += 1) {
      const cycleResult = await runtime.runPendingQueueCycle();
      processedCardJobs += cycleResult.processedCardJobs;

      const orderDetailResponse = await app.inject({
        method: 'GET',
        url: `/api/orders/${pendingJob.orderId}`,
        headers: {
          authorization: `Bearer ${adminToken}`,
        },
      });
      expect(orderDetailResponse.statusCode).toBe(200);
      if (orderDetailResponse.json().order.deliveryStatus === 'delivered') {
        delivered = true;
        break;
      }
    }

    expect(processedCardJobs).toBeGreaterThan(0);
    expect(delivered).toBe(true);
  });

  it('直充发货在 worker 模式下先入队，再由运行时消费为处理中', async () => {
    const supplyDetailResponse = await app.inject({
      method: 'GET',
      url: '/api/workspaces/distribution-supply/detail',
      headers: {
        authorization: `Bearer ${adminToken}`,
      },
    });
    expect(supplyDetailResponse.statusCode).toBe(200);
    const pendingJob = supplyDetailResponse
      .json()
      .jobs.find((job) => ['pending_dispatch', 'failed', 'manual_review'].includes(job.taskStatus));
    expect(pendingJob).toBeTruthy();
    const queueAction = pendingJob.taskStatus === 'pending_dispatch' ? 'dispatch' : 'retry';

    const queueResponse = await app.inject({
      method: 'POST',
      url: `/api/workspaces/distribution-supply/direct-charge-jobs/${pendingJob.id}/${queueAction}`,
      headers: {
        authorization: `Bearer ${adminToken}`,
      },
    });
    expect(queueResponse.statusCode).toBe(200);
    expect(queueResponse.json()).toMatchObject({
      success: true,
      accepted: true,
      queued: true,
      taskStatus: 'pending_dispatch',
    });

    const cycleResult = await runtime.runPendingQueueCycle();
    expect(cycleResult.processedDirectChargeJobs).toBeGreaterThan(0);

    const refreshedSupplyResponse = await app.inject({
      method: 'GET',
      url: '/api/workspaces/distribution-supply/detail',
      headers: {
        authorization: `Bearer ${adminToken}`,
      },
    });
    expect(refreshedSupplyResponse.statusCode).toBe(200);
    const refreshedJob = refreshedSupplyResponse
      .json()
      .jobs.find((job) => job.id === pendingJob.id);
    expect(refreshedJob.taskStatus).not.toBe('pending_dispatch');
  });

  it('直充人工接管在 worker 模式下先入队，再由运行时转人工处理', async () => {
    const supplyDetailResponse = await app.inject({
      method: 'GET',
      url: '/api/workspaces/distribution-supply/detail',
      headers: {
        authorization: `Bearer ${adminToken}`,
      },
    });
    expect(supplyDetailResponse.statusCode).toBe(200);
    const targetJob = supplyDetailResponse
      .json()
      .jobs.find((job) => job.taskStatus !== 'success');
    expect(targetJob).toBeTruthy();

    const manualReason = '需要人工核对充值结果';
    const queueResponse = await app.inject({
      method: 'POST',
      url: `/api/workspaces/distribution-supply/direct-charge-jobs/${targetJob.id}/manual-review`,
      headers: {
        authorization: `Bearer ${adminToken}`,
      },
      payload: {
        reason: manualReason,
      },
    });
    expect(queueResponse.statusCode).toBe(200);
    expect(queueResponse.json()).toMatchObject({
      success: true,
      accepted: true,
      queued: true,
      taskStatus: 'manual_review_pending',
      reason: manualReason,
    });

    const cycleResult = await runtime.runPendingQueueCycle();
    expect(cycleResult.processedDirectChargeJobs).toBeGreaterThan(0);

    const refreshedSupplyResponse = await app.inject({
      method: 'GET',
      url: '/api/workspaces/distribution-supply/detail',
      headers: {
        authorization: `Bearer ${adminToken}`,
      },
    });
    expect(refreshedSupplyResponse.statusCode).toBe(200);
    const refreshedJob = refreshedSupplyResponse
      .json()
      .jobs.find((job) => job.id === targetJob.id);
    expect(refreshedJob.taskStatus).toBe('manual_review');
    expect(refreshedJob.manualReason).toBe(manualReason);
  });
});
