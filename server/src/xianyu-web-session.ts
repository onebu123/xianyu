import fs from 'node:fs';
import { createHash, randomBytes, randomUUID } from 'node:crypto';

import { chromium, type Page } from 'playwright-core';
import QRCode from 'qrcode';

const PASSPORT_HOST = 'https://passport.goofish.com';
const HAS_LOGIN_URL = 'https://passport.goofish.com/newlogin/hasLogin.do';
const H5_GATEWAY_URL =
  'https://h5api.m.goofish.com/h5/mtop.gaia.nodejs.gaia.idle.data.gw.v2.index.get/1.0/';
const LOGIN_TOKEN_URL =
  'https://h5api.m.goofish.com/h5/mtop.taobao.idlemessage.pc.login.token/1.0/';
const MTOP_APP_KEY = '34839810';
const LOGIN_APP_KEY = '444e9908a51d1cb236a27862abc769c9';
const DEFAULT_RENEW_URL = process.env.APP_XIANYU_BROWSER_RENEW_URL?.trim() || 'https://www.goofish.com/im';
const PERSONAL_PAGE_URL = 'https://www.goofish.com/personal';
const XIANYU_WEB_SOCKET_DEFAULT_CACHE_HEADER = 'app-key token ua wv';
const XIANYU_WEB_SOCKET_DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36 DingTalk(2.2.0) OS(Windows/10) Browser(Chrome/138.0.0.0) DingWeb/2.2.0 IMPaaS DingWeb/2.2.0';
const XIANYU_WEB_SOCKET_DEFAULT_DT = 'j';
const XIANYU_WEB_SOCKET_DEFAULT_WV = 'im:3,au:3,sy:6';
const XIANYU_WEB_SOCKET_DEFAULT_SYNC = '0,0;0;0;';

export type XianyuQrLoginSessionStatus =
  | 'waiting'
  | 'scanned'
  | 'success'
  | 'expired'
  | 'cancelled'
  | 'verification_required'
  | 'failed';

export type XianyuCredentialRiskLevel = 'pending' | 'healthy' | 'warning' | 'offline' | 'abnormal';

interface InternalQrLoginSession {
  qrLoginId: string;
  authSessionId: string;
  status: XianyuQrLoginSessionStatus;
  qrCodeUrl: string;
  qrContent: string;
  createdAt: string;
  expiresAt: string;
  lastPolledAt: string | null;
  cookies: Map<string, string>;
  params: Record<string, string>;
  verificationUrl: string | null;
  unb: string | null;
  failureReason: string | null;
  monitorStarted: boolean;
}

export interface XianyuQrLoginSessionSnapshot {
  qrLoginId: string;
  authSessionId: string;
  status: XianyuQrLoginSessionStatus;
  qrCodeUrl: string;
  createdAt: string;
  expiresAt: string;
  lastPolledAt: string | null;
  verificationUrl: string | null;
  hasCookies: boolean;
  cookieMasked: string | null;
  failureReason: string | null;
}

export type XianyuQrLoginSnapshotListener = (snapshot: XianyuQrLoginSessionSnapshot) => void;

export interface XianyuQrLoginConsumeResult {
  qrLoginId: string;
  authSessionId: string;
  cookieText: string;
  unb: string | null;
  source: 'qr_login' | 'browser_qr_login';
}

export interface XianyuCredentialVerificationResult {
  riskLevel: XianyuCredentialRiskLevel;
  detail: string;
  verificationUrl: string | null;
  refreshedCookieText: string | null;
  rawRet: string[];
}

export interface XianyuBrowserRenewResult {
  renewed: boolean;
  cookieText: string | null;
  currentUrl: string | null;
  pageTitle: string | null;
  verificationUrl: string | null;
  detail: string;
}

export interface XianyuWebSocketAuthCache {
  appKey: string;
  cacheHeader: string;
  token: string;
  ua: string;
  dt: string;
  wv: string;
  sync: string;
  did: string;
  capturedAt: string;
  expiresAt: string;
}

interface XianyuBrowserProfileSnapshot {
  userId: string | null;
  encryptedUserId: string | null;
  displayName: string | null;
}

interface XianyuBrowserSessionProbeResult {
  cookieText: string | null;
  currentUrl: string | null;
  pageTitle: string | null;
  verificationUrl: string | null;
  missingKeys: string[];
  tracknick: string | null;
  profile: XianyuBrowserProfileSnapshot;
}

interface XianyuMtopPayload<TData> {
  ret?: string[];
  data?: TData;
}

export interface XianyuWebSessionProfileDetectionResult {
  detected: boolean;
  cookieText: string | null;
  currentUrl: string | null;
  pageTitle: string | null;
  verificationUrl: string | null;
  detail: string;
  providerUserId: string | null;
  providerShopId: string | null;
  providerShopName: string | null;
  nickname: string | null;
  mobile: string | null;
}

export interface XianyuWebProductItem {
  id: string;
  title: string;
  categoryId: string | null;
  categoryLabel: string;
  price: number;
  soldPrice: number | null;
  itemStatus: number;
  itemStatusText: string;
  stock: number;
  coverUrl: string | null;
  detailUrl: string | null;
}

export interface XianyuWebProductListResult {
  items: XianyuWebProductItem[];
  totalCount: number | null;
  pageCount: number;
  rawRet: string[];
}

export interface XianyuWebCompletedTradeCard {
  tradeId: string;
  createdAt: string | null;
  buyerName: string | null;
  feedback: string | null;
  rateTags: string[];
}

export interface XianyuWebCompletedTradeListResult {
  items: XianyuWebCompletedTradeCard[];
  totalCount: number | null;
  pageCount: number;
  rawRet: string[];
}

export interface XianyuWebOrderDetailEvent {
  eventType: string;
  eventTitle: string;
  eventDetail: string;
  operatorName: string | null;
  createdAt: string;
}

export interface XianyuWebOrderDetailResult {
  orderNo: string;
  buyerUserId: string | null;
  buyerName: string | null;
  itemId: string | null;
  itemTitle: string;
  quantity: number;
  unitPrice: number;
  paidAmount: number;
  discountAmount: number;
  refundAmount: number;
  paymentNo: string | null;
  orderStatusName: string | null;
  paidAt: string;
  shippedAt: string | null;
  completedAt: string | null;
  events: XianyuWebOrderDetailEvent[];
  rawRet: string[];
}

export interface XianyuWebImMessage {
  messageId: string;
  sessionId: string;
  sessionType: number | null;
  senderRole: 'buyer' | 'seller' | 'unknown';
  senderUserId: string | null;
  senderName: string;
  text: string;
  sentAt: string;
  version: number | null;
  rawContentType: number | null;
}

export interface XianyuWebImSession {
  sessionId: string;
  sessionType: number | null;
  conversationCid?: string | null;
  sellerUserId: string | null;
  sellerName: string | null;
  buyerUserId: string | null;
  buyerName: string | null;
  itemId: string | null;
  itemMainPic: string | null;
  summaryText: string;
  summaryVersion: number | null;
  summaryTimestamp: string;
  unreadCount: number;
  sortIndex: number | null;
}

export interface XianyuWebBargainSession extends XianyuWebImSession {
  messages: XianyuWebImMessage[];
  hasMoreMessages: boolean;
}

export interface XianyuWebBargainSessionResult {
  sessions: XianyuWebBargainSession[];
  totalCount: number;
  pageCount: number;
  rawRet: string[];
  refreshedCookieText?: string | null;
  socketAuthCache?: XianyuWebSocketAuthCache | null;
  socketAuthCacheRejected?: boolean;
}

export interface XianyuWebSendMessageResult {
  messageId: string;
  sentAt: string;
  rawRet: string[];
  refreshedCookieText?: string | null;
  socketAuthCache?: XianyuWebSocketAuthCache | null;
  socketAuthCacheRejected?: boolean;
}

function formatDateTime(date: Date) {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

const XIANYU_WEB_SOCKET_AUTH_CACHE_TTL_MS = 50 * 60 * 1000;

function parseXianyuCacheDateTime(value: string | null | undefined) {
  const normalized = value?.trim();
  if (!normalized) {
    return null;
  }

  const parsed = new Date(normalized.replace(' ', 'T'));
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return parsed;
}

export function isXianyuWebSocketAuthCacheUsable(
  cache: XianyuWebSocketAuthCache | null | undefined,
  now = new Date(),
) {
  if (!cache) {
    return false;
  }

  if (!cache.token?.trim() || !cache.did?.trim()) {
    return false;
  }

  const expiresAt = parseXianyuCacheDateTime(cache.expiresAt);
  if (!expiresAt) {
    return false;
  }

  return expiresAt.getTime() - now.getTime() > 2 * 60 * 1000;
}

function buildXianyuWebSocketAuthCache(authSnapshot: XianyuWebSocketAuthSnapshot): XianyuWebSocketAuthCache {
  const capturedAtDate = new Date();
  return {
    ...authSnapshot,
    capturedAt: formatDateTime(capturedAtDate),
    expiresAt: formatDateTime(new Date(capturedAtDate.getTime() + XIANYU_WEB_SOCKET_AUTH_CACHE_TTL_MS)),
  };
}

function createXianyuImMessageUuid() {
  return `-${Date.now()}${Math.trunc(Math.random() * 1000000)}`;
}

function inflateXianyuWebSocketAuthSnapshot(cache: XianyuWebSocketAuthCache): XianyuWebSocketAuthSnapshot {
  return {
    appKey: cache.appKey,
    cacheHeader: cache.cacheHeader,
    token: cache.token,
    ua: cache.ua,
    dt: cache.dt,
    wv: cache.wv,
    sync: cache.sync,
    did: cache.did,
  };
}

function buildBaseHeaders(input?: { referer?: string; origin?: string }) {
  return {
    'user-agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
    accept: 'application/json, text/plain, */*',
    'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
    ...(input?.referer ? { referer: input.referer } : {}),
    ...(input?.origin ? { origin: input.origin } : {}),
  };
}

function extractCookiePair(setCookie: string) {
  const pair = setCookie.split(';', 1)[0]?.trim();
  if (!pair || !pair.includes('=')) {
    return null;
  }

  const separatorIndex = pair.indexOf('=');
  const name = pair.slice(0, separatorIndex).trim();
  const value = pair.slice(separatorIndex + 1).trim();
  if (!name) {
    return null;
  }

  return { name, value };
}

function getSetCookieHeaders(headers: Headers) {
  const enhancedHeaders = headers as Headers & { getSetCookie?: () => string[] };
  if (typeof enhancedHeaders.getSetCookie === 'function') {
    return enhancedHeaders.getSetCookie();
  }

  const single = headers.get('set-cookie');
  return single ? [single] : [];
}

function applySetCookieHeaders(cookieJar: Map<string, string>, headers: Headers) {
  for (const setCookie of getSetCookieHeaders(headers)) {
    const pair = extractCookiePair(setCookie);
    if (!pair) {
      continue;
    }
    cookieJar.set(pair.name, pair.value);
  }
}

export function parseCookieText(cookieText: string) {
  const jar = new Map<string, string>();

  for (const segment of cookieText.split(';')) {
    const trimmed = segment.trim();
    if (!trimmed || !trimmed.includes('=')) {
      continue;
    }

    const separatorIndex = trimmed.indexOf('=');
    const name = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1).trim();
    if (!name) {
      continue;
    }

    jar.set(name, value);
  }

  return jar;
}

export function stringifyCookieJar(cookieJar: Map<string, string>) {
  return Array.from(cookieJar.entries())
    .map(([name, value]) => `${name}=${value}`)
    .join('; ');
}

function buildCookieHeader(cookieJar: Map<string, string>) {
  return stringifyCookieJar(cookieJar);
}

function getMtopToken(cookieJar: Map<string, string>) {
  const raw = cookieJar.get('_m_h5_tk') ?? cookieJar.get('m_h5_tk') ?? '';
  return raw.split('_')[0]?.trim() || '';
}

function createMtopSign(token: string, timestamp: string, appKey: string, data: string) {
  return createHash('md5')
    .update(`${token}&${timestamp}&${appKey}&${data}`)
    .digest('hex');
}

async function requestWithCookieJar(input: {
  url: string;
  method?: 'GET' | 'POST';
  cookieJar: Map<string, string>;
  headers?: Record<string, string>;
  searchParams?: Record<string, string>;
  body?: URLSearchParams;
}) {
  const url = new URL(input.url);
  for (const [key, value] of Object.entries(input.searchParams ?? {})) {
    url.searchParams.set(key, value);
  }

  const response = await fetch(url, {
    method: input.method ?? 'GET',
    headers: {
      ...input.headers,
      ...(input.cookieJar.size > 0 ? { cookie: buildCookieHeader(input.cookieJar) } : {}),
      ...(input.body ? { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' } : {}),
    },
    body: input.body,
    redirect: 'follow',
  });

  applySetCookieHeaders(input.cookieJar, response.headers);
  return response;
}

function randomDeviceId() {
  return randomBytes(16).toString('hex');
}

function createXianyuWebSocketDeviceId(cookieJar: Map<string, string>) {
  const stableSeed =
    cookieJar.get('unb')?.trim() ||
    cookieJar.get('cna')?.trim() ||
    cookieJar.get('cookie2')?.trim() ||
    randomDeviceId();
  return createHash('md5').update(stableSeed).digest('hex');
}

function getVerificationUrlFromPayload(payload: unknown) {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const data = (payload as { data?: { url?: string | null } }).data;
  return data?.url?.trim() || null;
}

async function postXianyuMtopWithCookieJar<TData>(input: {
  cookieJar: Map<string, string>;
  api: string;
  apiVersion?: string;
  data: Record<string, unknown>;
  referer?: string;
  origin?: string;
  spmCnt?: string;
}) {
  const token = getMtopToken(input.cookieJar);
  if (!token) {
    throw new Error('Cookie 中缺少 _m_h5_tk，无法调用闲鱼网页接口。');
  }

  const requestData = JSON.stringify(input.data);
  const timestamp = String(Date.now());
  const response = await requestWithCookieJar({
    url: `https://h5api.m.goofish.com/h5/${input.api}/${input.apiVersion ?? '1.0'}/`,
    method: 'POST',
    cookieJar: input.cookieJar,
    headers: buildBaseHeaders({
      referer: input.referer ?? 'https://www.goofish.com/',
      origin: input.origin ?? 'https://www.goofish.com',
    }),
    searchParams: {
      jsv: '2.7.2',
      appKey: MTOP_APP_KEY,
      t: timestamp,
      sign: createMtopSign(token, timestamp, MTOP_APP_KEY, requestData),
      v: input.apiVersion ?? '1.0',
      type: 'originaljson',
      accountSite: 'xianyu',
      dataType: 'json',
      timeout: '20000',
      api: input.api,
      sessionOption: 'AutoLoginOnly',
      spm_cnt: input.spmCnt ?? 'a21ybx.personal.0.0',
    },
    body: new URLSearchParams({
      data: requestData,
    }),
  });

  return (await response.json()) as XianyuMtopPayload<TData>;
}

function parseXianyuNumber(value: unknown) {
  const normalized =
    typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : '';
  if (!normalized) {
    return null;
  }

  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseXianyuAmount(value: unknown) {
  if (value && typeof value === 'object') {
    return parseXianyuAmount(extractXianyuText(value));
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value !== 'string') {
    return null;
  }

  const normalized = value.trim().replace(/[^\d.-]/g, '');
  if (!normalized) {
    return null;
  }

  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function readPrimitiveText(value: unknown): string {
  if (typeof value === 'string') {
    return value.trim();
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value).trim();
  }
  return '';
}

function extractXianyuText(value: unknown, depth = 0): string {
  if (depth > 3) {
    return '';
  }

  const primitive = readPrimitiveText(value);
  if (primitive) {
    return primitive;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const resolved = extractXianyuText(item, depth + 1);
      if (resolved) {
        return resolved;
      }
    }
    return '';
  }

  if (!value || typeof value !== 'object') {
    return '';
  }

  const record = value as Record<string, unknown>;
  for (const key of ['text', 'value', 'content', 'title', 'label', 'name', 'desc', 'subTitle', 'subtitle', 'rightText']) {
    const resolved = extractXianyuText(record[key], depth + 1);
    if (resolved) {
      return resolved;
    }
  }

  return '';
}

function pickObjectText(
  value: unknown,
  candidates: string[],
): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return '';
  }

  const record = value as Record<string, unknown>;
  for (const key of candidates) {
    const resolved = extractXianyuText(record[key]);
    if (resolved) {
      return resolved;
    }
  }

  return '';
}

