/**
 * 请求校验 Schema 定义
 * 集中管理所有 API 路由的 Zod 校验规则
 */

import { z } from 'zod';
import { systemUserRoles } from './access-control.js';

// ─── 认证 ────────────────────────────────────────────────

export const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

export const mfaVerifySchema = z.object({
  challengeToken: z.string().min(1),
  code: z.string().min(6).max(8),
});

export const platformMfaConfirmSchema = z.object({
  code: z.string().min(6).max(8),
});

export const tenantSelectSchema = z.object({
  tenantId: z.coerce.number().int().positive(),
});

export const platformTenantCreateSchema = z.object({
  tenantKey: z
    .string()
    .min(2)
    .max(40)
    .regex(/^[a-zA-Z0-9_-]+$/, '租户标识只允许字母、数字、下划线和中划线'),
  tenantName: z.string().min(2).max(60),
  displayName: z.string().min(2).max(60).optional(),
  initialAdminUserId: z.coerce.number().int().positive().optional(),
  initialAdminRole: z.enum(systemUserRoles).optional(),
});

export const platformTenantStatusSchema = z.object({
  status: z.enum(['active', 'suspended']),
});

export const platformTenantMembershipSchema = z.object({
  platformUserId: z.coerce.number().int().positive(),
  membershipRole: z.enum(['owner', 'admin', 'member', 'support']),
  systemRole: z.enum(systemUserRoles),
  status: z.enum(['active', 'disabled']).optional(),
});

export const openPlatformAppCreateSchema = z.object({
  appName: z.string().min(2).max(60),
  ownerName: z.string().min(2).max(40),
  contactName: z.string().max(80).optional(),
  callbackUrl: z.string().max(200).optional(),
  scopes: z
    .array(z.enum(['dashboard.read', 'orders.read', 'webhook.receive']))
    .min(1)
    .max(6),
  rateLimitPerMinute: z.coerce.number().int().min(30).max(5000).optional(),
});

export const openPlatformAppStatusSchema = z.object({
  status: z.enum(['active', 'suspended']),
});

export const openPlatformSettingsSchema = z.object({
  webhookBaseUrl: z.string().max(200).optional(),
  notifyEmail: z.string().email().max(120).or(z.literal('')).optional(),
  publishedVersion: z.string().min(2).max(20).optional(),
  defaultRateLimitPerMinute: z.coerce.number().int().min(30).max(5000).optional(),
  signatureTtlSeconds: z.coerce.number().int().min(60).max(3600).optional(),
  whitelistEnforced: z.boolean().optional(),
});

export const openPlatformWhitelistRuleCreateSchema = z.object({
  ruleType: z.enum(['ip']).default('ip'),
  ruleValue: z.string().min(3).max(80),
  description: z.string().max(120).optional(),
  enabled: z.boolean().optional(),
});

export const openPlatformWhitelistEnabledSchema = z.object({
  enabled: z.boolean(),
});

export const strongPasswordSchema = z
  .string()
  .min(12, '密码至少需要 12 位')
  .max(64, '密码不能超过 64 位')
  .regex(/[a-z]/, '密码至少包含 1 个小写字母')
  .regex(/[A-Z]/, '密码至少包含 1 个大写字母')
  .regex(/\d/, '密码至少包含 1 个数字')
  .regex(/[^A-Za-z0-9]/, '密码至少包含 1 个特殊字符');

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1, '请输入当前密码'),
  newPassword: strongPasswordSchema,
});

// ─── 通用筛选 ────────────────────────────────────────────

export const storeIdsSchema = z.preprocess((value) => {
  if (Array.isArray(value)) {
    return value.flatMap((item) =>
      String(item)
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean),
    );
  }

  if (typeof value === 'string') {
    return value
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);
  }

  if (typeof value === 'number') {
    return [String(value)];
  }

  return undefined;
}, z.array(z.coerce.number().int().positive()).max(20).optional());

export const baseFilterSchema = z.object({
  preset: z.enum(['today', 'last7Days', 'last30Days', 'last90Days']).optional(),
  startDate: z.string().optional(),
  endDate: z.string().optional(),
  storeId: z.coerce.number().optional(),
  storeIds: storeIdsSchema,
  productId: z.coerce.number().optional(),
  category: z.string().optional(),
  source: z.string().optional(),
  keyword: z.string().optional(),
  mainStatus: z.string().optional(),
  deliveryStatus: z.string().optional(),
  orderStatus: z.string().optional(),
  afterSaleStatus: z.string().optional(),
  caseType: z.enum(['refund', 'resend', 'dispute']).optional(),
  caseStatus: z
    .enum(['pending_review', 'processing', 'waiting_execute', 'resolved', 'rejected'])
    .optional(),
  sortBy: z.enum(['paidAt', 'paidAmount', 'completedAt', 'updatedAt']).optional(),
  sortOrder: z.enum(['asc', 'desc']).optional(),
});

