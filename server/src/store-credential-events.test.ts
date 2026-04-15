import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { createApp } from './app.js';
import { appConfig } from './config.js';
import * as xianyuWebSessionService from './xianyu-web-session.js';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'goofish-credential-events-'));
const dbPath = path.join(tempDir, 'test.db');

const app = await createApp({
  dbPath,
  forceReseed: true,
  runtimeMode: 'demo',
  seedDemoData: true,
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
      password: 'Admin@123456',
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

describe('店铺凭据时间线', () => {
  it('会返回扫码阶段的授权会话事件', async () => {
    const originalMode = appConfig.storeAuthMode;
    appConfig.storeAuthMode = 'xianyu_web_session';

    vi.spyOn(xianyuWebSessionService.xianyuQrLoginManager, 'create').mockResolvedValue({
      qrLoginId: 'qr-session-timeline-1',
      authSessionId: 'ignored',
      status: 'waiting',
      qrCodeUrl: 'data:image/png;base64,session-qr',
      createdAt: '2026-03-13 11:00:00',
      expiresAt: '2026-03-13 11:05:00',
      lastPolledAt: null,
      verificationUrl: null,
      hasCookies: false,
      cookieMasked: null,
      failureReason: null,
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

      const timelineResponse = await app.inject({
        method: 'GET',
        url: `/api/stores/auth-sessions/${session.sessionId}/credential-events`,
        headers: {
          authorization: `Bearer ${adminToken}`,
        },
      });
      expect(timelineResponse.statusCode).toBe(200);

      const payload = timelineResponse.json();
      expect(payload.sessionId).toBe(session.sessionId);
      expect(payload.storeId).toBeNull();
      expect(payload.storeName).toBeNull();

      const qrLoginStartedEvent = payload.events.find(
        (item: { eventType: string }) => item.eventType === 'qr_login_started',
      );
      expect(qrLoginStartedEvent).toBeTruthy();
      expect(qrLoginStartedEvent.status).toBe('info');
    } finally {
      appConfig.storeAuthMode = originalMode;
    }
  });

  it('会返回录入、校验、人工接管和续登事件', async () => {
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

      const payload = eventsResponse.json();
      expect(payload.storeId).toBe(store.id);

      const eventTypes = payload.events.map((item: { eventType: string }) => item.eventType);
      expect(eventTypes).toContain('credential_captured');
      expect(eventTypes).toContain('profile_synced');
      expect(eventTypes).toContain('credential_verified');
      expect(eventTypes).toContain('manual_takeover_required');
      expect(eventTypes).toContain('browser_renewed');

      const warningEvent = payload.events.find(
        (item: { eventType: string }) => item.eventType === 'manual_takeover_required',
      );
      expect(warningEvent).toBeTruthy();
      expect(warningEvent.verificationUrl).toBe('https://verify.goofish.com/timeline-risk');
    } finally {
      appConfig.storeAuthMode = originalMode;
    }
  });
});