function normalizeXianyuDateTime(value: unknown) {
  if (value && typeof value === 'object') {
    return normalizeXianyuDateTime(extractXianyuText(value));
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    const timestamp = value > 1e12 ? value : value * 1000;
    return formatDateTime(new Date(timestamp));
  }

  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  if (/^\d{10,13}$/.test(trimmed)) {
    const numeric = Number(trimmed);
    if (Number.isFinite(numeric)) {
      const timestamp = trimmed.length >= 13 ? numeric : numeric * 1000;
      return formatDateTime(new Date(timestamp));
    }
  }

  const match = trimmed.match(
    /^(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})(?:日)?(?:\s+|T)?(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?/,
  );
  if (!match) {
    return null;
  }

  const [, year, month, day, hour, minute, second] = match;
  return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')} ${hour.padStart(2, '0')}:${minute.padStart(
    2,
    '0',
  )}:${(second ?? '0').padStart(2, '0')}`;
}

function resolveXianyuStructuredValue(value: unknown, depth = 0): unknown {
  if (depth > 4) {
    return value;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (
      (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
      (trimmed.startsWith('[') && trimmed.endsWith(']'))
    ) {
      try {
        return resolveXianyuStructuredValue(JSON.parse(trimmed), depth + 1);
      } catch {
        return value;
      }
    }
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((item) => resolveXianyuStructuredValue(item, depth + 1));
  }

  if (!value || typeof value !== 'object') {
    return value;
  }

  const record = value as Record<string, unknown>;
  const resolved: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(record)) {
    resolved[key] = resolveXianyuStructuredValue(child, depth + 1);
  }
  return resolved;
}

interface XianyuLabelValueEntry {
  label: string;
  value: string;
}

function collectXianyuLabelValueEntries(
  value: unknown,
  bucket: XianyuLabelValueEntry[] = [],
  visited = new WeakSet<object>(),
) {
  if (!value || typeof value !== 'object') {
    return bucket;
  }

  if (visited.has(value)) {
    return bucket;
  }
  visited.add(value);

  if (Array.isArray(value)) {
    for (const item of value) {
      collectXianyuLabelValueEntries(item, bucket, visited);
    }
    return bucket;
  }

  const record = value as Record<string, unknown>;
  const label = pickObjectText(record, ['label', 'title', 'name', 'key']);
  const entryValue = pickObjectText(record, [
    'value',
    'text',
    'content',
    'desc',
    'detail',
    'subTitle',
    'subtitle',
    'rightText',
  ]);
  if (label && entryValue) {
    bucket.push({ label, value: entryValue });
  }

  for (const child of Object.values(record)) {
    collectXianyuLabelValueEntries(child, bucket, visited);
  }

  return bucket;
}

function findXianyuLabelValue(
  entries: XianyuLabelValueEntry[],
  keywords: string[],
) {
  const normalizedKeywords = keywords.map((item) => item.trim()).filter(Boolean);
  for (const entry of entries) {
    const normalizedLabel = entry.label.replace(/\s+/g, '');
    if (normalizedKeywords.some((keyword) => normalizedLabel.includes(keyword))) {
      return entry.value;
    }
  }
  return null;
}

function buildXianyuOrderTimelineEvents(
  timeline: unknown,
  labelEntries: XianyuLabelValueEntry[],
): XianyuWebOrderDetailEvent[] {
  const nodes = Array.isArray(timeline) ? timeline : [];
  const events: XianyuWebOrderDetailEvent[] = [];

  nodes.forEach((node, index) => {
    const title =
      pickObjectText(node, ['title', 'statusName', 'label']) || `订单节点 ${index + 1}`;
    const eventDetail =
      pickObjectText(node, ['desc', 'detail', 'subTitle', 'subtitle']) || `${title} 已同步`;
    const createdAt =
      normalizeXianyuDateTime(
        (node as Record<string, unknown>)?.gmtCreate ??
          (node as Record<string, unknown>)?.time ??
          (node as Record<string, unknown>)?.date,
      ) ??
      normalizeXianyuDateTime(
        findXianyuLabelValue(labelEntries, [
          title.includes('付款') ? '付款时间' : '',
          title.includes('发货') ? '发货时间' : '',
          title.includes('成交') || title.includes('成功') ? '成交时间' : '',
          title.includes('拍下') || title.includes('下单') ? '下单时间' : '',
        ]),
      );

    if (!createdAt) {
      return;
    }

    events.push({
      eventType: `xianyu_status_${index + 1}`,
      eventTitle: title,
      eventDetail,
      operatorName: null,
      createdAt,
    });
  });

  return events.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

function normalizeXianyuItemStatus(status: unknown) {
  const parsed = parseXianyuNumber(status);
  if (parsed === 0) {
    return { code: 0, text: '在售', stock: 1 };
  }
  if (parsed === 1) {
    return { code: 1, text: '已售出', stock: 0 };
  }
  if (parsed === 2) {
    return { code: 2, text: '已下架', stock: 0 };
  }

  return {
    code: parsed ?? -1,
    text: parsed === null ? '未知状态' : `状态${parsed}`,
    stock: 0,
  };
}

function isXianyuMtopSuccess(payload: XianyuMtopPayload<unknown>) {
  const rawRet = Array.isArray(payload.ret) ? payload.ret : [];
  if (rawRet.some((item) => item.includes('SUCCESS'))) {
    return true;
  }

  return rawRet.length === 0 && Boolean(payload.data);
}

function matchMaskedXianyuUserId(maskedUserId: string | null | undefined, fullUserId: string | null | undefined) {
  const masked = maskedUserId?.trim() ?? '';
  const full = fullUserId?.trim() ?? '';
  if (!masked || !full) {
    return false;
  }
  if (masked === full) {
    return true;
  }
  const maskIndex = masked.indexOf('***');
  if (maskIndex < 0) {
    return false;
  }
  const prefix = masked.slice(0, maskIndex);
  const suffix = masked.slice(maskIndex + 3);
  return full.startsWith(prefix) && full.endsWith(suffix);
}

function resolveXianyuImSenderRole(input: {
  senderInfo: {
    userId: string | null;
    nick: string | null;
    fishNick: string | null;
  };
  sellerInfo: {
    userId: string | null;
    nick: string | null;
    fishNick: string | null;
  };
  buyerInfo: {
    userId: string | null;
    nick: string | null;
    fishNick: string | null;
  };
}) {
  const senderUserId = input.senderInfo.userId?.trim() ?? '';
  const senderNick = input.senderInfo.nick?.trim() ?? '';
  const senderFishNick = input.senderInfo.fishNick?.trim() ?? '';
  const matchesIdentity = (candidate: {
    userId: string | null;
    nick: string | null;
    fishNick: string | null;
  }) =>
    matchMaskedXianyuUserId(senderUserId, candidate.userId) ||
    (!!senderNick && senderNick === (candidate.nick?.trim() ?? '')) ||
    (!!senderFishNick && senderFishNick === (candidate.fishNick?.trim() ?? ''));

  if (matchesIdentity(input.sellerInfo)) {
    return 'seller' as const;
  }
  if (matchesIdentity(input.buyerInfo)) {
    return 'buyer' as const;
  }
  return 'unknown' as const;
}

function extractXianyuImMessageText(content: unknown) {
  if (!content || typeof content !== 'object') {
    return '';
  }

  const record = content as Record<string, unknown>;
  return (
    extractXianyuText(record.text) ||
    extractXianyuText(record.content) ||
    extractXianyuText(record.title) ||
    ''
  );
}

function resolveBrowserExecutablePath(explicitPath?: string | null) {
  const candidates = [
    explicitPath?.trim(),
    process.env.APP_XIANYU_BROWSER_EXECUTABLE_PATH?.trim(),
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ].filter((value): value is string => Boolean(value));

  for (const filePath of candidates) {
    if (fs.existsSync(filePath)) {
      return filePath;
    }
  }

  return null;
}

function buildPlaywrightCookies(cookieJar: Map<string, string>) {
  return Array.from(cookieJar.entries()).map(([name, value]) => ({
    name,
    value,
    domain: '.goofish.com',
    path: '/',
    httpOnly: false,
    secure: true,
  }));
}

function buildMiniLoginWarmupUrl() {
  const url = new URL(`${PASSPORT_HOST}/mini_login.htm`);
  url.searchParams.set('lang', 'zh_cn');
  url.searchParams.set('appName', 'xianyu');
  url.searchParams.set('appEntrance', 'web');
  url.searchParams.set('styleType', 'vertical');
  url.searchParams.set('bizParams', '');
  url.searchParams.set('notLoadSsoView', 'false');
  url.searchParams.set('notKeepLogin', 'false');
  url.searchParams.set('isMobile', 'false');
  url.searchParams.set('qrCodeFirst', 'false');
  url.searchParams.set('stie', '77');
  return url.toString();
}

async function safeGoto(page: Page, url: string) {
  try {
    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: 15000,
    });
  } catch {
    await page.goto(url, {
      waitUntil: 'load',
      timeout: 25000,
    });
  }
}

async function warmupBrowserSession(page: Page) {
  await safeGoto(page, buildMiniLoginWarmupUrl());
  await page.waitForTimeout(1200);
  await safeGoto(page, DEFAULT_RENEW_URL);
  await page.waitForTimeout(1800);
  await safeGoto(page, PERSONAL_PAGE_URL);
  await page.waitForTimeout(2600);
}

async function probeXianyuWebSessionViaBrowser(input: {
  cookieText: string;
  showBrowser?: boolean;
  executablePath?: string | null;
}): Promise<XianyuBrowserSessionProbeResult> {
  const executablePath = resolveBrowserExecutablePath(input.executablePath);
  if (!executablePath) {
    throw new Error('未找到可用的 Edge/Chrome 浏览器，请先配置 APP_XIANYU_BROWSER_EXECUTABLE_PATH。');
  }

  const browser = await chromium.launch({
    executablePath,
    headless: input.showBrowser ? false : true,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
      '--disable-features=TranslateUI',
      '--lang=zh-CN',
    ],
  });

  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
      locale: 'zh-CN',
    });

    const cookieJar = parseCookieText(input.cookieText);
    if (cookieJar.size === 0) {
      return {
        cookieText: null,
        currentUrl: null,
        pageTitle: null,
        verificationUrl: null,
        missingKeys: ['cookie'],
        tracknick: null,
        profile: {
          userId: null,
          encryptedUserId: null,
          displayName: null,
        },
      };
    }

    await context.addCookies(buildPlaywrightCookies(cookieJar));
    const page = await context.newPage();
    const profile: XianyuBrowserProfileSnapshot = {
      userId: null,
      encryptedUserId: null,
      displayName: null,
    };

    page.on('response', async (response) => {
      const url = response.url();
      if (!/h5api\.m\.goofish\.com/.test(url)) {
        return;
      }

      try {
        const payload = (await response.json()) as {
          ret?: string[];
          data?: {
            userId?: number | string;
            baseInfo?: {
              encryptedUserId?: string | null;
              kcUserId?: number | string | null;
            };
            module?: {
              base?: {
                displayName?: string | null;
              };
            };
          };
        };
        const rawRet = Array.isArray(payload.ret) ? payload.ret : [];
        if (!rawRet.some((item) => item.includes('SUCCESS'))) {
          return;
        }

        const loginUserId = payload.data?.userId;
        const kcUserId = payload.data?.baseInfo?.kcUserId;
        const encryptedUserId = payload.data?.baseInfo?.encryptedUserId;
        const displayName = payload.data?.module?.base?.displayName;

        if (!profile.userId && (loginUserId || kcUserId)) {
          profile.userId = String(kcUserId ?? loginUserId);
        }
        if (!profile.encryptedUserId && encryptedUserId) {
          profile.encryptedUserId = encryptedUserId.trim();
        }
        if (!profile.displayName && displayName?.trim()) {
          profile.displayName = displayName.trim();
        }
      } catch {
        // Ignore unrelated response payloads.
      }
    });

    await warmupBrowserSession(page);

    const currentUrl = page.url();
    const pageTitle = await page.title().catch(() => null);
    const updatedCookies = await context.cookies();
    const nextJar = new Map<string, string>();
    for (const item of updatedCookies) {
      nextJar.set(item.name, item.value);
    }

    const renewedCookieText = stringifyCookieJar(nextJar);
    const verificationRequired =
      /verify|captcha|passport/i.test(currentUrl) || /验证码|验证/.test(pageTitle ?? '');
    const importantKeys = ['unb', '_m_h5_tk', '_m_h5_tk_enc', 'cookie2', '_tb_token_'];
    const missingKeys = importantKeys.filter((key) => !nextJar.get(key));

    return {
      cookieText: renewedCookieText || null,
      currentUrl,
      pageTitle,
      verificationUrl: verificationRequired ? currentUrl : null,
      missingKeys,
      tracknick: nextJar.get('tracknick')?.trim() || null,
      profile,
    };
  } finally {
    await browser.close();
  }
}

/**
 * 扫码登录后自动用 Playwright 浏览器访问闲鱼页面来补全 _m_h5_tk 等 MTOP 关键 Cookie。
 * 如果入参 Cookie 已包含 _m_h5_tk 则直接返回原始值，不启动浏览器。
 */
export async function enrichQrCookiesViaBrowser(cookieText: string): Promise<{
  enrichedCookieText: string;
  missingKeys: string[];
  enriched: boolean;
  detail: string;
}> {
  const jar = parseCookieText(cookieText);
  const mtopToken = jar.get('_m_h5_tk') ?? jar.get('m_h5_tk') ?? '';
  if (mtopToken) {
    return {
      enrichedCookieText: cookieText,
      missingKeys: [],
      enriched: false,
      detail: '_m_h5_tk 已存在，无需补全。',
    };
  }

  try {
    const probeResult = await probeXianyuWebSessionViaBrowser({
      cookieText,
      showBrowser: false,
      executablePath: null,
    });

    if (probeResult.cookieText && probeResult.missingKeys.length === 0) {
      return {
        enrichedCookieText: probeResult.cookieText,
        missingKeys: [],
        enriched: true,
        detail: '已通过浏览器自动补全 _m_h5_tk 等 MTOP Cookie。',
      };
    }

    // 即使部分缺失，如果拿到了 _m_h5_tk 也返回补全后的 Cookie
    if (probeResult.cookieText) {
      const enrichedJar = parseCookieText(probeResult.cookieText);
      const hasMtop = !!(enrichedJar.get('_m_h5_tk') ?? enrichedJar.get('m_h5_tk'));
      if (hasMtop) {
        return {
          enrichedCookieText: probeResult.cookieText,
          missingKeys: probeResult.missingKeys,
          enriched: true,
          detail: `已补全 _m_h5_tk，但仍缺少：${probeResult.missingKeys.join(', ')}。`,
        };
      }
    }

    return {
      enrichedCookieText: cookieText,
      missingKeys: probeResult.missingKeys,
      enriched: false,
      detail: `浏览器补全未能获取 _m_h5_tk，仍缺少：${probeResult.missingKeys.join(', ')}。`,
    };
  } catch (error) {
    return {
      enrichedCookieText: cookieText,
      missingKeys: ['_m_h5_tk'],
      enriched: false,
      detail: `浏览器补全失败：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export class XianyuQrLoginManager {
  private readonly sessions = new Map<string, InternalQrLoginSession>();

  private readonly authSessionIndex = new Map<string, string>();

  private readonly listeners = new Set<XianyuQrLoginSnapshotListener>();

  private isFinalStatus(status: XianyuQrLoginSessionStatus) {
    return (
      status === 'success' ||
      status === 'expired' ||
      status === 'cancelled' ||
      status === 'verification_required' ||
      status === 'failed'
    );
  }

  private toSnapshot(session: InternalQrLoginSession): XianyuQrLoginSessionSnapshot {
    const now = Date.now();
    if (!this.isFinalStatus(session.status) && now > new Date(session.expiresAt).getTime()) {
      session.status = 'expired';
    }

    return {
      qrLoginId: session.qrLoginId,
      authSessionId: session.authSessionId,
      status: session.status,
      qrCodeUrl: session.qrCodeUrl,
      createdAt: session.createdAt,
      expiresAt: session.expiresAt,
      lastPolledAt: session.lastPolledAt,
      verificationUrl: session.verificationUrl,
      hasCookies: session.cookies.size > 0 && Boolean(session.unb),
      cookieMasked:
        session.cookies.size > 0 && session.unb ? `${session.unb.slice(0, 3)}***${session.unb.slice(-3)}` : null,
      failureReason: session.failureReason,
    };
  }

  private getSnapshotSignal(session: InternalQrLoginSession) {
    const snapshot = this.toSnapshot(session);
    return JSON.stringify({
      status: snapshot.status,
      verificationUrl: snapshot.verificationUrl,
      hasCookies: snapshot.hasCookies,
      cookieMasked: snapshot.cookieMasked,
      failureReason: snapshot.failureReason,
    });
  }

  private emitSnapshot(session: InternalQrLoginSession) {
    const snapshot = this.toSnapshot(session);
    for (const listener of this.listeners) {
      listener(snapshot);
    }
    return snapshot;
  }

  private async getH5Cookies(cookieJar: Map<string, string>) {
    const data = JSON.stringify({ bizScene: 'home' });
    const timestamp = String(Date.now());

    await requestWithCookieJar({
      url: H5_GATEWAY_URL,
      method: 'GET',
      cookieJar,
      headers: buildBaseHeaders({
        referer: PASSPORT_HOST,
        origin: PASSPORT_HOST,
      }),
    });

    const token = getMtopToken(cookieJar);
    if (!token) {
      return;
    }
    if (!token) {
      throw new Error('未能获取二维码登录所需的 m_h5_tk。');
    }

    const response = await requestWithCookieJar({
      url: H5_GATEWAY_URL,
      method: 'POST',
      cookieJar,
      headers: buildBaseHeaders({
        referer: PASSPORT_HOST,
        origin: PASSPORT_HOST,
      }),
      searchParams: {
        jsv: '2.7.2',
        appKey: MTOP_APP_KEY,
        t: timestamp,
        sign: createMtopSign(token, timestamp, MTOP_APP_KEY, data),
        v: '1.0',
        type: 'originaljson',
        dataType: 'json',
        timeout: '20000',
        api: 'mtop.gaia.nodejs.gaia.idle.data.gw.v2.index.get',
        data,
      },
    });

    if (!response.ok) {
      throw new Error(`预热闲鱼 H5 Cookie 失败，HTTP ${response.status}`);
    }
  }

  private async getLoginParams(cookieJar: Map<string, string>) {
    const params = new URLSearchParams({
      lang: 'zh_cn',
      appName: 'xianyu',
      appEntrance: 'web',
      styleType: 'vertical',
      bizParams: '',
      notLoadSsoView: 'false',
      notKeepLogin: 'false',
      isMobile: 'false',
      qrCodeFirst: 'false',
      stie: '77',
      rnd: String(Math.random()),
    });

    const response = await requestWithCookieJar({
      url: `${PASSPORT_HOST}/mini_login.htm`,
      method: 'GET',
      cookieJar,
      headers: buildBaseHeaders({
        referer: PASSPORT_HOST,
        origin: PASSPORT_HOST,
      }),
      searchParams: Object.fromEntries(params.entries()),
    });

    const html = await response.text();
    const match = html.match(/window\.viewData\s*=\s*(\{.*?\});/s);
    if (!match?.[1]) {
      throw new Error('未能解析闲鱼扫码登录参数。');
    }

    const viewData = JSON.parse(match[1]) as { loginFormData?: Record<string, string | number | boolean> };
    if (!viewData.loginFormData) {
      throw new Error('闲鱼登录页未返回 loginFormData。');
    }

    const normalized: Record<string, string> = {};
    for (const [key, value] of Object.entries(viewData.loginFormData)) {
      normalized[key] = String(value);
    }
    normalized.umidTag = 'SERVER';
    return normalized;
  }

  private async monitor(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (!session || session.monitorStarted) {
      return;
    }

    session.monitorStarted = true;

    while (true) {
      const current = this.sessions.get(sessionId);
      if (!current) {
        return;
      }

      if (Date.now() > new Date(current.expiresAt).getTime()) {
        current.status = 'expired';
        this.emitSnapshot(current);
        return;
      }

      if (this.isFinalStatus(current.status)) {
        return;
      }

      const previousSignal = this.getSnapshotSignal(current);

      try {
        const response = await requestWithCookieJar({
          url: `${PASSPORT_HOST}/newlogin/qrcode/query.do`,
          method: 'POST',
          cookieJar: current.cookies,
          headers: buildBaseHeaders({
            referer: PASSPORT_HOST,
            origin: PASSPORT_HOST,
          }),
          body: new URLSearchParams(current.params),
        });

        current.lastPolledAt = formatDateTime(new Date());
        const payload = (await response.json()) as {
          content?: {
            data?: {
              qrCodeStatus?: string;
              iframeRedirect?: boolean;
              iframeRedirectUrl?: string | null;
            };
          };
        };
        const qrCodeStatus = payload.content?.data?.qrCodeStatus;

        if (qrCodeStatus === 'CONFIRMED') {
          if (payload.content?.data?.iframeRedirect) {
            current.status = 'verification_required';
            current.verificationUrl = payload.content?.data?.iframeRedirectUrl?.trim() || null;
          } else {
            current.status = 'success';
            current.unb = current.cookies.get('unb') ?? null;
          }
        } else if (qrCodeStatus === 'SCANED') {
          current.status = 'scanned';
        } else if (qrCodeStatus === 'EXPIRED') {
          current.status = 'expired';
        } else if (qrCodeStatus === 'NEW') {
          current.status = current.status === 'scanned' ? 'scanned' : 'waiting';
        } else if (qrCodeStatus) {
          current.status = 'cancelled';
          current.failureReason = `扫码确认已取消，状态 ${qrCodeStatus}`;
        }
      } catch (error) {
        current.failureReason = error instanceof Error ? error.message : '扫码轮询失败';
      }

      const nextSignal = this.getSnapshotSignal(current);
      if (nextSignal !== previousSignal) {
        this.emitSnapshot(current);
      }

      if (this.isFinalStatus(current.status)) {
        return;
      }

      await new Promise((resolve) => setTimeout(resolve, 800));
    }
  }

  subscribe(listener: XianyuQrLoginSnapshotListener) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async create(authSessionId: string) {
    const existingId = this.authSessionIndex.get(authSessionId);
    const existing = existingId ? this.sessions.get(existingId) : undefined;
    if (existing && !this.isFinalStatus(existing.status) && Date.now() < new Date(existing.expiresAt).getTime()) {
      return this.toSnapshot(existing);
    }

    const cookieJar = new Map<string, string>();
    // 当前网页登录二维码主链路以 mini_login 为准，H5 预热只做补充，不再阻断二维码生成。
    await this.getH5Cookies(cookieJar).catch(() => undefined);
    const loginParams = await this.getLoginParams(cookieJar);

    const response = await requestWithCookieJar({
      url: `${PASSPORT_HOST}/newlogin/qrcode/generate.do`,
      method: 'GET',
      cookieJar,
      headers: buildBaseHeaders({
        referer: PASSPORT_HOST,
        origin: PASSPORT_HOST,
      }),
      searchParams: loginParams,
    });

    const payload = (await response.json()) as {
      content?: {
        success?: boolean;
        data?: {
          t?: string;
          ck?: string;
          codeContent?: string;
        };
      };
    };

    if (!payload.content?.success || !payload.content.data?.codeContent) {
      throw new Error('闲鱼未返回可用的扫码二维码。');
    }

    const qrLoginId = randomUUID();
    const createdAt = new Date();
    const session: InternalQrLoginSession = {
      qrLoginId,
      authSessionId,
      status: 'waiting',
      qrCodeUrl: await QRCode.toDataURL(payload.content.data.codeContent),
      qrContent: payload.content.data.codeContent,
      createdAt: formatDateTime(createdAt),
      expiresAt: formatDateTime(new Date(createdAt.getTime() + 5 * 60 * 1000)),
      lastPolledAt: null,
      cookies: cookieJar,
      params: {
        ...loginParams,
        t: String(payload.content.data.t ?? '').trim(),
        ck: String(payload.content.data.ck ?? '').trim(),
      },
      verificationUrl: null,
      unb: null,
      failureReason: null,
      monitorStarted: false,
    };

    this.sessions.set(qrLoginId, session);
    this.authSessionIndex.set(authSessionId, qrLoginId);
    void this.monitor(qrLoginId);
    return this.emitSnapshot(session);
  }

  getByAuthSessionId(authSessionId: string) {
    const qrLoginId = this.authSessionIndex.get(authSessionId);
    const session = qrLoginId ? this.sessions.get(qrLoginId) : undefined;
    if (!session) {
      return null;
    }

    return this.toSnapshot(session);
  }

  consumeSuccessCookies(authSessionId: string): XianyuQrLoginConsumeResult | null {
    const qrLoginId = this.authSessionIndex.get(authSessionId);
    const session = qrLoginId ? this.sessions.get(qrLoginId) : undefined;
    if (!session || session.status !== 'success' || !session.unb || session.cookies.size === 0) {
      return null;
    }

    return {
      qrLoginId: session.qrLoginId,
      authSessionId,
      cookieText: stringifyCookieJar(session.cookies),
      unb: session.unb,
      source: 'qr_login',
    };
  }

  // ======================== 浏览器扫码登录（Playwright）========================
  // 参照 goofish-watcher 项目：用 Playwright 打开闲鱼实际页面，
  // 触发登录弹窗，截图 QR 码给用户扫描，浏览器自然获取完整 Cookie（含 _m_h5_tk）。

  private browserSessions = new Map<string, {
    authSessionId: string;
    status: 'starting' | 'waiting' | 'scanned' | 'success' | 'expired' | 'failed' | 'blocked';
    qrPngBase64: string | null;
    cookieText: string | null;
    unb: string | null;
    createdAt: string;
    expiresAt: string;
    failureReason: string | null;
    playwright: any;
    browser: any;
    context: any;
    page: any;
    monitorPromise: Promise<void> | null;
  }>();

  private async cleanupBrowserSession(authSessionId: string) {
    const session = this.browserSessions.get(authSessionId);
    if (!session) return;
    try { if (session.page && !session.page.isClosed()) await session.page.close(); } catch {}
    try { if (session.context) await session.context.close(); } catch {}
    try { if (session.browser) await session.browser.close(); } catch {}
    session.page = null;
    session.context = null;
    session.browser = null;
  }

  async startBrowserQrLogin(authSessionId: string): Promise<{
    status: string;
    qrPngBase64: string | null;
    expiresAt: string;
    failureReason: string | null;
  }> {
    // 清理旧的浏览器会话
    if (this.browserSessions.has(authSessionId)) {
      await this.cleanupBrowserSession(authSessionId);
      this.browserSessions.delete(authSessionId);
    }

    const createdAt = new Date();
    const expiresAt = new Date(createdAt.getTime() + 5 * 60 * 1000);

    const session: any = {
      authSessionId,
      status: 'starting',
      qrPngBase64: null,
      cookieText: null,
      unb: null,
      createdAt: formatDateTime(createdAt),
      expiresAt: formatDateTime(expiresAt),
      failureReason: null,
      playwright: null,
      browser: null,
      context: null,
      page: null,
      monitorPromise: null,
    };
    this.browserSessions.set(authSessionId, session);

    try {
      const execPath = process.env.APP_XIANYU_BROWSER_EXECUTABLE_PATH?.trim() || null;
      const launchOpts: any = {
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-dev-shm-usage',
          '--disable-blink-features=AutomationControlled',
          '--disable-gpu',
        ],
      };
      if (execPath) launchOpts.executablePath = execPath;

      session.browser = await chromium.launch(launchOpts);
      session.context = await session.browser.newContext({
        viewport: { width: 1920, height: 1080 },
        locale: 'zh-CN',
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
      });

      const page = await session.context.newPage();
      session.page = page;

      // 反检测
      await page.addInitScript(`
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        Object.defineProperty(navigator, 'languages', { get: () => ['zh-CN', 'zh', 'en'] });
        Object.defineProperty(navigator, 'plugins', { get: () => [1,2,3,4,5] });
        if (window.navigator) window.navigator.chrome = { runtime: {} };
      `);

      await page.goto('https://www.goofish.com/search?q=iphone', {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });

      // 等待登录弹窗
      let loginDetected = false;
      for (let i = 0; i < 20; i++) {
        await new Promise(r => setTimeout(r, 1000));
        if (page.isClosed()) {
          session.status = 'failed';
          session.failureReason = '浏览器页面意外关闭';
          return this.getBrowserQrStatus(authSessionId);
        }
        try {
          const txt = await page.innerText('body');
          if (txt.includes('非法访问')) {
            session.status = 'blocked';
            session.failureReason = '被闲鱼拦截：非法访问';
            return this.getBrowserQrStatus(authSessionId);
          }
          if (txt.includes('手机扫码安全登录') || txt.includes('闲鱼APP扫码') || txt.includes('短信登录')) {
            loginDetected = true;
            break;
          }
        } catch {}
      }

      if (!loginDetected) {
        session.status = 'failed';
        session.failureReason = '未检测到登录弹窗';
        return this.getBrowserQrStatus(authSessionId);
      }

      // 截图 QR 码
      let qrPng: Buffer | null = null;
      try {
        const dialogs = await page.$$('[role="dialog"], [class*="modal"], [class*="login"]');
        let bestDlg: any = null;
        let bestA = 0;
        for (const el of dialogs) {
          const box = await el.boundingBox();
          if (!box) continue;
          const a = box.width * box.height;
          if (a > bestA) { bestDlg = el; bestA = a; }
        }

        if (bestDlg && bestA >= 500 * 300) {
          const qrEls = await bestDlg.$$('svg, canvas, img');
          let bestQr: any = null;
          let bestQrA = 0;
          for (const el of qrEls) {
            const box = await el.boundingBox();
            if (!box || box.width < 150 || box.height < 150) continue;
            const ratio = box.width / box.height;
            if (ratio < 0.8 || ratio > 1.25) continue;
            const a = box.width * box.height;
            if (a > bestQrA) { bestQr = el; bestQrA = a; }
          }
          qrPng = bestQr && bestQrA >= 200 * 200
            ? await bestQr.screenshot({ type: 'png' })
            : await bestDlg.screenshot({ type: 'png' });
        }
      } catch {}

      const finalQrPng = qrPng ?? (await page.screenshot({ type: 'png' }));
      session.qrPngBase64 = finalQrPng.toString('base64');
      session.status = 'waiting';
      session.monitorPromise = this.monitorBrowserLogin(authSessionId);

      return this.getBrowserQrStatus(authSessionId);
    } catch (error: any) {
      session.status = 'failed';
      session.failureReason = error?.message || String(error);
      await this.cleanupBrowserSession(authSessionId);
      return this.getBrowserQrStatus(authSessionId);
    }
  }

  private async monitorBrowserLogin(authSessionId: string) {
    const session = this.browserSessions.get(authSessionId);
    if (!session?.page || !session?.context) return;

    const page = session.page;
    const context = session.context;

    try {
      const before = await context.cookies();
      const beforeNames = new Set(before.map((c: any) => c.name));
      const strongAuth = new Set(['tracknick', '_nk_', 'lgc', 'unb']);
      const timeout = 5 * 60 * 1000;
      const start = Date.now();

      while (Date.now() - start < timeout) {
        await new Promise(r => setTimeout(r, 2000));
        if (session.status !== 'waiting' && session.status !== 'scanned') return;
        if (page.isClosed()) {
          session.status = 'failed';
          session.failureReason = '浏览器页面意外关闭';
          return;
        }

        const now = await context.cookies();
        const nowNames = new Set(now.map((c: any) => c.name));
        const hasStrong = now.some((c: any) => strongAuth.has(c.name));
        const gained = [...nowNames].filter((n: any) => !beforeNames.has(n));

        const loginVisible = await page.innerText('body').then(
          (t: string) => t.includes('短信登录') || t.includes('手机扫码') || t.includes('闲鱼APP扫码'),
          () => false,
        );

        if (hasStrong || (!loginVisible && gained.length > 0)) {
          // 跳转首页验证
          try {
            await page.goto('https://www.goofish.com/', { waitUntil: 'domcontentloaded', timeout: 30000 });
            await new Promise(r => setTimeout(r, 3000));
          } catch {}

          const vText = await page.innerText('body').catch(() => '');
          if (vText.includes('短信登录') || vText.includes('手机扫码安全登录') || vText.includes('闲鱼APP扫码')) {
            continue;
          }

          // 成功
          const final = await context.cookies();
          session.cookieText = final.map((c: any) => `${c.name}=${c.value}`).join('; ');
          session.unb = final.find((c: any) => c.name === 'unb')?.value ?? null;
          session.status = 'success';

          if (session.unb) {
            const snap: XianyuQrLoginSessionSnapshot = {
              qrLoginId: `browser_${authSessionId}`,
              authSessionId,
              status: 'success',
              qrCodeUrl: '',
              createdAt: session.createdAt,
              expiresAt: session.expiresAt,
              lastPolledAt: formatDateTime(new Date()),
              verificationUrl: null,
              hasCookies: true,
              cookieMasked: `${session.unb.slice(0, 3)}***${session.unb.slice(-3)}`,
              failureReason: null,
            };
            for (const l of this.listeners) l(snap);
          }
          return;
        }
      }

      session.status = 'expired';
      session.failureReason = '浏览器扫码登录超时（5分钟）';
    } catch (e: any) {
      session.status = 'failed';
      session.failureReason = e?.message || String(e);
    } finally {
      await this.cleanupBrowserSession(authSessionId);
    }
  }

  getBrowserQrStatus(authSessionId: string) {
    const s = this.browserSessions.get(authSessionId);
    if (!s) {
      return { status: 'not_found', qrPngBase64: null, expiresAt: '', failureReason: '没有活跃的浏览器扫码会话', cookieText: null, unb: null };
    }
    if (s.status === 'waiting' && Date.now() > new Date(s.expiresAt).getTime()) {
      s.status = 'expired';
      s.failureReason = '浏览器扫码二维码已过期';
      void this.cleanupBrowserSession(authSessionId);
    }
    return {
      status: s.status,
      qrPngBase64: s.qrPngBase64,
      expiresAt: s.expiresAt,
      failureReason: s.failureReason,
      cookieText: s.status === 'success' ? s.cookieText : null,
      unb: s.status === 'success' ? s.unb : null,
    };
  }

  consumeBrowserQrCookies(authSessionId: string): XianyuQrLoginConsumeResult | null {
    const s = this.browserSessions.get(authSessionId);
    if (!s || s.status !== 'success' || !s.cookieText) return null;
    const result: XianyuQrLoginConsumeResult = {
      qrLoginId: `browser_${authSessionId}`,
      authSessionId,
      cookieText: s.cookieText,
      unb: s.unb,
      source: 'browser_qr_login',
    };
    void this.cleanupBrowserSession(authSessionId);
    this.browserSessions.delete(authSessionId);
    return result;
  }

}

