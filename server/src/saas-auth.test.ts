import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { createApp } from './app.js';

async function createSaasTestContext() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sale-compass-saas-'));
  const businessDbPath = path.join(tempRoot, 'private.db');
  const controlPlaneDbPath = path.join(tempRoot, 'control-plane.db');
  const tenantDatabaseRoot = path.join(tempRoot, 'tenants');
  const app = await createApp({
    dbPath: businessDbPath,
    controlPlaneDbPath,
    tenantDatabaseRoot,
    deploymentMode: 'saas',
    forceReseed: true,
    runtimeMode: 'demo',
    seedDemoData: true,
    bootstrapAdmin: {
      username: 'admin',
      password: 'Admin@123456',
      displayName: '平台管理员',
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
    platformToken: loginResponse.json().token as string,
    async cleanup() {
      await app.close();
      fs.rmSync(tempRoot, { recursive: true, force: true });
    },
  };
}

describe('SaaS 控制面与租户化认证', () => {
  it('平台登录返回可访问租户列表', async () => {
    const ctx = await createSaasTestContext();
    try {
      const response = await ctx.app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: {
          username: 'admin',
          password: 'Admin@123456',
        },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json().scope).toBe('platform');
      expect(response.json().nextStep).toBe('select_tenant');
      expect(response.json().memberships.length).toBeGreaterThan(0);
    } finally {
      await ctx.cleanup();
    }
  }, 20_000);

  it('平台会话不能直接访问租户业务接口', async () => {
    const ctx = await createSaasTestContext();
    try {
      const response = await ctx.app.inject({
        method: 'GET',
        url: '/api/dashboard?preset=last30Days',
        headers: {
          authorization: `Bearer ${ctx.platformToken}`,
        },
      });

      expect(response.statusCode).toBe(403);
    } finally {
      await ctx.cleanup();
    }
  }, 20_000);

  it('平台管理员可以创建租户并查看开通任务', async () => {
    const ctx = await createSaasTestContext();
    try {
      const createResponse = await ctx.app.inject({
        method: 'POST',
        url: '/api/platform/tenants',
        headers: {
          authorization: `Bearer ${ctx.platformToken}`,
        },
        payload: {
          tenantKey: 'acme',
          tenantName: 'Acme Corp',
        },
      });

      expect(createResponse.statusCode).toBe(200);
      expect(createResponse.json().tenant.status).toBe('active');
      expect(createResponse.json().provisioningJob.status).toBe('succeeded');

      const jobsResponse = await ctx.app.inject({
        method: 'GET',
        url: '/api/platform/provisioning-jobs',
        headers: {
          authorization: `Bearer ${ctx.platformToken}`,
        },
      });

      expect(jobsResponse.statusCode).toBe(200);
      expect(jobsResponse.json().list.length).toBeGreaterThan(0);
    } finally {
      await ctx.cleanup();
    }
  }, 20_000);

  it('选择租户后签发租户作用域会话，并拒绝访问平台接口', async () => {
    const ctx = await createSaasTestContext();
    try {
      const createResponse = await ctx.app.inject({
        method: 'POST',
        url: '/api/platform/tenants',
        headers: {
          authorization: `Bearer ${ctx.platformToken}`,
        },
        payload: {
          tenantKey: 'globex',
          tenantName: 'Globex',
        },
      });
      expect(createResponse.statusCode).toBe(200);

      const tenantId = createResponse.json().tenant.id;
      const selectResponse = await ctx.app.inject({
        method: 'POST',
        url: '/api/auth/select-tenant',
        headers: {
          authorization: `Bearer ${ctx.platformToken}`,
        },
        payload: {
          tenantId,
        },
      });

      expect(selectResponse.statusCode).toBe(200);
      expect(selectResponse.json().scope).toBe('tenant');
      expect(selectResponse.json().tenant.id).toBe(tenantId);
      expect(selectResponse.json().membership.systemRole).toBe('admin');

      const tenantToken = selectResponse.json().token;
      const dashboardResponse = await ctx.app.inject({
        method: 'GET',
        url: '/api/dashboard?preset=last30Days',
        headers: {
          authorization: `Bearer ${tenantToken}`,
        },
      });

      expect(dashboardResponse.statusCode).toBe(200);

      const platformRouteResponse = await ctx.app.inject({
        method: 'GET',
        url: '/api/platform/tenants',
        headers: {
          authorization: `Bearer ${tenantToken}`,
        },
      });

      expect(platformRouteResponse.statusCode).toBe(403);
    } finally {
      await ctx.cleanup();
    }
  }, 20_000);

  it('平台管理员可以查看平台账号列表，租户会话也能切换到其他租户', async () => {
    const ctx = await createSaasTestContext();
    try {
      const usersResponse = await ctx.app.inject({
        method: 'GET',
        url: '/api/platform/users',
        headers: {
          authorization: `Bearer ${ctx.platformToken}`,
        },
      });

      expect(usersResponse.statusCode).toBe(200);
      expect(usersResponse.json().list.length).toBeGreaterThan(0);

      const firstCreateResponse = await ctx.app.inject({
        method: 'POST',
        url: '/api/platform/tenants',
        headers: {
          authorization: `Bearer ${ctx.platformToken}`,
        },
        payload: {
          tenantKey: 'initech',
          tenantName: 'Initech',
        },
      });
      expect(firstCreateResponse.statusCode).toBe(200);

      const firstTenantResponse = await ctx.app.inject({
        method: 'POST',
        url: '/api/auth/select-tenant',
        headers: {
          authorization: `Bearer ${ctx.platformToken}`,
        },
        payload: {
          tenantId: firstCreateResponse.json().tenant.id,
        },
      });
      expect(firstTenantResponse.statusCode).toBe(200);

      const secondCreateResponse = await ctx.app.inject({
        method: 'POST',
        url: '/api/platform/tenants',
        headers: {
          authorization: `Bearer ${ctx.platformToken}`,
        },
        payload: {
          tenantKey: 'umbrella',
          tenantName: 'Umbrella',
        },
      });
      expect(secondCreateResponse.statusCode).toBe(200);

      const switchTenantResponse = await ctx.app.inject({
        method: 'POST',
        url: '/api/auth/select-tenant',
        headers: {
          authorization: `Bearer ${firstTenantResponse.json().token}`,
        },
        payload: {
          tenantId: secondCreateResponse.json().tenant.id,
        },
      });

      expect(switchTenantResponse.statusCode).toBe(200);
      expect(switchTenantResponse.json().scope).toBe('tenant');
      expect(switchTenantResponse.json().tenant.id).toBe(secondCreateResponse.json().tenant.id);
    } finally {
      await ctx.cleanup();
    }
  }, 20_000);
});
