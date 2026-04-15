import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

import type { ResolvedAppConfig } from './config.js';
import type { StoreAuthIntegrationMode, StoreAuthProviderKey } from './types.js';

export interface StoreAuthProviderPlan {
  integrationMode: StoreAuthIntegrationMode;
  providerKey: StoreAuthProviderKey | null;
  providerLabel: string;
  providerConfigured: boolean;
  providerState: string | null;
  authorizeUrl: string | null;
  callbackPath: string | null;
  callbackUrl: string | null;
  requiresBrowserCallback: boolean;
  instructions: string[];
}

export interface StoreAuthProviderCallbackPayload {
  accessToken: string;
  tokenType: string | null;
  expiresInSeconds: number | null;
  state: string;
  rawCallback: string;
}

function buildStoreAuthStateSignature(sessionId: string, nonce: string, signingSecret: string) {
  return createHmac('sha256', signingSecret).update(`${sessionId}.${nonce}`).digest('base64url');
}

function isSafeEqual(left: string, right: string) {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }

  return timingSafeEqual(leftBuffer, rightBuffer);
}

export function buildStoreAuthProviderState(sessionId: string, signingSecret: string) {
  const nonce = randomUUID().replace(/-/g, '');
  const signature = buildStoreAuthStateSignature(sessionId, nonce, signingSecret);
  return `${sessionId}.${nonce}.${signature}`;
}

export function parseStoreAuthSessionIdFromState(state: string) {
  const sessionId = state.split('.')[0]?.trim();
  return sessionId || null;
}

export function validateStoreAuthProviderState(
  state: string,
  signingSecret: string,
  expectedSessionId?: string | null,
) {
  const [sessionId, nonce, signature] = state.split('.');
  if (!sessionId || !nonce || !signature) {
    return false;
  }

  if (expectedSessionId && sessionId !== expectedSessionId) {
    return false;
  }

  const expectedSignature = buildStoreAuthStateSignature(sessionId, nonce, signingSecret);
  return isSafeEqual(signature, expectedSignature);
}

function buildXianyuAuthorizeUrl(input: {
  authorizeBaseUrl: string;
  appKey: string;
  callbackUrl: string;
  providerState: string;
  forceAuth: boolean;
}) {
  const url = new URL(input.authorizeBaseUrl);
  url.searchParams.set('response_type', 'token');
  url.searchParams.set('client_id', input.appKey);
  url.searchParams.set('sp', 'xianyu');
  url.searchParams.set('force_auth', input.forceAuth ? 'true' : 'false');
  url.searchParams.set('state', input.providerState);
  url.searchParams.set('redirect_uri', input.callbackUrl);
  return url.toString();
}

export function resolveStoreAuthProviderPlan(
  config: ResolvedAppConfig,
  input: {
    platform: 'xianyu' | 'taobao';
    sessionId: string;
    reauthorize: boolean;
    providerState?: string | null;
    signingSecret: string;
  },
): StoreAuthProviderPlan {
  if (input.platform === 'xianyu' && config.storeAuthMode === 'xianyu_browser_oauth') {
    const callbackPath = '/stores/connect/xianyu/callback';
    const callbackUrl = config.xianyuCallbackBaseUrl
      ? new URL(callbackPath, `${config.xianyuCallbackBaseUrl}/`).toString()
      : null;
    const providerState =
      input.providerState ?? buildStoreAuthProviderState(input.sessionId, input.signingSecret);
    const providerConfigured = Boolean(config.xianyuAppKey && config.xianyuCallbackBaseUrl);

    return {
      integrationMode: 'xianyu_browser_oauth',
      providerKey: 'xianyu-browser-oauth',
      providerLabel: '闲鱼浏览器授权',
      providerConfigured,
      providerState,
      authorizeUrl:
        providerConfigured && config.xianyuAppKey && callbackUrl
          ? buildXianyuAuthorizeUrl({
              authorizeBaseUrl: config.xianyuAuthorizeBaseUrl,
              appKey: config.xianyuAppKey,
              callbackUrl,
              providerState,
              forceAuth: config.xianyuForceAuth,
            })
          : null,
      callbackPath,
      callbackUrl,
      requiresBrowserCallback: true,
      instructions: [
        input.reauthorize ? '重新授权后会覆盖旧的 access token。' : '完成官方授权后会先接收 access token。',
        '当前骨架版只完成授权回调接收与安全入库，下一步还需要补店铺资料换取与正式绑店。',
        '正式联调前必须确认闲鱼开放平台资质、TOP 应用权限和聚石塔部署要求。',
      ],
    };
  }

  if (input.platform === 'xianyu' && config.storeAuthMode === 'xianyu_web_session') {
    return {
      integrationMode: 'xianyu_web_session',
      providerKey: 'xianyu-web-session',
      providerLabel: '闲鱼网页登录态接入',
      providerConfigured: true,
      providerState: null,
      authorizeUrl: null,
      callbackPath: null,
      callbackUrl: null,
      requiresBrowserCallback: false,
      instructions: [
        input.reauthorize
          ? '请录入最新的网页登录态或 Cookie，会覆盖旧的店铺接入凭据。'
          : '请录入可用的网页登录态或 Cookie，并补齐卖家与店铺资料。',
        '当前版本不依赖开放平台 appKey/appSecret，适合无法走官方 OAuth 的接入场景。',
        '建议先用手动 Cookie 方式联调，后续再补扫码登录、密码登录与风控处理。',
      ],
    };
  }

  return {
    integrationMode: 'simulated',
    providerKey: null,
    providerLabel: '受控模拟授权',
    providerConfigured: true,
    providerState: null,
    authorizeUrl: null,
    callbackPath: null,
    callbackUrl: null,
    requiresBrowserCallback: false,
    instructions: [
      '当前会话仍使用本地模拟授权表单。',
      '完成后会直接创建或恢复店铺，不会连接真实闲鱼平台。',
    ],
  };
}