export const xianyuQrLoginManager = new XianyuQrLoginManager();

export async function verifyXianyuWebSessionCookie(cookieText: string): Promise<XianyuCredentialVerificationResult> {
  const cookieJar = parseCookieText(cookieText);
  if (cookieJar.size === 0) {
    return {
      riskLevel: 'offline',
      detail: '未提供可用的 Cookie，无法执行登录态校验。',
      verificationUrl: null,
      refreshedCookieText: null,
      rawRet: [],
    };
  }

  const token = getMtopToken(cookieJar);
  if (!token) {
    return {
      riskLevel: 'offline',
      detail: 'Cookie 中缺少 _m_h5_tk，当前登录态已失效或不完整。',
      verificationUrl: null,
      refreshedCookieText: null,
      rawRet: [],
    };
  }

  const timestamp = String(Date.now());
  const data = JSON.stringify({
    appKey: LOGIN_APP_KEY,
    deviceId: randomDeviceId(),
  });

  const response = await requestWithCookieJar({
    url: LOGIN_TOKEN_URL,
    method: 'POST',
    cookieJar,
    headers: buildBaseHeaders({
      referer: `${PASSPORT_HOST}/`,
      origin: PASSPORT_HOST,
    }),
    searchParams: {
      jsv: '2.7.2',
      appKey: MTOP_APP_KEY,
      t: timestamp,
      sign: createMtopSign(token, timestamp, MTOP_APP_KEY, data),
      v: '1.0',
      type: 'originaljson',
      accountSite: 'xianyu',
      dataType: 'json',
      timeout: '20000',
      api: 'mtop.taobao.idlemessage.pc.login.token',
      sessionOption: 'AutoLoginOnly',
      spm_cnt: 'a21ybx.im.0.0',
    },
    body: new URLSearchParams({
      data,
    }),
  });

  const payload = (await response.json()) as {
    ret?: string[];
    data?: {
      url?: string | null;
    };
  };
  const rawRet = (payload.ret ?? []).filter((item): item is string => typeof item === 'string');
  const refreshedCookieText = stringifyCookieJar(cookieJar);

  if (rawRet.some((item) => item.includes('SUCCESS'))) {
    return {
      riskLevel: 'healthy',
      detail: '登录态校验通过，关键登录接口可正常返回。',
      verificationUrl: null,
      refreshedCookieText: refreshedCookieText !== cookieText ? refreshedCookieText : null,
      rawRet,
    };
  }

  if (rawRet.some((item) => item.includes('FAIL_SYS_USER_VALIDATE'))) {
    return {
      riskLevel: 'warning',
      detail: '命中平台风控，需要继续完成手机验证或验证码处理。',
      verificationUrl: getVerificationUrlFromPayload(payload),
      refreshedCookieText: refreshedCookieText !== cookieText ? refreshedCookieText : null,
      rawRet,
    };
  }

  if (
    rawRet.some(
      (item) =>
        item.includes('FAIL_SYS_SESSION_EXPIRED') ||
        item.includes('FAIL_SYS_TOKEN_EXOIRED') ||
        item.includes('FAIL_SYS_TOKEN_EMPTY') ||
        item.includes('FAIL_SYS_ILLEGAL_ACCESS'),
    )
  ) {
    return {
      riskLevel: 'offline',
      detail: '登录态已过期或关键令牌失效，需要重新登录或浏览器续登。',
      verificationUrl: null,
      refreshedCookieText: refreshedCookieText !== cookieText ? refreshedCookieText : null,
      rawRet,
    };
  }

  return {
    riskLevel: 'abnormal',
    detail: rawRet.length > 0 ? `登录态校验失败：${rawRet.join(' | ')}` : '登录态校验失败，平台未返回明确结果。',
    verificationUrl: getVerificationUrlFromPayload(payload),
    refreshedCookieText: refreshedCookieText !== cookieText ? refreshedCookieText : null,
    rawRet,
  };
}

