import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { createApp } from './app.js';
import { appConfig } from './config.js';
import * as xianyuWebSessionService from './xianyu-web-session.js';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'goofish-store-auth-detect-'));
const dbPath = path.join(tempDir, 'test.db');

const app = await createApp({
  dbPath,
  forceReseed: true,
  runtimeMode: 'demo',
  seedDemoData: true,
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

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(async () => {
  await app.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('网页登录态资料自动探测', () => {
  it('支持从已收登录态自动探测卖家资料并回写更完整 Cookie', async () => {
    const originalMode = appConfig.storeAuthMode;
    appConfig.storeAuthMode = 'xianyu_web_session';

    vi.spyOn(xianyuWebSessionService.xianyuQrLoginManager, 'consumeSuccessCookies').mockReturnValue({
      qrLoginId: 'qr-login-detect',
      authSessionId: 'ignored',
      cookieText: 'cna=detect-old; unb=detect-unb; cookie2=detect-cookie2;',
      unb: 'detect-unb',
      source: 'qr_login',
    });
    vi.spyOn(xianyuWebSessionService, 'enrichQrCookiesViaBrowser').mockResolvedValue({
      enrichedCookieText: 'cna=detect-old; unb=detect-unb; cookie2=detect-cookie2;',
      missingKeys: ['_m_h5_tk'],
      enriched: false,
      detail: '测试中跳过浏览器 Cookie 补全。',
    });
    vi.spyOn(xianyuWebSessionService, 'verifyXianyuWebSessionCookie')
      .mockResolvedValueOnce({
        riskLevel: 'offline',
        detail: 'Cookie 缺少 _m_h5_tk。',
        verificationUrl: null,
        refreshedCookieText: null,
        rawRet: ['FAIL_SYS_TOKEN_EMPTY::令牌为空'],
      })
      .mockResolvedValueOnce({
        riskLevel: 'healthy',
        detail: '浏览器补齐后的 Cookie 已可用。',
        verificationUrl: null,
        refreshedCookieText: null,
        rawRet: ['SUCCESS::调用成功'],
      });
    vi.spyOn(xianyuWebSessionService, 'detectXianyuWebSessionProfileViaBrowser').mockResolvedValue({
      detected: true,
      cookieText: 'cna=detect-new; unb=detect-unb; _m_h5_tk=detect-token_123; cookie2=detect-cookie2;',
      currentUrl: 'https://www.goofish.com/personal',
      pageTitle: '小布2345_闲鱼',
      verificationUrl: null,
      detail: '已根据网页登录态自动探测到卖家资料。',
      providerUserId: '2219728876568',
      providerShopId: 'xy584601422766',
      providerShopName: '小布2345',
      nickname: '小布2345',
      mobile: null,
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

      const acceptResponse = await app.inject({
        method: 'POST',
        url: `/api/stores/auth-sessions/${session.sessionId}/qr-login/accept`,
        headers: {
          authorization: `Bearer ${adminToken}`,
        },
      });
      expect(acceptResponse.statusCode).toBe(200);
      expect(acceptResponse.json().nextStep).toBe('sync_profile');

      const detectResponse = await app.inject({
        method: 'POST',
        url: `/api/stores/auth-sessions/${session.sessionId}/web-session-detect-profile`,
        headers: {
          authorization: `Bearer ${adminToken}`,
        },
        payload: {
          showBrowser: false,
        },
      });
      expect(detectResponse.statusCode).toBe(200);
      expect(detectResponse.json()).toMatchObject({
        detected: true,
        providerUserId: '2219728876568',
        providerShopId: 'xy584601422766',
        providerShopName: '小布2345',
        credentialUpdated: true,
        riskLevel: 'healthy',
      });

      const timelineResponse = await app.inject({
        method: 'GET',
        url: `/api/stores/auth-sessions/${session.sessionId}/credential-events`,
        headers: {
          authorization: `Bearer ${adminToken}`,
        },
      });
      expect(timelineResponse.statusCode).toBe(200);
      const browserRenewCapture = timelineResponse
        .json()
        .events.find((item: { eventType: string; source: string | null }) => {
          return item.eventType === 'credential_captured' && item.source === 'browser_renew';
        });
      expect(browserRenewCapture).toBeTruthy();
    } finally {
      appConfig.storeAuthMode = originalMode;
    }
  });
});