export const listQuerySchema = baseFilterSchema.extend({
  page: z.coerce.number().default(1),
  pageSize: z.coerce.number().default(20),
});

// ─── 工作台通用 ──────────────────────────────────────────

export const workspaceTaskStatusSchema = z.object({
  status: z.enum(['todo', 'in_progress', 'done']),
});

export const workspaceWithdrawalStatusSchema = z.object({
  status: z.enum(['pending', 'paid', 'rejected']),
});

export const workspaceWithdrawalCreateSchema = z.object({
  amount: z.coerce.number().positive().max(999999),
  storeId: z.coerce.number().int().positive().optional(),
  method: z.string().min(2).max(30),
  receivingAccount: z.string().min(3).max(120),
});

export const fundReconciliationStatusSchema = z.object({
  status: z.enum(['matched', 'anomaly', 'reviewed']),
  note: z.string().max(120).optional(),
});

// ─── AI 客服 ─────────────────────────────────────────────

export const aiServiceTakeoverSchema = z.object({
  action: z.enum(['takeover', 'release']),
  note: z.string().max(200).default(''),
});

export const aiServiceManualReplySchema = z.object({
  content: z.string().min(2).max(500),
  closeConversation: z.boolean().default(false),
});

export const aiServiceSettingsSchema = z.object({
  aiEnabled: z.boolean().optional(),
  autoReplyEnabled: z.boolean().optional(),
  faqEnabled: z.boolean().optional(),
  orderQueryEnabled: z.boolean().optional(),
  afterSaleSuggestionEnabled: z.boolean().optional(),
  highRiskManualOnly: z.boolean().optional(),
  boundaryNote: z.string().min(6).max(300).optional(),
  sensitiveWordsText: z.string().max(200).optional(),
});

export const aiServiceEnabledSchema = z.object({
  enabled: z.boolean(),
});

// ─── AI 议价 ─────────────────────────────────────────────

export const aiBargainTakeoverSchema = z.object({
  action: z.enum(['takeover', 'release']),
  note: z.string().max(200).default(''),
});

export const aiBargainManualDecisionSchema = z.object({
  content: z.string().min(2).max(500),
  action: z.enum(['counter_offer', 'accept', 'reject']),
  offerPrice: z.coerce.number().positive().max(999999).optional(),
});

export const aiBargainSettingsSchema = z.object({
  aiEnabled: z.boolean().optional(),
  autoBargainEnabled: z.boolean().optional(),
  highRiskManualOnly: z.boolean().optional(),
  allowAutoAccept: z.boolean().optional(),
  boundaryNote: z.string().min(6).max(300).optional(),
  sensitiveWordsText: z.string().max(200).optional(),
  blacklistNotice: z.string().min(4).max(200).optional(),
});

export const aiBargainStrategySchema = z.object({
  minPrice: z.coerce.number().positive().max(999999),
  targetPrice: z.coerce.number().positive().max(999999),
  stepPrice: z.coerce.number().positive().max(999999),
  maxRounds: z.coerce.number().int().min(1).max(8),
  enabled: z.boolean().optional(),
  riskTagsText: z.string().max(200).optional(),
});

// ─── 卡密 ────────────────────────────────────────────────

export const cardImportSchema = z.object({
  lines: z.array(z.string().min(1)).max(500).default([]),
});

export const cardRecycleSchema = z.object({
  action: z.enum(['recycle', 'revoke']),
});

// ─── 直充 / 分销 ────────────────────────────────────────

export const directChargeManualReviewSchema = z.object({
  reason: z.string().min(2).max(120).default('工作台人工接'),
});

export const directChargeCallbackSchema = z.object({
  taskNo: z.string().min(1),
  supplierOrderNo: z.string().min(1),
  supplierStatus: z.string().min(1),
  resultCode: z.string().optional(),
  detail: z.string().optional(),
  token: z.string().min(1),
});

export const supplySourceSyncSchema = z.object({
  syncType: z.enum(['product', 'inventory', 'price']),
});

export const supplySourceManualReviewSchema = z.object({
  reason: z.string().min(2).max(120).default('\\u5de5\\u4f5c\\u53f0\\u4eba\\u5de5\\u63a5\\u7ba1'),
});

export const supplySourceCallbackSchema = z.object({
  taskNo: z.string().min(1),
  sourceOrderNo: z.string().min(1),
  sourceStatus: z.string().min(1),
  detail: z.string().optional(),
  token: z.string().min(1),
});

export const supplySourceRefundSchema = z.object({
  noticeNo: z.string().min(1),
  sourceOrderNo: z.string().min(1),
  refundStatus: z.string().min(1),
  detail: z.string().optional(),
  token: z.string().min(1),
});

// ─── 履约 ────────────────────────────────────────────────

export const fulfillmentReasonSchema = z.object({
  reason: z.string().min(2).max(120),
});

export const fulfillmentNoteSchema = z.object({
  note: z.string().min(2).max(300),
});