export async function fetchXianyuWebSessionProducts(input: {
  cookieText: string;
  userId: string;
  pageSize?: number;
  maxPages?: number;
}): Promise<XianyuWebProductListResult> {
  const cookieJar = parseCookieText(input.cookieText);
  if (cookieJar.size === 0) {
    throw new Error('当前没有可用的网页登录态，无法同步闲鱼商品。');
  }

  const userId = input.userId.trim();
  if (!userId) {
    throw new Error('缺少卖家 ID，无法同步闲鱼商品。');
  }

  const pageSize = Math.max(1, Math.min(50, Math.trunc(input.pageSize ?? 20)));
  const maxPages = Math.max(1, Math.min(20, Math.trunc(input.maxPages ?? 5)));
  const items: XianyuWebProductItem[] = [];
  const seenIds = new Set<string>();
  let currentPage = 1;
  let pageCount = 0;
  let totalCount: number | null = null;
  let latestRet: string[] = [];

  while (pageCount < maxPages) {
    const payload = await postXianyuMtopWithCookieJar<{
      cardList?: Array<{
        cardData?: {
          id?: string | number;
          title?: string | null;
          categoryId?: string | number | null;
          itemStatus?: number | string | null;
          detailUrl?: string | null;
          detailParams?: {
            soldPrice?: string | number | null;
            picUrl?: string | null;
            title?: string | null;
          };
          picInfo?: {
            picUrl?: string | null;
          };
          priceInfo?: {
            price?: string | number | null;
          };
        };
      }>;
      nextPage?: boolean | number | string | null;
      totalCount?: number | string | null;
    }>({
      cookieJar,
      api: 'mtop.idle.web.xyh.item.list',
      data: {
        needGroupInfo: currentPage === 1,
        pageNumber: currentPage,
        userId,
        pageSize,
      },
    });

    const rawRet = Array.isArray(payload.ret) ? payload.ret : [];
    latestRet = rawRet;
    if (!rawRet.some((item) => item.includes('SUCCESS'))) {
      throw new Error(rawRet.length > 0 ? `拉取闲鱼商品失败：${rawRet.join(' | ')}` : '拉取闲鱼商品失败，平台未返回成功结果。');
    }

    const responseData = payload.data ?? {};
    if (totalCount === null) {
      totalCount = parseXianyuNumber(responseData.totalCount);
    }

    const cards = Array.isArray(responseData.cardList) ? responseData.cardList : [];
    for (const card of cards) {
      const raw = card.cardData;
      const rawId =
        raw?.id !== undefined && raw?.id !== null ? String(raw.id).trim() : '';
      if (!rawId || seenIds.has(rawId)) {
        continue;
      }

      const status = normalizeXianyuItemStatus(raw?.itemStatus);
      const title = raw?.title?.trim() || raw?.detailParams?.title?.trim() || `闲鱼商品 ${rawId}`;
      const categoryId =
        raw?.categoryId !== undefined && raw?.categoryId !== null
          ? String(raw.categoryId).trim()
          : null;
      const price =
        parseXianyuNumber(raw?.priceInfo?.price) ??
        parseXianyuNumber(raw?.detailParams?.soldPrice) ??
        0;
      const soldPrice = parseXianyuNumber(raw?.detailParams?.soldPrice);

      seenIds.add(rawId);
      items.push({
        id: rawId,
        title,
        categoryId,
        categoryLabel: categoryId ? `类目#${categoryId}` : '未分类',
        price,
        soldPrice,
        itemStatus: status.code,
        itemStatusText: status.text,
        stock: status.stock,
        coverUrl: raw?.picInfo?.picUrl?.trim() || raw?.detailParams?.picUrl?.trim() || null,
        detailUrl: raw?.detailUrl?.trim() || null,
      });
    }

    pageCount += 1;
    const nextPage = responseData.nextPage;
    const resolvedNextPage =
      typeof nextPage === 'number'
        ? nextPage
        : typeof nextPage === 'string' && /^\d+$/.test(nextPage.trim())
          ? Number(nextPage.trim())
          : null;

    if (resolvedNextPage && resolvedNextPage > currentPage && cards.length > 0) {
      currentPage = resolvedNextPage;
      continue;
    }

    if (nextPage === true && cards.length > 0) {
      currentPage += 1;
      continue;
    }

    break;
  }

  return {
    items,
    totalCount,
    pageCount,
    rawRet: latestRet,
  };
}

export async function fetchXianyuWebSessionSellerCompletedTrades(input: {
  cookieText: string;
  userId: string;
  pageSize?: number;
  maxPages?: number;
}): Promise<XianyuWebCompletedTradeListResult> {
  const cookieJar = parseCookieText(input.cookieText);
  if (cookieJar.size === 0) {
    throw new Error('当前没有可用的网页登录态，无法同步闲鱼成交订单。');
  }

  const userId = input.userId.trim();
  if (!userId) {
    throw new Error('缺少卖家 ID，无法拉取闲鱼已完成成交单。');
  }

  const pageSize = Math.max(1, Math.min(50, Math.trunc(input.pageSize ?? 20)));
  const maxPages = Math.max(1, Math.min(20, Math.trunc(input.maxPages ?? 10)));
  const items: XianyuWebCompletedTradeCard[] = [];
  const seenTradeIds = new Set<string>();
  let currentPage = 1;
  let pageCount = 0;
  let totalCount: number | null = null;
  let latestRet: string[] = [];

  while (pageCount < maxPages) {
    const payload = await postXianyuMtopWithCookieJar<{
      cardList?: Array<{
        cardData?: {
          tradeId?: string | number | null;
          gmtCreate?: string | number | null;
          feedback?: string | null;
          raterUserNick?: string | null;
          rateTagList?: Array<{ tagName?: string | null } | string> | null;
        };
      }>;
      nextPage?: boolean | number | string | null;
      totalCount?: string | number | null;
    }>({
      cookieJar,
      api: 'mtop.idle.web.trade.rate.list',
      data: {
        pageNumber: currentPage,
        pageSize,
        ratedUid: userId,
        rateType: 6,
      },
      spmCnt: 'a21ybx.personal.0.0',
    });

    const rawRet = Array.isArray(payload.ret) ? payload.ret : [];
    latestRet = rawRet;
    if (!rawRet.some((item) => item.includes('SUCCESS'))) {
      throw new Error(
        rawRet.length > 0
          ? `拉取闲鱼已完成成交单失败：${rawRet.join(' | ')}`
          : '拉取闲鱼已完成成交单失败，平台未返回成功结果。',
      );
    }

    const responseData = payload.data ?? {};
    if (totalCount === null) {
      totalCount = parseXianyuNumber(responseData.totalCount);
    }

    const cards = Array.isArray(responseData.cardList) ? responseData.cardList : [];
    for (const card of cards) {
      const raw = card.cardData;
      const tradeId =
        raw?.tradeId !== undefined && raw.tradeId !== null ? String(raw.tradeId).trim() : '';
      if (!tradeId || seenTradeIds.has(tradeId)) {
        continue;
      }

      seenTradeIds.add(tradeId);
      items.push({
        tradeId,
        createdAt: normalizeXianyuDateTime(raw?.gmtCreate),
        buyerName: raw?.raterUserNick?.trim() || null,
        feedback: raw?.feedback?.trim() || null,
        rateTags: Array.isArray(raw?.rateTagList)
          ? raw.rateTagList
              .map((entry) =>
                typeof entry === 'string'
                  ? entry.trim()
                  : entry?.tagName?.trim() || '',
              )
              .filter(Boolean)
          : [],
      });
    }

    pageCount += 1;
    const nextPage = responseData.nextPage;
    const resolvedNextPage =
      typeof nextPage === 'number'
        ? nextPage
        : typeof nextPage === 'string' && /^\d+$/.test(nextPage.trim())
          ? Number(nextPage.trim())
          : null;

    if (resolvedNextPage && resolvedNextPage > currentPage && cards.length > 0) {
      currentPage = resolvedNextPage;
      continue;
    }

    if (nextPage === true && cards.length > 0) {
      currentPage += 1;
      continue;
    }

    break;
  }

  return {
    items,
    totalCount,
    pageCount,
    rawRet: latestRet,
  };
}

export async function fetchXianyuWebSessionOrderDetail(input: {
  cookieText: string;
  tradeId: string;
}): Promise<XianyuWebOrderDetailResult> {
  return fetchXianyuWebSessionCompletedOrderDetail(input);

  const cookieJar = parseCookieText(input.cookieText);
  if (cookieJar.size === 0) {
    throw new Error('当前没有可用的网页登录态，无法拉取闲鱼订单详情。');
  }

  const tradeId = input.tradeId.trim();
  if (!tradeId) {
    throw new Error('缺少成交单号，无法拉取闲鱼订单详情。');
  }

  const payload = await postXianyuMtopWithCookieJar<{
    orderId?: string | number | null;
    peerUserId?: string | number | null;
    utArgs?: {
      orderId?: string | number | null;
      orderStatusName?: string | null;
    };
    components?: {
      orderStatusVO?: {
        nodes?: unknown[];
      };
      orderInfoVO?: {
        itemInfo?: {
          itemId?: string | number | null;
          title?: string | null;
          buyAmount?: string | number | null;
          price?: string | number | null;
        };
        orderInfoList?: unknown[];
        priceInfo?: {
          amount?: { value?: string | number | null } | null;
          expectBill?: { value?: string | number | null } | null;
          softwareBill?: { value?: string | number | null } | null;
        };
      };
    };
  }>({
    cookieJar,
    api: 'mtop.idle.web.trade.order.detail',
    data: {
      tid: tradeId,
    },
    spmCnt: 'a21ybx.orderdetail.0.0',
  });

  const rawRet = (payload.ret ?? []).filter((item): item is string => typeof item === 'string');
  if (!rawRet.some((item) => item.includes('SUCCESS'))) {
    throw new Error(
      rawRet.length > 0
        ? `拉取闲鱼订单详情失败：${rawRet.join(' | ')}`
        : '拉取闲鱼订单详情失败，平台未返回成功结果。',
    );
  }

  const responseData = resolveXianyuStructuredValue(payload.data ?? {}) as {
    orderId?: string | number | null;
    peerUserId?: string | number | null;
    utArgs?: {
      orderId?: string | number | null;
      orderStatusName?: string | null;
    };
    components?: {
      orderStatusVO?: unknown;
      orderInfoVO?: unknown;
    };
  };
  const orderInfo = (resolveXianyuStructuredValue(responseData.components?.orderInfoVO ?? {}) ?? {}) as {
    itemInfo?: {
      itemId?: string | number | null;
      title?: string | null;
      buyAmount?: string | number | null;
      price?: string | number | null;
    };
    orderInfoList?: unknown[];
    priceInfo?: {
      amount?: { value?: string | number | null } | null;
      expectBill?: { value?: string | number | null } | null;
      softwareBill?: { value?: string | number | null } | null;
    };
  };
  const orderStatus = (resolveXianyuStructuredValue(responseData.components?.orderStatusVO ?? {}) ?? {}) as {
    nodes?: unknown[];
  };
  const itemInfo = orderInfo.itemInfo ?? {};
  const priceInfo = orderInfo.priceInfo ?? {};
  const labelEntries = collectXianyuLabelValueEntries(orderInfo.orderInfoList ?? []);
  const paidAt =
    normalizeXianyuDateTime(findXianyuLabelValue(labelEntries, ['付款时间'])) ??
    normalizeXianyuDateTime(findXianyuLabelValue(labelEntries, ['下单时间'])) ??
    normalizeXianyuDateTime(findXianyuLabelValue(labelEntries, ['拍下时间'])) ??
    formatDateTime(new Date());
  const shippedAt = normalizeXianyuDateTime(findXianyuLabelValue(labelEntries, ['发货时间']));
  const completedAt = normalizeXianyuDateTime(findXianyuLabelValue(labelEntries, ['成交时间']));
  const quantity = Math.max(1, Math.trunc(parseXianyuNumber(itemInfo.buyAmount) ?? 1));
  const paidAmount =
    parseXianyuAmount(priceInfo.amount?.value) ??
    parseXianyuAmount(priceInfo.expectBill?.value) ??
    parseXianyuAmount(itemInfo.price) ??
    0;
  const unitPrice =
    parseXianyuAmount(itemInfo.price) ??
    (quantity > 0 ? Number((paidAmount / quantity).toFixed(2)) : paidAmount);
  const grossAmount = Number((unitPrice * quantity).toFixed(2));
  const discountAmount = Math.max(0, Number((grossAmount - paidAmount).toFixed(2)));
  const events = buildXianyuOrderTimelineEvents(
    (responseData.components?.orderStatusVO as { nodes?: unknown[] } | undefined)?.nodes,
    labelEntries,
  );

  return {
    orderNo:
      readPrimitiveText(responseData.utArgs?.orderId) ||
      readPrimitiveText(findXianyuLabelValue(labelEntries, ['订单编号'])) ||
      tradeId,
    buyerUserId: readPrimitiveText(responseData.peerUserId) || null,
    buyerName:
      readPrimitiveText(findXianyuLabelValue(labelEntries, ['买家昵称'])) || null,
    itemId: readPrimitiveText(itemInfo.itemId) || null,
    itemTitle: itemInfo.title?.trim() || `闲鱼成交商品 ${tradeId}`,
    quantity,
    unitPrice,
    paidAmount,
    discountAmount,
    refundAmount: 0,
    paymentNo:
      readPrimitiveText(findXianyuLabelValue(labelEntries, ['支付宝交易号'])) || null,
    orderStatusName: responseData.utArgs?.orderStatusName?.trim() || null,
    paidAt,
    shippedAt,
    completedAt,
    events,
    rawRet,
  };
}

