// @ts-nocheck
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from './app.js';
import { hashPassword } from './auth.js';
import { appConfig } from './config.js';
import * as xianyuWebSessionService from './xianyu-web-session.js';
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'goofish-stats-'));
const dbPath = path.join(tempDir, 'test.db');
const app = await createApp({
    dbPath,
    forceReseed: true,
    runtimeMode: 'demo',
    seedDemoData: true,
});
function buildMetricsRequestHeaders(adminAccessToken) {
    if (appConfig.metricsToken) {
        return {
            'x-metrics-token': appConfig.metricsToken,
        };
    }
    return {
        authorization: `Bearer ${adminAccessToken}`,
    };
}
async function withStoreAuthMode(mode, runner) {
    const originalMode = appConfig.storeAuthMode;
    appConfig.storeAuthMode = mode;
    try {
        return await runner();
    }
    finally {
        appConfig.storeAuthMode = originalMode;
    }
}
it('过期的网页登录态授权会话在重新生成二维码后仍可接收扫码登录态', async () => {
    const originalMode = appConfig.storeAuthMode;
    appConfig.storeAuthMode = 'xianyu_web_session';
    vi.spyOn(xianyuWebSessionService.xianyuQrLoginManager, 'create').mockResolvedValue({
        qrLoginId: 'qr-login-expired',
        authSessionId: 'ignored',
        status: 'waiting',
        qrCodeUrl: 'data:image/png;base64,qr',
        createdAt: '2026-03-13 10:00:00',
        expiresAt: '2026-03-13 10:05:00',
        lastPolledAt: null,
        verificationUrl: null,
        hasCookies: false,
        cookieMasked: null,
        failureReason: null,
    });
    vi.spyOn(xianyuWebSessionService.xianyuQrLoginManager, 'consumeSuccessCookies').mockReturnValue({
        qrLoginId: 'qr-login-expired',
        authSessionId: 'ignored',
        cookieText: 'cna=qr-expired; unb=qr-expired-unb; _m_h5_tk=qr-expired-token_123; cookie2=qr-expired-cookie2;',
        unb: 'qr-expired-unb',
        source: 'qr_login',
    });
    vi.spyOn(xianyuWebSessionService, 'verifyXianyuWebSessionCookie').mockResolvedValue({
        riskLevel: 'healthy',
        detail: '扫码登录态可用。',
        verificationUrl: null,
        refreshedCookieText: null,
        rawRet: ['SUCCESS::调用成功'],
    });
    try {
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
        const sqlite = new Database(dbPath);
        try {
            sqlite
                .prepare(`
              UPDATE store_auth_sessions
              SET expires_at = datetime('now', 'localtime', '-1 minute')
              WHERE session_id = ?
            `)
                .run(session.sessionId);
        }
        finally {
            sqlite.close();
        }
        const generateResponse = await app.inject({
            method: 'POST',
            url: `/api/stores/auth-sessions/${session.sessionId}/qr-login/generate`,
            headers: {
                authorization: `Bearer ${adminToken}`,
            },
        });
        expect(generateResponse.statusCode).toBe(200);
        expect(generateResponse.json().qrLoginId).toBe('qr-login-expired');
        const acceptResponse = await app.inject({
            method: 'POST',
            url: `/api/stores/auth-sessions/${session.sessionId}/qr-login/accept`,
            headers: {
                authorization: `Bearer ${adminToken}`,
            },
        });
        expect(acceptResponse.statusCode).toBe(200);
        expect(acceptResponse.json().nextStep).toBe('sync_profile');
        const detailResponse = await app.inject({
            method: 'GET',
            url: `/api/stores/auth-sessions/${session.sessionId}`,
            headers: {
                authorization: `Bearer ${adminToken}`,
            },
        });
        expect(detailResponse.statusCode).toBe(200);
        expect(detailResponse.json().status).toBe('pending');
        expect(detailResponse.json().tokenReceived).toBe(true);
        expect(detailResponse.json().nextStepKey).toBe('sync_profile');
        expect(detailResponse.json().invalidReason).toBeFalsy();
    }
    finally {
        appConfig.storeAuthMode = originalMode;
    }
});
/*
  it('凭据时间线会返回手动录入、校验、人工接管和续登事件', async () => {
    const originalMode = appConfig.storeAuthMode;
    appConfig.storeAuthMode = 'xianyu_web_session';

    try {
      const { store } = await createXianyuWebSessionStore({
        providerUserId: 'xy-user-timeline-1001',
        providerShopId: 'xy-shop-timeline-2001',
        providerShopName: '凭据时间线店铺',
        mobile: '139****1003',
      });

      vi.spyOn(xianyuWebSessionService, 'verifyXianyuWebSessionCookie')
        .mockResolvedValueOnce({
          riskLevel: 'warning',
          detail: '命中风控，需要人工接管。',
          verificationUrl: 'https://verify.goofish.com/timeline-risk',
          refreshedCookieText:
            'cna=timeline-risk; unb=timeline-unb; _m_h5_tk=timeline-token_123; cookie2=timeline-cookie2;',
          rawRet: ['FAIL_SYS_USER_VALIDATE::timeline risk'],
        })
        .mockResolvedValueOnce({
          riskLevel: 'healthy',
          detail: '续登后的 Cookie 校验通过。',
          verificationUrl: null,
          refreshedCookieText: null,
          rawRet: ['SUCCESS::timeline healthy'],
        });
      vi.spyOn(xianyuWebSessionService, 'renewXianyuWebSessionCookieViaBrowser').mockResolvedValue({
        renewed: true,
        cookieText:
          'cna=timeline-renewed; unb=timeline-renew-unb; _m_h5_tk=timeline-renew-token_123; cookie2=timeline-renew-cookie2;',
        currentUrl: 'https://www.goofish.com/im',
        pageTitle: '闲鱼消息',
        verificationUrl: null,
        detail: '浏览器续登成功。',
      });

      const verifyResponse = await app.inject({
        method: 'POST',
        url: `/api/stores/${store.id}/credential-verify`,
        headers: {
          authorization: `Bearer ${adminToken}`,
        },
      });
      expect(verifyResponse.statusCode).toBe(200);

      const renewResponse = await app.inject({
        method: 'POST',
        url: `/api/stores/${store.id}/browser-renew`,
        headers: {
          authorization: `Bearer ${adminToken}`,
        },
        payload: {
          showBrowser: false,
        },
      });
      expect(renewResponse.statusCode).toBe(200);

      const eventsResponse = await app.inject({
        method: 'GET',
        url: `/api/stores/${store.id}/credential-events`,
        headers: {
          authorization: `Bearer ${adminToken}`,
        },
      });
      expect(eventsResponse.statusCode).toBe(200);
      expect(eventsResponse.json().storeId).toBe(store.id);

      const eventTypes = eventsResponse.json().events.map((item: { eventType: string }) => item.eventType);
      expect(eventTypes).toContain('credential_captured');
      expect(eventTypes).toContain('profile_synced');
      expect(eventTypes).toContain('credential_verified');
      expect(eventTypes).toContain('manual_takeover_required');
      expect(eventTypes).toContain('browser_renewed');

      const warningEvent = eventsResponse.json().events.find(
        (item: { eventType: string }) => item.eventType === 'manual_takeover_required',
      );
      expect(warningEvent).toBeTruthy();
      expect(warningEvent.verificationUrl).toBe('https://verify.goofish.com/timeline-risk');
    } finally {
      appConfig.storeAuthMode = originalMode;
    }
  });
*/
/*
  it('网页登录态接入支持扫码登录收票并进入待绑店阶段', async () => {
    const originalMode = appConfig.storeAuthMode;
    appConfig.storeAuthMode = 'xianyu_web_session';

    vi.spyOn(xianyuWebSessionService.xianyuQrLoginManager, 'create').mockResolvedValue({
      qrLoginId: 'qr-login-1',
      authSessionId: 'ignored',
      status: 'waiting',
      qrCodeUrl: 'data:image/png;base64,qr',
      createdAt: '2026-03-13 10:00:00',
      expiresAt: '2026-03-13 10:05:00',
      lastPolledAt: null,
      verificationUrl: null,
      hasCookies: false,
      cookieMasked: null,
      failureReason: null,
    });
    vi.spyOn(xianyuWebSessionService.xianyuQrLoginManager, 'getByAuthSessionId').mockReturnValue({
      qrLoginId: 'qr-login-1',
      authSessionId: 'ignored',
      status: 'success',
      qrCodeUrl: 'data:image/png;base64,qr',
      createdAt: '2026-03-13 10:00:00',
      expiresAt: '2026-03-13 10:05:00',
      lastPolledAt: '2026-03-13 10:00:10',
      verificationUrl: null,
      hasCookies: true,
      cookieMasked: 'tes***123',
      failureReason: null,
    });
    vi.spyOn(xianyuWebSessionService.xianyuQrLoginManager, 'consumeSuccessCookies').mockReturnValue({
      qrLoginId: 'qr-login-1',
      authSessionId: 'ignored',
      cookieText: 'cna=qr-cookie; unb=qr-unb; _m_h5_tk=qr-token_123; cookie2=qr-cookie2;',
      unb: 'qr-unb',
      source: 'qr_login',
    });
    vi.spyOn(xianyuWebSessionService, 'verifyXianyuWebSessionCookie').mockResolvedValue({
      riskLevel: 'healthy',
      detail: '扫码登录态可用。',
      verificationUrl: null,
      refreshedCookieText: null,
      rawRet: ['SUCCESS::调用成功'],
    });

    try {
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

      const generateResponse = await app.inject({
        method: 'POST',
        url: `/api/stores/auth-sessions/${session.sessionId}/qr-login/generate`,
        headers: {
          authorization: `Bearer ${adminToken}`,
        },
      });
      expect(generateResponse.statusCode).toBe(200);
      expect(generateResponse.json().qrLoginId).toBe('qr-login-1');

      const statusResponse = await app.inject({
        method: 'GET',
        url: `/api/stores/auth-sessions/${session.sessionId}/qr-login`,
        headers: {
          authorization: `Bearer ${adminToken}`,
        },
      });
      expect(statusResponse.statusCode).toBe(200);
      expect(statusResponse.json().status).toBe('success');

      const acceptResponse = await app.inject({
        method: 'POST',
        url: `/api/stores/auth-sessions/${session.sessionId}/qr-login/accept`,
        headers: {
          authorization: `Bearer ${adminToken}`,
        },
      });
      expect(acceptResponse.statusCode).toBe(200);
      expect(acceptResponse.json().nextStep).toBe('sync_profile');

      const detailResponse = await app.inject({
        method: 'GET',
        url: `/api/stores/auth-sessions/${session.sessionId}`,
        headers: {
          authorization: `Bearer ${adminToken}`,
        },
      });
      expect(detailResponse.statusCode).toBe(200);
      expect(detailResponse.json().tokenReceived).toBe(true);
      expect(detailResponse.json().nextStepKey).toBe('sync_profile');
    } finally {
      appConfig.storeAuthMode = originalMode;
    }
  });

  it('网页登录态接入支持校验 Cookie 风控状态', async () => {
    const originalMode = appConfig.storeAuthMode;
    appConfig.storeAuthMode = 'xianyu_web_session';

    try {
      const { store } = await createXianyuWebSessionStore({
        providerUserId: 'xy-user-verify-1001',
        providerShopId: 'xy-shop-verify-2001',
        providerShopName: '登录态校验店铺',
        mobile: '139****1001',
      });

      vi.spyOn(xianyuWebSessionService, 'verifyXianyuWebSessionCookie').mockResolvedValue({
        riskLevel: 'warning',
        detail: '命中风控，需要补做验证。',
        verificationUrl: 'https://verify.goofish.com/risk',
        refreshedCookieText:
          'cna=verify-new; unb=verify-unb; _m_h5_tk=verify-token_123; cookie2=verify-cookie2;',
        rawRet: ['FAIL_SYS_USER_VALIDATE::风控验证'],
      });

      const verifyResponse = await app.inject({
        method: 'POST',
        url: `/api/stores/${store.id}/credential-verify`,
        headers: {
          authorization: `Bearer ${adminToken}`,
        },
      });
      expect(verifyResponse.statusCode).toBe(200);
      expect(verifyResponse.json().riskLevel).toBe('warning');
      expect(verifyResponse.json().verificationUrl).toBe('https://verify.goofish.com/risk');

      const management = await getStoreManagement();
      const refreshedStore = management.stores.find((item: { id: number }) => item.id === store.id);
      expect(refreshedStore).toBeTruthy();
      expect(refreshedStore.credentialRiskLevel).toBe('warning');
      expect(refreshedStore.credentialVerificationUrl).toBe('https://verify.goofish.com/risk');
    } finally {
      appConfig.storeAuthMode = originalMode;
    }
  });

  it('网页登录态主校验接口失败时会回退到真实成交单探测', async () => {
    const originalMode = appConfig.storeAuthMode;
    appConfig.storeAuthMode = 'xianyu_web_session';

    try {
      const { store } = await createXianyuWebSessionStore({
        providerUserId: 'xy-user-verify-fallback-1001',
        providerShopId: 'xy-shop-verify-fallback-2001',
        providerShopName: '登录态回退探测店铺',
        mobile: '139****1004',
      });

      vi.spyOn(xianyuWebSessionService, 'verifyXianyuWebSessionCookie').mockRejectedValue(new Error('fetch failed'));
      vi.spyOn(xianyuWebSessionService, 'fetchXianyuWebSessionSellerCompletedTrades').mockResolvedValue({
        items: [],
        totalCount: 0,
        pageCount: 1,
        rawRet: ['SUCCESS::调用成功'],
      });

      const verifyResponse = await app.inject({
        method: 'POST',
        url: `/api/stores/${store.id}/credential-verify`,
        headers: {
          authorization: `Bearer ${adminToken}`,
        },
      });
      expect(verifyResponse.statusCode).toBe(200);
      expect(verifyResponse.json().riskLevel).toBe('healthy');
      expect(verifyResponse.json().detail).toContain('真实成交单接口调用成功');

      const management = await getStoreManagement();
      const refreshedStore = management.stores.find((item: { id: number }) => item.id === store.id);
      expect(refreshedStore).toBeTruthy();
      expect(refreshedStore.credentialRiskLevel).toBe('healthy');
      expect(refreshedStore.credentialRiskReason).toContain('真实成交单接口调用成功');
    } finally {
      appConfig.storeAuthMode = originalMode;
    }
  });

  it('网页登录态接入支持浏览器续登并刷新凭据状态', async () => {
    const originalMode = appConfig.storeAuthMode;
    appConfig.storeAuthMode = 'xianyu_web_session';

    try {
      const { store } = await createXianyuWebSessionStore({
        providerUserId: 'xy-user-renew-1001',
        providerShopId: 'xy-shop-renew-2001',
        providerShopName: '浏览器续登店铺',
        mobile: '139****1002',
      });

      vi.spyOn(xianyuWebSessionService, 'renewXianyuWebSessionCookieViaBrowser').mockResolvedValue({
        renewed: true,
        cookieText: 'cna=renewed; unb=renew-unb; _m_h5_tk=renew-token_123; cookie2=renew-cookie2;',
        currentUrl: 'https://www.goofish.com/im',
        pageTitle: '闲鱼消息',
        verificationUrl: null,
        detail: '浏览器续登成功。',
      });
      vi.spyOn(xianyuWebSessionService, 'verifyXianyuWebSessionCookie').mockResolvedValue({
        riskLevel: 'healthy',
        detail: '续登后的 Cookie 校验通过。',
        verificationUrl: null,
        refreshedCookieText: null,
        rawRet: ['SUCCESS::调用成功'],
      });

      const renewResponse = await app.inject({
        method: 'POST',
        url: `/api/stores/${store.id}/browser-renew`,
        headers: {
          authorization: `Bearer ${adminToken}`,
        },
        payload: {
          showBrowser: false,
        },
      });
      expect(renewResponse.statusCode).toBe(200);
      expect(renewResponse.json().renewed).toBe(true);
      expect(renewResponse.json().riskLevel).toBe('healthy');

      const management = await getStoreManagement();
      const refreshedStore = management.stores.find((item: { id: number }) => item.id === store.id);
      expect(refreshedStore).toBeTruthy();
      expect(refreshedStore.credentialRiskLevel).toBe('healthy');
      expect(refreshedStore.lastCredentialRenewStatus).toBe('浏览器续登成功。');
    } finally {
      appConfig.storeAuthMode = originalMode;
    }
  });
});

*/
let adminToken = '';
async function getStoreManagement() {
    const response = await app.inject({
        method: 'GET',
        url: '/api/stores/management',
        headers: {
            authorization: `Bearer ${adminToken}`,
        },
    });
    expect(response.statusCode).toBe(200);
    return response.json();
}
async function createXianyuWebSessionStore(input) {
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
            cookieText: input.cookieText ?? 'cna=test-cookie; unb=test-unb; _m_h5_tk=test-token_123; cookie2=abc;',
            providerUserId: input.providerUserId,
            providerShopId: input.providerShopId,
            providerShopName: input.providerShopName,
            mobile: input.mobile,
            nickname: input.providerShopName,
            scopeText: 'item.read,item.write',
        },
    });
    expect(syncResponse.statusCode).toBe(200);
    const management = await getStoreManagement();
    const store = management.stores.find((item) => item.providerStoreId === input.providerShopId);
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
            password: 'Admin@123456',
        },
    });
    adminToken = response.json().token;
    console.log('DEBUG adminToken snippet:', String(adminToken).substring(0, 30));
});
afterAll(async () => {
    await app.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
});
afterEach(() => {
    vi.restoreAllMocks();
});
describe('销售统计接口', () => {
    it('健康检查可访问', async () => {
        const response = await app.inject({
            method: 'GET',
            url: '/api/health',
        });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({
            status: 'ok',
            version: '1.0.0',
            runtimeMode: 'demo',
        });
        // 确认不再暴露内部配置和路径信息
        expect(response.json().configuration).toBeUndefined();
        expect(response.json().dbPath).toBeUndefined();
    });
    it('管理员可以访问 Prometheus 指标接口', async () => {
        const response = await app.inject({
            method: 'GET',
            url: '/api/metrics',
            headers: buildMetricsRequestHeaders(adminToken),
        });
        expect(response.statusCode).toBe(200);
        expect(response.headers['content-type']).toContain('text/plain');
        expect(response.body).toContain('sale_compass_info');
        expect(response.body).toContain('sale_compass_http_requests_total');
    });
    it('登录后可以获取看板数据', async () => {
        const response = await app.inject({
            method: 'GET',
            url: '/api/dashboard?preset=last30Days',
            headers: {
                authorization: `Bearer ${adminToken}`,
            },
        });
        expect(response.statusCode).toBe(200);
        const payload = response.json();
        expect(payload.summary).toHaveLength(4);
        expect(payload.topProducts.length).toBeGreaterThan(0);
    });
    it('管理员可以导出订单 CSV', async () => {
        const response = await app.inject({
            method: 'GET',
            url: '/api/orders/export?preset=last7Days',
            headers: {
                authorization: `Bearer ${adminToken}`,
            },
        });
        expect(response.statusCode).toBe(200);
        expect(response.headers['content-type']).toContain('text/csv');
        expect(response.body).toContain('订单号');
    });
    it('订单中心支持商品筛选、排序和详情时间线', async () => {
        const optionsResponse = await app.inject({
            method: 'GET',
            url: '/api/options',
            headers: {
                authorization: `Bearer ${adminToken}`,
            },
        });
        expect(optionsResponse.statusCode).toBe(200);
        const options = optionsResponse.json();
        expect(options.products.length).toBeGreaterThan(0);
        const productId = options.products[0].value;
        const listResponse = await app.inject({
            method: 'GET',
            url: `/api/orders?preset=last90Days&productId=${productId}&sortBy=paidAmount&sortOrder=asc&page=1&pageSize=10`,
            headers: {
                authorization: `Bearer ${adminToken}`,
            },
        });
        expect(listResponse.statusCode).toBe(200);
        const listPayload = listResponse.json();
        expect(listPayload.list.length).toBeGreaterThan(0);
        expect(listPayload.list[0].productId).toBe(productId);
        expect(listPayload.list[0].mainStatus).toBeTruthy();
        expect(listPayload.list[0].deliveryStatus).toBeTruthy();
        expect(listPayload.list[0].fulfillmentType).toBeTruthy();
        expect(listPayload.list[0].fulfillmentQueue).toBeTruthy();
        if (listPayload.list.length >= 2) {
            expect(Number(listPayload.list[0].paidAmount)).toBeLessThanOrEqual(Number(listPayload.list[1].paidAmount));
        }
        const detailResponse = await app.inject({
            method: 'GET',
            url: `/api/orders/${listPayload.list[0].id}`,
            headers: {
                authorization: `Bearer ${adminToken}`,
            },
        });
        expect(detailResponse.statusCode).toBe(200);
        const detailPayload = detailResponse.json();
        expect(detailPayload.order.orderNo).toBe(listPayload.list[0].orderNo);
        expect(detailPayload.items.length).toBeGreaterThan(0);
        expect(detailPayload.payments.length).toBeGreaterThan(0);
        expect(detailPayload.events.length).toBeGreaterThan(1);
        expect(detailPayload.order.mainStatusText).toBeTruthy();
        expect(detailPayload.fulfillment.type).toBeTruthy();
        expect(Array.isArray(detailPayload.fulfillmentLogs)).toBe(true);
    });
    it('订单导出结果与当前筛选条件一致', async () => {
        const listResponse = await app.inject({
            method: 'GET',
            url: '/api/orders?preset=last30Days&mainStatus=paid&deliveryStatus=pending&page=1&pageSize=20',
            headers: {
                authorization: `Bearer ${adminToken}`,
            },
        });
        expect(listResponse.statusCode).toBe(200);
        const listPayload = listResponse.json();
        const exportResponse = await app.inject({
            method: 'GET',
            url: '/api/orders/export?preset=last30Days&mainStatus=paid&deliveryStatus=pending',
            headers: {
                authorization: `Bearer ${adminToken}`,
            },
        });
        expect(exportResponse.statusCode).toBe(200);
        expect(exportResponse.headers['content-type']).toContain('text/csv');
        const lines = exportResponse.body
            .trim()
            .split('\n')
            .filter((line) => line.length > 0);
        expect(lines[0]).toContain('主状态');
        expect(lines.length - 1).toBe(listPayload.total);
        if (listPayload.list.length > 0) {
            expect(exportResponse.body).toContain(listPayload.list[0].orderNo);
        }
    });
    it('可以获取功能工作台并执行状态变更', async () => {
        const overviewResponse = await app.inject({
            method: 'GET',
            url: '/api/workspaces/move',
            headers: {
                authorization: `Bearer ${adminToken}`,
            },
        });
        expect(overviewResponse.statusCode).toBe(200);
        const overview = overviewResponse.json();
        expect(overview.summary).toHaveLength(3);
        expect(overview.actions.length).toBeGreaterThan(0);
        expect(overview.rules.length).toBeGreaterThan(0);
        expect(overview.tasks.length).toBeGreaterThan(0);
        const runActionResponse = await app.inject({
            method: 'POST',
            url: `/api/workspaces/move/actions/${overview.actions[0].id}/run`,
            headers: {
                authorization: `Bearer ${adminToken}`,
            },
        });
        expect(runActionResponse.statusCode).toBe(200);
        const toggleRuleResponse = await app.inject({
            method: 'POST',
            url: `/api/workspaces/move/rules/${overview.rules[0].id}/toggle`,
            headers: {
                authorization: `Bearer ${adminToken}`,
            },
        });
        expect(toggleRuleResponse.statusCode).toBe(200);
        const updateTaskResponse = await app.inject({
            method: 'POST',
            url: `/api/workspaces/move/tasks/${overview.tasks[0].id}/status`,
            headers: {
                authorization: `Bearer ${adminToken}`,
            },
            payload: {
                status: 'done',
            },
        });
        expect(updateTaskResponse.statusCode).toBe(200);
        const refreshedResponse = await app.inject({
            method: 'GET',
            url: '/api/workspaces/move',
            headers: {
                authorization: `Bearer ${adminToken}`,
            },
        });
        expect(refreshedResponse.statusCode).toBe(200);
        const refreshed = refreshedResponse.json();
        expect(refreshed.logs.length).toBeGreaterThanOrEqual(3);
    });
    it('卡密仓库与资金中心详情接口可访问并支持专有操作', async () => {
        const cardTypeDetailResponse = await app.inject({
            method: 'GET',
            url: '/api/workspaces/card-types/detail',
            headers: {
                authorization: `Bearer ${adminToken}`,
            },
        });
        expect(cardTypeDetailResponse.statusCode).toBe(200);
        const cardTypeDetail = cardTypeDetailResponse.json();
        expect(cardTypeDetail.kind).toBe('card-types');
        expect(cardTypeDetail.rows.length).toBeGreaterThan(0);
        const cardTrashDetailResponse = await app.inject({
            method: 'GET',
            url: '/api/workspaces/card-trash/detail',
            headers: {
                authorization: `Bearer ${adminToken}`,
            },
        });
        expect(cardTrashDetailResponse.statusCode).toBe(200);
        const cardTrashDetail = cardTrashDetailResponse.json();
        expect(cardTrashDetail.kind).toBe('card-trash');
        expect(cardTrashDetail.rows.length).toBeGreaterThan(0);
        const restoreResponse = await app.inject({
            method: 'POST',
            url: `/api/workspaces/card-trash/card-types/${cardTrashDetail.rows[0].id}/restore`,
            headers: {
                authorization: `Bearer ${adminToken}`,
            },
        });
        expect(restoreResponse.statusCode).toBe(200);
        const fundWithdrawalDetailResponse = await app.inject({
            method: 'GET',
            url: '/api/workspaces/fund-withdrawals/detail',
            headers: {
                authorization: `Bearer ${adminToken}`,
            },
        });
        expect(fundWithdrawalDetailResponse.statusCode).toBe(200);
        const fundWithdrawalDetail = fundWithdrawalDetailResponse.json();
        expect(fundWithdrawalDetail.kind).toBe('fund-withdrawals');
        const pendingWithdrawal = fundWithdrawalDetail.rows.find((item) => item.status === 'pending');
        expect(pendingWithdrawal).toBeTruthy();
        const updateWithdrawalResponse = await app.inject({
            method: 'POST',
            url: `/api/workspaces/fund-withdrawals/withdrawals/${pendingWithdrawal.id}/status`,
            headers: {
                authorization: `Bearer ${adminToken}`,
            },
            payload: {
                status: 'paid',
            },
        });
        expect(updateWithdrawalResponse.statusCode).toBe(200);
        const fundAccountDetailResponse = await app.inject({
            method: 'GET',
            url: '/api/workspaces/fund-accounts/detail',
            headers: {
                authorization: `Bearer ${adminToken}`,
            },
        });
        expect(fundAccountDetailResponse.statusCode).toBe(200);
        const fundAccountDetail = fundAccountDetailResponse.json();
        expect(fundAccountDetail.kind).toBe('fund-accounts');
        expect(Number(fundAccountDetail.account.pendingWithdrawal)).toBe(0);
    });
    it('卡密发货引擎支持导入、去重、格式校验和低库存提醒', async () => {
        const cardTypeDetailResponse = await app.inject({
            method: 'GET',
            url: '/api/workspaces/card-types/detail',
            headers: {
                authorization: `Bearer ${adminToken}`,
            },
        });
        expect(cardTypeDetailResponse.statusCode).toBe(200);
        const cardTypeDetail = cardTypeDetailResponse.json();
        const firstType = cardTypeDetail.rows[0];
        expect(firstType.cardPrefix).toBeTruthy();
        const serial = String(Date.now()).slice(-8);
        const validLine = `${firstType.cardPrefix}${serial}${firstType.separatorText}${firstType.passwordPrefix}${serial}`;
        const importResponse = await app.inject({
            method: 'POST',
            url: `/api/workspaces/card-delivery/card-types/${firstType.id}/import`,
            headers: {
                authorization: `Bearer ${adminToken}`,
            },
            payload: {
                lines: [validLine, validLine, 'BAD-LINE'],
            },
        });
        expect(importResponse.statusCode).toBe(200);
        const importPayload = importResponse.json();
        expect(importPayload.importedCount).toBe(1);
        expect(importPayload.duplicateCount).toBe(1);
        expect(importPayload.invalidCount).toBe(1);
        const toggleInventoryResponse = await app.inject({
            method: 'POST',
            url: `/api/workspaces/card-delivery/card-types/${firstType.id}/inventory-sample/toggle`,
            headers: {
                authorization: `Bearer ${adminToken}`,
            },
        });
        expect(toggleInventoryResponse.statusCode).toBe(200);
        expect(['available', 'disabled']).toContain(toggleInventoryResponse.json().itemStatus);
        const cardDeliveryDetailResponse = await app.inject({
            method: 'GET',
            url: '/api/workspaces/card-delivery/detail',
            headers: {
                authorization: `Bearer ${adminToken}`,
            },
        });
        expect(cardDeliveryDetailResponse.statusCode).toBe(200);
        const cardDeliveryDetail = cardDeliveryDetailResponse.json();
        expect(cardDeliveryDetail.kind).toBe('card-delivery');
        expect(cardDeliveryDetail.jobs.length).toBeGreaterThan(0);
        expect(cardDeliveryDetail.alerts.some((item) => item.status === 'open')).toBe(true);
    });
    it('卡密订单支持幂等发货，失败任务可在启用配置后重试成功', async () => {
        const deliveryDetailResponse = await app.inject({
            method: 'GET',
            url: '/api/workspaces/card-delivery/detail',
            headers: {
                authorization: `Bearer ${adminToken}`,
            },
        });
        expect(deliveryDetailResponse.statusCode).toBe(200);
        const deliveryDetail = deliveryDetailResponse.json();
        const pendingJob = deliveryDetail.jobs.find((job) => job.jobStatus === 'pending' && job.cardTypeName === '王者点券直充');
        expect(pendingJob).toBeTruthy();
        const firstFulfillResponse = await app.inject({
            method: 'POST',
            url: `/api/workspaces/card-delivery/orders/${pendingJob.orderId}/fulfill`,
            headers: {
                authorization: `Bearer ${adminToken}`,
            },
        });
        expect(firstFulfillResponse.statusCode).toBe(200);
        const firstFulfill = firstFulfillResponse.json();
        expect(firstFulfill.success).toBe(true);
        expect(firstFulfill.idempotent).toBe(false);
        const secondFulfillResponse = await app.inject({
            method: 'POST',
            url: `/api/workspaces/card-delivery/orders/${pendingJob.orderId}/fulfill`,
            headers: {
                authorization: `Bearer ${adminToken}`,
            },
        });
        expect(secondFulfillResponse.statusCode).toBe(200);
        const secondFulfill = secondFulfillResponse.json();
        expect(secondFulfill.success).toBe(true);
        expect(secondFulfill.idempotent).toBe(true);
        expect(secondFulfill.outboundRecord.outboundNo).toBe(firstFulfill.outboundRecord.outboundNo);
        const failedJob = deliveryDetail.jobs.find((job) => job.jobStatus === 'failed');
        expect(failedJob).toBeTruthy();
        const enableDeliveryResponse = await app.inject({
            method: 'POST',
            url: '/api/workspaces/card-delivery/delivery-items/3/toggle',
            headers: {
                authorization: `Bearer ${adminToken}`,
            },
            payload: {},
        });
        expect(enableDeliveryResponse.statusCode).toBe(200);
        const retryResponse = await app.inject({
            method: 'POST',
            url: `/api/workspaces/card-delivery/jobs/${failedJob.id}/run`,
            headers: {
                authorization: `Bearer ${adminToken}`,
            },
        });
        expect(retryResponse.statusCode).toBe(200);
        expect(retryResponse.json().success).toBe(true);
        const orderDetailResponse = await app.inject({
            method: 'GET',
            url: `/api/orders/${pendingJob.orderId}`,
            headers: {
                authorization: `Bearer ${adminToken}`,
            },
        });
        expect(orderDetailResponse.statusCode).toBe(200);
        expect(orderDetailResponse.json().order.deliveryStatus).toBe('delivered');
    });
    it('卡密补发与回收记录可追溯到原订单和原出库单', async () => {
        const recordsDetailResponse = await app.inject({
            method: 'GET',
            url: '/api/workspaces/card-records/detail',
            headers: {
                authorization: `Bearer ${adminToken}`,
            },
        });
        expect(recordsDetailResponse.statusCode).toBe(200);
        const recordsDetail = recordsDetailResponse.json();
        const originalOutbound = recordsDetail.outboundRows.find((row) => row.outboundStatus === 'sent');
        expect(originalOutbound).toBeTruthy();
        const resendResponse = await app.inject({
            method: 'POST',
            url: `/api/workspaces/card-records/outbound-records/${originalOutbound.id}/resend`,
            headers: {
                authorization: `Bearer ${adminToken}`,
            },
        });
        expect(resendResponse.statusCode).toBe(200);
        const resendPayload = resendResponse.json();
        expect(resendPayload.success).toBe(true);
        expect(resendPayload.resendRecord.parentOutboundNo).toBe(originalOutbound.outboundNo);
        const recycleResponse = await app.inject({
            method: 'POST',
            url: `/api/workspaces/card-records/outbound-records/${originalOutbound.id}/recycle`,
            headers: {
                authorization: `Bearer ${adminToken}`,
            },
            payload: {
                action: 'recycle',
            },
        });
        expect(recycleResponse.statusCode).toBe(200);
        expect(recycleResponse.json().success).toBe(true);
        const refreshedRecordsResponse = await app.inject({
            method: 'GET',
            url: '/api/workspaces/card-records/detail',
            headers: {
                authorization: `Bearer ${adminToken}`,
            },
        });
        expect(refreshedRecordsResponse.statusCode).toBe(200);
        const refreshedRecords = refreshedRecordsResponse.json();
        expect(refreshedRecords.recycleRows.some((row) => row.outboundNo === originalOutbound.outboundNo && row.recycleAction === 'recycle')).toBe(true);
    });
    it('直充供应商支持启停和回调令牌轮换', async () => {
        const supplierDetailResponse = await app.inject({
            method: 'GET',
            url: '/api/workspaces/distribution-source/detail',
            headers: {
                authorization: `Bearer ${adminToken}`,
            },
        });
        expect(supplierDetailResponse.statusCode).toBe(200);
        const supplierDetail = supplierDetailResponse.json();
        expect(supplierDetail.kind).toBe('distribution-source');
        expect(supplierDetail.suppliers.length).toBeGreaterThan(0);
        expect(supplierDetail.items.length).toBeGreaterThan(0);
        const backupSupplier = supplierDetail.suppliers.find((row) => row.supplierKey === 'sim-topup-backup');
        expect(backupSupplier).toBeTruthy();
        const toggleResponse = await app.inject({
            method: 'POST',
            url: `/api/workspaces/distribution-source/suppliers/${backupSupplier.id}/toggle`,
            headers: {
                authorization: `Bearer ${adminToken}`,
            },
        });
        expect(toggleResponse.statusCode).toBe(200);
        expect(toggleResponse.json().enabled).toBe(true);
        const rotateResponse = await app.inject({
            method: 'POST',
            url: `/api/workspaces/distribution-source/suppliers/${backupSupplier.id}/token/rotate`,
            headers: {
                authorization: `Bearer ${adminToken}`,
            },
        });
        expect(rotateResponse.statusCode).toBe(200);
        expect(rotateResponse.json().callbackTokenMasked).toContain('***');
    });
    it('直充任务支持超时转重试、重试下发和成功回调', async () => {
        const supplyDetailResponse = await app.inject({
            method: 'GET',
            url: '/api/workspaces/distribution-supply/detail',
            headers: {
                authorization: `Bearer ${adminToken}`,
            },
        });
        expect(supplyDetailResponse.statusCode).toBe(200);
        const supplyDetail = supplyDetailResponse.json();
        expect(supplyDetail.kind).toBe('distribution-supply');
        const timeoutJob = supplyDetail.jobs.find((job) => job.orderNo.endsWith('99002') && job.callbackStatus === 'timeout');
        expect(timeoutJob).toBeTruthy();
        expect(timeoutJob.taskStatus).toBe('pending_dispatch');
        const retryResponse = await app.inject({
            method: 'POST',
            url: `/api/workspaces/distribution-supply/direct-charge-jobs/${timeoutJob.id}/retry`,
            headers: {
                authorization: `Bearer ${adminToken}`,
            },
        });
        expect(retryResponse.statusCode).toBe(200);
        const retryPayload = retryResponse.json();
        expect(retryPayload.success).toBe(true);
        expect(retryPayload.taskStatus).toBe('processing');
        const callbackResponse = await app.inject({
            method: 'POST',
            url: '/api/direct-charge/callbacks/sim-topup',
            payload: {
                taskNo: timeoutJob.taskNo,
                supplierOrderNo: retryPayload.supplierOrderNo ?? 'SIM-TIMEOUT-99002',
                supplierStatus: 'SUCCESS',
                resultCode: '0000',
                detail: '测试回调：充值成功。',
                token: 'sim-topup-callback-token',
            },
        });
        expect(callbackResponse.statusCode).toBe(200);
        expect(callbackResponse.json().accepted).toBe(true);
        expect(callbackResponse.json().mappedStatus).toBe('success');
        const refreshedSupplyResponse = await app.inject({
            method: 'GET',
            url: '/api/workspaces/distribution-supply/detail',
            headers: {
                authorization: `Bearer ${adminToken}`,
            },
        });
        expect(refreshedSupplyResponse.statusCode).toBe(200);
        const refreshedSupply = refreshedSupplyResponse.json();
        const completedJob = refreshedSupply.jobs.find((job) => job.id === timeoutJob.id);
        expect(completedJob.taskStatus).toBe('success');
        expect(completedJob.callbackStatus).toBe('verified');
        const orderDetailResponse = await app.inject({
            method: 'GET',
            url: `/api/orders/${timeoutJob.orderId}`,
            headers: {
                authorization: `Bearer ${adminToken}`,
            },
        });
        expect(orderDetailResponse.statusCode).toBe(200);
        expect(orderDetailResponse.json().order.deliveryStatus).toBe('delivered');
        expect(orderDetailResponse.json().order.mainStatus).toBe('completed');
    });
    it('直充回调验签失败会记录异常并支持人工接管', async () => {
        const supplyDetailResponse = await app.inject({
            method: 'GET',
            url: '/api/workspaces/distribution-supply/detail',
            headers: {
                authorization: `Bearer ${adminToken}`,
            },
        });
        expect(supplyDetailResponse.statusCode).toBe(200);
        const supplyDetail = supplyDetailResponse.json();
        const pendingJob = supplyDetail.jobs.find((job) => job.orderNo.endsWith('99001') && job.taskStatus === 'pending_dispatch');
        expect(pendingJob).toBeTruthy();
        const dispatchResponse = await app.inject({
            method: 'POST',
            url: `/api/workspaces/distribution-supply/direct-charge-jobs/${pendingJob.id}/dispatch`,
            headers: {
                authorization: `Bearer ${adminToken}`,
            },
        });
        expect(dispatchResponse.statusCode).toBe(200);
        expect(dispatchResponse.json().taskStatus).toBe('processing');
        const rejectedCallbackResponse = await app.inject({
            method: 'POST',
            url: '/api/direct-charge/callbacks/sim-topup',
            payload: {
                taskNo: pendingJob.taskNo,
                supplierOrderNo: dispatchResponse.json().supplierOrderNo ?? 'SIM-BAD-99001',
                supplierStatus: 'FAILED',
                resultCode: 'SIG_FAIL',
                detail: '测试回调：验签失败。',
                token: 'invalid-token',
            },
        });
        expect(rejectedCallbackResponse.statusCode).toBe(200);
        expect(rejectedCallbackResponse.json().accepted).toBe(false);
        expect(rejectedCallbackResponse.json().verificationStatus).toBe('failed');
        const manualReviewResponse = await app.inject({
            method: 'POST',
            url: `/api/workspaces/distribution-supply/direct-charge-jobs/${pendingJob.id}/manual-review`,
            headers: {
                authorization: `Bearer ${adminToken}`,
            },
            payload: {
                reason: '客服人工接管异常订单',
            },
        });
        expect(manualReviewResponse.statusCode).toBe(200);
        expect(manualReviewResponse.json().taskStatus).toBe('manual_review');
        const refreshedSupplyResponse = await app.inject({
            method: 'GET',
            url: '/api/workspaces/distribution-supply/detail',
            headers: {
                authorization: `Bearer ${adminToken}`,
            },
        });
        expect(refreshedSupplyResponse.statusCode).toBe(200);
        const refreshedSupply = refreshedSupplyResponse.json();
        const manualJob = refreshedSupply.jobs.find((job) => job.id === pendingJob.id);
        expect(manualJob.taskStatus).toBe('manual_review');
        expect(manualJob.manualReason).toBe('客服人工接管异常订单');
        expect(refreshedSupply.callbacks.some((row) => row.taskNo === pendingJob.taskNo && row.verificationStatus === 'failed')).toBe(true);
        expect(refreshedSupply.reconciliations.some((row) => row.orderNo === pendingJob.orderNo && row.reconcileStatus === 'anomaly')).toBe(true);
    });
    it('自有货源系统支持启停、令牌轮换、同步和同步重试', async () => {
        const detailResponse = await app.inject({
            method: 'GET',
            url: '/api/workspaces/distribution-source/detail',
            headers: {
                authorization: `Bearer ${adminToken}`,
            },
        });
        expect(detailResponse.statusCode).toBe(200);
        const detail = detailResponse.json();
        expect(detail.kind).toBe('distribution-source');
        expect(detail.sourceSystems.length).toBeGreaterThan(0);
        expect(detail.sourceProducts.length).toBeGreaterThan(0);
        expect(detail.sourceSyncRuns.length).toBeGreaterThan(0);
        const legacySystem = detail.sourceSystems.find((row) => row.systemKey === 'own-supply-legacy');
        const coreSystem = detail.sourceSystems.find((row) => row.systemKey === 'own-supply-core');
        expect(legacySystem).toBeTruthy();
        expect(coreSystem).toBeTruthy();
        const toggleResponse = await app.inject({
            method: 'POST',
            url: `/api/workspaces/distribution-source/source-systems/${legacySystem.id}/toggle`,
            headers: {
                authorization: `Bearer ${adminToken}`,
            },
        });
        expect(toggleResponse.statusCode).toBe(200);
        expect(toggleResponse.json().enabled).toBe(false);
        const rotateResponse = await app.inject({
            method: 'POST',
            url: `/api/workspaces/distribution-source/source-systems/${legacySystem.id}/token/rotate`,
            headers: {
                authorization: `Bearer ${adminToken}`,
            },
        });
        expect(rotateResponse.statusCode).toBe(200);
        expect(rotateResponse.json().callbackTokenMasked).toContain('***');
        const syncResponse = await app.inject({
            method: 'POST',
            url: `/api/workspaces/distribution-source/source-systems/${coreSystem.id}/sync`,
            headers: {
                authorization: `Bearer ${adminToken}`,
            },
            payload: {
                syncType: 'price',
            },
        });
        expect(syncResponse.statusCode).toBe(200);
        expect(syncResponse.json()).toMatchObject({
            systemId: coreSystem.id,
            syncType: 'price',
            runMode: 'manual',
            runStatus: 'success',
        });
        const latestRun = detail.sourceSyncRuns.find((row) => row.systemId === coreSystem.id);
        expect(latestRun).toBeTruthy();
        const retryResponse = await app.inject({
            method: 'POST',
            url: `/api/workspaces/distribution-source/source-sync-runs/${latestRun.id}/retry`,
            headers: {
                authorization: `Bearer ${adminToken}`,
            },
        });
        expect(retryResponse.statusCode).toBe(200);
        expect(retryResponse.json()).toMatchObject({
            syncType: latestRun.syncType,
            runMode: 'manual',
            runStatus: 'success',
        });
    });
    it('自有货源订单支持推单、成功回调和订单状态回写', async () => {
        const detailResponse = await app.inject({
            method: 'GET',
            url: '/api/workspaces/distribution-supply/detail',
            headers: {
                authorization: `Bearer ${adminToken}`,
            },
        });
        expect(detailResponse.statusCode).toBe(200);
        const detail = detailResponse.json();
        expect(detail.kind).toBe('distribution-supply');
        expect(detail.sourceOrders.length).toBeGreaterThan(0);
        const pendingOrder = detail.sourceOrders.find((row) => row.orderStatus === 'pending_push' && row.systemId === 1);
        expect(pendingOrder).toBeTruthy();
        const dispatchResponse = await app.inject({
            method: 'POST',
            url: `/api/workspaces/distribution-supply/source-orders/${pendingOrder.id}/dispatch`,
            headers: {
                authorization: `Bearer ${adminToken}`,
            },
        });
        expect(dispatchResponse.statusCode).toBe(200);
        const dispatchPayload = dispatchResponse.json();
        expect(dispatchPayload.orderStatus).toBe('processing');
        expect(dispatchPayload.sourceOrderNo).toBeTruthy();
        const callbackResponse = await app.inject({
            method: 'POST',
            url: '/api/source-supply/callbacks/own-supply-core',
            payload: {
                taskNo: pendingOrder.taskNo,
                sourceOrderNo: dispatchPayload.sourceOrderNo,
                sourceStatus: 'DELIVERED',
                detail: '测试货源回调：发货完成。',
                token: 'own-supply-core-token',
            },
        });
        expect(callbackResponse.statusCode).toBe(200);
        expect(callbackResponse.json()).toMatchObject({
            accepted: true,
            verificationStatus: 'passed',
            mappedStatus: 'success',
            orderStatus: 'success',
        });
        const refreshedResponse = await app.inject({
            method: 'GET',
            url: '/api/workspaces/distribution-supply/detail',
            headers: {
                authorization: `Bearer ${adminToken}`,
            },
        });
        expect(refreshedResponse.statusCode).toBe(200);
        const refreshed = refreshedResponse.json();
        const updatedOrder = refreshed.sourceOrders.find((row) => row.id === pendingOrder.id);
        expect(updatedOrder.orderStatus).toBe('success');
        expect(updatedOrder.sourceStatus).toBe('DELIVERED');
        expect(refreshed.sourceCallbacks.some((row) => row.taskNo === pendingOrder.taskNo && row.verificationStatus === 'passed')).toBe(true);
        const orderDetailResponse = await app.inject({
            method: 'GET',
            url: `/api/orders/${pendingOrder.orderId}`,
            headers: {
                authorization: `Bearer ${adminToken}`,
            },
        });
        expect(orderDetailResponse.statusCode).toBe(200);
        expect(orderDetailResponse.json().order.deliveryStatus).toBe('delivered');
        expect(orderDetailResponse.json().order.mainStatus).toBe('completed');
    });
    it('自有货源退款通知会生成售后记录和退款对账', async () => {
        const detailResponse = await app.inject({
            method: 'GET',
            url: '/api/workspaces/distribution-supply/detail',
            headers: {
                authorization: `Bearer ${adminToken}`,
            },
        });
        expect(detailResponse.statusCode).toBe(200);
        const detail = detailResponse.json();
        const pushedOrder = detail.sourceOrders.find((row) => row.systemId === 1 && Boolean(row.sourceOrderNo));
        expect(pushedOrder).toBeTruthy();
        const noticeNo = `REFUND-TEST-${Date.now()}`;
        const refundResponse = await app.inject({
            method: 'POST',
            url: '/api/source-supply/refunds/own-supply-core',
            payload: {
                noticeNo,
                sourceOrderNo: pushedOrder.sourceOrderNo,
                refundStatus: 'REFUNDED',
                detail: '测试退款通知：已退款。',
                token: 'own-supply-core-token',
            },
        });
        expect(refundResponse.statusCode).toBe(200);
        expect(refundResponse.json()).toMatchObject({
            accepted: true,
            mappedStatus: 'resolved',
        });
        expect(refundResponse.json().caseNo).toBeTruthy();
        const refreshedResponse = await app.inject({
            method: 'GET',
            url: '/api/workspaces/distribution-supply/detail',
            headers: {
                authorization: `Bearer ${adminToken}`,
            },
        });
        expect(refreshedResponse.statusCode).toBe(200);
        const refreshed = refreshedResponse.json();
        expect(refreshed.sourceRefundNotices.some((row) => row.noticeNo === noticeNo &&
            row.sourceOrderNo === pushedOrder.sourceOrderNo &&
            row.refundStatus === 'resolved')).toBe(true);
        expect(refreshed.sourceReconciliations.some((row) => row.reconcileType === 'refund' &&
            row.sourceRef === noticeNo &&
            row.reconcileStatus === 'matched')).toBe(true);
    });
    it('订单履约工作台返回统一队列、异常订单和店铺履约统计', async () => {
        const response = await app.inject({
            method: 'GET',
            url: '/api/orders/workbench/fulfillment?preset=last30Days',
            headers: {
                authorization: `Bearer ${adminToken}`,
            },
        });
        expect(response.statusCode).toBe(200);
        const payload = response.json();
        expect(payload.queueSummary.total).toBeGreaterThan(0);
        expect(payload.queueSummary.success).toBeGreaterThan(0);
        expect(payload.exceptionOrders.length).toBeGreaterThan(0);
        expect(payload.logs.length).toBeGreaterThan(0);
        expect(payload.storeStats.length).toBeGreaterThan(0);
        expect(payload.exceptionOrders.some((row) => ['card', 'direct_charge'].includes(row.fulfillmentType))).toBe(true);
    });
    it('订单中心统一履约动作支持重试、备注和终止', async () => {
        const workbenchResponse = await app.inject({
            method: 'GET',
            url: '/api/orders/workbench/fulfillment?preset=last30Days',
            headers: {
                authorization: `Bearer ${adminToken}`,
            },
        });
        expect(workbenchResponse.statusCode).toBe(200);
        const workbench = workbenchResponse.json();
        const targetOrder = workbench.exceptionOrders.find((row) => row.fulfillmentType === 'direct_charge');
        expect(targetOrder).toBeTruthy();
        const retryResponse = await app.inject({
            method: 'POST',
            url: `/api/orders/${targetOrder.id}/fulfillment/retry`,
            headers: {
                authorization: `Bearer ${adminToken}`,
            },
        });
        expect(retryResponse.statusCode).toBe(200);
        expect(retryResponse.json().success).toBe(true);
        const noteResponse = await app.inject({
            method: 'POST',
            url: `/api/orders/${targetOrder.id}/fulfillment/note`,
            headers: {
                authorization: `Bearer ${adminToken}`,
            },
            payload: {
                note: '第7轮统一履约备注测试',
            },
        });
        expect(noteResponse.statusCode).toBe(200);
        expect(noteResponse.json().sellerRemark).toContain('第7轮统一履约备注测试');
        const terminateResponse = await app.inject({
            method: 'POST',
            url: `/api/orders/${targetOrder.id}/fulfillment/terminate`,
            headers: {
                authorization: `Bearer ${adminToken}`,
            },
            payload: {
                reason: '第7轮统一履约终止测试',
            },
        });
        expect(terminateResponse.statusCode).toBe(200);
        expect(terminateResponse.json().mainStatus).toBe('closed');
        const detailResponse = await app.inject({
            method: 'GET',
            url: `/api/orders/${targetOrder.id}`,
            headers: {
                authorization: `Bearer ${adminToken}`,
            },
        });
        expect(detailResponse.statusCode).toBe(200);
        const detail = detailResponse.json();
        expect(detail.order.mainStatus).toBe('closed');
        expect(detail.fulfillmentLogs.some((row) => row.eventType === 'fulfillment_terminated')).toBe(true);
    });
    it('订单中心统一履约入口支持卡密补发并写入履约日志', async () => {
        const listResponse = await app.inject({
            method: 'GET',
            url: '/api/orders?preset=last30Days&page=1&pageSize=60',
            headers: {
                authorization: `Bearer ${adminToken}`,
            },
        });
        expect(listResponse.statusCode).toBe(200);
        const listPayload = listResponse.json();
        const cardOrder = listPayload.list.find((row) => row.fulfillmentType === 'card' && row.fulfillmentQueue === 'success');
        expect(cardOrder).toBeTruthy();
        const resendResponse = await app.inject({
            method: 'POST',
            url: `/api/orders/${cardOrder.id}/fulfillment/resend`,
            headers: {
                authorization: `Bearer ${adminToken}`,
            },
        });
        expect(resendResponse.statusCode).toBe(200);
        expect(resendResponse.json().success).toBe(true);
        const detailResponse = await app.inject({
            method: 'GET',
            url: `/api/orders/${cardOrder.id}`,
            headers: {
                authorization: `Bearer ${adminToken}`,
            },
        });
        expect(detailResponse.statusCode).toBe(200);
        expect(detailResponse
            .json()
            .fulfillmentLogs.some((row) => row.eventType === 'card_resent')).toBe(true);
    });
    it('售后中心返回退款、补发、争议和提醒数据', async () => {
        const workbenchResponse = await app.inject({
            method: 'GET',
            url: '/api/after-sales/workbench?preset=last30Days',
            headers: {
                authorization: `Bearer ${adminToken}`,
            },
        });
        expect(workbenchResponse.statusCode).toBe(200);
        const workbench = workbenchResponse.json();
        expect(workbench.summary.totalCases).toBeGreaterThanOrEqual(3);
        expect(workbench.summary.refundCases).toBeGreaterThanOrEqual(1);
        expect(workbench.summary.resendCases).toBeGreaterThanOrEqual(1);
        expect(workbench.summary.disputeCases).toBeGreaterThanOrEqual(1);
        expect(workbench.reminders.length).toBeGreaterThan(0);
        expect(workbench.timeoutCases.length).toBeGreaterThan(0);
        const scopedWorkbenchResponse = await app.inject({
            method: 'GET',
            url: '/api/after-sales/workbench?preset=last30Days&storeId=1',
            headers: {
                authorization: `Bearer ${adminToken}`,
            },
        });
        expect(scopedWorkbenchResponse.statusCode).toBe(200);
        const scopedWorkbench = scopedWorkbenchResponse.json();
        expect(scopedWorkbench.summary.totalCases).toBeGreaterThanOrEqual(1);
        const listResponse = await app.inject({
            method: 'GET',
            url: '/api/after-sales?preset=last30Days&page=1&pageSize=20',
            headers: {
                authorization: `Bearer ${adminToken}`,
            },
        });
        expect(listResponse.statusCode).toBe(200);
        const listPayload = listResponse.json();
        expect(listPayload.list.some((row) => row.caseType === 'refund')).toBe(true);
        expect(listPayload.list.some((row) => row.caseType === 'resend')).toBe(true);
        expect(listPayload.list.some((row) => row.caseType === 'dispute')).toBe(true);
        const resendCase = listPayload.list.find((row) => row.caseType === 'resend');
        expect(resendCase).toBeTruthy();
        const detailResponse = await app.inject({
            method: 'GET',
            url: `/api/after-sales/${resendCase.id}`,
            headers: {
                authorization: `Bearer ${adminToken}`,
            },
        });
        expect(detailResponse.statusCode).toBe(200);
        const detailPayload = detailResponse.json();
        expect(detailPayload.caseInfo.caseType).toBe('resend');
        expect(detailPayload.records.length).toBeGreaterThan(0);
        expect(detailPayload.reminders.length).toBeGreaterThan(0);
        expect(detailPayload.order.orderNo).toBeTruthy();
    });
    it('售后中心支持退款审核和退款完成状态流转', async () => {
        const listResponse = await app.inject({
            method: 'GET',
            url: '/api/after-sales?preset=last30Days&page=1&pageSize=20&caseType=refund',
            headers: {
                authorization: `Bearer ${adminToken}`,
            },
        });
        expect(listResponse.statusCode).toBe(200);
        const refundCase = listResponse
            .json()
            .list.find((row) => row.refundStatus === 'pending_review');
        expect(refundCase).toBeTruthy();
        const approveResponse = await app.inject({
            method: 'POST',
            url: `/api/after-sales/${refundCase.id}/refund/review`,
            headers: {
                authorization: `Bearer ${adminToken}`,
            },
            payload: {
                decision: 'approve',
                approvedAmount: 18.8,
                note: '第8轮退款审核通过测试',
            },
        });
        expect(approveResponse.statusCode).toBe(200);
        expect(approveResponse.json().refundStatus).toBe('approved');
        const refundResponse = await app.inject({
            method: 'POST',
            url: `/api/after-sales/${refundCase.id}/refund/review`,
            headers: {
                authorization: `Bearer ${adminToken}`,
            },
            payload: {
                decision: 'refund',
                note: '第8轮退款完成测试',
            },
        });
        expect(refundResponse.statusCode).toBe(200);
        expect(refundResponse.json().refundStatus).toBe('refunded');
        const detailResponse = await app.inject({
            method: 'GET',
            url: `/api/after-sales/${refundCase.id}`,
            headers: {
                authorization: `Bearer ${adminToken}`,
            },
        });
        expect(detailResponse.statusCode).toBe(200);
        const detailPayload = detailResponse.json();
        expect(detailPayload.refund.refundStatus).toBe('refunded');
        expect(detailPayload.caseInfo.caseStatus).toBe('resolved');
        expect(Number(detailPayload.order.refundAmount)).toBeGreaterThanOrEqual(18.8);
    });
    it('售后中心支持补发执行并回写履约记录', async () => {
        const listResponse = await app.inject({
            method: 'GET',
            url: '/api/after-sales?preset=last30Days&page=1&pageSize=20&caseType=resend',
            headers: {
                authorization: `Bearer ${adminToken}`,
            },
        });
        expect(listResponse.statusCode).toBe(200);
        const resendCase = listResponse
            .json()
            .list.find((row) => ['approved', 'failed'].includes(row.resendStatus));
        expect(resendCase).toBeTruthy();
        const executeResponse = await app.inject({
            method: 'POST',
            url: `/api/after-sales/${resendCase.id}/resend/execute`,
            headers: {
                authorization: `Bearer ${adminToken}`,
            },
            payload: {
                decision: 'success',
                note: '第8轮补发执行测试',
            },
        });
        expect(executeResponse.statusCode).toBe(200);
        expect(executeResponse.json().resendStatus).toBe('succeeded');
        const detailResponse = await app.inject({
            method: 'GET',
            url: `/api/after-sales/${resendCase.id}`,
            headers: {
                authorization: `Bearer ${adminToken}`,
            },
        });
        expect(detailResponse.statusCode).toBe(200);
        const detailPayload = detailResponse.json();
        expect(detailPayload.resend.resendStatus).toBe('succeeded');
        expect(detailPayload.caseInfo.caseStatus).toBe('resolved');
        expect(detailPayload.artifacts.cardOutbounds.length).toBeGreaterThan(0);
    });
    it('售后中心支持登记争议结论和补偿金额', async () => {
        const listResponse = await app.inject({
            method: 'GET',
            url: '/api/after-sales?preset=last30Days&page=1&pageSize=20&caseType=dispute',
            headers: {
                authorization: `Bearer ${adminToken}`,
            },
        });
        expect(listResponse.statusCode).toBe(200);
        const disputeCase = listResponse
            .json()
            .list.find((row) => ['open', 'processing'].includes(row.disputeStatus));
        expect(disputeCase).toBeTruthy();
        const concludeResponse = await app.inject({
            method: 'POST',
            url: `/api/after-sales/${disputeCase.id}/dispute/conclude`,
            headers: {
                authorization: `Bearer ${adminToken}`,
            },
            payload: {
                decision: 'buyer_win',
                note: '第8轮争议结论测试',
                compensationAmount: 6.6,
            },
        });
        expect(concludeResponse.statusCode).toBe(200);
        expect(concludeResponse.json().disputeStatus).toBe('buyer_win');
        const detailResponse = await app.inject({
            method: 'GET',
            url: `/api/after-sales/${disputeCase.id}`,
            headers: {
                authorization: `Bearer ${adminToken}`,
            },
        });
        expect(detailResponse.statusCode).toBe(200);
        const detailPayload = detailResponse.json();
        expect(detailPayload.dispute.disputeStatus).toBe('buyer_win');
        expect(detailPayload.caseInfo.caseStatus).toBe('resolved');
        expect(Number(detailPayload.dispute.compensationAmount)).toBe(6.6);
    });
    it('报表中心返回真实经营统计并支持多店铺筛选', async () => {
        const optionsResponse = await app.inject({
            method: 'GET',
            url: '/api/options',
            headers: {
                authorization: `Bearer ${adminToken}`,
            },
        });
        expect(optionsResponse.statusCode).toBe(200);
        const options = optionsResponse.json();
        expect(options.stores.length).toBeGreaterThan(1);
        const storeIds = options.stores
            .slice(0, 2)
            .map((item) => item.value)
            .join(',');
        const response = await app.inject({
            method: 'GET',
            url: `/api/reports?preset=last90Days&storeIds=${storeIds}`,
            headers: {
                authorization: `Bearer ${adminToken}`,
            },
        });
        expect(response.statusCode).toBe(200);
        const payload = response.json();
        const selectedIds = new Set(storeIds.split(',').map((value) => Number(value)));
        expect(payload.summary).toHaveLength(4);
        expect(payload.storeStats.length).toBeGreaterThan(0);
        expect(payload.storeStats.every((row) => selectedIds.has(row.storeId))).toBe(true);
        expect(payload.productStats.length).toBeGreaterThan(0);
        expect(payload.orderStats.overview.length).toBeGreaterThan(0);
        expect(payload.orderStats.fulfillmentDistribution.length).toBeGreaterThan(0);
        expect(payload.afterSaleStats.typeDistribution.length).toBeGreaterThan(0);
        expect(payload.trend.length).toBeGreaterThan(0);
        const netProfitCard = payload.summary.find((item) => item.key === 'netProfit');
        const netProfitFormula = payload.formulas.find((item) => item.key === 'netProfit');
        expect(Number(netProfitCard.value)).toBe(Number(netProfitFormula.value));
    });
    it('报表导出内容与接口口径一致', async () => {
        const reportResponse = await app.inject({
            method: 'GET',
            url: '/api/reports?preset=last30Days',
            headers: {
                authorization: `Bearer ${adminToken}`,
            },
        });
        expect(reportResponse.statusCode).toBe(200);
        const payload = reportResponse.json();
        const exportResponse = await app.inject({
            method: 'GET',
            url: '/api/reports/export?preset=last30Days',
            headers: {
                authorization: `Bearer ${adminToken}`,
            },
        });
        expect(exportResponse.statusCode).toBe(200);
        expect(exportResponse.headers['content-type']).toContain('text/csv');
        expect(exportResponse.body).toContain('报表摘要');
        expect(exportResponse.body).toContain('店铺维度统计');
        expect(exportResponse.body).toContain('净利润');
        if (payload.storeStats.length > 0) {
            expect(exportResponse.body).toContain(payload.storeStats[0].storeName);
        }
    });
    it('统计看板摘要已切换到真实利润口径', async () => {
        const response = await app.inject({
            method: 'GET',
            url: '/api/dashboard?preset=today',
            headers: {
                authorization: `Bearer ${adminToken}`,
            },
        });
        expect(response.statusCode).toBe(200);
        const payload = response.json();
        expect(payload.summary.map((item) => item.key)).toEqual([
            'receivedAmount',
            'netSalesAmount',
            'netProfit',
            'grossMargin',
        ]);
        expect(payload.modules.todayCards.some((item) => String(item.label).includes('访客'))).toBe(false);
    });
    it('资金中心返回真实账本联动并支持店铺筛选', async () => {
        const initialResponse = await app.inject({
            method: 'GET',
            url: '/api/workspaces/fund-accounts/detail?preset=last90Days',
            headers: {
                authorization: `Bearer ${adminToken}`,
            },
        });
        expect(initialResponse.statusCode).toBe(200);
        const initialPayload = initialResponse.json();
        expect(initialPayload.kind).toBe('fund-accounts');
        expect(initialPayload.settlements.length).toBeGreaterThan(0);
        expect(initialPayload.refunds.length).toBeGreaterThan(0);
        expect(initialPayload.reconciliations.length).toBeGreaterThan(0);
        const selectedStoreIds = Array.from(new Set([
            initialPayload.refunds[0]?.storeId,
            initialPayload.settlements[0]?.storeId,
            ...initialPayload.settlements.map((item) => item.storeId),
        ].filter((value) => Number.isInteger(value) && value > 0))).slice(0, 2);
        expect(selectedStoreIds.length).toBeGreaterThan(0);
        const filteredResponse = await app.inject({
            method: 'GET',
            url: `/api/workspaces/fund-accounts/detail?preset=last90Days&storeIds=${selectedStoreIds.join(',')}`,
            headers: {
                authorization: `Bearer ${adminToken}`,
            },
        });
        expect(filteredResponse.statusCode).toBe(200);
        const filteredPayload = filteredResponse.json();
        const selectedIdSet = new Set(selectedStoreIds);
        expect(filteredPayload.settlements.length).toBeGreaterThan(0);
        expect(filteredPayload.refunds.length).toBeGreaterThan(0);
        expect(filteredPayload.reconciliations.length).toBeGreaterThan(0);
        expect(filteredPayload.settlements.every((item) => selectedIdSet.has(item.storeId))).toBe(true);
        expect(filteredPayload.refunds.every((item) => selectedIdSet.has(item.storeId))).toBe(true);
        expect(filteredPayload.reconciliations
            .filter((item) => item.storeId !== null)
            .every((item) => selectedIdSet.has(Number(item.storeId)))).toBe(true);
    });
    it('资金账单支持流水分类与异常对账标记', async () => {
        const detailResponse = await app.inject({
            method: 'GET',
            url: '/api/workspaces/fund-bills/detail?preset=last90Days',
            headers: {
                authorization: `Bearer ${adminToken}`,
            },
        });
        expect(detailResponse.statusCode).toBe(200);
        const detailPayload = detailResponse.json();
        expect(detailPayload.kind).toBe('fund-bills');
        const categories = new Set(detailPayload.rows.map((item) => item.billCategory));
        expect(categories.has('income')).toBe(true);
        expect(categories.has('refund')).toBe(true);
        expect(categories.has('fee')).toBe(true);
        expect(categories.has('withdrawal')).toBe(true);
        const row = detailPayload.rows.find((item) => item.reconciliationId !== null);
        expect(row).toBeTruthy();
        if (!row?.reconciliationId) {
            throw new Error('缺少可更新的对账记录');
        }
        const reviewResponse = await app.inject({
            method: 'POST',
            url: `/api/workspaces/fund-bills/reconciliations/${row.reconciliationId}/status`,
            headers: {
                authorization: `Bearer ${adminToken}`,
            },
            payload: {
                status: 'reviewed',
                note: '第10轮对账异常复核',
            },
        });
        expect(reviewResponse.statusCode).toBe(200);
        expect(reviewResponse.json().status).toBe('reviewed');
        const refreshedResponse = await app.inject({
            method: 'GET',
            url: '/api/workspaces/fund-bills/detail?preset=last90Days',
            headers: {
                authorization: `Bearer ${adminToken}`,
            },
        });
        expect(refreshedResponse.statusCode).toBe(200);
        const refreshedPayload = refreshedResponse.json();
        const refreshedRow = refreshedPayload.rows.find((item) => item.reconciliationId === row.reconciliationId);
        expect(refreshedRow).toBeTruthy();
        if (!refreshedRow) {
            throw new Error('未找到复核后的对账记录');
        }
        expect(refreshedRow.reconcileStatus).toBe('reviewed');
        expect(refreshedRow.reconcileStatusText).toBe('已复核');
    });
    it('资金中心支持提现申请与审核回写', async () => {
        const beforeAccountResponse = await app.inject({
            method: 'GET',
            url: '/api/workspaces/fund-accounts/detail?preset=last30Days',
            headers: {
                authorization: `Bearer ${adminToken}`,
            },
        });
        expect(beforeAccountResponse.statusCode).toBe(200);
        const beforeAccountPayload = beforeAccountResponse.json();
        const optionsResponse = await app.inject({
            method: 'GET',
            url: '/api/options',
            headers: {
                authorization: `Bearer ${adminToken}`,
            },
        });
        expect(optionsResponse.statusCode).toBe(200);
        const options = optionsResponse.json();
        expect(options.stores.length).toBeGreaterThan(0);
        const storeId = options.stores[0].value;
        const receivingAccount = `finance-round10-${Date.now()}@alipay`;
        const createResponse = await app.inject({
            method: 'POST',
            url: '/api/workspaces/fund-withdrawals/withdrawals',
            headers: {
                authorization: `Bearer ${adminToken}`,
            },
            payload: {
                amount: 120,
                storeId,
                method: '支付宝',
                receivingAccount,
            },
        });
        expect(createResponse.statusCode).toBe(200);
        expect(createResponse.json().status).toBe('pending');
        const pendingAccountResponse = await app.inject({
            method: 'GET',
            url: '/api/workspaces/fund-accounts/detail?preset=last30Days',
            headers: {
                authorization: `Bearer ${adminToken}`,
            },
        });
        expect(pendingAccountResponse.statusCode).toBe(200);
        const pendingAccountPayload = pendingAccountResponse.json();
        expect(Number(pendingAccountPayload.account.pendingWithdrawal)).toBe(Number(beforeAccountPayload.account.pendingWithdrawal) + 120);
        const withdrawalListResponse = await app.inject({
            method: 'GET',
            url: `/api/workspaces/fund-withdrawals/detail?preset=last30Days&storeId=${storeId}`,
            headers: {
                authorization: `Bearer ${adminToken}`,
            },
        });
        expect(withdrawalListResponse.statusCode).toBe(200);
        const withdrawalListPayload = withdrawalListResponse.json();
        const createdRow = withdrawalListPayload.rows.find((item) => item.receivingAccount === receivingAccount);
        expect(createdRow).toBeTruthy();
        if (!createdRow) {
            throw new Error('未找到新建提现记录');
        }
        expect(createdRow.status).toBe('pending');
        const approveResponse = await app.inject({
            method: 'POST',
            url: `/api/workspaces/fund-withdrawals/withdrawals/${createdRow.id}/status`,
            headers: {
                authorization: `Bearer ${adminToken}`,
            },
            payload: {
                status: 'paid',
            },
        });
        expect(approveResponse.statusCode).toBe(200);
        expect(approveResponse.json().status).toBe('paid');
        const paidListResponse = await app.inject({
            method: 'GET',
            url: `/api/workspaces/fund-withdrawals/detail?preset=last30Days&storeId=${storeId}`,
            headers: {
                authorization: `Bearer ${adminToken}`,
            },
        });
        expect(paidListResponse.statusCode).toBe(200);
        const paidListPayload = paidListResponse.json();
        const paidRow = paidListPayload.rows.find((item) => item.receivingAccount === receivingAccount);
        expect(paidRow).toBeTruthy();
        if (!paidRow) {
            throw new Error('未找到已审核提现记录');
        }
        expect(paidRow.status).toBe('paid');
        const afterAccountResponse = await app.inject({
            method: 'GET',
            url: '/api/workspaces/fund-accounts/detail?preset=last30Days',
            headers: {
                authorization: `Bearer ${adminToken}`,
            },
        });
        expect(afterAccountResponse.statusCode).toBe(200);
        const afterAccountPayload = afterAccountResponse.json();
        expect(Number(afterAccountPayload.account.pendingWithdrawal)).toBe(Number(beforeAccountPayload.account.pendingWithdrawal));
        const fundBillsResponse = await app.inject({
            method: 'GET',
            url: '/api/workspaces/fund-bills/detail?preset=last30Days',
            headers: {
                authorization: `Bearer ${adminToken}`,
            },
        });
        expect(fundBillsResponse.statusCode).toBe(200);
        const fundBillsPayload = fundBillsResponse.json();
        const withdrawalBillRow = fundBillsPayload.rows.find((item) => item.merchantOrderNo === paidRow.withdrawalNo &&
            item.billCategory === 'withdrawal' &&
            item.businessStatus === '已打款');
        expect(withdrawalBillRow).toBeTruthy();
    }, 15000);
    it('AI客服工作台返回会话、消息、知识库和策略配置', async () => {
        const detailResponse = await app.inject({
            method: 'GET',
            url: '/api/workspaces/ai-service/detail',
            headers: {
                authorization: `Bearer ${adminToken}`,
            },
        });
        expect(detailResponse.statusCode).toBe(200);
        const detailPayload = detailResponse.json();
        expect(detailPayload.kind).toBe('ai-service');
        expect(detailPayload.settings.aiEnabled).toBe(true);
        expect(detailPayload.conversations.length).toBeGreaterThanOrEqual(4);
        expect(detailPayload.recentMessages.length).toBeGreaterThan(0);
        expect(detailPayload.takeovers.length).toBeGreaterThan(0);
        expect(detailPayload.knowledgeItems.length).toBeGreaterThan(0);
        expect(detailPayload.replyTemplates.length).toBeGreaterThan(0);
    });
    it('AI客服支持 FAQ 复用回复和订单状态自动答复', async () => {
        const detailResponse = await app.inject({
            method: 'GET',
            url: '/api/workspaces/ai-service/detail',
            headers: {
                authorization: `Bearer ${adminToken}`,
            },
        });
        expect(detailResponse.statusCode).toBe(200);
        const detailPayload = detailResponse.json();
        const faqConversation = detailPayload.conversations.find((item) => item.source === 'FAQ');
        expect(faqConversation).toBeTruthy();
        if (!faqConversation) {
            throw new Error('缺少 FAQ 会话');
        }
        const faqReplyResponse = await app.inject({
            method: 'POST',
            url: `/api/workspaces/ai-service/conversations/${faqConversation.id}/ai-reply`,
            headers: {
                authorization: `Bearer ${adminToken}`,
            },
            payload: {},
        });
        expect(faqReplyResponse.statusCode).toBe(200);
        expect(faqReplyResponse.json().replyType).toBe('ai');
        expect(faqReplyResponse.json().reused).toBe(true);
        const orderConversation = detailPayload.conversations.find((item) => item.source === '订单查询');
        expect(orderConversation).toBeTruthy();
        if (!orderConversation) {
            throw new Error('缺少待答复的订单查询会话');
        }
        const orderReplyResponse = await app.inject({
            method: 'POST',
            url: `/api/workspaces/ai-service/conversations/${orderConversation.id}/ai-reply`,
            headers: {
                authorization: `Bearer ${adminToken}`,
            },
            payload: {},
        });
        expect(orderReplyResponse.statusCode).toBe(200);
        expect(orderReplyResponse.json().replyType).toBe('ai');
        expect(orderReplyResponse.json().reused).toBe(false);
        const refreshedResponse = await app.inject({
            method: 'GET',
            url: '/api/workspaces/ai-service/detail',
            headers: {
                authorization: `Bearer ${adminToken}`,
            },
        });
        expect(refreshedResponse.statusCode).toBe(200);
        const refreshedPayload = refreshedResponse.json();
        const refreshedOrderConversation = refreshedPayload.conversations.find((item) => item.id === orderConversation.id);
        expect(refreshedOrderConversation).toBeTruthy();
        expect(refreshedOrderConversation.aiStatus).toBe('auto_replied');
        expect(refreshedPayload.recentMessages.some((item) => item.conversationId === orderConversation.id && item.senderType === 'ai')).toBe(true);
    });
    it('AI客服支持售后建议、人工接管和策略配置更新', async () => {
        const detailResponse = await app.inject({
            method: 'GET',
            url: '/api/workspaces/ai-service/detail',
            headers: {
                authorization: `Bearer ${adminToken}`,
            },
        });
        expect(detailResponse.statusCode).toBe(200);
        const detailPayload = detailResponse.json();
        const afterSaleConversation = detailPayload.conversations.find((item) => item.source === '售后咨询' || (item.caseNo && item.aiStatus === 'ready'));
        expect(afterSaleConversation).toBeTruthy();
        if (!afterSaleConversation) {
            throw new Error('缺少待建议的售后会话');
        }
        const suggestionResponse = await app.inject({
            method: 'POST',
            url: `/api/workspaces/ai-service/conversations/${afterSaleConversation.id}/ai-reply`,
            headers: {
                authorization: `Bearer ${adminToken}`,
            },
            payload: {},
        });
        expect(suggestionResponse.statusCode).toBe(200);
        expect(suggestionResponse.json().replyType).toBe('suggestion');
        const highRiskConversation = detailPayload.conversations.find((item) => item.riskLevel === 'high');
        expect(highRiskConversation).toBeTruthy();
        if (!highRiskConversation) {
            throw new Error('缺少高风险会话');
        }
        const takeoverResponse = await app.inject({
            method: 'POST',
            url: `/api/workspaces/ai-service/conversations/${highRiskConversation.id}/takeover`,
            headers: {
                authorization: `Bearer ${adminToken}`,
            },
            payload: {
                action: 'takeover',
            },
        });
        expect(takeoverResponse.statusCode).toBe(200);
        expect(takeoverResponse.json().conversationStatus).toBe('manual_active');
        const manualReplyResponse = await app.inject({
            method: 'POST',
            url: `/api/workspaces/ai-service/conversations/${highRiskConversation.id}/manual-reply`,
            headers: {
                authorization: `Bearer ${adminToken}`,
            },
            payload: {
                content: '已转人工专员核对处理，会尽快给您最终结果。',
                closeConversation: true,
            },
        });
        expect(manualReplyResponse.statusCode).toBe(200);
        expect(manualReplyResponse.json().conversationStatus).toBe('resolved');
        const disableAiResponse = await app.inject({
            method: 'POST',
            url: '/api/workspaces/ai-service/settings',
            headers: {
                authorization: `Bearer ${adminToken}`,
            },
            payload: {
                aiEnabled: false,
            },
        });
        expect(disableAiResponse.statusCode).toBe(200);
        expect(disableAiResponse.json().settings.aiEnabled).toBe(false);
        const knowledgeItem = detailPayload.knowledgeItems[0];
        const template = detailPayload.replyTemplates[0];
        expect(knowledgeItem).toBeTruthy();
        expect(template).toBeTruthy();
        if (!knowledgeItem || !template) {
            throw new Error('缺少知识库或话术模板样例');
        }
        const toggleKnowledgeResponse = await app.inject({
            method: 'POST',
            url: `/api/workspaces/ai-service/knowledge-items/${knowledgeItem.id}/enabled`,
            headers: {
                authorization: `Bearer ${adminToken}`,
            },
            payload: {
                enabled: false,
            },
        });
        expect(toggleKnowledgeResponse.statusCode).toBe(200);
        expect(toggleKnowledgeResponse.json().enabled).toBe(false);
        const toggleTemplateResponse = await app.inject({
            method: 'POST',
            url: `/api/workspaces/ai-service/reply-templates/${template.id}/enabled`,
            headers: {
                authorization: `Bearer ${adminToken}`,
            },
            payload: {
                enabled: false,
            },
        });
        expect(toggleTemplateResponse.statusCode).toBe(200);
        expect(toggleTemplateResponse.json().enabled).toBe(false);
        const finalDetailResponse = await app.inject({
            method: 'GET',
            url: '/api/workspaces/ai-service/detail',
            headers: {
                authorization: `Bearer ${adminToken}`,
            },
        });
        expect(finalDetailResponse.statusCode).toBe(200);
        const finalPayload = finalDetailResponse.json();
        const finalHighRiskConversation = finalPayload.conversations.find((item) => item.id === highRiskConversation.id);
        const finalKnowledgeItem = finalPayload.knowledgeItems.find((item) => item.id === knowledgeItem.id);
        const finalTemplate = finalPayload.replyTemplates.find((item) => item.id === template.id);
        expect(finalHighRiskConversation).toBeTruthy();
        expect(finalKnowledgeItem).toBeTruthy();
        expect(finalTemplate).toBeTruthy();
        if (!finalHighRiskConversation || !finalKnowledgeItem || !finalTemplate) {
            throw new Error('AI 客服最终状态回写缺失');
        }
        expect(finalPayload.settings.aiEnabled).toBe(false);
        expect(finalHighRiskConversation.conversationStatus).toBe('resolved');
        expect(finalKnowledgeItem.enabled).toBe(false);
        expect(finalTemplate.enabled).toBe(false);
    });
    it('AI议价工作台返回策略、会话、模板和黑名单', async () => {
        const detailResponse = await app.inject({
            method: 'GET',
            url: '/api/workspaces/ai-bargain/detail',
            headers: {
                authorization: `Bearer ${adminToken}`,
            },
        });
        expect(detailResponse.statusCode).toBe(200);
        const detailPayload = detailResponse.json();
        expect(detailPayload.kind).toBe('ai-bargain');
        expect(detailPayload.settings.aiEnabled).toBe(true);
        expect(detailPayload.strategies.length).toBeGreaterThanOrEqual(3);
        expect(detailPayload.sessions.length).toBeGreaterThanOrEqual(4);
        expect(detailPayload.logs.length).toBeGreaterThan(0);
        expect(detailPayload.templates.length).toBeGreaterThan(0);
        expect(detailPayload.blacklists.length).toBeGreaterThan(0);
    });
    it('AI议价支持底价保护与自动成交', async () => {
        const detailResponse = await app.inject({
            method: 'GET',
            url: '/api/workspaces/ai-bargain/detail',
            headers: {
                authorization: `Bearer ${adminToken}`,
            },
        });
        expect(detailResponse.statusCode).toBe(200);
        const detailPayload = detailResponse.json();
        const floorSession = detailPayload.sessions.find((item) => item.topic === '底价保护');
        const acceptSession = detailPayload.sessions.find((item) => item.topic === '自动成交');
        expect(floorSession).toBeTruthy();
        expect(acceptSession).toBeTruthy();
        const normalizedFloorSession = floorSession && floorSession.boundaryLabel === '底价保护'
            ? floorSession
            : detailPayload.sessions.find((item) => item.boundaryLabel === '底价保护' &&
                item.riskLevel === 'low' &&
                item.latestBuyerOffer !== null &&
                Number(item.latestBuyerOffer) < Number(item.minPrice));
        const normalizedAcceptSession = acceptSession &&
            acceptSession.riskLevel === 'low' &&
            Number(acceptSession.latestBuyerOffer ?? 0) >= Number(acceptSession.targetPrice)
            ? acceptSession
            : detailPayload.sessions.find((item) => item.riskLevel === 'low' &&
                item.latestBuyerOffer !== null &&
                Number(item.latestBuyerOffer) >= Number(item.targetPrice));
        if (!normalizedFloorSession || !normalizedAcceptSession) {
            throw new Error('缺少 AI 议价测试会话');
        }
        const floorResponse = await app.inject({
            method: 'POST',
            url: `/api/workspaces/ai-bargain/bargain-sessions/${normalizedFloorSession.id}/evaluate`,
            headers: {
                authorization: `Bearer ${adminToken}`,
            },
            payload: {},
        });
        expect(floorResponse.statusCode).toBe(200);
        expect(floorResponse.json().outcome).toBe('counter_offer');
        expect(Number(floorResponse.json().offerPrice)).toBeGreaterThanOrEqual(Number(normalizedFloorSession.minPrice));
        const acceptResponse = await app.inject({
            method: 'POST',
            url: `/api/workspaces/ai-bargain/bargain-sessions/${normalizedAcceptSession.id}/evaluate`,
            headers: {
                authorization: `Bearer ${adminToken}`,
            },
            payload: {},
        });
        expect(acceptResponse.statusCode).toBe(200);
        expect(acceptResponse.json().outcome).toBe('accept');
        expect(acceptResponse.json().sessionStatus).toBe('agreed');
        const refreshedResponse = await app.inject({
            method: 'GET',
            url: '/api/workspaces/ai-bargain/detail',
            headers: {
                authorization: `Bearer ${adminToken}`,
            },
        });
        expect(refreshedResponse.statusCode).toBe(200);
        const refreshedPayload = refreshedResponse.json();
        const refreshedAcceptSession = refreshedPayload.sessions.find((item) => item.id === normalizedAcceptSession.id);
        expect(refreshedAcceptSession).toBeTruthy();
        expect(refreshedAcceptSession.sessionStatus).toBe('agreed');
        expect(refreshedPayload.logs.some((item) => item.sessionId === normalizedAcceptSession.id && item.actionType === 'accept')).toBe(true);
    });
    it('AI议价支持高风险转人工、策略更新和黑名单模板开关', async () => {
        const detailResponse = await app.inject({
            method: 'GET',
            url: '/api/workspaces/ai-bargain/detail',
            headers: {
                authorization: `Bearer ${adminToken}`,
            },
        });
        expect(detailResponse.statusCode).toBe(200);
        const detailPayload = detailResponse.json();
        const riskSession = detailPayload.sessions.find((item) => item.topic === '高风险黑名单');
        const strategy = detailPayload.strategies[0];
        const template = detailPayload.templates[0];
        const blacklist = detailPayload.blacklists[0];
        expect(riskSession).toBeTruthy();
        expect(strategy).toBeTruthy();
        expect(template).toBeTruthy();
        expect(blacklist).toBeTruthy();
        if (!riskSession || !strategy || !template || !blacklist) {
            throw new Error('缺少 AI 议价配置样本');
        }
        const riskResponse = await app.inject({
            method: 'POST',
            url: `/api/workspaces/ai-bargain/bargain-sessions/${riskSession.id}/evaluate`,
            headers: {
                authorization: `Bearer ${adminToken}`,
            },
            payload: {},
        });
        expect(riskResponse.statusCode).toBe(200);
        expect(riskResponse.json().outcome).toBe('blocked');
        expect(riskResponse.json().sessionStatus).toBe('pending_manual');
        const takeoverResponse = await app.inject({
            method: 'POST',
            url: `/api/workspaces/ai-bargain/bargain-sessions/${riskSession.id}/takeover`,
            headers: {
                authorization: `Bearer ${adminToken}`,
            },
            payload: {
                action: 'takeover',
            },
        });
        expect(takeoverResponse.statusCode).toBe(200);
        expect(takeoverResponse.json().sessionStatus).toBe('manual_active');
        const manualDecisionResponse = await app.inject({
            method: 'POST',
            url: `/api/workspaces/ai-bargain/bargain-sessions/${riskSession.id}/manual-decision`,
            headers: {
                authorization: `Bearer ${adminToken}`,
            },
            payload: {
                content: '当前会话已转人工，只能按人工审批价继续沟通。',
                action: 'counter_offer',
                offerPrice: Number(riskSession.minPrice) + 1,
            },
        });
        expect(manualDecisionResponse.statusCode).toBe(200);
        expect(manualDecisionResponse.json().sessionStatus).toBe('manual_active');
        const updateStrategyResponse = await app.inject({
            method: 'POST',
            url: `/api/workspaces/ai-bargain/bargain-strategies/${strategy.id}`,
            headers: {
                authorization: `Bearer ${adminToken}`,
            },
            payload: {
                minPrice: Number(strategy.minPrice) + 1,
                targetPrice: Number(strategy.targetPrice) + 1,
                stepPrice: Number(strategy.stepPrice),
                maxRounds: 4,
                enabled: true,
                riskTagsText: '重点,人工复核',
            },
        });
        expect(updateStrategyResponse.statusCode).toBe(200);
        const settingsResponse = await app.inject({
            method: 'POST',
            url: '/api/workspaces/ai-bargain/bargain-settings',
            headers: {
                authorization: `Bearer ${adminToken}`,
            },
            payload: {
                aiEnabled: false,
            },
        });
        expect(settingsResponse.statusCode).toBe(200);
        expect(settingsResponse.json().settings.aiEnabled).toBe(false);
        const toggleTemplateResponse = await app.inject({
            method: 'POST',
            url: `/api/workspaces/ai-bargain/bargain-templates/${template.id}/enabled`,
            headers: {
                authorization: `Bearer ${adminToken}`,
            },
            payload: {
                enabled: false,
            },
        });
        expect(toggleTemplateResponse.statusCode).toBe(200);
        expect(toggleTemplateResponse.json().enabled).toBe(false);
        const toggleBlacklistResponse = await app.inject({
            method: 'POST',
            url: `/api/workspaces/ai-bargain/bargain-blacklist/${blacklist.id}/enabled`,
            headers: {
                authorization: `Bearer ${adminToken}`,
            },
            payload: {
                enabled: false,
            },
        });
        expect(toggleBlacklistResponse.statusCode).toBe(200);
        expect(toggleBlacklistResponse.json().enabled).toBe(false);
        const finalResponse = await app.inject({
            method: 'GET',
            url: '/api/workspaces/ai-bargain/detail',
            headers: {
                authorization: `Bearer ${adminToken}`,
            },
        });
        expect(finalResponse.statusCode).toBe(200);
        const finalPayload = finalResponse.json();
        const finalStrategy = finalPayload.strategies.find((item) => item.id === strategy.id);
        const finalTemplate = finalPayload.templates.find((item) => item.id === template.id);
        const finalBlacklist = finalPayload.blacklists.find((item) => item.id === blacklist.id);
        const finalRiskSession = finalPayload.sessions.find((item) => item.id === riskSession.id);
        expect(finalStrategy).toBeTruthy();
        expect(finalTemplate).toBeTruthy();
        expect(finalBlacklist).toBeTruthy();
        expect(finalRiskSession).toBeTruthy();
        if (!finalStrategy || !finalTemplate || !finalBlacklist || !finalRiskSession) {
            throw new Error('AI 议价最终状态回写缺失');
        }
        expect(finalPayload.settings.aiEnabled).toBe(false);
        expect(Number(finalStrategy.minPrice)).toBe(Number(strategy.minPrice) + 1);
        expect(finalTemplate.enabled).toBe(false);
        expect(finalBlacklist.enabled).toBe(false);
        expect(finalRiskSession.sessionStatus).toBe('manual_active');
    });
    it('店铺接入中心返回多店铺、多状态和会话日志', async () => {
        const overview = await getStoreManagement();
        expect(overview.summaries.totalStoreCount).toBeGreaterThanOrEqual(7);
        expect(overview.summaries.xianyuStoreCount).toBeGreaterThanOrEqual(5);
        expect(overview.summaries.taobaoStoreCount).toBeGreaterThanOrEqual(2);
        expect(overview.summaries.pendingActivationCount).toBeGreaterThanOrEqual(1);
        expect(overview.summaries.offlineStoreCount).toBeGreaterThanOrEqual(1);
        expect(overview.summaries.abnormalStoreCount).toBeGreaterThanOrEqual(1);
        expect(overview.authSessions.length).toBeGreaterThan(0);
        expect(overview.healthChecks.length).toBeGreaterThan(0);
        expect(overview.groups.some((group) => group.name.length > 0)).toBe(true);
    });
    it('店铺元数据、启停和批量健康检查链路可用', async () => {
        const overview = await getStoreManagement();
        const disabledStore = overview.stores.find((store) => !store.enabled);
        expect(disabledStore).toBeTruthy();
        const updateMetaResponse = await app.inject({
            method: 'POST',
            url: `/api/stores/${disabledStore.id}/meta`,
            headers: {
                authorization: `Bearer ${adminToken}`,
            },
            payload: {
                groupName: '图书复盘组',
                tags: ['闲鱼', '批量停用', '复盘'],
                remark: '用于测试店铺标签与备注编辑',
            },
        });
        expect(updateMetaResponse.statusCode).toBe(200);
        expect(updateMetaResponse.json().store.groupName).toBe('图书复盘组');
        const singleHealthCheckResponse = await app.inject({
            method: 'POST',
            url: `/api/stores/${disabledStore.id}/health-check`,
            headers: {
                authorization: `Bearer ${adminToken}`,
            },
        });
        expect(singleHealthCheckResponse.statusCode).toBe(200);
        expect(singleHealthCheckResponse.json().status).toBe('skipped');
        const enableResponse = await app.inject({
            method: 'POST',
            url: `/api/stores/${disabledStore.id}/enabled`,
            headers: {
                authorization: `Bearer ${adminToken}`,
            },
            payload: {
                enabled: true,
            },
        });
        expect(enableResponse.statusCode).toBe(200);
        expect(enableResponse.json().store.enabled).toBe(true);
        const refreshedOverview = await getStoreManagement();
        const batchTargets = refreshedOverview.stores
            .filter((store) => store.enabled)
            .slice(0, 2)
            .map((store) => store.id);
        expect(batchTargets).toHaveLength(2);
        const batchDisableResponse = await app.inject({
            method: 'POST',
            url: '/api/stores/batch/enabled',
            headers: {
                authorization: `Bearer ${adminToken}`,
            },
            payload: {
                storeIds: batchTargets,
                enabled: false,
            },
        });
        expect(batchDisableResponse.statusCode).toBe(200);
        expect(batchDisableResponse.json().stores).toHaveLength(2);
        const batchHealthCheckResponse = await app.inject({
            method: 'POST',
            url: '/api/stores/batch/health-check',
            headers: {
                authorization: `Bearer ${adminToken}`,
            },
            payload: {
                storeIds: batchTargets,
            },
        });
        expect(batchHealthCheckResponse.statusCode).toBe(200);
        expect(batchHealthCheckResponse.json().checks).toHaveLength(2);
        expect(batchHealthCheckResponse.json().checks.every((check) => check.status === 'skipped')).toBe(true);
    });
    it('重新授权不会创建重复店铺，并会刷新授权状态', async () => {
        await withStoreAuthMode('xianyu_web_session', async () => {
        const overview = await getStoreManagement();
        const offlineStore = overview.stores.find((store) => store.connectionStatus === 'offline');
        expect(offlineStore).toBeTruthy();
        const totalStoreCount = overview.summaries.totalStoreCount;
        const sessionResponse = await app.inject({
            method: 'POST',
            url: '/api/stores/auth-sessions',
            headers: {
                authorization: `Bearer ${adminToken}`,
            },
            payload: {
                platform: offlineStore.platform,
                source: 'shop',
                authType: offlineStore.platform === 'xianyu' ? 11 : 21,
                storeId: offlineStore.id,
            },
        });
        expect(sessionResponse.statusCode).toBe(200);
        const session = sessionResponse.json();
        expect(session.reauthorize).toBe(true);
        expect(session.storeId).toBe(offlineStore.id);
        const syncResponse = await app.inject({
            method: 'POST',
            url: `/api/stores/auth-sessions/${session.sessionId}/web-session-sync`,
            headers: {
                authorization: `Bearer ${adminToken}`,
            },
            payload: {
                cookieText: 'cna=reauth-cookie; unb=reauth-unb; _m_h5_tk=reauth-token_123; cookie2=reauth-cookie2;',
                providerUserId: offlineStore.providerUserId ?? 'xy-user-reauth-1001',
                providerShopId: offlineStore.providerStoreId ?? 'xy-shop-reauth-2001',
                providerShopName: '重新授权店铺',
                mobile: '13800138111',
                nickname: '重新授权店铺',
                scopeText: 'item.read,item.write',
            },
        });
        expect(syncResponse.statusCode).toBe(200);
        const completed = syncResponse.json();
        expect(completed.reauthorized).toBe(true);
        expect(completed.storeId).toBe(offlineStore.id);
        expect(completed.activationStatus).toBe('active');
        const refreshed = await getStoreManagement();
        expect(refreshed.summaries.totalStoreCount).toBe(totalStoreCount);
        expect(refreshed.stores.filter((store) => store.id === offlineStore.id)).toHaveLength(1);
        const updatedStore = refreshed.stores.find((store) => store.id === offlineStore.id);
        expect(updatedStore.shopName).toBe('重新授权店铺');
        expect(updatedStore.authStatus).toBe('authorized');
        expect(updatedStore.connectionStatus).toBe('active');
        });
    });
    it('店铺管理支持创建闲鱼店铺并激活', async () => {
        await withStoreAuthMode('xianyu_web_session', async () => {
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
        expect(session.sessionId).toBeTruthy();
        expect(session.reauthorize).toBe(false);
        const syncResponse = await app.inject({
            method: 'POST',
            url: `/api/stores/auth-sessions/${session.sessionId}/web-session-sync`,
            headers: {
                authorization: `Bearer ${adminToken}`,
            },
            payload: {
                cookieText: 'cna=new-cookie; unb=new-unb; _m_h5_tk=new-token_123; cookie2=new-cookie2;',
                providerUserId: 'xy-user-new-1001',
                providerShopId: 'xy-shop-new-2001',
                providerShopName: '新增闲鱼店铺',
                mobile: '13800138000',
                nickname: '新增闲鱼店铺',
                scopeText: 'item.read,item.write',
            },
        });
        expect(syncResponse.statusCode).toBe(200);
        const completed = syncResponse.json();
        expect(completed.activationStatus).toBe('pending_activation');
        const activateResponse = await app.inject({
            method: 'POST',
            url: `/api/stores/${completed.storeId}/activate`,
            headers: {
                authorization: `Bearer ${adminToken}`,
            },
        });
        expect(activateResponse.statusCode).toBe(200);
        const refreshed = await getStoreManagement();
        const createdStore = refreshed.stores.find((store) => store.id === completed.storeId);
        expect(createdStore).toBeTruthy();
        expect(createdStore.platform).toBe('xianyu');
        expect(createdStore.connectionStatus).toBe('active');
        });
    });
    it('真实授权支持无登录态公共回调并更新接入下一步', async () => {
        const originalConfig = {
            storeAuthMode: appConfig.storeAuthMode,
            xianyuAppKey: appConfig.xianyuAppKey,
            xianyuAppSecret: appConfig.xianyuAppSecret,
            xianyuCallbackBaseUrl: appConfig.xianyuCallbackBaseUrl,
        };
        appConfig.storeAuthMode = 'xianyu_browser_oauth';
        appConfig.xianyuAppKey = '28189801';
        appConfig.xianyuAppSecret = 'demo-xianyu-app-secret';
        appConfig.xianyuCallbackBaseUrl = 'https://callback.example.com';
        try {
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
            expect(session.integrationMode).toBe('xianyu_browser_oauth');
            expect(session.authorizeUrl).toContain('open.api.goofish.com/authorize');
            const authorizeUrl = new URL(session.authorizeUrl);
            const state = authorizeUrl.searchParams.get('state');
            expect(state).toBeTruthy();
            const beforeDetailResponse = await app.inject({
                method: 'GET',
                url: `/api/stores/auth-sessions/${session.sessionId}`,
                headers: {
                    authorization: `Bearer ${adminToken}`,
                },
            });
            expect(beforeDetailResponse.statusCode).toBe(200);
            expect(beforeDetailResponse.json().nextStepKey).toBe('wait_provider_callback');
            const callbackResponse = await app.inject({
                method: 'POST',
                url: `/api/public/stores/auth-sessions/${session.sessionId}/provider-callback`,
                payload: {
                    accessToken: 'xianyu-test-access-token',
                    tokenType: 'bearer',
                    expiresInSeconds: 7200,
                    state,
                    rawCallback: JSON.stringify({
                        query: {},
                        hashParams: {
                            access_token: 'xianyu-test-access-token',
                            state,
                        },
                    }),
                },
            });
            expect(callbackResponse.statusCode).toBe(200);
            expect(callbackResponse.json().nextStep).toBe('sync_profile');
            expect(callbackResponse.json().nextStepText).toContain('绑店');
            const afterDetailResponse = await app.inject({
                method: 'GET',
                url: `/api/stores/auth-sessions/${session.sessionId}`,
                headers: {
                    authorization: `Bearer ${adminToken}`,
                },
            });
            expect(afterDetailResponse.statusCode).toBe(200);
            const detail = afterDetailResponse.json();
            expect(detail.tokenReceived).toBe(true);
            expect(detail.nextStepKey).toBe('sync_profile');
            expect(detail.providerAccessTokenMasked).toBeTruthy();
            const completeResponse = await app.inject({
                method: 'POST',
                url: `/api/stores/auth-sessions/${session.sessionId}/complete`,
                headers: {
                    authorization: `Bearer ${adminToken}`,
                },
                payload: {
                    mobile: '13800138000',
                    nickname: '真实授权骨架店铺',
                    loginMode: 'sms',
                },
            });
            expect(completeResponse.statusCode).toBe(409);
            const profileSyncResponse = await app.inject({
                method: 'POST',
                url: `/api/stores/auth-sessions/${session.sessionId}/profile-sync`,
                headers: {
                    authorization: `Bearer ${adminToken}`,
                },
                payload: {
                    providerUserId: 'xy-user-1001',
                    providerShopId: 'xy-shop-2001',
                    providerShopName: '真实授权骨架店铺',
                    mobile: '138****0000',
                    nickname: '真实授权骨架店铺',
                    scopeText: 'item.read,item.write',
                    refreshToken: 'xianyu-refresh-token',
                },
            });
            expect(profileSyncResponse.statusCode).toBe(200);
            expect(profileSyncResponse.json().shopName).toBe('真实授权骨架店铺');
            const finalDetailResponse = await app.inject({
                method: 'GET',
                url: `/api/stores/auth-sessions/${session.sessionId}`,
                headers: {
                    authorization: `Bearer ${adminToken}`,
                },
            });
            expect(finalDetailResponse.statusCode).toBe(200);
            const finalDetail = finalDetailResponse.json();
            expect(finalDetail.nextStepKey).toBe('done');
            expect(finalDetail.profileSyncStatus).toBe('success');
            expect(finalDetail.providerShopId).toBe('xy-shop-2001');
            const refreshed = await getStoreManagement();
            const createdStore = refreshed.stores.find((store) => store.providerStoreId === 'xy-shop-2001');
            expect(createdStore).toBeTruthy();
            expect(createdStore.shopName).toBe('真实授权骨架店铺');
            expect(createdStore.profileSyncStatus).toBe('success');
        }
        finally {
            appConfig.storeAuthMode = originalConfig.storeAuthMode;
            appConfig.xianyuAppKey = originalConfig.xianyuAppKey;
            appConfig.xianyuAppSecret = originalConfig.xianyuAppSecret;
            appConfig.xianyuCallbackBaseUrl = originalConfig.xianyuCallbackBaseUrl;
        }
    });
    it('网页登录态接入支持录入 Cookie 后直接完成绑店', async () => {
        const originalMode = appConfig.storeAuthMode;
        appConfig.storeAuthMode = 'xianyu_web_session';
        try {
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
            expect(session.integrationMode).toBe('xianyu_web_session');
            expect(session.authorizeUrl).toBeNull();
            expect(session.providerLabel).toBe('闲鱼网页登录态接入');
            const beforeDetailResponse = await app.inject({
                method: 'GET',
                url: `/api/stores/auth-sessions/${session.sessionId}`,
                headers: {
                    authorization: `Bearer ${adminToken}`,
                },
            });
            expect(beforeDetailResponse.statusCode).toBe(200);
            expect(beforeDetailResponse.json().nextStepKey).toBe('manual_complete');
            const syncResponse = await app.inject({
                method: 'POST',
                url: `/api/stores/auth-sessions/${session.sessionId}/web-session-sync`,
                headers: {
                    authorization: `Bearer ${adminToken}`,
                },
                payload: {
                    cookieText: 'cna=test-cookie; unb=test-unb; _m_h5_tk=test-token_123;',
                    providerUserId: 'xy-user-cookie-1001',
                    providerShopId: 'xy-shop-cookie-2001',
                    providerShopName: '网页登录态接入店铺',
                    mobile: '139****0000',
                    nickname: '网页登录态接入店铺',
                    scopeText: 'item.read,item.write',
                },
            });
            expect(syncResponse.statusCode).toBe(200);
            expect(syncResponse.json().shopName).toBe('网页登录态接入店铺');
            const finalDetailResponse = await app.inject({
                method: 'GET',
                url: `/api/stores/auth-sessions/${session.sessionId}`,
                headers: {
                    authorization: `Bearer ${adminToken}`,
                },
            });
            expect(finalDetailResponse.statusCode).toBe(200);
            const finalDetail = finalDetailResponse.json();
            expect(finalDetail.nextStepKey).toBe('done');
            expect(finalDetail.profileSyncStatus).toBe('success');
            expect(finalDetail.providerShopId).toBe('xy-shop-cookie-2001');
            expect(finalDetail.providerAccessTokenMasked).toBeTruthy();
            const refreshed = await getStoreManagement();
            const createdStore = refreshed.stores.find((store) => store.providerStoreId === 'xy-shop-cookie-2001');
            expect(createdStore).toBeTruthy();
            expect(createdStore.shopName).toBe('网页登录态接入店铺');
            expect(createdStore.profileSyncStatus).toBe('success');
        }
        finally {
            appConfig.storeAuthMode = originalMode;
        }
    });
    it('演示库跨天后重启会自动滚动到当天', async () => {
    });
    it('系统监控工作台返回告警、任务监控和恢复记录', async () => {
        const overviewResponse = await app.inject({
            method: 'GET',
            url: '/api/workspaces/system-monitoring',
            headers: {
                authorization: `Bearer ${adminToken}`,
            },
        });
        expect(overviewResponse.statusCode).toBe(200);
        const overview = overviewResponse.json();
        expect(overview.summary).toHaveLength(3);
        expect(overview.actions.length).toBeGreaterThan(0);
        const detailResponse = await app.inject({
            method: 'GET',
            url: '/api/workspaces/system-monitoring/detail',
            headers: {
                authorization: `Bearer ${adminToken}`,
            },
        });
        expect(detailResponse.statusCode).toBe(200);
        const detail = detailResponse.json();
        expect(detail.kind).toBe('system-monitoring');
        expect(detail.alerts.length).toBeGreaterThanOrEqual(4);
        expect(detail.jobMonitors.length).toBeGreaterThanOrEqual(4);
        expect(detail.backups.length).toBeGreaterThan(0);
        expect(detail.logArchives.length).toBeGreaterThan(0);
        expect(detail.recoveryDrills.length).toBeGreaterThan(0);
    });
    it('系统监控支持确认告警并扩展健康检查摘要', async () => {
        const detailResponse = await app.inject({
            method: 'GET',
            url: '/api/workspaces/system-monitoring/detail',
            headers: {
                authorization: `Bearer ${adminToken}`,
            },
        });
        expect(detailResponse.statusCode).toBe(200);
        const detail = detailResponse.json();
        const alert = detail.alerts.find((item) => item.status === 'open') ?? detail.alerts[0];
        expect(alert).toBeTruthy();
        const alertResponse = await app.inject({
            method: 'POST',
            url: `/api/workspaces/system-monitoring/alerts/${alert.id}/status`,
            headers: {
                authorization: `Bearer ${adminToken}`,
            },
            payload: {
                status: 'acknowledged',
            },
        });
        expect(alertResponse.statusCode).toBe(200);
        expect(alertResponse.json().status).toBe('acknowledged');
        const refreshedDetailResponse = await app.inject({
            method: 'GET',
            url: '/api/workspaces/system-monitoring/detail',
            headers: {
                authorization: `Bearer ${adminToken}`,
            },
        });
        expect(refreshedDetailResponse.statusCode).toBe(200);
        const refreshedDetail = refreshedDetailResponse.json();
        const updatedAlert = refreshedDetail.alerts.find((item) => item.id === alert.id);
        expect(updatedAlert).toBeTruthy();
        expect(updatedAlert.status).toBe('acknowledged');
        const healthResponse = await app.inject({
            method: 'GET',
            url: '/api/health',
        });
        expect(healthResponse.statusCode).toBe(200);
        expect(healthResponse.json()).toMatchObject({
            status: 'ok',
        });
        // /api/health 已精简为只返回基本状态，不再包含 database/alerts 详情
        expect(healthResponse.json().database).toBeUndefined();
    });
    it('系统监控支持执行备份、日志归档和恢复演练', async () => {
        const backupResponse = await app.inject({
            method: 'POST',
            url: '/api/workspaces/system-monitoring/backups/run',
            headers: {
                authorization: `Bearer ${adminToken}`,
            },
            payload: {},
        });
        expect(backupResponse.statusCode).toBe(200);
        const backupPayload = backupResponse.json();
        expect(backupPayload.runStatus).toBe('success');
        expect(fs.existsSync(backupPayload.filePath)).toBe(true);
        const archiveResponse = await app.inject({
            method: 'POST',
            url: '/api/workspaces/system-monitoring/log-archives/run',
            headers: {
                authorization: `Bearer ${adminToken}`,
            },
            payload: {},
        });
        expect(archiveResponse.statusCode).toBe(200);
        const archivePayload = archiveResponse.json();
        expect(archivePayload.logCount).toBeGreaterThan(0);
        expect(fs.existsSync(archivePayload.filePath)).toBe(true);
        const recoveryResponse = await app.inject({
            method: 'POST',
            url: '/api/workspaces/system-monitoring/recovery-drills/run',
            headers: {
                authorization: `Bearer ${adminToken}`,
            },
            payload: {},
        });
        expect(recoveryResponse.statusCode).toBe(200);
        const recoveryPayload = recoveryResponse.json();
        expect(recoveryPayload.status).toBe('success');
        expect(fs.existsSync(recoveryPayload.targetPath)).toBe(true);
    });
    it('婕旂ず搴撹法澶╁悗閲嶅惎浼氳嚜鍔ㄦ粴鍔ㄥ埌褰撳ぉ', async () => {
        const staleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'goofish-stale-'));
        const staleDbPath = path.join(staleDir, 'stale.db');
        const seededApp = await createApp({
            dbPath: staleDbPath,
            forceReseed: true,
            runtimeMode: 'demo',
            seedDemoData: true,
        });
        await seededApp.close();
        const db = new Database(staleDbPath);
        db.exec(`
      UPDATE orders
      SET
        order_no = 'GF' || replace(substr(datetime(paid_at, '-1 day'), 1, 10), '-', '') || substr(order_no, 11),
        paid_at = datetime(paid_at, '-1 day'),
        shipped_at = CASE WHEN shipped_at IS NULL THEN NULL ELSE datetime(shipped_at, '-1 day') END,
        completed_at = CASE WHEN completed_at IS NULL THEN NULL ELSE datetime(completed_at, '-1 day') END;
      UPDATE traffic_daily SET report_date = date(report_date, '-1 day');
      UPDATE customers SET registered_at = date(registered_at, '-1 day');
    `);
        const staleOrders = db
            .prepare("SELECT COUNT(*) AS count FROM orders WHERE substr(paid_at, 1, 10) = date('now', 'localtime')")
            .get();
        expect(staleOrders.count).toBe(0);
        db.close();
        const refreshedApp = await createApp({
            dbPath: staleDbPath,
            runtimeMode: 'demo',
            seedDemoData: true,
        });
        const loginResponse = await refreshedApp.inject({
            method: 'POST',
            url: '/api/auth/login',
            payload: {
                username: 'admin',
                password: 'Admin@123456',
            },
        });
        const refreshedToken = loginResponse.json().token;
        const response = await refreshedApp.inject({
            method: 'GET',
            url: '/api/dashboard?preset=today',
            headers: {
                authorization: `Bearer ${refreshedToken}`,
            },
        });
        expect(response.statusCode).toBe(200);
        const payload = response.json();
        expect(payload.modules.todayCards.some((item) => Number(item.value) > 0)).toBe(true);
        await refreshedApp.close();
        fs.rmSync(staleDir, { recursive: true, force: true });
    });
    it('prod 模式空库初始化时只创建管理员不注入演示数据', async () => {
        const isolatedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'goofish-prod-'));
        const isolatedDbPath = path.join(isolatedDir, 'prod.db');
        const prodApp = await createApp({
            dbPath: isolatedDbPath,
            forceReseed: true,
            runtimeMode: 'prod',
            seedDemoData: false,
            bootstrapAdmin: {
                username: 'owner',
                password: 'CompassShield@20260312!',
                displayName: '店主管理员',
            },
        });
        try {
            const loginResponse = await prodApp.inject({
                method: 'POST',
                url: '/api/auth/login',
                payload: {
                    username: 'owner',
                    password: 'CompassShield@20260312!',
                },
            });
            expect(loginResponse.statusCode).toBe(200);
            const healthResponse = await prodApp.inject({
                method: 'GET',
                url: '/api/health',
            });
            expect(healthResponse.statusCode).toBe(200);
            expect(healthResponse.json()).toMatchObject({ status: 'ok', runtimeMode: 'prod' });
            const isolatedDb = new Database(isolatedDbPath);
            const counts = isolatedDb
                .prepare(`
          SELECT
            (SELECT COUNT(*) FROM users) AS userCount,
            (SELECT COUNT(*) FROM orders) AS orderCount,
            (SELECT COUNT(*) FROM products) AS productCount,
            (SELECT COUNT(*) FROM managed_stores) AS managedStoreCount
        `)
                .get();
            isolatedDb.close();
            expect(counts.userCount).toBe(1);
            expect(counts.orderCount).toBe(0);
            expect(counts.productCount).toBe(0);
            expect(counts.managedStoreCount).toBe(0);
        }
        finally {
            await prodApp.close();
            fs.rmSync(isolatedDir, { recursive: true, force: true });
        }
    });
    it('旧库升级后会补齐缺失字段并正常启动', async () => {
        const legacyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'goofish-legacy-'));
        const legacyDbPath = path.join(legacyDir, 'legacy.db');
        const legacyDb = new Database(legacyDbPath);
        legacyDb.exec(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        role TEXT NOT NULL,
        password_hash TEXT NOT NULL
      );

      CREATE TABLE stores (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        manager TEXT NOT NULL
      );

      CREATE TABLE products (
        id INTEGER PRIMARY KEY,
        store_id INTEGER NOT NULL,
        sku TEXT NOT NULL,
        name TEXT NOT NULL,
        category TEXT NOT NULL,
        price REAL NOT NULL,
        cost REAL NOT NULL,
        stock INTEGER NOT NULL
      );

      CREATE TABLE customers (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        province TEXT NOT NULL,
        registered_at TEXT NOT NULL
      );

      CREATE TABLE orders (
        id INTEGER PRIMARY KEY,
        order_no TEXT NOT NULL UNIQUE,
        store_id INTEGER NOT NULL,
        product_id INTEGER NOT NULL,
        customer_id INTEGER NOT NULL,
        source TEXT NOT NULL,
        quantity INTEGER NOT NULL,
        paid_amount REAL NOT NULL,
        discount_amount REAL NOT NULL,
        order_status TEXT NOT NULL,
        after_sale_status TEXT NOT NULL,
        refund_amount REAL NOT NULL DEFAULT 0,
        paid_at TEXT NOT NULL,
        shipped_at TEXT,
        completed_at TEXT,
        delivery_hours REAL NOT NULL DEFAULT 0,
        is_new_customer INTEGER NOT NULL DEFAULT 0
      );

      CREATE INDEX idx_orders_paid_at ON orders(paid_at);
      CREATE INDEX idx_orders_store_paid_at ON orders(store_id, paid_at);

      CREATE TABLE fund_bills (
        id INTEGER PRIMARY KEY,
        trade_time TEXT NOT NULL,
        bill_no TEXT NOT NULL,
        merchant_order_no TEXT NOT NULL,
        payment_no TEXT NOT NULL,
        item_name TEXT NOT NULL,
        item_info TEXT NOT NULL,
        amount REAL NOT NULL,
        trade_type TEXT NOT NULL,
        trade_method TEXT NOT NULL,
        balance_after REAL NOT NULL,
        remark TEXT NOT NULL
      );

      CREATE TABLE fund_withdrawals (
        id INTEGER PRIMARY KEY,
        withdrawal_no TEXT NOT NULL,
        trade_time TEXT NOT NULL,
        trade_no TEXT NOT NULL,
        trade_type TEXT NOT NULL,
        amount REAL NOT NULL,
        fee REAL NOT NULL,
        arrival_amount REAL NOT NULL,
        available_balance REAL NOT NULL,
        status TEXT NOT NULL,
        method TEXT NOT NULL,
        receiving_account TEXT NOT NULL,
        review_remark TEXT NOT NULL
      );

      CREATE TABLE fund_deposits (
        id INTEGER PRIMARY KEY,
        deposit_type TEXT NOT NULL,
        industry TEXT NOT NULL,
        status TEXT NOT NULL,
        amount REAL NOT NULL,
        operate_time TEXT NOT NULL,
        action_label TEXT NOT NULL,
        trade_time TEXT NOT NULL,
        payment_no TEXT NOT NULL,
        trade_amount REAL NOT NULL,
        trade_type TEXT NOT NULL,
        description TEXT NOT NULL
      );

      CREATE TABLE fund_orders (
        id INTEGER PRIMARY KEY,
        created_at TEXT NOT NULL,
        paid_at TEXT NOT NULL,
        order_item TEXT NOT NULL,
        cycle_text TEXT NOT NULL,
        order_content TEXT NOT NULL,
        paid_amount REAL NOT NULL,
        merchant_order_no TEXT NOT NULL,
        bill_no TEXT NOT NULL,
        payment_no TEXT NOT NULL
      );
    `);
        legacyDb
            .prepare(`
          INSERT INTO users (id, username, display_name, role, password_hash)
          VALUES (?, ?, ?, ?, ?)
        `)
            .run(1, 'legacy-admin', '旧库管理员', 'admin', hashPassword('Legacy@123456'));
        legacyDb.close();
        const legacyApp = await createApp({
            dbPath: legacyDbPath,
            runtimeMode: 'prod',
            seedDemoData: false,
        });
        try {
            const healthResponse = await legacyApp.inject({
                method: 'GET',
                url: '/api/health',
            });
            expect(healthResponse.statusCode).toBe(200);
            expect(healthResponse.json()).toMatchObject({ status: 'ok', runtimeMode: 'prod' });
            const migratedDb = new Database(legacyDbPath, { readonly: true });
            const orderColumns = migratedDb
                .prepare('PRAGMA table_info(orders)')
                .all();
            const fundBillColumns = migratedDb
                .prepare('PRAGMA table_info(fund_bills)')
                .all();
            const fundWithdrawalColumns = migratedDb
                .prepare('PRAGMA table_info(fund_withdrawals)')
                .all();
            const fundDepositColumns = migratedDb
                .prepare('PRAGMA table_info(fund_deposits)')
                .all();
            const fundOrderColumns = migratedDb
                .prepare('PRAGMA table_info(fund_orders)')
                .all();
            expect(orderColumns.some((column) => column.name === 'main_status')).toBe(true);
            expect(orderColumns.some((column) => column.name === 'payment_status')).toBe(true);
            expect(orderColumns.some((column) => column.name === 'delivery_status')).toBe(true);
            expect(fundBillColumns.some((column) => column.name === 'store_id')).toBe(true);
            expect(fundWithdrawalColumns.some((column) => column.name === 'store_id')).toBe(true);
            expect(fundDepositColumns.some((column) => column.name === 'store_id')).toBe(true);
            expect(fundOrderColumns.some((column) => column.name === 'store_id')).toBe(true);
            migratedDb.close();
        }
        finally {
            await legacyApp.close();
            fs.rmSync(legacyDir, { recursive: true, force: true });
        }
    });
    it('网页登录态接入支持扫码登录收票并进入待绑店阶段', async () => {
        const originalMode = appConfig.storeAuthMode;
        appConfig.storeAuthMode = 'xianyu_web_session';
        vi.spyOn(xianyuWebSessionService.xianyuQrLoginManager, 'create').mockResolvedValue({
            qrLoginId: 'qr-login-1',
            authSessionId: 'ignored',
            status: 'waiting',
            qrCodeUrl: 'data:image/png;base64,qr',
            createdAt: '2026-03-13 10:00:00',
            expiresAt: '2026-03-13 10:05:00',
            lastPolledAt: null,
            verificationUrl: null,
            hasCookies: false,
            cookieMasked: null,
            failureReason: null,
        });
        vi.spyOn(xianyuWebSessionService.xianyuQrLoginManager, 'getByAuthSessionId').mockReturnValue({
            qrLoginId: 'qr-login-1',
            authSessionId: 'ignored',
            status: 'success',
            qrCodeUrl: 'data:image/png;base64,qr',
            createdAt: '2026-03-13 10:00:00',
            expiresAt: '2026-03-13 10:05:00',
            lastPolledAt: '2026-03-13 10:00:10',
            verificationUrl: null,
            hasCookies: true,
            cookieMasked: 'tes***123',
            failureReason: null,
        });
        vi.spyOn(xianyuWebSessionService.xianyuQrLoginManager, 'consumeSuccessCookies').mockReturnValue({
            qrLoginId: 'qr-login-1',
            authSessionId: 'ignored',
            cookieText: 'cna=qr-cookie; unb=qr-unb; _m_h5_tk=qr-token_123; cookie2=qr-cookie2;',
            unb: 'qr-unb',
            source: 'qr_login',
        });
        vi.spyOn(xianyuWebSessionService, 'verifyXianyuWebSessionCookie').mockResolvedValue({
            riskLevel: 'healthy',
            detail: '扫码登录态可用。',
            verificationUrl: null,
            refreshedCookieText: null,
            rawRet: ['SUCCESS::调用成功'],
        });
        try {
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
            const generateResponse = await app.inject({
                method: 'POST',
                url: `/api/stores/auth-sessions/${session.sessionId}/qr-login/generate`,
                headers: {
                    authorization: `Bearer ${adminToken}`,
                },
            });
            expect(generateResponse.statusCode).toBe(200);
            expect(generateResponse.json().qrLoginId).toBe('qr-login-1');
            const statusResponse = await app.inject({
                method: 'GET',
                url: `/api/stores/auth-sessions/${session.sessionId}/qr-login`,
                headers: {
                    authorization: `Bearer ${adminToken}`,
                },
            });
            expect(statusResponse.statusCode).toBe(200);
            expect(statusResponse.json().status).toBe('success');
            const acceptResponse = await app.inject({
                method: 'POST',
                url: `/api/stores/auth-sessions/${session.sessionId}/qr-login/accept`,
                headers: {
                    authorization: `Bearer ${adminToken}`,
                },
            });
            expect(acceptResponse.statusCode).toBe(200);
            expect(acceptResponse.json().nextStep).toBe('sync_profile');
            const detailResponse = await app.inject({
                method: 'GET',
                url: `/api/stores/auth-sessions/${session.sessionId}`,
                headers: {
                    authorization: `Bearer ${adminToken}`,
                },
            });
            expect(detailResponse.statusCode).toBe(200);
            expect(detailResponse.json().tokenReceived).toBe(true);
            expect(detailResponse.json().nextStepKey).toBe('sync_profile');
        }
        finally {
            appConfig.storeAuthMode = originalMode;
        }
    });
    it('网页登录态接入支持校验 Cookie 风控状态', async () => {
        const originalMode = appConfig.storeAuthMode;
        appConfig.storeAuthMode = 'xianyu_web_session';
        try {
            const { store } = await createXianyuWebSessionStore({
                providerUserId: 'xy-user-verify-1001',
                providerShopId: 'xy-shop-verify-2001',
                providerShopName: '登录态校验店铺',
                mobile: '139****1001',
            });
            vi.spyOn(xianyuWebSessionService, 'verifyXianyuWebSessionCookie').mockResolvedValue({
                riskLevel: 'warning',
                detail: '命中风控，需要补做验证。',
                verificationUrl: 'https://verify.goofish.com/risk',
                refreshedCookieText: 'cna=verify-new; unb=verify-unb; _m_h5_tk=verify-token_123; cookie2=verify-cookie2;',
                rawRet: ['FAIL_SYS_USER_VALIDATE::风控验证'],
            });
            const verifyResponse = await app.inject({
                method: 'POST',
                url: `/api/stores/${store.id}/credential-verify`,
                headers: {
                    authorization: `Bearer ${adminToken}`,
                },
            });
            expect(verifyResponse.statusCode).toBe(200);
            expect(verifyResponse.json().riskLevel).toBe('warning');
            expect(verifyResponse.json().verificationUrl).toBe('https://verify.goofish.com/risk');
            const management = await getStoreManagement();
            const refreshedStore = management.stores.find((item) => item.id === store.id);
            expect(refreshedStore).toBeTruthy();
            expect(refreshedStore.credentialRiskLevel).toBe('warning');
            expect(refreshedStore.credentialVerificationUrl).toBe('https://verify.goofish.com/risk');
        }
        finally {
            appConfig.storeAuthMode = originalMode;
        }
    });
    it('网页登录态接入支持浏览器续登并刷新凭据状态', async () => {
        const originalMode = appConfig.storeAuthMode;
        appConfig.storeAuthMode = 'xianyu_web_session';
        try {
            const { store } = await createXianyuWebSessionStore({
                providerUserId: 'xy-user-renew-1001',
                providerShopId: 'xy-shop-renew-2001',
                providerShopName: '浏览器续登店铺',
                mobile: '139****1002',
            });
            vi.spyOn(xianyuWebSessionService, 'renewXianyuWebSessionCookieViaBrowser').mockResolvedValue({
                renewed: true,
                cookieText: 'cna=renewed; unb=renew-unb; _m_h5_tk=renew-token_123; cookie2=renew-cookie2;',
                currentUrl: 'https://www.goofish.com/im',
                pageTitle: '闲鱼消息',
                verificationUrl: null,
                detail: '浏览器续登成功。',
            });
            vi.spyOn(xianyuWebSessionService, 'verifyXianyuWebSessionCookie').mockResolvedValue({
                riskLevel: 'healthy',
                detail: '续登后的 Cookie 校验通过。',
                verificationUrl: null,
                refreshedCookieText: null,
                rawRet: ['SUCCESS::调用成功'],
            });
            const renewResponse = await app.inject({
                method: 'POST',
                url: `/api/stores/${store.id}/browser-renew`,
                headers: {
                    authorization: `Bearer ${adminToken}`,
                },
                payload: {
                    showBrowser: false,
                },
            });
            expect(renewResponse.statusCode).toBe(200);
            expect(renewResponse.json().renewed).toBe(true);
            expect(renewResponse.json().riskLevel).toBe('healthy');
            const management = await getStoreManagement();
            const refreshedStore = management.stores.find((item) => item.id === store.id);
            expect(refreshedStore).toBeTruthy();
            expect(refreshedStore.credentialRiskLevel).toBe('healthy');
            expect(refreshedStore.lastCredentialRenewStatus).toBe('浏览器续登成功。');
        }
        finally {
            appConfig.storeAuthMode = originalMode;
        }
    });
    it('AI议价支持同步真实闲鱼会话并自动评估且重复同步不重复落库', async () => {
        const isolatedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'goofish-ai-bargain-'));
        const isolatedDbPath = path.join(isolatedDir, 'test.db');
        const isolatedApp = await createApp({
            dbPath: isolatedDbPath,
            forceReseed: true,
            runtimeMode: 'demo',
            seedDemoData: true,
        });
        try {
            const loginResponse = await isolatedApp.inject({
                method: 'POST',
                url: '/api/auth/login',
                payload: {
                    username: 'admin',
                    password: 'Admin@123456',
                },
            });
            expect(loginResponse.statusCode).toBe(200);
            const isolatedAdminToken = loginResponse.json().token;
            await withStoreAuthMode('xianyu_web_session', async () => {
            const sessionResponse = await isolatedApp.inject({
                method: 'POST',
                url: '/api/stores/auth-sessions',
                headers: {
                    authorization: `Bearer ${isolatedAdminToken}`,
                },
                payload: {
                    platform: 'xianyu',
                    source: 'shop',
                    authType: 11,
                },
            });
            expect(sessionResponse.statusCode).toBe(200);
            const session = sessionResponse.json();
            const webSessionSyncResponse = await isolatedApp.inject({
                method: 'POST',
                url: `/api/stores/auth-sessions/${session.sessionId}/web-session-sync`,
                headers: {
                    authorization: `Bearer ${isolatedAdminToken}`,
                },
                payload: {
                    cookieText: 'cna=test-cookie; unb=test-unb; _m_h5_tk=test-token_123; cookie2=abc;',
                    providerUserId: 'xy-user-ai-bargain-1001',
                    providerShopId: 'xy-shop-ai-bargain-2001',
                    providerShopName: '真实议价同步店铺',
                    mobile: '139****1005',
                    nickname: '真实议价同步店铺',
                    scopeText: 'item.read,item.write',
                },
            });
            expect(webSessionSyncResponse.statusCode).toBe(200);
            const managementResponse = await isolatedApp.inject({
                method: 'GET',
                url: '/api/stores/management',
                headers: {
                    authorization: `Bearer ${isolatedAdminToken}`,
                },
            });
            expect(managementResponse.statusCode).toBe(200);
            const store = managementResponse
                .json()
                .stores.find((item) => item.providerStoreId === 'xy-shop-ai-bargain-2001');
            expect(store).toBeTruthy();
            if (!store) {
                throw new Error('缺少真实 AI 议价同步店铺');
            }
            vi.spyOn(xianyuWebSessionService, 'fetchXianyuWebSessionProducts').mockResolvedValue({
                items: [
                    {
                        id: '92001001',
                        title: '真实议价测试商品',
                        categoryId: '1001',
                        categoryLabel: '会员',
                        price: 299,
                        soldPrice: null,
                        itemStatus: 1,
                        itemStatusText: '销售中',
                        stock: 8,
                        coverUrl: null,
                        detailUrl: null,
                    },
                ],
                totalCount: 1,
                pageCount: 1,
                rawRet: ['SUCCESS::调用成功'],
            });
            const productSyncResponse = await isolatedApp.inject({
                method: 'POST',
                url: '/api/products/xianyu-web-sync',
                headers: {
                    authorization: `Bearer ${isolatedAdminToken}`,
                },
                payload: {
                    storeIds: [store.id],
                    pageSize: 20,
                    maxPages: 1,
                },
            });
            expect(productSyncResponse.statusCode).toBe(200);
            expect(productSyncResponse.json().successCount).toBe(1);
            const fetchBargainSessionsSpy = vi.spyOn(xianyuWebSessionService, 'fetchXianyuWebSessionBargainSessions').mockResolvedValue({
                sessions: [
                    {
                        sessionId: '57580658382',
                        sessionType: 1,
                        sellerUserId: '2219728876568',
                        sellerName: '真实议价同步店铺',
                        buyerUserId: '99887766',
                        buyerName: '真实买家A',
                        itemId: '92001001',
                        itemMainPic: null,
                        summaryText: '200元可以吗',
                        summaryVersion: 12,
                        summaryTimestamp: '2026-03-16 10:02:00',
                        unreadCount: 1,
                        sortIndex: 100,
                        hasMoreMessages: false,
                        messages: [
                            {
                                messageId: 'msg-1',
                                sessionId: '57580658382',
                                sessionType: 1,
                                senderRole: 'buyer',
                                senderUserId: '99887766',
                                senderName: '真实买家A',
                                text: '200元可以吗',
                                sentAt: '2026-03-16 10:02:00',
                                version: 12,
                                rawContentType: 101,
                            },
                        ],
                    },
                ],
                totalCount: 1,
                pageCount: 1,
                rawRet: ['SUCCESS::调用成功'],
            });
            const socketAuthCache = {
                appKey: '444e9908a51d1cb236a27862abc769c9',
                cacheHeader: 'app-key token ua wv',
                token: 'im-token-1',
                ua: 'Mozilla/5.0 test',
                dt: 'j',
                wv: 'im:3,au:3,sy:6',
                sync: '0,0;0;0;',
                did: 'device-1',
                capturedAt: '2026-03-16 10:05:00',
                expiresAt: '2026-03-16 10:55:00',
            };
            fetchBargainSessionsSpy.mockClear();
            fetchBargainSessionsSpy.mockResolvedValueOnce({
                sessions: [
                    {
                        sessionId: '57580658382',
                        sessionType: 1,
                        sellerUserId: '2219728876568',
                        sellerName: '真实议价同步店铺',
                        buyerUserId: '99887766',
                        buyerName: '真实买家A',
                        itemId: '92001001',
                        itemMainPic: null,
                        summaryText: '最低200可以吗',
                        summaryVersion: 12,
                        summaryTimestamp: '2026-03-16 10:02:00',
                        unreadCount: 1,
                        sortIndex: 100,
                        hasMoreMessages: false,
                        messages: [
                            {
                                messageId: 'msg-1',
                                sessionId: '57580658382',
                                sessionType: 1,
                                senderRole: 'buyer',
                                senderUserId: '99887766',
                                senderName: '真实买家A',
                                text: '最低200可以吗',
                                sentAt: '2026-03-16 10:02:00',
                                version: 12,
                                rawContentType: 101,
                            },
                        ],
                    },
                ],
                totalCount: 1,
                pageCount: 1,
                rawRet: ['SUCCESS::璋冪敤鎴愬姛'],
                refreshedCookieText: 'cna=refreshed-cookie; unb=refreshed-unb; _m_h5_tk=refreshed-token_123; cookie2=refreshed-cookie2;',
                socketAuthCache,
            });
            fetchBargainSessionsSpy.mockResolvedValueOnce({
                sessions: [
                    {
                        sessionId: '57580658382',
                        sessionType: 1,
                        sellerUserId: '2219728876568',
                        sellerName: '真实议价同步店铺',
                        buyerUserId: '99887766',
                        buyerName: '真实买家A',
                        itemId: '92001001',
                        itemMainPic: null,
                        summaryText: '最低200可以吗',
                        summaryVersion: 12,
                        summaryTimestamp: '2026-03-16 10:02:00',
                        unreadCount: 1,
                        sortIndex: 100,
                        hasMoreMessages: false,
                        messages: [
                            {
                                messageId: 'msg-1',
                                sessionId: '57580658382',
                                sessionType: 1,
                                senderRole: 'buyer',
                                senderUserId: '99887766',
                                senderName: '真实买家A',
                                text: '最低200可以吗',
                                sentAt: '2026-03-16 10:02:00',
                                version: 12,
                                rawContentType: 101,
                            },
                        ],
                    },
                ],
                totalCount: 1,
                pageCount: 1,
                rawRet: ['SOCKET_AUTH_CACHE::HIT'],
            });
            const syncResponse = await isolatedApp.inject({
                method: 'POST',
                url: '/api/workspaces/ai-bargain/bargain-sync',
                headers: {
                    authorization: `Bearer ${isolatedAdminToken}`,
                },
                payload: {
                    storeIds: [store.id],
                    maxSessionsPerStore: 10,
                    maxMessagesPerSession: 10,
                },
            });
            expect(syncResponse.statusCode).toBe(200);
            const syncPayload = syncResponse.json();
            expect(syncPayload.successCount).toBe(1);
            expect(syncPayload.results[0].candidateSessionCount).toBe(1);
            expect(syncPayload.results[0].syncedSessionCount).toBe(1);
            expect(syncPayload.results[0].createdSessionCount).toBe(1);
            expect(syncPayload.results[0].createdStrategyCount).toBe(1);
            expect(syncPayload.results[0].autoEvaluatedCount).toBe(1);
            expect(fetchBargainSessionsSpy.mock.calls[0]?.[0]?.cachedSocketAuth).toBeNull();
            const sqlite = new Database(isolatedDbPath);
            try {
                const cacheRow = sqlite
                    .prepare(`SELECT source, captured_at AS capturedAt, expires_at AS expiresAt FROM xianyu_im_session_auth_cache WHERE store_id = ?`)
                    .get(store.id);
                expect(cacheRow).toBeTruthy();
                expect(cacheRow.source).toBe('ai_bargain_sync');
                expect(cacheRow.capturedAt).toBe('2026-03-16 10:05:00');
                expect(cacheRow.expiresAt).toBe('2026-03-16 10:55:00');
            }
            finally {
                sqlite.close();
            }
            const detailResponse = await isolatedApp.inject({
                method: 'GET',
                url: '/api/workspaces/ai-bargain/detail',
                headers: {
                    authorization: `Bearer ${isolatedAdminToken}`,
                },
            });
            expect(detailResponse.statusCode).toBe(200);
            const detailPayload = detailResponse.json();
            const sessionNo = `XYIM-${store.id}-57580658382`;
            const syncedSession = detailPayload.sessions.find((item) => item.sessionNo === sessionNo);
            expect(syncedSession).toBeTruthy();
            if (!syncedSession) {
                throw new Error('缺少真实 AI 议价同步会话');
            }
            expect(syncedSession.customerName).toBe('真实买家A');
            expect(syncedSession.sessionStatus).toBe('bargaining');
            expect(syncedSession.aiStatus).toBe('auto_countered');
            expect(Number(syncedSession.latestBuyerOffer)).toBe(200);
            expect(detailPayload.strategies.filter((item) => item.productId === 92001001)).toHaveLength(1);
            expect(detailPayload.logs.some((item) => item.sessionId === syncedSession.id && item.actionType === 'buyer_offer')).toBe(true);
            expect(detailPayload.logs.some((item) => item.sessionId === syncedSession.id && item.actionType === 'counter_offer')).toBe(true);
            const initialLogCount = detailPayload.logs.filter((item) => item.sessionId === syncedSession.id).length;
            const secondSyncResponse = await isolatedApp.inject({
                method: 'POST',
                url: '/api/workspaces/ai-bargain/bargain-sync',
                headers: {
                    authorization: `Bearer ${isolatedAdminToken}`,
                },
                payload: {
                    storeIds: [store.id],
                    maxSessionsPerStore: 10,
                    maxMessagesPerSession: 10,
                },
            });
            expect(secondSyncResponse.statusCode).toBe(200);
            expect(secondSyncResponse.json().successCount).toBe(1);
            expect(fetchBargainSessionsSpy.mock.calls[1]?.[0]?.cachedSocketAuth).toMatchObject({
                token: 'im-token-1',
                did: 'device-1',
                expiresAt: '2026-03-16 10:55:00',
            });
            const finalDetailResponse = await isolatedApp.inject({
                method: 'GET',
                url: '/api/workspaces/ai-bargain/detail',
                headers: {
                    authorization: `Bearer ${isolatedAdminToken}`,
                },
            });
            expect(finalDetailResponse.statusCode).toBe(200);
            const finalPayload = finalDetailResponse.json();
            expect(finalPayload.sessions.filter((item) => item.sessionNo === sessionNo)).toHaveLength(1);
            expect(finalPayload.strategies.filter((item) => item.productId === 92001001)).toHaveLength(1);
            expect(finalPayload.logs.filter((item) => item.sessionId === syncedSession.id)).toHaveLength(initialLogCount);
            });
        }
        finally {
            await isolatedApp.close();
            fs.rmSync(isolatedDir, { recursive: true, force: true });
        }
    });
    it('AI客服支持同步真实闲鱼会话并把 AI/人工回复发到真实 IM', async () => {
        const isolatedDir = fs.mkdtempSync(path.join(os.tmpdir(), 'goofish-ai-service-'));
        const isolatedDbPath = path.join(isolatedDir, 'test.db');
        const isolatedApp = await createApp({
            dbPath: isolatedDbPath,
            forceReseed: true,
            runtimeMode: 'demo',
            seedDemoData: true,
        });
        try {
            const loginResponse = await isolatedApp.inject({
                method: 'POST',
                url: '/api/auth/login',
                payload: {
                    username: 'admin',
                    password: 'Admin@123456',
                },
            });
            expect(loginResponse.statusCode).toBe(200);
            const isolatedAdminToken = loginResponse.json().token;
            await withStoreAuthMode('xianyu_web_session', async () => {
            const sessionResponse = await isolatedApp.inject({
                method: 'POST',
                url: '/api/stores/auth-sessions',
                headers: {
                    authorization: `Bearer ${isolatedAdminToken}`,
                },
                payload: {
                    platform: 'xianyu',
                    source: 'shop',
                    authType: 11,
                },
            });
            expect(sessionResponse.statusCode).toBe(200);
            const session = sessionResponse.json();
            const webSessionSyncResponse = await isolatedApp.inject({
                method: 'POST',
                url: `/api/stores/auth-sessions/${session.sessionId}/web-session-sync`,
                headers: {
                    authorization: `Bearer ${isolatedAdminToken}`,
                },
                payload: {
                    cookieText: 'cna=test-cookie; unb=test-unb; _m_h5_tk=test-token_123; cookie2=abc;',
                    providerUserId: 'xy-user-ai-service-1001',
                    providerShopId: 'xy-shop-ai-service-2001',
                    providerShopName: '真实客服同步店铺',
                    mobile: '139****2006',
                    nickname: '真实客服同步店铺',
                    scopeText: 'item.read,item.write',
                },
            });
            expect(webSessionSyncResponse.statusCode).toBe(200);
            const managementResponse = await isolatedApp.inject({
                method: 'GET',
                url: '/api/stores/management',
                headers: {
                    authorization: `Bearer ${isolatedAdminToken}`,
                },
            });
            expect(managementResponse.statusCode).toBe(200);
            const store = managementResponse
                .json()
                .stores.find((item) => item.providerStoreId === 'xy-shop-ai-service-2001');
            expect(store).toBeTruthy();
            if (!store) {
                throw new Error('缺少真实 AI 客服同步店铺');
            }
            const socketAuthCache = {
                appKey: '444e9908a51d1cb236a27862abc769c9',
                cacheHeader: 'app-key token ua wv',
                token: 'im-token-service-1',
                ua: 'Mozilla/5.0 test',
                dt: 'j',
                wv: 'im:3,au:3,sy:6',
                sync: '0,0;0;0;',
                did: 'device-service-1',
                capturedAt: '2026-03-16 11:05:00',
                expiresAt: '2026-03-16 11:55:00',
            };
            vi.spyOn(xianyuWebSessionService, 'fetchXianyuWebSessionBargainSessions').mockResolvedValue({
                sessions: [
                    {
                        sessionId: '57580658382',
                        sessionType: 1,
                        conversationCid: '57580658382@goofish',
                        sellerUserId: '2219728876568',
                        sellerName: '真实客服同步店铺',
                        buyerUserId: '66778899',
                        buyerName: '真实买家B',
                        itemId: '92008801',
                        itemMainPic: 'https://example.com/ai-service-item.png',
                        summaryText: '请问付款后多久到账？',
                        summaryVersion: 18,
                        summaryTimestamp: '2026-03-16 11:02:00',
                        unreadCount: 1,
                        sortIndex: 101,
                        hasMoreMessages: false,
                        messages: [
                            {
                                messageId: 'msg-service-1',
                                sessionId: '57580658382',
                                sessionType: 1,
                                senderRole: 'buyer',
                                senderUserId: '66778899',
                                senderName: '真实买家B',
                                text: '请问付款后多久到账？',
                                sentAt: '2026-03-16 11:02:00',
                                version: 18,
                                rawContentType: 101,
                            },
                            {
                                messageId: 'msg-service-2',
                                sessionId: '57580658382',
                                sessionType: 1,
                                senderRole: 'seller',
                                senderUserId: '2219728876568',
                                senderName: '真实客服同步店铺',
                                text: '一般付款后会尽快处理，请稍等。',
                                sentAt: '2026-03-16 11:02:30',
                                version: 19,
                                rawContentType: 101,
                            },
                        ],
                    },
                ],
                totalCount: 1,
                pageCount: 1,
                rawRet: ['SUCCESS::调用成功'],
                refreshedCookieText: 'cna=refreshed-service; unb=service-unb; _m_h5_tk=refreshed-service-token_123; cookie2=service-cookie2;',
                socketAuthCache,
            });
            const sendTextMessageSpy = vi.spyOn(xianyuWebSessionService, 'sendXianyuWebSessionTextMessage').mockResolvedValue({
                messageId: 'remote-message-1',
                sentAt: '2026-03-16 11:03:00',
                rawRet: ['SOCKET_AUTH_CACHE::HIT', 'SOCKET_AUTH::SEND_OK'],
            });
            const syncResponse = await isolatedApp.inject({
                method: 'POST',
                url: '/api/workspaces/ai-service/service-sync',
                headers: {
                    authorization: `Bearer ${isolatedAdminToken}`,
                },
                payload: {
                    storeIds: [store.id],
                    maxSessionsPerStore: 10,
                    maxMessagesPerSession: 10,
                },
            });
            expect(syncResponse.statusCode).toBe(200);
            const syncPayload = syncResponse.json();
            expect(syncPayload.successCount).toBe(1);
            expect(syncPayload.results[0].candidateSessionCount).toBe(1);
            expect(syncPayload.results[0].syncedConversationCount).toBe(1);
            expect(syncPayload.results[0].createdConversationCount).toBe(1);
            expect(syncPayload.results[0].createdMessageCount).toBe(2);
            const repeatSyncResponse = await isolatedApp.inject({
                method: 'POST',
                url: '/api/workspaces/ai-service/service-sync',
                headers: {
                    authorization: `Bearer ${isolatedAdminToken}`,
                },
                payload: {
                    storeIds: [store.id],
                    maxSessionsPerStore: 10,
                    maxMessagesPerSession: 10,
                },
            });
            expect(repeatSyncResponse.statusCode).toBe(200);
            expect(repeatSyncResponse.json().results[0].createdMessageCount).toBe(0);
            const sqlite = new Database(isolatedDbPath);
            try {
                const cacheRow = sqlite
                    .prepare(`SELECT source, captured_at AS capturedAt, expires_at AS expiresAt FROM xianyu_im_session_auth_cache WHERE store_id = ?`)
                    .get(store.id);
                expect(cacheRow).toBeTruthy();
                expect(cacheRow.source).toBe('ai_service_sync');
                expect(cacheRow.capturedAt).toBe('2026-03-16 11:05:00');
                expect(cacheRow.expiresAt).toBe('2026-03-16 11:55:00');
            }
            finally {
                sqlite.close();
            }
            const detailResponse = await isolatedApp.inject({
                method: 'GET',
                url: '/api/workspaces/ai-service/detail',
                headers: {
                    authorization: `Bearer ${isolatedAdminToken}`,
                },
            });
            expect(detailResponse.statusCode).toBe(200);
            const detailPayload = detailResponse.json();
            const conversation = detailPayload.conversations.find((item) => item.sessionNo === `XYIM-AICS-${store.id}-57580658382`);
            expect(conversation).toBeTruthy();
            if (!conversation) {
                throw new Error('缺少真实 AI 客服同步会话');
            }
            expect(conversation.itemMainPic).toBe('https://example.com/ai-service-item.png');
            expect(detailPayload.recentMessages.filter((item) => item.conversationId === conversation.id)).toHaveLength(2);
            expect(detailPayload.recentMessages.some((item) => item.conversationId === conversation.id && item.senderType === 'seller' && item.senderName === '真实客服同步店铺')).toBe(true);
            const aiReplyResponse = await isolatedApp.inject({
                method: 'POST',
                url: `/api/workspaces/ai-service/conversations/${conversation.id}/ai-reply`,
                headers: {
                    authorization: `Bearer ${isolatedAdminToken}`,
                },
                payload: {},
            });
            expect(aiReplyResponse.statusCode).toBe(200);
            expect(aiReplyResponse.json().replyType).toBe('ai');
            expect(sendTextMessageSpy).toHaveBeenCalledTimes(1);
            expect(sendTextMessageSpy.mock.calls[0]?.[0]).toMatchObject({
                sessionId: '57580658382',
                conversationCid: '57580658382@goofish',
                cachedSocketAuth: {
                    token: 'im-token-service-1',
                    did: 'device-service-1',
                    expiresAt: '2026-03-16 11:55:00',
                },
            });
            const manualReplyResponse = await isolatedApp.inject({
                method: 'POST',
                url: `/api/workspaces/ai-service/conversations/${conversation.id}/manual-reply`,
                headers: {
                    authorization: `Bearer ${isolatedAdminToken}`,
                },
                payload: {
                    content: '已为您核对订单，稍后会继续跟进。',
                    closeConversation: true,
                },
            });
            expect(manualReplyResponse.statusCode).toBe(200);
            expect(sendTextMessageSpy).toHaveBeenCalledTimes(2);
            expect(sendTextMessageSpy.mock.calls[1]?.[0]).toMatchObject({
                sessionId: '57580658382',
                conversationCid: '57580658382@goofish',
                content: '已为您核对订单，稍后会继续跟进。',
            });
            const finalDetailResponse = await isolatedApp.inject({
                method: 'GET',
                url: '/api/workspaces/ai-service/detail',
                headers: {
                    authorization: `Bearer ${isolatedAdminToken}`,
                },
            });
            expect(finalDetailResponse.statusCode).toBe(200);
            const finalPayload = finalDetailResponse.json();
            const finalConversation = finalPayload.conversations.find((item) => item.id === conversation.id);
            expect(finalConversation).toBeTruthy();
            expect(finalConversation.conversationStatus).toBe('resolved');
            expect(finalPayload.recentMessages.some((item) => item.conversationId === conversation.id && item.senderType === 'ai')).toBe(true);
            expect(finalPayload.recentMessages.some((item) => item.conversationId === conversation.id && item.senderType === 'manual')).toBe(true);
            });
        }
        finally {
            await isolatedApp.close();
            fs.rmSync(isolatedDir, { recursive: true, force: true });
        }
        /*
        const { store } = await createXianyuWebSessionStore({
            providerUserId: 'xy-user-ai-bargain-1001',
            providerShopId: 'xy-shop-ai-bargain-2001',
            providerShopName: '真实议价同步店铺',
            mobile: '139****1005',
        });
        vi.spyOn(xianyuWebSessionService, 'fetchXianyuWebSessionProducts').mockResolvedValue({
            items: [
                {
                    id: '92001001',
                    title: '真实议价测试商品',
                    categoryId: '1001',
                    categoryLabel: '会员',
                    price: 299,
                    soldPrice: null,
                    itemStatus: 1,
                    itemStatusText: '销售中',
                    stock: 8,
                    coverUrl: null,
                    detailUrl: null,
                },
            ],
            totalCount: 1,
            pageCount: 1,
            rawRet: ['SUCCESS::调用成功'],
        });
        vi.spyOn(xianyuWebSessionService, 'fetchXianyuWebSessionBargainSessions').mockResolvedValue({
            sessions: [
                {
                    sessionId: '57580658382',
                    sessionType: 1,
                    sellerUserId: '2219728876568',
                    sellerName: '真实议价同步店铺',
                    buyerUserId: '99887766',
                    buyerName: '真实买家A',
                    itemId: '92001001',
                    itemMainPic: null,
                    summaryText: '200元可以吗',
                    summaryVersion: 12,
                    summaryTimestamp: '2026-03-16 10:02:00',
                    unreadCount: 1,
                    sortIndex: 100,
                    hasMoreMessages: false,
                    messages: [
                        {
                            messageId: 'msg-1',
                            sessionId: '57580658382',
                            sessionType: 1,
                            senderRole: 'buyer',
                            senderUserId: '99887766',
                            senderName: '真实买家A',
                            text: '200元可以吗',
                            sentAt: '2026-03-16 10:02:00',
                            version: 12,
                            rawContentType: 101,
                        },
                    ],
                },
            ],
            totalCount: 1,
            pageCount: 1,
            rawRet: ['SUCCESS::调用成功'],
        });
        const sqlite = new Database(dbPath);
        try {
            sqlite
                .prepare(`
                INSERT INTO stores (id, name, manager)
                VALUES (?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                  name = excluded.name,
                  manager = excluded.manager
              `)
                .run(store.id, '真实议价同步店铺', '真实议价同步店铺');
            sqlite
                .prepare(`
                INSERT INTO products (id, store_id, sku, name, category, price, cost, stock)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                  store_id = excluded.store_id,
                  sku = excluded.sku,
                  name = excluded.name,
                  category = excluded.category,
                  price = excluded.price,
                  cost = excluded.cost,
                  stock = excluded.stock
              `)
                .run(92001001, store.id, '92001001', '真实议价测试商品', '会员', 299, 0, 8);
        }
        finally {
            sqlite.close();
        }
        const syncResponse = await app.inject({
            method: 'POST',
            url: '/api/workspaces/ai-bargain/bargain-sync',
            headers: {
                authorization: `Bearer ${adminToken}`,
            },
            payload: {
                storeIds: [store.id],
                maxSessionsPerStore: 10,
                maxMessagesPerSession: 10,
            },
        });
        expect(syncResponse.statusCode).toBe(200);
        const syncPayload = syncResponse.json();
        expect(syncPayload.successCount).toBe(1);
        expect(syncPayload.results[0].candidateSessionCount).toBe(1);
        expect(syncPayload.results[0].syncedSessionCount).toBe(1);
        expect(syncPayload.results[0].createdSessionCount).toBe(1);
        expect(syncPayload.results[0].createdStrategyCount).toBe(1);
        expect(syncPayload.results[0].autoEvaluatedCount).toBe(1);
        const detailResponse = await app.inject({
            method: 'GET',
            url: '/api/workspaces/ai-bargain/detail',
            headers: {
                authorization: `Bearer ${adminToken}`,
            },
        });
        expect(detailResponse.statusCode).toBe(200);
        const detailPayload = detailResponse.json();
        const sessionNo = `XYIM-${store.id}-57580658382`;
        const syncedSession = detailPayload.sessions.find((item) => item.sessionNo === sessionNo);
        expect(syncedSession).toBeTruthy();
        if (!syncedSession) {
            throw new Error('缺少真实 AI 议价同步会话');
        }
        expect(syncedSession.customerName).toBe('真实买家A');
        expect(syncedSession.sessionStatus).toBe('bargaining');
        expect(syncedSession.aiStatus).toBe('auto_countered');
        expect(Number(syncedSession.latestBuyerOffer)).toBe(200);
        expect(detailPayload.strategies.filter((item) => item.productId === 92001001)).toHaveLength(1);
        expect(detailPayload.logs.some((item) => item.sessionId === syncedSession.id && item.actionType === 'buyer_offer')).toBe(true);
        expect(detailPayload.logs.some((item) => item.sessionId === syncedSession.id && item.actionType === 'counter_offer')).toBe(true);
        const initialLogCount = detailPayload.logs.filter((item) => item.sessionId === syncedSession.id).length;
        const secondSyncResponse = await app.inject({
            method: 'POST',
            url: '/api/workspaces/ai-bargain/bargain-sync',
            headers: {
                authorization: `Bearer ${adminToken}`,
            },
            payload: {
                storeIds: [store.id],
                maxSessionsPerStore: 10,
                maxMessagesPerSession: 10,
            },
        });
        expect(secondSyncResponse.statusCode).toBe(200);
        expect(secondSyncResponse.json().successCount).toBe(1);
        const finalDetailResponse = await app.inject({
            method: 'GET',
            url: '/api/workspaces/ai-bargain/detail',
            headers: {
                authorization: `Bearer ${adminToken}`,
            },
        });
        expect(finalDetailResponse.statusCode).toBe(200);
        const finalPayload = finalDetailResponse.json();
        expect(finalPayload.sessions.filter((item) => item.sessionNo === sessionNo)).toHaveLength(1);
        expect(finalPayload.strategies.filter((item) => item.productId === 92001001)).toHaveLength(1);
        expect(finalPayload.logs.filter((item) => item.sessionId === syncedSession.id)).toHaveLength(initialLogCount);
        */
    });
});