// ─── 售后 ────────────────────────────────────────────────

export const afterSaleRefundActionSchema = z.object({
  decision: z.enum(['approve', 'reject', 'refund']),
  approvedAmount: z.coerce.number().positive().max(999999).optional(),
  note: z.string().max(300).default(''),
});

export const afterSaleResendActionSchema = z.object({
  decision: z.enum(['approve', 'reject', 'success', 'failed']),
  note: z.string().max(300).default(''),
});

export const afterSaleDisputeActionSchema = z.object({
  decision: z.enum(['buyer_win', 'seller_win', 'refund', 'resend']),
  compensationAmount: z.coerce.number().min(0).max(999999).optional(),
  note: z.string().max(300).default(''),
});

export const afterSaleNoteSchema = z.object({
  note: z.string().min(2).max(300),
});

// ─── 店铺授权 ────────────────────────────────────────────

export const storeAuthSessionSchema = z.object({
  platform: z.enum(['xianyu', 'taobao']),
  source: z.string().default('shop'),
  authType: z.coerce.number().int().positive().default(11),
  storeId: z.coerce.number().int().positive().optional(),
});

export const storeAuthCompleteSchema = z.object({
  mobile: z.string().min(6),
  nickname: z.string().min(1),
  loginMode: z.enum(['sms', 'password']),
});

export const storeAuthProviderCallbackSchema = z.object({
  accessToken: z.string().min(1),
  tokenType: z.string().optional(),
  expiresInSeconds: z.coerce.number().int().positive().optional(),
  state: z.string().min(1),
  rawCallback: z.string().min(1),
});

export const storeAuthProfileSyncSchema = z.object({
  providerUserId: z.string().min(1),
  providerShopId: z.string().min(1),
  providerShopName: z.string().min(1),
  mobile: z.string().min(2),
  nickname: z.string().min(1).optional(),
  scopeText: z.string().max(200).optional(),
  refreshToken: z.string().min(1).max(512).optional(),
});

export const storeAuthWebSessionSyncSchema = z.object({
  cookieText: z.string().min(10).optional(),
  providerUserId: z.string().min(1),
  providerShopId: z.string().min(1),
  providerShopName: z.string().min(1),
  mobile: z.string().min(2),
  nickname: z.string().min(1).optional(),
  scopeText: z.string().max(200).optional(),
  refreshToken: z.string().min(1).max(512).optional(),
});

export const storeBrowserRenewSchema = z.object({
  showBrowser: z.boolean().optional().default(false),
  executablePath: z.string().min(1).max(260).optional(),
});

// ─── 闲鱼同步 ────────────────────────────────────────────

export const xianyuProductSyncSchema = z.object({
  storeIds: z.array(z.coerce.number().int().positive()).max(20).optional(),
});

export const xianyuOrderSyncSchema = z.object({
  storeIds: z.array(z.coerce.number().int().positive()).max(20).optional(),
  maxOrdersPerStore: z.coerce.number().int().positive().max(100).optional(),
});

export const aiBargainSyncSchema = z.object({
  storeIds: z.array(z.coerce.number().int().positive()).max(20).optional(),
  maxSessionsPerStore: z.coerce.number().int().positive().max(50).optional(),
  maxMessagesPerSession: z.coerce.number().int().positive().max(50).optional(),
});

export const aiServiceSyncSchema = aiBargainSyncSchema;

// ─── 店铺管理 ────────────────────────────────────────────

export const storeMetaUpdateSchema = z.object({
  groupName: z.string().min(1).max(30),
  tags: z.array(z.string().min(1).max(20)).max(8).default([]),
  remark: z.string().max(200).default(''),
});

export const storeEnabledSchema = z.object({
  enabled: z.boolean(),
});

export const storeBatchStatusSchema = z.object({
  storeIds: z.array(z.coerce.number().int().positive()).min(1).max(50),
  enabled: z.boolean(),
});

export const storeBatchHealthCheckSchema = z.object({
  storeIds: z.array(z.coerce.number().int().positive()).min(1).max(50),
});

// ─── 系统管理 ────────────────────────────────────────────

export const systemUserCreateSchema = z.object({
  username: z
    .string()
    .min(3)
    .max(32)
    .regex(/^[a-zA-Z0-9._-]+$/, '用户名只允许字母、数字、点、下划线和中划线'),
  displayName: z.string().min(2).max(32),
  password: strongPasswordSchema,
  role: z.enum(systemUserRoles),
});

export const systemUserRoleSchema = z.object({
  role: z.enum(systemUserRoles),
});

export const systemUserStatusSchema = z.object({
  status: z.enum(['active', 'disabled']),
});

export const secureSettingUpsertSchema = z.object({
  description: z.string().min(2).max(120),
  value: z.string().min(6).max(256),
});

export const systemAlertStatusSchema = z.object({
  status: z.enum(['acknowledged', 'resolved']),
});