export async function fetchXianyuWebSessionCompletedOrderDetail(input: {
  cookieText: string;
  tradeId: string;
}): Promise<XianyuWebOrderDetailResult> {
  const cookieJar = parseCookieText(input.cookieText);
  if (cookieJar.size === 0) {
    throw new Error('当前没有可用的网页登录态，无法拉取闲鱼订单详情。');
  }

  const tradeId = input.tradeId.trim();
  if (!tradeId) {
    throw new Error('缺少成交单号，无法拉取闲鱼订单详情。');
  }

  const payload = await postXianyuMtopWithCookieJar<{
    orderId?: string | number | null;
    peerUserId?: string | number | null;
    utArgs?: {
      orderId?: string | number | null;
      orderStatusName?: string | null;
    };
    components?: {
      orderStatusVO?: unknown;
      orderInfoVO?: unknown;
    };
  }>({
    cookieJar,
    api: 'mtop.idle.web.trade.order.detail',
    data: {
      tid: tradeId,
    },
    spmCnt: 'a21ybx.orderdetail.0.0',
  });

  const rawRet = Array.isArray(payload.ret) ? payload.ret : [];
  if (!rawRet.some((item) => item.includes('SUCCESS'))) {
    throw new Error(
      rawRet.length > 0
        ? `拉取闲鱼订单详情失败：${rawRet.join(' | ')}`
        : '拉取闲鱼订单详情失败，平台未返回成功结果。',
    );
  }

  const responseData = resolveXianyuStructuredValue(payload.data ?? {}) as {
    orderId?: string | number | null;
    peerUserId?: string | number | null;
    utArgs?: {
      orderId?: string | number | null;
      orderStatusName?: string | null;
    };
    components?: unknown[];
  };
  const componentList = Array.isArray(responseData.components)
    ? (resolveXianyuStructuredValue(responseData.components) as Array<{
        render?: string | null;
        data?: unknown;
      }>)
    : [];
  const orderInfoComponent = componentList.find((item) => item.render === 'orderInfoVO');
  const orderStatusComponent = componentList.find((item) => item.render === 'orderStatusVO');
  const orderInfo = (resolveXianyuStructuredValue(orderInfoComponent?.data ?? {}) ?? {}) as {
    itemInfo?: {
      itemId?: string | number | null;
      title?: string | null;
      buyAmount?: string | number | null;
      price?: string | number | null;
    };
    orderInfoList?: unknown[];
    priceInfo?: {
      amount?: { value?: string | number | null } | null;
      expectBill?: { value?: string | number | null } | null;
      softwareBill?: { value?: string | number | null } | null;
    };
  };
  const orderStatus = (resolveXianyuStructuredValue(orderStatusComponent?.data ?? {}) ?? {}) as {
    orderStatusNodeList?: unknown[];
    nodes?: unknown[];
  };
  const itemInfo = orderInfo.itemInfo ?? {};
  const priceInfo = orderInfo.priceInfo ?? {};
  const labelEntries = collectXianyuLabelValueEntries(orderInfo.orderInfoList ?? []);
  const paidAt =
    normalizeXianyuDateTime(findXianyuLabelValue(labelEntries, ['付款时间'])) ??
    normalizeXianyuDateTime(findXianyuLabelValue(labelEntries, ['下单时间'])) ??
    normalizeXianyuDateTime(findXianyuLabelValue(labelEntries, ['拍下时间'])) ??
    formatDateTime(new Date());
  const shippedAt = normalizeXianyuDateTime(findXianyuLabelValue(labelEntries, ['发货时间']));
  const completedAt = normalizeXianyuDateTime(findXianyuLabelValue(labelEntries, ['成交时间']));
  const quantity = Math.max(1, Math.trunc(parseXianyuNumber(itemInfo.buyAmount) ?? 1));
  const paidAmount =
    parseXianyuAmount(priceInfo.amount?.value) ??
    parseXianyuAmount(priceInfo.expectBill?.value) ??
    parseXianyuAmount(itemInfo.price) ??
    0;
  const unitPrice =
    parseXianyuAmount(itemInfo.price) ??
    (quantity > 0 ? Number((paidAmount / quantity).toFixed(2)) : paidAmount);
  const grossAmount = Number((unitPrice * quantity).toFixed(2));
  const discountAmount = Math.max(0, Number((grossAmount - paidAmount).toFixed(2)));
  const paidAtResolved =
    normalizeXianyuDateTime(findXianyuLabelValue(labelEntries, ['付款时间'])) ??
    normalizeXianyuDateTime(findXianyuLabelValue(labelEntries, ['下单时间'])) ??
    normalizeXianyuDateTime(findXianyuLabelValue(labelEntries, ['拍下时间'])) ??
    paidAt;
  const shippedAtResolved =
    normalizeXianyuDateTime(findXianyuLabelValue(labelEntries, ['发货时间'])) ?? shippedAt;
  const completedAtResolved =
    normalizeXianyuDateTime(findXianyuLabelValue(labelEntries, ['成交时间'])) ?? completedAt;
  const orderNoResolved =
    extractXianyuText(responseData.utArgs?.orderId) ||
    extractXianyuText(findXianyuLabelValue(labelEntries, ['订单编号'])) ||
    tradeId;
  const buyerNameResolved =
    extractXianyuText(findXianyuLabelValue(labelEntries, ['买家昵称'])) || null;
  const itemIdResolved =
    extractXianyuText(itemInfo.itemId) ||
    extractXianyuText((responseData as { itemId?: unknown }).itemId) ||
    null;
  const itemTitleResolved = extractXianyuText(itemInfo.title) || `闲鱼成交商品 ${tradeId}`;
  const paymentNoResolved =
    extractXianyuText(findXianyuLabelValue(labelEntries, ['支付宝交易号'])) || null;
  const eventsResolved = buildXianyuOrderTimelineEvents(orderStatus.orderStatusNodeList, labelEntries);

  return {
    orderNo: orderNoResolved,
    buyerUserId: extractXianyuText(responseData.peerUserId) || null,
    buyerName: buyerNameResolved,
    itemId: itemIdResolved,
    itemTitle: itemTitleResolved,
    quantity,
    unitPrice,
    paidAmount,
    discountAmount,
    refundAmount: 0,
    paymentNo: paymentNoResolved,
    orderStatusName: extractXianyuText(responseData.utArgs?.orderStatusName) || null,
    paidAt: paidAtResolved,
    shippedAt: shippedAtResolved,
    completedAt: completedAtResolved,
    events: eventsResolved,
    rawRet,
  };

  return {
    orderNo:
      extractXianyuText(responseData.utArgs?.orderId) ||
      extractXianyuText(findXianyuLabelValue(labelEntries, ['订单编号'])) ||
      tradeId,
    buyerUserId: extractXianyuText(responseData.peerUserId) || null,
    buyerName: extractXianyuText(findXianyuLabelValue(labelEntries, ['买家昵称'])) || null,
    itemId: extractXianyuText(itemInfo.itemId) || null,
    itemTitle: extractXianyuText(itemInfo.title) || `闲鱼成交商品 ${tradeId}`,
    quantity,
    unitPrice,
    paidAmount,
    discountAmount,
    refundAmount: 0,
    paymentNo: extractXianyuText(findXianyuLabelValue(labelEntries, ['支付宝交易号'])) || null,
    orderStatusName: extractXianyuText(responseData.utArgs?.orderStatusName) || null,
    paidAt,
    shippedAt,
    completedAt,
    events: buildXianyuOrderTimelineEvents(orderStatus.nodes, labelEntries),
    rawRet,
  };
}

async function fetchXianyuWebSessionImSessions(input: {
  cookieText: string;
  maxSessions?: number;
  maxPages?: number;
}): Promise<{
  sessions: XianyuWebImSession[];
  totalCount: number;
  pageCount: number;
  rawRet: string[];
}> {
  const cookieJar = parseCookieText(input.cookieText);
  if (cookieJar.size === 0) {
    throw new Error('当前没有可用的网页登录态，无法拉取闲鱼会话列表。');
  }

  const maxSessions = Math.max(1, Math.min(50, Math.trunc(input.maxSessions ?? 20)));
  const maxPages = Math.max(1, Math.min(10, Math.trunc(input.maxPages ?? 3)));
  const sessions: XianyuWebImSession[] = [];
  const seenSessionIds = new Set<string>();
  let totalCount = 0;
  let pageCount = 0;
  let latestRet: string[] = [];
  let nextSortIndex: number | null = null;
  let nextSessionId: string | null = null;

  while (pageCount < maxPages && sessions.length < maxSessions) {
    const requestData: Record<string, unknown> = {
      sessionTypes: '[3]',
      fetchNum: Math.min(30, maxSessions - sessions.length),
    };
    if (nextSortIndex !== null) {
      requestData.sortIndex = nextSortIndex;
    }
    if (nextSessionId) {
      requestData.sessionId = nextSessionId;
    }

    const payload = await postXianyuMtopWithCookieJar<{
      hasMore?: boolean | null;
      sessions?: Array<{
        message?: {
          summary?: {
            summary?: string | null;
            ts?: string | number | null;
            version?: string | number | null;
            unread?: string | number | null;
            sortIndex?: string | number | null;
          };
        };
        session?: {
          sessionId?: string | number | null;
          sessionType?: string | number | null;
          itemInfo?: {
            itemId?: string | number | null;
            mainPic?: string | null;
            sellerInfo?: {
              userId?: string | number | null;
            };
          };
          ownerInfo?: {
            userId?: string | number | null;
            nick?: string | null;
            fishNick?: string | null;
          };
          userInfo?: {
            userId?: string | number | null;
            nick?: string | null;
            fishNick?: string | null;
          };
        };
      }>;
    }>({
      cookieJar,
      api: 'mtop.taobao.idlemessage.pc.session.sync',
      apiVersion: '3.0',
      data: requestData,
      referer: 'https://www.goofish.com/im',
      origin: 'https://www.goofish.com',
      spmCnt: 'a21ybx.im.0.0',
    });

    latestRet = Array.isArray(payload.ret) ? payload.ret : [];
    if (!isXianyuMtopSuccess(payload)) {
      throw new Error(
        latestRet.length > 0
          ? `拉取闲鱼会话列表失败：${latestRet.join(' | ')}`
          : '拉取闲鱼会话列表失败，平台未返回成功结果。',
      );
    }

    const responseData = payload.data ?? {};
    const items = Array.isArray(responseData.sessions) ? responseData.sessions : [];
    pageCount += 1;
    totalCount += items.length;

    for (const item of items) {
      const sessionInfo = item.session ?? {};
      const summary = item.message?.summary ?? {};
      const sessionId = readPrimitiveText(sessionInfo.sessionId);
      if (!sessionId || seenSessionIds.has(sessionId)) {
        continue;
      }

      seenSessionIds.add(sessionId);
      sessions.push({
        sessionId,
        sessionType: parseXianyuNumber(sessionInfo.sessionType),
        conversationCid: `${sessionId}@goofish`,
        sellerUserId:
          readPrimitiveText(sessionInfo.ownerInfo?.userId) ||
          readPrimitiveText(sessionInfo.itemInfo?.sellerInfo?.userId) ||
          null,
        sellerName:
          extractXianyuText(sessionInfo.ownerInfo?.fishNick) ||
          extractXianyuText(sessionInfo.ownerInfo?.nick) ||
          null,
        buyerUserId: readPrimitiveText(sessionInfo.userInfo?.userId) || null,
        buyerName:
          extractXianyuText(sessionInfo.userInfo?.fishNick) ||
          extractXianyuText(sessionInfo.userInfo?.nick) ||
          null,
        itemId: readPrimitiveText(sessionInfo.itemInfo?.itemId) || null,
        itemMainPic: extractXianyuText(sessionInfo.itemInfo?.mainPic) || null,
        summaryText: extractXianyuText(summary.summary),
        summaryVersion: parseXianyuNumber(summary.version),
        summaryTimestamp: normalizeXianyuDateTime(summary.ts) ?? formatDateTime(new Date()),
        unreadCount: parseXianyuNumber(summary.unread) ?? 0,
        sortIndex: parseXianyuNumber(summary.sortIndex),
      });
    }

    if (!responseData.hasMore || items.length === 0) {
      break;
    }

    const lastSession = sessions.at(-1);
    if (!lastSession) {
      break;
    }
    nextSortIndex = lastSession.sortIndex;
    nextSessionId = lastSession.sessionId;
  }

  return {
    sessions,
    totalCount,
    pageCount,
    rawRet: latestRet,
  };
}

interface XianyuWebSocketConversationRecord {
  cid: string;
  sessionId: string;
  sessionType: number | null;
  bizType: number | null;
  sellerUserId: string | null;
  buyerUserId: string | null;
  itemId: string | null;
  itemMainPic: string | null;
  summaryText: string;
  summaryTimestamp: string;
  unreadCount: number;
  sortIndex: number | null;
  lastMessageId: string | null;
  lastMessageSenderUserId: string | null;
  lastMessageText: string;
  lastMessageRawContentType: number | null;
  lastMessageTimestamp: string;
}

function extractXianyuSessionIdFromCid(cid: string | null) {
  const normalizedCid = cid?.trim() ?? '';
  if (!normalizedCid) {
    return '';
  }

  const [sessionId] = normalizedCid.split('@');
  return sessionId?.trim() ?? '';
}

