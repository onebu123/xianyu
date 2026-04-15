import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { addDays, addMinutes, format, subDays } from 'date-fns';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { createApp } from './app.js';
import { appConfig } from './config.js';
import * as xianyuWebSessionService from './xianyu-web-session.js';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'goofish-xianyu-order-sync-'));
const dbPath = path.join(tempDir, 'test.db');

const app = await createApp({
  dbPath,
  forceReseed: true,
  runtimeMode: 'prod',
  seedDemoData: false,
  bootstrapAdmin: {
    username: 'admin',
    password: 'CompassShield@20260312!',
    displayName: 'System Admin',
  },
});

let adminToken = '';

function createRecentCompletedOrderFixture(now = new Date()) {
  const paidAt = subDays(now, 2);
  const shippedAt = addMinutes(paidAt, 3);
  const completedAt = addDays(paidAt, 1);

  return {
    tradeId: '4502105606035006506',
    paymentNo: '2026030522001406501234567890',
    itemId: '1012603042378',
    itemTitle: 'Product Alpha',
    buyerUserId: '998877665544',
    buyerName: 'Buyer A',
    paidAt: format(paidAt, 'yyyy-MM-dd HH:mm:ss'),
    shippedAt: format(shippedAt, 'yyyy-MM-dd HH:mm:ss'),
    completedAt: format(completedAt, 'yyyy-MM-dd HH:mm:ss'),
  };
}

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

