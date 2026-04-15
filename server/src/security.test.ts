import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from './app.js';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'goofish-security-'));
const dbPath = path.join(tempDir, 'security.db');
const AUTH_COOKIE_NAME = 'goofish-statistics-auth';

const app = await createApp({
  dbPath,
  forceReseed: true,
  runtimeMode: 'demo',
  seedDemoData: true,
});

const tokens: Record<string, string> = {};

async function login(username: string, password: string) {
  return app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username, password },
  });
}

function buildAuthCookie(token: string) {
  return `${AUTH_COOKIE_NAME}=${encodeURIComponent(token)}`;
}


beforeAll(async () => {
  const accounts = [
    ['admin', 'Admin@123456'],
    ['operator', 'Operator@123456'],
    ['support', 'Support@123456'],
    ['finance', 'Finance@123456'],
  ] as const;

  for (const [username, password] of accounts) {
    const response = await login(username, password);
    expect(response.statusCode).toBe(200);
    tokens[username] = response.json().token;
  }
});

afterAll(async () => {
  await app.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});


function extractCookieHeader(response: { headers: Record<string, unknown> }) {
  const header = response.headers['set-cookie'];
  if (Array.isArray(header)) {
    return typeof header[0] === 'string' ? header[0] : undefined;
  }
  return typeof header === 'string' ? header : undefined;
}