function decodeXianyuBase64Json(value: unknown) {
  const normalized = extractXianyuText(value);
  if (!normalized) {
    return null;
  }

  try {
    const text = Buffer.from(normalized, 'base64').toString('utf8');
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function extractXianyuWebSocketMessageText(message: Record<string, unknown>) {
  const content = (message.content ?? {}) as Record<string, unknown>;
  const custom = (content.custom ?? {}) as Record<string, unknown>;
  const decoded = decodeXianyuBase64Json(custom.data);
  const decodedText = decoded
    ? extractXianyuText(decoded.text) ||
      extractXianyuText((decoded.text as { text?: unknown } | undefined)?.text) ||
      extractXianyuText(decoded.summary)
    : '';

  return (
    extractXianyuText(custom.summary) ||
    decodedText ||
    extractXianyuText((message.extension as Record<string, unknown> | undefined)?.detailNotice) ||
    extractXianyuText((message.extension as Record<string, unknown> | undefined)?.reminderNotice) ||
    ''
  );
}

function resolveXianyuConversationPeerUserId(
  conversation: Record<string, unknown>,
  sellerUserId: string | null,
  extUserId: string | null,
) {
  if (extUserId) {
    return extUserId;
  }

  const candidates = [
    extractXianyuText(conversation.pairFirst),
    extractXianyuText(conversation.pairSecond),
  ]
    .map((value) => value.split('@')[0]?.trim() ?? '')
    .filter(Boolean);

  for (const candidate of candidates) {
    if (candidate !== (sellerUserId ?? '') && candidate !== '0') {
      return candidate;
    }
  }

  return null;
}

export function parseXianyuWebSocketConversationListFrame(payload: string) {
  const normalizedPayload = payload.trim();
  if (!normalizedPayload.startsWith('{')) {
    return [] as XianyuWebSocketConversationRecord[];
  }

  let parsedPayload: {
    body?: {
      userConvs?: unknown[];
    };
  } | null = null;
  try {
    parsedPayload = JSON.parse(normalizedPayload) as {
      body?: {
        userConvs?: unknown[];
      };
    };
  } catch {
    return [];
  }

  const userConversations = Array.isArray(parsedPayload?.body?.userConvs)
    ? parsedPayload.body.userConvs
    : [];
  return userConversations
    .map((entry) => {
      if (!entry || typeof entry !== 'object') {
        return null;
      }

      const userConversation = (
        (entry as { singleChatUserConversation?: unknown }).singleChatUserConversation ?? {}
      ) as Record<string, unknown>;
      const singleConversation = (
        (userConversation.singleChatConversation ?? {}) as Record<string, unknown>
      );
      const extension = ((singleConversation.extension ?? {}) as Record<string, unknown>);
      const lastMessageEnvelope = ((userConversation.lastMessage ?? {}) as Record<string, unknown>);
      const lastMessage = ((lastMessageEnvelope.message ?? {}) as Record<string, unknown>);
      const cid = extractXianyuText(singleConversation.cid);
      const sessionId = extractXianyuSessionIdFromCid(cid);
      if (!sessionId) {
        return null;
      }

      const sellerUserId = extractXianyuText(extension.ownerUserId) || null;
      const extUserId = extractXianyuText(extension.extUserId) || null;
      const buyerUserId = resolveXianyuConversationPeerUserId(singleConversation, sellerUserId, extUserId);
      const summaryText = extractXianyuWebSocketMessageText(lastMessage);
      const summaryTimestamp =
        normalizeXianyuDateTime(lastMessage.createAt) ??
        normalizeXianyuDateTime(userConversation.modifyTime) ??
        normalizeXianyuDateTime(userConversation.joinTime) ??
        formatDateTime(new Date());
      const lastMessageTimestamp =
        normalizeXianyuDateTime(lastMessage.createAt) ??
        normalizeXianyuDateTime(userConversation.modifyTime) ??
        summaryTimestamp;
      const senderUid = extractXianyuText((lastMessage.sender as Record<string, unknown> | undefined)?.uid);

      return {
        cid,
        sessionId,
        sessionType:
          parseXianyuNumber((lastMessage.extension as Record<string, unknown> | undefined)?.sessionType) ??
          parseXianyuNumber(singleConversation.bizType),
        bizType: parseXianyuNumber(singleConversation.bizType),
        sellerUserId,
        buyerUserId,
        itemId: extractXianyuText(extension.itemId) || null,
        itemMainPic: extractXianyuText(extension.itemMainPic) || null,
        summaryText,
        summaryTimestamp,
        unreadCount:
          parseXianyuNumber(lastMessage.unreadCount) ??
          parseXianyuNumber(userConversation.redPoint) ??
          0,
        sortIndex:
          parseXianyuNumber(userConversation.modifyTime) ??
          parseXianyuNumber(lastMessage.createAt),
        lastMessageId: extractXianyuText(lastMessage.messageId) || null,
        lastMessageSenderUserId: senderUid ? senderUid.split('@')[0]?.trim() ?? null : null,
        lastMessageText: summaryText,
        lastMessageRawContentType:
          parseXianyuNumber((lastMessage.content as Record<string, unknown> | undefined)?.contentType) ??
          parseXianyuNumber(
            ((lastMessage.content as Record<string, unknown> | undefined)?.custom as Record<
              string,
              unknown
            > | undefined)?.type,
          ),
        lastMessageTimestamp,
      } satisfies XianyuWebSocketConversationRecord;
    })
    .filter((record): record is XianyuWebSocketConversationRecord => Boolean(record));
}

export function shouldUseXianyuImBrowserConversationFallback(sessions: XianyuWebImSession[]) {
  if (sessions.length === 0) {
    return true;
  }

  return !sessions.some(
    (session) =>
      (session.sessionType ?? 0) === 1 &&
      Boolean(session.sessionId.trim()) &&
      Boolean(session.itemId?.trim()) &&
      (Boolean(session.buyerUserId?.trim()) || Boolean(session.summaryText.trim())),
  );
}

async function fetchXianyuWebSessionImMessages(input: {
  cookieText: string;
  session: XianyuWebImSession;
  fetchCount?: number;
}): Promise<{
  messages: XianyuWebImMessage[];
  hasMore: boolean;
  rawRet: string[];
}> {
  const cookieJar = parseCookieText(input.cookieText);
  if (cookieJar.size === 0) {
    throw new Error('当前没有可用的网页登录态，无法拉取闲鱼会话消息。');
  }

  const fetchCount = Math.max(1, Math.min(50, Math.trunc(input.fetchCount ?? 20)));
  const payload = await postXianyuMtopWithCookieJar<{
    fetchs?: string | number | null;
    hasMore?: boolean | null;
    messages?: Array<{
      messageUuid?: string | null;
      version?: string | number | null;
      timeStamp?: string | number | null;
      content?: {
        contentType?: string | number | null;
        text?: {
          text?: string | null;
          content?: string | null;
        } | null;
      };
      senderInfo?: {
        userId?: string | null;
        nick?: string | null;
        fishNick?: string | null;
      };
      sessionInfo?: {
        sessionId?: string | number | null;
        sessionType?: string | number | null;
        ownerInfo?: {
          userId?: string | null;
          nick?: string | null;
          fishNick?: string | null;
        };
        userInfo?: {
          userId?: string | null;
          nick?: string | null;
          fishNick?: string | null;
        };
      };
    }>;
    result?: {
      success?: boolean;
    };
  }>({
    cookieJar,
    api: 'mtop.taobao.idlemessage.pc.message.sync',
    data: {
      req: JSON.stringify({
        type: 1,
        fetchs: fetchCount,
        sessionId: input.session.sessionId,
        version: input.session.summaryVersion ?? 0,
        start: 0,
        includeRequestMsg: true,
      }),
    },
    referer: 'https://www.goofish.com/im',
    origin: 'https://www.goofish.com',
    spmCnt: 'a21ybx.im.0.0',
  });

  const rawRet = Array.isArray(payload.ret) ? payload.ret : [];
  if (!isXianyuMtopSuccess(payload) && !payload.data?.result?.success) {
    throw new Error(
      rawRet.length > 0
        ? `拉取闲鱼会话消息失败：${rawRet.join(' | ')}`
        : '拉取闲鱼会话消息失败，平台未返回成功结果。',
    );
  }

  const messages = (payload.data?.messages ?? [])
    .map((message) => {
      const sessionInfo = message.sessionInfo ?? {};
      const senderInfo = {
        userId: extractXianyuText(message.senderInfo?.userId) || null,
        nick: extractXianyuText(message.senderInfo?.nick) || null,
        fishNick: extractXianyuText(message.senderInfo?.fishNick) || null,
      };
      const sellerInfo = {
        userId: extractXianyuText(sessionInfo.ownerInfo?.userId) || input.session.sellerUserId,
        nick: extractXianyuText(sessionInfo.ownerInfo?.nick) || null,
        fishNick: extractXianyuText(sessionInfo.ownerInfo?.fishNick) || input.session.sellerName,
      };
      const buyerInfo = {
        userId: extractXianyuText(sessionInfo.userInfo?.userId) || input.session.buyerUserId,
        nick: extractXianyuText(sessionInfo.userInfo?.nick) || null,
        fishNick: extractXianyuText(sessionInfo.userInfo?.fishNick) || input.session.buyerName,
      };
      const text = extractXianyuImMessageText(message.content);
      if (!text) {
        return null;
      }

      return {
        messageId:
          extractXianyuText(message.messageUuid) ||
          `${input.session.sessionId}:${extractXianyuText(message.version) || Date.now()}`,
        sessionId: readPrimitiveText(sessionInfo.sessionId) || input.session.sessionId,
        sessionType: parseXianyuNumber(sessionInfo.sessionType) ?? input.session.sessionType,
        senderRole: resolveXianyuImSenderRole({
          senderInfo,
          sellerInfo,
          buyerInfo,
        }),
        senderUserId: senderInfo.userId,
        senderName: senderInfo.fishNick || senderInfo.nick || '未知发送方',
        text,
        sentAt:
          normalizeXianyuDateTime(message.timeStamp) ??
          input.session.summaryTimestamp ??
          formatDateTime(new Date()),
        version: parseXianyuNumber(message.version),
        rawContentType: parseXianyuNumber(message.content?.contentType),
      } satisfies XianyuWebImMessage;
    })
    .filter((message): message is XianyuWebImMessage => Boolean(message));

  return {
    messages,
    hasMore: Boolean(payload.data?.hasMore),
    rawRet,
  };
}

async function fetchXianyuWebSessionImUserProfile(input: {
  cookieJar: Map<string, string>;
  sessionId: string;
  sessionType: number | null;
  isOwner: boolean;
}) {
  const payload = await postXianyuMtopWithCookieJar<{
    userInfo?: {
      nick?: string | null;
      fishNick?: string | null;
    };
  }>({
    cookieJar: input.cookieJar,
    api: 'mtop.taobao.idlemessage.pc.user.query',
    apiVersion: '4.0',
    data: {
      type: 0,
      sessionType: input.sessionType ?? 1,
      sessionId: input.sessionId,
      isOwner: input.isOwner,
    },
    referer: 'https://www.goofish.com/im',
    origin: 'https://www.goofish.com',
    spmCnt: 'a21ybx.im.0.0',
  });

  if (!isXianyuMtopSuccess(payload)) {
    return null;
  }

  return {
    nick: extractXianyuText(payload.data?.userInfo?.nick) || null,
    fishNick: extractXianyuText(payload.data?.userInfo?.fishNick) || null,
  };
}

function buildXianyuWebSocketFallbackMessage(
  record: XianyuWebSocketConversationRecord,
  session: XianyuWebImSession,
) {
  const text = record.lastMessageText.trim() || session.summaryText.trim();
  if (!text) {
    return null;
  }

  const senderInfo = {
    userId: record.lastMessageSenderUserId,
    nick: null,
    fishNick: null,
  };
  const sellerInfo = {
    userId: session.sellerUserId,
    nick: null,
    fishNick: session.sellerName,
  };
  const buyerInfo = {
    userId: session.buyerUserId,
    nick: null,
    fishNick: session.buyerName,
  };
  const senderRole = resolveXianyuImSenderRole({
    senderInfo,
    sellerInfo,
    buyerInfo,
  });

  return {
    messageId: record.lastMessageId || `${session.sessionId}:${session.sortIndex ?? Date.now()}`,
    sessionId: session.sessionId,
    sessionType: session.sessionType,
    senderRole,
    senderUserId: record.lastMessageSenderUserId,
    senderName:
      (senderRole === 'seller' ? session.sellerName : senderRole === 'buyer' ? session.buyerName : null) ||
      record.lastMessageSenderUserId ||
      '未知发送方',
    text,
    sentAt: record.lastMessageTimestamp || session.summaryTimestamp,
    version: session.sortIndex,
    rawContentType: record.lastMessageRawContentType,
  } satisfies XianyuWebImMessage;
}

interface XianyuWebSocketAuthSnapshot {
  appKey: string;
  cacheHeader: string;
  token: string;
  ua: string;
  dt: string;
  wv: string;
  sync: string;
  did: string;
}

interface XianyuWebSocketResponseEnvelope {
  headers?: Record<string, unknown>;
  code?: number;
  body?: Record<string, unknown>;
  lwp?: string;
}

function createXianyuWebSocketMid() {
  return `${Date.now()}${Math.trunc(Math.random() * 1000)} 0`;
}

async function captureXianyuWebSessionSocketAuthViaBrowser(input: {
  cookieText: string;
  headless: boolean;
  executablePath: string;
}) {
  const browser = await chromium.launch({
    executablePath: input.executablePath,
    headless: input.headless,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
      '--disable-features=TranslateUI',
      '--lang=zh-CN',
    ],
  });

  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
      locale: 'zh-CN',
    });

    const cookieJar = parseCookieText(input.cookieText);
    if (cookieJar.size === 0) {
      throw new Error('当前没有可用于抓取闲鱼 IM 会话的 Cookie。');
    }

    await context.addCookies(buildPlaywrightCookies(cookieJar));
    const page = await context.newPage();
    let authSnapshot: XianyuWebSocketAuthSnapshot | null = null;
    let reloadTriggered = false;

    page.on('websocket', (webSocket) => {
      webSocket.on('framesent', (event) => {
        if (authSnapshot) {
          return;
        }

        const payload = String(event.payload ?? '').trim();
        if (!payload.startsWith('{')) {
          return;
        }

        let parsedPayload: {
          lwp?: string;
          headers?: Record<string, unknown>;
        } | null = null;
        try {
          parsedPayload = JSON.parse(payload) as {
            lwp?: string;
            headers?: Record<string, unknown>;
          };
        } catch {
          return;
        }

        if (parsedPayload?.lwp !== '/reg') {
          return;
        }

        const headers = parsedPayload.headers ?? {};
        const token = extractXianyuText(headers.token);
        const did = extractXianyuText(headers.did);
        if (!token || !did) {
          return;
        }

        authSnapshot = {
          appKey: extractXianyuText(headers['app-key']) || LOGIN_APP_KEY,
          cacheHeader: extractXianyuText(headers['cache-header']) || 'app-key token ua wv',
          token,
          ua:
            extractXianyuText(headers.ua) ||
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36 DingTalk(2.2.0) OS(Windows/10) Browser(Chrome/138.0.0.0) DingWeb/2.2.0 IMPaaS DingWeb/2.2.0',
          dt: extractXianyuText(headers.dt) || 'j',
          wv: extractXianyuText(headers.wv) || 'im:3,au:3,sy:6',
          sync: extractXianyuText(headers.sync) || '0,0;0;0;',
          did,
        };
      });
    });

    await safeGoto(page, DEFAULT_RENEW_URL);
    const startedAt = Date.now();
    while (Date.now() - startedAt < 20000) {
      await page.waitForTimeout(1000);
      if (authSnapshot) {
        break;
      }
      if (!reloadTriggered && Date.now() - startedAt >= 8000) {
        reloadTriggered = true;
        try {
          await page.reload({
            waitUntil: 'domcontentloaded',
            timeout: 15000,
          });
        } catch {
          await page.waitForTimeout(1200);
        }
      }
    }

    const updatedCookies = await context.cookies();
    const nextCookieJar = new Map(cookieJar);
    for (const item of updatedCookies) {
      if (!item?.name?.trim()) {
        continue;
      }
      nextCookieJar.set(item.name, item.value);
    }

    const renewedCookieText = stringifyCookieJar(nextCookieJar);

    return {
      authSnapshot,
      refreshedCookieText:
        renewedCookieText && renewedCookieText !== input.cookieText ? renewedCookieText : null,
    };
  } finally {
    await browser.close();
  }
}

