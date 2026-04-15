import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { createApp } from './app.js';
import { appConfig } from './config.js';
import * as xianyuWebSessionService from './xianyu-web-session.js';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'goofish-xianyu-product-sync-'));
const dbPath = path.join(tempDir, 'test.db');

const app = await createApp({
  dbPath,
  forceReseed: true,
  runtimeMode: 'prod',
  seedDemoData: false,
  bootstrapAdmin: {
    username: 'admin',
    password: 'CompassShield@20260312!',
    displayName: '系统管理员',
  },
});

let adminToken = '';

async function createXianyuWebSessionStore(input: {
  providerUserId: string;
  providerShopId: string;
  providerShopName: string;
  mobile: string;
  cookieText?: string;
}) {
  const sessionResponse = await app.inject({
    method: 'POST',
    url: '/api/stores/auth-sessions',
    headers: {
      authorization: `Bearer ${adminToken}`,
    },
    payload: {
      platform: 'xianyu',
      source: 'shop',
      authType: 11,
    },
  });
  expect(sessionResponse.statusCode).toBe(200);
  const session = sessionResponse.json();

  const syncResponse = await app.inject({
    method: 'POST',
    url: `/api/stores/auth-sessions/${session.sessionId}/web-session-sync`,
    headers: {
      authorization: `Bearer ${adminToken}`,
    },
    payload: {
      cookieText:
        input.cookieText ?? 'cna=test-cookie; unb=test-unb; _m_h5_tk=test-token_123; cookie2=abc;',
      providerUserId: input.providerUserId,
      providerShopId: input.providerShopId,
      providerShopName: input.providerShopName,
      mobile: input.mobile,
      nickname: input.providerShopName,
      scopeText: 'item.read,item.write',
    },
  });
  expect(syncResponse.statusCode).toBe(200);

  const managementResponse = await app.inject({
    method: 'GET',
    url: '/api/stores/management',
    headers: {
      authorization: `Bearer ${adminToken}`,
    },
  });
  expect(managementResponse.statusCode).toBe(200);
  const store = managementResponse
    .json()
    .stores.find((item: { providerStoreId: string | null }) => item.providerStoreId === input.providerShopId);
  expect(store).toBeTruthy();

  return {
    session,
    store,
  };
}

beforeAll(async () => {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: {
      username: 'admin',
      password: 'CompassShield@20260312!',
    },
  });
  adminToken = response.json().token;
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await app.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('闲鱼真实商品同步', () => {
  it('支持把已激活网页登录态店铺的真实商品同步到商品工作台', async () => {
    const originalMode = appConfig.storeAuthMode;
    appConfig.storeAuthMode = 'xianyu_web_session';

    try {
      const { store } = await createXianyuWebSessionStore({
        providerUserId: '2219728876568',
        providerShopId: 'xy584601422766',
        providerShopName: '小布2345',
        mobile: '13900000000',
      });

      const activateResponse = await app.inject({
        method: 'POST',
        url: `/api/stores/${store.id}/activate`,
        headers: {
          authorization: `Bearer ${adminToken}`,
        },
      });
      expect(activateResponse.statusCode).toBe(200);

      vi.spyOn(xianyuWebSessionService, 'fetchXianyuWebSessionProducts').mockResolvedValue({
        items: [
          {
            id: '1015114876464',
            title: '一年plus会员',
            categoryId: '50025461',
            categoryLabel: '类目#50025461',
            price: 350,
            soldPrice: 350,
            itemStatus: 1,
            itemStatusText: '已售出',
            stock: 0,
            coverUrl: null,
            detailUrl: null,
          },
          {
            id: '1014188796648',
            title: '补差价',
            categoryId: '50023914',
            categoryLabel: '类目#50023914',
            price: 253,
            soldPrice: 253,
            itemStatus: 1,
            itemStatusText: '已售出',
            stock: 0,
            coverUrl: null,
            detailUrl: null,
          },
        ],
        totalCount: 2,
        pageCount: 1,
        rawRet: ['SUCCESS::调用成功'],
      });

      const syncResponse = await app.inject({
        method: 'POST',
        url: '/api/products/xianyu-web-sync',
        headers: {
          authorization: `Bearer ${adminToken}`,
        },
        payload: {
          storeIds: [store.id],
        },
      });
      expect(syncResponse.statusCode).toBe(200);
      expect(syncResponse.json()).toMatchObject({
        successCount: 1,
        totalCount: 1,
        results: [
          {
            storeId: store.id,
            success: true,
            fetchedCount: 2,
            syncedCount: 2,
          },
        ],
      });

      const managementAfterSyncResponse = await app.inject({
        method: 'GET',
        url: '/api/stores/management',
        headers: {
          authorization: `Bearer ${adminToken}`,
        },
      });
      expect(managementAfterSyncResponse.statusCode).toBe(200);
      const refreshedStore = managementAfterSyncResponse
        .json()
        .stores.find((item: { id: number }) => item.id === store.id);
      expect(refreshedStore).toBeTruthy();
      expect(refreshedStore.connectionStatus).toBe('active');
      expect(refreshedStore.authStatus).toBe('authorized');
      expect(refreshedStore.healthStatus).toBe('healthy');
      expect(refreshedStore.credentialRiskLevel).toBe('healthy');
      expect(refreshedStore.credentialRiskReason).toContain('真实商品同步成功');

      const optionsResponse = await app.inject({
        method: 'GET',
        url: '/api/options',
        headers: {
          authorization: `Bearer ${adminToken}`,
        },
      });
      expect(optionsResponse.statusCode).toBe(200);
      expect(optionsResponse.json().stores).toContainEqual({
        value: store.id,
        label: '小布2345',
      });

      const productsResponse = await app.inject({
        method: 'GET',
        url: `/api/products?preset=last30Days&storeId=${store.id}`,
        headers: {
          authorization: `Bearer ${adminToken}`,
        },
      });
      expect(productsResponse.statusCode).toBe(200);
      expect(productsResponse.json().summary.totalProducts).toBe(2);
      expect(productsResponse.json().ranking).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: 1015114876464,
            name: '一年plus会员',
            storeName: '小布2345',
            stock: 0,
            soldQuantity: 0,
            orderCount: 0,
          }),
          expect.objectContaining({
            id: 1014188796648,
            name: '补差价',
            storeName: '小布2345',
            stock: 0,
            soldQuantity: 0,
            orderCount: 0,
          }),
        ]),
      );
    } finally {
      appConfig.storeAuthMode = originalMode;
    }
  });
});