describe('第 1 轮安全与权限体系', () => {
  it('不同角色只能访问各自职责范围内的接口', async () => {
    const adminUserResponse = await app.inject({
      method: 'GET',
      url: '/api/workspaces/system-accounts/detail',
      headers: { authorization: `Bearer ${tokens.admin}` },
    });
    expect(adminUserResponse.statusCode).toBe(200);

    const operatorBlockedResponse = await app.inject({
      method: 'GET',
      url: '/api/workspaces/system-accounts/detail',
      headers: { authorization: `Bearer ${tokens.operator}` },
    });
    expect(operatorBlockedResponse.statusCode).toBe(403);

    const financeWithdrawalResponse = await app.inject({
      method: 'GET',
      url: '/api/workspaces/fund-withdrawals/detail',
      headers: { authorization: `Bearer ${tokens.finance}` },
    });
    expect(financeWithdrawalResponse.statusCode).toBe(200);

    const supportWithdrawalBlockedResponse = await app.inject({
      method: 'POST',
      url: '/api/workspaces/fund-withdrawals/withdrawals/1/status',
      headers: { authorization: `Bearer ${tokens.support}` },
      payload: { status: 'paid' },
    });
    expect(supportWithdrawalBlockedResponse.statusCode).toBe(403);

    const operatorStoreResponse = await app.inject({
      method: 'GET',
      url: '/api/stores/management',
      headers: { authorization: `Bearer ${tokens.operator}` },
    });
    expect(operatorStoreResponse.statusCode).toBe(200);

    const financeStoreBlockedResponse = await app.inject({
      method: 'GET',
      url: '/api/stores/management',
      headers: { authorization: `Bearer ${tokens.finance}` },
    });
    expect(financeStoreBlockedResponse.statusCode).toBe(403);

    const operatorExportResponse = await app.inject({
      method: 'GET',
      url: '/api/orders/export?preset=last7Days',
      headers: { authorization: `Bearer ${tokens.operator}` },
    });
    expect(operatorExportResponse.statusCode).toBe(200);
  });

  it('登录失败、登录成功和越权访问会写入审计日志', async () => {
    const failedLoginResponse = await login('support', 'WrongPassword');
    expect(failedLoginResponse.statusCode).toBe(401);

    const blockedResponse = await app.inject({
      method: 'GET',
      url: '/api/workspaces/open-logs/detail',
      headers: { authorization: `Bearer ${tokens.operator}` },
    });
    expect(blockedResponse.statusCode).toBe(403);

    const auditResponse = await app.inject({
      method: 'GET',
      url: '/api/workspaces/open-logs/detail',
      headers: { authorization: `Bearer ${tokens.admin}` },
    });
    expect(auditResponse.statusCode).toBe(200);
    const payload = auditResponse.json();
    expect(payload.kind).toBe('open-logs');
    expect(payload.rows.some((row: { action: string }) => row.action === 'login_failure')).toBe(true);
    expect(payload.rows.some((row: { action: string }) => row.action === 'login_success')).toBe(true);
    expect(payload.rows.some((row: { action: string }) => row.action === 'unauthorized_access')).toBe(
      true,
    );
  });

  it('管理员可以管理账号，停用后的账号无法继续登录', async () => {
    const createResponse = await app.inject({
      method: 'POST',
      url: '/api/system/users',
      headers: { authorization: `Bearer ${tokens.admin}` },
      payload: {
        username: 'ops_case',
        displayName: '测试运营',
        password: 'OpsCase@123456',
        role: 'operator',
      },
    });
    expect(createResponse.statusCode).toBe(200);
    const createdUser = createResponse.json().user;
    expect(createdUser.username).toBe('ops_case');

    const disableResponse = await app.inject({
      method: 'POST',
      url: `/api/system/users/${createdUser.id}/status`,
      headers: { authorization: `Bearer ${tokens.admin}` },
      payload: { status: 'disabled' },
    });
    expect(disableResponse.statusCode).toBe(200);
    expect(disableResponse.json().user.status).toBe('disabled');

    const blockedLoginResponse = await login('ops_case', 'OpsCase@123456');
    expect(blockedLoginResponse.statusCode).toBe(403);
  });

  it('敏感配置只保存密文和脱敏值，并且支持轮换', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/api/system/secure-settings/openai_api_key',
      headers: { authorization: `Bearer ${tokens.admin}` },
      payload: {
        description: 'AI 客服模型密钥',
        value: 'sk-live-sensitive-secret',
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().setting.maskedValue).toContain('***');

    const sqlite = new Database(dbPath, { readonly: true });
    const row = sqlite
      .prepare(
        `
          SELECT value_encrypted AS encryptedValue, value_masked AS maskedValue
          FROM secure_settings
          WHERE key = 'openai_api_key'
        `,
      )
      .get() as { encryptedValue: string; maskedValue: string };
    sqlite.close();

    expect(row.encryptedValue).not.toBe('sk-live-sensitive-secret');
    expect(row.encryptedValue.includes('sk-live-sensitive-secret')).toBe(false);
    expect(row.maskedValue).toContain('***');
  });

  it('Bearer 令牌可以续期，续期后仍能获取当前用户资料', async () => {
    const refreshResponse = await app.inject({
      method: 'POST',
      url: '/api/auth/refresh',
      headers: { authorization: `Bearer ${tokens.admin}` },
      payload: {},
    });
    expect(refreshResponse.statusCode).toBe(200);
    const refreshPayload = refreshResponse.json();
    expect(refreshPayload.token).toBeTruthy();
    expect(refreshPayload.expiresAt).toBeTruthy();

    const profileResponse = await app.inject({
      method: 'GET',
      url: '/api/auth/profile',
      headers: { authorization: `Bearer ${refreshPayload.token}` },
    });
    expect(profileResponse.statusCode).toBe(200);
    expect(profileResponse.json().user.role).toBe('admin');
  });

  it('登录成功后服务端返回 set-cookie，Cookie 可用于后续鉴权', async () => {
    const loginResponse = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { username: 'admin', password: 'Admin@123456' },
    });
    expect(loginResponse.statusCode).toBe(200);

    const cookieStr = extractCookieHeader(loginResponse);
    expect(cookieStr).toBeTruthy();
    expect(cookieStr).toContain('HttpOnly');
    expect(cookieStr).toContain('SameSite=Lax');

    const cookieNameValue = cookieStr!.split(';')[0];
    const profileResponse = await app.inject({
      method: 'GET',
      url: '/api/auth/profile',
      headers: { cookie: cookieNameValue },
    });
    expect(profileResponse.statusCode).toBe(200);
    expect(profileResponse.json().user.username).toBe('admin');
  });

  it('通过 Cookie 鉴权可以完成令牌续期', async () => {
    const refreshResponse = await app.inject({
      method: 'POST',
      url: '/api/auth/refresh',
      headers: { cookie: buildAuthCookie(tokens.operator) },
      payload: {},
    });
    expect(refreshResponse.statusCode).toBe(200);
    const payload = refreshResponse.json();
    expect(payload.expiresAt).toBeTruthy();
    expect(payload.user.username).toBe('operator');
    expect(refreshResponse.headers['set-cookie']).toBeTruthy();
  });

  it('同时带 Cookie 和 Bearer 时，优先使用 Cookie 鉴权', async () => {
    const profileResponse = await app.inject({
      method: 'GET',
      url: '/api/auth/profile',
      headers: {
        authorization: `Bearer ${tokens.admin}`,
        cookie: buildAuthCookie(tokens.operator),
      },
    });
    expect(profileResponse.statusCode).toBe(200);
    expect(profileResponse.json().user.username).toBe('operator');
  });

  it('/api/health 不暴露部署敏感信息', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/health',
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe('ok');
    expect(body.configuration).toBeUndefined();
    expect(body.dbPath).toBeUndefined();
    expect(body.envFilePath).toBeUndefined();
  });

  it('商品履约规则配置可以按前端字符串通道值持久化保存', async () => {
    const saveResponse = await app.inject({
      method: 'POST',
      url: '/api/products/1/fulfillment-rule',
      headers: { authorization: `Bearer ${tokens.admin}` },
      payload: {
        fulfillmentType: 'source_system',
        supplierId: 'sim-own-supply',
        externalSku: 'SOURCE-SKU-1004',
      },
    });
    expect(saveResponse.statusCode).toBe(200);
    expect(saveResponse.json().success).toBe(true);

    const getResponse = await app.inject({
      method: 'GET',
      url: '/api/products/1/fulfillment-rule',
      headers: { authorization: `Bearer ${tokens.admin}` },
    });
    expect(getResponse.statusCode).toBe(200);
    const rule = getResponse.json();
    expect(rule.fulfillmentType).toBe('source_system');
    expect(rule.supplierId).toBe('sim-own-supply');
    expect(rule.externalSku).toBe('SOURCE-SKU-1004');
  });

  it('登出会返回清 Cookie 头，并同时让当前 Cookie 和 Bearer 失效', async () => {
    const loginCookie = buildAuthCookie(tokens.admin);

    const logoutResponse = await app.inject({
      method: 'POST',
      url: '/api/auth/logout',
      headers: { cookie: loginCookie },
      payload: {},
    });
    expect(logoutResponse.statusCode).toBe(200);

    const cookieStr = extractCookieHeader(logoutResponse);
    expect(cookieStr).toBeTruthy();
    expect(cookieStr).toContain('Max-Age=0');

    const bearerAfterLogout = await app.inject({
      method: 'GET',
      url: '/api/auth/profile',
      headers: { authorization: `Bearer ${tokens.admin}` },
    });
    expect(bearerAfterLogout.statusCode).toBe(401);

    const cookieAfterLogout = await app.inject({
      method: 'GET',
      url: '/api/auth/profile',
      headers: { cookie: loginCookie },
    });
    expect(cookieAfterLogout.statusCode).toBe(401);
  });
});