async function openXianyuWebSocketClient(authSnapshot: XianyuWebSocketAuthSnapshot) {
  const socket = new WebSocket('wss://wss-goofish.dingtalk.com/');
  const pending = new Map<
    string,
    {
      resolve: (value: XianyuWebSocketResponseEnvelope) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  const failPending = (error: Error) => {
    for (const [mid, pendingRequest] of pending.entries()) {
      clearTimeout(pendingRequest.timer);
      pendingRequest.reject(error);
      pending.delete(mid);
    }
  };

  await new Promise<void>((resolve, reject) => {
    const onOpen = () => {
      socket.removeEventListener('open', onOpen);
      socket.removeEventListener('error', onError);
      resolve();
    };
    const onError = () => {
      socket.removeEventListener('open', onOpen);
      socket.removeEventListener('error', onError);
      reject(new Error('连接闲鱼 IM WebSocket 失败。'));
    };
    socket.addEventListener('open', onOpen);
    socket.addEventListener('error', onError);
  });

  socket.addEventListener('message', (event) => {
    const payload = String(event.data ?? '').trim();
    if (!payload.startsWith('{')) {
      return;
    }

    let parsedPayload: XianyuWebSocketResponseEnvelope | null = null;
    try {
      parsedPayload = JSON.parse(payload) as XianyuWebSocketResponseEnvelope;
    } catch {
      return;
    }

    const mid = extractXianyuText(parsedPayload.headers?.mid);
    if (!mid || !pending.has(mid)) {
      return;
    }

    const pendingRequest = pending.get(mid);
    if (!pendingRequest) {
      return;
    }

    clearTimeout(pendingRequest.timer);
    pending.delete(mid);
    pendingRequest.resolve(parsedPayload);
  });
  socket.addEventListener('close', () => {
    failPending(new Error('闲鱼 IM WebSocket 已关闭。'));
  });
  socket.addEventListener('error', () => {
    failPending(new Error('闲鱼 IM WebSocket 通信失败。'));
  });

  const request = async (input: {
    lwp: string;
    body?: unknown;
    extraHeaders?: Record<string, string>;
    timeoutMs?: number;
  }) =>
    await new Promise<XianyuWebSocketResponseEnvelope>((resolve, reject) => {
      const mid = createXianyuWebSocketMid();
      const timer = setTimeout(() => {
        pending.delete(mid);
        reject(new Error(`${input.lwp} 请求超时。`));
      }, input.timeoutMs ?? 15000);
      pending.set(mid, { resolve, reject, timer });
      socket.send(
        JSON.stringify({
          lwp: input.lwp,
          headers: {
            mid,
            ...(input.extraHeaders ?? {}),
          },
          ...(input.body === undefined ? {} : { body: input.body }),
        }),
      );
    });

  const registerResponse = await request({
    lwp: '/reg',
    extraHeaders: {
      'cache-header': authSnapshot.cacheHeader,
      'app-key': authSnapshot.appKey,
      token: authSnapshot.token,
      ua: authSnapshot.ua,
      dt: authSnapshot.dt,
      wv: authSnapshot.wv,
      sync: authSnapshot.sync,
      did: authSnapshot.did,
    },
    timeoutMs: 15000,
  });

  if (Number(registerResponse.code ?? 0) !== 200) {
    failPending(new Error('闲鱼 IM WebSocket 注册失败。'));
    socket.close();
    throw new Error('闲鱼 IM WebSocket 注册失败。');
  }

  return {
    request,
    async close() {
      failPending(new Error('闲鱼 IM WebSocket 已主动关闭。'));
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close();
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    },
  };
}

function parseXianyuWebSocketUserMessages(
  response: XianyuWebSocketResponseEnvelope,
  session: XianyuWebImSession,
) {
  const messageModels = Array.isArray(response.body?.userMessageModels)
    ? response.body.userMessageModels
    : [];
  const messages = messageModels
    .map((entry) => {
      if (!entry || typeof entry !== 'object') {
        return null;
      }

      const userMessage = entry as Record<string, unknown>;
      const message = ((userMessage.message ?? {}) as Record<string, unknown>);
      const senderUserId =
        extractXianyuText((message.extension as Record<string, unknown> | undefined)?.senderUserId) ||
        extractXianyuText((message.sender as Record<string, unknown> | undefined)?.uid).split('@')[0]?.trim() ||
        null;
      const text = extractXianyuWebSocketMessageText(message);
      if (!text) {
        return null;
      }

      const senderRole = resolveXianyuImSenderRole({
        senderInfo: {
          userId: senderUserId,
          nick: null,
          fishNick: null,
        },
        sellerInfo: {
          userId: session.sellerUserId,
          nick: null,
          fishNick: session.sellerName,
        },
        buyerInfo: {
          userId: session.buyerUserId,
          nick: null,
          fishNick: session.buyerName,
        },
      });

      return {
        messageId: extractXianyuText(message.messageId) || `${session.sessionId}:${Date.now()}`,
        sessionId: session.sessionId,
        sessionType: session.sessionType,
        senderRole,
        senderUserId,
        senderName:
          (senderRole === 'seller' ? session.sellerName : senderRole === 'buyer' ? session.buyerName : null) ||
          senderUserId ||
          '未知发送方',
        text,
        sentAt: normalizeXianyuDateTime(message.createAt) ?? session.summaryTimestamp,
        version: parseXianyuNumber(message.createAt),
        rawContentType:
          parseXianyuNumber((message.content as Record<string, unknown> | undefined)?.contentType) ??
          parseXianyuNumber(
            ((message.content as Record<string, unknown> | undefined)?.custom as Record<string, unknown> | undefined)
              ?.type,
          ),
      } satisfies XianyuWebImMessage;
    })
    .filter((message): message is XianyuWebImMessage => Boolean(message))
    .sort(
      (left, right) =>
        left.sentAt.localeCompare(right.sentAt) || left.messageId.localeCompare(right.messageId),
    );

  return {
    messages,
    hasMore: Boolean(parseXianyuNumber(response.body?.nextCursor)),
  };
}

async function fetchXianyuWebSessionBargainSessionsViaSocketAuth(input: {
  cookieText: string;
  authSnapshot: XianyuWebSocketAuthSnapshot;
  maxSessions?: number;
  maxMessagesPerSession?: number;
  rawRetPrefix?: string[];
}) {
  const maxSessions = Math.max(1, Math.min(50, Math.trunc(input.maxSessions ?? 20)));
  const cookieJar = parseCookieText(input.cookieText);
  const client = await openXianyuWebSocketClient(input.authSnapshot);
  const sellerNameCache = new Map<string, string | null>();
  const sessions: XianyuWebBargainSession[] = [];
  try {
    const conversationMap = new Map<string, XianyuWebSocketConversationRecord>();
    const newestResponse = await client.request({
      lwp: '/r/Conversation/listNewestPagination',
      body: [Number.MAX_SAFE_INTEGER, maxSessions],
      timeoutMs: 15000,
    });
    for (const record of parseXianyuWebSocketConversationListFrame(JSON.stringify(newestResponse))) {
      if (record.bizType === 1 && record.itemId && record.buyerUserId) {
        conversationMap.set(record.cid, record);
      }
    }

    try {
      const topResponse = await client.request({
        lwp: '/r/Conversation/listTop',
        body: [{ topRank: Number.MAX_SAFE_INTEGER, maxCount: 2000 }],
        timeoutMs: 15000,
      });
      for (const record of parseXianyuWebSocketConversationListFrame(JSON.stringify(topResponse))) {
        if (record.bizType === 1 && record.itemId && record.buyerUserId) {
          const existing = conversationMap.get(record.cid);
          if (!existing || (record.sortIndex ?? 0) >= (existing.sortIndex ?? 0)) {
            conversationMap.set(record.cid, record);
          }
        }
      }
    } catch {
      // Ignore missing pinned conversations and continue with the newest list.
    }

    const records = Array.from(conversationMap.values())
      .sort(
        (left, right) =>
          (right.sortIndex ?? 0) - (left.sortIndex ?? 0) || right.sessionId.localeCompare(left.sessionId),
      )
      .slice(0, maxSessions);

    for (const record of records) {
      let sellerName = record.sellerUserId ? (sellerNameCache.get(record.sellerUserId) ?? null) : null;
      if (record.sellerUserId && !sellerNameCache.has(record.sellerUserId)) {
        try {
          const sellerProfile = await fetchXianyuWebSessionImUserProfile({
            cookieJar,
            sessionId: record.sessionId,
            sessionType: record.sessionType,
            isOwner: true,
          });
          sellerName = sellerProfile?.fishNick || sellerProfile?.nick || null;
        } catch {
          sellerName = null;
        }
        sellerNameCache.set(record.sellerUserId, sellerName);
      }

      let buyerName: string | null = null;
      try {
        const buyerProfile = await fetchXianyuWebSessionImUserProfile({
          cookieJar,
          sessionId: record.sessionId,
          sessionType: record.sessionType,
          isOwner: false,
        });
        buyerName = buyerProfile?.fishNick || buyerProfile?.nick || null;
      } catch {
        buyerName = null;
      }

      const session: XianyuWebImSession = {
        sessionId: record.sessionId,
        sessionType: record.sessionType,
        conversationCid: record.cid,
        sellerUserId: record.sellerUserId,
        sellerName,
        buyerUserId: record.buyerUserId,
        buyerName,
        itemId: record.itemId,
        itemMainPic: record.itemMainPic,
        summaryText: record.summaryText,
        summaryVersion: null,
        summaryTimestamp: record.summaryTimestamp,
        unreadCount: record.unreadCount,
        sortIndex: record.sortIndex,
      };

      let messages: XianyuWebImMessage[] = [];
      let hasMoreMessages = false;
      try {
        const messageResponse = await client.request({
          lwp: '/r/MessageManager/listUserMessages',
          body: [record.cid, false, Number.MAX_SAFE_INTEGER, input.maxMessagesPerSession ?? 20, false],
          timeoutMs: 15000,
        });
        const parsedMessages = parseXianyuWebSocketUserMessages(messageResponse, session);
        messages = parsedMessages.messages;
        hasMoreMessages = parsedMessages.hasMore;
      } catch {
        try {
          const messageResult = await fetchXianyuWebSessionImMessages({
            cookieText: input.cookieText,
            session,
            fetchCount: input.maxMessagesPerSession,
          });
          messages = messageResult.messages;
          hasMoreMessages = messageResult.hasMore;
        } catch {
          messages = [];
        }
      }

      if (messages.length === 0) {
        const fallbackMessage = buildXianyuWebSocketFallbackMessage(record, session);
        if (fallbackMessage) {
          messages = [fallbackMessage];
        }
      }

      sessions.push({
        ...session,
        messages,
        hasMoreMessages,
      });
    }

    return {
      sessions,
      totalCount: sessions.length,
      pageCount: records.length > 0 ? 1 : 0,
      rawRet: [
        ...(input.rawRetPrefix ?? []),
        sessions.length > 0 ? 'BROWSER_FALLBACK::CONVERSATION_WS' : 'BROWSER_FALLBACK::NO_CONVERSATIONS',
      ],
    } satisfies XianyuWebBargainSessionResult;
  } finally {
    await client.close();
  }
}

async function fetchXianyuWebSessionBargainSessionsViaBrowser(input: {
  cookieText: string;
  maxSessions?: number;
  maxMessagesPerSession?: number;
}) {
  const executablePath = resolveBrowserExecutablePath();
  if (!executablePath) {
    throw new Error('未找到可用的 Edge/Chrome 浏览器，无法抓取真实闲鱼 IM 会话。');
  }

  const maxSessions = Math.max(1, Math.min(50, Math.trunc(input.maxSessions ?? 20)));
  const headlessModes = [true, false];
  let authSnapshot: XianyuWebSocketAuthSnapshot | null = null;
  let refreshedCookieText: string | null = null;

  for (const headless of headlessModes) {
    const captureResult = await captureXianyuWebSessionSocketAuthViaBrowser({
      cookieText: input.cookieText,
      headless,
      executablePath,
    });
    authSnapshot = captureResult.authSnapshot;
    refreshedCookieText = captureResult.refreshedCookieText ?? refreshedCookieText;
    if (authSnapshot) {
      break;
    }
  }

  if (!authSnapshot) {
    throw new Error('浏览器已打开闲鱼消息页，但未捕获到 IM 鉴权帧。');
  }

  const socketResult = await fetchXianyuWebSessionBargainSessionsViaSocketAuth({
    cookieText: refreshedCookieText ?? input.cookieText,
    authSnapshot,
    maxSessions,
    maxMessagesPerSession: input.maxMessagesPerSession,
  });

  return {
    ...socketResult,
    refreshedCookieText,
    socketAuthCache: buildXianyuWebSocketAuthCache(authSnapshot),
  };
}

async function fetchXianyuWebSocketAuthViaLoginToken(input: { cookieText: string }) {
  const cookieJar = parseCookieText(input.cookieText);
  if (cookieJar.size === 0) {
    throw new Error('当前没有可用的闲鱼网页登录态，无法获取 IM 长连鉴权。');
  }

  await requestWithCookieJar({
    url: HAS_LOGIN_URL,
    method: 'POST',
    cookieJar,
    headers: buildBaseHeaders({
      referer: 'https://www.goofish.com/',
      origin: PASSPORT_HOST,
    }),
    searchParams: {
      appName: 'xianyu',
      fromSite: '77',
    },
    body: new URLSearchParams({
      hid: cookieJar.get('unb')?.trim() || '',
      ltl: 'true',
      appName: 'xianyu',
      appEntrance: 'web',
      _csrf_token: cookieJar.get('XSRF-TOKEN')?.trim() || '',
      umidToken: '',
      hsiz: cookieJar.get('cookie2')?.trim() || '',
      bizParams: 'taobaoBizLoginFrom=web',
      mainPage: 'false',
      isMobile: 'false',
      lang: 'zh_CN',
      returnUrl: '',
      fromSite: '77',
      isIframe: 'true',
      documentReferer: 'https://www.goofish.com/',
      defaultView: 'hasLogin',
      umidTag: 'SERVER',
      deviceId: cookieJar.get('cna')?.trim() || '',
    }),
  }).catch(() => null);

  const token = getMtopToken(cookieJar);
  if (!token) {
    throw new Error('当前 Cookie 缺少 _m_h5_tk，无法获取闲鱼 IM 长连鉴权。');
  }

  const timestamp = String(Date.now());
  const deviceId = createXianyuWebSocketDeviceId(cookieJar);
  const data = JSON.stringify({
    appKey: LOGIN_APP_KEY,
    deviceId,
  });

  const response = await requestWithCookieJar({
    url: LOGIN_TOKEN_URL,
    method: 'POST',
    cookieJar,
    headers: buildBaseHeaders({
      referer: `${PASSPORT_HOST}/`,
      origin: PASSPORT_HOST,
    }),
    searchParams: {
      jsv: '2.7.2',
      appKey: MTOP_APP_KEY,
      t: timestamp,
      sign: createMtopSign(token, timestamp, MTOP_APP_KEY, data),
      v: '1.0',
      type: 'originaljson',
      accountSite: 'xianyu',
      dataType: 'json',
      timeout: '20000',
      api: 'mtop.taobao.idlemessage.pc.login.token',
      sessionOption: 'AutoLoginOnly',
      spm_cnt: 'a21ybx.im.0.0',
    },
    body: new URLSearchParams({
      data,
    }),
  });

  const payload = (await response.json()) as {
    ret?: string[];
    data?: {
      accessToken?: string | null;
      url?: string | null;
    };
  };
  const rawRet = (payload.ret ?? []).filter((item): item is string => typeof item === 'string');
  const refreshedCookieText = stringifyCookieJar(cookieJar);

  if (rawRet.some((item) => item.includes('SUCCESS'))) {
    const accessToken = extractXianyuText(payload.data?.accessToken);
    if (!accessToken) {
      throw new Error('闲鱼登录态校验成功，但未返回可用的 IM accessToken。');
    }

    return {
      authSnapshot: {
        appKey: LOGIN_APP_KEY,
        cacheHeader: XIANYU_WEB_SOCKET_DEFAULT_CACHE_HEADER,
        token: accessToken,
        ua: XIANYU_WEB_SOCKET_DEFAULT_UA,
        dt: XIANYU_WEB_SOCKET_DEFAULT_DT,
        wv: XIANYU_WEB_SOCKET_DEFAULT_WV,
        sync: XIANYU_WEB_SOCKET_DEFAULT_SYNC,
        did: deviceId,
      } satisfies XianyuWebSocketAuthSnapshot,
      refreshedCookieText: refreshedCookieText !== input.cookieText ? refreshedCookieText : null,
    };
  }

  if (rawRet.some((item) => item.includes('FAIL_SYS_USER_VALIDATE'))) {
    const verificationUrl = getVerificationUrlFromPayload(payload);
    throw new Error(
      verificationUrl
        ? `闲鱼 IM 鉴权命中风控，请先完成验证后重试：${verificationUrl}`
        : '闲鱼 IM 鉴权命中风控，请先在闲鱼网页端完成验证后重试。',
    );
  }

  if (
    rawRet.some(
      (item) =>
        item.includes('FAIL_SYS_SESSION_EXPIRED') ||
        item.includes('FAIL_SYS_TOKEN_EXOIRED') ||
        item.includes('FAIL_SYS_TOKEN_EMPTY') ||
        item.includes('FAIL_SYS_ILLEGAL_ACCESS'),
    )
  ) {
    throw new Error('闲鱼网页登录态已过期或关键令牌失效，无法建立 IM 长连。');
  }

  throw new Error(
    rawRet.length > 0 ? `闲鱼 IM 鉴权失败：${rawRet.join(' | ')}` : '闲鱼 IM 鉴权失败，平台未返回明确结果。',
  );
}

export async function fetchXianyuWebSessionBargainSessions(input: {
  cookieText: string;
  maxSessions?: number;
  maxMessagesPerSession?: number;
  maxPages?: number;
  cachedSocketAuth?: XianyuWebSocketAuthCache | null;
}): Promise<XianyuWebBargainSessionResult> {
  let sessionResult: Awaited<ReturnType<typeof fetchXianyuWebSessionImSessions>> | null = null;
  try {
    sessionResult = await fetchXianyuWebSessionImSessions({
      cookieText: input.cookieText,
      maxSessions: input.maxSessions,
      maxPages: input.maxPages,
    });
  } catch {
    sessionResult = null;
  }

  const shouldUseBrowserFallback =
    !sessionResult || shouldUseXianyuImBrowserConversationFallback(sessionResult.sessions);
  let socketAuthCacheRejected = false;
  const cachedSocketAuth = input.cachedSocketAuth;

  if (shouldUseBrowserFallback && cachedSocketAuth && isXianyuWebSocketAuthCacheUsable(cachedSocketAuth)) {
    try {
      const cachedSocketResult = await fetchXianyuWebSessionBargainSessionsViaSocketAuth({
        cookieText: input.cookieText,
        authSnapshot: inflateXianyuWebSocketAuthSnapshot(cachedSocketAuth),
        maxSessions: input.maxSessions,
        maxMessagesPerSession: input.maxMessagesPerSession,
        rawRetPrefix: ['SOCKET_AUTH_CACHE::HIT'],
      });
      return {
        ...cachedSocketResult,
        socketAuthCache: cachedSocketAuth,
      };
    } catch {
      socketAuthCacheRejected = true;
    }
  }

  if (shouldUseBrowserFallback) {
    try {
      const tokenAuthResult = await fetchXianyuWebSocketAuthViaLoginToken({
        cookieText: input.cookieText,
      });
      const tokenSocketResult = await fetchXianyuWebSessionBargainSessionsViaSocketAuth({
        cookieText: tokenAuthResult.refreshedCookieText ?? input.cookieText,
        authSnapshot: tokenAuthResult.authSnapshot,
        maxSessions: input.maxSessions,
        maxMessagesPerSession: input.maxMessagesPerSession,
        rawRetPrefix: ['LOGIN_TOKEN::OK'],
      });
      if (tokenSocketResult.sessions.length > 0 || !sessionResult) {
        return {
          ...tokenSocketResult,
          refreshedCookieText: tokenAuthResult.refreshedCookieText,
          socketAuthCache: buildXianyuWebSocketAuthCache(tokenAuthResult.authSnapshot),
          socketAuthCacheRejected,
        };
      }
    } catch (error) {
      if (!sessionResult) {
        if (socketAuthCacheRejected && error instanceof Error) {
          (error as Error & { socketAuthCacheRejected?: boolean }).socketAuthCacheRejected = true;
        }
        throw error;
      }
    }

    try {
      const browserResult = await fetchXianyuWebSessionBargainSessionsViaBrowser({
        cookieText: input.cookieText,
        maxSessions: input.maxSessions,
        maxMessagesPerSession: input.maxMessagesPerSession,
      });
      if (browserResult.sessions.length > 0 || !sessionResult) {
        return {
          ...browserResult,
          socketAuthCacheRejected,
        };
      }
    } catch (error) {
      if (socketAuthCacheRejected && error instanceof Error) {
        (error as Error & { socketAuthCacheRejected?: boolean }).socketAuthCacheRejected = true;
      }
      throw error;
    }
  }

  if (!sessionResult) {
    const error = new Error('抓取闲鱼真实议价会话失败，既未拿到网页会话列表，也未拿到浏览器兜底结果。');
    if (socketAuthCacheRejected) {
      (error as Error & { socketAuthCacheRejected?: boolean }).socketAuthCacheRejected = true;
    }
    throw error;
  }

  const sessions: XianyuWebBargainSession[] = [];

  for (const session of sessionResult.sessions) {
    const messageResult = await fetchXianyuWebSessionImMessages({
      cookieText: input.cookieText,
      session,
      fetchCount: input.maxMessagesPerSession,
    });
    sessions.push({
      ...session,
      messages: messageResult.messages,
      hasMoreMessages: messageResult.hasMore,
    });
  }

  return {
    sessions,
    totalCount: sessionResult.totalCount,
    pageCount: sessionResult.pageCount,
    rawRet: sessionResult.rawRet,
    socketAuthCacheRejected,
  };
}

async function sendXianyuWebSessionTextMessageViaSocketAuth(input: {
  cookieText: string;
  authSnapshot: XianyuWebSocketAuthSnapshot;
  sessionId: string;
  conversationCid?: string | null;
  content: string;
  rawRetPrefix?: string[];
}) {
  const sessionId = input.sessionId.trim();
  if (!sessionId) {
    throw new Error('缺少可用于发送消息的闲鱼会话标识。');
  }

  const messageContent = input.content.trim();
  if (!messageContent) {
    throw new Error('消息内容不能为空。');
  }

  const conversationCid = input.conversationCid?.trim() || `${sessionId}@goofish`;
  const client = await openXianyuWebSocketClient(input.authSnapshot);
  try {
    const response = await client.request({
      lwp: '/r/MessageSend/sendByReceiverScope',
      body: [
        {
          uuid: createXianyuImMessageUuid(),
          cid: conversationCid,
          conversationType: 1,
          content: {
            contentType: 1,
            text: {
              content: messageContent,
              extension: {},
            },
          },
          redPointPolicy: 1,
          extension: {},
          ctx: {},
          mtags: {},
          msgReadStatusSetting: 1,
        },
        {
          actualReceivers: [],
        },
      ],
      timeoutMs: 15000,
    });

    if (Number(response.code ?? 0) !== 200 || !extractXianyuText(response.body?.messageId)) {
      throw new Error('闲鱼 IM 发信失败，WebSocket 未返回成功结果。');
    }

    return {
      messageId: extractXianyuText(response.body?.messageId),
      sentAt:
        normalizeXianyuDateTime(response.body?.createAt) ??
        normalizeXianyuDateTime(response.body?.gmtCreate) ??
        formatDateTime(new Date()),
      rawRet: [...(input.rawRetPrefix ?? []), 'SOCKET_AUTH::SEND_OK'],
    } satisfies XianyuWebSendMessageResult;
  } finally {
    await client.close();
  }
}

async function sendXianyuWebSessionTextMessageViaBrowser(input: {
  cookieText: string;
  sessionId: string;
  conversationCid?: string | null;
  content: string;
}) {
  const executablePath = resolveBrowserExecutablePath();
  if (!executablePath) {
    throw new Error('未找到可用的 Edge/Chrome 浏览器，无法发送闲鱼 IM 消息。');
  }

  const headlessModes = [true, false];
  let authSnapshot: XianyuWebSocketAuthSnapshot | null = null;
  let refreshedCookieText: string | null = null;

  for (const headless of headlessModes) {
    const captureResult = await captureXianyuWebSessionSocketAuthViaBrowser({
      cookieText: input.cookieText,
      headless,
      executablePath,
    });
    authSnapshot = captureResult.authSnapshot;
    refreshedCookieText = captureResult.refreshedCookieText ?? refreshedCookieText;
    if (authSnapshot) {
      break;
    }
  }

  if (!authSnapshot) {
    throw new Error('浏览器已打开闲鱼消息页，但未捕获到 IM 鉴权。');
  }

  const sendResult = await sendXianyuWebSessionTextMessageViaSocketAuth({
    cookieText: refreshedCookieText ?? input.cookieText,
    authSnapshot,
    sessionId: input.sessionId,
    conversationCid: input.conversationCid,
    content: input.content,
  });

  return {
    ...sendResult,
    refreshedCookieText,
    socketAuthCache: buildXianyuWebSocketAuthCache(authSnapshot),
  } satisfies XianyuWebSendMessageResult;
}

export async function sendXianyuWebSessionTextMessage(input: {
  cookieText: string;
  sessionId: string;
  conversationCid?: string | null;
  content: string;
  cachedSocketAuth?: XianyuWebSocketAuthCache | null;
}): Promise<XianyuWebSendMessageResult> {
  let socketAuthCacheRejected = false;
  const cachedSocketAuth = input.cachedSocketAuth;

  if (cachedSocketAuth && isXianyuWebSocketAuthCacheUsable(cachedSocketAuth)) {
    try {
      const cachedResult = await sendXianyuWebSessionTextMessageViaSocketAuth({
        cookieText: input.cookieText,
        authSnapshot: inflateXianyuWebSocketAuthSnapshot(cachedSocketAuth),
        sessionId: input.sessionId,
        conversationCid: input.conversationCid,
        content: input.content,
        rawRetPrefix: ['SOCKET_AUTH_CACHE::HIT'],
      });
      return {
        ...cachedResult,
        socketAuthCache: cachedSocketAuth,
      };
    } catch {
      socketAuthCacheRejected = true;
    }
  }

  try {
    const tokenAuthResult = await fetchXianyuWebSocketAuthViaLoginToken({
      cookieText: input.cookieText,
    });
    const tokenResult = await sendXianyuWebSessionTextMessageViaSocketAuth({
      cookieText: tokenAuthResult.refreshedCookieText ?? input.cookieText,
      authSnapshot: tokenAuthResult.authSnapshot,
      sessionId: input.sessionId,
      conversationCid: input.conversationCid,
      content: input.content,
      rawRetPrefix: ['LOGIN_TOKEN::OK'],
    });
    return {
      ...tokenResult,
      refreshedCookieText: tokenAuthResult.refreshedCookieText,
      socketAuthCache: buildXianyuWebSocketAuthCache(tokenAuthResult.authSnapshot),
      socketAuthCacheRejected,
    };
  } catch (tokenAuthError) {
    if (socketAuthCacheRejected && tokenAuthError instanceof Error) {
      (tokenAuthError as Error & { socketAuthCacheRejected?: boolean }).socketAuthCacheRejected = true;
    }
  }

  try {
    return {
      ...(await sendXianyuWebSessionTextMessageViaBrowser({
        cookieText: input.cookieText,
        sessionId: input.sessionId,
        conversationCid: input.conversationCid,
        content: input.content,
      })),
      socketAuthCacheRejected,
    };
  } catch (error) {
    if (socketAuthCacheRejected && error instanceof Error) {
      (error as Error & { socketAuthCacheRejected?: boolean }).socketAuthCacheRejected = true;
    }
    throw error;
  }
}

export async function renewXianyuWebSessionCookieViaBrowser(input: {
  cookieText: string;
  showBrowser?: boolean;
  executablePath?: string | null;
}): Promise<XianyuBrowserRenewResult> {
  const executablePath = resolveBrowserExecutablePath(input.executablePath);
  if (!executablePath) {
    return {
      renewed: false,
      cookieText: null,
      currentUrl: null,
      pageTitle: null,
      verificationUrl: null,
      detail: '未找到可用的 Edge/Chrome 浏览器，请先配置 APP_XIANYU_BROWSER_EXECUTABLE_PATH。',
    };
  }

  const browser = await chromium.launch({
    executablePath,
    headless: input.showBrowser ? false : true,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage',
      '--disable-features=TranslateUI',
      '--lang=zh-CN',
    ],
  });

  let pageTitle: string | null = null;
  let currentUrl: string | null = null;

  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
      locale: 'zh-CN',
    });

    const cookieJar = parseCookieText(input.cookieText);
    if (cookieJar.size === 0) {
      return {
        renewed: false,
        cookieText: null,
        currentUrl: null,
        pageTitle: null,
        verificationUrl: null,
        detail: '当前没有可续登的 Cookie。 ',
      };
    }

    await context.addCookies(buildPlaywrightCookies(cookieJar));
    const page = await context.newPage();

    try {
      await page.goto(DEFAULT_RENEW_URL, {
        waitUntil: 'domcontentloaded',
        timeout: 15000,
      });
    } catch {
      await page.goto(DEFAULT_RENEW_URL, {
        waitUntil: 'load',
        timeout: 25000,
      });
    }

    await page.waitForTimeout(2000);
    try {
      await page.reload({
        waitUntil: 'domcontentloaded',
        timeout: 15000,
      });
      await page.waitForTimeout(1000);
    } catch {
      await page.waitForTimeout(1000);
    }

    currentUrl = page.url();
    pageTitle = await page.title().catch(() => null);

    const updatedCookies = await context.cookies();
    const nextJar = new Map<string, string>();
    for (const item of updatedCookies) {
      nextJar.set(item.name, item.value);
    }

    const renewedCookieText = stringifyCookieJar(nextJar);
    const verificationRequired =
      /verify|captcha|passport/i.test(currentUrl) || /验证码|验证/.test(pageTitle ?? '');

    if (verificationRequired) {
      return {
        renewed: false,
        cookieText: renewedCookieText || null,
        currentUrl,
        pageTitle,
        verificationUrl: currentUrl,
        detail: '浏览器访问过程中命中验证码或验证页，需要人工继续处理。',
      };
    }

    const importantKeys = ['unb', '_m_h5_tk', '_m_h5_tk_enc', 'cookie2', 't', 'sgcookie', 'cna'];
    const missingKeys = importantKeys.filter((key) => !nextJar.get(key));
    if (missingKeys.length > 0) {
      return {
        renewed: false,
        cookieText: renewedCookieText || null,
        currentUrl,
        pageTitle,
        verificationUrl: null,
        detail: `浏览器续登后仍缺少关键 Cookie：${missingKeys.join('、')}。`,
      };
    }

    return {
      renewed: true,
      cookieText: renewedCookieText,
      currentUrl,
      pageTitle,
      verificationUrl: null,
      detail: '浏览器续登成功，已获取新的关键 Cookie。',
    };
  } finally {
    await browser.close();
  }
}

