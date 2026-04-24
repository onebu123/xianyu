import { createHmac } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { createApp } from './app.js';

async function createPrivateTestContext() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sale-compass-open-platform-'));
  const dbPath = path.join(tempRoot, 'private.db');
  const app = await createApp({
    dbPath,
    forceReseed: true,
    deploymentMode: 'private',
    runtimeMode: 'demo',
    seedDemoData: true,
    bootstrapAdmin: {
      username: 'admin',
      password: 'Admin@123456',
      displayName: '系统管理员',
    },
  });

  const loginResponse = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: {
      username: 'admin',
      password: 'Admin@123456',
    },
  });
  expect(loginResponse.statusCode).toBe(200);

  return {
    app,
    token: loginResponse.json().token as string,
    async cleanup() {
      await app.close();
      fs.rmSync(tempRoot, { recursive: true, force: true });
    },
  };
}

describe('开放平台', () => {
  it('支持创建应用、轮换密钥、配置白名单并完成签名公开调用', async () => {
    const ctx = await createPrivateTestContext();
    try {
      const headers = {
        authorization: `Bearer ${ctx.token}`,
      };

      const createResponse = await ctx.app.inject({
        method: 'POST',
        url: '/api/open-platform/apps',
        headers,
        payload: {
          appName: 'ERP 联调',
          ownerName: '运营中台',
          contactName: 'ops@example.com',
          callbackUrl: 'https://erp.example.com/webhook',
          scopes: ['dashboard.read', 'orders.read'],
          rateLimitPerMinute: 180,
        },
      });
      expect(createResponse.statusCode).toBe(200);
      expect(createResponse.json().appKey).toBeTruthy();
      expect(createResponse.json().secretPlainText).toBeTruthy();

      const appKey = createResponse.json().appKey as string;
      let secret = createResponse.json().secretPlainText as string;

      const rotateResponse = await ctx.app.inject({
        method: 'POST',
        url: `/api/open-platform/apps/${createResponse.json().id}/secret/rotate`,
        headers,
        payload: {},
      });
      expect(rotateResponse.statusCode).toBe(200);
      secret = rotateResponse.json().secretPlainText as string;

      const statusResponse = await ctx.app.inject({
        method: 'POST',
        url: `/api/open-platform/apps/${createResponse.json().id}/status`,
        headers,
        payload: {
          status: 'active',
        },
      });
      expect(statusResponse.statusCode).toBe(200);

      const settingsResponse = await ctx.app.inject({
        method: 'POST',
        url: '/api/open-platform/settings',
        headers,
        payload: {
          webhookBaseUrl: 'https://open.example.com',
          notifyEmail: 'ops@example.com',
          publishedVersion: 'v2',
          defaultRateLimitPerMinute: 180,
          signatureTtlSeconds: 300,
          whitelistEnforced: true,
        },
      });
      expect(settingsResponse.statusCode).toBe(200);
      expect(settingsResponse.json().settings.publishedVersion).toBe('v2');

      const ruleResponse = await ctx.app.inject({
        method: 'POST',
        url: '/api/open-platform/whitelist',
        headers,
        payload: {
          ruleType: 'ip',
          ruleValue: '127.0.0.1',
          description: '本机联调',
          enabled: true,
        },
      });
      expect(ruleResponse.statusCode).toBe(200);

      const routePath = '/api/public/open-platform/private/dashboard/summary';
      const timestamp = String(Date.now());
      const signature = createHmac('sha256', secret)
        .update(`${appKey}.${timestamp}.GET.${routePath}`)
        .digest('hex');

      const publicResponse = await ctx.app.inject({
        method: 'GET',
        url: `${routePath}?preset=last30Days`,
        headers: {
          'x-open-app-key': appKey,
          'x-open-timestamp': timestamp,
          'x-open-signature': signature,
          'x-forwarded-for': '127.0.0.1',
        },
      });
      expect(publicResponse.statusCode).toBe(200);
      expect(publicResponse.json().summary).toBeTruthy();

      const invalidSignatureResponse = await ctx.app.inject({
        method: 'GET',
        url: '/api/public/open-platform/private/orders/overview',
        headers: {
          'x-open-app-key': appKey,
          'x-open-timestamp': String(Date.now()),
          'x-open-signature': 'invalid-signature',
          'x-forwarded-for': '127.0.0.1',
        },
      });
      expect(invalidSignatureResponse.statusCode).toBe(403);
    } finally {
      await ctx.cleanup();
    }
  }, 20_000);
});