function mockCompletedOrderSync(order = createRecentCompletedOrderFixture()) {
  vi.spyOn(xianyuWebSessionService, 'fetchXianyuWebSessionSellerCompletedTrades').mockResolvedValue({
    items: [
      {
        tradeId: order.tradeId,
        createdAt: order.paidAt,
        buyerName: order.buyerName,
        feedback: 'Fast delivery',
        rateTags: ['Fast delivery'],
      },
    ],
    totalCount: 1,
    pageCount: 1,
    rawRet: ['SUCCESS::OK'],
  });
  vi.spyOn(xianyuWebSessionService, 'fetchXianyuWebSessionCompletedOrderDetail').mockResolvedValue({
    orderNo: order.tradeId,
    buyerUserId: order.buyerUserId,
    buyerName: order.buyerName,
    itemId: order.itemId,
    itemTitle: order.itemTitle,
    quantity: 1,
    unitPrice: 88,
    paidAmount: 88,
    discountAmount: 0,
    refundAmount: 0,
    paymentNo: order.paymentNo,
    orderStatusName: 'Completed',
    paidAt: order.paidAt,
    shippedAt: order.shippedAt,
    completedAt: order.completedAt,
    events: [
      {
        eventType: 'xianyu_status_1',
        eventTitle: 'Order placed',
        eventDetail: 'Buyer placed the order.',
        operatorName: null,
        createdAt: order.paidAt,
      },
      {
        eventType: 'xianyu_status_2',
        eventTitle: 'Paid',
        eventDetail: 'Buyer completed payment.',
        operatorName: null,
        createdAt: order.paidAt,
      },
      {
        eventType: 'xianyu_status_3',
        eventTitle: 'Shipped',
        eventDetail: 'Seller shipped the order.',
        operatorName: null,
        createdAt: order.shippedAt,
      },
      {
        eventType: 'xianyu_status_4',
        eventTitle: 'Completed',
        eventDetail: 'Order completed successfully.',
        operatorName: null,
        createdAt: order.completedAt,
      },
    ],
    rawRet: ['SUCCESS::OK'],
  });
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

describe('xianyu order sync', () => {
  it('syncs completed trades into orders and product metrics', async () => {
    const originalMode = appConfig.storeAuthMode;
    appConfig.storeAuthMode = 'xianyu_web_session';

    try {
      const completedOrder = createRecentCompletedOrderFixture();
      const { store } = await createXianyuWebSessionStore({
        providerUserId: '2219728876568',
        providerShopId: 'xy584601422766',
        providerShopName: 'Shop 2345',
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

      mockCompletedOrderSync(completedOrder);

      const syncResponse = await app.inject({
        method: 'POST',
        url: '/api/orders/xianyu-web-sync',
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
            fetchedCount: 1,
            syncedCount: 1,
            failedTradeCount: 0,
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
      expect(String(refreshedStore.credentialRiskReason ?? '')).not.toHaveLength(0);

      const overviewResponse = await app.inject({
        method: 'GET',
        url: `/api/orders/overview?preset=last30Days&storeId=${store.id}`,
        headers: {
          authorization: `Bearer ${adminToken}`,
        },
      });
      expect(overviewResponse.statusCode).toBe(200);
      expect(overviewResponse.json()).toMatchObject({
        totalOrders: 1,
        completedOrders: 1,
        mainCompletedOrders: 1,
        salesAmount: 88,
      });

      const ordersResponse = await app.inject({
        method: 'GET',
        url: `/api/orders?preset=last30Days&storeId=${store.id}&page=1&pageSize=10`,
        headers: {
          authorization: `Bearer ${adminToken}`,
        },
      });
      expect(ordersResponse.statusCode).toBe(200);
      expect(ordersResponse.json().list).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            orderNo: '4502105606035006506',
            storeName: 'Shop 2345',
            productName: 'Product Alpha',
            customerName: 'Buyer A',
            paidAmount: 88,
            mainStatus: 'completed',
            deliveryStatus: 'delivered',
            paymentStatus: 'paid',
          }),
        ]),
      );

      const orderId = ordersResponse.json().list[0]?.id;
      expect(orderId).toBeTruthy();
      const detailResponse = await app.inject({
        method: 'GET',
        url: `/api/orders/${orderId}`,
        headers: {
          authorization: `Bearer ${adminToken}`,
        },
      });
      expect(detailResponse.statusCode).toBe(200);
      expect(detailResponse.json()).toMatchObject({
        order: expect.objectContaining({
          orderNo: '4502105606035006506',
          productName: 'Product Alpha',
          customerName: 'Buyer A',
          completedAt: completedOrder.completedAt,
        }),
        payments: [
          expect.objectContaining({
            paymentNo: '2026030522001406501234567890',
            paidAmount: 88,
          }),
        ],
      });
      expect(detailResponse.json().events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            eventType: 'xianyu_status_4',
            eventTitle: 'Completed',
          }),
        ]),
      );

      const productsResponse = await app.inject({
        method: 'GET',
        url: `/api/products?preset=last30Days&storeId=${store.id}`,
        headers: {
          authorization: `Bearer ${adminToken}`,
        },
      });
      expect(productsResponse.statusCode).toBe(200);
      expect(productsResponse.json().ranking).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: 1012603042378,
            name: 'Product Alpha',
            storeName: 'Shop 2345',
            soldQuantity: 1,
            salesAmount: 88,
            orderCount: 1,
          }),
        ]),
      );
    } finally {
      appConfig.storeAuthMode = originalMode;
    }
  });

  it('keeps repeated sync idempotent when fund settlements already reference the payment', async () => {
    const originalMode = appConfig.storeAuthMode;
    appConfig.storeAuthMode = 'xianyu_web_session';

    try {
      const completedOrder = createRecentCompletedOrderFixture();
      const { store } = await createXianyuWebSessionStore({
        providerUserId: '2219728876568',
        providerShopId: 'xy584601422766',
        providerShopName: 'Shop 2345',
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

      mockCompletedOrderSync(completedOrder);

      const firstSyncResponse = await app.inject({
        method: 'POST',
        url: '/api/orders/xianyu-web-sync',
        headers: {
          authorization: `Bearer ${adminToken}`,
        },
        payload: {
          storeIds: [store.id],
        },
      });
      expect(firstSyncResponse.statusCode).toBe(200);

      const sqlite = new Database(dbPath);
      const payment = sqlite
        .prepare(
          `
            SELECT
              op.id AS paymentId,
              op.order_id AS orderId,
              op.payment_no AS paymentNo
            FROM order_payments op
            INNER JOIN orders o ON o.id = op.order_id
            WHERE o.order_no = ?
            LIMIT 1
          `,
        )
        .get('4502105606035006506') as
        | {
            paymentId: number;
            orderId: number;
            paymentNo: string;
          }
        | undefined;
      expect(payment).toBeTruthy();

      sqlite
        .prepare(
          `
            INSERT INTO fund_settlements (
              payment_id,
              order_id,
              store_id,
              settlement_no,
              order_no,
              payment_no,
              gross_amount,
              received_amount,
              fee_amount,
              settled_amount,
              settlement_status,
              settled_at,
              note,
              updated_at
            ) VALUES (
              @paymentId,
              @orderId,
              @storeId,
              @settlementNo,
              @orderNo,
              @paymentNo,
              @grossAmount,
              @receivedAmount,
              @feeAmount,
              @settledAmount,
              @settlementStatus,
              @settledAt,
              @note,
              @updatedAt
            )
          `,
        )
        .run({
          paymentId: payment!.paymentId,
          orderId: payment!.orderId,
          storeId: store.id,
          settlementNo: `JS${String(payment!.paymentId).padStart(6, '0')}567890`,
          orderNo: '4502105606035006506',
          paymentNo: payment!.paymentNo,
          grossAmount: 88,
          receivedAmount: 88,
          feeAmount: 0,
          settledAmount: 88,
          settlementStatus: 'settled',
          settledAt: completedOrder.completedAt,
          note: 'Regression settlement reference',
          updatedAt: completedOrder.completedAt,
        });

      const secondSyncResponse = await app.inject({
        method: 'POST',
        url: '/api/orders/xianyu-web-sync',
        headers: {
          authorization: `Bearer ${adminToken}`,
        },
        payload: {
          storeIds: [store.id],
        },
      });
      expect(secondSyncResponse.statusCode).toBe(200);
      expect(secondSyncResponse.json()).toMatchObject({
        successCount: 1,
        totalCount: 1,
        results: [
          expect.objectContaining({
            storeId: store.id,
            success: true,
            syncedCount: 1,
          }),
        ],
      });

      const paymentAfterResync = sqlite
        .prepare(
          `
            SELECT
              id,
              payment_no AS paymentNo
            FROM order_payments
            WHERE order_id = ?
            ORDER BY id ASC
          `,
        )
        .all(payment!.orderId) as Array<{ id: number; paymentNo: string }>;
      const settlementAfterResync = sqlite
        .prepare(
          `
            SELECT
              payment_id AS paymentId,
              payment_no AS paymentNo
            FROM fund_settlements
            WHERE order_id = ?
          `,
        )
        .get(payment!.orderId) as { paymentId: number; paymentNo: string } | undefined;
      sqlite.close();

      expect(paymentAfterResync).toHaveLength(1);
      expect(paymentAfterResync[0]).toMatchObject({
        id: payment!.paymentId,
        paymentNo: '2026030522001406501234567890',
      });
      expect(settlementAfterResync).toMatchObject({
        paymentId: payment!.paymentId,
        paymentNo: '2026030522001406501234567890',
      });
    } finally {
      appConfig.storeAuthMode = originalMode;
    }
  });
});