export async function detectXianyuWebSessionProfileViaBrowser(input: {
  cookieText: string;
  showBrowser?: boolean;
  executablePath?: string | null;
}): Promise<XianyuWebSessionProfileDetectionResult> {
  const probe = await probeXianyuWebSessionViaBrowser(input);
  if (probe.missingKeys.includes('cookie')) {
    return {
      detected: false,
      cookieText: null,
      currentUrl: null,
      pageTitle: null,
      verificationUrl: null,
      detail: '当前没有可用于探测资料的 Cookie。',
      providerUserId: null,
      providerShopId: null,
      providerShopName: null,
      nickname: null,
      mobile: null,
    };
  }

  if (probe.verificationUrl) {
    return {
      detected: false,
      cookieText: probe.cookieText,
      currentUrl: probe.currentUrl,
      pageTitle: probe.pageTitle,
      verificationUrl: probe.verificationUrl,
      detail: '当前登录态命中验证页，先完成人工验证后再自动探测资料。',
      providerUserId: null,
      providerShopId: null,
      providerShopName: null,
      nickname: null,
      mobile: null,
    };
  }

  const providerUserId = probe.profile.userId?.trim() || null;
  const providerShopName = probe.profile.displayName?.trim() || probe.tracknick || null;
  const providerShopId =
    probe.tracknick || probe.profile.encryptedUserId?.trim() || providerUserId || null;

  if (!providerUserId || !providerShopId || !providerShopName) {
    return {
      detected: false,
      cookieText: probe.cookieText,
      currentUrl: probe.currentUrl,
      pageTitle: probe.pageTitle,
      verificationUrl: null,
      detail:
        probe.missingKeys.length > 0
          ? `网页登录态已恢复，但仍缺少关键 Cookie：${probe.missingKeys.join('、')}。`
          : '网页登录态已恢复，但暂未自动探测到完整的卖家资料。',
      providerUserId,
      providerShopId,
      providerShopName,
      nickname: providerShopName,
      mobile: null,
    };
  }

  return {
    detected: true,
    cookieText: probe.cookieText,
    currentUrl: probe.currentUrl,
    pageTitle: probe.pageTitle,
    verificationUrl: null,
    detail: '已根据网页登录态自动探测到卖家资料。',
    providerUserId,
    providerShopId,
    providerShopName,
    nickname: providerShopName,
    mobile: null,
  };
}
