import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { FastifyReply, FastifyRequest } from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { appConfig } from './config.js';
import { StatisticsDatabase } from './database.js';
import { summarizeRequestForLog } from './observability.js';

const originalStoreAuthMode = appConfig.storeAuthMode;

function createSecurityTestDatabase() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'goofish-store-auth-security-'));
  const dbPath = path.join(tempDir, 'test.db');
  const database = new StatisticsDatabase(dbPath);
  database.initialize({
    forceReseed: true,
    runtimeMode: 'demo',
    seedDemoData: true,
  });
  return {
    tempDir,
    dbPath,
    database,
  };
}

function getRawDb(database: StatisticsDatabase) {
  return (database as unknown as { db: { prepare: (sql: string) => { all: (...args: unknown[]) => unknown[]; get: (...args: unknown[]) => unknown; run: (...args: unknown[]) => unknown } } }).db;
}

afterEach(() => {
  appConfig.storeAuthMode = originalStoreAuthMode;
});

describe('店铺授权安全回归', () => {
  it('未绑店会话录入网页登录态时不会互相覆盖，且不会落原始 Cookie', () => {
    appConfig.storeAuthMode = 'xianyu_web_session';
    const { tempDir, database } = createSecurityTestDatabase();

    try {
      const sessionOne = database.createStoreAuthSession({
        platform: 'xianyu',
        source: 'shop',
        authType: 11,
      });
      const sessionTwo = database.createStoreAuthSession({
        platform: 'xianyu',
        source: 'shop',
        authType: 11,
      });

      database.receiveStoreAuthSessionWebCredential(sessionOne.sessionId, {
        cookieText:
          'cna=session-one; unb=user-one; _m_h5_tk=session-one-token_123; cookie2=session-one-cookie2;',
        source: 'manual',
        rawPayloadText:
          '{"cookieText":"cna=session-one; unb=user-one; _m_h5_tk=session-one-token_123; cookie2=session-one-cookie2;"}',
      });
      database.receiveStoreAuthSessionWebCredential(sessionTwo.sessionId, {
        cookieText:
          'cna=session-two; unb=user-two; _m_h5_tk=session-two-token_123; cookie2=session-two-cookie2;',
        source: 'manual',
        rawPayloadText:
          '{"cookieText":"cna=session-two; unb=user-two; _m_h5_tk=session-two-token_123; cookie2=session-two-cookie2;"}',
      });

      const sqlite = getRawDb(database);
      const credentialRows = sqlite
        .prepare(
          `
            SELECT session_id AS sessionId
            FROM store_platform_credentials
            WHERE session_id IN (?, ?)
            ORDER BY session_id
          `,
        )
        .all(sessionOne.sessionId, sessionTwo.sessionId) as Array<{ sessionId: string }>;
      expect(credentialRows).toHaveLength(2);
      expect(credentialRows.map((row) => row.sessionId).sort()).toEqual(
        [sessionOne.sessionId, sessionTwo.sessionId].sort(),
      );

      const sessionRows = sqlite
        .prepare(
          `
            SELECT
              session_id AS sessionId,
              provider_payload_text AS providerPayloadText
            FROM store_auth_sessions
            WHERE session_id IN (?, ?)
            ORDER BY session_id
          `,
        )
        .all(sessionOne.sessionId, sessionTwo.sessionId) as Array<{
        sessionId: string;
        providerPayloadText: string;
      }>;
      expect(sessionRows).toHaveLength(2);
      for (const row of sessionRows) {
        expect(row.providerPayloadText).toContain('"payloadType": "web_session_capture"');
        expect(row.providerPayloadText).not.toContain('cookieText');
        expect(row.providerPayloadText).not.toContain('_m_h5_tk=');
        expect(row.providerPayloadText).not.toContain('cookie2=');
        expect(row.providerPayloadText).not.toContain('session-one-token_123');
        expect(row.providerPayloadText).not.toContain('session-two-token_123');
      }
    } finally {
      database.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('真实授权回调只保存脱敏摘要，不落原始 token', () => {
    appConfig.storeAuthMode = 'xianyu_browser_oauth';
    const { tempDir, database } = createSecurityTestDatabase();

    try {
      const session = database.createStoreAuthSession({
        platform: 'xianyu',
        source: 'shop',
        authType: 11,
      });
      const detail = database.getStoreAuthSessionDetail(session.sessionId);
      expect(detail?.providerState).toBeTruthy();

      const accessToken = 'real-access-token-secret-123456';
      const refreshToken = 'real-refresh-token-secret-654321';
      const result = database.receiveStoreAuthProviderCallback({
        sessionId: session.sessionId,
        accessToken,
        tokenType: 'Bearer',
        expiresInSeconds: 7200,
        state: detail!.providerState!,
        rawCallback: `https://callback.example.com?access_token=${accessToken}&refresh_token=${refreshToken}`,
      });
      expect(result.accepted).toBe(true);

      const sqlite = getRawDb(database);
      const row = sqlite
        .prepare(
          `
            SELECT provider_payload_text AS providerPayloadText
            FROM store_auth_sessions
            WHERE session_id = ?
          `,
        )
        .get(session.sessionId) as { providerPayloadText: string };
      expect(row.providerPayloadText).toContain('"payloadType": "provider_callback"');
      expect(row.providerPayloadText).not.toContain(accessToken);
      expect(row.providerPayloadText).not.toContain(refreshToken);
      expect(row.providerPayloadText).not.toContain('access_token=');
      expect(row.providerPayloadText).not.toContain('refresh_token=');
    } finally {
      database.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('扫码已收登录态后，绑店可直接复用服务端凭据而不再要求前端回传 Cookie', () => {
    appConfig.storeAuthMode = 'xianyu_web_session';
    const { tempDir, database } = createSecurityTestDatabase();

    try {
      const session = database.createStoreAuthSession({
        platform: 'xianyu',
        source: 'shop',
        authType: 11,
      });
      database.receiveStoreAuthSessionWebCredential(session.sessionId, {
        cookieText:
          'cna=server-side-cookie; unb=server-side-unb; _m_h5_tk=server-side-token_123; cookie2=server-side-cookie2;',
        source: 'qr_login',
      });

      const payload = database.syncStoreAuthSessionWebSession(
        session.sessionId,
        {
          providerUserId: 'xy-user-security-1001',
          providerShopId: 'xy-shop-security-2001',
          providerShopName: '安全接入店铺',
          mobile: '139****0000',
          nickname: '安全接入店铺',
          scopeText: 'item.read,item.write',
        },
        1,
      );

      if (!payload) {
        throw new Error('扫码已接收的授权会话应当可以直接完成绑店。');
      }
      expect(payload.storeId).toBeGreaterThan(0);
      expect(payload.providerShopId).toBe('xy-shop-security-2001');
      expect(payload.providerShopName).toBe('安全接入店铺');
    } finally {
      database.close();
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('初始化时会清理历史遗留的原始授权载荷', () => {
    appConfig.storeAuthMode = 'xianyu_web_session';
    const { tempDir, dbPath, database } = createSecurityTestDatabase();

    try {
      const session = database.createStoreAuthSession({
        platform: 'xianyu',
        source: 'shop',
        authType: 11,
      });
      const sqlite = getRawDb(database);
      sqlite
        .prepare(
          `
            UPDATE store_auth_sessions
            SET
              provider_access_token_masked = @providerAccessTokenMasked,
              provider_access_token_received_at = @providerAccessTokenReceivedAt,
              provider_payload_text = @providerPayloadText
            WHERE session_id = @sessionId
          `,
        )
        .run({
          sessionId: session.sessionId,
          providerAccessTokenMasked: 'cna***ie2',
          providerAccessTokenReceivedAt: '2026-03-14 09:30:00',
          providerPayloadText:
            '{"cookieText":"cna=legacy-user; unb=legacy-unb; _m_h5_tk=legacy-token_123; cookie2=legacy-cookie2;"}',
        });

      database.close();

      const reopened = new StatisticsDatabase(dbPath);
      reopened.initialize({
        runtimeMode: 'demo',
        seedDemoData: true,
      });

      try {
        const reopenedSqlite = getRawDb(reopened);
        const row = reopenedSqlite
          .prepare(
            `
              SELECT provider_payload_text AS providerPayloadText
              FROM store_auth_sessions
              WHERE session_id = ?
            `,
          )
          .get(session.sessionId) as { providerPayloadText: string };
        expect(row.providerPayloadText).toContain('"payloadType": "legacy_scrubbed"');
        expect(row.providerPayloadText).toContain('"maskedValue": "cna***ie2"');
        expect(row.providerPayloadText).not.toContain('legacy-token_123');
        expect(row.providerPayloadText).not.toContain('cookieText');

        reopened.close();
      } catch (error) {
        reopened.close();
        throw error;
      }
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('请求日志会脱敏实时流令牌和 token 查询参数', () => {
    const payload = summarizeRequestForLog({
      request: {
        id: 'req-security-1',
        method: 'GET',
        url: '/api/stores/auth-sessions/demo/live-stream?streamToken=stream-secret-123&foo=bar&access_token=access-secret-456',
        ip: '127.0.0.1',
        headers: {
          'user-agent': 'vitest',
        },
      } as unknown as FastifyRequest,
      reply: {
        statusCode: 200,
      } as FastifyReply,
      route: '/api/stores/auth-sessions/:sessionId/live-stream',
      durationSeconds: 0.123,
    });

    expect(payload.url).toContain('foo=bar');
    expect(payload.url).toContain('streamToken=%5BREDACTED%5D');
    expect(payload.url).toContain('access_token=%5BREDACTED%5D');
    expect(payload.url).not.toContain('stream-secret-123');
    expect(payload.url).not.toContain('access-secret-456');
  });
});
