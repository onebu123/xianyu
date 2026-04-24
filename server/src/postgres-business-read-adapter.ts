import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import pg from 'pg';
import {
  addDays,
  differenceInCalendarDays,
  endOfDay,
  format,
  isValid,
  parseISO,
  startOfDay,
  subDays,
} from 'date-fns';

import { decryptSecret, encryptSecret, maskSecret } from './auth.js';
import { appConfig } from './config.js';
import type { StatisticsDatabase } from './database.js';
import { buildOpenPlatformSecretSettingKey } from './open-platform-repository.js';
import { getSupplySourceAdapter } from './source-system-adapters.js';
import type { SupplySourceSyncType } from './source-system-adapters.js';
import { resolveStoreAuthProviderPlan } from './store-auth-providers.js';
import type { FilterOptions, PaginationParams, QueryFilters, StoreAuthIntegrationMode } from './types.js';
import type {
  XianyuWebBargainSession,
  XianyuWebSocketAuthCache,
} from './xianyu-web-session.js';

const { Pool } = pg;

interface DateRange {
  startDate: string;
  endDate: string;
  previousStartDate: string;
  previousEndDate: string;
}

interface MetricSummary {
  grossAmount: number;
  receivedAmount: number;
  discountAmount: number;
  salesAmount: number;
  orderCount: number;
  averageOrderValue: number;
  averageDeliveryHours: number;
  refundAmount: number;
  newCustomerCount: number;
  costAmount: number;
  compensationAmount: number;
  grossProfit: number;
  grossMargin: number;
  netProfit: number;
  paymentCount: number;
}

interface PostgresOperationalSnapshot {
  database: {
    databaseName: string;
    sizeBytes: number;
  };
  tables: Array<{
    schemaName: string;
    tableName: string;
    rowEstimate: number;
    totalBytes: number;
    columns: Array<{
      columnName: string;
      dataType: string;
      udtName: string;
      isNullable: boolean;
    }>;
  }>;
}

type DashboardResponse = ReturnType<{
  (): {
    range: {
      startDate: string;
      endDate: string;
      preset: string;
    };
    summary: Array<{
      key: string;
      label: string;
      value: number;
      unit: string;
      compareRate: number;
    }>;
    modules: {
      todayCards: Array<{ label: string; value: number; unit: string }>;
      businessCards: {
        productStats: Array<{ label: string; value: number; unit: string }>;
        orderStats: Array<{ label: string; value: number; unit: string }>;
        afterSaleStats: Array<{ label: string; value: number; unit: string }>;
      };
    };
    trend: Array<{
      reportDate: string;
      salesAmount: number;
      orderCount: number;
      refundAmount: number;
    }>;
    sourceDistribution: Array<{ source: string; orderCount: number; salesAmount: number }>;
    orderStatusDistribution: Array<{ status: string; orderCount: number }>;
    topProducts: Array<{
      name: string;
      storeName: string;
      category: string;
      soldQuantity: number;
      salesAmount: number;
      refundAmount: number;
    }>;
    filters: FilterOptions;
  };
}>;

type OrdersOverview = {
  totalOrders: number;
  paidOrders: number;
  processingOrders: number;
  fulfilledOrders: number;
  mainCompletedOrders: number;
  mainAfterSaleOrders: number;
  pendingShipment: number;
  shippedOrders: number;
  completedOrders: number;
  afterSaleOrders: number;
  averageDeliveryHours: number;
  salesAmount: number;
};
type OrderMainStatus = 'paid' | 'processing' | 'fulfilled' | 'completed' | 'after_sale' | 'closed';
type OrderPaymentStatus = 'paid' | 'refunded_partial' | 'refunded_full';
type OrderDeliveryStatus = 'pending' | 'shipped' | 'delivered' | 'manual_review';
type OrderFulfillmentType = 'standard' | 'card' | 'direct_charge';
type OrderFulfillmentQueue = 'pending' | 'processing' | 'success' | 'failed' | 'manual_review';
type AfterSaleCaseType = 'refund' | 'resend' | 'dispute';
type AfterSaleCaseStatus = 'pending_review' | 'processing' | 'waiting_execute' | 'resolved' | 'rejected';
type AfterSaleRefundStatus = 'pending_review' | 'approved' | 'rejected' | 'refunded';
type AfterSaleResendStatus = 'requested' | 'approved' | 'processing' | 'succeeded' | 'failed' | 'rejected';
type AfterSaleDisputeStatus = 'open' | 'processing' | 'buyer_win' | 'seller_win' | 'refunded' | 'resent';
type AfterSaleReminderType = 'pending' | 'timeout';
type AfterSaleReminderStatus = 'active' | 'resolved';
type CardOutboundStatus = 'sent' | 'resent' | 'recycled' | 'revoked';
type DirectChargeJobStatus = 'pending_dispatch' | 'processing' | 'success' | 'failed' | 'manual_review';
type SupplySourceSyncRunStatus = 'success' | 'failed' | 'partial';
type SupplySourceSyncMode = 'manual' | 'scheduled';
type SupplySourceReconcileStatus = 'matched' | 'pending' | 'anomaly' | 'reviewed';
type SupplySourceSystemStatus = 'online' | 'warning' | 'offline';
type SupplySourceOrderStatus = 'pending_push' | 'processing' | 'success' | 'failed' | 'manual_review';
type SupplySourceVerificationStatus = 'pending' | 'verified' | 'failed';
type OrdersListResult = ReturnType<StatisticsDatabase['getOrdersList']>;
type OrderDetailResult = ReturnType<StatisticsDatabase['getOrderDetail']>;
type OrdersExportCsv = ReturnType<StatisticsDatabase['exportOrdersCsv']>;
type OrderFulfillmentWorkbench = ReturnType<StatisticsDatabase['getOrderFulfillmentWorkbench']>;
type AfterSaleWorkbenchResult = ReturnType<StatisticsDatabase['getAfterSaleWorkbench']>;
type AfterSaleCasesResult = ReturnType<StatisticsDatabase['getAfterSaleCases']>;
type AfterSaleDetailResult = ReturnType<StatisticsDatabase['getAfterSaleDetail']>;
type OrderListItem = OrdersListResult['list'][number];
type OrderDetailPayload = NonNullable<OrderDetailResult>;
type OrderFulfillmentMeta = {
  fulfillmentType: OrderListItem['fulfillmentType'];
  fulfillmentTypeText: OrderListItem['fulfillmentTypeText'];
  fulfillmentQueue: OrderListItem['fulfillmentQueue'];
  fulfillmentQueueText: OrderListItem['fulfillmentQueueText'];
  fulfillmentStage: OrderListItem['fulfillmentStage'];
  fulfillmentStageDetail: OrderListItem['fulfillmentStageDetail'];
  latestTaskNo: OrderDetailPayload['fulfillment']['latestTaskNo'];
  latestSupplierOrderNo: OrderDetailPayload['fulfillment']['latestSupplierOrderNo'];
  latestOutboundNo: OrderDetailPayload['fulfillment']['latestOutboundNo'];
  retryCount: OrderDetailPayload['fulfillment']['retryCount'];
  maxRetry: OrderDetailPayload['fulfillment']['maxRetry'];
  manualReason: OrderDetailPayload['fulfillment']['manualReason'];
  latestLogTitle: OrderDetailPayload['fulfillment']['latestLogTitle'];
  latestLogDetail: OrderDetailPayload['fulfillment']['latestLogDetail'];
  latestLogAt: OrderDetailPayload['fulfillment']['latestLogAt'];
  canRetry: OrderDetailPayload['fulfillment']['canRetry'];
  canResend: OrderDetailPayload['fulfillment']['canResend'];
  canTerminate: OrderDetailPayload['fulfillment']['canTerminate'];
  canNote: OrderDetailPayload['fulfillment']['canNote'];
};

type WorkspaceOverview = NonNullable<ReturnType<StatisticsDatabase['getWorkspaceOverview']>>;
type WorkspaceBusinessDetail = NonNullable<ReturnType<StatisticsDatabase['getWorkspaceBusinessDetail']>>;
type BusinessReportsResponse = ReturnType<StatisticsDatabase['getBusinessReports']>;
type ProductsView = ReturnType<StatisticsDatabase['getProductsView']>;
type CustomersView = ReturnType<StatisticsDatabase['getCustomersView']>;
type StoreManagementOverview = ReturnType<StatisticsDatabase['getStoreManagementOverview']>;
type StoreAuthSessionCreateResult = ReturnType<StatisticsDatabase['createStoreAuthSession']> & {
  shadowSeed?: {
    sessionId: string;
    createdAt: string;
    expiresAt: string;
    providerState?: string | null;
  };
};
type StoreAuthSessionDetail = ReturnType<StatisticsDatabase['getStoreAuthSessionDetail']>;
type StoreCredentialEvents = ReturnType<StatisticsDatabase['getStoreCredentialEvents']>;
type StoreCredentialEventsBySession = ReturnType<StatisticsDatabase['getStoreCredentialEventsBySession']>;
type SystemHealthSnapshot = ReturnType<StatisticsDatabase['getSystemHealthSnapshot']>;
type SystemMonitoringDetail = Extract<WorkspaceBusinessDetail, { kind: 'system-monitoring' }>;
type AiServiceDetail = Extract<WorkspaceBusinessDetail, { kind: 'ai-service' }>;
type AiServiceGeneratedReply = ReturnType<StatisticsDatabase['generateAiServiceReply']>;
type AiServiceLlmReply = ReturnType<StatisticsDatabase['writeAiServiceLlmReply']>;
type AiServiceTakeoverUpdate = ReturnType<StatisticsDatabase['updateAiServiceConversationTakeover']>;
type AiServiceManualReply = ReturnType<StatisticsDatabase['sendAiServiceManualReply']>;
type AiServiceSyncTarget = ReturnType<StatisticsDatabase['listManagedStoreAiBargainSyncTargets']>[number];
type AiServiceDispatchTarget = ReturnType<StatisticsDatabase['getAiServiceConversationDispatchTarget']>;
type AiServiceSyncResult = ReturnType<StatisticsDatabase['syncAiServiceConversationsFromXianyuIm']>;
type AiBargainSyncResult = ReturnType<StatisticsDatabase['syncAiBargainSessionsFromXianyuIm']>;
type WorkspaceTaskStatus = 'todo' | 'in_progress' | 'done';
type SystemAlertStatus = 'acknowledged' | 'resolved';
type SystemAlertStatusUpdate = NonNullable<ReturnType<StatisticsDatabase['updateSystemAlertStatus']>>;
type SystemBackupRun = NonNullable<ReturnType<StatisticsDatabase['runSystemBackup']>>;
type SystemLogArchiveRun = NonNullable<ReturnType<StatisticsDatabase['runSystemLogArchive']>>;
type SystemRecoveryDrillRun = NonNullable<ReturnType<StatisticsDatabase['runSystemRecoveryDrill']>>;
type AuditLogInput = {
  action: string;
  targetType: string;
  targetId?: string | null;
  detail: string;
  result: 'success' | 'failure' | 'blocked';
  operator?: {
    id: number;
    username: string;
    displayName: string;
  } | null;
  ipAddress?: string | null;
};

type StorePlatform = 'xianyu' | 'taobao';
type StoreConnectionStatus = 'pending_activation' | 'active' | 'offline' | 'abnormal';
type StoreAuthStatus = 'authorized' | 'expired' | 'invalidated' | 'pending';
type StoreAuthSessionStatus = 'pending' | 'completed' | 'expired' | 'invalidated';
type StoreHealthStatus = 'healthy' | 'warning' | 'offline' | 'abnormal' | 'skipped';
type StoreCredentialRiskLevel = 'pending' | 'healthy' | 'warning' | 'offline' | 'abnormal';
type StoreCredentialEventType =
  | 'qr_login_started'
  | 'browser_qr_login_started'
  | 'browser_qr_login_accepted'
  | 'credential_captured'
  | 'profile_synced'
  | 'credential_verified'
  | 'browser_renewed'
  | 'manual_takeover_required';
type StoreCredentialEventStatus = 'info' | 'success' | 'warning' | 'error';
type StoreProfileSyncStatus = 'pending' | 'syncing' | 'success' | 'failed';
type StoreAuthSessionNextStep =
  | 'manual_complete'
  | 'wait_provider_callback'
  | 'sync_profile'
  | 'done'
  | 'expired'
  | 'invalidated';

interface ManagedStoreRecord {
  id: number;
  platform: StorePlatform;
  shopTypeLabel: string;
  shopName: string;
  sellerNo: string;
  nickname: string;
  statusText: string;
  activationStatus: string;
  packageText: string;
  publishLimitText: string;
  createdAt: string;
  updatedAt: string;
  ownerAccountId: number | null;
  ownerAccountName: string | null;
  ownerMobile: string | null;
  createdByUserId: number | null;
  createdByName: string | null;
  groupName: string;
  tagsText: string;
  remark: string;
  enabled: number;
  connectionStatus: StoreConnectionStatus;
  authStatus: StoreAuthStatus;
  authExpiresAt: string | null;
  lastSyncAt: string | null;
  healthStatus: StoreHealthStatus;
  lastHealthCheckAt: string | null;
  lastHealthCheckDetail: string | null;
  lastSessionId: string | null;
  lastReauthorizeAt: string | null;
  providerStoreId: string | null;
  providerUserId: string | null;
  credentialId: number | null;
  credentialType: string | null;
  credentialSource: string | null;
  credentialRiskLevel: StoreCredentialRiskLevel | null;
  credentialRiskReason: string | null;
  credentialVerificationUrl: string | null;
  lastCredentialRenewAt: string | null;
  lastCredentialRenewStatus: string | null;
  profileSyncStatus: StoreProfileSyncStatus;
  profileSyncError: string | null;
  lastProfileSyncAt: string | null;
  lastVerifiedAt: string | null;
}

interface StoreCredentialEventRecord {
  id: number;
  storeId: number | null;
  sessionId: string | null;
  credentialId: number | null;
  eventType: StoreCredentialEventType;
  status: StoreCredentialEventStatus;
  detail: string;
  source: string | null;
  riskLevel: StoreCredentialRiskLevel | null;
  verificationUrl: string | null;
  createdAt: string;
  operatorName: string | null;
}

interface StoreAuthSessionStepInfo {
  nextStepKey: StoreAuthSessionNextStep;
  nextStepText: string;
}

const ORDER_SORT_FIELDS = {
  paidAt: 'o.paid_at',
  paidAmount: 'o.paid_amount',
  completedAt: 'o.completed_at',
  updatedAt: 'o.updated_at',
} as const;
const DEFAULT_FULFILLMENT_STAGE = 'Pending fulfillment';
const DEFAULT_FULFILLMENT_STAGE_DETAIL = 'Waiting to enter the unified fulfillment pipeline.';

function normalizeOpenPlatformScopes(scopesText: string) {
  return String(scopesText ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

interface ReportOrderRow {
  id: number;
  orderNo: string;
  storeId: number;
  storeName: string;
  productId: number;
  productName: string;
  productSku: string;
  category: string;
  source: string;
  quantity: number;
  paidAmount: number;
  refundAmount: number;
  grossAmount: number;
  discountAmount: number;
  receivedAmount: number;
  paymentCount: number;
  unitCost: number;
  mainStatus: string;
  paymentStatus: string;
  deliveryStatus: string;
  orderStatus: string;
  afterSaleStatus: string;
  paidAt: string;
  completedAt: string | null;
  deliveryHours: number;
  isNewCustomer: number;
  fulfillmentType: string;
  fulfillmentQueue: string;
}

interface ReportCaseRow {
  caseId: number;
  caseNo: string;
  orderId: number;
  orderNo: string;
  storeId: number;
  storeName: string;
  productId: number;
  productName: string;
  category: string;
  caseType: string;
  caseStatus: string;
  priority: string;
  latestResult: string | null;
  createdAt: string;
  deadlineAt: string;
  refundStatus: string | null;
  requestedAmount: number | null;
  approvedAmount: number | null;
  resendStatus: string | null;
  disputeStatus: string | null;
  compensationAmount: number | null;
}

function toNumber(value: unknown, digits = 0) {
  const numeric = Number(value ?? 0);
  if (!Number.isFinite(numeric)) {
    return 0;
  }
  return digits > 0 ? Number(numeric.toFixed(digits)) : numeric;
}

function toPercentage(value: number) {
  return Number(value.toFixed(2));
}

function compareMetric(current: number, previous: number) {
  if (previous === 0) {
    return current === 0 ? 0 : 100;
  }
  return toPercentage(((current - previous) / previous) * 100);
}

function resolveDateRange(filters: QueryFilters): DateRange {
  const now = new Date();
  let start = startOfDay(subDays(now, 29));
  let end = endOfDay(now);

  if (filters.startDate && filters.endDate) {
    const startDate = parseISO(filters.startDate);
    const endDate = parseISO(filters.endDate);
    if (isValid(startDate) && isValid(endDate)) {
      start = startOfDay(startDate);
      end = endOfDay(endDate);
    }
  } else if (filters.preset) {
    switch (filters.preset) {
      case 'today':
        start = startOfDay(now);
        end = endOfDay(now);
        break;
      case 'last7Days':
        start = startOfDay(subDays(now, 6));
        end = endOfDay(now);
        break;
      case 'last30Days':
        start = startOfDay(subDays(now, 29));
        end = endOfDay(now);
        break;
      case 'last90Days':
        start = startOfDay(subDays(now, 89));
        end = endOfDay(now);
        break;
    }
  }

  const dayCount = differenceInCalendarDays(end, start) + 1;
  const previousEnd = endOfDay(subDays(start, 1));
  const previousStart = startOfDay(subDays(previousEnd, dayCount - 1));

  return {
    startDate: format(start, 'yyyy-MM-dd'),
    endDate: format(end, 'yyyy-MM-dd'),
    previousStartDate: format(previousStart, 'yyyy-MM-dd'),
    previousEndDate: format(previousEnd, 'yyyy-MM-dd'),
  };
}

function buildOrderFilter(filters: QueryFilters, range: DateRange) {
  const clauses = ['substring(o.paid_at, 1, 10) BETWEEN $1 AND $2'];
  const values: Array<string | number | number[]> = [range.startDate, range.endDate];

  const pushValue = (value: string | number | number[]) => {
    values.push(value);
    return `$${values.length}`;
  };

  if (filters.storeId) {
    clauses.push(`o.store_id = ${pushValue(filters.storeId)}`);
  }
  if (filters.storeIds?.length) {
    clauses.push(`o.store_id = ANY(${pushValue(filters.storeIds.map((item) => Number(item)))}::int[])`);
  }
  if (filters.productId) {
    clauses.push(`o.product_id = ${pushValue(filters.productId)}`);
  }
  if (filters.category?.trim()) {
    clauses.push(`p.category = ${pushValue(filters.category.trim())}`);
  }
  if (filters.source?.trim()) {
    clauses.push(`o.source = ${pushValue(filters.source.trim())}`);
  }
  if (filters.keyword?.trim()) {
    const keyword = `%${filters.keyword.trim()}%`;
    const placeholder = pushValue(keyword);
    clauses.push(
      `(o.order_no ILIKE ${placeholder} OR COALESCE(p.name, '') ILIKE ${placeholder} OR COALESCE(c.name, '') ILIKE ${placeholder})`,
    );
  }
  if (filters.mainStatus?.trim()) {
    clauses.push(`o.main_status = ${pushValue(filters.mainStatus.trim())}`);
  }
  if (filters.deliveryStatus?.trim()) {
    clauses.push(`o.delivery_status = ${pushValue(filters.deliveryStatus.trim())}`);
  }
  if (filters.orderStatus?.trim()) {
    clauses.push(`o.order_status = ${pushValue(filters.orderStatus.trim())}`);
  }
  if (filters.afterSaleStatus?.trim()) {
    clauses.push(`o.after_sale_status = ${pushValue(filters.afterSaleStatus.trim())}`);
  }

  return {
    whereSql: `WHERE ${clauses.join(' AND ')}`,
    values,
  };
}

function buildProductFilter(filters: QueryFilters) {
  const clauses: string[] = [];
  const values: Array<string | number | number[]> = [];

  const pushValue = (value: string | number | number[]) => {
    values.push(value);
    return `$${values.length}`;
  };

  if (filters.storeId) {
    clauses.push(`p.store_id = ${pushValue(filters.storeId)}`);
  }
  if (filters.storeIds?.length) {
    clauses.push(`p.store_id = ANY(${pushValue(filters.storeIds.map((item) => Number(item)))}::int[])`);
  }
  if (filters.productId) {
    clauses.push(`p.id = ${pushValue(filters.productId)}`);
  }
  if (filters.category?.trim()) {
    clauses.push(`p.category = ${pushValue(filters.category.trim())}`);
  }
  if (filters.keyword?.trim()) {
    const keyword = `%${filters.keyword.trim()}%`;
    const placeholder = pushValue(keyword);
    clauses.push(`(p.name ILIKE ${placeholder} OR p.sku ILIKE ${placeholder})`);
  }

  return {
    whereSql: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '',
    values,
  };
}

function buildAfterSaleFilter(filters: QueryFilters, range: DateRange) {
  const clauses = ['ac.created_at >= $1', 'ac.created_at <= $2'];
  const values: Array<string | number | number[]> = [
    `${range.startDate} 00:00:00`,
    `${range.endDate} 23:59:59`,
  ];

  const pushValue = (value: string | number | number[]) => {
    values.push(value);
    return `$${values.length}`;
  };

  if (filters.storeId) {
    clauses.push(`o.store_id = ${pushValue(filters.storeId)}`);
  }
  if (filters.storeIds?.length) {
    clauses.push(`o.store_id = ANY(${pushValue(filters.storeIds.map((item) => Number(item)))}::int[])`);
  }
  if (filters.productId) {
    clauses.push(`o.product_id = ${pushValue(filters.productId)}`);
  }
  if (filters.category?.trim()) {
    clauses.push(`p.category = ${pushValue(filters.category.trim())}`);
  }
  if (filters.source?.trim()) {
    clauses.push(`o.source = ${pushValue(filters.source.trim())}`);
  }
  if (filters.afterSaleStatus?.trim()) {
    clauses.push(`o.after_sale_status = ${pushValue(filters.afterSaleStatus.trim())}`);
  }
  if (filters.caseType?.trim()) {
    clauses.push(`ac.case_type = ${pushValue(filters.caseType.trim())}`);
  }
  if (filters.caseStatus?.trim()) {
    clauses.push(`ac.case_status = ${pushValue(filters.caseStatus.trim())}`);
  }
  if (filters.keyword?.trim()) {
    const keyword = `%${filters.keyword.trim()}%`;
    const placeholder = pushValue(keyword);
    clauses.push(
      `(ac.case_no ILIKE ${placeholder} OR o.order_no ILIKE ${placeholder} OR COALESCE(p.name, '') ILIKE ${placeholder} OR COALESCE(c.name, '') ILIKE ${placeholder})`,
    );
  }

  return {
    whereSql: `WHERE ${clauses.join(' AND ')}`,
    values,
  };
}

function shiftPlaceholders(sql: string, offset: number) {
  if (!sql || offset === 0) {
    return sql;
  }
  return sql.replace(/\$(\d+)/g, (_match, index) => `$${Number(index) + offset}`);
}

function getOrderMainStatusText(status: string) {
  return (
    {
      paid: '待履约',
      processing: '处理中',
      fulfilled: '已履约',
      completed: '已完成',
      after_sale: '售后中',
      closed: '已关闭',
    }[status] ?? status
  );
}

function getOrderDeliveryStatusText(status: string) {
  return (
    {
      pending: 'Pending shipment',
      shipped: 'Shipped',
      delivered: 'Delivered',
      manual_review: 'Manual review',
    }[status] ?? status
  );
}

function getOrderPaymentStatusText(status: string) {
  return (
    {
      paid: 'Paid',
      refunded_partial: 'Partial refund',
      refunded_full: 'Full refund',
    }[status] ?? status
  );
}

function getOrderFulfillmentTypeText(type: string) {
  return (
    {
      standard: 'Standard',
      card: 'Card delivery',
      direct_charge: 'Direct charge',
    }[type] ?? type
  );
}

function getOrderFulfillmentQueueText(queue: string) {
  return (
    {
      pending: '待处理',
      processing: '处理中',
      success: '已成功',
      failed: '失败待处理',
      manual_review: '待人工',
    }[queue] ?? queue
  );
}

function getAfterSaleCaseTypeText(type: string) {
  return (
    {
      refund: '退款单',
      resend: '补发单',
      dispute: '争议单',
    }[type] ?? type
  );
}

function getAfterSaleCaseStatusText(status: string) {
  return (
    {
      pending_review: '待审核',
      processing: '处理中',
      waiting_execute: '待执行',
      resolved: '已完结',
      rejected: '已驳回',
    }[status] ?? status
  );
}

function getAfterSaleRefundStatusText(status: string) {
  return (
    {
      pending_review: '待审核',
      approved: '已通过',
      rejected: '已驳回',
      refunded: '已退款',
    }[status] ?? status
  );
}

function getAfterSaleResendStatusText(status: string) {
  return (
    {
      requested: '待确认',
      approved: '已通过',
      processing: '补发中',
      succeeded: '补发成功',
      failed: '补发失败',
      rejected: '已驳回',
    }[status] ?? status
  );
}

function getAfterSaleDisputeStatusText(status: string) {
  return (
    {
      open: '待登记',
      processing: '处理中',
      buyer_win: '支持买家',
      seller_win: '支持卖家',
      refunded: '转退款',
      resent: '转补发',
    }[status] ?? status
  );
}

function getAfterSaleReminderTypeText(type: string) {
  return (
    {
      pending: '待处理提醒',
      timeout: '超时提醒',
    }[type] ?? type
  );
}

function getAfterSalePriorityText(priority: string) {
  return (
    {
      low: '低',
      normal: '中',
      high: '高',
      urgent: '紧急',
    }[priority] ?? priority
  );
}

function isTimeoutAfterSaleCase(caseStatus: string, deadlineAt: string, nowText = format(new Date(), 'yyyy-MM-dd HH:mm:ss')) {
  return !['resolved', 'rejected'].includes(caseStatus) && deadlineAt < nowText;
}

function escapeCsvCell(value: string | number | null | undefined) {
  return `"${String(value ?? '').replaceAll('"', '""')}"`;
}

function buildOrderFulfillmentMeta(input: {
  mainStatus: string;
  deliveryStatus: string;
  cardDeliveryId?: number | null;
  directChargeItemId?: number | null;
  cardJobStatus?: string | null;
  cardAttemptCount?: number | null;
  cardErrorMessage?: string | null;
  latestOutboundNo?: string | null;
  directTaskNo?: string | null;
  directSupplierOrderNo?: string | null;
  directTaskStatus?: string | null;
  directRetryCount?: number | null;
  directMaxRetry?: number | null;
  directErrorMessage?: string | null;
  directResultDetail?: string | null;
  directManualReason?: string | null;
  latestLogTitle?: string | null;
  latestLogDetail?: string | null;
  latestLogAt?: string | null;
}): OrderFulfillmentMeta {
  const fulfillmentType =
    input.cardDeliveryId != null
      ? 'card'
      : input.directChargeItemId != null || input.directTaskNo || input.directTaskStatus
        ? 'direct_charge'
        : 'standard';

  let fulfillmentQueue: OrderListItem['fulfillmentQueue'] = 'pending';
  if (input.mainStatus === 'closed') {
    fulfillmentQueue = 'failed';
  } else if (fulfillmentType === 'card') {
    if (input.cardJobStatus === 'failed') {
      fulfillmentQueue = 'failed';
    } else if (input.deliveryStatus === 'manual_review') {
      fulfillmentQueue = 'manual_review';
    } else if (
      input.cardJobStatus === 'success' ||
      input.deliveryStatus === 'delivered' ||
      ['fulfilled', 'completed'].includes(input.mainStatus)
    ) {
      fulfillmentQueue = 'success';
    } else if (input.mainStatus === 'processing' || input.deliveryStatus === 'shipped') {
      fulfillmentQueue = 'processing';
    }
  } else if (fulfillmentType === 'direct_charge') {
    if (input.directTaskStatus === 'failed') {
      fulfillmentQueue = 'failed';
    } else if (input.directTaskStatus === 'manual_review' || input.deliveryStatus === 'manual_review') {
      fulfillmentQueue = 'manual_review';
    } else if (
      input.directTaskStatus === 'success' ||
      input.deliveryStatus === 'delivered' ||
      input.mainStatus === 'completed'
    ) {
      fulfillmentQueue = 'success';
    } else if (
      input.directTaskStatus === 'processing' ||
      input.mainStatus === 'processing' ||
      input.deliveryStatus === 'shipped'
    ) {
      fulfillmentQueue = 'processing';
    }
  } else if (input.deliveryStatus === 'manual_review') {
    fulfillmentQueue = 'manual_review';
  } else if (
    input.deliveryStatus === 'delivered' ||
    ['fulfilled', 'completed'].includes(input.mainStatus)
  ) {
    fulfillmentQueue = 'success';
  } else if (input.mainStatus === 'processing' || input.deliveryStatus === 'shipped') {
    fulfillmentQueue = 'processing';
  }

  let fulfillmentStage = DEFAULT_FULFILLMENT_STAGE;
  let fulfillmentStageDetail = DEFAULT_FULFILLMENT_STAGE_DETAIL;

  if (fulfillmentType === 'card') {
    if (fulfillmentQueue === 'failed') {
      fulfillmentStage = 'Card delivery failed';
      fulfillmentStageDetail = input.cardErrorMessage ?? 'Card delivery failed and is waiting for follow-up.';
    } else if (fulfillmentQueue === 'manual_review') {
      fulfillmentStage = 'Card delivery needs review';
      fulfillmentStageDetail = input.cardErrorMessage ?? 'Card delivery was handed over for manual review.';
    } else if (fulfillmentQueue === 'success') {
      fulfillmentStage = 'Card delivery completed';
      fulfillmentStageDetail = input.latestOutboundNo
        ? `Latest outbound record: ${input.latestOutboundNo}`
        : 'Card delivery has completed successfully.';
    } else if (fulfillmentQueue === 'processing') {
      fulfillmentStage = 'Card delivery processing';
      fulfillmentStageDetail = 'The order has entered the card delivery pipeline.';
    } else {
      fulfillmentStage = 'Waiting for card delivery';
      fulfillmentStageDetail = 'Waiting for the card delivery engine to allocate stock.';
    }
  } else if (fulfillmentType === 'direct_charge') {
    if (fulfillmentQueue === 'failed') {
      fulfillmentStage = 'Direct charge failed';
      fulfillmentStageDetail =
        input.directErrorMessage ?? 'The supplier returned a failure response.';
    } else if (fulfillmentQueue === 'manual_review') {
      fulfillmentStage = 'Direct charge needs review';
      fulfillmentStageDetail =
        input.directManualReason ?? input.directErrorMessage ?? 'The direct charge task requires manual follow-up.';
    } else if (fulfillmentQueue === 'success') {
      fulfillmentStage = 'Direct charge completed';
      fulfillmentStageDetail =
        input.directResultDetail ?? 'The supplier callback completed successfully.';
    } else if (fulfillmentQueue === 'processing') {
      fulfillmentStage = 'Supplier processing';
      fulfillmentStageDetail =
        input.directResultDetail ?? 'The direct charge task has been dispatched to the supplier.';
    } else {
      fulfillmentStage = 'Waiting for supplier dispatch';
      fulfillmentStageDetail = 'The direct charge task has not been dispatched yet.';
    }
  } else if (fulfillmentQueue === 'manual_review') {
    fulfillmentStage = 'Waiting for manual review';
    fulfillmentStageDetail = 'This order is not handled by the automated fulfillment pipeline.';
  } else if (fulfillmentQueue === 'success') {
    fulfillmentStage = 'Fulfillment complete';
    fulfillmentStageDetail = 'The order has completed shipment and delivery.';
  } else if (fulfillmentQueue === 'processing') {
    fulfillmentStage = 'Fulfillment processing';
    fulfillmentStageDetail = 'The order is being processed by the fulfillment workflow.';
  }

  return {
    fulfillmentType,
    fulfillmentTypeText: getOrderFulfillmentTypeText(fulfillmentType),
    fulfillmentQueue,
    fulfillmentQueueText: getOrderFulfillmentQueueText(fulfillmentQueue),
    fulfillmentStage,
    fulfillmentStageDetail,
    latestTaskNo: input.directTaskNo ?? null,
    latestSupplierOrderNo: input.directSupplierOrderNo ?? null,
    latestOutboundNo: input.latestOutboundNo ?? null,
    retryCount:
      fulfillmentType === 'direct_charge'
        ? Number(input.directRetryCount ?? 0)
        : Number(input.cardAttemptCount ?? 0),
    maxRetry: fulfillmentType === 'direct_charge' ? Number(input.directMaxRetry ?? 0) : 1,
    manualReason: input.directManualReason ?? null,
    latestLogTitle: input.latestLogTitle ?? null,
    latestLogDetail: input.latestLogDetail ?? null,
    latestLogAt: input.latestLogAt ?? null,
    canRetry:
      fulfillmentType === 'card' || fulfillmentType === 'direct_charge'
        ? ['pending', 'failed', 'manual_review'].includes(fulfillmentQueue)
        : false,
    canResend: fulfillmentType === 'card' && Boolean(input.latestOutboundNo),
    canTerminate: fulfillmentQueue !== 'success' && input.mainStatus !== 'closed',
    canNote: true,
  };
}

export class PostgresBusinessReadAdapter {
  private readonly connectionString: string;
  private readonly pool: pg.Pool;
  private readonly logger = console;

  constructor(connectionString: string) {
    this.connectionString = connectionString;
    this.pool = new Pool({
      connectionString,
      max: 2,
    });
  }

  async close() {
    await this.pool.end();
  }

  private parseStoreTags(tagsText: string) {
    return String(tagsText ?? '')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  }

  private normalizeStoreTags(tags: string[] | string | null | undefined) {
    const raw = Array.isArray(tags) ? tags : typeof tags === 'string' ? tags.split(',') : [];
    return Array.from(new Set(raw.map((item) => item.trim()).filter(Boolean))).join(',');
  }

  private getStoreConnectionStatusText(status: StoreConnectionStatus) {
    return (
      {
        pending_activation: '待激活',
        active: '已激活',
        offline: '掉线',
        abnormal: '异常',
      }[status] ?? status
    );
  }

  private getStoreAuthStatusText(status: StoreAuthStatus | StoreAuthSessionStatus) {
    return (
      {
        authorized: '已授权',
        pending: '待完成',
        completed: '已完成',
        expired: '已过期',
        invalidated: '已失效',
      }[status] ?? status
    );
  }

  private getStoreHealthStatusText(status: StoreHealthStatus) {
    return (
      {
        healthy: '健康',
        warning: '待处理',
        offline: '掉线',
        abnormal: '异常',
        skipped: '已跳过',
      }[status] ?? status
    );
  }

  private getStoreProfileSyncStatusText(status: StoreProfileSyncStatus) {
    return (
      {
        pending: '待同步',
        syncing: '同步中',
        success: '已同步',
        failed: '同步失败',
      }[status] ?? status
    );
  }

  private getStoreCredentialEventTypeText(type: StoreCredentialEventType) {
    return (
      {
        qr_login_started: '扫码登录',
        browser_qr_login_started: '浏览器扫码',
        browser_qr_login_accepted: '浏览器扫码接收',
        credential_captured: '登录态入库',
        profile_synced: '资料同步',
        credential_verified: '登录态校验',
        browser_renewed: '浏览器续登',
        manual_takeover_required: '人工接管',
      }[type] ?? type
    );
  }

  private getStoreCredentialEventStatusText(status: StoreCredentialEventStatus) {
    return (
      {
        info: '已记录',
        success: '成功',
        warning: '待处理',
        error: '失败',
      }[status] ?? status
    );
  }

  private getAiServiceConversationStatusText(status: string) {
    return (
      {
        open: '待 AI 处理',
        pending_manual: '待人工接管',
        manual_active: '人工处理中',
        resolved: '已解决',
        closed: '已关闭',
      }[status] ?? status
    );
  }

  private getAiServiceAiStatusText(status: string) {
    return (
      {
        ready: '待答复',
        auto_replied: 'AI 已回复',
        suggested: '已生成建议',
        manual_only: '仅人工处理',
        disabled: 'AI 已关闭',
      }[status] ?? status
    );
  }

  private getAiServiceRiskLevelText(level: string) {
    return (
      {
        low: '低风险',
        medium: '中风险',
        high: '高风险',
      }[level] ?? level
    );
  }

  private getAiServiceMessageTypeText(senderType: string) {
    return (
      {
        customer: '买家消息',
        seller: '卖家消息',
        ai: 'AI 回复',
        suggestion: 'AI 建议',
        system: '系统提示',
        manual: '人工回复',
      }[senderType] ?? senderType
    );
  }

  private normalizeStoreAuthSessionNextStep(
    value: string | null | undefined,
  ): StoreAuthSessionNextStep | null {
    if (
      value === 'manual_complete' ||
      value === 'wait_provider_callback' ||
      value === 'sync_profile' ||
      value === 'done' ||
      value === 'expired' ||
      value === 'invalidated'
    ) {
      return value;
    }

    return null;
  }

  private getManagedStoreStatusText(status: StoreConnectionStatus, enabled: boolean) {
    if (!enabled) {
      return '已停用';
    }

    return (
      {
        pending_activation: '未激活',
        active: '基础',
        offline: '掉线',
        abnormal: '异常',
      }[status] ?? status
    );
  }

  private maskCardPart(value: string) {
    const trimmed = String(value ?? '').trim();
    if (trimmed.length <= 2) {
      return `${trimmed.slice(0, 1)}***`;
    }
    if (trimmed.length <= 6) {
      return `${trimmed.slice(0, 2)}***${trimmed.slice(-1)}`;
    }
    return `${trimmed.slice(0, 3)}***${trimmed.slice(-2)}`;
  }

  private buildMaskedCardValue(cardNo: string, cardSecret: string) {
    return `${this.maskCardPart(cardNo)} / ${this.maskCardPart(cardSecret)}`;
  }

  private async getCardTypeBase(
    queryable: pg.Pool | pg.PoolClient,
    cardTypeId: number,
  ) {
    const result = await queryable.query(
      `
        SELECT
          id,
          type_name AS "typeName",
          card_prefix AS "cardPrefix",
          password_prefix AS "passwordPrefix",
          separator_text AS "separatorText",
          is_deleted AS "isDeleted"
        FROM card_types
        WHERE id = $1
        LIMIT 1
      `,
      [cardTypeId],
    );
    return result.rows[0] as
      | {
          id: number;
          typeName: string;
          cardPrefix: string;
          passwordPrefix: string;
          separatorText: string;
          isDeleted: number;
        }
      | undefined;
  }

  private async getCardFulfillmentContext(client: pg.PoolClient, orderId: number) {
    const result = await client.query(
      `
        SELECT
          o.id,
          o.order_no AS "orderNo",
          o.product_id AS "productId",
          o.quantity,
          o.paid_at AS "paidAt",
          p.name AS "productName",
          s.name AS "storeName",
          c.name AS "customerName",
          cdi.id AS "deliveryId",
          cdi.enabled AS "deliveryEnabled",
          cdi.status AS "deliveryItemStatus",
          cdi.delivery_policy AS "deliveryPolicy",
          ct.id AS "cardTypeId",
          ct.type_name AS "cardTypeName"
        FROM orders o
        LEFT JOIN products p ON p.id = o.product_id
        LEFT JOIN stores s ON s.id = o.store_id
        LEFT JOIN customers c ON c.id = o.customer_id
        LEFT JOIN card_delivery_items cdi ON cdi.product_id = o.product_id
        LEFT JOIN card_types ct ON ct.id = cdi.card_type_id
        WHERE o.id = $1
      `,
      [orderId],
    );
    return result.rows[0] as
      | {
          id: number;
          orderNo: string;
          productId: number;
          quantity: number;
          paidAt: string | null;
          productName: string | null;
          storeName: string | null;
          customerName: string | null;
          deliveryId: number | null;
          deliveryEnabled: number | null;
          deliveryItemStatus: string | null;
          deliveryPolicy: string | null;
          cardTypeId: number | null;
          cardTypeName: string | null;
        }
      | undefined;
  }

  private async ensureCardDeliveryJobRecord(
    client: pg.PoolClient,
    orderId: number,
    cardTypeId: number,
    jobType: 'auto_fulfill' | 'manual_resend',
    now: string,
  ) {
    const existingResult = await client.query(
      `
        SELECT id
        FROM card_delivery_jobs
        WHERE order_id = $1
          AND job_type = $2
        ORDER BY id DESC
        LIMIT 1
      `,
      [orderId, jobType],
    );
    const existingId = Number(existingResult.rows[0]?.id ?? 0);
    if (existingId > 0) {
      return existingId;
    }

    const nextId = await this.nextTableId(client, 'card_delivery_jobs');
    await client.query(
      `
        INSERT INTO card_delivery_jobs (
          id,
          order_id,
          card_type_id,
          job_type,
          job_status,
          attempt_count,
          created_at,
          updated_at
        ) VALUES (
          $1, $2, $3, $4, 'pending', 0, $5, $5
        )
      `,
      [nextId, orderId, cardTypeId, jobType, now],
    );
    return nextId;
  }

  private generateCardImportLines(
    cardType: {
      cardPrefix: string;
      passwordPrefix: string;
      separatorText: string;
    },
    count = 4,
    includeNoise = true,
  ) {
    const base = Date.now() % 1000000;
    const validLines = Array.from({ length: count }, (_, index) => {
      const cardSerial = String(base + index).padStart(6, '0');
      const secretSerial = String(base + count + index).padStart(6, '0');
      return `${cardType.cardPrefix}${cardSerial}${cardType.separatorText}${cardType.passwordPrefix}${secretSerial}`;
    });

    if (!includeNoise || validLines.length === 0) {
      return validLines;
    }

    return [
      ...validLines,
      validLines[0],
      `${cardType.cardPrefix}${String(base + 99).padStart(6, '0')}`,
      `BAD-${String(base + 199).padStart(6, '0')}`,
    ];
  }

  private parseCardImportLine(
    cardType: {
      id: number;
      typeName: string;
      cardPrefix: string;
      passwordPrefix: string;
      separatorText: string;
    },
    rawLine: string,
  ) {
    const line = rawLine.trim();
    if (!line) {
      return null;
    }

    const separatorToken = `${cardType.separatorText}${cardType.passwordPrefix}`;
    const separatorIndex = line.indexOf(separatorToken, cardType.cardPrefix.length);
    if (separatorIndex <= 0) {
      return null;
    }

    const cardNo = line.slice(0, separatorIndex).trim();
    const cardSecret = line.slice(separatorIndex + cardType.separatorText.length).trim();
    if (!cardNo || !cardSecret) {
      return null;
    }

    if (!cardNo.startsWith(cardType.cardPrefix) || !cardSecret.startsWith(cardType.passwordPrefix)) {
      return null;
    }

    return {
      cardNo,
      cardSecret,
      cardMasked: this.buildMaskedCardValue(cardNo, cardSecret),
    };
  }

  private async syncCardTypeInventorySummary(
    client: pg.PoolClient,
    cardTypeId: number,
    now: string,
  ) {
    const summaryResult = await client.query(
      `
        SELECT
          COUNT(*) AS "totalCount",
          SUM(CASE WHEN item_status = 'available' THEN 1 ELSE 0 END) AS "availableCount",
          SUM(CASE WHEN item_status = 'locked' THEN 1 ELSE 0 END) AS "lockedCount",
          SUM(CASE WHEN item_status = 'sold' THEN 1 ELSE 0 END) AS "soldCount",
          SUM(CASE WHEN item_status = 'disabled' THEN 1 ELSE 0 END) AS "disabledCount"
        FROM card_inventory_items
        WHERE card_type_id = $1
      `,
      [cardTypeId],
    );
    const summary = summaryResult.rows[0] as Record<string, number | null> | undefined;

    await client.query(
      `
        UPDATE card_types
        SET
          unsold_count = $1,
          sold_count = $2,
          total_stock = $3,
          updated_at = $4
        WHERE id = $5
      `,
      [
        Number(summary?.availableCount ?? 0),
        Number(summary?.soldCount ?? 0),
        Number(summary?.totalCount ?? 0),
        now,
        cardTypeId,
      ],
    );

    return {
      totalCount: Number(summary?.totalCount ?? 0),
      availableCount: Number(summary?.availableCount ?? 0),
      lockedCount: Number(summary?.lockedCount ?? 0),
      soldCount: Number(summary?.soldCount ?? 0),
      disabledCount: Number(summary?.disabledCount ?? 0),
    };
  }

  private async refreshCardStockAlert(
    client: pg.PoolClient,
    cardTypeId: number,
    now: string,
  ) {
    const cardType = await this.getCardTypeBase(client, cardTypeId);
    if (!cardType) {
      return null;
    }

    const summary = await this.syncCardTypeInventorySummary(client, cardTypeId, now);
    const thresholdValue = 5;
    const status = summary.availableCount <= thresholdValue ? 'open' : 'resolved';
    const detail =
      status === 'open'
        ? `${cardType.typeName} available stock is down to ${summary.availableCount}, below threshold ${thresholdValue}.`
        : `${cardType.typeName} stock recovered to ${summary.availableCount}.`;

    await client.query(
      `
        INSERT INTO card_stock_alerts (
          card_type_id,
          alert_level,
          threshold_value,
          current_stock,
          status,
          detail,
          created_at,
          updated_at
        )
        VALUES ($1, 'low_stock', $2, $3, $4, $5, $6, $6)
        ON CONFLICT (card_type_id) DO UPDATE SET
          alert_level = EXCLUDED.alert_level,
          threshold_value = EXCLUDED.threshold_value,
          current_stock = EXCLUDED.current_stock,
          status = EXCLUDED.status,
          detail = EXCLUDED.detail,
          updated_at = EXCLUDED.updated_at
      `,
      [cardTypeId, thresholdValue, summary.availableCount, status, detail, now],
    );

    return { ...summary, status, detail };
  }

  private async markManagedStoreBusinessSyncHealthy(
    client: pg.PoolClient,
    storeId: number,
    input: {
      detail: string;
      verifiedAt: string;
    },
  ) {
    await client.query(
      `
        UPDATE store_platform_credentials
        SET
          risk_level = 'healthy',
          risk_reason = $1,
          verification_url = NULL,
          last_verified_at = $2,
          updated_at = $2
        WHERE store_id = $3
          AND credential_type = 'web_session'
      `,
      [input.detail, input.verifiedAt, storeId],
    );

    await client.query(
      `
        UPDATE managed_stores
        SET
          connection_status = 'active',
          activation_status = 'active',
          auth_status = 'authorized',
          health_status = 'healthy',
          last_health_check_at = $1,
          last_health_check_detail = $2,
          last_verified_at = $1,
          status_text = $3,
          last_sync_at = $1,
          updated_at = $1
        WHERE id = $4
      `,
      [input.verifiedAt, input.detail, this.getManagedStoreStatusText('active', true), storeId],
    );
  }

  private getStoreAuthSessionStepInfo(input: {
    status: StoreAuthSessionStatus;
    integrationMode: StoreAuthIntegrationMode;
    nextStep?: string | null;
    profileSyncStatus?: StoreProfileSyncStatus | null;
    profileSyncError?: string | null;
    providerAccessTokenReceivedAt?: string | null;
    invalidReason?: string | null;
  }): StoreAuthSessionStepInfo {
    if (input.status === 'completed') {
      return {
        nextStepKey: 'done',
        nextStepText: '已完成资料补齐与绑店。',
      };
    }

    if (input.status === 'expired') {
      return {
        nextStepKey: 'expired',
        nextStepText: '授权会话已过期，需要重新发起授权。',
      };
    }

    if (input.status === 'invalidated') {
      return {
        nextStepKey: 'invalidated',
        nextStepText: input.invalidReason?.trim() || '授权会话已失效。',
      };
    }

    const explicitNextStep = this.normalizeStoreAuthSessionNextStep(input.nextStep);
    if (explicitNextStep === 'sync_profile') {
      if (input.profileSyncStatus === 'failed' && input.profileSyncError?.trim()) {
        return {
          nextStepKey: 'sync_profile',
          nextStepText: `资料同步失败：${input.profileSyncError.trim()}`,
        };
      }

      if (input.profileSyncStatus === 'syncing') {
        return {
          nextStepKey: 'sync_profile',
          nextStepText: '正在同步卖家与店铺资料，请稍后刷新。',
        };
      }

      return {
        nextStepKey: 'sync_profile',
        nextStepText: '已接收官方回调，待换取店铺资料并完成绑店。',
      };
    }

    if (explicitNextStep) {
      return this.getStoreAuthSessionStepInfo({
        ...input,
        nextStep: null,
        status:
          explicitNextStep === 'done'
            ? 'completed'
            : explicitNextStep === 'expired'
              ? 'expired'
              : explicitNextStep === 'invalidated'
                ? 'invalidated'
                : input.status,
      });
    }

    if (input.integrationMode === 'xianyu_browser_oauth') {
      if (input.providerAccessTokenReceivedAt) {
        return {
          nextStepKey: 'sync_profile',
          nextStepText: '已接收官方回调，待换取店铺资料并完成绑店。',
        };
      }

      return {
        nextStepKey: 'wait_provider_callback',
        nextStepText: '等待跳转到闲鱼授权页面并接收官方回调。',
      };
    }

    if (input.integrationMode === 'xianyu_web_session') {
      if (input.providerAccessTokenReceivedAt) {
        return {
          nextStepKey: 'sync_profile',
          nextStepText: '已录入网页登录态，待补齐卖家与店铺资料。',
        };
      }

      return {
        nextStepKey: 'manual_complete',
        nextStepText: '等待录入网页登录态与店铺资料，并完成绑店。',
      };
    }

    return {
      nextStepKey: 'manual_complete',
      nextStepText: '等待站内补全账号资料并完成建店。',
    };
  }

  private async getStoreAuthCallbackSigningSecret() {
    const result = await this.pool.query(
      `
        SELECT value_encrypted AS "valueEncrypted"
        FROM secure_settings
        WHERE key = 'xianyu_callback_secret'
        LIMIT 1
      `,
    );
    const row = result.rows[0] as { valueEncrypted?: string } | undefined;
    if (!row?.valueEncrypted) {
      return appConfig.secureConfigSecret;
    }

    try {
      return decryptSecret(String(row.valueEncrypted), appConfig.secureConfigSecret);
    } catch {
      return appConfig.secureConfigSecret;
    }
  }

  private getStoreAuthPermissions(platform: StorePlatform) {
    if (platform === 'xianyu') {
      return [
        'Read login and user-profile information',
        'Read and update store product data',
        'Read activity participation and publish-limit rules',
      ];
    }

    return [
      'Read login and user-profile information',
      'Read Taobao store product data',
      'Read required seller order and inventory data',
    ];
  }

  private redactStoreAuthPayloadText(rawText: string | null | undefined) {
    const trimmed = rawText?.trim() ?? '';
    if (!trimmed) {
      return null;
    }

    return {
      rawLength: trimmed.length,
      rawSha256: createHash('sha256').update(trimmed).digest('hex').slice(0, 24),
    };
  }

  private buildStoreAuthPayloadSummary(input: {
    payloadType: 'provider_callback' | 'web_session_capture';
    capturedAt: string;
    maskedValue?: string | null;
    rawText?: string | null;
    tokenType?: string | null;
    expiresAt?: string | null;
    credentialSource?: string | null;
    riskLevel?: StoreCredentialRiskLevel | null;
    verificationUrl?: string | null;
    note?: string | null;
  }) {
    const summary: Record<string, string | number> = {
      payloadType: input.payloadType,
      capturedAt: input.capturedAt,
    };

    if (input.maskedValue?.trim()) {
      summary.maskedValue = input.maskedValue.trim();
    }
    if (input.tokenType?.trim()) {
      summary.tokenType = input.tokenType.trim();
    }
    if (input.expiresAt?.trim()) {
      summary.expiresAt = input.expiresAt.trim();
    }
    if (input.credentialSource?.trim()) {
      summary.credentialSource = input.credentialSource.trim();
    }
    if (input.riskLevel?.trim()) {
      summary.riskLevel = input.riskLevel.trim();
    }
    if (input.verificationUrl?.trim()) {
      summary.verificationUrl = input.verificationUrl.trim();
    }
    if (input.note?.trim()) {
      summary.note = input.note.trim();
    }

    const redactedPayload = this.redactStoreAuthPayloadText(input.rawText);
    if (redactedPayload) {
      summary.rawLength = redactedPayload.rawLength;
      summary.rawSha256 = redactedPayload.rawSha256;
    }

    return JSON.stringify(summary, null, 2);
  }

  private async deleteScopedStoreCredential(
    queryable: pg.Pool | pg.PoolClient,
    input: {
      sessionId: string;
      platform: StorePlatform;
      providerKey: string;
      credentialType: 'access_token' | 'web_session';
      storeId: number | null;
      ownerAccountId: number | null;
      keepCredentialId?: number | null;
    },
  ) {
    const keepCredentialId = input.keepCredentialId ?? null;
    await queryable.query(
      `
        DELETE FROM store_platform_credentials
        WHERE platform = $1
          AND provider_key = $2
          AND credential_type = $3
          AND session_id = $4
          AND ($5::int IS NULL OR id <> $5)
      `,
      [input.platform, input.providerKey, input.credentialType, input.sessionId, keepCredentialId],
    );

    if (input.storeId !== null) {
      await queryable.query(
        `
          DELETE FROM store_platform_credentials
          WHERE platform = $1
            AND provider_key = $2
            AND credential_type = $3
            AND store_id = $4
            AND (session_id IS NULL OR session_id <> $5)
            AND ($6::int IS NULL OR id <> $6)
        `,
        [
          input.platform,
          input.providerKey,
          input.credentialType,
          input.storeId,
          input.sessionId,
          keepCredentialId,
        ],
      );
      return;
    }

    if (input.ownerAccountId !== null) {
      await queryable.query(
        `
          DELETE FROM store_platform_credentials
          WHERE platform = $1
            AND provider_key = $2
            AND credential_type = $3
            AND store_id IS NULL
            AND owner_account_id = $4
            AND (session_id IS NULL OR session_id <> $5)
            AND ($6::int IS NULL OR id <> $6)
        `,
        [
          input.platform,
          input.providerKey,
          input.credentialType,
          input.ownerAccountId,
          input.sessionId,
          keepCredentialId,
        ],
      );
    }
  }

  private async getStoreCredentialBySessionId(
    queryable: pg.Pool | pg.PoolClient,
    sessionId: string,
  ) {
    const result = await queryable.query(
      `
        SELECT
          id,
          platform,
          store_id AS "storeId",
          owner_account_id AS "ownerAccountId",
          provider_key AS "providerKey",
          credential_type AS "credentialType",
          access_token_masked AS "accessTokenMasked",
          expires_at AS "expiresAt",
          provider_user_id AS "providerUserId",
          provider_shop_id AS "providerShopId",
          provider_shop_name AS "providerShopName",
          scope_text AS "scopeText"
        FROM store_platform_credentials
        WHERE session_id = $1
        ORDER BY id DESC
        LIMIT 1
      `,
      [sessionId],
    );
    return result.rows[0] as
      | {
          id: number;
          platform: StorePlatform;
          storeId: number | null;
          ownerAccountId: number | null;
          providerKey: string;
          credentialType: string;
          accessTokenMasked: string | null;
          expiresAt: string | null;
          providerUserId: string | null;
          providerShopId: string | null;
          providerShopName: string | null;
          scopeText: string | null;
        }
      | undefined;
  }

  private async recordStoreCredentialEvent(
    queryable: pg.Pool | pg.PoolClient,
    input: {
      storeId?: number | null;
      sessionId?: string | null;
      credentialId?: number | null;
      eventType: StoreCredentialEventType;
      status: StoreCredentialEventStatus;
      detail: string;
      source?: string | null;
      riskLevel?: StoreCredentialRiskLevel | null;
      verificationUrl?: string | null;
      operatorUserId?: number | null;
    },
  ) {
    const createdAt = format(new Date(), 'yyyy-MM-dd HH:mm:ss');
    const nextId = await this.nextTableId(queryable, 'store_credential_events');
    await queryable.query(
      `
        INSERT INTO store_credential_events (
          id,
          store_id,
          session_id,
          credential_id,
          event_type,
          status,
          detail,
          source,
          risk_level,
          verification_url,
          operator_user_id,
          created_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12
        )
      `,
      [
        nextId,
        input.storeId ?? null,
        input.sessionId ?? null,
        input.credentialId ?? null,
        input.eventType,
        input.status,
        input.detail.trim(),
        input.source?.trim() || null,
        input.riskLevel ?? null,
        input.verificationUrl?.trim() || null,
        input.operatorUserId ?? null,
        createdAt,
      ],
    );

    return {
      eventType: input.eventType,
      status: input.status,
      detail: input.detail.trim(),
      createdAt,
    };
  }

  async recordStoreCredentialEventEntry(input: {
    storeId?: number | null;
    sessionId?: string | null;
    credentialId?: number | null;
    eventType: StoreCredentialEventType;
    status: StoreCredentialEventStatus;
    detail: string;
    source?: string | null;
    riskLevel?: StoreCredentialRiskLevel | null;
    verificationUrl?: string | null;
    operatorUserId?: number | null;
  }) {
    return this.recordStoreCredentialEvent(this.pool, input);
  }

  private async deleteManagedStoreXianyuImAuthCache(
    queryable: pg.Pool | pg.PoolClient,
    storeId: number,
  ) {
    await queryable.query('DELETE FROM xianyu_im_session_auth_cache WHERE store_id = $1', [storeId]);
  }

  private async getManagedStoreCredentialContext(
    queryable: pg.Pool | pg.PoolClient,
    storeId: number,
  ) {
    const result = await queryable.query(
      `
        SELECT
          ms.id AS "storeId",
          ms.platform,
          ms.shop_name AS "shopName",
          ms.enabled,
          ms.connection_status AS "connectionStatus",
          COALESCE(spc.provider_user_id, ms.provider_user_id) AS "providerUserId",
          ms.credential_id AS "credentialId",
          spc.credential_type AS "credentialType",
          spc.access_token_encrypted AS "accessTokenEncrypted"
        FROM managed_stores ms
        LEFT JOIN store_platform_credentials spc ON spc.id = ms.credential_id
        WHERE ms.id = $1
        LIMIT 1
      `,
      [storeId],
    );
    return result.rows[0] as
      | {
          storeId: number;
          platform: StorePlatform;
          shopName: string;
          enabled: number;
          connectionStatus: StoreConnectionStatus;
          providerUserId: string | null;
          credentialId: number | null;
          credentialType: string | null;
          accessTokenEncrypted: string | null;
        }
      | undefined;
  }

  private async upsertStoreOwnerAccount(
    queryable: pg.Pool | pg.PoolClient,
    input: {
      accountId?: number | null;
      platform: StorePlatform;
      ownerName: string;
      mobile: string;
      loginMode: 'sms' | 'password' | 'oauth' | 'cookie';
      authorizedByUserId: number | null;
    },
  ) {
    const now = format(new Date(), 'yyyy-MM-dd HH:mm:ss');
    let accountId: number | null = null;

    if (input.accountId) {
      const existingById = await queryable.query(
        'SELECT id FROM store_owner_accounts WHERE id = $1 LIMIT 1',
        [input.accountId],
      );
      accountId = existingById.rows[0]?.id ? Number(existingById.rows[0].id) : null;
    }

    if (!accountId) {
      const existingByMobile = await queryable.query(
        `
          SELECT id
          FROM store_owner_accounts
          WHERE platform = $1 AND mobile = $2
          ORDER BY id DESC
          LIMIT 1
        `,
        [input.platform, input.mobile],
      );
      accountId = existingByMobile.rows[0]?.id ? Number(existingByMobile.rows[0].id) : null;
    }

    if (accountId) {
      await queryable.query(
        `
          UPDATE store_owner_accounts
          SET
            owner_name = $1,
            mobile = $2,
            login_mode = $3,
            account_status = 'active',
            last_authorized_at = $4,
            last_authorized_by = $5,
            updated_at = $4
          WHERE id = $6
        `,
        [input.ownerName, input.mobile, input.loginMode, now, input.authorizedByUserId, accountId],
      );
      return accountId;
    }

    const nextId = await this.nextTableId(queryable, 'store_owner_accounts');
    await queryable.query(
      `
        INSERT INTO store_owner_accounts (
          id,
          platform,
          owner_name,
          mobile,
          login_mode,
          account_status,
          last_authorized_at,
          last_authorized_by,
          created_at,
          updated_at
        ) VALUES (
          $1, $2, $3, $4, $5, 'active', $6, $7, $6, $6
        )
      `,
      [
        nextId,
        input.platform,
        input.ownerName,
        input.mobile,
        input.loginMode,
        now,
        input.authorizedByUserId,
      ],
    );
    return nextId;
  }

  private async bindStoreCredentialEventsToStore(
    queryable: pg.Pool | pg.PoolClient,
    sessionId: string,
    input: { storeId: number; credentialId?: number | null },
  ) {
    await queryable.query(
      `
        UPDATE store_credential_events
        SET
          store_id = $1,
          credential_id = COALESCE(credential_id, $2)
        WHERE session_id = $3
      `,
      [input.storeId, input.credentialId ?? null, sessionId],
    );
  }

  private async findManagedStoreByProviderShopId(
    queryable: pg.Pool | pg.PoolClient,
    platform: StorePlatform,
    providerShopId: string,
  ) {
    const result = await queryable.query(
      `
        SELECT
          id,
          seller_no AS "sellerNo",
          connection_status AS "connectionStatus",
          enabled
        FROM managed_stores
        WHERE platform = $1 AND provider_store_id = $2
        LIMIT 1
      `,
      [platform, providerShopId],
    );
    return result.rows[0] as
      | {
          id: number;
          sellerNo: string;
          connectionStatus: StoreConnectionStatus;
          enabled: number;
        }
      | undefined;
  }

  private async buildSellerNo(
    queryable: pg.Pool | pg.PoolClient,
    platform: StorePlatform,
  ) {
    const prefix = platform === 'xianyu' ? 'xy' : 'tb';
    const result = await queryable.query(
      `
        SELECT seller_no AS "sellerNo"
        FROM managed_stores
        WHERE platform = $1
        ORDER BY id DESC
        LIMIT 1
      `,
      [platform],
    );
    const latest = result.rows[0] as { sellerNo: string } | undefined;
    const baseNumber = latest
      ? Number(String(latest.sellerNo ?? '').replace(/\D/g, '').slice(-12))
      : platform === 'xianyu'
        ? 560104526732
        : 839104223301;
    return `${prefix}${String(baseNumber + 108244).padStart(12, '0')}`;
  }

  private async listManagedStores() {
    const result = await this.pool.query(
      `
        SELECT
          ms.id,
          ms.platform,
          ms.shop_type_label AS "shopTypeLabel",
          ms.shop_name AS "shopName",
          ms.seller_no AS "sellerNo",
          ms.nickname,
          ms.status_text AS "statusText",
          ms.activation_status AS "activationStatus",
          ms.package_text AS "packageText",
          ms.publish_limit_text AS "publishLimitText",
          ms.created_at AS "createdAt",
          ms.updated_at AS "updatedAt",
          ms.owner_account_id AS "ownerAccountId",
          oa.owner_name AS "ownerAccountName",
          oa.mobile AS "ownerMobile",
          ms.created_by_user_id AS "createdByUserId",
          u.display_name AS "createdByName",
          ms.group_name AS "groupName",
          ms.tags_text AS "tagsText",
          ms.remark,
          ms.enabled,
          ms.connection_status AS "connectionStatus",
          ms.auth_status AS "authStatus",
          ms.auth_expires_at AS "authExpiresAt",
          ms.last_sync_at AS "lastSyncAt",
          ms.health_status AS "healthStatus",
          ms.last_health_check_at AS "lastHealthCheckAt",
          ms.last_health_check_detail AS "lastHealthCheckDetail",
          ms.last_session_id AS "lastSessionId",
          ms.last_reauthorize_at AS "lastReauthorizeAt",
          ms.provider_store_id AS "providerStoreId",
          ms.provider_user_id AS "providerUserId",
          ms.credential_id AS "credentialId",
          spc.credential_type AS "credentialType",
          spc.credential_source AS "credentialSource",
          spc.risk_level AS "credentialRiskLevel",
          spc.risk_reason AS "credentialRiskReason",
          spc.verification_url AS "credentialVerificationUrl",
          spc.last_renewed_at AS "lastCredentialRenewAt",
          spc.last_renew_status AS "lastCredentialRenewStatus",
          ms.profile_sync_status AS "profileSyncStatus",
          ms.profile_sync_error AS "profileSyncError",
          ms.last_profile_sync_at AS "lastProfileSyncAt",
          ms.last_verified_at AS "lastVerifiedAt"
        FROM managed_stores ms
        LEFT JOIN store_owner_accounts oa ON oa.id = ms.owner_account_id
        LEFT JOIN users u ON u.id = ms.created_by_user_id
        LEFT JOIN store_platform_credentials spc ON spc.id = ms.credential_id
        ORDER BY ms.updated_at DESC, ms.id DESC
      `,
    );
    const rows = result.rows as ManagedStoreRecord[];

    return rows.map((row) => {
      const enabled = Boolean(row.enabled);
      const connectionStatus = row.connectionStatus;
      const authStatus = row.authStatus;
      const healthStatus = row.healthStatus;

      return {
        ...row,
        enabled,
        scheduleStatus: enabled ? ('running' as const) : ('paused' as const),
        connectionStatus,
        connectionStatusText: this.getStoreConnectionStatusText(connectionStatus),
        authStatus,
        authStatusText: this.getStoreAuthStatusText(authStatus),
        healthStatus,
        healthStatusText: this.getStoreHealthStatusText(healthStatus),
        profileSyncStatusText: this.getStoreProfileSyncStatusText(row.profileSyncStatus),
        statusText: this.getManagedStoreStatusText(connectionStatus, enabled),
        activationStatus: connectionStatus,
        tags: this.parseStoreTags(row.tagsText),
        activationHint:
          connectionStatus === 'pending_activation' ? '授权已完成，激活后才会进入正式调度。' : null,
      };
    });
  }

  private async listStoreAuthSessions(limit = 24) {
    const result = await this.pool.query(
      `
        SELECT
          sas.session_id AS "sessionId",
          sas.platform,
          sas.source,
          sas.auth_type AS "authType",
          sas.status,
          sas.integration_mode AS "integrationMode",
          sas.provider_label AS "providerLabel",
          sas.next_step AS "nextStep",
          sas.profile_sync_status AS "profileSyncStatus",
          sas.profile_sync_error AS "profileSyncError",
          sas.created_at AS "createdAt",
          sas.expires_at AS "expiresAt",
          sas.completed_at AS "completedAt",
          sas.invalid_reason AS "invalidReason",
          sas.provider_access_token_received_at AS "providerAccessTokenReceivedAt",
          sas.store_id AS "storeId",
          sas.owner_account_id AS "ownerAccountId",
          sas.mobile,
          sas.nickname,
          sas.reauthorize,
          ms.shop_name AS "storeName",
          oa.owner_name AS "ownerAccountName",
          u.display_name AS "createdByName"
        FROM store_auth_sessions sas
        LEFT JOIN managed_stores ms ON ms.id = sas.store_id
        LEFT JOIN store_owner_accounts oa ON oa.id = sas.owner_account_id
        LEFT JOIN users u ON u.id = sas.created_by_user_id
        ORDER BY sas.created_at DESC, sas.session_id DESC
        LIMIT $1
      `,
      [limit],
    );
    const rows = result.rows as Array<{
      sessionId: string;
      platform: StorePlatform;
      source: string;
      authType: number;
      status: StoreAuthSessionStatus;
      integrationMode: StoreAuthIntegrationMode;
      providerLabel: string | null;
      nextStep: string | null;
      profileSyncStatus: StoreProfileSyncStatus;
      profileSyncError: string | null;
      createdAt: string;
      expiresAt: string | null;
      completedAt: string | null;
      invalidReason: string | null;
      providerAccessTokenReceivedAt: string | null;
      storeId: number | null;
      ownerAccountId: number | null;
      mobile: string | null;
      nickname: string | null;
      reauthorize: number;
      storeName: string | null;
      ownerAccountName: string | null;
      createdByName: string | null;
    }>;

    return rows.map((row) => ({
      ...row,
      reauthorize: Boolean(row.reauthorize),
      statusText: this.getStoreAuthStatusText(row.status),
      tokenReceived: Boolean(row.providerAccessTokenReceivedAt),
      ...this.getStoreAuthSessionStepInfo({
        status: row.status,
        integrationMode: row.integrationMode,
        nextStep: row.nextStep,
        profileSyncStatus: row.profileSyncStatus,
        profileSyncError: row.profileSyncError,
        providerAccessTokenReceivedAt: row.providerAccessTokenReceivedAt,
        invalidReason: row.invalidReason,
      }),
    }));
  }

  private async listStoreHealthChecks(limit = 24) {
    const result = await this.pool.query(
      `
        SELECT
          shc.id,
          shc.store_id AS "storeId",
          ms.shop_name AS "storeName",
          shc.status,
          shc.detail,
          shc.checked_at AS "checkedAt",
          shc.trigger_mode AS "triggerMode",
          u.display_name AS "triggeredByName"
        FROM store_health_checks shc
        LEFT JOIN managed_stores ms ON ms.id = shc.store_id
        LEFT JOIN users u ON u.id = shc.triggered_by_user_id
        ORDER BY shc.checked_at DESC, shc.id DESC
        LIMIT $1
      `,
      [limit],
    );
    const rows = result.rows as Array<{
      id: number;
      storeId: number;
      storeName: string | null;
      status: StoreHealthStatus;
      detail: string;
      checkedAt: string;
      triggerMode: string;
      triggeredByName: string | null;
    }>;

    return rows.map((row) => ({
      ...row,
      statusText: this.getStoreHealthStatusText(row.status),
    }));
  }

  async getStoreManagementOverview(): Promise<StoreManagementOverview> {
    const [profileResult, fallbackAdminResult, stores, authSessions, healthChecks] = await Promise.all([
      this.pool.query(
        `
          SELECT
            display_name AS "displayName",
            mobile,
            updated_at AS "updatedAt"
          FROM store_operator_profile
          ORDER BY id
          LIMIT 1
        `,
      ),
      this.pool.query(
        `
          SELECT display_name AS "displayName"
          FROM users
          WHERE role = 'admin'
          ORDER BY id
          LIMIT 1
        `,
      ),
      this.listManagedStores(),
      this.listStoreAuthSessions(),
      this.listStoreHealthChecks(),
    ]);
    const profile = profileResult.rows[0] as
      | {
          displayName: string;
          mobile: string;
          updatedAt: string;
        }
      | undefined;
    const fallbackAdmin = fallbackAdminResult.rows[0] as { displayName: string } | undefined;
    const xianyuStores = stores.filter((store) => store.platform === 'xianyu');
    const taobaoStores = stores.filter((store) => store.platform === 'taobao');
    const groups = Array.from(
      stores.reduce((accumulator, store) => {
        const count = accumulator.get(store.groupName) ?? 0;
        accumulator.set(store.groupName, count + 1);
        return accumulator;
      }, new Map<string, number>()),
    )
      .map(([name, count]) => ({ name, count }))
      .sort((left, right) => right.count - left.count || left.name.localeCompare(right.name, 'zh-CN'));
    const groupInsights = Array.from(
      stores.reduce((accumulator, store) => {
        const current = accumulator.get(store.groupName) ?? {
          name: store.groupName,
          count: 0,
          activeCount: 0,
          riskCount: 0,
          offlineCount: 0,
        };
        current.count += 1;
        if (store.connectionStatus === 'active') {
          current.activeCount += 1;
        }
        if (store.connectionStatus === 'offline') {
          current.offlineCount += 1;
        }
        if (
          store.connectionStatus !== 'active' ||
          store.healthStatus === 'warning' ||
          store.healthStatus === 'abnormal' ||
          store.credentialRiskLevel === 'warning' ||
          store.credentialRiskLevel === 'offline' ||
          store.credentialRiskLevel === 'abnormal'
        ) {
          current.riskCount += 1;
        }
        accumulator.set(store.groupName, current);
        return accumulator;
      }, new Map<string, { name: string; count: number; activeCount: number; riskCount: number; offlineCount: number }>()),
    )
      .map(([, row]) => row)
      .sort((left, right) => right.riskCount - left.riskCount || right.count - left.count);
    const ownerInsights = Array.from(
      stores.reduce((accumulator, store) => {
        const ownerName = store.ownerAccountName?.trim() || '未分配负责人';
        const current = accumulator.get(ownerName) ?? {
          ownerName,
          storeCount: 0,
          activeCount: 0,
          riskCount: 0,
          groups: new Set<string>(),
        };
        current.storeCount += 1;
        if (store.connectionStatus === 'active') {
          current.activeCount += 1;
        }
        if (
          store.connectionStatus !== 'active' ||
          store.healthStatus === 'warning' ||
          store.healthStatus === 'abnormal' ||
          store.credentialRiskLevel === 'warning' ||
          store.credentialRiskLevel === 'offline' ||
          store.credentialRiskLevel === 'abnormal'
        ) {
          current.riskCount += 1;
        }
        current.groups.add(store.groupName);
        accumulator.set(ownerName, current);
        return accumulator;
      }, new Map<string, { ownerName: string; storeCount: number; activeCount: number; riskCount: number; groups: Set<string> }>()),
    )
      .map(([, row]) => ({
        ...row,
        groups: [...row.groups].sort((left, right) => left.localeCompare(right, 'zh-CN')),
      }))
      .sort((left, right) => right.riskCount - left.riskCount || right.storeCount - left.storeCount);
    const riskStores = stores
      .filter(
        (store) =>
          store.connectionStatus !== 'active' ||
          store.healthStatus === 'warning' ||
          store.healthStatus === 'abnormal' ||
          store.credentialRiskLevel === 'warning' ||
          store.credentialRiskLevel === 'offline' ||
          store.credentialRiskLevel === 'abnormal',
      )
      .slice(0, 12)
      .map((store) => ({
        id: store.id,
        shopName: store.shopName,
        platform: store.platform,
        groupName: store.groupName,
        ownerAccountName: store.ownerAccountName,
        connectionStatus: store.connectionStatus,
        connectionStatusText: store.connectionStatusText,
        healthStatus: store.healthStatus,
        healthStatusText: store.healthStatusText,
        credentialRiskLevel: store.credentialRiskLevel,
      }));

    return {
      profile: profile ?? {
        displayName: fallbackAdmin?.displayName ?? '系统管理员',
        mobile: '未配置',
        updatedAt: format(new Date(), 'yyyy-MM-dd HH:mm:ss'),
      },
      actions: [
        { key: 'xianyu', label: '创建闲鱼店铺', description: '发起新的闲鱼官方授权会话。' },
        { key: 'taobao', label: '创建淘宝店铺', description: '发起新的淘宝授权会话。' },
        { key: 'reauthorize', label: '重新授权', description: '针对掉线、过期、异常店铺重新建立授权。' },
        { key: 'batch-health-check', label: '批量体检', description: '对已启用店铺执行健康检查。' },
      ],
      stores,
      xianyuStores,
      taobaoStores,
      authSessions,
      healthChecks,
      groups,
      groupInsights,
      ownerInsights,
      riskStores,
      summaries: {
        totalStoreCount: stores.length,
        xianyuStoreCount: xianyuStores.length,
        taobaoStoreCount: taobaoStores.length,
        enabledStoreCount: stores.filter((store) => store.enabled).length,
        disabledStoreCount: stores.filter((store) => !store.enabled).length,
        pendingActivationCount: xianyuStores.filter(
          (item) => item.connectionStatus === 'pending_activation',
        ).length,
        activeStoreCount: stores.filter((item) => item.connectionStatus === 'active').length,
        offlineStoreCount: stores.filter((item) => item.connectionStatus === 'offline').length,
        abnormalStoreCount: stores.filter((item) => item.connectionStatus === 'abnormal').length,
        pendingSessionCount: authSessions.filter((session) => session.status === 'pending').length,
        expiredSessionCount: authSessions.filter((session) => session.status === 'expired').length,
        invalidatedSessionCount: authSessions.filter((session) => session.status === 'invalidated')
          .length,
      },
      serviceCards: [
        {
          key: 'sessions',
          title: '授权会话',
          actionLabel: '查看记录',
          description: '支持待完成、已完成、已过期、已失效四类授权状态和重新授权链路。',
        },
        {
          key: 'health',
          title: '健康检查',
          actionLabel: '执行体检',
          description: '支持单店与批量健康检查，掉线和异常状态单独区分。',
        },
        {
          key: 'batch',
          title: '批量管理',
          actionLabel: '批量操作',
          description: '支持批量启用、停用和批量体检，停用店铺会暂停调度。',
        },
      ],
    };
  }

  async getStoreAuthSessionDetail(sessionId: string): Promise<StoreAuthSessionDetail> {
    const result = await this.pool.query(
      `
        SELECT
          sas.session_id AS "sessionId",
          sas.platform,
          sas.source,
          sas.auth_type AS "authType",
          sas.status,
          sas.created_at AS "createdAt",
          sas.expires_at AS "expiresAt",
          sas.completed_at AS "completedAt",
          sas.invalid_reason AS "invalidReason",
          sas.store_id AS "storeId",
          sas.owner_account_id AS "ownerAccountId",
          sas.created_by_user_id AS "createdByUserId",
          sas.reauthorize,
          sas.integration_mode AS "integrationMode",
          sas.provider_key AS "providerKey",
          sas.provider_label AS "providerLabel",
          sas.provider_state AS "providerState",
          sas.provider_auth_url AS "providerAuthUrl",
          sas.callback_url AS "callbackUrl",
          sas.provider_access_token_masked AS "providerAccessTokenMasked",
          sas.provider_access_token_received_at AS "providerAccessTokenReceivedAt",
          sas.next_step AS "nextStep",
          sas.callback_received_at AS "callbackReceivedAt",
          sas.profile_sync_status AS "profileSyncStatus",
          sas.profile_sync_error AS "profileSyncError",
          sas.profile_synced_at AS "profileSyncedAt",
          sas.mobile,
          sas.nickname,
          spc.provider_user_id AS "providerUserId",
          spc.provider_shop_id AS "providerShopId",
          spc.provider_shop_name AS "providerShopName",
          spc.scope_text AS "scopeText"
        FROM store_auth_sessions sas
        LEFT JOIN store_platform_credentials spc ON spc.session_id = sas.session_id
        WHERE sas.session_id = $1
        ORDER BY spc.id DESC NULLS LAST
        LIMIT 1
      `,
      [sessionId],
    );
    const session = result.rows[0] as
      | {
          sessionId: string;
          platform: StorePlatform;
          source: string;
          authType: number;
          status: StoreAuthSessionStatus;
          createdAt: string;
          expiresAt: string | null;
          completedAt: string | null;
          invalidReason: string | null;
          storeId: number | null;
          ownerAccountId: number | null;
          createdByUserId: number | null;
          reauthorize: number;
          integrationMode: StoreAuthIntegrationMode;
          providerKey: string | null;
          providerLabel: string | null;
          providerState: string | null;
          providerAuthUrl: string | null;
          callbackUrl: string | null;
          providerAccessTokenMasked: string | null;
          providerAccessTokenReceivedAt: string | null;
          nextStep: string | null;
          callbackReceivedAt: string | null;
          profileSyncStatus: StoreProfileSyncStatus;
          profileSyncError: string | null;
          profileSyncedAt: string | null;
          mobile: string | null;
          nickname: string | null;
          providerUserId: string | null;
          providerShopId: string | null;
          providerShopName: string | null;
          scopeText: string | null;
        }
      | undefined;

    if (!session) {
      return null;
    }

    const providerPlan = resolveStoreAuthProviderPlan(appConfig, {
      platform: session.platform,
      sessionId: session.sessionId,
      reauthorize: Boolean(session.reauthorize),
      providerState: session.providerState,
      signingSecret: await this.getStoreAuthCallbackSigningSecret(),
    });
    const stepInfo = this.getStoreAuthSessionStepInfo({
      status: session.status,
      integrationMode: session.integrationMode,
      nextStep: session.nextStep,
      profileSyncStatus: session.profileSyncStatus,
      profileSyncError: session.profileSyncError,
      providerAccessTokenReceivedAt: session.providerAccessTokenReceivedAt,
      invalidReason: session.invalidReason,
    });

    return {
      ...session,
      reauthorize: Boolean(session.reauthorize),
      providerConfigured: providerPlan.providerConfigured,
      authorizeUrl: session.providerAuthUrl ?? providerPlan.authorizeUrl,
      callbackPath: providerPlan.callbackPath,
      callbackUrl: session.callbackUrl ?? providerPlan.callbackUrl,
      requiresBrowserCallback: providerPlan.requiresBrowserCallback,
      instructions: providerPlan.instructions,
      tokenReceived: Boolean(session.providerAccessTokenReceivedAt),
      profileSyncStatusText: this.getStoreProfileSyncStatusText(session.profileSyncStatus),
      ...stepInfo,
    };
  }

  async getStoreAuthSessionWebSessionCredential(sessionId: string) {
    const result = await this.pool.query(
      `
        SELECT
          sas.session_id AS "sessionId",
          sas.platform,
          sas.store_id AS "storeId",
          spc.id AS "credentialId",
          spc.credential_type AS "credentialType",
          spc.access_token_encrypted AS "accessTokenEncrypted"
        FROM store_auth_sessions sas
        LEFT JOIN store_platform_credentials spc ON spc.session_id = sas.session_id
        WHERE sas.session_id = $1
        ORDER BY spc.id DESC
        LIMIT 1
      `,
      [sessionId],
    );
    const context = result.rows[0] as
      | {
          sessionId: string;
          platform: StorePlatform;
          storeId: number | null;
          credentialId: number | null;
          credentialType: string | null;
          accessTokenEncrypted: string | null;
        }
      | undefined;

    if (!context) {
      return null;
    }

    if (
      context.credentialType !== 'web_session' ||
      !context.credentialId ||
      !context.accessTokenEncrypted
    ) {
      const error = new Error('当前授权会话未托管可用的网页登录态。');
      (error as Error & { statusCode?: number }).statusCode = 409;
      throw error;
    }

    return {
      ...context,
      cookieText: decryptSecret(context.accessTokenEncrypted, appConfig.secureConfigSecret),
    };
  }

  async createStoreAuthSession(input: {
    platform: StorePlatform;
    source: string;
    authType: number;
    storeId?: number | null;
    createdByUserId?: number | null;
  }): Promise<StoreAuthSessionCreateResult> {
    const client = await this.pool.connect();
    let transactionOpen = false;
    try {
      await client.query('BEGIN');
      transactionOpen = true;

      let targetStore:
        | {
            id: number;
            platform: StorePlatform;
            shopName: string;
            ownerAccountId: number | null;
          }
        | undefined;

      if (input.storeId) {
        const targetStoreResult = await client.query(
          `
            SELECT
              id,
              platform,
              shop_name AS "shopName",
              owner_account_id AS "ownerAccountId"
            FROM managed_stores
            WHERE id = $1
          `,
          [input.storeId],
        );
        targetStore = targetStoreResult.rows[0] as
          | {
              id: number;
              platform: StorePlatform;
              shopName: string;
              ownerAccountId: number | null;
            }
          | undefined;

        if (!targetStore) {
          throw new Error('Target store does not exist.');
        }

        if (targetStore.platform !== input.platform) {
          throw new Error('Reauthorization platform must match the managed store platform.');
        }

        await client.query(
          `
            UPDATE store_auth_sessions
            SET
              status = 'invalidated',
              invalid_reason = $1
            WHERE store_id = $2
              AND status = 'pending'
          `,
          ['Superseded by a newer reauthorization session.', input.storeId],
        );
      }

      const sessionId = randomUUID();
      const createdAt = format(new Date(), 'yyyy-MM-dd HH:mm:ss');
      const expiresAt = format(new Date(Date.now() + 15 * 60 * 1000), 'yyyy-MM-dd HH:mm:ss');
      const signingSecret = await this.getStoreAuthCallbackSigningSecret();
      const providerPlan = resolveStoreAuthProviderPlan(appConfig, {
        platform: input.platform,
        sessionId,
        reauthorize: Boolean(input.storeId),
        signingSecret,
      });
      const nextStep =
        providerPlan.integrationMode === 'xianyu_browser_oauth'
          ? 'wait_provider_callback'
          : 'manual_complete';

      await client.query(
        `
          INSERT INTO store_auth_sessions (
            session_id,
            platform,
            source,
            auth_type,
            status,
            created_at,
            expires_at,
            store_id,
            owner_account_id,
            created_by_user_id,
            reauthorize,
            integration_mode,
            provider_key,
            provider_label,
            provider_state,
            provider_auth_url,
            callback_url,
            next_step,
            profile_sync_status
          ) VALUES (
            $1, $2, $3, $4, 'pending', $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, 'pending'
          )
        `,
        [
          sessionId,
          input.platform,
          input.source,
          input.authType,
          createdAt,
          expiresAt,
          input.storeId ?? null,
          targetStore?.ownerAccountId ?? null,
          input.createdByUserId ?? null,
          input.storeId ? 1 : 0,
          providerPlan.integrationMode,
          providerPlan.providerKey,
          providerPlan.providerLabel,
          providerPlan.providerState,
          providerPlan.authorizeUrl,
          providerPlan.callbackUrl,
          nextStep,
        ],
      );

      await client.query('COMMIT');
      transactionOpen = false;

      return {
        sessionId,
        platform: input.platform,
        source: input.source,
        authType: input.authType,
        createdAt,
        expiresAt,
        reauthorize: Boolean(input.storeId),
        storeId: input.storeId ?? null,
        storeName: targetStore?.shopName ?? null,
        integrationMode: providerPlan.integrationMode,
        providerKey: providerPlan.providerKey,
        providerLabel: providerPlan.providerLabel,
        providerConfigured: providerPlan.providerConfigured,
        authorizeUrl: providerPlan.authorizeUrl,
        callbackPath: providerPlan.callbackPath,
        callbackUrl: providerPlan.callbackUrl,
        requiresBrowserCallback: providerPlan.requiresBrowserCallback,
        instructions: providerPlan.instructions,
        permissions: this.getStoreAuthPermissions(input.platform),
        shadowSeed: {
          sessionId,
          createdAt,
          expiresAt,
          providerState: providerPlan.providerState,
        },
      };
    } catch (error) {
      if (transactionOpen) {
        await client.query('ROLLBACK');
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async refreshStoreAuthSessionWindow(
    sessionId: string,
    input?: {
      minutes?: number;
      reviveExpiredWebSession?: boolean;
    },
  ) {
    const result = await this.pool.query(
      `
        SELECT
          session_id AS "sessionId",
          status,
          integration_mode AS "integrationMode",
          provider_access_token_received_at AS "providerAccessTokenReceivedAt"
        FROM store_auth_sessions
        WHERE session_id = $1
      `,
      [sessionId],
    );
    const session = result.rows[0] as
      | {
          sessionId: string;
          status: StoreAuthSessionStatus;
          integrationMode: StoreAuthIntegrationMode;
          providerAccessTokenReceivedAt: string | null;
        }
      | undefined;

    if (!session) {
      return null;
    }

    const minutes = Math.max(1, Math.trunc(input?.minutes ?? 15));
    const revived =
      Boolean(input?.reviveExpiredWebSession) &&
      session.status === 'expired' &&
      session.integrationMode === 'xianyu_web_session';

    if (session.status === 'invalidated' || session.status === 'completed') {
      return {
        sessionId: session.sessionId,
        refreshed: false,
        revived: false,
        status: session.status,
        expiresAt: null,
      };
    }

    if (session.status === 'expired' && !revived) {
      return {
        sessionId: session.sessionId,
        refreshed: false,
        revived: false,
        status: session.status,
        expiresAt: null,
      };
    }

    const expiresAt = format(new Date(Date.now() + minutes * 60 * 1000), 'yyyy-MM-dd HH:mm:ss');
    const nextStatus: StoreAuthSessionStatus = revived ? 'pending' : session.status;
    const nextStep =
      session.integrationMode === 'xianyu_web_session'
        ? session.providerAccessTokenReceivedAt
          ? 'sync_profile'
          : 'manual_complete'
        : null;

    await this.pool.query(
      `
        UPDATE store_auth_sessions
        SET
          expires_at = $1,
          status = $2,
          invalid_reason = CASE WHEN $3 THEN NULL ELSE invalid_reason END,
          next_step = CASE
            WHEN $3 AND integration_mode = 'xianyu_web_session' THEN $4
            ELSE next_step
          END
        WHERE session_id = $5
      `,
      [expiresAt, nextStatus, revived, nextStep, session.sessionId],
    );

    return {
      sessionId: session.sessionId,
      refreshed: true,
      revived,
      status: nextStatus,
      expiresAt,
    };
  }

  async receiveStoreAuthSessionWebCredential(
    sessionId: string,
    input: {
      cookieText: string;
      source?: 'manual' | 'qr_login' | 'browser_qr_login' | 'browser_renew';
      rawPayloadText?: string | null;
      riskLevel?: StoreCredentialRiskLevel;
      riskReason?: string | null;
      verificationUrl?: string | null;
    },
  ) {
    const client = await this.pool.connect();
    let transactionOpen = false;
    try {
      await client.query('BEGIN');
      transactionOpen = true;

      const sessionResult = await client.query(
        `
          SELECT
            session_id AS "sessionId",
            platform,
            status,
            store_id AS "storeId",
            owner_account_id AS "ownerAccountId",
            integration_mode AS "integrationMode",
            provider_key AS "providerKey"
          FROM store_auth_sessions
          WHERE session_id = $1
        `,
        [sessionId],
      );
      const session = sessionResult.rows[0] as
        | {
            sessionId: string;
            platform: StorePlatform;
            status: StoreAuthSessionStatus;
            storeId: number | null;
            ownerAccountId: number | null;
            integrationMode: StoreAuthIntegrationMode;
            providerKey: string | null;
          }
        | undefined;

      if (!session) {
        await client.query('ROLLBACK');
        transactionOpen = false;
        return null;
      }

      if (session.status === 'invalidated' || session.status === 'completed') {
        const error = new Error('The authorization session is no longer writable.');
        (error as Error & { statusCode?: number }).statusCode = 409;
        throw error;
      }

      if (session.integrationMode !== 'xianyu_web_session') {
        const error = new Error('This authorization session does not accept web-session credentials.');
        (error as Error & { statusCode?: number }).statusCode = 409;
        throw error;
      }

      const cookieText = input.cookieText.trim();
      if (cookieText.length < 10) {
        const error = new Error('A complete web-session cookie is required.');
        (error as Error & { statusCode?: number }).statusCode = 400;
        throw error;
      }

      const now = format(new Date(), 'yyyy-MM-dd HH:mm:ss');
      const authExpiresAt = format(new Date(Date.now() + 15 * 60 * 1000), 'yyyy-MM-dd HH:mm:ss');
      const providerKey = session.providerKey ?? 'xianyu-web-session';
      const credentialSource = input.source ?? 'manual';
      const cookieMasked = maskSecret(cookieText);
      const effectiveStatus: StoreAuthSessionStatus =
        session.status === 'expired' ? 'pending' : session.status;
      const existingCredential = await this.getStoreCredentialBySessionId(client, session.sessionId);
      const reuseCredentialId =
        existingCredential?.credentialType === 'web_session' && existingCredential.providerKey === providerKey
          ? existingCredential.id
          : null;

      await this.deleteScopedStoreCredential(client, {
        sessionId: session.sessionId,
        platform: session.platform,
        providerKey,
        credentialType: 'web_session',
        storeId: session.storeId,
        ownerAccountId: session.ownerAccountId,
        keepCredentialId: reuseCredentialId,
      });

      const encryptedCookieText = encryptSecret(cookieText, appConfig.secureConfigSecret);
      const credentialId =
        reuseCredentialId !== null
          ? reuseCredentialId
          : await this.nextTableId(client, 'store_platform_credentials');

      if (reuseCredentialId === null) {
        await client.query(
          `
            INSERT INTO store_platform_credentials (
              id,
              session_id,
              platform,
              store_id,
              owner_account_id,
              provider_key,
              credential_type,
              access_token_encrypted,
              access_token_masked,
              expires_at,
              last_sync_status,
              credential_source,
              risk_level,
              risk_reason,
              verification_url,
              created_at,
              updated_at
            ) VALUES (
              $1, $2, $3, $4, $5, $6, 'web_session', $7, $8, NULL, 'pending_profile_sync', $9, $10, $11, $12, $13, $13
            )
          `,
          [
            credentialId,
            session.sessionId,
            session.platform,
            session.storeId,
            session.ownerAccountId,
            providerKey,
            encryptedCookieText,
            cookieMasked,
            credentialSource,
            input.riskLevel ?? 'pending',
            input.riskReason?.trim() ?? '',
            input.verificationUrl?.trim() || null,
            now,
          ],
        );
      } else {
        await client.query(
          `
            UPDATE store_platform_credentials
            SET
              store_id = $1,
              owner_account_id = $2,
              access_token_encrypted = $3,
              access_token_masked = $4,
              expires_at = NULL,
              last_sync_status = 'pending_profile_sync',
              credential_source = $5,
              risk_level = $6,
              risk_reason = $7,
              verification_url = $8,
              updated_at = $9
            WHERE id = $10
          `,
          [
            session.storeId,
            session.ownerAccountId,
            encryptedCookieText,
            cookieMasked,
            credentialSource,
            input.riskLevel ?? 'pending',
            input.riskReason?.trim() ?? '',
            input.verificationUrl?.trim() || null,
            now,
            reuseCredentialId,
          ],
        );
      }

      if (session.storeId) {
      await this.deleteManagedStoreXianyuImAuthCache(client, session.storeId);
      }

      await client.query(
        `
          UPDATE store_auth_sessions
          SET
            status = $1,
            expires_at = $2,
            provider_access_token_masked = $3,
            provider_access_token_received_at = $4,
            provider_payload_text = $5,
            invalid_reason = NULL,
            next_step = 'sync_profile',
            callback_received_at = $4,
            profile_sync_status = 'pending',
            profile_sync_error = NULL,
            provider_error_code = NULL,
            provider_error_message = NULL
          WHERE session_id = $6
        `,
        [
          effectiveStatus,
          authExpiresAt,
          cookieMasked,
          now,
          this.buildStoreAuthPayloadSummary({
            payloadType: 'web_session_capture',
            capturedAt: now,
            maskedValue: cookieMasked,
            rawText: input.rawPayloadText ?? null,
            credentialSource,
            riskLevel: input.riskLevel ?? 'pending',
            verificationUrl: input.verificationUrl ?? null,
          }),
          session.sessionId,
        ],
      );

      const stepInfo = this.getStoreAuthSessionStepInfo({
        status: effectiveStatus,
        integrationMode: session.integrationMode,
        nextStep: 'sync_profile',
        providerAccessTokenReceivedAt: now,
      });

      await this.recordStoreCredentialEvent(client, {
        storeId: session.storeId,
        sessionId: session.sessionId,
        credentialId,
        eventType: 'credential_captured',
        status:
          input.riskLevel === 'warning' || input.riskLevel === 'offline' || input.riskLevel === 'abnormal'
            ? 'warning'
            : 'success',
        detail:
          credentialSource === 'qr_login'
            ? 'Captured QR-login web session and persisted it.'
            : credentialSource === 'browser_qr_login'
              ? 'Captured browser QR-login web session and persisted it.'
              : credentialSource === 'browser_renew'
                ? 'Updated the latest renewed browser web session.'
                : 'Captured a manual web session and persisted it.',
        source: credentialSource,
        riskLevel: input.riskLevel ?? 'pending',
        verificationUrl: input.verificationUrl ?? null,
      });

      if (
        input.verificationUrl?.trim() ||
        input.riskLevel === 'warning' ||
        input.riskLevel === 'offline' ||
        input.riskLevel === 'abnormal'
      ) {
        await this.recordStoreCredentialEvent(client, {
          storeId: session.storeId,
          sessionId: session.sessionId,
          credentialId,
          eventType: 'manual_takeover_required',
          status: 'warning',
          detail:
            input.riskReason?.trim() ||
            'The web session was stored, but manual follow-up is still required.',
          source: credentialSource,
          riskLevel: input.riskLevel ?? 'warning',
          verificationUrl: input.verificationUrl ?? null,
        });
      }

      await client.query('COMMIT');
      transactionOpen = false;

      return {
        accepted: true,
        sessionId: session.sessionId,
        integrationMode: session.integrationMode,
        providerKey,
        accessTokenMasked: cookieMasked,
        accessTokenReceivedAt: now,
        nextStep: stepInfo.nextStepKey,
        nextStepText: stepInfo.nextStepText,
        source: credentialSource,
        message:
          credentialSource === 'browser_renew'
            ? 'Updated the web session and kept the store pending for validation.'
            : 'Stored the web session and marked the session ready for profile sync.',
      };
    } catch (error) {
      if (transactionOpen) {
        await client.query('ROLLBACK');
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async syncStoreAuthSessionProfile(
    sessionId: string,
    input: {
      providerUserId: string;
      providerShopId: string;
      providerShopName: string;
      mobile: string;
      nickname?: string | null;
      scopeText?: string | null;
      refreshToken?: string | null;
    },
    syncedByUserId: number | null,
  ) {
    let sessionResult = await this.pool.query(
      `
        SELECT
          session_id AS "sessionId",
          platform,
          source,
          status,
          store_id AS "storeId",
          owner_account_id AS "ownerAccountId",
          created_by_user_id AS "createdByUserId",
          reauthorize,
          integration_mode AS "integrationMode",
          provider_access_token_received_at AS "providerAccessTokenReceivedAt"
        FROM store_auth_sessions
        WHERE session_id = $1
      `,
      [sessionId],
    );
    let session = sessionResult.rows[0] as
      | {
          sessionId: string;
          platform: StorePlatform;
          source: string;
          status: StoreAuthSessionStatus;
          storeId: number | null;
          ownerAccountId: number | null;
          createdByUserId: number | null;
          reauthorize: number;
          integrationMode: StoreAuthIntegrationMode;
          providerAccessTokenReceivedAt: string | null;
        }
      | undefined;

    if (!session) {
      return null;
    }

    if (session.status === 'invalidated' || session.status === 'completed') {
      const error = new Error('The authorization session is no longer writable.');
      (error as Error & { statusCode?: number }).statusCode = 409;
      throw error;
    }

    if (session.status === 'expired' && session.integrationMode === 'xianyu_web_session') {
      await this.refreshStoreAuthSessionWindow(sessionId, {
        minutes: 15,
        reviveExpiredWebSession: true,
      });
      sessionResult = await this.pool.query(
        `
          SELECT
            session_id AS "sessionId",
            platform,
            source,
            status,
            store_id AS "storeId",
            owner_account_id AS "ownerAccountId",
            created_by_user_id AS "createdByUserId",
            reauthorize,
            integration_mode AS "integrationMode",
            provider_access_token_received_at AS "providerAccessTokenReceivedAt"
          FROM store_auth_sessions
          WHERE session_id = $1
        `,
        [sessionId],
      );
      session = sessionResult.rows[0] as typeof session;
      if (!session) {
        return null;
      }
    }

    if (
      session.integrationMode !== 'xianyu_browser_oauth' &&
      session.integrationMode !== 'xianyu_web_session'
    ) {
      const error = new Error('This authorization session does not support profile sync.');
      (error as Error & { statusCode?: number }).statusCode = 409;
      throw error;
    }

    if (!session.providerAccessTokenReceivedAt) {
      const error =
        session.integrationMode === 'xianyu_web_session'
          ? new Error('A web session must be captured before profile sync.')
          : new Error('The provider callback must be received before profile sync.');
      (error as Error & { statusCode?: number }).statusCode = 409;
      throw error;
    }

    const providerUserId = input.providerUserId.trim();
    const providerShopId = input.providerShopId.trim();
    const providerShopName = input.providerShopName.trim();
    const mobile = input.mobile.trim();
    const nickname = input.nickname?.trim() || providerShopName;

    if (!providerUserId || !providerShopId || !providerShopName || !mobile) {
      const error = new Error('providerUserId, providerShopId, providerShopName and mobile are required.');
      (error as Error & { statusCode?: number }).statusCode = 400;
      throw error;
    }

    const client = await this.pool.connect();
    let transactionOpen = false;
    try {
      await client.query('BEGIN');
      transactionOpen = true;

      const credential = await this.getStoreCredentialBySessionId(client, sessionId);
      if (!credential) {
        const error = new Error('No authorization credential is attached to this session.');
        (error as Error & { statusCode?: number }).statusCode = 404;
        throw error;
      }

      const scopeText = input.scopeText?.trim() ?? credential.scopeText ?? '';
      const refreshToken = input.refreshToken?.trim() || null;
      const now = format(new Date(), 'yyyy-MM-dd HH:mm:ss');

      await client.query(
        `
          UPDATE store_auth_sessions
          SET
            next_step = 'sync_profile',
            profile_sync_status = 'syncing',
            profile_sync_error = NULL,
            provider_error_code = NULL,
            provider_error_message = NULL
          WHERE session_id = $1
        `,
        [sessionId],
      );

      const ownerAccountId = await this.upsertStoreOwnerAccount(client, {
        accountId: session.ownerAccountId ?? credential.ownerAccountId ?? null,
        platform: session.platform,
        ownerName: nickname,
        mobile,
        loginMode: session.integrationMode === 'xianyu_web_session' ? 'cookie' : 'oauth',
        authorizedByUserId: syncedByUserId,
      });

      let storeId =
        session.storeId ??
        (await this.findManagedStoreByProviderShopId(client, session.platform, providerShopId))?.id ??
        null;
      let sellerNo = providerShopId || (await this.buildSellerNo(client, session.platform));
      let activationStatus: StoreConnectionStatus =
        session.platform === 'xianyu' ? 'pending_activation' : 'active';

      if (storeId) {
        const currentStoreResult = await client.query(
          `
            SELECT
              id,
              seller_no AS "sellerNo",
              connection_status AS "connectionStatus",
              enabled
            FROM managed_stores
            WHERE id = $1
          `,
          [storeId],
        );
        const currentStore = currentStoreResult.rows[0] as
          | {
              id: number;
              sellerNo: string;
              connectionStatus: StoreConnectionStatus;
              enabled: number;
            }
          | undefined;

        if (!currentStore) {
          await client.query('ROLLBACK');
          transactionOpen = false;
          return null;
        }

        sellerNo = currentStore.sellerNo || sellerNo;
        activationStatus =
          currentStore.connectionStatus === 'pending_activation' ? 'pending_activation' : 'active';

        await client.query(
          `
            UPDATE managed_stores
            SET
              shop_name = $1,
              seller_no = $2,
              nickname = $3,
              owner_account_id = $4,
              auth_status = 'authorized',
              auth_expires_at = $5,
              last_session_id = $6,
              last_reauthorize_at = $7,
              last_sync_at = CASE WHEN $8 = 'active' THEN $7 ELSE last_sync_at END,
              health_status = $9,
              last_health_check_detail = $10,
              connection_status = $8,
              activation_status = $8,
              status_text = $11,
              provider_store_id = $12,
              provider_user_id = $13,
              credential_id = $14,
              profile_sync_status = 'success',
              profile_sync_error = NULL,
              last_profile_sync_at = $7,
              updated_at = $7
            WHERE id = $15
          `,
          [
            providerShopName,
            sellerNo,
            nickname,
            ownerAccountId,
            credential.expiresAt,
            sessionId,
            now,
            activationStatus,
            activationStatus === 'active' ? 'healthy' : 'warning',
            activationStatus === 'active'
              ? 'Profile sync completed and the store connection is healthy.'
              : 'Profile sync completed and the store is waiting for manual activation.',
            this.getManagedStoreStatusText(activationStatus, Boolean(currentStore.enabled)),
            providerShopId,
            providerUserId,
            credential.id,
            storeId,
          ],
        );
      } else {
        const nextStoreId = await this.nextTableId(client, 'managed_stores');
        storeId = nextStoreId;
        await client.query(
          `
            INSERT INTO managed_stores (
              id,
              platform,
              shop_type_label,
              shop_name,
              seller_no,
              nickname,
              status_text,
              activation_status,
              package_text,
              publish_limit_text,
              owner_account_id,
              created_by_user_id,
              group_name,
              tags_text,
              remark,
              enabled,
              connection_status,
              auth_status,
              auth_expires_at,
              last_sync_at,
              health_status,
              last_health_check_at,
              last_health_check_detail,
              last_session_id,
              last_reauthorize_at,
              provider_store_id,
              provider_user_id,
              credential_id,
              profile_sync_status,
              profile_sync_error,
              last_profile_sync_at,
              last_verified_at,
              created_at,
              updated_at
            ) VALUES (
              $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, 1, $8, 'authorized', $16, $17, $18, NULL, $19, $20, $20, $21, $22, $23, 'success', NULL, $20, $20, $20, $20
            )
          `,
          [
            nextStoreId,
            session.platform,
            session.platform === 'xianyu' ? '闲鱼店铺' : '淘宝店铺',
            providerShopName,
            sellerNo,
            nickname,
            this.getManagedStoreStatusText(activationStatus, true),
            activationStatus,
            session.platform === 'xianyu'
              ? session.integrationMode === 'xianyu_web_session'
                ? '网页登录态接入'
                : '官方授权接入'
              : '淘宝接入',
            session.platform === 'xianyu'
              ? session.integrationMode === 'xianyu_web_session'
                ? '已录入网页登录态，待后续探测校验'
                : '已接入官方授权'
              : '已准备同步商品与库存',
            ownerAccountId,
            session.createdByUserId ?? syncedByUserId,
            session.platform === 'xianyu' ? '闲鱼主店' : '淘宝搬家',
            session.platform === 'xianyu'
              ? this.normalizeStoreTags([
                  '闲鱼',
                  session.integrationMode === 'xianyu_web_session' ? '网页登录态接入' : '官方授权',
                ])
              : this.normalizeStoreTags(['淘宝', '官方授权']),
            session.integrationMode === 'xianyu_web_session'
              ? 'Initial store binding completed via web-session profile sync.'
              : 'Initial store binding completed via provider profile sync.',
            credential.expiresAt,
            activationStatus === 'active' ? now : null,
            activationStatus === 'active' ? 'healthy' : 'warning',
            activationStatus === 'active'
              ? 'Profile sync completed and the store connection is healthy.'
              : 'Profile sync completed and the store is waiting for manual activation.',
            sessionId,
            providerShopId,
            providerUserId,
            credential.id,
          ],
        );
      }

      await client.query(
        `
          UPDATE store_platform_credentials
          SET
            store_id = $1,
            owner_account_id = $2,
            refresh_token_encrypted = $3,
            scope_text = $4,
            provider_user_id = $5,
            provider_shop_id = $6,
            provider_shop_name = $7,
            last_verified_at = $8,
            last_sync_status = 'profile_synced',
            updated_at = $8
          WHERE id = $9
        `,
        [
          storeId,
          ownerAccountId,
          refreshToken ? encryptSecret(refreshToken, appConfig.secureConfigSecret) : null,
          scopeText,
          providerUserId,
          providerShopId,
          providerShopName,
          now,
          credential.id,
        ],
      );

      await client.query(
        `
          UPDATE store_auth_sessions
          SET
            status = 'completed',
            completed_at = $1,
            invalid_reason = NULL,
            store_id = $2,
            owner_account_id = $3,
            mobile = $4,
            nickname = $5,
            next_step = 'done',
            profile_sync_status = 'success',
            profile_sync_error = NULL,
            profile_synced_at = $1,
            provider_error_code = NULL,
            provider_error_message = NULL
          WHERE session_id = $6
        `,
        [now, storeId, ownerAccountId, mobile, nickname, sessionId],
      );

      await this.bindStoreCredentialEventsToStore(client, sessionId, {
        storeId,
        credentialId: credential.id,
      });
      await this.recordStoreCredentialEvent(client, {
        storeId,
        sessionId,
        credentialId: credential.id,
        eventType: 'profile_synced',
        status: 'success',
        detail:
          session.integrationMode === 'xianyu_web_session'
            ? 'Bound the seller profile, store profile and web session together.'
            : 'Bound the seller profile, store profile and provider credential together.',
        source: session.integrationMode,
        operatorUserId: syncedByUserId,
      });

      await client.query('COMMIT');
      transactionOpen = false;

      return {
        storeId,
        platform: session.platform,
        activationStatus,
        statusText:
          activationStatus === 'pending_activation'
            ? 'Profile synced, waiting for activation.'
            : 'Profile synced and store connected.',
        shopName: providerShopName,
        sellerNo,
        source: session.source,
        reauthorized: Boolean(session.storeId),
        providerUserId,
        providerShopId,
        providerShopName,
        profileSyncedAt: now,
      };
    } catch (error) {
      if (transactionOpen) {
        await client.query('ROLLBACK');
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async completeStoreAuthSession(
    sessionId: string,
    payload: { mobile: string; nickname: string; loginMode: 'sms' | 'password' },
    completedByUserId: number | null,
  ) {
    const client = await this.pool.connect();
    let transactionOpen = false;
    try {
      await client.query('BEGIN');
      transactionOpen = true;

      const sessionResult = await client.query(
        `
          SELECT
            session_id AS "sessionId",
            platform,
            source,
            auth_type AS "authType",
            status,
            store_id AS "storeId",
            owner_account_id AS "ownerAccountId",
            created_by_user_id AS "createdByUserId",
            integration_mode AS "integrationMode"
          FROM store_auth_sessions
          WHERE session_id = $1
        `,
        [sessionId],
      );
      const session = sessionResult.rows[0] as
        | {
            sessionId: string;
            platform: StorePlatform;
            source: string;
            authType: number;
            status: StoreAuthSessionStatus;
            storeId: number | null;
            ownerAccountId: number | null;
            createdByUserId: number | null;
            integrationMode: StoreAuthIntegrationMode;
          }
        | undefined;

      if (!session || session.status !== 'pending') {
        await client.query('ROLLBACK');
        transactionOpen = false;
        return null;
      }

      if (session.integrationMode !== 'simulated') {
        const error = new Error('This authorization session has switched to a real provider flow.');
        (error as Error & { statusCode?: number }).statusCode = 409;
        throw error;
      }

      const now = format(new Date(), 'yyyy-MM-dd HH:mm:ss');
      const authExpiresAt = format(
        new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        'yyyy-MM-dd HH:mm:ss',
      );
      const ownerAccountId = await this.upsertStoreOwnerAccount(client, {
        accountId: session.ownerAccountId,
        platform: session.platform,
        ownerName: payload.nickname,
        mobile: payload.mobile,
        loginMode: payload.loginMode,
        authorizedByUserId: completedByUserId,
      });

      let storeId = session.storeId ?? null;
      let sellerNo = '';
      let activationStatus: StoreConnectionStatus;

      if (storeId) {
        const currentStoreResult = await client.query(
          `
            SELECT
              id,
              seller_no AS "sellerNo",
              connection_status AS "connectionStatus",
              enabled
            FROM managed_stores
            WHERE id = $1
          `,
          [storeId],
        );
        const currentStore = currentStoreResult.rows[0] as
          | {
              id: number;
              sellerNo: string;
              connectionStatus: StoreConnectionStatus;
              enabled: number;
            }
          | undefined;

        if (!currentStore) {
          await client.query('ROLLBACK');
          transactionOpen = false;
          return null;
        }

        sellerNo = currentStore.sellerNo;
        activationStatus =
          currentStore.connectionStatus === 'pending_activation' ? 'pending_activation' : 'active';

        await client.query(
          `
            UPDATE managed_stores
            SET
              shop_name = $1,
              nickname = $1,
              owner_account_id = $2,
              auth_status = 'authorized',
              auth_expires_at = $3,
              last_session_id = $4,
              last_reauthorize_at = $5,
              last_sync_at = CASE WHEN $6 = 'active' THEN $5 ELSE last_sync_at END,
              health_status = $7,
              last_health_check_detail = $8,
              connection_status = $6,
              activation_status = $6,
              status_text = $9,
              updated_at = $5
            WHERE id = $10
          `,
          [
            payload.nickname,
            ownerAccountId,
            authExpiresAt,
            sessionId,
            now,
            activationStatus,
            activationStatus === 'pending_activation' ? 'warning' : 'healthy',
            activationStatus === 'pending_activation'
              ? 'Authorization restored, waiting for manual activation.'
              : 'Authorization restored and connection is healthy again.',
            this.getManagedStoreStatusText(activationStatus, Boolean(currentStore.enabled)),
            storeId,
          ],
        );
      } else {
        activationStatus = session.platform === 'xianyu' ? 'pending_activation' : 'active';
        sellerNo = await this.buildSellerNo(client, session.platform);
        storeId = await this.nextTableId(client, 'managed_stores');
        await client.query(
          `
            INSERT INTO managed_stores (
              id,
              platform,
              shop_type_label,
              shop_name,
              seller_no,
              nickname,
              status_text,
              activation_status,
              package_text,
              publish_limit_text,
              owner_account_id,
              created_by_user_id,
              group_name,
              tags_text,
              remark,
              enabled,
              connection_status,
              auth_status,
              auth_expires_at,
              last_sync_at,
              health_status,
              last_health_check_at,
              last_health_check_detail,
              last_session_id,
              last_reauthorize_at,
              created_at,
              updated_at
            ) VALUES (
              $1, $2, $3, $4, $5, $4, $6, $7, $8, $9, $10, $11, $12, $13, $14, 1, $7, 'authorized', $15, $16, $17, NULL, $18, $19, $19, $19, $19
            )
          `,
          [
            storeId,
            session.platform,
            session.platform === 'xianyu' ? '闲鱼店铺' : '淘宝店铺',
            payload.nickname,
            sellerNo,
            this.getManagedStoreStatusText(activationStatus, true),
            activationStatus,
            session.platform === 'xianyu' ? '开通提效包' : '淘宝接入',
            session.platform === 'xianyu' ? '已授权接入' : '已准备同步商品与库存',
            ownerAccountId,
            session.createdByUserId ?? completedByUserId,
            session.platform === 'xianyu' ? '闲鱼主店' : '淘宝搬家',
            session.platform === 'xianyu'
              ? this.normalizeStoreTags(['闲鱼', '新接入'])
              : this.normalizeStoreTags(['淘宝', '新接入']),
            'Created from the store access center.',
            authExpiresAt,
            activationStatus === 'active' ? now : null,
            activationStatus === 'pending_activation' ? 'warning' : 'healthy',
            activationStatus === 'pending_activation'
              ? 'Authorization completed, waiting for activation.'
              : 'Authorization completed and connection is healthy.',
            sessionId,
          ],
        );
      }

      await client.query(
        `
          UPDATE store_auth_sessions
          SET
            status = 'completed',
            completed_at = $1,
            mobile = $2,
            nickname = $3,
            invalid_reason = NULL,
            store_id = $4,
            owner_account_id = $5,
            next_step = 'done',
            profile_sync_status = 'success',
            profile_sync_error = NULL,
            profile_synced_at = $1
          WHERE session_id = $6
        `,
        [now, payload.mobile, payload.nickname, storeId, ownerAccountId, sessionId],
      );

      await client.query('COMMIT');
      transactionOpen = false;

      return {
        storeId,
        platform: session.platform,
        activationStatus,
        statusText: this.getManagedStoreStatusText(activationStatus, true),
        shopName: payload.nickname,
        sellerNo,
        source: session.source,
        loginMode: payload.loginMode,
        reauthorized: Boolean(session.storeId),
      };
    } catch (error) {
      if (transactionOpen) {
        await client.query('ROLLBACK');
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async activateManagedStore(storeId: number) {
    const client = await this.pool.connect();
    let transactionOpen = false;
    try {
      await client.query('BEGIN');
      transactionOpen = true;

      const result = await client.query(
        `
          SELECT
            id,
            shop_name AS "shopName",
            connection_status AS "connectionStatus",
            enabled
          FROM managed_stores
          WHERE id = $1
          LIMIT 1
        `,
        [storeId],
      );
      const store = result.rows[0] as
        | {
            id: number;
            shopName: string;
            connectionStatus: StoreConnectionStatus;
            enabled: number;
          }
        | undefined;
      if (!store) {
        await client.query('ROLLBACK');
        transactionOpen = false;
        return null;
      }

      if (store.connectionStatus === 'active') {
        await client.query('COMMIT');
        transactionOpen = false;
        return { activated: true, shopName: store.shopName };
      }

      const now = format(new Date(), 'yyyy-MM-dd HH:mm:ss');
      await client.query(
        `
          UPDATE managed_stores
          SET
            status_text = $1,
            activation_status = 'active',
            connection_status = 'active',
            health_status = CASE WHEN enabled = 1 THEN 'healthy' ELSE health_status END,
            last_sync_at = CASE WHEN enabled = 1 THEN $2 ELSE last_sync_at END,
            last_health_check_detail = CASE
              WHEN enabled = 1 THEN $3
              ELSE last_health_check_detail
            END,
            updated_at = $4
          WHERE id = $5
        `,
        [
          this.getManagedStoreStatusText('active', Boolean(store.enabled)),
          now,
          'Store was activated and is ready for scheduled tasks.',
          now,
          storeId,
        ],
      );

      await client.query('COMMIT');
      transactionOpen = false;
      return { activated: true, shopName: store.shopName };
    } catch (error) {
      if (transactionOpen) {
        await client.query('ROLLBACK');
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async updateManagedStoreMeta(
    storeId: number,
    input: { groupName: string; tags: string[]; remark: string },
  ) {
    const client = await this.pool.connect();
    let transactionOpen = false;
    try {
      await client.query('BEGIN');
      transactionOpen = true;

      const currentResult = await client.query(
        `
          SELECT id
          FROM managed_stores
          WHERE id = $1
          LIMIT 1
        `,
        [storeId],
      );
      if (!currentResult.rows[0]) {
        await client.query('ROLLBACK');
        transactionOpen = false;
        throw new Error('Store does not exist.');
      }

      const now = format(new Date(), 'yyyy-MM-dd HH:mm:ss');
      await client.query(
        `
          UPDATE managed_stores
          SET
            group_name = $1,
            tags_text = $2,
            remark = $3,
            updated_at = $4
          WHERE id = $5
        `,
        [
          input.groupName.trim() || 'Ungrouped',
          this.normalizeStoreTags(input.tags),
          input.remark.trim(),
          now,
          storeId,
        ],
      );

      await client.query('COMMIT');
      transactionOpen = false;
      return (await this.listManagedStores()).find((store) => store.id === storeId) ?? null;
    } catch (error) {
      if (transactionOpen) {
        await client.query('ROLLBACK');
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async setManagedStoreEnabled(storeId: number, enabled: boolean) {
    const client = await this.pool.connect();
    let transactionOpen = false;
    try {
      await client.query('BEGIN');
      transactionOpen = true;

      const currentResult = await client.query(
        `
          SELECT
            id,
            connection_status AS "connectionStatus"
          FROM managed_stores
          WHERE id = $1
          LIMIT 1
        `,
        [storeId],
      );
      const current = currentResult.rows[0] as
        | {
            id: number;
            connectionStatus: StoreConnectionStatus;
          }
        | undefined;
      if (!current) {
        await client.query('ROLLBACK');
        transactionOpen = false;
        throw new Error('Store does not exist.');
      }

      const now = format(new Date(), 'yyyy-MM-dd HH:mm:ss');
      await client.query(
        `
          UPDATE managed_stores
          SET
            enabled = $1,
            status_text = $2,
            updated_at = $3
          WHERE id = $4
        `,
        [enabled ? 1 : 0, this.getManagedStoreStatusText(current.connectionStatus, enabled), now, storeId],
      );

      await client.query('COMMIT');
      transactionOpen = false;
      return (await this.listManagedStores()).find((store) => store.id === storeId) ?? null;
    } catch (error) {
      if (transactionOpen) {
        await client.query('ROLLBACK');
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async batchSetManagedStoreEnabled(storeIds: number[], enabled: boolean) {
    const uniqueStoreIds = Array.from(
      new Set(storeIds.filter((storeId) => Number.isInteger(storeId) && storeId > 0)),
    );
    const stores = [];
    for (const storeId of uniqueStoreIds) {
      const updated = await this.setManagedStoreEnabled(storeId, enabled);
      if (updated) {
        stores.push(updated);
      }
    }
    return stores;
  }

  async markManagedStoreCredentialRenew(
    storeId: number,
    input: {
      cookieText?: string | null;
      detail: string;
      renewed: boolean;
      verificationUrl?: string | null;
    },
  ) {
    const client = await this.pool.connect();
    let transactionOpen = false;
    try {
      await client.query('BEGIN');
      transactionOpen = true;

      const context = await this.getManagedStoreCredentialContext(client, storeId);
      if (!context) {
        await client.query('ROLLBACK');
        transactionOpen = false;
        return null;
      }

      if (!context.credentialId) {
        const error = new Error('Store credential is not available for browser renewal.');
        (error as Error & { statusCode?: number }).statusCode = 409;
        throw error;
      }

      const now = format(new Date(), 'yyyy-MM-dd HH:mm:ss');
      const cookieText = input.cookieText?.trim() || null;
      await client.query(
        `
          UPDATE store_platform_credentials
          SET
            access_token_encrypted = COALESCE($1, access_token_encrypted),
            access_token_masked = COALESCE($2, access_token_masked),
            verification_url = COALESCE($3, verification_url),
            last_renewed_at = $4,
            last_renew_status = $5,
            updated_at = $4
          WHERE id = $6
        `,
        [
          cookieText ? encryptSecret(cookieText, appConfig.secureConfigSecret) : null,
          cookieText ? maskSecret(cookieText) : null,
          input.verificationUrl?.trim() || null,
          now,
          input.detail.trim(),
          context.credentialId,
        ],
      );

      await client.query(
        `
          UPDATE managed_stores
          SET updated_at = $1
          WHERE id = $2
        `,
        [now, storeId],
      );

      if (cookieText) {
        await this.deleteManagedStoreXianyuImAuthCache(client, storeId);
      }

      await this.recordStoreCredentialEvent(client, {
        storeId,
        credentialId: context.credentialId,
        eventType: 'browser_renewed',
        status: input.renewed ? 'success' : input.verificationUrl?.trim() ? 'warning' : 'error',
        detail: input.detail.trim(),
        source: 'browser_renew',
        verificationUrl: input.verificationUrl ?? null,
      });

      if (input.verificationUrl?.trim()) {
        await this.recordStoreCredentialEvent(client, {
          storeId,
          credentialId: context.credentialId,
          eventType: 'manual_takeover_required',
          status: 'warning',
          detail: input.detail.trim(),
          source: 'browser_renew',
          verificationUrl: input.verificationUrl ?? null,
        });
      }

      await client.query('COMMIT');
      transactionOpen = false;

      return {
        storeId,
        shopName: context.shopName,
        renewed: input.renewed,
        renewedAt: now,
        detail: input.detail.trim(),
      };
    } catch (error) {
      if (transactionOpen) {
        await client.query('ROLLBACK');
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async saveManagedStoreXianyuImAuthCache(
    storeId: number,
    cache: XianyuWebSocketAuthCache,
    source = 'ai_bargain_sync',
  ) {
    const now = format(new Date(), 'yyyy-MM-dd HH:mm:ss');
    const encrypted = encryptSecret(JSON.stringify(cache), appConfig.secureConfigSecret);
    await this.pool.query(
      `
        INSERT INTO xianyu_im_session_auth_cache (
          store_id,
          auth_snapshot_encrypted,
          source,
          captured_at,
          expires_at,
          updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT(store_id) DO UPDATE SET
          auth_snapshot_encrypted = EXCLUDED.auth_snapshot_encrypted,
          source = EXCLUDED.source,
          captured_at = EXCLUDED.captured_at,
          expires_at = EXCLUDED.expires_at,
          updated_at = EXCLUDED.updated_at
      `,
      [storeId, encrypted, source.trim() || 'ai_bargain_sync', cache.capturedAt, cache.expiresAt, now],
    );
  }

  async clearManagedStoreXianyuImAuthCache(storeId: number) {
    await this.deleteManagedStoreXianyuImAuthCache(this.pool, storeId);
  }

  async getStoreCredentialEvents(
    storeId: number,
    limit = 40,
  ): Promise<StoreCredentialEvents> {
    const storeResult = await this.pool.query(
      `
        SELECT id, shop_name AS "shopName"
        FROM managed_stores
        WHERE id = $1
        LIMIT 1
      `,
      [storeId],
    );
    const store = storeResult.rows[0] as { id: number; shopName: string } | undefined;
    if (!store) {
      return null;
    }

    const rowsResult = await this.pool.query(
      `
        SELECT
          sce.id,
          sce.store_id AS "storeId",
          sce.session_id AS "sessionId",
          sce.credential_id AS "credentialId",
          sce.event_type AS "eventType",
          sce.status,
          sce.detail,
          sce.source,
          sce.risk_level AS "riskLevel",
          sce.verification_url AS "verificationUrl",
          sce.created_at AS "createdAt",
          u.display_name AS "operatorName"
        FROM store_credential_events sce
        LEFT JOIN users u ON u.id = sce.operator_user_id
        WHERE sce.store_id = $1
        ORDER BY sce.created_at DESC, sce.id DESC
        LIMIT $2
      `,
      [storeId, limit],
    );
    const rows = rowsResult.rows as StoreCredentialEventRecord[];

    return {
      storeId,
      shopName: store.shopName,
      events: rows.map((row) => ({
        ...row,
        eventTypeText: this.getStoreCredentialEventTypeText(row.eventType),
        statusText: this.getStoreCredentialEventStatusText(row.status),
      })),
    };
  }

  async getStoreCredentialEventsBySession(
    sessionId: string,
    limit = 40,
  ): Promise<StoreCredentialEventsBySession> {
    const sessionResult = await this.pool.query(
      `
        SELECT
          sas.session_id AS "sessionId",
          sas.store_id AS "storeId",
          ms.shop_name AS "storeName"
        FROM store_auth_sessions sas
        LEFT JOIN managed_stores ms ON ms.id = sas.store_id
        WHERE sas.session_id = $1
        LIMIT 1
      `,
      [sessionId],
    );
    const session = sessionResult.rows[0] as
      | {
          sessionId: string;
          storeId: number | null;
          storeName: string | null;
        }
      | undefined;
    if (!session) {
      return null;
    }

    const rowsResult = await this.pool.query(
      `
        SELECT
          sce.id,
          sce.store_id AS "storeId",
          sce.session_id AS "sessionId",
          sce.credential_id AS "credentialId",
          sce.event_type AS "eventType",
          sce.status,
          sce.detail,
          sce.source,
          sce.risk_level AS "riskLevel",
          sce.verification_url AS "verificationUrl",
          sce.created_at AS "createdAt",
          u.display_name AS "operatorName"
        FROM store_credential_events sce
        LEFT JOIN users u ON u.id = sce.operator_user_id
        WHERE sce.session_id = $1
        ORDER BY sce.created_at DESC, sce.id DESC
        LIMIT $2
      `,
      [sessionId, limit],
    );
    const rows = rowsResult.rows as StoreCredentialEventRecord[];

    return {
      sessionId: session.sessionId,
      storeId: session.storeId,
      storeName: session.storeName,
      events: rows.map((row) => ({
        ...row,
        eventTypeText: this.getStoreCredentialEventTypeText(row.eventType),
        statusText: this.getStoreCredentialEventStatusText(row.status),
      })),
    };
  }

  async listManagedStoreProductSyncTargets(storeIds?: number[]) {
    const clauses = [
      "ms.platform = 'xianyu'",
      'ms.enabled = 1',
      "spc.credential_type = 'web_session'",
      'spc.access_token_encrypted IS NOT NULL',
      "TRIM(COALESCE(spc.provider_user_id, ms.provider_user_id, '')) <> ''",
    ];
    const params: unknown[] = [];

    if (storeIds && storeIds.length > 0) {
      params.push(storeIds);
      clauses.push(`ms.id = ANY($${params.length}::int[])`);
    }

    const result = await this.pool.query(
      `
        SELECT
          ms.id AS "storeId",
          ms.shop_name AS "shopName",
          ms.provider_user_id AS "managedProviderUserId",
          oa.owner_name AS "ownerName",
          spc.provider_user_id AS "credentialProviderUserId",
          spc.access_token_encrypted AS "accessTokenEncrypted",
          xisc.auth_snapshot_encrypted AS "authSnapshotEncrypted"
        FROM managed_stores ms
        INNER JOIN store_platform_credentials spc ON spc.id = ms.credential_id
        LEFT JOIN store_owner_accounts oa ON oa.id = ms.owner_account_id
        LEFT JOIN xianyu_im_session_auth_cache xisc ON xisc.store_id = ms.id
        WHERE ${clauses.join(' AND ')}
        ORDER BY ms.id ASC
      `,
      params,
    );

    return (result.rows as Array<{
      storeId: number;
      shopName: string;
      managedProviderUserId: string | null;
      ownerName: string | null;
      credentialProviderUserId: string | null;
      accessTokenEncrypted: string;
      authSnapshotEncrypted: string | null;
    }>).map((row) => ({
      storeId: Number(row.storeId),
      shopName: String(row.shopName ?? ''),
      ownerName: row.ownerName?.trim() || String(row.shopName ?? ''),
      providerUserId:
        row.credentialProviderUserId?.trim() || row.managedProviderUserId?.trim() || '',
      cookieText: decryptSecret(String(row.accessTokenEncrypted), appConfig.secureConfigSecret),
      cachedSocketAuth: this.parseXianyuWebSocketAuthCache(row.authSnapshotEncrypted),
    }));
  }

  async listManagedStoreOrderSyncTargets(storeIds?: number[]) {
    return this.listManagedStoreProductSyncTargets(storeIds);
  }

  async listManagedStoreAiBargainSyncTargets(storeIds?: number[]): Promise<AiServiceSyncTarget[]> {
    return this.listManagedStoreProductSyncTargets(storeIds) as Promise<AiServiceSyncTarget[]>;
  }

  async getManagedStoreXianyuImSyncTarget(storeId: number): Promise<AiServiceSyncTarget | null> {
    const targets = await this.listManagedStoreAiBargainSyncTargets([storeId]);
    return targets[0] ?? null;
  }

  async getAiServiceConversationDispatchTarget(
    featureKey: string,
    conversationId: number,
  ): Promise<AiServiceDispatchTarget> {
    if (featureKey !== 'ai-service') {
      return null;
    }

    const result = await this.pool.query(
      `
        SELECT
          session_no AS "sessionNo",
          store_id AS "storeId",
          source
        FROM ai_service_conversations
        WHERE id = $1
        LIMIT 1
      `,
      [conversationId],
    );
    const row = result.rows[0] as
      | {
          sessionNo: string;
          storeId: number | null;
          source: string;
        }
      | undefined;
    if (!row?.storeId || String(row.source ?? '') !== 'real_session_sync') {
      return null;
    }

    const parsed = this.parseAiServiceRealSessionNo(String(row.sessionNo ?? ''));
    if (!parsed || parsed.storeId !== Number(row.storeId)) {
      return null;
    }

    return parsed;
  }

  async syncManagedStoreProducts(input: {
    storeId: number;
    items: Array<{
      id: string;
      title: string;
      categoryLabel: string;
      price: number;
      stock: number;
    }>;
  }) {
    const storeResult = await this.pool.query(
      `
        SELECT
          ms.id,
          ms.shop_name AS "shopName",
          COALESCE(oa.owner_name, ms.nickname, ms.shop_name) AS "ownerName"
        FROM managed_stores ms
        LEFT JOIN store_owner_accounts oa ON oa.id = ms.owner_account_id
        WHERE ms.id = $1
        LIMIT 1
      `,
      [input.storeId],
    );
    const store = storeResult.rows[0] as
      | {
          id: number;
          shopName: string;
          ownerName: string;
        }
      | undefined;
    if (!store) {
      return null;
    }

    const now = format(new Date(), 'yyyy-MM-dd HH:mm:ss');
    const client = await this.pool.connect();
    let transactionOpen = false;
    try {
      await client.query('BEGIN');
      transactionOpen = true;

      await client.query(
        `
          INSERT INTO stores (id, name, manager)
          VALUES ($1, $2, $3)
          ON CONFLICT (id) DO UPDATE SET
            name = EXCLUDED.name,
            manager = EXCLUDED.manager
        `,
        [store.id, store.shopName, store.ownerName],
      );

      let syncedCount = 0;
      let skippedCount = 0;
      for (const item of input.items) {
        const productId = Number(item.id);
        if (!Number.isSafeInteger(productId) || productId <= 0) {
          skippedCount += 1;
          continue;
        }

        await client.query(
          `
            INSERT INTO products (id, store_id, sku, name, category, price, cost, stock)
            VALUES ($1, $2, $3, $4, $5, $6, 0, $7)
            ON CONFLICT (id) DO UPDATE SET
              store_id = EXCLUDED.store_id,
              sku = EXCLUDED.sku,
              name = EXCLUDED.name,
              category = EXCLUDED.category,
              price = EXCLUDED.price,
              stock = EXCLUDED.stock
          `,
          [
            productId,
            store.id,
            item.id,
            item.title.trim() || `闲鱼商品 ${item.id}`,
            item.categoryLabel.trim() || '未分类',
            Number.isFinite(item.price) ? item.price : 0,
            Math.max(0, Math.trunc(item.stock)),
          ],
        );
        syncedCount += 1;
      }

      await this.markManagedStoreBusinessSyncHealthy(client, store.id, {
        detail: 'Real product sync finished successfully and the credential is healthy for business APIs.',
        verifiedAt: now,
      });

      await client.query('COMMIT');
      transactionOpen = false;

      return {
        storeId: store.id,
        shopName: store.shopName,
        syncedCount,
        skippedCount,
        syncedAt: now,
      };
    } catch (error) {
      if (transactionOpen) {
        await client.query('ROLLBACK');
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async syncManagedStoreOrders(input: {
    storeId: number;
    orders: Array<{
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
      events: Array<{
        eventType: string;
        eventTitle: string;
        eventDetail: string;
        operatorName: string | null;
        createdAt: string;
      }>;
    }>;
  }) {
    const storeResult = await this.pool.query(
      `
        SELECT
          ms.id,
          ms.shop_name AS "shopName",
          COALESCE(oa.owner_name, ms.nickname, ms.shop_name) AS "ownerName"
        FROM managed_stores ms
        LEFT JOIN store_owner_accounts oa ON oa.id = ms.owner_account_id
        WHERE ms.id = $1
        LIMIT 1
      `,
      [input.storeId],
    );
    const store = storeResult.rows[0] as
      | {
          id: number;
          shopName: string;
          ownerName: string;
        }
      | undefined;
    if (!store) {
      return null;
    }

    const now = format(new Date(), 'yyyy-MM-dd HH:mm:ss');
    const resolveSyntheticEntityId = (namespace: string, seed: string) => {
      const digest = createHash('sha1')
        .update(`${namespace}:${seed}`)
        .digest('hex')
        .slice(0, 12);
      return Number.parseInt(digest, 16);
    };
    const resolveProductId = (rawItemId: string | null, orderNo: string) => {
      const normalized = rawItemId?.trim() || '';
      if (/^\d+$/.test(normalized)) {
        const numeric = Number(normalized);
        if (Number.isSafeInteger(numeric) && numeric > 0) {
          return numeric;
        }
      }
      return resolveSyntheticEntityId('xianyu-product', normalized || orderNo);
    };
    const resolveDeliveryHours = (paidAt: string, shippedAt: string | null) => {
      if (!shippedAt) {
        return 0;
      }
      const paidTimestamp = Date.parse(paidAt.replace(' ', 'T'));
      const shippedTimestamp = Date.parse(shippedAt.replace(' ', 'T'));
      if (!Number.isFinite(paidTimestamp) || !Number.isFinite(shippedTimestamp) || shippedTimestamp < paidTimestamp) {
        return 0;
      }
      return Number(((shippedTimestamp - paidTimestamp) / 3600000).toFixed(1));
    };

    const client = await this.pool.connect();
    let transactionOpen = false;
    try {
      await client.query('BEGIN');
      transactionOpen = true;

      await client.query(
        `
          INSERT INTO stores (id, name, manager)
          VALUES ($1, $2, $3)
          ON CONFLICT (id) DO UPDATE SET
            name = EXCLUDED.name,
            manager = EXCLUDED.manager
        `,
        [store.id, store.shopName, store.ownerName],
      );

      const sortedOrders = [...input.orders].sort(
        (left, right) => left.paidAt.localeCompare(right.paidAt) || left.orderNo.localeCompare(right.orderNo),
      );

      let syncedCount = 0;
      let skippedCount = 0;
      for (const order of sortedOrders) {
        const orderNo = order.orderNo.trim();
        const paidAt = order.paidAt.trim();
        if (!orderNo || !paidAt) {
          skippedCount += 1;
          continue;
        }

        const productId = resolveProductId(order.itemId, orderNo);
        const existingProductResult = await client.query(
          `
            SELECT id, category, cost, stock
            FROM products
            WHERE id = $1
            LIMIT 1
          `,
          [productId],
        );
        const existingProduct = existingProductResult.rows[0] as
          | { id: number; category: string | null; cost: number | null; stock: number | null }
          | undefined;
        const productSku = order.itemId?.trim() || String(productId);
        const category = existingProduct?.category?.trim() || 'Xianyu real trade';
        const productName = order.itemTitle.trim() || `Xianyu order item ${orderNo}`;
        await client.query(
          `
            INSERT INTO products (id, store_id, sku, name, category, price, cost, stock)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            ON CONFLICT (id) DO UPDATE SET
              store_id = EXCLUDED.store_id,
              sku = EXCLUDED.sku,
              name = EXCLUDED.name,
              category = CASE
                WHEN COALESCE(products.category, '') = '' OR products.category = 'Uncategorized' THEN EXCLUDED.category
                ELSE products.category
              END,
              price = EXCLUDED.price
          `,
          [
            productId,
            store.id,
            productSku,
            productName,
            category,
            Number.isFinite(order.unitPrice) ? order.unitPrice : 0,
            toNumber(existingProduct?.cost),
            toNumber(existingProduct?.stock),
          ],
        );

        const externalCustomerId =
          order.buyerUserId?.trim() ||
          (order.buyerName?.trim() ? `nick:${order.buyerName.trim()}` : `trade:${orderNo}`);
        const customerRefResult = await client.query(
          `
            SELECT customer_id AS "customerId"
            FROM customer_external_refs
            WHERE provider = $1
              AND external_customer_id = $2
            LIMIT 1
          `,
          ['xianyu', externalCustomerId],
        );
        let customerId =
          customerRefResult.rows[0] && Number(customerRefResult.rows[0].customerId) > 0
            ? Number(customerRefResult.rows[0].customerId)
            : null;
        const customerName = order.buyerName?.trim() || `Xianyu buyer ${externalCustomerId}`;
        if (!customerId) {
          const insertedCustomer = await client.query(
            `
              INSERT INTO customers (name, province, registered_at)
              VALUES ($1, $2, $3)
              RETURNING id
            `,
            [customerName, 'Unknown', paidAt],
          );
          customerId = Number(insertedCustomer.rows[0]?.id);
          await client.query(
            `
              INSERT INTO customer_external_refs (provider, external_customer_id, customer_id, created_at)
              VALUES ($1, $2, $3, $4)
              ON CONFLICT (provider, external_customer_id) DO UPDATE SET
                customer_id = EXCLUDED.customer_id
            `,
            ['xianyu', externalCustomerId, customerId, now],
          );
        } else {
          await client.query(
            `
              UPDATE customers
              SET name = $1,
                  province = $2
              WHERE id = $3
            `,
            [customerName, 'Unknown', customerId],
          );
        }

        const refundAmount = Math.max(0, Number((order.refundAmount ?? 0).toFixed(2)));
        const paidAmount = Math.max(0, Number((order.paidAmount ?? 0).toFixed(2)));
        const discountAmount = Math.max(0, Number((order.discountAmount ?? 0).toFixed(2)));
        const grossAmount = Number((paidAmount + discountAmount).toFixed(2));
        const paymentStatus: OrderPaymentStatus =
          refundAmount >= paidAmount && paidAmount > 0
            ? 'refunded_full'
            : refundAmount > 0
              ? 'refunded_partial'
              : 'paid';
        const deliveryStatus: OrderDeliveryStatus = order.completedAt
          ? 'delivered'
          : order.shippedAt
            ? 'shipped'
            : 'pending';
        const orderStatus = order.completedAt ? 'completed' : order.shippedAt ? 'shipped' : 'pending_shipment';
        const deliveryHours = resolveDeliveryHours(paidAt, order.shippedAt);
        const existingOrderResult = await client.query(
          `
            SELECT id, buyer_note AS "buyerNote", seller_remark AS "sellerRemark"
            FROM orders
            WHERE order_no = $1
            LIMIT 1
          `,
          [orderNo],
        );
        const existingOrder = existingOrderResult.rows[0] as
          | { id: number; buyerNote: string | null; sellerRemark: string | null }
          | undefined;
        const customerOrderCountResult = await client.query(
          `
            SELECT COUNT(*) AS total
            FROM orders
            WHERE customer_id = $1
              AND order_no <> $2
          `,
          [customerId, orderNo],
        );
        const isNewCustomer = toNumber(customerOrderCountResult.rows[0]?.total) === 0 ? 1 : 0;
        const orderPayload = [
          orderNo,
          store.id,
          productId,
          customerId,
          'Xianyu real trade',
          Math.max(1, Math.trunc(order.quantity || 1)),
          paidAmount,
          discountAmount,
          orderStatus,
          'completed' as OrderMainStatus,
          paymentStatus,
          deliveryStatus,
          refundAmount > 0 ? 'resolved' : 'none',
          refundAmount,
          paidAt,
          order.shippedAt?.trim() || null,
          order.completedAt?.trim() || null,
          deliveryHours,
          isNewCustomer,
          existingOrder?.buyerNote ?? '',
          existingOrder?.sellerRemark ?? '',
          paidAt,
          now,
        ];

        let orderId = existingOrder ? Number(existingOrder.id) : null;
        if (orderId) {
          await client.query(
            `
              UPDATE orders
              SET
                store_id = $2,
                product_id = $3,
                customer_id = $4,
                source = $5,
                quantity = $6,
                paid_amount = $7,
                discount_amount = $8,
                order_status = $9,
                main_status = $10,
                payment_status = $11,
                delivery_status = $12,
                after_sale_status = $13,
                refund_amount = $14,
                paid_at = $15,
                shipped_at = $16,
                completed_at = $17,
                delivery_hours = $18,
                is_new_customer = $19,
                buyer_note = $20,
                seller_remark = $21,
                updated_at = $23
              WHERE order_no = $1
            `,
            orderPayload,
          );
        } else {
          const insertedOrder = await client.query(
            `
              INSERT INTO orders (
                order_no,
                store_id,
                product_id,
                customer_id,
                source,
                quantity,
                paid_amount,
                discount_amount,
                order_status,
                main_status,
                payment_status,
                delivery_status,
                after_sale_status,
                refund_amount,
                paid_at,
                shipped_at,
                completed_at,
                delivery_hours,
                is_new_customer,
                buyer_note,
                seller_remark,
                created_at,
                updated_at
              ) VALUES (
                $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23
              )
              RETURNING id
            `,
            orderPayload,
          );
          orderId = Number(insertedOrder.rows[0]?.id);
        }

        await client.query('DELETE FROM order_items WHERE order_id = $1', [orderId]);
        await client.query("DELETE FROM order_events WHERE order_id = $1 AND event_type LIKE 'xianyu_%'", [orderId]);

        await client.query(
          `
            INSERT INTO order_items (
              order_id,
              line_no,
              product_id,
              product_name_snapshot,
              sku_snapshot,
              category_snapshot,
              quantity,
              unit_price,
              paid_amount,
              delivery_status,
              after_sale_status,
              created_at,
              updated_at
            ) VALUES (
              $1, 1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12
            )
          `,
          [
            orderId,
            productId,
            productName,
            productSku,
            category,
            Math.max(1, Math.trunc(order.quantity || 1)),
            Number.isFinite(order.unitPrice) ? order.unitPrice : 0,
            paidAmount,
            deliveryStatus,
            refundAmount > 0 ? 'resolved' : 'none',
            paidAt,
            now,
          ],
        );

        const paymentNo = order.paymentNo?.trim() || `XYPAY-${orderNo}`;
        const settledAt = order.completedAt?.trim() || order.shippedAt?.trim() || paidAt;
        const existingPaymentResult = await client.query(
          `
            SELECT id
            FROM order_payments
            WHERE order_id = $1
            ORDER BY id ASC
            LIMIT 1
          `,
          [orderId],
        );
        const existingPaymentId =
          existingPaymentResult.rows[0] && Number(existingPaymentResult.rows[0].id) > 0
            ? Number(existingPaymentResult.rows[0].id)
            : null;
        if (existingPaymentId) {
          await client.query(
            `
              UPDATE order_payments
              SET
                order_id = $1,
                payment_no = $2,
                payment_channel = 'Alipay',
                payment_status = $3,
                gross_amount = $4,
                discount_amount = $5,
                paid_amount = $6,
                paid_at = $7,
                settled_at = $8,
                updated_at = $9
              WHERE id = $10
            `,
            [
              orderId,
              paymentNo,
              paymentStatus,
              grossAmount,
              discountAmount,
              paidAmount,
              paidAt,
              settledAt,
              now,
              existingPaymentId,
            ],
          );
        } else {
          await client.query(
            `
              INSERT INTO order_payments (
                order_id,
                payment_no,
                payment_channel,
                payment_status,
                gross_amount,
                discount_amount,
                paid_amount,
                paid_at,
                settled_at,
                created_at,
                updated_at
              ) VALUES (
                $1, $2, 'Alipay', $3, $4, $5, $6, $7, $8, $9, $10
              )
            `,
            [orderId, paymentNo, paymentStatus, grossAmount, discountAmount, paidAmount, paidAt, settledAt, paidAt, now],
          );
        }

        const events =
          order.events.length > 0
            ? order.events
            : [
                {
                  eventType: 'xianyu_completed',
                  eventTitle: order.orderStatusName?.trim() || 'Trade completed',
                  eventDetail: 'Xianyu completed order synced.',
                  operatorName: null,
                  createdAt: order.completedAt?.trim() || paidAt,
                },
              ];

        for (const event of events) {
          await client.query(
            `
              INSERT INTO order_events (
                order_id,
                event_type,
                event_title,
                event_detail,
                operator_name,
                created_at
              ) VALUES (
                $1, $2, $3, $4, $5, $6
              )
            `,
            [
              orderId,
              event.eventType.trim() || 'xianyu_event',
              event.eventTitle.trim() || 'Xianyu order event',
              event.eventDetail.trim() || 'Xianyu order status updated.',
              event.operatorName?.trim() || null,
              event.createdAt.trim() || paidAt,
            ],
          );
        }

        syncedCount += 1;
      }

      await this.markManagedStoreBusinessSyncHealthy(client, store.id, {
        detail: 'Real order sync finished successfully and the credential is healthy for business APIs.',
        verifiedAt: now,
      });

      await client.query('COMMIT');
      transactionOpen = false;

      return {
        storeId: store.id,
        shopName: store.shopName,
        syncedCount,
        skippedCount,
        syncedAt: now,
      };
    } catch (error) {
      if (transactionOpen) {
        await client.query('ROLLBACK');
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async getFilterOptions(fallback: FilterOptions): Promise<FilterOptions> {
    try {
      const [stores, products, categories, sources] = await Promise.all([
        this.pool.query(`SELECT id AS value, name AS label FROM stores ORDER BY id`),
        this.pool.query(`SELECT id AS value, name AS label FROM products ORDER BY name`),
        this.pool.query(
          `SELECT DISTINCT category AS value, category AS label FROM products WHERE category IS NOT NULL AND category != '' ORDER BY category`,
        ),
        this.pool.query(
          `SELECT DISTINCT source AS value, source AS label FROM orders WHERE source IS NOT NULL AND source != '' ORDER BY source`,
        ),
      ]);

      return {
        stores: stores.rows.map((row) => ({ value: Number(row.value), label: String(row.label) })),
        products: products.rows.map((row) => ({
          value: Number(row.value),
          label: String(row.label),
        })),
        categories: categories.rows.map((row) => ({
          value: String(row.value),
          label: String(row.label),
        })),
        sources: sources.rows.map((row) => ({ value: String(row.value), label: String(row.label) })),
      };
    } catch {
      return fallback;
    }
  }

  async getOrdersOverview(filters: QueryFilters): Promise<OrdersOverview> {
    const range = resolveDateRange(filters);
    const { whereSql, values } = buildOrderFilter(filters, range);
    const summary = await this.pool.query(
      `
        SELECT
          COUNT(*) AS "totalOrders",
          SUM(CASE WHEN o.main_status = 'paid' THEN 1 ELSE 0 END) AS "paidOrders",
          SUM(CASE WHEN o.main_status = 'processing' THEN 1 ELSE 0 END) AS "processingOrders",
          SUM(CASE WHEN o.main_status = 'fulfilled' THEN 1 ELSE 0 END) AS "fulfilledOrders",
          SUM(CASE WHEN o.main_status = 'completed' THEN 1 ELSE 0 END) AS "mainCompletedOrders",
          SUM(CASE WHEN o.main_status = 'after_sale' THEN 1 ELSE 0 END) AS "mainAfterSaleOrders",
          SUM(CASE WHEN o.order_status = 'pending_shipment' THEN 1 ELSE 0 END) AS "pendingShipment",
          SUM(CASE WHEN o.order_status = 'shipped' THEN 1 ELSE 0 END) AS "shippedOrders",
          SUM(CASE WHEN o.order_status = 'completed' THEN 1 ELSE 0 END) AS "completedOrders",
          SUM(CASE WHEN o.after_sale_status != 'none' THEN 1 ELSE 0 END) AS "afterSaleOrders",
          AVG(NULLIF(o.delivery_hours, 0)) AS "averageDeliveryHours",
          SUM(o.paid_amount) AS "salesAmount"
        FROM orders o
        LEFT JOIN products p ON p.id = o.product_id
        LEFT JOIN customers c ON c.id = o.customer_id
        ${whereSql}
      `,
      values,
    );
    const row = summary.rows[0] ?? {};
    return {
      totalOrders: toNumber(row.totalOrders),
      paidOrders: toNumber(row.paidOrders),
      processingOrders: toNumber(row.processingOrders),
      fulfilledOrders: toNumber(row.fulfilledOrders),
      mainCompletedOrders: toNumber(row.mainCompletedOrders),
      mainAfterSaleOrders: toNumber(row.mainAfterSaleOrders),
      pendingShipment: toNumber(row.pendingShipment),
      shippedOrders: toNumber(row.shippedOrders),
      completedOrders: toNumber(row.completedOrders),
      afterSaleOrders: toNumber(row.afterSaleOrders),
      averageDeliveryHours: toNumber(row.averageDeliveryHours, 1),
      salesAmount: toNumber(row.salesAmount, 2),
    };
  }

  async getOrdersList(
    filters: QueryFilters,
    pagination: PaginationParams,
  ): Promise<OrdersListResult> {
    const range = resolveDateRange(filters);
    const { whereSql, values } = buildOrderFilter(filters, range);
    const orderBy = this.resolveOrderSort(filters.sortBy, filters.sortOrder);
    const page = Math.max(pagination.page, 1);
    const pageSize = Math.max(Math.min(pagination.pageSize, 100), 1);

    const [countResult, rowsResult] = await Promise.all([
      this.pool.query(
        `
          SELECT COUNT(*) AS total
          FROM orders o
          LEFT JOIN products p ON p.id = o.product_id
          LEFT JOIN customers c ON c.id = o.customer_id
          ${whereSql}
        `,
        values,
      ),
      this.pool.query(
        `
          SELECT
            o.id,
            o.order_no AS "orderNo",
            o.store_id AS "storeId",
            s.name AS "storeName",
            o.product_id AS "productId",
            p.name AS "productName",
            p.sku AS "productSku",
            p.category AS category,
            o.customer_id AS "customerId",
            c.name AS "customerName",
            o.quantity,
            o.paid_amount AS "paidAmount",
            o.discount_amount AS "discountAmount",
            o.refund_amount AS "refundAmount",
            o.main_status AS "mainStatus",
            o.delivery_status AS "deliveryStatus",
            o.payment_status AS "paymentStatus",
            o.order_status AS "orderStatus",
            o.after_sale_status AS "afterSaleStatus",
            o.source,
            o.paid_at AS "paidAt",
            o.shipped_at AS "shippedAt",
            o.completed_at AS "completedAt",
            o.updated_at AS "updatedAt",
            (
              SELECT MAX(oe.created_at)
              FROM order_events oe
              WHERE oe.order_id = o.id
            ) AS "latestEventAt"
          FROM orders o
          LEFT JOIN products p ON p.id = o.product_id
          LEFT JOIN stores s ON s.id = o.store_id
          LEFT JOIN customers c ON c.id = o.customer_id
          ${whereSql}
          ORDER BY ${orderBy}
          LIMIT $${values.length + 1} OFFSET $${values.length + 2}
        `,
        [...values, pageSize, (page - 1) * pageSize],
      ),
    ]);

    const fulfillmentMetaMap = await this.loadOrderFulfillmentMeta(
      rowsResult.rows.map((row) => toNumber(row.id)),
    );

    return {
      total: toNumber(countResult.rows[0]?.total),
      page,
      pageSize,
      list: rowsResult.rows.map((row) => {
        const mainStatus = String(row.mainStatus ?? '') as OrderMainStatus;
        const deliveryStatus = String(row.deliveryStatus ?? '') as OrderDeliveryStatus;
        const paymentStatus = String(row.paymentStatus ?? '') as OrderPaymentStatus;
        const fulfillmentMeta = fulfillmentMetaMap.get(toNumber(row.id));
        return {
          id: toNumber(row.id),
          orderNo: String(row.orderNo ?? ''),
          storeId: toNumber(row.storeId),
          storeName: String(row.storeName ?? ''),
          productId: toNumber(row.productId),
          productName: String(row.productName ?? ''),
          productSku: String(row.productSku ?? ''),
          category: String(row.category ?? ''),
          customerId: toNumber(row.customerId),
          customerName: String(row.customerName ?? ''),
          quantity: toNumber(row.quantity),
          paidAmount: toNumber(row.paidAmount, 2),
          discountAmount: toNumber(row.discountAmount, 2),
          refundAmount: toNumber(row.refundAmount, 2),
          mainStatus,
          mainStatusText: getOrderMainStatusText(mainStatus),
          deliveryStatus,
          deliveryStatusText: getOrderDeliveryStatusText(deliveryStatus),
          paymentStatus,
          paymentStatusText: getOrderPaymentStatusText(paymentStatus),
          orderStatus: String(row.orderStatus ?? ''),
          afterSaleStatus: String(row.afterSaleStatus ?? ''),
          source: String(row.source ?? ''),
          paidAt: String(row.paidAt ?? ''),
          shippedAt: row.shippedAt ? String(row.shippedAt) : null,
          completedAt: row.completedAt ? String(row.completedAt) : null,
          updatedAt: String(row.updatedAt ?? ''),
          latestEventAt: row.latestEventAt ? String(row.latestEventAt) : null,
          fulfillmentType: fulfillmentMeta?.fulfillmentType ?? 'standard',
          fulfillmentTypeText:
            fulfillmentMeta?.fulfillmentTypeText ?? getOrderFulfillmentTypeText('standard'),
          fulfillmentQueue: fulfillmentMeta?.fulfillmentQueue ?? 'pending',
          fulfillmentQueueText:
            fulfillmentMeta?.fulfillmentQueueText ?? getOrderFulfillmentQueueText('pending'),
          fulfillmentStage: fulfillmentMeta?.fulfillmentStage ?? DEFAULT_FULFILLMENT_STAGE,
          fulfillmentStageDetail:
            fulfillmentMeta?.fulfillmentStageDetail ?? DEFAULT_FULFILLMENT_STAGE_DETAIL,
        };
      }),
    };
  }

  async getOrderDetail(orderId: number): Promise<OrderDetailResult> {
    const orderResult = await this.pool.query(
      `
        SELECT
          o.id,
          o.order_no AS "orderNo",
          o.store_id AS "storeId",
          s.name AS "storeName",
          o.product_id AS "productId",
          p.name AS "productName",
          p.sku AS "productSku",
          p.category AS category,
          o.customer_id AS "customerId",
          c.name AS "customerName",
          c.province AS "customerProvince",
          o.source,
          o.quantity,
          o.paid_amount AS "paidAmount",
          o.discount_amount AS "discountAmount",
          o.refund_amount AS "refundAmount",
          o.main_status AS "mainStatus",
          o.payment_status AS "paymentStatus",
          o.delivery_status AS "deliveryStatus",
          o.order_status AS "orderStatus",
          o.after_sale_status AS "afterSaleStatus",
          o.paid_at AS "paidAt",
          o.shipped_at AS "shippedAt",
          o.completed_at AS "completedAt",
          o.delivery_hours AS "deliveryHours",
          o.is_new_customer AS "isNewCustomer",
          o.buyer_note AS "buyerNote",
          o.seller_remark AS "sellerRemark",
          o.created_at AS "createdAt",
          o.updated_at AS "updatedAt"
        FROM orders o
        LEFT JOIN stores s ON s.id = o.store_id
        LEFT JOIN products p ON p.id = o.product_id
        LEFT JOIN customers c ON c.id = o.customer_id
        WHERE o.id = $1
      `,
      [orderId],
    );
    const order = orderResult.rows[0];
    if (!order) {
      return null;
    }

    const [itemsResult, paymentsResult, eventsResult, fulfillmentMetaMap] = await Promise.all([
      this.pool.query(
        `
          SELECT
            id,
            line_no AS "lineNo",
            product_id AS "productId",
            product_name_snapshot AS "productName",
            sku_snapshot AS "productSku",
            category_snapshot AS category,
            quantity,
            unit_price AS "unitPrice",
            paid_amount AS "paidAmount",
            delivery_status AS "deliveryStatus",
            after_sale_status AS "afterSaleStatus",
            created_at AS "createdAt",
            updated_at AS "updatedAt"
          FROM order_items
          WHERE order_id = $1
          ORDER BY line_no ASC, id ASC
        `,
        [orderId],
      ),
      this.pool.query(
        `
          SELECT
            id,
            payment_no AS "paymentNo",
            payment_channel AS "paymentChannel",
            payment_status AS "paymentStatus",
            gross_amount AS "grossAmount",
            discount_amount AS "discountAmount",
            paid_amount AS "paidAmount",
            paid_at AS "paidAt",
            settled_at AS "settledAt",
            created_at AS "createdAt",
            updated_at AS "updatedAt"
          FROM order_payments
          WHERE order_id = $1
          ORDER BY paid_at ASC, id ASC
        `,
        [orderId],
      ),
      this.pool.query(
        `
          SELECT
            id,
            event_type AS "eventType",
            event_title AS "eventTitle",
            event_detail AS "eventDetail",
            operator_name AS "operatorName",
            created_at AS "createdAt"
          FROM order_events
          WHERE order_id = $1
          ORDER BY created_at ASC, id ASC
        `,
        [orderId],
      ),
      this.loadOrderFulfillmentMeta([orderId]),
    ]);

    const fulfillmentMeta = fulfillmentMetaMap.get(orderId);
    const events = eventsResult.rows.map((row) => ({
      id: toNumber(row.id),
      eventType: String(row.eventType ?? ''),
      eventTitle: String(row.eventTitle ?? ''),
      eventDetail: String(row.eventDetail ?? ''),
      operatorName: row.operatorName ? String(row.operatorName) : null,
      createdAt: String(row.createdAt ?? ''),
    }));
    const fulfillmentLogs = events.filter((event) =>
      /^card_|^direct_charge_|^fulfillment_/.test(event.eventType),
    );
    const mainStatus = String(order.mainStatus ?? '') as OrderMainStatus;
    const paymentStatus = String(order.paymentStatus ?? '') as OrderPaymentStatus;
    const deliveryStatus = String(order.deliveryStatus ?? '') as OrderDeliveryStatus;

    return {
      order: {
        id: toNumber(order.id),
        orderNo: String(order.orderNo ?? ''),
        storeId: toNumber(order.storeId),
        storeName: String(order.storeName ?? ''),
        productId: toNumber(order.productId),
        productName: String(order.productName ?? ''),
        productSku: String(order.productSku ?? ''),
        category: String(order.category ?? ''),
        customerId: toNumber(order.customerId),
        customerName: String(order.customerName ?? ''),
        customerProvince: String(order.customerProvince ?? ''),
        source: String(order.source ?? ''),
        quantity: toNumber(order.quantity),
        paidAmount: toNumber(order.paidAmount, 2),
        discountAmount: toNumber(order.discountAmount, 2),
        refundAmount: toNumber(order.refundAmount, 2),
        mainStatus,
        mainStatusText: getOrderMainStatusText(mainStatus),
        paymentStatus,
        paymentStatusText: getOrderPaymentStatusText(paymentStatus),
        deliveryStatus,
        deliveryStatusText: getOrderDeliveryStatusText(deliveryStatus),
        orderStatus: String(order.orderStatus ?? ''),
        afterSaleStatus: String(order.afterSaleStatus ?? ''),
        paidAt: String(order.paidAt ?? ''),
        shippedAt: order.shippedAt ? String(order.shippedAt) : null,
        completedAt: order.completedAt ? String(order.completedAt) : null,
        deliveryHours: toNumber(order.deliveryHours, 2),
        isNewCustomer: Boolean(toNumber(order.isNewCustomer)),
        buyerNote: String(order.buyerNote ?? ''),
        sellerRemark: String(order.sellerRemark ?? ''),
        createdAt: String(order.createdAt ?? ''),
        updatedAt: String(order.updatedAt ?? ''),
        fulfillmentType: fulfillmentMeta?.fulfillmentType ?? 'standard',
        fulfillmentTypeText:
          fulfillmentMeta?.fulfillmentTypeText ?? getOrderFulfillmentTypeText('standard'),
        fulfillmentQueue: fulfillmentMeta?.fulfillmentQueue ?? 'pending',
        fulfillmentQueueText:
          fulfillmentMeta?.fulfillmentQueueText ?? getOrderFulfillmentQueueText('pending'),
        fulfillmentStage: fulfillmentMeta?.fulfillmentStage ?? DEFAULT_FULFILLMENT_STAGE,
        fulfillmentStageDetail:
          fulfillmentMeta?.fulfillmentStageDetail ?? DEFAULT_FULFILLMENT_STAGE_DETAIL,
      },
      items: itemsResult.rows.map((row) => {
        const itemDeliveryStatus = String(row.deliveryStatus ?? '') as OrderDeliveryStatus;
        return {
          id: toNumber(row.id),
          lineNo: toNumber(row.lineNo),
          productId: toNumber(row.productId),
          productName: String(row.productName ?? ''),
          productSku: String(row.productSku ?? ''),
          category: String(row.category ?? ''),
          quantity: toNumber(row.quantity),
          unitPrice: toNumber(row.unitPrice, 2),
          paidAmount: toNumber(row.paidAmount, 2),
          deliveryStatus: itemDeliveryStatus,
          deliveryStatusText: getOrderDeliveryStatusText(itemDeliveryStatus),
          afterSaleStatus: String(row.afterSaleStatus ?? ''),
          createdAt: String(row.createdAt ?? ''),
          updatedAt: String(row.updatedAt ?? ''),
        };
      }),
      payments: paymentsResult.rows.map((row) => {
        const paymentRowStatus = String(row.paymentStatus ?? '') as OrderPaymentStatus;
        return {
          id: toNumber(row.id),
          paymentNo: String(row.paymentNo ?? ''),
          paymentChannel: String(row.paymentChannel ?? ''),
          paymentStatus: paymentRowStatus,
          paymentStatusText: getOrderPaymentStatusText(paymentRowStatus),
          grossAmount: toNumber(row.grossAmount, 2),
          discountAmount: toNumber(row.discountAmount, 2),
          paidAmount: toNumber(row.paidAmount, 2),
          paidAt: String(row.paidAt ?? ''),
          settledAt: row.settledAt ? String(row.settledAt) : null,
          createdAt: String(row.createdAt ?? ''),
          updatedAt: String(row.updatedAt ?? ''),
        };
      }),
      events,
      fulfillment: {
        type: fulfillmentMeta?.fulfillmentType ?? 'standard',
        typeText: fulfillmentMeta?.fulfillmentTypeText ?? getOrderFulfillmentTypeText('standard'),
        queue: fulfillmentMeta?.fulfillmentQueue ?? 'pending',
        queueText: fulfillmentMeta?.fulfillmentQueueText ?? getOrderFulfillmentQueueText('pending'),
        stage: fulfillmentMeta?.fulfillmentStage ?? DEFAULT_FULFILLMENT_STAGE,
        stageDetail: fulfillmentMeta?.fulfillmentStageDetail ?? DEFAULT_FULFILLMENT_STAGE_DETAIL,
        latestTaskNo: fulfillmentMeta?.latestTaskNo ?? null,
        latestSupplierOrderNo: fulfillmentMeta?.latestSupplierOrderNo ?? null,
        latestOutboundNo: fulfillmentMeta?.latestOutboundNo ?? null,
        retryCount: fulfillmentMeta?.retryCount ?? 0,
        maxRetry: fulfillmentMeta?.maxRetry ?? 0,
        manualReason: fulfillmentMeta?.manualReason ?? null,
        latestLogTitle: fulfillmentMeta?.latestLogTitle ?? null,
        latestLogDetail: fulfillmentMeta?.latestLogDetail ?? null,
        latestLogAt: fulfillmentMeta?.latestLogAt ?? null,
        canRetry: fulfillmentMeta?.canRetry ?? false,
        canResend: fulfillmentMeta?.canResend ?? false,
        canTerminate: fulfillmentMeta?.canTerminate ?? false,
        canNote: fulfillmentMeta?.canNote ?? true,
      },
      fulfillmentLogs,
    };
  }

  async exportOrdersCsv(filters: QueryFilters): Promise<OrdersExportCsv> {
    const rows = (await this.getOrdersList(filters, { page: 1, pageSize: 5000 })).list;
    const headers = [
      'Order No',
      'Store',
      'Product',
      'SKU',
      'Category',
      'Customer',
      'Quantity',
      'Paid Amount',
      'Main Status',
      'Delivery Status',
      'Payment Status',
      'After-sale Status',
      'Source',
      'Paid At',
      'Completed At',
    ];
    return [
      headers.join(','),
      ...rows.map((row) =>
        [
          row.orderNo,
          row.storeName,
          row.productName,
          row.productSku,
          row.category,
          row.customerName,
          row.quantity,
          row.paidAmount,
          row.mainStatusText,
          row.deliveryStatusText,
          row.paymentStatusText,
          row.afterSaleStatus,
          row.source,
          row.paidAt,
          row.completedAt,
        ]
          .map((value) => escapeCsvCell(value))
          .join(','),
      ),
    ].join('\n');
  }

  async getOrderFulfillmentWorkbench(filters: QueryFilters): Promise<OrderFulfillmentWorkbench> {
    const range = resolveDateRange(filters);
    const { whereSql, values } = buildOrderFilter(filters, range);
    const [rowsResult, logsResult] = await Promise.all([
      this.pool.query(
        `
          SELECT
            o.id,
            o.order_no AS "orderNo",
            o.store_id AS "storeId",
            s.name AS "storeName",
            p.name AS "productName",
            o.paid_amount AS "paidAmount",
            o.main_status AS "mainStatus",
            o.delivery_status AS "deliveryStatus",
            o.updated_at AS "updatedAt"
          FROM orders o
          LEFT JOIN stores s ON s.id = o.store_id
          LEFT JOIN products p ON p.id = o.product_id
          LEFT JOIN customers c ON c.id = o.customer_id
          ${whereSql}
          ORDER BY o.updated_at DESC, o.id DESC
        `,
        values,
      ),
      this.pool.query(
        `
          SELECT
            oe.id,
            o.id AS "orderId",
            o.order_no AS "orderNo",
            s.name AS "storeName",
            p.name AS "productName",
            oe.event_type AS "eventType",
            oe.event_title AS "eventTitle",
            oe.event_detail AS "eventDetail",
            oe.operator_name AS "operatorName",
            oe.created_at AS "createdAt"
          FROM order_events oe
          INNER JOIN orders o ON o.id = oe.order_id
          LEFT JOIN stores s ON s.id = o.store_id
          LEFT JOIN products p ON p.id = o.product_id
          LEFT JOIN customers c ON c.id = o.customer_id
          ${whereSql ? `${whereSql} AND (` : 'WHERE ('}
            oe.event_type LIKE 'card_%'
            OR oe.event_type LIKE 'direct_charge_%'
            OR oe.event_type LIKE 'fulfillment_%'
          )
          ORDER BY oe.created_at DESC, oe.id DESC
          LIMIT 24
        `,
        values,
      ),
    ]);

    const metaMap = await this.loadOrderFulfillmentMeta(rowsResult.rows.map((row) => toNumber(row.id)));
    const enrichedRows = rowsResult.rows.map((row) => {
      const orderId = toNumber(row.id);
      const mainStatus = String(row.mainStatus ?? '') as OrderMainStatus;
      const deliveryStatus = String(row.deliveryStatus ?? '') as OrderDeliveryStatus;
      const meta = metaMap.get(orderId);
      return {
        id: orderId,
        orderNo: String(row.orderNo ?? ''),
        storeId: toNumber(row.storeId),
        storeName: String(row.storeName ?? ''),
        productName: String(row.productName ?? ''),
        paidAmount: toNumber(row.paidAmount, 2),
        mainStatus,
        deliveryStatus,
        updatedAt: String(row.updatedAt ?? ''),
        fulfillmentType: meta?.fulfillmentType ?? ('standard' as OrderFulfillmentType),
        fulfillmentTypeText:
          meta?.fulfillmentTypeText ?? getOrderFulfillmentTypeText('standard'),
        fulfillmentQueue: meta?.fulfillmentQueue ?? ('pending' as OrderFulfillmentQueue),
        fulfillmentQueueText:
          meta?.fulfillmentQueueText ?? getOrderFulfillmentQueueText('pending'),
        fulfillmentStage: meta?.fulfillmentStage ?? DEFAULT_FULFILLMENT_STAGE,
        fulfillmentStageDetail:
          meta?.fulfillmentStageDetail ?? DEFAULT_FULFILLMENT_STAGE_DETAIL,
      };
    });

    const queueSummary = enrichedRows.reduce(
      (accumulator, row) => {
        accumulator.total += 1;
        accumulator[row.fulfillmentQueue] += 1;
        return accumulator;
      },
      {
        total: 0,
        pending: 0,
        processing: 0,
        success: 0,
        failed: 0,
        manual_review: 0,
      },
    );

    const storeStats = Array.from(
      enrichedRows.reduce<
        Map<
          number,
          {
            storeId: number;
            storeName: string;
            totalOrders: number;
            successCount: number;
            failedCount: number;
            manualCount: number;
            processingCount: number;
          }
        >
      >((accumulator, row) => {
        const current = accumulator.get(row.storeId) ?? {
          storeId: row.storeId,
          storeName: row.storeName,
          totalOrders: 0,
          successCount: 0,
          failedCount: 0,
          manualCount: 0,
          processingCount: 0,
        };
        current.totalOrders += 1;
        if (row.fulfillmentQueue === 'success') {
          current.successCount += 1;
        }
        if (row.fulfillmentQueue === 'failed') {
          current.failedCount += 1;
        }
        if (row.fulfillmentQueue === 'manual_review') {
          current.manualCount += 1;
        }
        if (row.fulfillmentQueue === 'processing') {
          current.processingCount += 1;
        }
        accumulator.set(row.storeId, current);
        return accumulator;
      }, new Map()),
    )
      .map(([, value]) => ({
        ...value,
        successRate: value.totalOrders > 0 ? Number(((value.successCount / value.totalOrders) * 100).toFixed(1)) : 0,
        failedRate: value.totalOrders > 0 ? Number(((value.failedCount / value.totalOrders) * 100).toFixed(1)) : 0,
        manualRate: value.totalOrders > 0 ? Number(((value.manualCount / value.totalOrders) * 100).toFixed(1)) : 0,
      }))
      .sort((left, right) => right.totalOrders - left.totalOrders || left.storeId - right.storeId);

    return {
      queueSummary,
      exceptionOrders: enrichedRows
        .filter((row) => ['failed', 'manual_review'].includes(row.fulfillmentQueue))
        .slice(0, 12),
      logs: logsResult.rows.map((row) => ({
        id: toNumber(row.id),
        orderId: toNumber(row.orderId),
        orderNo: String(row.orderNo ?? ''),
        storeName: String(row.storeName ?? ''),
        productName: String(row.productName ?? ''),
        eventType: String(row.eventType ?? ''),
        eventTitle: String(row.eventTitle ?? ''),
        eventDetail: String(row.eventDetail ?? ''),
        operatorName: row.operatorName ? String(row.operatorName) : null,
        createdAt: String(row.createdAt ?? ''),
      })),
      storeStats,
    };
  }

  async getAfterSaleWorkbench(filters: QueryFilters): Promise<AfterSaleWorkbenchResult> {
    const range = resolveDateRange(filters);
    const { whereSql, values } = buildAfterSaleFilter(filters, range);
    const [summaryResult, remindersResult, listRowsResult] = await Promise.all([
      this.pool.query(
        `
          SELECT
            COUNT(*) AS "totalCases",
            COUNT(*) FILTER (WHERE ac.case_status IN ('pending_review', 'processing', 'waiting_execute')) AS "pendingCases",
            COUNT(*) FILTER (WHERE ac.case_status = 'processing') AS "processingCases",
            COUNT(*) FILTER (WHERE ac.case_status = 'resolved') AS "resolvedCases",
            COUNT(*) FILTER (WHERE ac.case_type = 'refund') AS "refundCases",
            COUNT(*) FILTER (WHERE ac.case_type = 'resend') AS "resendCases",
            COUNT(*) FILTER (WHERE ac.case_type = 'dispute') AS "disputeCases",
            COUNT(*) FILTER (WHERE COALESCE(reminder_summary."hasTimeoutReminder", 0) = 1) AS "timeoutCases",
            SUM(CASE WHEN rf.refund_status IN ('pending_review', 'approved') THEN COALESCE(rf.requested_amount, 0) ELSE 0 END) AS "pendingRefundAmount"
          FROM after_sale_cases ac
          INNER JOIN orders o ON o.id = ac.order_id
          LEFT JOIN products p ON p.id = o.product_id
          LEFT JOIN stores s ON s.id = o.store_id
          LEFT JOIN customers c ON c.id = o.customer_id
          LEFT JOIN after_sale_refunds rf ON rf.case_id = ac.id
          LEFT JOIN LATERAL (
            SELECT MAX(CASE WHEN rm.reminder_type = 'timeout' AND rm.reminder_status = 'active' THEN 1 ELSE 0 END) AS "hasTimeoutReminder"
            FROM after_sale_reminders rm
            WHERE rm.case_id = ac.id
          ) reminder_summary ON TRUE
          ${whereSql}
        `,
        values,
      ),
      this.pool.query(
        `
          SELECT
            rm.id,
            ac.id AS "caseId",
            ac.case_no AS "caseNo",
            ac.case_type AS "caseType",
            ac.case_status AS "caseStatus",
            o.order_no AS "orderNo",
            s.name AS "storeName",
            p.name AS "productName",
            rm.reminder_type AS "reminderType",
            rm.title,
            rm.detail,
            rm.remind_at AS "remindAt",
            ac.sla_deadline_at AS "deadlineAt"
          FROM after_sale_reminders rm
          INNER JOIN after_sale_cases ac ON ac.id = rm.case_id
          INNER JOIN orders o ON o.id = ac.order_id
          LEFT JOIN products p ON p.id = o.product_id
          LEFT JOIN stores s ON s.id = o.store_id
          LEFT JOIN customers c ON c.id = o.customer_id
          ${whereSql}
            AND rm.reminder_status = 'active'
          ORDER BY
            CASE WHEN rm.reminder_type = 'timeout' THEN 0 ELSE 1 END,
            rm.remind_at ASC,
            rm.id DESC
          LIMIT 12
        `,
        values,
      ),
      this.pool.query(
        `
          SELECT
            ac.id,
            ac.case_no AS "caseNo",
            ac.order_id AS "orderId",
            ac.case_type AS "caseType",
            ac.case_status AS "caseStatus",
            ac.reason,
            ac.latest_result AS "latestResult",
            ac.priority,
            ac.sla_deadline_at AS "deadlineAt",
            ac.updated_at AS "updatedAt",
            o.order_no AS "orderNo",
            s.name AS "storeName",
            p.name AS "productName",
            c.name AS "customerName",
            rf.refund_status AS "refundStatus",
            rf.requested_amount AS "requestedAmount",
            rs.resend_status AS "resendStatus",
            ad.dispute_status AS "disputeStatus",
            COALESCE(reminder_summary."hasTimeoutReminder", 0) AS "hasTimeoutReminder"
          FROM after_sale_cases ac
          INNER JOIN orders o ON o.id = ac.order_id
          LEFT JOIN products p ON p.id = o.product_id
          LEFT JOIN stores s ON s.id = o.store_id
          LEFT JOIN customers c ON c.id = o.customer_id
          LEFT JOIN after_sale_refunds rf ON rf.case_id = ac.id
          LEFT JOIN after_sale_resends rs ON rs.case_id = ac.id
          LEFT JOIN after_sale_disputes ad ON ad.case_id = ac.id
          LEFT JOIN LATERAL (
            SELECT MAX(CASE WHEN rm.reminder_type = 'timeout' AND rm.reminder_status = 'active' THEN 1 ELSE 0 END) AS "hasTimeoutReminder"
            FROM after_sale_reminders rm
            WHERE rm.case_id = ac.id
          ) reminder_summary ON TRUE
          ${whereSql}
          ORDER BY "hasTimeoutReminder" DESC, ac.updated_at DESC, ac.id DESC
          LIMIT 18
        `,
        values,
      ),
    ]);

    const decorateCase = (row: Record<string, unknown>) => {
      const caseType = String(row.caseType ?? '') as AfterSaleCaseType;
      const caseStatus = String(row.caseStatus ?? '') as AfterSaleCaseStatus;
      const refundStatus = row.refundStatus ? (String(row.refundStatus) as AfterSaleRefundStatus) : null;
      const resendStatus = row.resendStatus ? (String(row.resendStatus) as AfterSaleResendStatus) : null;
      const disputeStatus = row.disputeStatus ? (String(row.disputeStatus) as AfterSaleDisputeStatus) : null;
      const priority = String(row.priority ?? '');
      return {
        id: toNumber(row.id),
        caseNo: String(row.caseNo ?? ''),
        orderId: toNumber(row.orderId),
        caseType,
        caseStatus,
        reason: String(row.reason ?? ''),
        latestResult: row.latestResult ? String(row.latestResult) : null,
        priority,
        deadlineAt: String(row.deadlineAt ?? ''),
        updatedAt: String(row.updatedAt ?? ''),
        orderNo: String(row.orderNo ?? ''),
        storeName: String(row.storeName ?? ''),
        productName: String(row.productName ?? ''),
        customerName: String(row.customerName ?? ''),
        refundStatus,
        requestedAmount: row.requestedAmount == null ? null : toNumber(row.requestedAmount, 2),
        resendStatus,
        disputeStatus,
        hasTimeoutReminder: toNumber(row.hasTimeoutReminder),
        caseTypeText: getAfterSaleCaseTypeText(caseType),
        caseStatusText: getAfterSaleCaseStatusText(caseStatus),
        priorityText: getAfterSalePriorityText(priority),
        refundStatusText: refundStatus ? getAfterSaleRefundStatusText(refundStatus) : null,
        resendStatusText: resendStatus ? getAfterSaleResendStatusText(resendStatus) : null,
        disputeStatusText: disputeStatus ? getAfterSaleDisputeStatusText(disputeStatus) : null,
      };
    };

    return {
      summary: {
        totalCases: toNumber(summaryResult.rows[0]?.totalCases),
        pendingCases: toNumber(summaryResult.rows[0]?.pendingCases),
        processingCases: toNumber(summaryResult.rows[0]?.processingCases),
        resolvedCases: toNumber(summaryResult.rows[0]?.resolvedCases),
        timeoutCases: toNumber(summaryResult.rows[0]?.timeoutCases),
        refundCases: toNumber(summaryResult.rows[0]?.refundCases),
        resendCases: toNumber(summaryResult.rows[0]?.resendCases),
        disputeCases: toNumber(summaryResult.rows[0]?.disputeCases),
        pendingRefundAmount: toNumber(summaryResult.rows[0]?.pendingRefundAmount, 2),
      },
      reminders: remindersResult.rows.map((row) => {
        const caseType = String(row.caseType ?? '') as AfterSaleCaseType;
        const caseStatus = String(row.caseStatus ?? '') as AfterSaleCaseStatus;
        const reminderType = String(row.reminderType ?? '') as AfterSaleReminderType;
        return {
          id: toNumber(row.id),
          caseId: toNumber(row.caseId),
          caseNo: String(row.caseNo ?? ''),
          caseType,
          caseStatus,
          orderNo: String(row.orderNo ?? ''),
          storeName: String(row.storeName ?? ''),
          productName: String(row.productName ?? ''),
          reminderType,
          title: String(row.title ?? ''),
          detail: String(row.detail ?? ''),
          remindAt: String(row.remindAt ?? ''),
          deadlineAt: String(row.deadlineAt ?? ''),
          caseTypeText: getAfterSaleCaseTypeText(caseType),
          caseStatusText: getAfterSaleCaseStatusText(caseStatus),
          reminderTypeText: getAfterSaleReminderTypeText(reminderType),
        };
      }),
      pendingCases: listRowsResult.rows
        .map((row) => decorateCase(row))
        .filter((row) => ['pending_review', 'processing', 'waiting_execute'].includes(row.caseStatus))
        .slice(0, 8),
      timeoutCases: listRowsResult.rows
        .map((row) => decorateCase(row))
        .filter((row) => row.hasTimeoutReminder > 0)
        .slice(0, 8),
    };
  }

  async getAfterSaleCases(
    filters: QueryFilters,
    pagination: PaginationParams,
  ): Promise<AfterSaleCasesResult> {
    const range = resolveDateRange(filters);
    const { whereSql, values } = buildAfterSaleFilter(filters, range);
    const page = Math.max(1, pagination.page);
    const pageSize = Math.min(50, Math.max(1, pagination.pageSize));
    const offset = (page - 1) * pageSize;

    const [totalResult, rowsResult] = await Promise.all([
      this.pool.query(
        `
          SELECT COUNT(*) AS total
          FROM after_sale_cases ac
          INNER JOIN orders o ON o.id = ac.order_id
          LEFT JOIN products p ON p.id = o.product_id
          LEFT JOIN stores s ON s.id = o.store_id
          LEFT JOIN customers c ON c.id = o.customer_id
          ${whereSql}
        `,
        values,
      ),
      this.pool.query(
        `
          SELECT
            ac.id,
            ac.case_no AS "caseNo",
            ac.order_id AS "orderId",
            ac.case_type AS "caseType",
            ac.case_status AS "caseStatus",
            ac.reason,
            ac.priority,
            ac.latest_result AS "latestResult",
            ac.sla_deadline_at AS "deadlineAt",
            ac.created_at AS "createdAt",
            ac.updated_at AS "updatedAt",
            o.order_no AS "orderNo",
            s.name AS "storeName",
            p.name AS "productName",
            c.name AS "customerName",
            rf.requested_amount AS "requestedAmount",
            rf.approved_amount AS "approvedAmount",
            rf.refund_status AS "refundStatus",
            rs.resend_status AS "resendStatus",
            ad.dispute_status AS "disputeStatus",
            ad.compensation_amount AS "compensationAmount",
            COALESCE(reminder_summary."reminderTypesText", '') AS "reminderTypesText",
            COALESCE(reminder_summary."hasTimeoutReminder", 0) AS "hasTimeoutReminder"
          FROM after_sale_cases ac
          INNER JOIN orders o ON o.id = ac.order_id
          LEFT JOIN products p ON p.id = o.product_id
          LEFT JOIN stores s ON s.id = o.store_id
          LEFT JOIN customers c ON c.id = o.customer_id
          LEFT JOIN after_sale_refunds rf ON rf.case_id = ac.id
          LEFT JOIN after_sale_resends rs ON rs.case_id = ac.id
          LEFT JOIN after_sale_disputes ad ON ad.case_id = ac.id
          LEFT JOIN LATERAL (
            SELECT
              STRING_AGG(DISTINCT rm.reminder_type, ',') FILTER (WHERE rm.reminder_status = 'active') AS "reminderTypesText",
              MAX(CASE WHEN rm.reminder_type = 'timeout' AND rm.reminder_status = 'active' THEN 1 ELSE 0 END) AS "hasTimeoutReminder"
            FROM after_sale_reminders rm
            WHERE rm.case_id = ac.id
          ) reminder_summary ON TRUE
          ${whereSql}
          ORDER BY "hasTimeoutReminder" DESC, ac.updated_at DESC, ac.id DESC
          LIMIT $${values.length + 1} OFFSET $${values.length + 2}
        `,
        [...values, pageSize, offset],
      ),
    ]);

    return {
      total: toNumber(totalResult.rows[0]?.total),
      page,
      pageSize,
      list: rowsResult.rows.map((row) => {
        const caseType = String(row.caseType ?? '') as AfterSaleCaseType;
        const caseStatus = String(row.caseStatus ?? '') as AfterSaleCaseStatus;
        const refundStatus = row.refundStatus ? (String(row.refundStatus) as AfterSaleRefundStatus) : null;
        const resendStatus = row.resendStatus ? (String(row.resendStatus) as AfterSaleResendStatus) : null;
        const disputeStatus = row.disputeStatus ? (String(row.disputeStatus) as AfterSaleDisputeStatus) : null;
        const reminderTypes = String(row.reminderTypesText ?? '')
          .split(',')
          .map((item) => item.trim())
          .filter(Boolean) as AfterSaleReminderType[];
        return {
          id: toNumber(row.id),
          caseNo: String(row.caseNo ?? ''),
          orderId: toNumber(row.orderId),
          caseType,
          caseStatus,
          reason: String(row.reason ?? ''),
          priority: String(row.priority ?? ''),
          latestResult: row.latestResult ? String(row.latestResult) : null,
          deadlineAt: String(row.deadlineAt ?? ''),
          createdAt: String(row.createdAt ?? ''),
          updatedAt: String(row.updatedAt ?? ''),
          orderNo: String(row.orderNo ?? ''),
          storeName: String(row.storeName ?? ''),
          productName: String(row.productName ?? ''),
          customerName: String(row.customerName ?? ''),
          requestedAmount: row.requestedAmount == null ? null : toNumber(row.requestedAmount, 2),
          approvedAmount: row.approvedAmount == null ? null : toNumber(row.approvedAmount, 2),
          refundStatus,
          resendStatus,
          disputeStatus,
          compensationAmount: row.compensationAmount == null ? null : toNumber(row.compensationAmount, 2),
          reminderTypesText: String(row.reminderTypesText ?? ''),
          hasTimeoutReminder: toNumber(row.hasTimeoutReminder),
          caseTypeText: getAfterSaleCaseTypeText(caseType),
          caseStatusText: getAfterSaleCaseStatusText(caseStatus),
          priorityText: getAfterSalePriorityText(String(row.priority ?? '')),
          refundStatusText: refundStatus ? getAfterSaleRefundStatusText(refundStatus) : null,
          resendStatusText: resendStatus ? getAfterSaleResendStatusText(resendStatus) : null,
          disputeStatusText: disputeStatus ? getAfterSaleDisputeStatusText(disputeStatus) : null,
          reminderTypes,
          canReviewRefund:
            caseType === 'refund' &&
            Boolean(refundStatus && ['pending_review', 'approved'].includes(refundStatus)),
          canExecuteResend:
            caseType === 'resend' &&
            Boolean(resendStatus && ['requested', 'approved', 'failed'].includes(resendStatus)),
          canConcludeDispute:
            caseType === 'dispute' &&
            Boolean(disputeStatus && ['open', 'processing'].includes(disputeStatus)),
          canNote: true,
        };
      }),
    };
  }

  async getAfterSaleDetail(caseId: number): Promise<AfterSaleDetailResult> {
    const context = await this.getAfterSaleCaseContext(caseId);
    if (!context) {
      return null;
    }

    const [orderResult, recordsResult, remindersResult, cardOutboundsResult, directJobsResult, fulfillmentMap] =
      await Promise.all([
        this.pool.query(
          `
            SELECT
              o.id,
              o.order_no AS "orderNo",
              s.name AS "storeName",
              p.name AS "productName",
              c.name AS "customerName",
              o.paid_amount AS "paidAmount",
              o.refund_amount AS "refundAmount",
              o.main_status AS "mainStatus",
              o.delivery_status AS "deliveryStatus",
              o.after_sale_status AS "afterSaleStatus",
              o.paid_at AS "paidAt",
              o.updated_at AS "updatedAt"
            FROM orders o
            LEFT JOIN stores s ON s.id = o.store_id
            LEFT JOIN products p ON p.id = o.product_id
            LEFT JOIN customers c ON c.id = o.customer_id
            WHERE o.id = $1
          `,
          [context.orderId],
        ),
        this.pool.query(
          `
            SELECT
              id,
              record_type AS "recordType",
              title,
              detail,
              operator_name AS "operatorName",
              created_at AS "createdAt"
            FROM after_sale_records
            WHERE case_id = $1
            ORDER BY created_at DESC, id DESC
          `,
          [caseId],
        ),
        this.pool.query(
          `
            SELECT
              id,
              reminder_type AS "reminderType",
              reminder_status AS "reminderStatus",
              title,
              detail,
              remind_at AS "remindAt",
              resolved_at AS "resolvedAt"
            FROM after_sale_reminders
            WHERE case_id = $1
            ORDER BY remind_at DESC, id DESC
          `,
          [caseId],
        ),
        this.pool.query(
          `
            SELECT
              outbound_no AS "outboundNo",
              outbound_status AS "outboundStatus",
              reason,
              created_at AS "createdAt"
            FROM card_outbound_records
            WHERE order_id = $1
            ORDER BY id DESC
            LIMIT 5
          `,
          [context.orderId],
        ),
        this.pool.query(
          `
            SELECT
              task_no AS "taskNo",
              supplier_order_no AS "supplierOrderNo",
              task_status AS "taskStatus",
              result_detail AS "resultDetail",
              updated_at AS "updatedAt"
            FROM direct_charge_jobs
            WHERE order_id = $1
            ORDER BY id DESC
            LIMIT 5
          `,
          [context.orderId],
        ),
        this.loadOrderFulfillmentMeta([context.orderId]),
      ]);

    const orderRow = orderResult.rows[0];
    if (!orderRow) {
      return null;
    }
    const mainStatus = String(orderRow.mainStatus ?? '') as OrderMainStatus;
    const deliveryStatus = String(orderRow.deliveryStatus ?? '') as OrderDeliveryStatus;
    const fulfillment = fulfillmentMap.get(context.orderId);

    return {
      caseInfo: {
        id: context.id,
        caseNo: context.caseNo,
        orderId: context.orderId,
        orderNo: context.orderNo,
        caseType: context.caseType,
        caseTypeText: getAfterSaleCaseTypeText(context.caseType),
        caseStatus: context.caseStatus,
        caseStatusText: getAfterSaleCaseStatusText(context.caseStatus),
        reason: context.reason,
        priority: context.priority,
        priorityText: getAfterSalePriorityText(context.priority),
        latestResult: context.latestResult,
        deadlineAt: context.deadlineAt,
        createdAt: context.createdAt,
        updatedAt: context.updatedAt,
      },
      refund: context.refundId
        ? {
            requestedAmount: Number(context.requestedAmount ?? 0),
            approvedAmount: Number(context.approvedAmount ?? 0),
            refundStatus: context.refundStatus!,
            refundStatusText: getAfterSaleRefundStatusText(context.refundStatus!),
          }
        : null,
      resend: context.resendId
        ? {
            resendStatus: context.resendStatus!,
            resendStatusText: getAfterSaleResendStatusText(context.resendStatus!),
            fulfillmentType: context.resendFulfillmentType,
            relatedOutboundNo: context.relatedOutboundNo,
            relatedTaskNo: context.relatedTaskNo,
          }
        : null,
      dispute: context.disputeId
        ? {
            disputeStatus: context.disputeStatus!,
            disputeStatusText: getAfterSaleDisputeStatusText(context.disputeStatus!),
            compensationAmount: Number(context.compensationAmount ?? 0),
          }
        : null,
      order: {
        id: toNumber(orderRow.id),
        orderNo: String(orderRow.orderNo ?? ''),
        storeName: String(orderRow.storeName ?? ''),
        productName: String(orderRow.productName ?? ''),
        customerName: String(orderRow.customerName ?? ''),
        paidAmount: toNumber(orderRow.paidAmount, 2),
        refundAmount: toNumber(orderRow.refundAmount, 2),
        mainStatus,
        mainStatusText: getOrderMainStatusText(mainStatus),
        deliveryStatus,
        deliveryStatusText: getOrderDeliveryStatusText(deliveryStatus),
        afterSaleStatus: String(orderRow.afterSaleStatus ?? ''),
        paidAt: String(orderRow.paidAt ?? ''),
        updatedAt: String(orderRow.updatedAt ?? ''),
      },
      fulfillment: fulfillment
        ? {
            type: fulfillment.fulfillmentType,
            typeText: fulfillment.fulfillmentTypeText,
            queue: fulfillment.fulfillmentQueue,
            queueText: fulfillment.fulfillmentQueueText,
            stage: fulfillment.fulfillmentStage,
            stageDetail: fulfillment.fulfillmentStageDetail,
            latestTaskNo: fulfillment.latestTaskNo,
            latestSupplierOrderNo: fulfillment.latestSupplierOrderNo,
            latestOutboundNo: fulfillment.latestOutboundNo,
          }
        : null,
      artifacts: {
        cardOutbounds: cardOutboundsResult.rows.map((row) => ({
          outboundNo: String(row.outboundNo ?? ''),
          outboundStatus: String(row.outboundStatus ?? '') as CardOutboundStatus,
          reason: row.reason ? String(row.reason) : null,
          createdAt: String(row.createdAt ?? ''),
        })),
        directJobs: directJobsResult.rows.map((row) => ({
          taskNo: String(row.taskNo ?? ''),
          supplierOrderNo: row.supplierOrderNo ? String(row.supplierOrderNo) : null,
          taskStatus: String(row.taskStatus ?? '') as DirectChargeJobStatus,
          resultDetail: row.resultDetail ? String(row.resultDetail) : null,
          updatedAt: String(row.updatedAt ?? ''),
        })),
      },
      records: recordsResult.rows.map((row) => ({
        id: toNumber(row.id),
        recordType: String(row.recordType ?? ''),
        title: String(row.title ?? ''),
        detail: String(row.detail ?? ''),
        operatorName: row.operatorName ? String(row.operatorName) : null,
        createdAt: String(row.createdAt ?? ''),
      })),
      reminders: remindersResult.rows.map((row) => {
        const reminderType = String(row.reminderType ?? '') as AfterSaleReminderType;
        const reminderStatus = String(row.reminderStatus ?? '') as AfterSaleReminderStatus;
        return {
          id: toNumber(row.id),
          reminderType,
          reminderStatus,
          title: String(row.title ?? ''),
          detail: String(row.detail ?? ''),
          remindAt: String(row.remindAt ?? ''),
          resolvedAt: row.resolvedAt ? String(row.resolvedAt) : null,
          reminderTypeText: getAfterSaleReminderTypeText(reminderType),
        };
      }),
    };
  }

  private async getAfterSaleCaseContext(caseId: number) {
    const result = await this.pool.query(
      `
        SELECT
          ac.id,
          ac.case_no AS "caseNo",
          ac.order_id AS "orderId",
          ac.case_type AS "caseType",
          ac.case_status AS "caseStatus",
          ac.reason,
          ac.priority,
          ac.latest_result AS "latestResult",
          ac.sla_deadline_at AS "deadlineAt",
          ac.created_at AS "createdAt",
          ac.updated_at AS "updatedAt",
          o.order_no AS "orderNo",
          o.order_status AS "orderStatus",
          o.paid_amount AS "paidAmount",
          o.refund_amount AS "refundAmount",
          o.delivery_status AS "deliveryStatus",
          o.after_sale_status AS "afterSaleStatus",
          rf.id AS "refundId",
          rf.requested_amount AS "requestedAmount",
          rf.approved_amount AS "approvedAmount",
          rf.refund_status AS "refundStatus",
          rs.id AS "resendId",
          rs.resend_status AS "resendStatus",
          rs.fulfillment_type AS "resendFulfillmentType",
          rs.related_outbound_no AS "relatedOutboundNo",
          rs.related_task_no AS "relatedTaskNo",
          ad.id AS "disputeId",
          ad.dispute_status AS "disputeStatus",
          ad.compensation_amount AS "compensationAmount"
        FROM after_sale_cases ac
        INNER JOIN orders o ON o.id = ac.order_id
        LEFT JOIN after_sale_refunds rf ON rf.case_id = ac.id
        LEFT JOIN after_sale_resends rs ON rs.case_id = ac.id
        LEFT JOIN after_sale_disputes ad ON ad.case_id = ac.id
        WHERE ac.id = $1
      `,
      [caseId],
    );
    const row = result.rows[0];
    if (!row) {
      return null;
    }
    return {
      id: toNumber(row.id),
      caseNo: String(row.caseNo ?? ''),
      orderId: toNumber(row.orderId),
      caseType: String(row.caseType ?? '') as AfterSaleCaseType,
      caseStatus: String(row.caseStatus ?? '') as AfterSaleCaseStatus,
      reason: String(row.reason ?? ''),
      priority: String(row.priority ?? ''),
      latestResult: row.latestResult ? String(row.latestResult) : null,
      deadlineAt: String(row.deadlineAt ?? ''),
      createdAt: String(row.createdAt ?? ''),
      updatedAt: String(row.updatedAt ?? ''),
      orderNo: String(row.orderNo ?? ''),
      orderStatus: String(row.orderStatus ?? ''),
      paidAmount: toNumber(row.paidAmount, 2),
      refundAmount: toNumber(row.refundAmount, 2),
      deliveryStatus: String(row.deliveryStatus ?? '') as OrderDeliveryStatus,
      afterSaleStatus: String(row.afterSaleStatus ?? ''),
      refundId: row.refundId == null ? null : toNumber(row.refundId),
      requestedAmount: row.requestedAmount == null ? null : toNumber(row.requestedAmount, 2),
      approvedAmount: row.approvedAmount == null ? null : toNumber(row.approvedAmount, 2),
      refundStatus: row.refundStatus ? (String(row.refundStatus) as AfterSaleRefundStatus) : null,
      resendId: row.resendId == null ? null : toNumber(row.resendId),
      resendStatus: row.resendStatus ? (String(row.resendStatus) as AfterSaleResendStatus) : null,
      resendFulfillmentType: row.resendFulfillmentType
        ? (String(row.resendFulfillmentType) as OrderFulfillmentType)
        : null,
      relatedOutboundNo: row.relatedOutboundNo ? String(row.relatedOutboundNo) : null,
      relatedTaskNo: row.relatedTaskNo ? String(row.relatedTaskNo) : null,
      disputeId: row.disputeId == null ? null : toNumber(row.disputeId),
      disputeStatus: row.disputeStatus ? (String(row.disputeStatus) as AfterSaleDisputeStatus) : null,
      compensationAmount:
        row.compensationAmount == null ? null : toNumber(row.compensationAmount, 2),
    };
  }

  private resolveOrderSort(sortBy?: string, sortOrder?: string) {
    const column =
      ORDER_SORT_FIELDS[(sortBy as keyof typeof ORDER_SORT_FIELDS) ?? 'paidAt'] ??
      ORDER_SORT_FIELDS.paidAt;
    const direction = sortOrder === 'asc' ? 'ASC' : 'DESC';
    return `${column} ${direction}, o.id DESC`;
  }

  private async loadOrderFulfillmentMeta(orderIds: number[]) {
    const idList = Array.from(new Set(orderIds.filter((id) => Number.isInteger(id) && id > 0)));
    const metaMap = new Map<number, OrderFulfillmentMeta>();
    if (idList.length === 0) {
      return metaMap;
    }

    const [orderResult, cardResult, directResult, eventResult] = await Promise.all([
      this.pool.query(
        `
          SELECT
            o.id,
            o.main_status AS "mainStatus",
            o.delivery_status AS "deliveryStatus",
            cdi.id AS "cardDeliveryId",
            dci.id AS "directChargeItemId"
          FROM orders o
          LEFT JOIN card_delivery_items cdi ON cdi.product_id = o.product_id
          LEFT JOIN direct_charge_items dci ON dci.product_id = o.product_id
          WHERE o.id = ANY($1::int[])
        `,
        [idList],
      ),
      this.pool.query(
        `
          SELECT DISTINCT ON (o.id)
            o.id AS "orderId",
            cdi.id AS "cardDeliveryId",
            cdj.job_status AS "jobStatus",
            cdj.attempt_count AS "attemptCount",
            cdj.error_message AS "errorMessage",
            cor.outbound_no AS "latestOutboundNo"
          FROM orders o
          INNER JOIN card_delivery_items cdi ON cdi.product_id = o.product_id
          LEFT JOIN card_delivery_jobs cdj ON cdj.order_id = o.id
          LEFT JOIN card_outbound_records cor ON cor.id = cdj.latest_outbound_record_id
          WHERE o.id = ANY($1::int[])
          ORDER BY o.id, cdj.id DESC NULLS LAST
        `,
        [idList],
      ),
      this.pool.query(
        `
          SELECT DISTINCT ON (o.id)
            o.id AS "orderId",
            dci.id AS "directChargeItemId",
            dcj.task_no AS "taskNo",
            dcj.supplier_order_no AS "supplierOrderNo",
            dcj.task_status AS "taskStatus",
            dcj.retry_count AS "retryCount",
            dcj.max_retry AS "maxRetry",
            dcj.error_message AS "errorMessage",
            dcj.result_detail AS "resultDetail",
            dcj.manual_reason AS "manualReason"
          FROM orders o
          LEFT JOIN direct_charge_items dci ON dci.product_id = o.product_id
          LEFT JOIN direct_charge_jobs dcj ON dcj.order_id = o.id
          WHERE o.id = ANY($1::int[])
          ORDER BY o.id, dcj.id DESC NULLS LAST
        `,
        [idList],
      ),
      this.pool.query(
        `
          SELECT DISTINCT ON (oe.order_id)
            oe.order_id AS "orderId",
            oe.event_title AS "eventTitle",
            oe.event_detail AS "eventDetail",
            oe.created_at AS "createdAt"
          FROM order_events oe
          WHERE oe.order_id = ANY($1::int[])
            AND (
              oe.event_type LIKE 'card_%'
              OR oe.event_type LIKE 'direct_charge_%'
              OR oe.event_type LIKE 'fulfillment_%'
            )
          ORDER BY oe.order_id, oe.id DESC
        `,
        [idList],
      ),
    ]);

    const cardMap = new Map(cardResult.rows.map((row) => [toNumber(row.orderId), row]));
    const directMap = new Map(directResult.rows.map((row) => [toNumber(row.orderId), row]));
    const eventMap = new Map(eventResult.rows.map((row) => [toNumber(row.orderId), row]));

    for (const row of orderResult.rows) {
      const orderId = toNumber(row.id);
      const cardRow = cardMap.get(orderId);
      const directRow = directMap.get(orderId);
      const eventRow = eventMap.get(orderId);
      metaMap.set(
        orderId,
        buildOrderFulfillmentMeta({
          mainStatus: String(row.mainStatus ?? ''),
          deliveryStatus: String(row.deliveryStatus ?? ''),
          cardDeliveryId: row.cardDeliveryId == null ? null : toNumber(row.cardDeliveryId),
          directChargeItemId:
            row.directChargeItemId == null ? null : toNumber(row.directChargeItemId),
          cardJobStatus: cardRow?.jobStatus ? String(cardRow.jobStatus) : null,
          cardAttemptCount: cardRow?.attemptCount == null ? null : toNumber(cardRow.attemptCount),
          cardErrorMessage: cardRow?.errorMessage ? String(cardRow.errorMessage) : null,
          latestOutboundNo: cardRow?.latestOutboundNo ? String(cardRow.latestOutboundNo) : null,
          directTaskNo: directRow?.taskNo ? String(directRow.taskNo) : null,
          directSupplierOrderNo: directRow?.supplierOrderNo
            ? String(directRow.supplierOrderNo)
            : null,
          directTaskStatus: directRow?.taskStatus ? String(directRow.taskStatus) : null,
          directRetryCount: directRow?.retryCount == null ? null : toNumber(directRow.retryCount),
          directMaxRetry: directRow?.maxRetry == null ? null : toNumber(directRow.maxRetry),
          directErrorMessage: directRow?.errorMessage ? String(directRow.errorMessage) : null,
          directResultDetail: directRow?.resultDetail ? String(directRow.resultDetail) : null,
          directManualReason: directRow?.manualReason ? String(directRow.manualReason) : null,
          latestLogTitle: eventRow?.eventTitle ? String(eventRow.eventTitle) : null,
          latestLogDetail: eventRow?.eventDetail ? String(eventRow.eventDetail) : null,
          latestLogAt: eventRow?.createdAt ? String(eventRow.createdAt) : null,
        }),
      );
    }

    return metaMap;
  }

  async getDashboard(filters: QueryFilters, fallback: DashboardResponse): Promise<DashboardResponse> {
    const range = resolveDateRange(filters);
    const currentSummary = await this.getMetricSummary({
      ...filters,
      startDate: range.startDate,
      endDate: range.endDate,
    });
    const previousSummary = await this.getMetricSummary({
      ...filters,
      startDate: range.previousStartDate,
      endDate: range.previousEndDate,
    });
    const todaySummary = await this.getMetricSummary({ ...filters, preset: 'today' });
    const ordersOverview = await this.getOrdersOverview(filters);
    const todayOrdersOverview = await this.getOrdersOverview({ ...filters, preset: 'today' });
    const pgFilters = await this.getFilterOptions(fallback.filters);
    const trend = await this.getTrend(filters);
    const sourceDistribution = await this.getSourceDistribution(filters);
    const orderStatusDistribution = await this.getOrderStatusDistribution(filters);
    const topProducts = await this.getTopProducts(filters);

    const productStats = fallback.modules.businessCards.productStats;
    const activeProducts =
      productStats.find((item) => item.label === '动销商品')?.value ??
      productStats.find((item) => item.label === '活跃商品')?.value ??
      0;
    const todayProductActive =
      fallback.modules.todayCards.find((item) => item.label === '活跃商品')?.value ??
      activeProducts;

    return {
      ...fallback,
      range: {
        startDate: range.startDate,
        endDate: range.endDate,
        preset: filters.preset ?? 'last30Days',
      },
      summary: [
        {
          key: 'receivedAmount',
          label: '实收金额',
          value: currentSummary.receivedAmount,
          unit: 'CNY',
          compareRate: compareMetric(currentSummary.receivedAmount, previousSummary.receivedAmount),
        },
        {
          key: 'netSalesAmount',
          label: '净销售额',
          value: toNumber(currentSummary.receivedAmount - currentSummary.refundAmount, 2),
          unit: 'CNY',
          compareRate: compareMetric(
            currentSummary.receivedAmount - currentSummary.refundAmount,
            previousSummary.receivedAmount - previousSummary.refundAmount,
          ),
        },
        {
          key: 'netProfit',
          label: '净利润',
          value: currentSummary.netProfit,
          unit: 'CNY',
          compareRate: compareMetric(currentSummary.netProfit, previousSummary.netProfit),
        },
        {
          key: 'grossMargin',
          label: '毛利率',
          value: currentSummary.grossMargin,
          unit: '%',
          compareRate: compareMetric(currentSummary.grossMargin, previousSummary.grossMargin),
        },
      ],
      modules: {
        todayCards: [
          { label: '支付金额', value: todaySummary.receivedAmount, unit: 'CNY' },
          { label: '支付订单数', value: todaySummary.orderCount, unit: '单' },
          { label: '支付客单价', value: todaySummary.averageOrderValue, unit: 'CNY' },
          { label: '活跃商品', value: todayProductActive, unit: '款' },
          { label: '待发货', value: todayOrdersOverview.pendingShipment, unit: '单' },
          { label: '已发货', value: todayOrdersOverview.shippedOrders, unit: '单' },
          { label: '待售后', value: todayOrdersOverview.afterSaleOrders, unit: '单' },
          { label: '退款金额', value: todaySummary.refundAmount, unit: 'CNY' },
        ],
        businessCards: {
          productStats,
          orderStats: [
            { label: '待发货', value: ordersOverview.pendingShipment, unit: '单' },
            { label: '已发货', value: ordersOverview.shippedOrders, unit: '单' },
            { label: '交易成功', value: ordersOverview.completedOrders, unit: '单' },
            {
              label: '平均发货时长',
              value: ordersOverview.averageDeliveryHours,
              unit: '小时',
            },
          ],
          afterSaleStats: [
            { label: '进行中售后', value: ordersOverview.afterSaleOrders, unit: '单' },
            {
              label: '退款金额',
              value: currentSummary.refundAmount,
              unit: 'CNY',
            },
            {
              label: '净销售额',
              value: toNumber(currentSummary.receivedAmount - currentSummary.refundAmount, 2),
              unit: 'CNY',
            },
            {
              label: '动销商品',
              value: activeProducts,
              unit: '款',
            },
          ],
        },
      },
      trend,
      sourceDistribution,
      orderStatusDistribution,
      topProducts,
      filters: pgFilters,
    };
  }

  async getProductsView(filters: QueryFilters): Promise<ProductsView> {
    const range = resolveDateRange(filters);
    const { whereSql, values } = buildOrderFilter(filters, range);
    const { whereSql: productWhereSql, values: productValues } = buildProductFilter(filters);
    const mergedProductWhereSql = shiftPlaceholders(productWhereSql, values.length);
    const mergedValues = [...values, ...productValues];

    const [activitySummaryResult, inventorySummaryResult, categorySalesResult, rankingResult] =
      await Promise.all([
        this.pool.query(
          `
            SELECT
              COUNT(DISTINCT p.id) AS "activeProducts",
              SUM(o.quantity) AS "soldQuantity",
              SUM(o.paid_amount) AS "salesAmount"
            FROM orders o
            LEFT JOIN products p ON p.id = o.product_id
            LEFT JOIN customers c ON c.id = o.customer_id
            ${whereSql}
          `,
          values,
        ),
        this.pool.query(
          `
            SELECT
              COUNT(*) AS "totalProducts",
              SUM(p.stock) AS "totalStock",
              SUM(CASE WHEN p.stock <= 30 THEN 1 ELSE 0 END) AS "lowStockProducts",
              COUNT(DISTINCT p.category) AS "categoryCount"
            FROM products p
            ${productWhereSql}
          `,
          productValues,
        ),
        this.pool.query(
          `
            SELECT
              p.category AS category,
              SUM(o.paid_amount) AS "salesAmount",
              SUM(o.quantity) AS "soldQuantity"
            FROM orders o
            LEFT JOIN products p ON p.id = o.product_id
            LEFT JOIN customers c ON c.id = o.customer_id
            ${whereSql}
            GROUP BY p.category
            ORDER BY "salesAmount" DESC NULLS LAST
          `,
          values,
        ),
        this.pool.query(
          `
            WITH order_agg AS (
              SELECT
                o.product_id AS "productId",
                SUM(o.quantity) AS "soldQuantity",
                SUM(o.paid_amount) AS "salesAmount",
                COUNT(*) AS "orderCount",
                SUM(CASE WHEN o.after_sale_status != 'none' THEN 1 ELSE 0 END) AS "afterSaleCount",
                MIN(o.paid_at) AS "firstSaleAt",
                MAX(o.updated_at) AS "latestSaleAt"
              FROM orders o
              LEFT JOIN products p ON p.id = o.product_id
              LEFT JOIN customers c ON c.id = o.customer_id
              ${whereSql}
              GROUP BY o.product_id
            )
            SELECT
              p.id,
              p.sku,
              p.name,
              p.category,
              p.price,
              s.name AS "storeName",
              p.stock,
              COALESCE(oa."soldQuantity", 0) AS "soldQuantity",
              COALESCE(oa."salesAmount", 0) AS "salesAmount",
              COALESCE(oa."orderCount", 0) AS "orderCount",
              COALESCE(oa."afterSaleCount", 0) AS "afterSaleCount",
              oa."firstSaleAt" AS "firstSaleAt",
              oa."latestSaleAt" AS "latestSaleAt"
            FROM products p
            LEFT JOIN stores s ON s.id = p.store_id
            LEFT JOIN order_agg oa ON oa."productId" = p.id
            ${mergedProductWhereSql}
            ORDER BY COALESCE(oa."salesAmount", 0) DESC, p.id DESC
            LIMIT 12
          `,
          mergedValues,
        ),
      ]);

    const activitySummary = activitySummaryResult.rows[0] ?? {};
    const inventorySummary = inventorySummaryResult.rows[0] ?? {};

    return {
      summary: {
        totalProducts: toNumber(inventorySummary.totalProducts),
        totalStock: toNumber(inventorySummary.totalStock),
        activeProducts: toNumber(activitySummary.activeProducts),
        soldQuantity: toNumber(activitySummary.soldQuantity),
        salesAmount: toNumber(activitySummary.salesAmount, 2),
        lowStockProducts: toNumber(inventorySummary.lowStockProducts),
        categoryCount: toNumber(inventorySummary.categoryCount),
      },
      categorySales: categorySalesResult.rows.map((row) => ({
        category: row.category ? String(row.category) : null,
        salesAmount: toNumber(row.salesAmount, 2),
        soldQuantity: toNumber(row.soldQuantity),
      })),
      ranking: rankingResult.rows.map((row) => ({
        id: toNumber(row.id),
        sku: String(row.sku ?? ''),
        name: String(row.name ?? ''),
        category: String(row.category ?? ''),
        price: toNumber(row.price, 2),
        storeName: String(row.storeName ?? ''),
        stock: toNumber(row.stock),
        soldQuantity: toNumber(row.soldQuantity),
        salesAmount: toNumber(row.salesAmount, 2),
        orderCount: toNumber(row.orderCount),
        afterSaleCount: toNumber(row.afterSaleCount),
        firstSaleAt: row.firstSaleAt ? String(row.firstSaleAt) : null,
        latestSaleAt: row.latestSaleAt ? String(row.latestSaleAt) : null,
      })),
    };
  }

  async getCustomersView(filters: QueryFilters): Promise<CustomersView> {
    const range = resolveDateRange(filters);
    const { whereSql, values } = buildOrderFilter(filters, range);
    const [summaryResult, provinceRowsResult, customerListResult] = await Promise.all([
      this.pool.query(
        `
          SELECT
            COUNT(DISTINCT o.customer_id) AS "customerCount",
            COUNT(DISTINCT CASE WHEN o.is_new_customer = 1 THEN o.customer_id END) AS "newCustomers",
            COUNT(DISTINCT CASE WHEN o.is_new_customer = 0 THEN o.customer_id END) AS "repeatCustomers",
            SUM(o.paid_amount) AS "salesAmount"
          FROM orders o
          LEFT JOIN products p ON p.id = o.product_id
          LEFT JOIN customers c ON c.id = o.customer_id
          ${whereSql}
        `,
        values,
      ),
      this.pool.query(
        `
          SELECT
            c.province,
            COUNT(DISTINCT o.customer_id) AS "customerCount",
            SUM(o.paid_amount) AS "salesAmount"
          FROM orders o
          LEFT JOIN products p ON p.id = o.product_id
          LEFT JOIN customers c ON c.id = o.customer_id
          ${whereSql}
          GROUP BY c.province
          ORDER BY "salesAmount" DESC NULLS LAST
          LIMIT 10
        `,
        values,
      ),
      this.pool.query(
        `
          SELECT
            c.id,
            c.name,
            c.province,
            COUNT(o.id) AS "orderCount",
            SUM(o.paid_amount) AS "totalSpend",
            MAX(o.paid_at) AS "latestOrderAt"
          FROM orders o
          LEFT JOIN products p ON p.id = o.product_id
          LEFT JOIN customers c ON c.id = o.customer_id
          ${whereSql}
          GROUP BY c.id, c.name, c.province
          ORDER BY "totalSpend" DESC NULLS LAST
          LIMIT 12
        `,
        values,
      ),
    ]);

    const summary = summaryResult.rows[0] ?? {};
    const customerCount = toNumber(summary.customerCount);
    const repeatCustomers = toNumber(summary.repeatCustomers);
    const salesAmount = toNumber(summary.salesAmount, 2);

    return {
      summary: {
        customerCount,
        newCustomers: toNumber(summary.newCustomers),
        repeatCustomers,
        averageSpend: customerCount === 0 ? 0 : Number((salesAmount / customerCount).toFixed(2)),
        repeatRate: customerCount === 0 ? 0 : toPercentage((repeatCustomers / customerCount) * 100),
      },
      provinceRows: provinceRowsResult.rows.map((row) => ({
        province: row.province ? String(row.province) : null,
        customerCount: toNumber(row.customerCount),
        salesAmount: toNumber(row.salesAmount, 2),
      })),
      customerList: customerListResult.rows.map((row) => ({
        id: toNumber(row.id),
        name: String(row.name ?? ''),
        province: row.province ? String(row.province) : null,
        orderCount: toNumber(row.orderCount),
        totalSpend: toNumber(row.totalSpend, 2),
        latestOrderAt: row.latestOrderAt ? String(row.latestOrderAt) : null,
      })),
    };
  }

  async getBusinessReports(filters: QueryFilters): Promise<BusinessReportsResponse> {
    const range = resolveDateRange(filters);
    const [currentSnapshot, previousSnapshot, reportFilters] = await Promise.all([
      this.buildBusinessReportSnapshot({
        ...filters,
        startDate: range.startDate,
        endDate: range.endDate,
      }),
      this.buildBusinessReportSnapshot({
        ...filters,
        startDate: range.previousStartDate,
        endDate: range.previousEndDate,
      }),
      this.getFilterOptions({ stores: [], products: [], categories: [], sources: [] }),
    ]);

    const netSalesAmount = currentSnapshot.metrics.receivedAmount - currentSnapshot.metrics.refundAmount;
    const previousNetSalesAmount =
      previousSnapshot.metrics.receivedAmount - previousSnapshot.metrics.refundAmount;

    return {
      range: {
        startDate: range.startDate,
        endDate: range.endDate,
        preset: filters.preset ?? 'last30Days',
      },
      summary: [
        {
          key: 'receivedAmount',
          label: '实收金额',
          value: currentSnapshot.metrics.receivedAmount,
          unit: 'CNY',
          compareRate: compareMetric(
            currentSnapshot.metrics.receivedAmount,
            previousSnapshot.metrics.receivedAmount,
          ),
        },
        {
          key: 'netSalesAmount',
          label: '净销售额',
          value: Number(netSalesAmount.toFixed(2)),
          unit: 'CNY',
          compareRate: compareMetric(netSalesAmount, previousNetSalesAmount),
        },
        {
          key: 'netProfit',
          label: '净利润',
          value: currentSnapshot.metrics.netProfit,
          unit: 'CNY',
          compareRate: compareMetric(currentSnapshot.metrics.netProfit, previousSnapshot.metrics.netProfit),
        },
        {
          key: 'grossMargin',
          label: '毛利率',
          value: currentSnapshot.metrics.grossMargin,
          unit: '%',
          compareRate: compareMetric(
            currentSnapshot.metrics.grossMargin,
            previousSnapshot.metrics.grossMargin,
          ),
        },
      ],
      formulas: [
        {
          key: 'grossAmount',
          label: '订单原额',
          value: currentSnapshot.metrics.grossAmount,
          unit: 'CNY',
          formula: '订单原额 = 支付记录 gross_amount 汇总',
          description: '回溯到 order_payments.gross_amount，表示优惠前的支付原额。',
        },
        {
          key: 'discountAmount',
          label: '优惠金额',
          value: currentSnapshot.metrics.discountAmount,
          unit: 'CNY',
          formula: '优惠金额 = 支付记录 discount_amount 汇总',
          description: '回溯到 order_payments.discount_amount，用于衡量营销让利成本。',
        },
        {
          key: 'receivedAmount',
          label: '实收金额',
          value: currentSnapshot.metrics.receivedAmount,
          unit: 'CNY',
          formula: '实收金额 = 支付记录 paid_amount 汇总',
          description: '回溯到 order_payments.paid_amount，也是当前报表的基础收入口径。',
        },
        {
          key: 'refundAmount',
          label: '退款金额',
          value: currentSnapshot.metrics.refundAmount,
          unit: 'CNY',
          formula: '退款金额 = 订单 refund_amount 汇总',
          description: '回溯到 orders.refund_amount，代表已回写到订单主线的退款。',
        },
        {
          key: 'netSalesAmount',
          label: '净销售额',
          value: Number(netSalesAmount.toFixed(2)),
          unit: 'CNY',
          formula: '净销售额 = 实收金额 - 退款金额',
          description: '用于统一店铺、商品、订单维度的净收入口径。',
        },
        {
          key: 'costAmount',
          label: '商品成本',
          value: currentSnapshot.metrics.costAmount,
          unit: 'CNY',
          formula: '商品成本 = 商品成本价 × 订单数量',
          description: '回溯到 products.cost 与 orders.quantity。',
        },
        {
          key: 'compensationAmount',
          label: '售后补偿',
          value: currentSnapshot.metrics.compensationAmount,
          unit: 'CNY',
          formula: '售后补偿 = 争议补偿金额汇总',
          description: '回溯到 after_sale_disputes.compensation_amount。',
        },
        {
          key: 'grossProfit',
          label: '毛利',
          value: currentSnapshot.metrics.grossProfit,
          unit: 'CNY',
          formula: '毛利 = 净销售额 - 商品成本',
          description: '不扣售后补偿，用于衡量商品经营毛利。',
        },
        {
          key: 'grossMargin',
          label: '毛利率',
          value: currentSnapshot.metrics.grossMargin,
          unit: '%',
          formula: '毛利率 = 毛利 / 净销售额 × 100%',
          description: '净销售额为 0 时按 0 处理。',
        },
        {
          key: 'netProfit',
          label: '净利润',
          value: currentSnapshot.metrics.netProfit,
          unit: 'CNY',
          formula: '净利润 = 毛利 - 售后补偿',
          description: '用于输出可直接复盘的最终经营利润口径。',
        },
      ],
      paymentSummary: {
        grossAmount: currentSnapshot.metrics.grossAmount,
        discountAmount: currentSnapshot.metrics.discountAmount,
        receivedAmount: currentSnapshot.metrics.receivedAmount,
        refundAmount: currentSnapshot.metrics.refundAmount,
        netSalesAmount: Number(netSalesAmount.toFixed(2)),
        paymentCount: currentSnapshot.metrics.paymentCount,
      },
      storeStats: currentSnapshot.storeStats,
      productStats: currentSnapshot.productStats,
      orderStats: currentSnapshot.orderStats,
      afterSaleStats: currentSnapshot.afterSaleStats,
      trend: currentSnapshot.trend,
      filters: reportFilters,
    };
  }

  async exportBusinessReportsCsv(filters: QueryFilters): Promise<string> {
    const report = await this.getBusinessReports(filters);
    const sections: string[] = [];

    const appendSection = (title: string, headers: string[], rows: Array<Array<string | number>>) => {
      sections.push(title);
      sections.push(headers.join(','));
      rows.forEach((row) => {
        sections.push(row.map((cell) => escapeCsvCell(cell)).join(','));
      });
      sections.push('');
    };

    appendSection(
      '报表摘要',
      ['指标', '数值', '单位', '环比'],
      report.summary.map((item) => [item.label, item.value, item.unit, `${item.compareRate.toFixed(2)}%`]),
    );
    appendSection(
      '统计口径',
      ['指标', '数值', '单位', '公式', '说明'],
      report.formulas.map((item) => [item.label, item.value, item.unit, item.formula, item.description]),
    );
    appendSection(
      '店铺维度统计',
      ['店铺', '订单数', '实收金额', '退款金额', '净销售额', '毛利', '毛利率', '售后单数', '履约成功率', '人工处理单', '平均发货时长'],
      report.storeStats.map((item) => [
        item.storeName,
        item.orderCount,
        item.salesAmount,
        item.refundAmount,
        item.netSalesAmount,
        item.grossProfit,
        `${item.grossMargin.toFixed(2)}%`,
        item.afterSaleCases,
        `${item.successFulfillmentRate.toFixed(2)}%`,
        item.manualReviewCount,
        item.averageDeliveryHours,
      ]),
    );
    appendSection(
      '商品维度统计',
      ['商品', 'SKU', '店铺', '分类', '订单数', '销量', '实收金额', '退款金额', '净销售额', '毛利', '毛利率', '售后单数', '履约成功率'],
      report.productStats.map((item) => [
        item.productName,
        item.productSku,
        item.storeName,
        item.category,
        item.orderCount,
        item.soldQuantity,
        item.salesAmount,
        item.refundAmount,
        item.netSalesAmount,
        item.grossProfit,
        `${item.grossMargin.toFixed(2)}%`,
        item.afterSaleCases,
        `${item.successFulfillmentRate.toFixed(2)}%`,
      ]),
    );
    appendSection(
      '订单维度概览',
      ['指标', '数值', '单位', '说明'],
      report.orderStats.overview.map((item) => [item.label, item.value, item.unit, item.description]),
    );
    appendSection(
      '订单状态分布',
      ['状态', '订单数'],
      report.orderStats.statusDistribution.map((item) => [item.label, item.orderCount]),
    );
    appendSection(
      '订单来源分布',
      ['来源', '订单数', '实收金额'],
      report.orderStats.sourceDistribution.map((item) => [item.source, item.orderCount, item.salesAmount]),
    );
    appendSection(
      '履约队列分布',
      ['队列', '订单数'],
      report.orderStats.fulfillmentDistribution.map((item) => [item.label, item.orderCount]),
    );
    appendSection(
      '售后维度概览',
      ['指标', '数值', '单位', '说明'],
      report.afterSaleStats.overview.map((item) => [item.label, item.value, item.unit, item.description]),
    );
    appendSection(
      '售后类型分布',
      ['类型', '单量', '已完结', '超时', '退款金额', '补偿金额'],
      report.afterSaleStats.typeDistribution.map((item) => [
        item.caseTypeText,
        item.caseCount,
        item.resolvedCount,
        item.timeoutCount,
        item.refundAmount,
        item.compensationAmount,
      ]),
    );
    appendSection(
      '售后状态分布',
      ['状态', '单量'],
      report.afterSaleStats.statusDistribution.map((item) => [item.caseStatusText, item.caseCount]),
    );
    appendSection(
      '时间趋势',
      ['日期', '订单原额', '实收金额', '退款金额', '净利润', '订单数', '售后单量'],
      report.trend.map((item) => [
        item.reportDate,
        item.grossAmount,
        item.receivedAmount,
        item.refundAmount,
        item.netProfit,
        item.orderCount,
        item.afterSaleCaseCount,
      ]),
    );

    return sections.join('\n').trim();
  }

  async getWorkspaceOverview(
    featureKey: string,
    fallback: WorkspaceOverview,
  ): Promise<WorkspaceOverview> {
    const [moduleResult, actionsResult, rulesResult, tasksResult, logsResult, taskStatsResult] =
      await Promise.all([
        this.pool.query(
          `
            SELECT
              feature_key AS "featureKey",
              feature_label AS "featureLabel",
              group_key AS "groupKey",
              group_label AS "groupLabel",
              status_tag AS "statusTag",
              updated_at AS "updatedAt"
            FROM workspace_modules
            WHERE feature_key = $1
          `,
          [featureKey],
        ),
        this.pool.query(
          `
            SELECT
              id,
              title,
              description,
              status,
              run_count AS "runCount",
              last_run_at AS "lastRunAt"
            FROM workspace_actions
            WHERE feature_key = $1
            ORDER BY id ASC
          `,
          [featureKey],
        ),
        this.pool.query(
          `
            SELECT
              id,
              name,
              description,
              enabled,
              scope_text AS scope,
              updated_at AS "updatedAt"
            FROM workspace_rules
            WHERE feature_key = $1
            ORDER BY id ASC
          `,
          [featureKey],
        ),
        this.pool.query(
          `
            SELECT
              id,
              title,
              description,
              owner,
              priority,
              status,
              due_at AS "dueAt"
            FROM workspace_tasks
            WHERE feature_key = $1
            ORDER BY
              CASE status
                WHEN 'todo' THEN 1
                WHEN 'in_progress' THEN 2
                ELSE 3
              END,
              due_at ASC,
              id ASC
          `,
          [featureKey],
        ),
        this.pool.query(
          `
            SELECT
              id,
              log_type AS type,
              title,
              detail,
              created_at AS "createdAt"
            FROM workspace_logs
            WHERE feature_key = $1
            ORDER BY created_at DESC, id DESC
            LIMIT 8
          `,
          [featureKey],
        ),
        this.pool.query(
          `
            SELECT
              SUM(CASE WHEN status IN ('todo', 'in_progress') THEN 1 ELSE 0 END) AS "pendingTaskCount",
              SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS "doneTaskCount",
              SUM(
                CASE
                  WHEN status != 'done'
                    AND due_at < to_char(CURRENT_TIMESTAMP, 'YYYY-MM-DD HH24:MI:SS')
                  THEN 1
                  ELSE 0
                END
              ) AS "overdueTaskCount"
            FROM workspace_tasks
            WHERE feature_key = $1
          `,
          [featureKey],
        ),
      ]);

    const moduleRow = moduleResult.rows[0];
    if (!moduleRow) {
      return fallback;
    }

    const actions = actionsResult.rows.map((row) => ({
      id: toNumber(row.id),
      title: String(row.title),
      description: String(row.description ?? ''),
      status: String(row.status ?? ''),
      runCount: toNumber(row.runCount),
      lastRunAt: row.lastRunAt ? String(row.lastRunAt) : null,
    }));
    const rules = rulesResult.rows.map((row) => ({
      id: toNumber(row.id),
      name: String(row.name),
      description: String(row.description ?? ''),
      enabled: Boolean(toNumber(row.enabled)),
      scope: String(row.scope ?? ''),
      updatedAt: String(row.updatedAt ?? ''),
    }));
    const tasks = tasksResult.rows.map((row) => ({
      id: toNumber(row.id),
      title: String(row.title),
      description: String(row.description ?? ''),
      owner: String(row.owner ?? ''),
      priority: String(row.priority ?? ''),
      status: String(row.status ?? 'todo') as WorkspaceTaskStatus,
      dueAt: String(row.dueAt ?? ''),
    }));
    const logs = logsResult.rows.map((row) => ({
      id: toNumber(row.id),
      type: String(row.type ?? ''),
      title: String(row.title ?? ''),
      detail: String(row.detail ?? ''),
      createdAt: String(row.createdAt ?? ''),
    }));
    const taskStats = taskStatsResult.rows[0] ?? {};
    const enabledRuleCount = rules.filter((row) => row.enabled).length;
    const actionRunCount = actions.reduce((total, row) => total + toNumber(row.runCount), 0);
    const pendingTaskCount = toNumber(taskStats.pendingTaskCount);
    const doneTaskCount = toNumber(taskStats.doneTaskCount);
    const overdueTaskCount = toNumber(taskStats.overdueTaskCount);

    const summary = fallback.summary.length >= 3
      ? [
          {
            ...fallback.summary[0],
            value: pendingTaskCount,
            meta: `${doneTaskCount} done`,
          },
          {
            ...fallback.summary[1],
            value: enabledRuleCount,
            meta: `${rules.length} total`,
          },
          {
            ...fallback.summary[2],
            value: logs.length,
            meta: `${actionRunCount} runs`,
          },
        ]
      : fallback.summary;

    const insights = fallback.insights.length >= 2
      ? [
          {
            ...fallback.insights[0],
            content: `${moduleRow.featureLabel} has ${pendingTaskCount} open tasks and ${enabledRuleCount} enabled rules.`,
          },
          {
            ...fallback.insights[1],
            content:
              overdueTaskCount > 0
                ? `${overdueTaskCount} task(s) are overdue and should be reviewed first.`
                : 'Recent action logs are synced from PostgreSQL.',
          },
        ]
      : fallback.insights;

    return {
      ...fallback,
      featureKey: String(moduleRow.featureKey),
      featureLabel: String(moduleRow.featureLabel),
      groupKey: String(moduleRow.groupKey),
      groupLabel: String(moduleRow.groupLabel),
      statusTag: String(moduleRow.statusTag),
      updatedAt: String(moduleRow.updatedAt),
      summary,
      actions,
      rules,
      tasks,
      logs,
      insights,
    };
  }

  async getWorkspaceBusinessDetail(
    featureKey: string,
    fallback: WorkspaceBusinessDetail,
  ): Promise<WorkspaceBusinessDetail> {
    try {
      if (featureKey === 'system-monitoring' && fallback.kind === 'system-monitoring') {
        return await this.getSystemMonitoringDetail(fallback);
      }

      if (featureKey === 'ai-service' && fallback.kind === 'ai-service') {
        return await this.getAiServiceDetail(fallback);
      }
    } catch {
      // fall through to SQLite shadow payload
    }

    return fallback;
  }

  async getSystemHealthSnapshot(
    fallback?: SystemHealthSnapshot | null,
  ): Promise<SystemHealthSnapshot> {
    const emptySnapshot: SystemHealthSnapshot = {
      database: {
        path: fallback?.database?.path ?? 'postgres://tenant-business',
        sizeBytes: toNumber(fallback?.database?.sizeBytes),
      },
      alerts: {
        activeCount: toNumber(fallback?.alerts?.activeCount),
        criticalCount: toNumber(fallback?.alerts?.criticalCount),
      },
      jobs: {
        failedCount: toNumber(fallback?.jobs?.failedCount),
        pendingCount: toNumber(fallback?.jobs?.pendingCount),
      },
      backups: {
        successCount: toNumber(fallback?.backups?.successCount),
        latestBackupNo: fallback?.backups?.latestBackupNo ?? null,
        latestBackupAt: fallback?.backups?.latestBackupAt ?? null,
      },
      openPlatform: {
        appCount: toNumber(fallback?.openPlatform?.appCount),
        activeAppCount: toNumber(fallback?.openPlatform?.activeAppCount),
        recentCallCount: toNumber(fallback?.openPlatform?.recentCallCount),
        blockedCallCount: toNumber(fallback?.openPlatform?.blockedCallCount),
      },
      paths: {
        backupDir: fallback?.paths?.backupDir ?? '',
        logArchiveDir: fallback?.paths?.logArchiveDir ?? '',
        recoveryDir: fallback?.paths?.recoveryDir ?? '',
      },
    };

    try {
      const [
        databaseResult,
        alertStatsResult,
        jobStatsResult,
        backupLatestResult,
        backupCountResult,
        openPlatformStatsResult,
      ] = await Promise.all([
        this.pool.query(
          `
            SELECT
              current_database() AS "databaseName",
              pg_database_size(current_database()) AS "sizeBytes"
          `,
        ),
        this.pool.query(
          `
            SELECT
              SUM(CASE WHEN status != 'resolved' THEN 1 ELSE 0 END) AS "activeCount",
              SUM(CASE WHEN status != 'resolved' AND severity = 'critical' THEN 1 ELSE 0 END) AS "criticalCount"
            FROM system_alerts
          `,
        ),
        this.pool.query(
          `
            SELECT
              (
                SELECT COUNT(*) FROM card_delivery_jobs WHERE job_status = 'failed'
              ) +
              (
                SELECT COUNT(*) FROM direct_charge_jobs WHERE task_status IN ('failed', 'manual_review')
              ) +
              (
                SELECT COUNT(*) FROM supply_source_orders WHERE order_status IN ('failed', 'manual_review')
              ) AS "failedCount",
              (
                SELECT COUNT(*) FROM card_delivery_jobs WHERE job_status = 'pending'
              ) +
              (
                SELECT COUNT(*) FROM direct_charge_jobs WHERE task_status IN ('pending_dispatch', 'processing')
              ) +
              (
                SELECT COUNT(*) FROM supply_source_orders WHERE order_status IN ('pending_push', 'processing')
              ) AS "pendingCount"
          `,
        ),
        this.pool.query(
          `
            SELECT
              backup_no AS "backupNo",
              started_at AS "startedAt"
            FROM system_backup_runs
            WHERE run_status = 'success'
            ORDER BY started_at DESC, id DESC
            LIMIT 1
          `,
        ),
        this.pool.query(
          `
            SELECT COUNT(*) AS count
            FROM system_backup_runs
            WHERE run_status = 'success'
          `,
        ),
        this.pool.query(
          `
            SELECT
              (SELECT COUNT(*) FROM open_platform_apps) AS "appCount",
              (SELECT COUNT(*) FROM open_platform_apps WHERE status = 'active') AS "activeAppCount",
              (
                SELECT COUNT(*)
                FROM open_platform_call_logs
                WHERE created_at >= to_char(CURRENT_TIMESTAMP - INTERVAL '7 day', 'YYYY-MM-DD HH24:MI:SS')
              ) AS "recentCallCount",
              (
                SELECT COUNT(*)
                FROM open_platform_call_logs
                WHERE call_status = 'blocked'
                  AND created_at >= to_char(CURRENT_TIMESTAMP - INTERVAL '7 day', 'YYYY-MM-DD HH24:MI:SS')
              ) AS "blockedCallCount"
          `,
        ),
      ]);

      const databaseRow = databaseResult.rows[0] ?? {};
      const alertStats = alertStatsResult.rows[0] ?? {};
      const jobStats = jobStatsResult.rows[0] ?? {};
      const latestBackup = backupLatestResult.rows[0] ?? {};
      const backupCount = backupCountResult.rows[0] ?? {};
      const openPlatformStats = openPlatformStatsResult.rows[0] ?? {};

      return {
        database: {
          path: emptySnapshot.database.path || `postgres://${String(databaseRow.databaseName ?? 'tenant-business')}`,
          sizeBytes: toNumber(databaseRow.sizeBytes),
        },
        alerts: {
          activeCount: toNumber(alertStats.activeCount),
          criticalCount: toNumber(alertStats.criticalCount),
        },
        jobs: {
          failedCount: toNumber(jobStats.failedCount),
          pendingCount: toNumber(jobStats.pendingCount),
        },
        backups: {
          successCount: toNumber(backupCount.count),
          latestBackupNo: latestBackup.backupNo ? String(latestBackup.backupNo) : null,
          latestBackupAt: latestBackup.startedAt ? String(latestBackup.startedAt) : null,
        },
        openPlatform: {
          appCount: toNumber(openPlatformStats.appCount),
          activeAppCount: toNumber(openPlatformStats.activeAppCount),
          recentCallCount: toNumber(openPlatformStats.recentCallCount),
          blockedCallCount: toNumber(openPlatformStats.blockedCallCount),
        },
        paths: emptySnapshot.paths,
      };
    } catch {
      return emptySnapshot;
    }
  }

  async recordAuditLog(input: AuditLogInput) {
    const now = format(new Date(), 'yyyy-MM-dd HH:mm:ss');
    const nextId = await this.nextTableId(this.pool, 'audit_logs');
    await this.pool.query(
      `
        INSERT INTO audit_logs (
          id,
          operator_user_id,
          operator_username,
          operator_display_name,
          action,
          target_type,
          target_id,
          detail,
          result,
          ip_address,
          created_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      `,
      [
        nextId,
        input.operator?.id ?? null,
        input.operator?.username ?? null,
        input.operator?.displayName ?? null,
        input.action,
        input.targetType,
        input.targetId ?? null,
        input.detail,
        input.result,
        input.ipAddress ?? null,
        now,
      ],
    );
  }

  async getOpenPlatformAppsDetail() {
    const [appsResult, recentCallsResult, settingsResult] = await Promise.all([
      this.pool.query(
        `
          SELECT
            app.id,
            app.app_key AS "appKey",
            app.app_name AS "appName",
            app.owner_name AS "ownerName",
            app.contact_name AS "contactName",
            app.callback_url AS "callbackUrl",
            app.status,
            app.scopes_text AS "scopesText",
            app.rate_limit_per_minute AS "rateLimitPerMinute",
            app.last_called_at AS "lastCalledAt",
            app.created_at AS "createdAt",
            app.updated_at AS "updatedAt",
            ss.value_masked AS "secretMasked",
            COALESCE(stats."successCount", 0) AS "successCount",
            COALESCE(stats."blockedCount", 0) AS "blockedCount",
            COALESCE(stats."failureCount", 0) AS "failureCount"
          FROM open_platform_apps app
          LEFT JOIN secure_settings ss ON ss.key = app.secret_setting_key
          LEFT JOIN (
            SELECT
              app_key,
              SUM(CASE WHEN call_status = 'success' THEN 1 ELSE 0 END) AS "successCount",
              SUM(CASE WHEN call_status = 'blocked' THEN 1 ELSE 0 END) AS "blockedCount",
              SUM(CASE WHEN call_status = 'failure' THEN 1 ELSE 0 END) AS "failureCount"
            FROM open_platform_call_logs
            WHERE created_at >= to_char(CURRENT_TIMESTAMP - INTERVAL '7 day', 'YYYY-MM-DD HH24:MI:SS')
            GROUP BY app_key
          ) stats ON stats.app_key = app.app_key
          ORDER BY app.updated_at DESC, app.id DESC
        `,
      ),
      this.pool.query(
        `
          SELECT
            id,
            app_key AS "appKey",
            tenant_key AS "tenantKey",
            trace_id AS "traceId",
            http_method AS "httpMethod",
            route_path AS "routePath",
            request_ip AS "requestIp",
            status_code AS "statusCode",
            call_status AS "callStatus",
            duration_ms AS "durationMs",
            detail,
            created_at AS "createdAt"
          FROM open_platform_call_logs
          ORDER BY created_at DESC, id DESC
          LIMIT 12
        `,
      ),
      this.pool.query(
        `
          SELECT
            ops.webhook_base_url AS "webhookBaseUrl",
            ops.notify_email AS "notifyEmail",
            ops.published_version AS "publishedVersion",
            ops.default_rate_limit_per_minute AS "defaultRateLimitPerMinute",
            ops.signature_ttl_seconds AS "signatureTtlSeconds",
            ops.whitelist_enforced AS "whitelistEnforced",
            ops.updated_at AS "updatedAt",
            u.display_name AS "updatedByName"
          FROM open_platform_settings ops
          LEFT JOIN users u ON u.id = ops.updated_by
          WHERE ops.id = 1
        `,
      ),
    ]);

    const apps = appsResult.rows.map((row) => ({
      ...row,
      scopes: normalizeOpenPlatformScopes(String(row.scopesText ?? '')),
      totalCallCount:
        toNumber(row.successCount) + toNumber(row.blockedCount) + toNumber(row.failureCount),
      secretMasked: row.secretMasked ?? '未生成',
    }));
    const recentCalls = recentCallsResult.rows;
    const settings = settingsResult.rows[0] ?? null;

    return {
      kind: 'open-apps' as const,
      title: '开放应用',
      description: '管理第三方接入应用、签名密钥和最近 7 天的调用状态。',
      metrics: [
        { label: '应用总数', value: apps.length, unit: '个', helper: '当前租户录入的开放应用数量' },
        {
          label: '启用应用',
          value: apps.filter((row) => row.status === 'active').length,
          unit: '个',
          helper: '可以正常发起调用的应用',
        },
        {
          label: '近 7 天调用',
          value: recentCalls.length === 0 ? 0 : apps.reduce((total, row) => total + row.totalCallCount, 0),
          unit: '次',
          helper: '包含成功、拦截和失败调用',
        },
        {
          label: '默认限流',
          value: Number(settings?.defaultRateLimitPerMinute ?? 0),
          unit: '次/分钟',
          helper: '未单独配置时的默认速率限制',
        },
      ],
      apps,
      recentCalls,
    };
  }

  async getOpenPlatformDocsDetail() {
    const [docsResult, settingsResult] = await Promise.all([
      this.pool.query(
        `
          SELECT
            id,
            doc_key AS "docKey",
            title,
            category,
            http_method AS "httpMethod",
            route_path AS "routePath",
            status,
            scope_text AS "scopeText",
            version_tag AS "versionTag",
            description,
            sample_payload AS "samplePayload",
            created_at AS "createdAt",
            updated_at AS "updatedAt"
          FROM open_platform_docs
          ORDER BY category ASC, id ASC
        `,
      ),
      this.pool.query(
        `
          SELECT
            published_version AS "publishedVersion"
          FROM open_platform_settings
          WHERE id = 1
        `,
      ),
    ]);
    const docs = docsResult.rows;
    const settings = settingsResult.rows[0] ?? null;
    return {
      kind: 'open-docs' as const,
      title: '开放文档',
      description: '统一维护公网 API 文档、发布版本和签名约定。',
      metrics: [
        { label: '文档数', value: docs.length, unit: '份', helper: '包含已发布和草稿文档' },
        {
          label: '已发布',
          value: docs.filter((row) => row.status === 'published').length,
          unit: '份',
          helper: '当前对外可用的文档',
        },
        {
          label: '当前版本',
          value: settings?.publishedVersion ?? 'v2',
          unit: '',
          helper: '对外发布的文档版本',
        },
        {
          label: '读取接口',
          value: docs.filter((row) => row.category === '读取接口').length,
          unit: '份',
          helper: '以查询和聚合为主的接口文档',
        },
      ],
      docs,
    };
  }

  async getOpenPlatformSettingsDetail() {
    const [settingsResult, appsResult, rulesResult] = await Promise.all([
      this.pool.query(
        `
          SELECT
            ops.webhook_base_url AS "webhookBaseUrl",
            ops.notify_email AS "notifyEmail",
            ops.published_version AS "publishedVersion",
            ops.default_rate_limit_per_minute AS "defaultRateLimitPerMinute",
            ops.signature_ttl_seconds AS "signatureTtlSeconds",
            ops.whitelist_enforced AS "whitelistEnforced",
            ops.updated_at AS "updatedAt",
            u.display_name AS "updatedByName"
          FROM open_platform_settings ops
          LEFT JOIN users u ON u.id = ops.updated_by
          WHERE ops.id = 1
        `,
      ),
      this.pool.query(
        `
          SELECT
            app.app_key AS "appKey",
            ss.value_masked AS "secretMasked"
          FROM open_platform_apps app
          LEFT JOIN secure_settings ss ON ss.key = app.secret_setting_key
        `,
      ),
      this.pool.query(
        `
          SELECT enabled
          FROM open_platform_whitelist_rules
        `,
      ),
    ]);
    const settings = settingsResult.rows[0] ?? null;
    const apps = appsResult.rows;
    const rules = rulesResult.rows;
    return {
      kind: 'open-settings' as const,
      title: '开放平台设置',
      description: '管理回调域名、默认速率限制、签名时效和白名单策略。',
      metrics: [
        {
          label: '已配置密钥',
          value: apps.filter((row) => row.secretMasked !== '未生成' && row.secretMasked != null).length,
          unit: '个',
          helper: '开放应用签名密钥已脱敏存储',
        },
        {
          label: '启用白名单',
          value: rules.filter((row) => Boolean(row.enabled)).length,
          unit: '条',
          helper: '当前启用的来源控制规则',
        },
        {
          label: '签名有效期',
          value: Number(settings?.signatureTtlSeconds ?? 0),
          unit: '秒',
          helper: '请求允许的时间偏差',
        },
        {
          label: '默认回调域名',
          value: settings?.webhookBaseUrl || '未配置',
          unit: '',
          helper: '新应用默认使用的回调域名',
        },
      ],
      settings: settings
        ? {
            ...settings,
            whitelistEnforced: Boolean(settings.whitelistEnforced),
          }
        : null,
    };
  }

  async getOpenPlatformWhitelistDetail() {
    const [rulesResult, recentCallsResult] = await Promise.all([
      this.pool.query(
        `
          SELECT
            rule.id AS id,
            rule.rule_type AS "ruleType",
            rule.rule_value AS "ruleValue",
            rule.description AS description,
            rule.enabled AS enabled,
            rule.hit_count AS "hitCount",
            rule.last_hit_at AS "lastHitAt",
            rule.created_at AS "createdAt",
            rule.updated_at AS "updatedAt",
            u.display_name AS "updatedByName"
          FROM open_platform_whitelist_rules rule
          LEFT JOIN users u ON u.id = rule.updated_by
          ORDER BY rule.enabled DESC, rule.updated_at DESC, rule.id DESC
        `,
      ),
      this.pool.query(
        `
          SELECT
            call_status AS "callStatus"
          FROM open_platform_call_logs
          ORDER BY created_at DESC, id DESC
          LIMIT 20
        `,
      ),
    ]);
    const rules = rulesResult.rows.map((row) => ({
      ...row,
      enabled: Boolean(row.enabled),
    }));
    const recentCalls = recentCallsResult.rows;
    return {
      kind: 'open-whitelist' as const,
      title: '开放平台白名单',
      description: '按来源 IP 控制公网 API 可访问范围，并结合调用留痕做防护。',
      metrics: [
        { label: '规则总数', value: rules.length, unit: '条', helper: '当前租户的白名单规则数' },
        {
          label: '已启用',
          value: rules.filter((row) => row.enabled).length,
          unit: '条',
          helper: '当前参与校验的规则',
        },
        {
          label: '累计命中',
          value: rules.reduce((total, row) => total + Number(row.hitCount ?? 0), 0),
          unit: '次',
          helper: '白名单规则命中的累计次数',
        },
        {
          label: '近 7 天拦截',
          value: recentCalls.filter((row) => row.callStatus === 'blocked').length,
          unit: '次',
          helper: '白名单或签名校验拦截的请求',
        },
      ],
      rules,
    };
  }

  async verifyOpenPlatformRequest(input: {
    tenantKey: string;
    appKey: string;
    timestamp: string;
    signature: string;
    httpMethod: string;
    routePath: string;
    requestIp: string;
    requiredScope: string;
  }) {
    const appResult = await this.pool.query(
      `
        SELECT
          id,
          app_key AS "appKey",
          app_name AS "appName",
          status,
          scopes_text AS "scopesText",
          secret_setting_key AS "secretSettingKey",
          rate_limit_per_minute AS "rateLimitPerMinute"
        FROM open_platform_apps
        WHERE app_key = $1
        LIMIT 1
      `,
      [input.appKey],
    );
    const app = appResult.rows[0] as
      | {
          id: number;
          appKey: string;
          appName: string;
          status: 'active' | 'suspended';
          scopesText: string;
          secretSettingKey: string;
          rateLimitPerMinute: number;
        }
      | undefined;

    if (!app) {
      throw new Error('开放应用不存在');
    }
    if (app.status !== 'active') {
      throw new Error('开放应用已停用');
    }

    const scopes = normalizeOpenPlatformScopes(app.scopesText);
    if (!scopes.includes(input.requiredScope)) {
      throw new Error('开放应用未授权当前接口范围');
    }

    const settings = await this.getOpenPlatformSettingsRow();
    const ttlSeconds = Math.max(Number(settings?.signatureTtlSeconds ?? 300), 60);
    const requestTime = Number(input.timestamp);
    if (!Number.isFinite(requestTime)) {
      throw new Error('签名时间戳无效');
    }
    if (Math.abs(Date.now() - requestTime) > ttlSeconds * 1000) {
      throw new Error('签名已过期');
    }

    const secret = await this.getOpenPlatformAppSecret(app.secretSettingKey);
    if (!secret) {
      throw new Error('开放应用未配置签名密钥');
    }

    const expectedSignature = createHmac('sha256', secret)
      .update(`${app.appKey}.${input.timestamp}.${input.httpMethod.toUpperCase()}.${input.routePath}`)
      .digest('hex');
    if (expectedSignature !== input.signature.trim().toLowerCase()) {
      throw new Error('签名校验失败');
    }

    const rulesResult = await this.pool.query(
      `
        SELECT rule_value AS "ruleValue"
        FROM open_platform_whitelist_rules
        WHERE enabled = 1
        ORDER BY id ASC
      `,
    );
    const whitelistEnforced = Boolean(settings?.whitelistEnforced);
    if (
      whitelistEnforced &&
      rulesResult.rows.length > 0 &&
      !rulesResult.rows.some((row) =>
        this.matchOpenPlatformIpRule(String(row.ruleValue ?? ''), input.requestIp),
      )
    ) {
      throw new Error('来源地址未命中白名单');
    }

    return {
      ...app,
      scopes,
    };
  }

  async recordOpenPlatformCallLog(input: {
    appId: number | null;
    appKey: string;
    tenantKey: string;
    traceId: string;
    httpMethod: string;
    routePath: string;
    requestIp: string | null;
    statusCode: number;
    callStatus: 'success' | 'blocked' | 'failure';
    durationMs: number;
    detail: string;
  }) {
    const now = format(new Date(), 'yyyy-MM-dd HH:mm:ss');
    const callLogId = await this.nextTableId(this.pool, 'open_platform_call_logs');
    await this.pool.query(
      `
        INSERT INTO open_platform_call_logs (
          id,
          app_id,
          app_key,
          tenant_key,
          trace_id,
          http_method,
          route_path,
          request_ip,
          status_code,
          call_status,
          duration_ms,
          detail,
          created_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13
        )
      `,
      [
        callLogId,
        input.appId,
        input.appKey,
        input.tenantKey,
        input.traceId,
        input.httpMethod,
        input.routePath,
        input.requestIp,
        input.statusCode,
        input.callStatus,
        Math.max(Math.trunc(input.durationMs), 0),
        input.detail,
        now,
      ],
    );
  }

  async getOpenPlatformPublicDashboardSummary() {
    return this.getDashboard({ preset: 'last30Days' }, this.createDashboardFallback());
  }

  async getOpenPlatformPublicOrdersOverview() {
    return this.getOrdersOverview({ preset: 'last30Days' });
  }

  async openPlatformVerifyRequest(input: {
    tenantKey: string;
    appKey: string;
    timestamp: string;
    signature: string;
    httpMethod: string;
    routePath: string;
    requestIp: string;
    requiredScope: string;
  }) {
    return this.verifyOpenPlatformRequest(input);
  }

  async openPlatformRecordCallLog(input: {
    appId: number | null;
    appKey: string;
    tenantKey: string;
    traceId: string;
    httpMethod: string;
    routePath: string;
    requestIp: string | null;
    statusCode: number;
    callStatus: 'success' | 'blocked' | 'failure';
    durationMs: number;
    detail: string;
  }) {
    return this.recordOpenPlatformCallLog(input);
  }

  async openPlatformGetPublicDashboardSummary() {
    return this.getOpenPlatformPublicDashboardSummary();
  }

  async openPlatformGetPublicOrdersOverview() {
    return this.getOpenPlatformPublicOrdersOverview();
  }

  async createOpenPlatformApp(input: {
    appName: string;
    ownerName: string;
    contactName?: string;
    callbackUrl?: string;
    scopes: string[];
    rateLimitPerMinute?: number;
    updatedByUserId: number | null;
  }) {
    const client = await this.pool.connect();
    let transactionOpen = false;
    try {
      await client.query('BEGIN');
      transactionOpen = true;

      const now = format(new Date(), 'yyyy-MM-dd HH:mm:ss');
      const normalizedBase =
        input.appName
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '')
          .slice(0, 24) || 'open-app';

      let appKey = normalizedBase;
      let suffix = 2;
      while (true) {
        const existsResult = await client.query(
          `SELECT 1 FROM open_platform_apps WHERE app_key = $1 LIMIT 1`,
          [appKey],
        );
        if (existsResult.rowCount === 0) {
          break;
        }
        appKey = `${normalizedBase}-${suffix}`;
        suffix += 1;
      }

      const appId = await this.nextTableId(client, 'open_platform_apps');
      const secretSettingKey = buildOpenPlatformSecretSettingKey(appKey);
      const secretPlainText = randomBytes(24).toString('base64url');
      await this.upsertSecureSetting(
        client,
        secretSettingKey,
        `Open-platform app ${input.appName.trim()} signing secret`,
        secretPlainText,
        input.updatedByUserId,
        now,
      );

      await client.query(
        `
          INSERT INTO open_platform_apps (
            id,
            app_key,
            app_name,
            owner_name,
            contact_name,
            callback_url,
            status,
            scopes_text,
            secret_setting_key,
            rate_limit_per_minute,
            created_at,
            updated_at,
            updated_by
          )
          VALUES (
            $1, $2, $3, $4, $5, $6, 'active', $7, $8, $9, $10, $10, $11
          )
        `,
        [
          appId,
          appKey,
          input.appName.trim(),
          input.ownerName.trim(),
          input.contactName?.trim() ?? '',
          input.callbackUrl?.trim() ?? '',
          input.scopes.join(','),
          secretSettingKey,
          Math.max(input.rateLimitPerMinute ?? 120, 30),
          now,
          input.updatedByUserId,
        ],
      );

      const createdResult = await client.query(
        `
          SELECT
            id,
            app_key AS "appKey",
            app_name AS "appName",
            owner_name AS "ownerName",
            contact_name AS "contactName",
            callback_url AS "callbackUrl",
            status,
            scopes_text AS "scopesText",
            rate_limit_per_minute AS "rateLimitPerMinute",
            created_at AS "createdAt",
            updated_at AS "updatedAt"
          FROM open_platform_apps
          WHERE id = $1
        `,
        [appId],
      );

      await client.query('COMMIT');
      transactionOpen = false;

      const created = createdResult.rows[0];
      return created
        ? {
            ...created,
            scopes: normalizeOpenPlatformScopes(String(created.scopesText ?? '')),
            secretPlainText,
          }
        : null;
    } catch (error) {
      if (transactionOpen) {
        await client.query('ROLLBACK');
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async updateOpenPlatformAppStatus(appId: number, status: 'active' | 'suspended') {
    const now = format(new Date(), 'yyyy-MM-dd HH:mm:ss');
    const result = await this.pool.query(
      `
        UPDATE open_platform_apps
        SET status = $1, updated_at = $2
        WHERE id = $3
      `,
      [status, now, appId],
    );
    if (result.rowCount === 0) {
      return null;
    }

    const appResult = await this.pool.query(
      `
        SELECT
          id,
          app_key AS "appKey",
          app_name AS "appName",
          status,
          updated_at AS "updatedAt"
        FROM open_platform_apps
        WHERE id = $1
      `,
      [appId],
    );
    return appResult.rows[0] ?? null;
  }

  async rotateOpenPlatformAppSecret(appId: number, updatedByUserId: number | null) {
    const client = await this.pool.connect();
    let transactionOpen = false;
    try {
      await client.query('BEGIN');
      transactionOpen = true;

      const appResult = await client.query(
        `
          SELECT
            id,
            app_key AS "appKey",
            app_name AS "appName",
            secret_setting_key AS "secretSettingKey"
          FROM open_platform_apps
          WHERE id = $1
        `,
        [appId],
      );
      const app = appResult.rows[0] as
        | {
            id: number;
            appKey: string;
            appName: string;
            secretSettingKey: string;
          }
        | undefined;
      if (!app) {
        await client.query('ROLLBACK');
        transactionOpen = false;
        return null;
      }

      const secretPlainText = randomBytes(24).toString('base64url');
      const now = format(new Date(), 'yyyy-MM-dd HH:mm:ss');
      const setting = await this.upsertSecureSetting(
        client,
        app.secretSettingKey,
        `Open-platform app ${app.appName} signing secret`,
        secretPlainText,
        updatedByUserId,
        now,
      );

      await client.query(`UPDATE open_platform_apps SET updated_at = $1 WHERE id = $2`, [now, appId]);

      await client.query('COMMIT');
      transactionOpen = false;

      return {
        ...app,
        secretPlainText,
        secretMasked: setting.maskedValue,
        updatedAt: now,
      };
    } catch (error) {
      if (transactionOpen) {
        await client.query('ROLLBACK');
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async updateOpenPlatformSettings(input: {
    webhookBaseUrl?: string;
    notifyEmail?: string;
    publishedVersion?: string;
    defaultRateLimitPerMinute?: number;
    signatureTtlSeconds?: number;
    whitelistEnforced?: boolean;
    updatedByUserId: number | null;
  }) {
    const current = await this.getOpenPlatformSettingsRow();
    if (!current) {
      return null;
    }

    const now = format(new Date(), 'yyyy-MM-dd HH:mm:ss');
    await this.pool.query(
      `
        UPDATE open_platform_settings
        SET
          webhook_base_url = $1,
          notify_email = $2,
          published_version = $3,
          default_rate_limit_per_minute = $4,
          signature_ttl_seconds = $5,
          whitelist_enforced = $6,
          updated_at = $7,
          updated_by = $8
        WHERE id = 1
      `,
      [
        input.webhookBaseUrl?.trim() ?? current.webhookBaseUrl,
        input.notifyEmail?.trim() ?? current.notifyEmail,
        input.publishedVersion?.trim() ?? current.publishedVersion,
        Math.max(input.defaultRateLimitPerMinute ?? current.defaultRateLimitPerMinute, 30),
        Math.max(input.signatureTtlSeconds ?? current.signatureTtlSeconds, 60),
        input.whitelistEnforced ?? current.whitelistEnforced ? 1 : 0,
        now,
        input.updatedByUserId,
      ],
    );

    return (await this.getOpenPlatformSettingsDetail()).settings;
  }

  async createOpenPlatformWhitelistRule(input: {
    ruleType: 'ip';
    ruleValue: string;
    description?: string;
    enabled?: boolean;
    updatedByUserId: number | null;
  }) {
    const now = format(new Date(), 'yyyy-MM-dd HH:mm:ss');
    const ruleId = await this.nextTableId(this.pool, 'open_platform_whitelist_rules');
    await this.pool.query(
      `
        INSERT INTO open_platform_whitelist_rules (
          id,
          rule_type,
          rule_value,
          description,
          enabled,
          hit_count,
          created_at,
          updated_at,
          updated_by
        )
        VALUES ($1, $2, $3, $4, $5, 0, $6, $6, $7)
      `,
      [
        ruleId,
        input.ruleType,
        input.ruleValue.trim(),
        input.description?.trim() ?? '',
        input.enabled ?? true ? 1 : 0,
        now,
        input.updatedByUserId,
      ],
    );

    const ruleResult = await this.pool.query(
      `
        SELECT
          id,
          rule_type AS "ruleType",
          rule_value AS "ruleValue",
          description,
          enabled,
          hit_count AS "hitCount",
          last_hit_at AS "lastHitAt",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM open_platform_whitelist_rules
        WHERE id = $1
      `,
      [ruleId],
    );
    return ruleResult.rows[0] ?? null;
  }

  async updateOpenPlatformWhitelistRuleEnabled(
    ruleId: number,
    enabled: boolean,
    updatedByUserId: number | null,
  ) {
    const now = format(new Date(), 'yyyy-MM-dd HH:mm:ss');
    const result = await this.pool.query(
      `
        UPDATE open_platform_whitelist_rules
        SET enabled = $1, updated_at = $2, updated_by = $3
        WHERE id = $4
      `,
      [enabled ? 1 : 0, now, updatedByUserId, ruleId],
    );
    if (result.rowCount === 0) {
      return null;
    }

    const ruleResult = await this.pool.query(
      `
        SELECT
          id,
          rule_type AS "ruleType",
          rule_value AS "ruleValue",
          description,
          enabled,
          hit_count AS "hitCount",
          last_hit_at AS "lastHitAt",
          created_at AS "createdAt",
          updated_at AS "updatedAt"
        FROM open_platform_whitelist_rules
        WHERE id = $1
      `,
      [ruleId],
    );
    return ruleResult.rows[0] ?? null;
  }

  async updateAiServiceSettings(
    featureKey: string,
    input: {
      aiEnabled?: boolean;
      autoReplyEnabled?: boolean;
      faqEnabled?: boolean;
      orderQueryEnabled?: boolean;
      afterSaleSuggestionEnabled?: boolean;
      highRiskManualOnly?: boolean;
      boundaryNote?: string;
      sensitiveWordsText?: string;
    },
    operator: { id: number; displayName: string },
  ) {
    if (featureKey !== 'ai-service') {
      return null;
    }

    const current = await this.getAiServiceSettingsRow();
    if (!current) {
      return null;
    }

    const next = {
      aiEnabled: input.aiEnabled ?? current.aiEnabled,
      autoReplyEnabled: input.autoReplyEnabled ?? current.autoReplyEnabled,
      faqEnabled: input.faqEnabled ?? current.faqEnabled,
      orderQueryEnabled: input.orderQueryEnabled ?? current.orderQueryEnabled,
      afterSaleSuggestionEnabled:
        input.afterSaleSuggestionEnabled ?? current.afterSaleSuggestionEnabled,
      highRiskManualOnly: input.highRiskManualOnly ?? current.highRiskManualOnly,
      boundaryNote: input.boundaryNote ?? current.boundaryNote,
      sensitiveWordsText: input.sensitiveWordsText ?? current.sensitiveWordsText,
    };
    const now = format(new Date(), 'yyyy-MM-dd HH:mm:ss');

    const client = await this.pool.connect();
    let transactionOpen = false;
    try {
      await client.query('BEGIN');
      transactionOpen = true;

      await client.query(
        `
          UPDATE ai_service_settings
          SET
            ai_enabled = $1,
            auto_reply_enabled = $2,
            faq_enabled = $3,
            order_query_enabled = $4,
            after_sale_suggestion_enabled = $5,
            high_risk_manual_only = $6,
            boundary_note = $7,
            sensitive_words_text = $8,
            updated_at = $9,
            updated_by = $10
          WHERE id = 1
        `,
        [
          next.aiEnabled ? 1 : 0,
          next.autoReplyEnabled ? 1 : 0,
          next.faqEnabled ? 1 : 0,
          next.orderQueryEnabled ? 1 : 0,
          next.afterSaleSuggestionEnabled ? 1 : 0,
          next.highRiskManualOnly ? 1 : 0,
          next.boundaryNote,
          next.sensitiveWordsText,
          now,
          operator.id,
        ],
      );

      await this.insertWorkspaceLog(
        client,
        featureKey,
        'policy',
        'AI service settings updated',
        `${operator.displayName} updated the AI service policy switches.`,
        now,
      );
      await this.touchWorkspace(client, featureKey, now);

      await client.query('COMMIT');
      transactionOpen = false;
    } catch (error) {
      if (transactionOpen) {
        await client.query('ROLLBACK');
      }
      throw error;
    } finally {
      client.release();
    }

    return this.getAiServiceSettingsRow();
  }

  async updateAiServiceKnowledgeItemEnabled(
    featureKey: string,
    knowledgeItemId: number,
    enabled: boolean,
  ) {
    if (featureKey !== 'ai-service') {
      return null;
    }

    const client = await this.pool.connect();
    let transactionOpen = false;
    try {
      await client.query('BEGIN');
      transactionOpen = true;

      const rowResult = await client.query(
        `SELECT id, title FROM ai_service_knowledge_items WHERE id = $1`,
        [knowledgeItemId],
      );
      const row = rowResult.rows[0] as { id: number; title: string } | undefined;
      if (!row) {
        await client.query('ROLLBACK');
        transactionOpen = false;
        return null;
      }

      const now = format(new Date(), 'yyyy-MM-dd HH:mm:ss');
      await client.query(
        `
          UPDATE ai_service_knowledge_items
          SET enabled = $1, updated_at = $2
          WHERE id = $3
        `,
        [enabled ? 1 : 0, now, knowledgeItemId],
      );
      await this.insertWorkspaceLog(
        client,
        featureKey,
        'knowledge',
        `${row.title} ${enabled ? 'enabled' : 'disabled'}`,
        `AI knowledge item ${row.title} status was updated.`,
        now,
      );
      await this.touchWorkspace(client, featureKey, now);

      await client.query('COMMIT');
      transactionOpen = false;
      return { enabled };
    } catch (error) {
      if (transactionOpen) {
        await client.query('ROLLBACK');
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async updateAiServiceReplyTemplateEnabled(
    featureKey: string,
    templateId: number,
    enabled: boolean,
  ) {
    if (featureKey !== 'ai-service') {
      return null;
    }

    const client = await this.pool.connect();
    let transactionOpen = false;
    try {
      await client.query('BEGIN');
      transactionOpen = true;

      const rowResult = await client.query(
        `SELECT id, title FROM ai_service_reply_templates WHERE id = $1`,
        [templateId],
      );
      const row = rowResult.rows[0] as { id: number; title: string } | undefined;
      if (!row) {
        await client.query('ROLLBACK');
        transactionOpen = false;
        return null;
      }

      const now = format(new Date(), 'yyyy-MM-dd HH:mm:ss');
      await client.query(
        `
          UPDATE ai_service_reply_templates
          SET enabled = $1, updated_at = $2
          WHERE id = $3
        `,
        [enabled ? 1 : 0, now, templateId],
      );
      await this.insertWorkspaceLog(
        client,
        featureKey,
        'template',
        `${row.title} ${enabled ? 'enabled' : 'disabled'}`,
        `AI reply template ${row.title} status was updated.`,
        now,
      );
      await this.touchWorkspace(client, featureKey, now);

      await client.query('COMMIT');
      transactionOpen = false;
      return { enabled };
    } catch (error) {
      if (transactionOpen) {
        await client.query('ROLLBACK');
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async writeAiServiceLlmReply(
    featureKey: string,
    conversationId: number,
    content: string,
    operator: { id: number; displayName: string },
  ): Promise<AiServiceLlmReply> {
    if (featureKey !== 'ai-service') {
      return null;
    }

    const context = await this.getAiServiceConversationContext(conversationId);
    if (!context) {
      return null;
    }

    const client = await this.pool.connect();
    let transactionOpen = false;
    try {
      await client.query('BEGIN');
      transactionOpen = true;

      const now = format(new Date(), 'yyyy-MM-dd HH:mm:ss');
      const messageTime = await this.appendAiServiceMessage(client, {
        conversationId,
        senderType: 'ai',
        senderName: 'AI 客服（LLM）',
        scene: 'llm',
        content,
        status: 'pending',
        operatorUserId: operator.id,
        createdAt: now,
      });
      await this.updateAiServiceConversationState(client, conversationId, {
        conversationStatus: 'open',
        aiStatus: 'auto_replied',
        latestUserIntent: context.latestUserIntent,
        boundaryLabel: 'LLM 智能回复',
        unreadCount: 0,
        updatedAt: messageTime,
      });
      await this.insertWorkspaceLog(
        client,
        featureKey,
        'ai_reply',
        `${context.sessionNo} LLM 已生成智能回复`,
        `${operator.displayName} 触发了会话 ${context.sessionNo} 的大模型智能回复。`,
        now,
      );
      await this.touchWorkspace(client, featureKey, now);

      await client.query('COMMIT');
      transactionOpen = false;
      return {
        reused: false,
        replyType: 'ai',
        conversationStatus: 'open',
        aiStatus: 'auto_replied',
        content,
      };
    } catch (error) {
      if (transactionOpen) {
        await client.query('ROLLBACK');
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async generateAiServiceReply(
    featureKey: string,
    conversationId: number,
    operator: { id: number; displayName: string },
  ): Promise<AiServiceGeneratedReply> {
    if (featureKey !== 'ai-service') {
      return null;
    }

    const settings = await this.getAiServiceSettingsRow();
    const context = await this.getAiServiceConversationContext(conversationId);
    const latestCustomerMessage = await this.getAiServiceLatestCustomerMessage(conversationId);
    if (!settings || !context || !latestCustomerMessage) {
      return null;
    }

    const latestOutboundMessage = await this.getAiServiceLatestOutboundMessage(conversationId);
    if (
      latestOutboundMessage &&
      latestOutboundMessage.createdAt >= latestCustomerMessage.createdAt &&
      ['ai', 'suggestion', 'system'].includes(latestOutboundMessage.senderType)
    ) {
      return {
        reused: true,
        replyType: latestOutboundMessage.senderType,
        conversationStatus: context.conversationStatus,
        aiStatus: context.aiStatus,
        content: latestOutboundMessage.content,
      };
    }

    const now = format(new Date(), 'yyyy-MM-dd HH:mm:ss');
    const sensitiveWords = this.parseAiServiceSensitiveWords(settings.sensitiveWordsText);
    const isHighRiskMessage =
      context.riskLevel === 'high' || this.isAiServiceHighRiskMessage(latestCustomerMessage.content, sensitiveWords);

    let replyType: 'ai' | 'suggestion' | 'system' = 'suggestion';
    let scene = 'fallback';
    let status = 'suggested';
    let content = '';
    let relatedKnowledgeId: number | null = null;
    let relatedTemplateId: number | null = null;
    let conversationStatus = context.conversationStatus;
    let aiStatus = context.aiStatus;
    let boundaryLabel = context.boundaryLabel || '标准答复';

    if (!settings.aiEnabled || !settings.autoReplyEnabled) {
      replyType = 'system';
      scene = 'policy';
      status = 'blocked';
      content = 'AI 客服当前已关闭，本次会话需要人工处理。';
      conversationStatus = 'pending_manual';
      aiStatus = 'disabled';
      boundaryLabel = 'AI 已关闭';
    } else if (isHighRiskMessage && settings.highRiskManualOnly) {
      replyType = 'system';
      scene = 'risk';
      status = 'blocked';
      content = '已识别为高风险会话，建议立即转人工接管并按边界话术回复。';
      conversationStatus = 'pending_manual';
      aiStatus = 'manual_only';
      boundaryLabel = '高风险转人工';
    } else if (
      settings.afterSaleSuggestionEnabled &&
      (context.caseId !== null || this.isAiServiceAfterSaleMessage(latestCustomerMessage.content))
    ) {
      const suggestion = context.caseId ? await this.buildAiServiceAfterSaleSuggestion(context.caseId) : null;
      replyType = 'suggestion';
      scene = 'after_sale';
      status = 'suggested';
      content =
        suggestion?.content ??
        '建议回复：当前问题涉及售后，请先确认订单状态、售后类型和系统记录，再由人工发送最终口径。';
      relatedTemplateId = suggestion?.templateId ?? null;
      conversationStatus = 'pending_manual';
      aiStatus = 'suggested';
      boundaryLabel = '售后建议';
    } else if (
      settings.orderQueryEnabled &&
      context.orderId &&
      this.isAiServiceOrderQueryMessage(latestCustomerMessage.content)
    ) {
      const reply = await this.buildAiServiceOrderReply(context.orderId);
      if (reply) {
        replyType = 'ai';
        scene = 'order_query';
        status = 'pending';
        content = reply.content;
        relatedTemplateId = reply.templateId;
        conversationStatus = 'open';
        aiStatus = 'auto_replied';
        boundaryLabel = '订单状态答复';
      }
    } else {
      const knowledge = settings.faqEnabled
        ? await this.findAiServiceKnowledgeMatch(latestCustomerMessage.content)
        : null;
      if (knowledge) {
        replyType = 'ai';
        scene = 'faq';
        status = 'pending';
        content = knowledge.answerText;
        relatedKnowledgeId = knowledge.id;
        conversationStatus = 'open';
        aiStatus = 'auto_replied';
        boundaryLabel = `FAQ / ${knowledge.title}`;
      } else {
        replyType = 'suggestion';
        scene = 'fallback';
        status = 'suggested';
        content = '当前问题不在自动答复范围内，建议转人工处理并补充到知识库。';
        conversationStatus = 'pending_manual';
        aiStatus = 'suggested';
        boundaryLabel = '兜底转人工';
      }
    }

    const client = await this.pool.connect();
    let transactionOpen = false;
    try {
      await client.query('BEGIN');
      transactionOpen = true;

      const messageTime = await this.appendAiServiceMessage(client, {
        conversationId,
        senderType: replyType,
        senderName:
          replyType === 'ai' ? 'AI 客服' : replyType === 'suggestion' ? 'AI 建议' : '系统提示',
        scene,
        content,
        status,
        relatedKnowledgeId,
        relatedTemplateId,
        operatorUserId: operator.id,
        createdAt: now,
      });
      await this.updateAiServiceConversationState(client, conversationId, {
        conversationStatus,
        aiStatus,
        latestUserIntent: latestCustomerMessage.content,
        boundaryLabel,
        unreadCount: 0,
        updatedAt: messageTime,
      });
      await this.insertWorkspaceLog(
        client,
        featureKey,
        replyType === 'ai' ? 'ai_reply' : replyType === 'suggestion' ? 'ai_suggestion' : 'ai_blocked',
        `${context.sessionNo} 已生成${replyType === 'ai' ? '回复' : replyType === 'suggestion' ? '建议' : '人工提示'}`,
        `${operator.displayName} 触发了会话 ${context.sessionNo} 的 ${scene} 处理。`,
        now,
      );
      await this.touchWorkspace(client, featureKey, now);

      await client.query('COMMIT');
      transactionOpen = false;
      return {
        reused: false,
        replyType,
        conversationStatus,
        aiStatus,
        content,
      };
    } catch (error) {
      if (transactionOpen) {
        await client.query('ROLLBACK');
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async updateAiServiceConversationTakeover(
    featureKey: string,
    conversationId: number,
    action: 'takeover' | 'release',
    note: string,
    operator: { id: number; displayName: string },
  ): Promise<AiServiceTakeoverUpdate> {
    if (featureKey !== 'ai-service') {
      return null;
    }

    const context = await this.getAiServiceConversationContext(conversationId);
    if (!context) {
      return null;
    }

    const client = await this.pool.connect();
    let transactionOpen = false;
    try {
      await client.query('BEGIN');
      transactionOpen = true;

      const now = format(new Date(), 'yyyy-MM-dd HH:mm:ss');
      const content =
        action === 'takeover'
          ? `${operator.displayName} 已接管当前会话，后续由人工继续处理。`
          : `${operator.displayName} 已释放人工接管，会话回到 AI 待处理队列。`;

      await this.appendAiServiceMessage(client, {
        conversationId,
        senderType: 'system',
        senderName: '系统提示',
        scene: action === 'takeover' ? 'manual_takeover' : 'manual_release',
        content,
        status: 'logged',
        operatorUserId: operator.id,
        createdAt: now,
      });
      await this.appendAiServiceTakeoverRecord(client, {
        conversationId,
        actionType: action,
        operatorUserId: operator.id,
        operatorName: operator.displayName,
        note: note || content,
        createdAt: now,
      });
      await this.updateAiServiceConversationState(client, conversationId, {
        conversationStatus: action === 'takeover' ? 'manual_active' : 'open',
        aiStatus: action === 'takeover' ? 'manual_only' : 'ready',
        assignedUserId: action === 'takeover' ? operator.id : null,
        boundaryLabel: action === 'takeover' ? '人工接管' : '恢复 AI 待处理',
        unreadCount: 0,
        updatedAt: now,
      });
      await this.insertWorkspaceLog(
        client,
        featureKey,
        'takeover',
        `${context.sessionNo} ${action === 'takeover' ? '已转人工' : '已释放接管'}`,
        `${operator.displayName}${action === 'takeover' ? '接管' : '释放'}了会话 ${context.sessionNo}。`,
        now,
      );
      await this.touchWorkspace(client, featureKey, now);

      await client.query('COMMIT');
      transactionOpen = false;
      return {
        conversationStatus: action === 'takeover' ? 'manual_active' : 'open',
        aiStatus: action === 'takeover' ? 'manual_only' : 'ready',
      };
    } catch (error) {
      if (transactionOpen) {
        await client.query('ROLLBACK');
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async sendAiServiceManualReply(
    featureKey: string,
    conversationId: number,
    content: string,
    closeConversation: boolean,
    operator: { id: number; displayName: string },
  ): Promise<AiServiceManualReply> {
    if (featureKey !== 'ai-service') {
      return null;
    }

    const context = await this.getAiServiceConversationContext(conversationId);
    if (!context) {
      return null;
    }

    const client = await this.pool.connect();
    let transactionOpen = false;
    try {
      await client.query('BEGIN');
      transactionOpen = true;

      const now = format(new Date(), 'yyyy-MM-dd HH:mm:ss');
      const nextStatus = closeConversation ? 'resolved' : 'manual_active';

      await this.appendAiServiceMessage(client, {
        conversationId,
        senderType: 'manual',
        senderName: operator.displayName,
        scene: 'manual_reply',
        content,
        status: 'sent',
        operatorUserId: operator.id,
        createdAt: now,
      });
      await this.appendAiServiceTakeoverRecord(client, {
        conversationId,
        actionType: 'correction',
        operatorUserId: operator.id,
        operatorName: operator.displayName,
        note: closeConversation ? '人工纠偏并关闭会话。' : '人工纠偏并继续跟进。',
        createdAt: now,
      });
      await this.updateAiServiceConversationState(client, conversationId, {
        conversationStatus: nextStatus,
        aiStatus: 'manual_only',
        assignedUserId: operator.id,
        boundaryLabel: closeConversation ? '人工已结单' : '人工纠偏',
        unreadCount: 0,
        updatedAt: now,
      });
      await this.insertWorkspaceLog(
        client,
        featureKey,
        'manual_reply',
        `${context.sessionNo} 已记录人工回复`,
        `${operator.displayName} 对会话 ${context.sessionNo} 执行了人工纠偏。`,
        now,
      );
      await this.touchWorkspace(client, featureKey, now);

      await client.query('COMMIT');
      transactionOpen = false;
      return {
        conversationStatus: nextStatus,
        aiStatus: 'manual_only',
      };
    } catch (error) {
      if (transactionOpen) {
        await client.query('ROLLBACK');
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async updateAiServiceLatestOutboundMessageStatus(
    featureKey: string,
    conversationId: number,
    senderType: 'ai' | 'manual',
    status: string,
  ) {
    if (featureKey !== 'ai-service') {
      return;
    }

    await this.pool.query(
      `
        UPDATE ai_service_messages
        SET status = $1
        WHERE id = (
          SELECT id
          FROM ai_service_messages
          WHERE conversation_id = $2
            AND sender_type = $3
          ORDER BY id DESC
          LIMIT 1
        )
      `,
      [status, conversationId, senderType],
    );
  }

  async syncAiServiceConversationsFromXianyuIm(input: {
    featureKey: string;
    storeId: number;
    sessions: XianyuWebBargainSession[];
    operator: { id: number; displayName: string };
    syncSource?: 'manual' | 'auto';
  }): Promise<AiServiceSyncResult> {
    if (input.featureKey !== 'ai-service') {
      return null;
    }

    const storeResult = await this.pool.query(
      `
        SELECT
          ms.id,
          ms.shop_name AS "shopName",
          COALESCE(oa.owner_name, ms.nickname, ms.shop_name) AS "ownerName"
        FROM managed_stores ms
        LEFT JOIN store_owner_accounts oa ON oa.id = ms.owner_account_id
        WHERE ms.id = $1
        LIMIT 1
      `,
      [input.storeId],
    );
    const store = storeResult.rows[0] as
      | {
          id: number;
          shopName: string;
          ownerName: string;
        }
      | undefined;
    if (!store) {
      return null;
    }

    const settings = await this.getAiServiceSettingsRow();
    const sensitiveWords = this.parseAiServiceSensitiveWords(settings?.sensitiveWordsText ?? '');
    const now = format(new Date(), 'yyyy-MM-dd HH:mm:ss');
    const result = {
      storeId: Number(store.id),
      shopName: String(store.shopName ?? ''),
      fetchedSessionCount: input.sessions.length,
      candidateSessionCount: 0,
      syncedConversationCount: 0,
      skippedCount: 0,
      createdConversationCount: 0,
      updatedConversationCount: 0,
      createdMessageCount: 0,
      syncedAt: now,
    };

    const client = await this.pool.connect();
    let transactionOpen = false;
    try {
      await client.query('BEGIN');
      transactionOpen = true;

      await client.query(
        `
          INSERT INTO stores (id, name, manager)
          VALUES ($1, $2, $3)
          ON CONFLICT (id) DO UPDATE SET
            name = EXCLUDED.name,
            manager = EXCLUDED.manager
        `,
        [store.id, store.shopName, store.ownerName],
      );

      for (const remoteSession of input.sessions) {
        if (Number(remoteSession.sessionType ?? 0) !== 1) {
          continue;
        }

        const buyerMessages = remoteSession.messages.filter(
          (message) => message.senderRole === 'buyer' && String(message.text ?? '').trim(),
        );
        const latestCustomerMessage =
          buyerMessages.at(-1)?.text.trim() || String(remoteSession.summaryText ?? '').trim();
        if (!latestCustomerMessage) {
          result.skippedCount += 1;
          continue;
        }

        result.candidateSessionCount += 1;

        const externalCustomerId = String(remoteSession.buyerUserId ?? '').trim();
        if (!externalCustomerId) {
          result.skippedCount += 1;
          continue;
        }

        const normalizedItemId = String(remoteSession.itemId ?? '').trim();
        const productId =
          /^\d+$/.test(normalizedItemId) && Number(normalizedItemId) > 0
            ? Number(normalizedItemId)
            : null;
        const productResult =
          productId !== null
            ? await client.query(
                `
                  SELECT id, name
                  FROM products
                  WHERE id = $1
                    AND store_id = $2
                  LIMIT 1
                `,
                [productId, store.id],
              )
            : { rows: [] };
        const product = productResult.rows[0] as { id: number; name: string } | undefined;

        const customerRefResult = await client.query(
          `
            SELECT customer_id AS "customerId"
            FROM customer_external_refs
            WHERE provider = 'xianyu'
              AND external_customer_id = $1
            LIMIT 1
          `,
          [externalCustomerId],
        );
        let customerId =
          customerRefResult.rows[0] && Number(customerRefResult.rows[0].customerId) > 0
            ? Number(customerRefResult.rows[0].customerId)
            : null;
        const customerName =
          String(remoteSession.buyerName ?? '').trim() ||
          String(buyerMessages.at(-1)?.senderName ?? '').trim() ||
          externalCustomerId;
        if (!customerId) {
          const nextCustomerId = await this.nextTableId(client, 'customers');
          await client.query(
            `
              INSERT INTO customers (id, name, province, registered_at)
              VALUES ($1, $2, $3, $4)
            `,
            [nextCustomerId, customerName, 'Unknown', remoteSession.summaryTimestamp || now],
          );
          customerId = nextCustomerId;
        } else {
          await client.query(
            `
              UPDATE customers
              SET name = $1, province = $2
              WHERE id = $3
            `,
            [customerName, 'Unknown', customerId],
          );
        }
        await client.query(
          `
            INSERT INTO customer_external_refs (provider, external_customer_id, customer_id, created_at)
            VALUES ('xianyu', $1, $2, $3)
            ON CONFLICT (provider, external_customer_id) DO UPDATE SET
              customer_id = EXCLUDED.customer_id
          `,
          [externalCustomerId, customerId, now],
        );

        const orderResult =
          customerId !== null
            ? await client.query(
                product?.id
                  ? `
                      SELECT id, order_no AS "orderNo"
                      FROM orders
                      WHERE store_id = $1
                        AND customer_id = $2
                        AND product_id = $3
                      ORDER BY paid_at DESC, id DESC
                      LIMIT 1
                    `
                  : `
                      SELECT id, order_no AS "orderNo"
                      FROM orders
                      WHERE store_id = $1
                        AND customer_id = $2
                      ORDER BY paid_at DESC, id DESC
                      LIMIT 1
                    `,
                product?.id ? [store.id, customerId, product.id] : [store.id, customerId],
              )
            : { rows: [] };
        const order = orderResult.rows[0] as { id: number; orderNo: string } | undefined;

        const shouldLinkAfterSale = this.isAiServiceAfterSaleMessage(latestCustomerMessage);
        const afterSaleResult =
          shouldLinkAfterSale && order?.id
            ? await client.query(
                `
                  SELECT id, case_no AS "caseNo"
                  FROM after_sale_cases
                  WHERE order_id = $1
                  ORDER BY created_at DESC, id DESC
                  LIMIT 1
                `,
                [order.id],
              )
            : { rows: [] };
        const afterSaleCase = afterSaleResult.rows[0] as { id: number; caseNo: string } | undefined;

        const riskLevel = this.isAiServiceHighRiskMessage(latestCustomerMessage, sensitiveWords)
          ? 'high'
          : shouldLinkAfterSale
            ? 'medium'
            : 'low';
        const conversationStatus = riskLevel === 'high' ? 'pending_manual' : 'open';
        const aiStatus = riskLevel === 'high' ? 'manual_only' : 'ready';
        const priority =
          riskLevel === 'high' || afterSaleCase
            ? 'high'
            : Number(remoteSession.unreadCount ?? 0) > 0
              ? 'medium'
              : 'low';
        const topic = this.buildAiServiceRealTopic({
          latestCustomerText: latestCustomerMessage,
          productName: product?.name ?? null,
          caseNo: afterSaleCase?.caseNo ?? null,
        });
        const tags = [
          'real-im',
          this.isAiServiceOrderQueryMessage(latestCustomerMessage) ? 'order' : '',
          shouldLinkAfterSale ? 'after-sale' : '',
          riskLevel === 'high' ? 'high-risk' : '',
        ].filter(Boolean);
        const tagsText = tags.join(',');
        const boundaryLabel =
          riskLevel === 'high'
            ? 'high-risk-manual'
            : shouldLinkAfterSale
              ? 'after-sale-suggestion'
              : this.isAiServiceOrderQueryMessage(latestCustomerMessage)
                ? 'order-status-reply'
                : 'real-session-sync';
        const sessionNo = `XYIM-AICS-${store.id}-${String(remoteSession.sessionId).trim()}`;
        const lastMessageAt = buyerMessages.at(-1)?.sentAt || remoteSession.summaryTimestamp || now;
        const itemMainPic = String(remoteSession.itemMainPic ?? '').trim() || null;

        const existingConversationResult = await client.query(
          `
            SELECT
              id,
              conversation_status AS "conversationStatus",
              ai_status AS "aiStatus",
              risk_level AS "riskLevel",
              last_message_at AS "lastMessageAt"
            FROM ai_service_conversations
            WHERE session_no = $1
            LIMIT 1
          `,
          [sessionNo],
        );
        const existingConversation = existingConversationResult.rows[0] as
          | {
              id: number;
              conversationStatus: string;
              aiStatus: string;
              riskLevel: string;
              lastMessageAt: string;
            }
          | undefined;

        let conversationId: number;
        if (!existingConversation) {
          const nextConversationId = await this.nextTableId(client, 'ai_service_conversations');
          await client.query(
            `
              INSERT INTO ai_service_conversations (
                id,
                session_no,
                channel,
                source,
                customer_id,
                customer_name,
                store_id,
                order_id,
                case_id,
                topic,
                latest_user_intent,
                item_main_pic,
                conversation_status,
                ai_status,
                risk_level,
                priority,
                unread_count,
                assigned_user_id,
                boundary_label,
                tags_text,
                last_message_at,
                created_at,
                updated_at
              ) VALUES (
                $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, NULL, $18, $19, $20, $21, $22
              )
            `,
            [
              nextConversationId,
              sessionNo,
              'Xianyu IM',
              'real_session_sync',
              customerId,
              customerName,
              store.id,
              order?.id ?? null,
              afterSaleCase?.id ?? null,
              topic,
              latestCustomerMessage,
              itemMainPic,
              conversationStatus,
              aiStatus,
              riskLevel,
              priority,
              Number(remoteSession.unreadCount ?? 0),
              boundaryLabel,
              tagsText,
              lastMessageAt,
              buyerMessages[0]?.sentAt ?? lastMessageAt,
              lastMessageAt,
            ],
          );
          conversationId = nextConversationId;
          result.createdConversationCount += 1;
        } else {
          conversationId = Number(existingConversation.id);
          const shouldReopen =
            String(existingConversation.conversationStatus) === 'resolved' &&
            String(existingConversation.lastMessageAt ?? '') < String(lastMessageAt);
          await client.query(
            `
              UPDATE ai_service_conversations
              SET
                customer_id = $1,
                customer_name = $2,
                store_id = $3,
                order_id = COALESCE($4, order_id),
                case_id = COALESCE($5, case_id),
                topic = $6,
                latest_user_intent = $7,
                item_main_pic = COALESCE($8, item_main_pic),
                conversation_status = $9,
                ai_status = $10,
                risk_level = $11,
                priority = $12,
                unread_count = $13,
                boundary_label = $14,
                tags_text = $15,
                last_message_at = CASE
                  WHEN last_message_at >= $16 THEN last_message_at
                  ELSE $16
                END,
                updated_at = $17
              WHERE id = $18
            `,
            [
              customerId,
              customerName,
              store.id,
              order?.id ?? null,
              afterSaleCase?.id ?? null,
              topic,
              latestCustomerMessage,
              itemMainPic,
              shouldReopen
                ? conversationStatus
                : String(existingConversation.conversationStatus) === 'manual_active'
                  ? 'manual_active'
                  : conversationStatus,
              shouldReopen
                ? aiStatus
                : String(existingConversation.conversationStatus) === 'manual_active'
                  ? 'manual_only'
                  : aiStatus,
              String(existingConversation.riskLevel) === 'high' || riskLevel === 'high'
                ? 'high'
                : riskLevel,
              priority,
              Number(remoteSession.unreadCount ?? 0),
              boundaryLabel,
              tagsText,
              lastMessageAt,
              now,
              conversationId,
            ],
          );
          result.updatedConversationCount += 1;
        }

        const remoteMessageList =
          remoteSession.messages.length > 0
            ? [...remoteSession.messages].sort(
                (left, right) =>
                  String(left.sentAt).localeCompare(String(right.sentAt)) ||
                  Number(left.version ?? 0) - Number(right.version ?? 0) ||
                  String(left.messageId).localeCompare(String(right.messageId)),
              )
            : [
                {
                  messageId: `${String(remoteSession.sessionId)}:summary`,
                  sessionId: remoteSession.sessionId,
                  sessionType: remoteSession.sessionType,
                  senderRole: 'buyer' as const,
                  senderUserId: remoteSession.buyerUserId,
                  senderName: remoteSession.buyerName ?? customerName,
                  text: latestCustomerMessage,
                  sentAt: lastMessageAt,
                  version: remoteSession.summaryVersion,
                  rawContentType: 101,
                },
              ];

        for (const message of remoteMessageList) {
          const normalizedContent = String(message.text ?? '').trim();
          if (!normalizedContent) {
            continue;
          }

          const senderType =
            message.senderRole === 'buyer'
              ? 'customer'
              : message.senderRole === 'seller'
                ? 'seller'
                : 'system';
          const senderName =
            String(message.senderName ?? '').trim() ||
            (senderType === 'customer'
              ? customerName
              : senderType === 'seller'
                ? String(remoteSession.sellerName ?? '').trim() || store.shopName
                : 'system');
          const scene =
            senderType === 'system'
              ? 'system_sync'
              : this.isAiServiceAfterSaleMessage(normalizedContent)
                ? 'after_sale'
                : this.isAiServiceOrderQueryMessage(normalizedContent)
                  ? 'order_query'
                  : senderType === 'seller'
                    ? 'manual_reply'
                    : 'faq';
          const status =
            senderType === 'customer'
              ? 'received'
              : senderType === 'seller'
                ? 'sent'
                : 'logged';

          const existingByExternalResult = message.messageId
            ? await client.query(
                `
                  SELECT id
                  FROM ai_service_messages
                  WHERE conversation_id = $1
                    AND external_message_id = $2
                  LIMIT 1
                `,
                [conversationId, message.messageId],
              )
            : { rows: [] };
          if (existingByExternalResult.rows[0]) {
            continue;
          }

          const existingMessageResult = await client.query(
            `
              SELECT id
              FROM ai_service_messages
              WHERE conversation_id = $1
                AND sender_type = $2
                AND content = $3
                AND created_at = $4
              LIMIT 1
            `,
            [conversationId, senderType, normalizedContent, message.sentAt],
          );
          if (existingMessageResult.rows[0]) {
            continue;
          }

          await this.appendAiServiceMessage(client, {
            conversationId,
            externalMessageId: message.messageId,
            senderType,
            senderName,
            senderUserId: message.senderUserId,
            scene,
            content: normalizedContent,
            status,
            createdAt: message.sentAt,
          });
          result.createdMessageCount += 1;
        }

        result.syncedConversationCount += 1;
      }

      const hasChanges =
        result.createdConversationCount > 0 ||
        result.updatedConversationCount > 0 ||
        result.createdMessageCount > 0;
      if (input.syncSource === 'auto') {
        if (hasChanges) {
          await this.insertWorkspaceLog(
            client,
            input.featureKey,
            'real_session_auto_sync',
            `${store.shopName} AI service sessions synced`,
            `Auto sync captured ${result.syncedConversationCount} sessions and ${result.createdMessageCount} new messages.`,
            now,
          );
          await this.touchWorkspace(client, input.featureKey, now);
        }
      } else {
        await this.insertWorkspaceLog(
          client,
          input.featureKey,
          'real_session_sync',
          `${store.shopName} AI service real sessions synced`,
          `${input.operator.displayName} synced ${result.syncedConversationCount} real sessions.`,
          now,
        );
        await this.touchWorkspace(client, input.featureKey, now);
      }

      await client.query('COMMIT');
      transactionOpen = false;
      return result;
    } catch (error) {
      if (transactionOpen) {
        await client.query('ROLLBACK');
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async syncAiBargainSessionsFromXianyuIm(input: {
    featureKey: string;
    storeId: number;
    sessions: XianyuWebBargainSession[];
    operator: { id: number; displayName: string };
  }): Promise<AiBargainSyncResult> {
    if (input.featureKey !== 'ai-bargain') {
      return null;
    }

    const storeResult = await this.pool.query(
      `
        SELECT
          ms.id,
          ms.shop_name AS "shopName",
          COALESCE(oa.owner_name, ms.nickname, ms.shop_name) AS "ownerName"
        FROM managed_stores ms
        LEFT JOIN store_owner_accounts oa ON oa.id = ms.owner_account_id
        WHERE ms.id = $1
        LIMIT 1
      `,
      [input.storeId],
    );
    const store = storeResult.rows[0] as
      | {
          id: number;
          shopName: string;
          ownerName: string;
        }
      | undefined;
    if (!store) {
      return null;
    }

    const now = format(new Date(), 'yyyy-MM-dd HH:mm:ss');
    const result = {
      storeId: Number(store.id),
      shopName: String(store.shopName ?? ''),
      fetchedSessionCount: input.sessions.length,
      candidateSessionCount: 0,
      syncedSessionCount: 0,
      skippedCount: 0,
      createdSessionCount: 0,
      updatedSessionCount: 0,
      createdLogCount: 0,
      createdStrategyCount: 0,
      autoEvaluatedCount: 0,
      syncedAt: now,
    };

    const client = await this.pool.connect();
    let transactionOpen = false;
    try {
      await client.query('BEGIN');
      transactionOpen = true;

      await client.query(
        `
          INSERT INTO stores (id, name, manager)
          VALUES ($1, $2, $3)
          ON CONFLICT (id) DO UPDATE SET
            name = EXCLUDED.name,
            manager = EXCLUDED.manager
        `,
        [store.id, store.shopName, store.ownerName],
      );

      for (const remoteSession of input.sessions) {
        const buyerMessages = remoteSession.messages.filter(
          (message) =>
            message.senderRole === 'buyer' &&
            this.isAiBargainIntentText(String(message.text ?? '')),
        );
        const isCandidate =
          buyerMessages.length > 0 ||
          (remoteSession.messages.length === 0 &&
            this.isAiBargainIntentText(String(remoteSession.summaryText ?? '')));
        if (!isCandidate) {
          continue;
        }
        result.candidateSessionCount += 1;

        const normalizedItemId = String(remoteSession.itemId ?? '').trim();
        if (!/^\d+$/.test(normalizedItemId)) {
          result.skippedCount += 1;
          continue;
        }

        const productId = Number(normalizedItemId);
        if (!Number.isSafeInteger(productId) || productId <= 0) {
          result.skippedCount += 1;
          continue;
        }

        const productResult = await client.query(
          `
            SELECT
              id,
              name,
              price,
              category,
              stock
            FROM products
            WHERE id = $1
              AND store_id = $2
            LIMIT 1
          `,
          [productId, store.id],
        );
        const product = productResult.rows[0] as
          | {
              id: number;
              name: string;
              price: number;
              category: string;
              stock: number;
            }
          | undefined;
        if (!product) {
          result.skippedCount += 1;
          continue;
        }

        let strategyResult = await client.query(
          `
            SELECT
              id,
              strategy_name AS "strategyName",
              listed_price AS "listedPrice",
              min_price AS "minPrice",
              target_price AS "targetPrice",
              step_price AS "stepPrice",
              max_rounds AS "maxRounds",
              enabled,
              risk_tags_text AS "riskTagsText"
            FROM ai_bargain_strategies
            WHERE product_id = $1
              AND store_id = $2
            ORDER BY enabled DESC, id ASC
            LIMIT 1
          `,
          [productId, store.id],
        );
        let strategy = strategyResult.rows[0] as
          | {
              id: number;
              strategyName: string;
              listedPrice: number;
              minPrice: number;
              targetPrice: number;
              stepPrice: number;
              maxRounds: number;
              enabled: number;
              riskTagsText: string;
            }
          | undefined;
        if (!strategy) {
          const listedPrice = Number(Number(product.price ?? 0).toFixed(2));
          const minPrice = Number((listedPrice * 0.9).toFixed(2));
          const targetPrice = Number(
            Math.max(minPrice, listedPrice - Math.max(1, listedPrice * 0.05)).toFixed(2),
          );
          const stepPrice = Number(Math.max(1, listedPrice * 0.02).toFixed(2));
          const strategyId = await this.nextTableId(client, 'ai_bargain_strategies');
          await client.query(
            `
              INSERT INTO ai_bargain_strategies (
                id,
                product_id,
                store_id,
                strategy_name,
                product_name_snapshot,
                listed_price,
                min_price,
                target_price,
                step_price,
                max_rounds,
                enabled,
                risk_tags_text,
                updated_at
              ) VALUES (
                $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 1, $11, $12
              )
            `,
            [
              strategyId,
              productId,
              store.id,
              `${product.name}标准策略`,
              product.name,
              listedPrice,
              minPrice,
              targetPrice,
              stepPrice,
              3,
              '真实IM,自动议价',
              now,
            ],
          );
          result.createdStrategyCount += 1;
          strategyResult = await client.query(
            `
              SELECT
                id,
                strategy_name AS "strategyName",
                listed_price AS "listedPrice",
                min_price AS "minPrice",
                target_price AS "targetPrice",
                step_price AS "stepPrice",
                max_rounds AS "maxRounds",
                enabled,
                risk_tags_text AS "riskTagsText"
              FROM ai_bargain_strategies
              WHERE id = $1
              LIMIT 1
            `,
            [strategyId],
          );
          strategy = strategyResult.rows[0] as typeof strategy;
        }
        if (!strategy) {
          result.skippedCount += 1;
          continue;
        }

        const customerName = String(remoteSession.buyerName ?? '').trim() || '闲鱼买家';
        const externalCustomerId =
          String(remoteSession.buyerUserId ?? '').trim() ||
          `im-session:${store.id}:${String(remoteSession.sessionId ?? '')}`;
        const customerRefResult = await client.query(
          `
            SELECT customer_id AS "customerId"
            FROM customer_external_refs
            WHERE provider = 'xianyu'
              AND external_customer_id = $1
            LIMIT 1
          `,
          [externalCustomerId],
        );
        let customerId =
          customerRefResult.rows[0] && Number(customerRefResult.rows[0].customerId) > 0
            ? Number(customerRefResult.rows[0].customerId)
            : null;
        if (!customerId) {
          const nextCustomerId = await this.nextTableId(client, 'customers');
          await client.query(
            `
              INSERT INTO customers (id, name, province, registered_at)
              VALUES ($1, $2, $3, $4)
            `,
            [nextCustomerId, customerName, 'Unknown', remoteSession.summaryTimestamp || now],
          );
          customerId = nextCustomerId;
        } else {
          await client.query(
            `
              UPDATE customers
              SET name = $1, province = $2
              WHERE id = $3
            `,
            [customerName, 'Unknown', customerId],
          );
        }
        await client.query(
          `
            INSERT INTO customer_external_refs (provider, external_customer_id, customer_id, created_at)
            VALUES ('xianyu', $1, $2, $3)
            ON CONFLICT (provider, external_customer_id) DO UPDATE SET
              customer_id = EXCLUDED.customer_id
          `,
          [externalCustomerId, customerId, now],
        );

        const riskProfile = await this.getAiBargainCustomerRisk(client, customerId);
        const blacklistHit = await this.findAiBargainBlacklistHit(client, customerId, customerName);
        const riskLevel = blacklistHit ? 'high' : riskProfile.level;
        const riskReason = blacklistHit
          ? `命中黑名单：${blacklistHit.reason}`
          : riskProfile.reason;

        const linkedOrderResult = await client.query(
          `
            SELECT
              id,
              order_no AS "orderNo"
            FROM orders
            WHERE store_id = $1
              AND product_id = $2
              AND customer_id = $3
            ORDER BY paid_at DESC, id DESC
            LIMIT 1
          `,
          [store.id, productId, customerId],
        );
        const linkedOrder = linkedOrderResult.rows[0] as { id: number; orderNo: string } | undefined;

        const sessionNo = `XYIM-${store.id}-${String(remoteSession.sessionId ?? '').trim()}`;
        const existingSessionResult = await client.query(
          `
            SELECT
              id,
              session_status AS "sessionStatus",
              ai_status AS "aiStatus",
              last_message_at AS "lastMessageAt",
              risk_reason AS "riskReason",
              latest_buyer_offer AS "latestBuyerOffer"
            FROM ai_bargain_sessions
            WHERE session_no = $1
            LIMIT 1
          `,
          [sessionNo],
        );
        const existingSession = existingSessionResult.rows[0] as
          | {
              id: number;
              sessionStatus: string;
              aiStatus: string;
              lastMessageAt: string;
              riskReason: string;
              latestBuyerOffer: number | null;
            }
          | undefined;
        const sortedMessages = [...remoteSession.messages].sort(
          (left, right) =>
            String(left.sentAt ?? '').localeCompare(String(right.sentAt ?? '')) ||
            String(left.messageId ?? '').localeCompare(String(right.messageId ?? '')),
        );
        const latestBuyerOffer = [...sortedMessages]
          .reverse()
          .reduce<number | null>((foundOffer, message) => {
            if (foundOffer !== null || message.senderRole !== 'buyer') {
              return foundOffer;
            }
            return this.extractAiBargainOfferPrice(String(message.text ?? ''));
          }, null);
        const firstMessageAt = sortedMessages[0]?.sentAt || remoteSession.summaryTimestamp || now;
        const lastMessageAt =
          sortedMessages[sortedMessages.length - 1]?.sentAt || remoteSession.summaryTimestamp || now;
        const tagsText = Array.from(
          new Set(
            [String(strategy.riskTagsText ?? ''), 'real-im']
              .join(',')
              .split(/[,，]/)
              .map((tag) => tag.trim())
              .filter(Boolean),
          ),
        ).join(',');

        let sessionId = existingSession?.id ?? null;
        if (!sessionId) {
          sessionId = await this.nextTableId(client, 'ai_bargain_sessions');
          await client.query(
            `
              INSERT INTO ai_bargain_sessions (
                id,
                session_no,
                channel,
                topic,
                customer_id,
                customer_name,
                store_id,
                product_id,
                order_id,
                strategy_id,
                product_name_snapshot,
                listed_price,
                min_price,
                target_price,
                latest_buyer_offer,
                latest_counter_price,
                current_round,
                max_rounds,
                session_status,
                ai_status,
                risk_level,
                risk_reason,
                assigned_user_id,
                boundary_label,
                tags_text,
                last_message_at,
                created_at,
                updated_at
              ) VALUES (
                $1, $2, 'Xianyu IM', $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, NULL, 0, $15, 'open', 'ready', $16, $17, NULL, 'real-session-sync', $18, $19, $20, $21
              )
            `,
            [
              sessionId,
              sessionNo,
              '真实买家议价',
              customerId,
              customerName,
              store.id,
              productId,
              linkedOrder?.id ?? null,
              strategy.id,
              product.name,
              toNumber(strategy.listedPrice, 2),
              toNumber(strategy.minPrice, 2),
              toNumber(strategy.targetPrice, 2),
              latestBuyerOffer,
              Number(strategy.maxRounds ?? 3),
              riskLevel,
              riskReason,
              tagsText,
              lastMessageAt,
              firstMessageAt,
              lastMessageAt,
            ],
          );
          result.createdSessionCount += 1;
        } else {
          await client.query(
            `
              UPDATE ai_bargain_sessions
              SET
                customer_id = $1,
                customer_name = $2,
                store_id = $3,
                product_id = $4,
                order_id = COALESCE($5, order_id),
                strategy_id = $6,
                product_name_snapshot = $7,
                listed_price = $8,
                min_price = $9,
                target_price = $10,
                latest_buyer_offer = COALESCE($11, latest_buyer_offer),
                max_rounds = $12,
                tags_text = $13,
                last_message_at = CASE
                  WHEN last_message_at >= $14 THEN last_message_at
                  ELSE $14
                END,
                updated_at = $15
              WHERE id = $16
            `,
            [
              customerId,
              customerName,
              store.id,
              productId,
              linkedOrder?.id ?? null,
              strategy.id,
              product.name,
              toNumber(strategy.listedPrice, 2),
              toNumber(strategy.minPrice, 2),
              toNumber(strategy.targetPrice, 2),
              latestBuyerOffer,
              Number(strategy.maxRounds ?? 3),
              tagsText,
              lastMessageAt,
              now,
              sessionId,
            ],
          );
          result.updatedSessionCount += 1;
        }
        result.syncedSessionCount += 1;

        for (const message of sortedMessages) {
          const normalizedText = this.normalizeAiBargainMessageText(String(message.text ?? ''));
          if (!normalizedText) {
            continue;
          }

          let actorType: 'customer' | 'manual' | null = null;
          if (message.senderRole === 'buyer') {
            actorType = 'customer';
          } else if (message.senderRole === 'seller') {
            actorType = 'manual';
          }
          if (!actorType) {
            continue;
          }

          const offerPrice = this.extractAiBargainOfferPrice(normalizedText);
          const actionType =
            actorType === 'customer'
              ? offerPrice !== null
                ? 'buyer_offer'
                : 'buyer_message'
              : offerPrice !== null
                ? 'manual_offer'
                : 'manual_message';
          const createdAt = message.sentAt || lastMessageAt;
          const existingLogResult = await client.query(
            `
              SELECT id
              FROM ai_bargain_logs
              WHERE session_id = $1
                AND actor_type = $2
                AND action_type = $3
                AND message_text = $4
                AND created_at = $5
                AND (
                  (offer_price IS NULL AND $6 IS NULL)
                  OR offer_price = $6
                )
              LIMIT 1
            `,
            [sessionId, actorType, actionType, normalizedText, createdAt, offerPrice],
          );
          if (existingLogResult.rows[0]) {
            continue;
          }

          const logId = await this.nextTableId(client, 'ai_bargain_logs');
          await client.query(
            `
              INSERT INTO ai_bargain_logs (
                id,
                session_id,
                actor_type,
                action_type,
                offer_price,
                message_text,
                related_template_id,
                operator_user_id,
                created_at
              ) VALUES (
                $1, $2, $3, $4, $5, $6, NULL, NULL, $7
              )
            `,
            [logId, sessionId, actorType, actionType, offerPrice, normalizedText, createdAt],
          );
          result.createdLogCount += 1;
        }
      }

      await this.insertWorkspaceLog(
        client,
        input.featureKey,
        'sync',
        `${store.shopName} AI bargain real sessions synced`,
        `${input.operator.displayName} synced ${result.syncedSessionCount} real bargain sessions.`,
        now,
      );
      await this.touchWorkspace(client, input.featureKey, now);

      await client.query('COMMIT');
      transactionOpen = false;
      return result;
    } catch (error) {
      if (transactionOpen) {
        await client.query('ROLLBACK');
      }
      throw error;
    } finally {
      client.release();
    }
  }

  private normalizeAiBargainMessageText(text: string) {
    return text.replace(/\s+/g, ' ').trim();
  }

  private isAiBargainIntentText(text: string) {
    const normalized = this.normalizeAiBargainMessageText(text);
    if (!normalized) {
      return false;
    }

    if (/(最低|便宜|优惠|砍价|议价|还价|少点|再少|实价|什么价|多少|价格|报价|包邮|一口价)/.test(normalized)) {
      return true;
    }

    if (!/(?:¥|￥|\d)/.test(normalized)) {
      return false;
    }

    return /(到手|价格|报价|行不行|可不可以|包邮|刀|少)/.test(normalized);
  }

  private extractAiBargainOfferPrice(text: string) {
    const normalized = this.normalizeAiBargainMessageText(text);
    if (!normalized) {
      return null;
    }

    const candidates: number[] = [];
    const pricePattern = /(?:¥|￥)?\s*(\d+(?:\.\d{1,2})?)\s*(元|块|w|W|万)?/g;
    let match: RegExpExecArray | null = null;
    while ((match = pricePattern.exec(normalized)) !== null) {
      const rawValue = Number(match[1]);
      if (!Number.isFinite(rawValue) || rawValue <= 0) {
        continue;
      }

      const unit = match[2] ?? '';
      const context = normalized.slice(
        Math.max(0, match.index - 6),
        Math.min(normalized.length, match.index + match[0].length + 6),
      );
      const hasPriceCue =
        Boolean(unit) ||
        /(最低|便宜|优惠|砍价|议价|还价|少点|多少|价格|报价|包邮|刀|到手)/.test(context);
      if (!hasPriceCue) {
        continue;
      }

      const normalizedValue = /^(w|W|万)$/.test(unit) ? rawValue * 10000 : rawValue;
      if (!Number.isFinite(normalizedValue) || normalizedValue <= 0 || normalizedValue > 999999) {
        continue;
      }

      candidates.push(Number(normalizedValue.toFixed(2)));
    }

    if (candidates.length === 0) {
      return null;
    }

    return Math.max(...candidates);
  }

  private async getAiBargainCustomerRisk(client: pg.PoolClient, customerId: number | null) {
    if (!customerId) {
      return {
        level: 'medium' as const,
        reason: 'Buyer profile is incomplete, keep the bargain session conservative.',
      };
    }

    const [orderSummaryResult, caseSummaryResult] = await Promise.all([
      client.query(
        `
          SELECT
            COUNT(*) AS "orderCount",
            SUM(CASE WHEN after_sale_status != 'none' THEN 1 ELSE 0 END) AS "afterSaleOrderCount",
            SUM(refund_amount) AS "refundAmount"
          FROM orders
          WHERE customer_id = $1
        `,
        [customerId],
      ),
      client.query(
        `
          SELECT
            COUNT(*) AS "caseCount",
            SUM(CASE WHEN case_type = 'dispute' THEN 1 ELSE 0 END) AS "disputeCount"
          FROM after_sale_cases ac
          INNER JOIN orders o ON o.id = ac.order_id
          WHERE o.customer_id = $1
        `,
        [customerId],
      ),
    ]);

    const orderSummary = orderSummaryResult.rows[0] ?? {};
    const caseSummary = caseSummaryResult.rows[0] ?? {};
    const orderCount = toNumber(orderSummary.orderCount);
    const afterSaleOrderCount = toNumber(orderSummary.afterSaleOrderCount);
    const refundAmount = toNumber(orderSummary.refundAmount, 2);
    const caseCount = toNumber(caseSummary.caseCount);
    const disputeCount = toNumber(caseSummary.disputeCount);

    if (disputeCount > 0 || caseCount >= 2 || refundAmount >= 50) {
      return {
        level: 'high' as const,
        reason: `Historical disputes=${disputeCount}, after-sales=${caseCount}, refunds=${refundAmount.toFixed(2)}.`,
      };
    }

    if (afterSaleOrderCount > 0 || refundAmount > 0 || orderCount <= 1) {
      return {
        level: 'medium' as const,
        reason:
          orderCount <= 1
            ? 'Buyer has very limited history, keep the bargain session conservative.'
            : `Buyer has after-sales history (${afterSaleOrderCount}) or refunds (${refundAmount.toFixed(2)}).`,
      };
    }

    return {
      level: 'low' as const,
      reason: 'Buyer history is stable enough for the standard bargain strategy.',
    };
  }

  private async findAiBargainBlacklistHit(
    client: pg.PoolClient,
    customerId: number | null,
    customerName: string,
  ) {
    const result = await client.query(
      `
        SELECT
          id,
          customer_id AS "customerId",
          customer_name AS "customerName",
          reason
        FROM ai_bargain_blacklist
        WHERE enabled = 1
          AND (
            (customer_id IS NOT NULL AND customer_id = $1)
            OR customer_name = $2
          )
        ORDER BY id ASC
        LIMIT 1
      `,
      [customerId, customerName],
    );
    return result.rows[0] as
      | {
          id: number;
          customerId: number | null;
          customerName: string;
          reason: string;
        }
      | undefined;
  }

  private parseXianyuWebSocketAuthCache(payloadText: string | null): XianyuWebSocketAuthCache | null {
    if (!payloadText?.trim()) {
      return null;
    }

    try {
      const parsed = JSON.parse(
        decryptSecret(payloadText, appConfig.secureConfigSecret),
      ) as Partial<XianyuWebSocketAuthCache>;
      if (
        !parsed ||
        typeof parsed !== 'object' ||
        typeof parsed.appKey !== 'string' ||
        typeof parsed.cacheHeader !== 'string' ||
        typeof parsed.token !== 'string' ||
        typeof parsed.ua !== 'string' ||
        typeof parsed.dt !== 'string' ||
        typeof parsed.wv !== 'string' ||
        typeof parsed.sync !== 'string' ||
        typeof parsed.did !== 'string' ||
        typeof parsed.capturedAt !== 'string' ||
        typeof parsed.expiresAt !== 'string'
      ) {
        return null;
      }

      return {
        appKey: parsed.appKey,
        cacheHeader: parsed.cacheHeader,
        token: parsed.token,
        ua: parsed.ua,
        dt: parsed.dt,
        wv: parsed.wv,
        sync: parsed.sync,
        did: parsed.did,
        capturedAt: parsed.capturedAt,
        expiresAt: parsed.expiresAt,
      };
    } catch {
      return null;
    }
  }

  private parseAiServiceRealSessionNo(sessionNo: string) {
    const match = sessionNo.match(/^XYIM-AICS-(\d+)-(.+)$/);
    if (!match) {
      return null;
    }

    const [, storeIdText, sessionId] = match;
    const storeId = Number(storeIdText);
    if (!Number.isSafeInteger(storeId) || storeId <= 0 || !sessionId.trim()) {
      return null;
    }

    return {
      storeId,
      sessionId: sessionId.trim(),
      conversationCid: `${sessionId.trim()}@goofish`,
    };
  }

  private parseAiServiceSensitiveWords(text: string) {
    return String(text ?? '')
      .split(/[,，\n]/)
      .map((item) => item.trim())
      .filter(Boolean);
  }

  private isAiServiceHighRiskMessage(message: string, sensitiveWords: string[]) {
    return (
      sensitiveWords.some((word) => word && message.includes(word)) ||
      ['投诉', '差评', '举报', '起诉', '骗子', '赔偿', '维权'].some((word) => message.includes(word))
    );
  }

  private isAiServiceAfterSaleMessage(message: string) {
    return /退款|售后|补发|争议|赔付|退货/.test(message);
  }

  private isAiServiceOrderQueryMessage(message: string) {
    return /订单|发货|物流|到账|什么时候|状态|查询|进度/.test(message);
  }

  private buildAiServiceRealTopic(input: {
    latestCustomerText: string;
    productName: string | null;
    caseNo: string | null;
  }) {
    if (input.caseNo || this.isAiServiceAfterSaleMessage(input.latestCustomerText)) {
      return 'After-sale inquiry';
    }
    if (this.isAiServiceOrderQueryMessage(input.latestCustomerText)) {
      return 'Order status inquiry';
    }
    if (input.productName?.trim()) {
      return `${input.productName.trim()} inquiry`;
    }

    const normalized = input.latestCustomerText.trim();
    return normalized ? normalized.slice(0, 20) : 'Buyer inquiry';
  }

  private async getAiServiceConversationContext(conversationId: number) {
    const result = await this.pool.query(
      `
        SELECT
          c.id,
          c.session_no AS "sessionNo",
          c.channel,
          c.source,
          c.customer_name AS "customerName",
          c.store_id AS "storeId",
          s.name AS "storeName",
          c.order_id AS "orderId",
          o.order_no AS "orderNo",
          c.case_id AS "caseId",
          ac.case_no AS "caseNo",
          c.topic,
          c.latest_user_intent AS "latestUserIntent",
          c.conversation_status AS "conversationStatus",
          c.ai_status AS "aiStatus",
          c.risk_level AS "riskLevel",
          c.priority,
          c.unread_count AS "unreadCount",
          c.assigned_user_id AS "assignedUserId",
          u.display_name AS "assignedUserName",
          c.boundary_label AS "boundaryLabel",
          c.tags_text AS "tagsText",
          c.last_message_at AS "lastMessageAt",
          c.created_at AS "createdAt",
          c.updated_at AS "updatedAt"
        FROM ai_service_conversations c
        LEFT JOIN stores s ON s.id = c.store_id
        LEFT JOIN orders o ON o.id = c.order_id
        LEFT JOIN after_sale_cases ac ON ac.id = c.case_id
        LEFT JOIN users u ON u.id = c.assigned_user_id
        WHERE c.id = $1
        LIMIT 1
      `,
      [conversationId],
    );

    return result.rows[0] as
      | {
          id: number;
          sessionNo: string;
          channel: string;
          source: string;
          customerName: string;
          storeId: number | null;
          storeName: string | null;
          orderId: number | null;
          orderNo: string | null;
          caseId: number | null;
          caseNo: string | null;
          topic: string;
          latestUserIntent: string;
          conversationStatus: string;
          aiStatus: string;
          riskLevel: string;
          priority: string;
          unreadCount: number;
          assignedUserId: number | null;
          assignedUserName: string | null;
          boundaryLabel: string;
          tagsText: string;
          lastMessageAt: string;
          createdAt: string;
          updatedAt: string;
        }
      | undefined;
  }

  private async getAiServiceLatestCustomerMessage(conversationId: number) {
    const result = await this.pool.query(
      `
        SELECT
          id,
          content,
          created_at AS "createdAt"
        FROM ai_service_messages
        WHERE conversation_id = $1
          AND sender_type = 'customer'
        ORDER BY id DESC
        LIMIT 1
      `,
      [conversationId],
    );

    return result.rows[0] as
      | {
          id: number;
          content: string;
          createdAt: string;
        }
      | undefined;
  }

  private async getAiServiceLatestOutboundMessage(conversationId: number) {
    const result = await this.pool.query(
      `
        SELECT
          id,
          sender_type AS "senderType",
          scene,
          content,
          status,
          created_at AS "createdAt"
        FROM ai_service_messages
        WHERE conversation_id = $1
          AND sender_type != 'customer'
        ORDER BY id DESC
        LIMIT 1
      `,
      [conversationId],
    );

    return result.rows[0] as
      | {
          id: number;
          senderType: string;
          scene: string;
          content: string;
          status: string;
          createdAt: string;
        }
      | undefined;
  }

  private async findAiServiceKnowledgeMatch(message: string) {
    const normalizedMessage = String(message ?? '').toLowerCase();
    const result = await this.pool.query(
      `
        SELECT
          id,
          category,
          title,
          keywords_text AS "keywordsText",
          answer_text AS "answerText"
        FROM ai_service_knowledge_items
        WHERE enabled = 1
        ORDER BY id ASC
      `,
    );

    return (
      (result.rows as Array<{
        id: number;
        category: string;
        title: string;
        keywordsText: string;
        answerText: string;
      }>).find((item) =>
        String(item.keywordsText ?? '')
          .split(/[,，]/)
          .map((entry) => entry.trim().toLowerCase())
          .filter(Boolean)
          .some((keyword) => normalizedMessage.includes(keyword)),
      ) ?? null
    );
  }

  private async findAiServiceTemplate(scene: string) {
    const result = await this.pool.query(
      `
        SELECT
          id,
          scene,
          title,
          trigger_text AS "triggerText",
          template_content AS "templateContent"
        FROM ai_service_reply_templates
        WHERE enabled = 1
          AND scene = $1
        ORDER BY id ASC
        LIMIT 1
      `,
      [scene],
    );

    return result.rows[0] as
      | {
          id: number;
          scene: string;
          title: string;
          triggerText: string;
          templateContent: string;
        }
      | undefined;
  }

  private applyAiServiceTemplate(template: string, replacements: Record<string, string | number | null>) {
    return Object.entries(replacements).reduce(
      (content, [key, value]) => content.replaceAll(`{${key}}`, value === null ? '-' : String(value)),
      template,
    );
  }

  private async buildAiServiceOrderReply(orderId: number) {
    const detail = await this.getOrderDetail(orderId);
    if (!detail) {
      return null;
    }

    const template = await this.findAiServiceTemplate('order_query');
    const content = template
      ? this.applyAiServiceTemplate(template.templateContent, {
          orderNo: detail.order.orderNo,
          productName: detail.order.productName,
          mainStatusText: detail.order.mainStatusText,
          deliveryStatusText: detail.order.deliveryStatusText,
          paidAt: detail.order.paidAt,
          latestEventAt: detail.order.updatedAt,
        })
      : `订单 ${detail.order.orderNo} 当前处于${detail.order.mainStatusText}，发货状态为${detail.order.deliveryStatusText}，最近更新于 ${detail.order.updatedAt}。`;

    return {
      content,
      templateId: template?.id ?? null,
    };
  }

  private async buildAiServiceAfterSaleSuggestion(caseId: number) {
    const detail = await this.getAfterSaleDetail(caseId);
    if (!detail) {
      return null;
    }

    const template = await this.findAiServiceTemplate('after_sale');
    const sceneLabel =
      detail.caseInfo.caseType === 'refund'
        ? `退款状态 ${detail.refund?.refundStatusText ?? '-'}`
        : detail.caseInfo.caseType === 'resend'
          ? `补发状态 ${detail.resend?.resendStatusText ?? '-'}`
          : `争议状态 ${detail.dispute?.disputeStatusText ?? '-'}`;
    const content = template
      ? this.applyAiServiceTemplate(template.templateContent, {
          caseNo: detail.caseInfo.caseNo,
          orderNo: detail.order.orderNo,
          caseTypeText: detail.caseInfo.caseTypeText,
          caseStatusText: detail.caseInfo.caseStatusText,
          sceneLabel,
          latestResult: detail.caseInfo.latestResult,
        })
      : `建议回复：当前售后单 ${detail.caseInfo.caseNo} 为${detail.caseInfo.caseTypeText}，主状态 ${detail.caseInfo.caseStatusText}，${sceneLabel}。建议客服先说明当前进度，再按售后规则给出下一步承诺。`;

    return {
      content,
      templateId: template?.id ?? null,
    };
  }

  private async appendAiServiceMessage(
    client: pg.PoolClient,
    input: {
      conversationId: number;
      externalMessageId?: string | null;
      senderType: string;
      senderName?: string | null;
      senderUserId?: string | null;
      scene: string;
      content: string;
      status: string;
      relatedKnowledgeId?: number | null;
      relatedTemplateId?: number | null;
      operatorUserId?: number | null;
      createdAt?: string;
    },
  ) {
    const createdAt = input.createdAt ?? format(new Date(), 'yyyy-MM-dd HH:mm:ss');
    const nextId = await this.nextTableId(client, 'ai_service_messages');
    await client.query(
      `
        INSERT INTO ai_service_messages (
          id,
          conversation_id,
          external_message_id,
          sender_type,
          sender_name,
          sender_user_id,
          scene,
          content,
          status,
          related_knowledge_id,
          related_template_id,
          operator_user_id,
          created_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13
        )
      `,
      [
        nextId,
        input.conversationId,
        input.externalMessageId ?? null,
        input.senderType,
        input.senderName?.trim() || '',
        input.senderUserId ?? null,
        input.scene,
        input.content,
        input.status,
        input.relatedKnowledgeId ?? null,
        input.relatedTemplateId ?? null,
        input.operatorUserId ?? null,
        createdAt,
      ],
    );
    return createdAt;
  }

  private async updateAiServiceConversationState(
    client: pg.PoolClient,
    conversationId: number,
    input: {
      conversationStatus: string;
      aiStatus: string;
      assignedUserId?: number | null;
      latestUserIntent?: string;
      boundaryLabel?: string;
      unreadCount?: number;
      updatedAt?: string;
    },
  ) {
    const updatedAt = input.updatedAt ?? format(new Date(), 'yyyy-MM-dd HH:mm:ss');
    await client.query(
      `
        UPDATE ai_service_conversations
        SET
          conversation_status = $1,
          ai_status = $2,
          assigned_user_id = $3,
          latest_user_intent = COALESCE($4, latest_user_intent),
          boundary_label = COALESCE($5, boundary_label),
          unread_count = COALESCE($6, unread_count),
          last_message_at = $7,
          updated_at = $8
        WHERE id = $9
      `,
      [
        input.conversationStatus,
        input.aiStatus,
        input.assignedUserId ?? null,
        input.latestUserIntent ?? null,
        input.boundaryLabel ?? null,
        input.unreadCount ?? null,
        updatedAt,
        updatedAt,
        conversationId,
      ],
    );
    return updatedAt;
  }

  private async appendAiServiceTakeoverRecord(
    client: pg.PoolClient,
    input: {
      conversationId: number;
      actionType: string;
      operatorUserId?: number | null;
      operatorName: string;
      note: string;
      createdAt?: string;
    },
  ) {
    const createdAt = input.createdAt ?? format(new Date(), 'yyyy-MM-dd HH:mm:ss');
    const nextId = await this.nextTableId(client, 'ai_service_takeovers');
    await client.query(
      `
        INSERT INTO ai_service_takeovers (
          id,
          conversation_id,
          action_type,
          operator_user_id,
          operator_name,
          note,
          created_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7)
      `,
      [
        nextId,
        input.conversationId,
        input.actionType,
        input.operatorUserId ?? null,
        input.operatorName,
        input.note,
        createdAt,
      ],
    );
  }

  async runSystemBackup(
    featureKey: string,
    triggeredByName?: string | null,
  ): Promise<SystemBackupRun | null> {
    if (featureKey !== 'system-monitoring') {
      return null;
    }

    const started = new Date();
    const startedAt = format(started, 'yyyy-MM-dd HH:mm:ss');
    const backupNo = `BK-${format(started, 'yyyyMMddHHmmss')}-${randomUUID().slice(0, 6)}`;

    try {
      const artifact = await this.createPostgresBackupArtifact({
        backupNo,
        startedAt,
        triggeredByName,
      });
      const finishedAt = format(new Date(), 'yyyy-MM-dd HH:mm:ss');
      const client = await this.pool.connect();
      let transactionOpen = false;
      try {
        await client.query('BEGIN');
        transactionOpen = true;

        const row = await this.recordSystemBackupRun(client, {
          backupNo,
          backupType: 'manual',
          runStatus: 'success',
          fileName: artifact.fileName,
          filePath: artifact.filePath,
          fileSize: artifact.fileSize,
          detail: artifact.detail,
          startedAt,
          finishedAt,
          triggeredByName,
        });

        await this.insertWorkspaceLog(
          client,
          featureKey,
          'backup',
          'PostgreSQL backup completed',
          `Backup ${row.backupNo} wrote ${row.fileName} (${row.fileSize} bytes).`,
          finishedAt,
        );
        await this.touchWorkspace(client, featureKey, finishedAt);

        await client.query('COMMIT');
        transactionOpen = false;
        return row;
      } catch (error) {
        if (transactionOpen) {
          await client.query('ROLLBACK');
        }
        throw error;
      } finally {
        client.release();
      }
    } catch (error) {
      fs.mkdirSync(this.getBackupRootDir(), { recursive: true });
      const finishedAt = format(new Date(), 'yyyy-MM-dd HH:mm:ss');
      const detail = this.toErrorMessage(error, 'PostgreSQL backup failed.');
      const client = await this.pool.connect();
      let transactionOpen = false;
      try {
        await client.query('BEGIN');
        transactionOpen = true;

        const row = await this.recordSystemBackupRun(client, {
          backupNo,
          backupType: 'manual',
          runStatus: 'failed',
          fileName: '',
          filePath: path.resolve(this.getBackupRootDir()),
          fileSize: 0,
          detail,
          startedAt,
          finishedAt,
          triggeredByName,
        });

        await this.insertWorkspaceLog(
          client,
          featureKey,
          'backup',
          'PostgreSQL backup failed',
          detail,
          finishedAt,
        );
        await this.touchWorkspace(client, featureKey, finishedAt);

        await client.query('COMMIT');
        transactionOpen = false;
        return row;
      } catch (commitError) {
        if (transactionOpen) {
          await client.query('ROLLBACK');
        }
        throw commitError;
      } finally {
        client.release();
      }
    }
  }

  async runSystemLogArchive(
    featureKey: string,
    triggeredByName?: string | null,
  ): Promise<SystemLogArchiveRun | null> {
    if (featureKey !== 'system-monitoring') {
      return null;
    }

    const createdAt = format(new Date(), 'yyyy-MM-dd HH:mm:ss');
    const archiveNo = `LOG-${format(new Date(), 'yyyyMMddHHmmss')}-${randomUUID().slice(0, 6)}`;

    try {
      const artifact = await this.createPostgresLogArchiveArtifact({
        archiveNo,
        createdAt,
      });
      const client = await this.pool.connect();
      let transactionOpen = false;
      try {
        await client.query('BEGIN');
        transactionOpen = true;

        await this.recordSystemLogArchive(client, {
          archiveNo,
          periodStart: artifact.periodStart,
          periodEnd: artifact.periodEnd,
          logCount: artifact.logCount,
          fileName: artifact.fileName,
          filePath: artifact.filePath,
          archiveStatus: 'ready',
          detail: artifact.detail,
          createdAt,
          triggeredByName,
        });

        await this.insertWorkspaceLog(
          client,
          featureKey,
          'archive',
          'PostgreSQL audit log archive completed',
          `Archive ${archiveNo} wrote ${artifact.logCount} logs to ${artifact.fileName}.`,
          createdAt,
        );
        await this.touchWorkspace(client, featureKey, createdAt);

        await client.query('COMMIT');
        transactionOpen = false;
        return {
          archiveNo,
          fileName: artifact.fileName,
          filePath: artifact.filePath,
          logCount: artifact.logCount,
          createdAt,
        };
      } catch (error) {
        if (transactionOpen) {
          await client.query('ROLLBACK');
        }
        throw error;
      } finally {
        client.release();
      }
    } catch (error) {
      fs.mkdirSync(this.getLogArchiveRootDir(), { recursive: true });
      const detail = this.toErrorMessage(error, 'PostgreSQL audit log archive failed.');
      const client = await this.pool.connect();
      let transactionOpen = false;
      try {
        await client.query('BEGIN');
        transactionOpen = true;

        await this.recordSystemLogArchive(client, {
          archiveNo,
          periodStart: createdAt,
          periodEnd: createdAt,
          logCount: 0,
          fileName: '',
          filePath: path.resolve(this.getLogArchiveRootDir()),
          archiveStatus: 'failed',
          detail,
          createdAt,
          triggeredByName,
        });

        await this.insertWorkspaceLog(
          client,
          featureKey,
          'archive',
          'PostgreSQL audit log archive failed',
          detail,
          createdAt,
        );
        await this.touchWorkspace(client, featureKey, createdAt);

        await client.query('COMMIT');
        transactionOpen = false;
      } catch (commitError) {
        if (transactionOpen) {
          await client.query('ROLLBACK');
        }
        throw commitError;
      } finally {
        client.release();
      }

      throw error;
    }
  }

  async runSystemRecoveryDrill(
    featureKey: string,
    triggeredByName?: string | null,
  ): Promise<SystemRecoveryDrillRun | null> {
    if (featureKey !== 'system-monitoring') {
      return null;
    }

    const drillNo = `DRILL-${format(new Date(), 'yyyyMMddHHmmss')}-${randomUUID().slice(0, 6)}`;
    const started = new Date();
    const startedAt = format(started, 'yyyy-MM-dd HH:mm:ss');
    const reportPath = path.resolve(path.join(this.getRecoveryDrillRootDir(), drillNo, 'report.json'));
    const latestBackupResult = await this.pool.query(
      `
        SELECT
          id,
          backup_no AS "backupNo",
          run_status AS "runStatus",
          file_name AS "fileName",
          file_path AS "filePath"
        FROM system_backup_runs
        WHERE run_status = 'success'
        ORDER BY started_at DESC, id DESC
        LIMIT 1
      `,
    );

    let backup =
      latestBackupResult.rows[0] &&
      String(latestBackupResult.rows[0].filePath ?? '').trim() &&
      fs.existsSync(String(latestBackupResult.rows[0].filePath))
        ? {
            id: toNumber(latestBackupResult.rows[0].id),
            backupNo: String(latestBackupResult.rows[0].backupNo ?? ''),
            fileName: String(latestBackupResult.rows[0].fileName ?? ''),
            filePath: String(latestBackupResult.rows[0].filePath ?? ''),
          }
        : null;

    if (!backup) {
      const freshBackup = await this.runSystemBackup(featureKey, triggeredByName);
      if (
        freshBackup &&
        freshBackup.runStatus === 'success' &&
        freshBackup.fileName &&
        freshBackup.filePath &&
        fs.existsSync(freshBackup.filePath)
      ) {
        backup = {
          id: freshBackup.id,
          backupNo: freshBackup.backupNo,
          fileName: freshBackup.fileName,
          filePath: freshBackup.filePath,
        };
      }
    }

    if (!backup) {
      const detail = 'PostgreSQL recovery drill requires a readable backup artifact.';
      return this.persistRecoveryDrillResult({
        featureKey,
        drillNo,
        backupRunId: null,
        backupNo: null,
        drillStatus: 'failed',
        targetPath: reportPath,
        detail,
        startedAt,
        started,
        triggeredByName,
      });
    }

    try {
      const manifestRaw = fs.readFileSync(backup.filePath, 'utf8');
      const manifest = JSON.parse(manifestRaw) as {
        kind?: string;
        database?: { databaseName?: string | null };
        tables?: Array<{
          schemaName?: string;
          tableName?: string;
          rowEstimate?: number;
          totalBytes?: number;
          columns?: Array<{
            columnName?: string;
            dataType?: string;
            udtName?: string;
            isNullable?: boolean;
          }>;
        }>;
      };
      if (!manifest.kind || !Array.isArray(manifest.tables)) {
        throw new Error('Backup artifact is not a recognized PostgreSQL snapshot.');
      }

      const currentSnapshot = await this.collectPostgresOperationalSnapshot();
      const liveTables = new Map(
        currentSnapshot.tables.map((table) => [
          `${table.schemaName}.${table.tableName}`,
          table,
        ]),
      );
      const missingTables: string[] = [];
      const changedTables: string[] = [];

      for (const table of manifest.tables) {
        const schemaName = String(table.schemaName ?? 'public');
        const tableName = String(table.tableName ?? '');
        const key = `${schemaName}.${tableName}`;
        const liveTable = liveTables.get(key);
        if (!liveTable) {
          missingTables.push(key);
          continue;
        }
        if (
          this.buildColumnSignature(table.columns ?? []) !==
          this.buildColumnSignature(liveTable.columns)
        ) {
          changedTables.push(key);
        }
      }

      const finishedAt = format(new Date(), 'yyyy-MM-dd HH:mm:ss');
      fs.mkdirSync(path.dirname(reportPath), { recursive: true });
      fs.writeFileSync(
        reportPath,
        JSON.stringify(
          {
            kind: 'postgres-recovery-drill-report',
            drillNo,
            backupNo: backup.backupNo,
            startedAt,
            finishedAt,
            sourceArtifactPath: backup.filePath,
            sourceDatabase: manifest.database?.databaseName ?? currentSnapshot.database.databaseName,
            checkedTableCount: manifest.tables.length,
            missingTables,
            changedTables,
            targetPath: reportPath,
          },
          null,
          2,
        ),
        'utf8',
      );

      const detail =
        missingTables.length > 0
          ? `Validated ${manifest.tables.length} tables from backup ${backup.backupNo}; ${missingTables.length} tables are missing from the live database.`
          : changedTables.length > 0
            ? `Validated ${manifest.tables.length} tables from backup ${backup.backupNo}; ${changedTables.length} tables changed shape since the snapshot.`
            : `Validated ${manifest.tables.length} tables from backup ${backup.backupNo} with no missing tables.`;

      return this.persistRecoveryDrillResult({
        featureKey,
        drillNo,
        backupRunId: backup.id,
        backupNo: backup.backupNo,
        drillStatus: 'success',
        targetPath: reportPath,
        detail,
        startedAt,
        started,
        triggeredByName,
      });
    } catch (error) {
      const detail = this.toErrorMessage(error, 'PostgreSQL recovery drill failed.');
      fs.mkdirSync(path.dirname(reportPath), { recursive: true });
      fs.writeFileSync(
        reportPath,
        JSON.stringify(
          {
            kind: 'postgres-recovery-drill-report',
            drillNo,
            backupNo: backup.backupNo,
            startedAt,
            finishedAt: format(new Date(), 'yyyy-MM-dd HH:mm:ss'),
            sourceArtifactPath: backup.filePath,
            targetPath: reportPath,
            error: detail,
          },
          null,
          2,
        ),
        'utf8',
      );

      return this.persistRecoveryDrillResult({
        featureKey,
        drillNo,
        backupRunId: backup.id,
        backupNo: backup.backupNo,
        drillStatus: 'failed',
        targetPath: reportPath,
        detail,
        startedAt,
        started,
        triggeredByName,
      });
    }
  }

  async runWorkspaceAction(featureKey: string, actionId: number) {
    const client = await this.pool.connect();
    let transactionOpen = false;
    try {
      await client.query('BEGIN');
      transactionOpen = true;

      const actionResult = await client.query(
        `
          SELECT id, title, run_count AS "runCount"
          FROM workspace_actions
          WHERE id = $1 AND feature_key = $2
        `,
        [actionId, featureKey],
      );
      const action = actionResult.rows[0] as { id: number; title: string; runCount: number } | undefined;
      if (!action) {
        await client.query('ROLLBACK');
        transactionOpen = false;
        return null;
      }

      const now = format(new Date(), 'yyyy-MM-dd HH:mm:ss');
      await client.query(
        `
          UPDATE workspace_actions
          SET run_count = COALESCE(run_count, 0) + 1, last_run_at = $1
          WHERE id = $2 AND feature_key = $3
        `,
        [now, actionId, featureKey],
      );

      const pendingTaskResult = await client.query(
        `
          SELECT id
          FROM workspace_tasks
          WHERE feature_key = $1 AND status = 'todo'
          ORDER BY due_at ASC, id ASC
          LIMIT 1
        `,
        [featureKey],
      );
      const pendingTask = pendingTaskResult.rows[0] as { id: number } | undefined;
      if (pendingTask) {
        await client.query(
          `
            UPDATE workspace_tasks
            SET status = 'in_progress'
            WHERE id = $1 AND feature_key = $2
          `,
          [pendingTask.id, featureKey],
        );
      } else {
        const nextTaskId = await this.nextTableId(client, 'workspace_tasks');
        await client.query(
          `
            INSERT INTO workspace_tasks (id, feature_key, title, description, owner, priority, status, due_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          `,
          [
            nextTaskId,
            featureKey,
            `${featureKey} action review`,
            'Auto-generated review task after workspace action execution.',
            'system',
            'medium',
            'todo',
            format(addDays(new Date(), 1), 'yyyy-MM-dd HH:mm:ss'),
          ],
        );
      }

      await this.insertWorkspaceLog(
        client,
        featureKey,
        'action',
        `${action.title} executed`,
        'Execution result recorded for follow-up review.',
        now,
      );
      await this.touchWorkspace(client, featureKey, now);

      await client.query('COMMIT');
      transactionOpen = false;
      return { ok: true };
    } catch (error) {
      if (transactionOpen) {
        await client.query('ROLLBACK');
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async toggleWorkspaceRule(featureKey: string, ruleId: number) {
    const client = await this.pool.connect();
    let transactionOpen = false;
    try {
      await client.query('BEGIN');
      transactionOpen = true;

      const ruleResult = await client.query(
        `
          SELECT id, name, enabled
          FROM workspace_rules
          WHERE id = $1 AND feature_key = $2
        `,
        [ruleId, featureKey],
      );
      const rule = ruleResult.rows[0] as
        | { id: number; name: string; enabled: number | string }
        | undefined;
      if (!rule) {
        await client.query('ROLLBACK');
        transactionOpen = false;
        return null;
      }

      const nextEnabled = toNumber(rule.enabled) ? 0 : 1;
      const now = format(new Date(), 'yyyy-MM-dd HH:mm:ss');

      await client.query(
        `
          UPDATE workspace_rules
          SET enabled = $1, updated_at = $2
          WHERE id = $3 AND feature_key = $4
        `,
        [nextEnabled, now, ruleId, featureKey],
      );

      await this.insertWorkspaceLog(
        client,
        featureKey,
        'rule',
        `${rule.name} ${nextEnabled ? 'enabled' : 'disabled'}`,
        nextEnabled
          ? 'Rule was added back to the active execution scope.'
          : 'Rule was removed from the active execution scope.',
        now,
      );
      await this.touchWorkspace(client, featureKey, now);

      await client.query('COMMIT');
      transactionOpen = false;
      return { enabled: Boolean(nextEnabled) };
    } catch (error) {
      if (transactionOpen) {
        await client.query('ROLLBACK');
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async updateWorkspaceTaskStatus(
    featureKey: string,
    taskId: number,
    status: WorkspaceTaskStatus,
  ) {
    const client = await this.pool.connect();
    let transactionOpen = false;
    try {
      await client.query('BEGIN');
      transactionOpen = true;

      const taskResult = await client.query(
        `
          SELECT id, title
          FROM workspace_tasks
          WHERE id = $1 AND feature_key = $2
        `,
        [taskId, featureKey],
      );
      const task = taskResult.rows[0] as { id: number; title: string } | undefined;
      if (!task) {
        await client.query('ROLLBACK');
        transactionOpen = false;
        return null;
      }

      const now = format(new Date(), 'yyyy-MM-dd HH:mm:ss');
      await client.query(
        `
          UPDATE workspace_tasks
          SET status = $1
          WHERE id = $2 AND feature_key = $3
        `,
        [status, taskId, featureKey],
      );

      await this.insertWorkspaceLog(
        client,
        featureKey,
        'task',
        `${task.title} status updated`,
        `Task status changed to ${status}.`,
        now,
      );
      await this.touchWorkspace(client, featureKey, now);

      await client.query('COMMIT');
      transactionOpen = false;
      return { status };
    } catch (error) {
      if (transactionOpen) {
        await client.query('ROLLBACK');
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async updateSystemAlertStatus(
    featureKey: string,
    alertId: number,
    status: SystemAlertStatus,
  ): Promise<SystemAlertStatusUpdate | null> {
    if (featureKey !== 'system-monitoring') {
      return null;
    }

    const client = await this.pool.connect();
    let transactionOpen = false;
    try {
      await client.query('BEGIN');
      transactionOpen = true;

      const alertResult = await client.query(
        `
          SELECT id, alert_type AS "alertType", title
          FROM system_alerts
          WHERE id = $1
        `,
        [alertId],
      );
      const alert = alertResult.rows[0] as { id: number; alertType: string; title: string } | undefined;
      if (!alert) {
        await client.query('ROLLBACK');
        transactionOpen = false;
        return null;
      }

      const now = format(new Date(), 'yyyy-MM-dd HH:mm:ss');
      await client.query(
        `
          UPDATE system_alerts
          SET
            status = $1,
            acknowledged_at = CASE
              WHEN $1 = 'acknowledged' THEN COALESCE(acknowledged_at, $2)
              ELSE acknowledged_at
            END,
            resolved_at = CASE
              WHEN $1 = 'resolved' THEN COALESCE(resolved_at, $2)
              ELSE NULL
            END,
            updated_at = $2
          WHERE id = $3
        `,
        [status, now, alertId],
      );

      await this.insertWorkspaceLog(
        client,
        featureKey,
        'alert',
        `${this.getSystemAlertTypeText(alert.alertType)}告警已${status === 'acknowledged' ? '确认' : '处理'}`,
        status === 'acknowledged'
          ? `${alert.title} 已由运维人员确认，等待后续处理。`
          : `${alert.title} 已手动标记为处理完成，系统将在下次体检时继续复核。`,
        now,
      );
      await this.touchWorkspace(client, featureKey, now);

      await client.query('COMMIT');
      transactionOpen = false;
      return { status };
    } catch (error) {
      if (transactionOpen) {
        await client.query('ROLLBACK');
      }
      throw error;
    } finally {
      client.release();
    }
  }

  private async getAiServiceDetail(fallback: AiServiceDetail): Promise<AiServiceDetail> {
    const [
      settings,
      summaryResult,
      conversationsResult,
      recentMessagesResult,
      takeoversResult,
      knowledgeItemsResult,
      replyTemplatesResult,
      syncNoticesResult,
    ] = await Promise.all([
      this.getAiServiceSettingsRow(),
      this.pool.query(
        `
          SELECT
            COUNT(*) AS "totalConversationCount",
            SUM(CASE WHEN conversation_status IN ('open', 'pending_manual', 'manual_active') THEN 1 ELSE 0 END) AS "activeConversationCount",
            SUM(CASE WHEN conversation_status = 'pending_manual' THEN 1 ELSE 0 END) AS "pendingManualCount",
            SUM(CASE WHEN ai_status = 'auto_replied' THEN 1 ELSE 0 END) AS "autoReplyCount",
            SUM(CASE WHEN risk_level = 'high' THEN 1 ELSE 0 END) AS "highRiskCount"
          FROM ai_service_conversations
        `,
      ),
      this.pool.query(
        `
          SELECT
            c.id,
            c.session_no AS "sessionNo",
            c.channel,
            c.source,
            c.customer_name AS "customerName",
            c.topic,
            c.store_id AS "storeId",
            s.name AS "storeName",
            o.order_no AS "orderNo",
            ac.case_no AS "caseNo",
            c.latest_user_intent AS "latestUserIntent",
            c.item_main_pic AS "itemMainPic",
            c.conversation_status AS "conversationStatus",
            c.ai_status AS "aiStatus",
            c.risk_level AS "riskLevel",
            c.priority,
            c.unread_count AS "unreadCount",
            c.boundary_label AS "boundaryLabel",
            c.tags_text AS "tagsText",
            c.last_message_at AS "lastMessageAt",
            u.display_name AS "assignedUserName"
          FROM ai_service_conversations c
          LEFT JOIN stores s ON s.id = c.store_id
          LEFT JOIN orders o ON o.id = c.order_id
          LEFT JOIN after_sale_cases ac ON ac.id = c.case_id
          LEFT JOIN users u ON u.id = c.assigned_user_id
          ORDER BY
            CASE c.conversation_status
              WHEN 'pending_manual' THEN 1
              WHEN 'manual_active' THEN 2
              WHEN 'open' THEN 3
              ELSE 4
            END,
            c.last_message_at DESC,
            c.id DESC
        `,
      ),
      this.pool.query(
        `
          SELECT
            m.id,
            m.conversation_id AS "conversationId",
            c.session_no AS "sessionNo",
            c.customer_name AS "customerName",
            m.sender_name AS "senderName",
            m.sender_type AS "senderType",
            m.scene,
            m.content,
            m.status,
            m.created_at AS "createdAt"
          FROM ai_service_messages m
          INNER JOIN ai_service_conversations c ON c.id = m.conversation_id
          ORDER BY
            c.last_message_at DESC,
            m.created_at ASC,
            m.id ASC
        `,
      ),
      this.pool.query(
        `
          SELECT
            t.id,
            t.conversation_id AS "conversationId",
            c.session_no AS "sessionNo",
            c.customer_name AS "customerName",
            t.action_type AS "actionType",
            t.operator_name AS "operatorName",
            t.note,
            t.created_at AS "createdAt"
          FROM ai_service_takeovers t
          INNER JOIN ai_service_conversations c ON c.id = t.conversation_id
          ORDER BY t.created_at DESC, t.id DESC
          LIMIT 12
        `,
      ),
      this.pool.query(
        `
          SELECT
            id,
            category,
            title,
            keywords_text AS "keywordsText",
            question_text AS "questionText",
            answer_text AS "answerText",
            enabled,
            risk_level AS "riskLevel",
            updated_at AS "updatedAt"
          FROM ai_service_knowledge_items
          ORDER BY enabled DESC, id ASC
        `,
      ),
      this.pool.query(
        `
          SELECT
            id,
            scene,
            title,
            trigger_text AS "triggerText",
            template_content AS "templateContent",
            enabled,
            updated_at AS "updatedAt"
          FROM ai_service_reply_templates
          ORDER BY enabled DESC, id ASC
        `,
      ),
      this.pool.query(
        `
          SELECT
            ms.id AS "storeId",
            ms.shop_name AS "storeName",
            spc.risk_level AS "riskLevel",
            spc.risk_reason AS detail,
            spc.verification_url AS "verificationUrl",
            COALESCE(ms.last_health_check_at, spc.last_verified_at, spc.updated_at, ms.updated_at) AS "updatedAt"
          FROM managed_stores ms
          INNER JOIN store_platform_credentials spc ON spc.id = ms.credential_id
          WHERE ms.platform = 'xianyu'
            AND ms.enabled = 1
            AND spc.credential_type = 'web_session'
            AND (
              COALESCE(spc.verification_url, '') <> ''
              OR spc.risk_level IN ('warning', 'offline', 'abnormal')
            )
          ORDER BY
            CASE spc.risk_level
              WHEN 'abnormal' THEN 1
              WHEN 'offline' THEN 2
              WHEN 'warning' THEN 3
              ELSE 4
            END,
            "updatedAt" DESC,
            ms.id DESC
        `,
      ),
    ]);

    const summary = summaryResult.rows[0] ?? {};
    const enabledKnowledgeCount = knowledgeItemsResult.rows.filter((row) => Boolean(toNumber(row.enabled))).length;
    const enabledReplyTemplateCount = replyTemplatesResult.rows.filter((row) => Boolean(toNumber(row.enabled))).length;

    return {
      ...fallback,
      metrics:
        fallback.metrics.length >= 4
          ? [
              {
                ...fallback.metrics[0],
                value: toNumber(summary.activeConversationCount),
                helper: `待人工 ${toNumber(summary.pendingManualCount)} 个`,
              },
              {
                ...fallback.metrics[1],
                value: toNumber(summary.autoReplyCount),
                helper: '标准 FAQ 与订单状态可自动答复',
              },
              {
                ...fallback.metrics[2],
                value: toNumber(summary.highRiskCount),
                helper: '命中敏感词或高风险标签后仅转人工',
              },
              {
                ...fallback.metrics[3],
                value: enabledKnowledgeCount,
                helper: `话术模板 ${enabledReplyTemplateCount} 条`,
              },
            ]
          : fallback.metrics,
      settings: settings ?? fallback.settings,
      conversations: conversationsResult.rows.map((row) => ({
        ...row,
        id: toNumber(row.id),
        storeId: row.storeId == null ? null : toNumber(row.storeId),
        tags: String(row.tagsText ?? '')
          .split(/[,，]/)
          .map((item) => item.trim())
          .filter(Boolean),
        conversationStatus: String(row.conversationStatus ?? 'open'),
        conversationStatusText: this.getAiServiceConversationStatusText(String(row.conversationStatus ?? 'open')),
        aiStatus: String(row.aiStatus ?? 'ready'),
        aiStatusText: this.getAiServiceAiStatusText(String(row.aiStatus ?? 'ready')),
        riskLevel: String(row.riskLevel ?? 'medium'),
        riskLevelText: this.getAiServiceRiskLevelText(String(row.riskLevel ?? 'medium')),
        unreadCount: toNumber(row.unreadCount),
      })),
      recentMessages: recentMessagesResult.rows.map((row) => ({
        ...row,
        id: toNumber(row.id),
        conversationId: toNumber(row.conversationId),
        senderType: String(row.senderType ?? 'system'),
        senderTypeText: this.getAiServiceMessageTypeText(String(row.senderType ?? 'system')),
      })),
      takeovers: takeoversResult.rows.map((row) => ({
        ...row,
        id: toNumber(row.id),
        conversationId: toNumber(row.conversationId),
      })),
      knowledgeItems: knowledgeItemsResult.rows.map((row) => ({
        ...row,
        id: toNumber(row.id),
        enabled: Boolean(toNumber(row.enabled)),
        riskLevel: String(row.riskLevel ?? 'medium'),
        riskLevelText: this.getAiServiceRiskLevelText(String(row.riskLevel ?? 'medium')),
      })),
      replyTemplates: replyTemplatesResult.rows.map((row) => ({
        ...row,
        id: toNumber(row.id),
        enabled: Boolean(toNumber(row.enabled)),
      })),
      syncNotices: syncNoticesResult.rows.map((row) => {
        const riskLevel = String(row.riskLevel ?? 'warning');
        const verificationUrl = String(row.verificationUrl ?? '').trim() || null;
        return {
          ...row,
          storeId: toNumber(row.storeId),
          riskLevel,
          detail:
            String(row.detail ?? '').trim() ||
            (verificationUrl
              ? '闲鱼消息链路命中验证码，请点击入口继续处理。'
              : riskLevel === 'offline'
                ? '闲鱼网页登录态已失效，请重新登录或续登。'
                : '闲鱼消息链路当前需要人工处理。'),
          verificationUrl,
          updatedAt: String(row.updatedAt ?? ''),
        };
      }),
    };
  }

  private async getSystemMonitoringDetail(
    fallback: SystemMonitoringDetail,
  ): Promise<SystemMonitoringDetail> {
    const [
      alertsResult,
      backupsResult,
      logArchivesResult,
      recoveryDrillsResult,
      cardDeliveryMonitorResult,
      directChargeMonitorResult,
      sourceSupplyMonitorResult,
      storeHealthMonitorResult,
      databaseSizeResult,
    ] = await Promise.all([
      this.pool.query(
        `
          SELECT
            id,
            alert_type AS "alertType",
            severity,
            status,
            source_count AS "sourceCount",
            title,
            detail,
            first_triggered_at AS "firstTriggeredAt",
            last_triggered_at AS "lastTriggeredAt",
            acknowledged_at AS "acknowledgedAt",
            resolved_at AS "resolvedAt",
            updated_at AS "updatedAt"
          FROM system_alerts
          ORDER BY
            CASE status
              WHEN 'open' THEN 1
              WHEN 'acknowledged' THEN 2
              ELSE 3
            END,
            CASE severity
              WHEN 'critical' THEN 1
              ELSE 2
            END,
            last_triggered_at DESC,
            id DESC
        `,
      ),
      this.pool.query(
        `
          SELECT
            id,
            backup_no AS "backupNo",
            backup_type AS "backupType",
            run_status AS "runStatus",
            file_name AS "fileName",
            file_path AS "filePath",
            file_size AS "fileSize",
            detail,
            started_at AS "startedAt",
            finished_at AS "finishedAt",
            triggered_by_name AS "triggeredByName"
          FROM system_backup_runs
          ORDER BY started_at DESC, id DESC
          LIMIT 8
        `,
      ),
      this.pool.query(
        `
          SELECT
            id,
            archive_no AS "archiveNo",
            period_start AS "periodStart",
            period_end AS "periodEnd",
            log_count AS "logCount",
            file_name AS "fileName",
            file_path AS "filePath",
            archive_status AS "archiveStatus",
            detail,
            created_at AS "createdAt",
            triggered_by_name AS "triggeredByName"
          FROM system_log_archives
          ORDER BY created_at DESC, id DESC
          LIMIT 8
        `,
      ),
      this.pool.query(
        `
          SELECT
            id,
            drill_no AS "drillNo",
            backup_no_snapshot AS "backupNo",
            drill_status AS "drillStatus",
            target_path AS "targetPath",
            duration_seconds AS "durationSeconds",
            detail,
            started_at AS "startedAt",
            finished_at AS "finishedAt",
            triggered_by_name AS "triggeredByName"
          FROM system_recovery_drills
          ORDER BY started_at DESC, id DESC
          LIMIT 8
        `,
      ),
      this.pool.query(
        `
          SELECT
            'card-delivery' AS "groupKey",
            '卡密发货' AS "groupLabel",
            SUM(CASE WHEN job_status = 'pending' THEN 1 ELSE 0 END) AS "pendingCount",
            SUM(CASE WHEN job_status = 'failed' THEN 1 ELSE 0 END) AS "failedCount",
            SUM(CASE WHEN job_status = 'recycled' THEN 1 ELSE 0 END) AS "manualCount",
            MAX(updated_at) AS "latestUpdatedAt"
          FROM card_delivery_jobs
        `,
      ),
      this.pool.query(
        `
          SELECT
            'direct-charge' AS "groupKey",
            '直充发货' AS "groupLabel",
            SUM(CASE WHEN task_status IN ('pending_dispatch', 'processing') THEN 1 ELSE 0 END) AS "pendingCount",
            SUM(CASE WHEN task_status = 'failed' THEN 1 ELSE 0 END) AS "failedCount",
            SUM(CASE WHEN task_status = 'manual_review' THEN 1 ELSE 0 END) AS "manualCount",
            MAX(updated_at) AS "latestUpdatedAt"
          FROM direct_charge_jobs
        `,
      ),
      this.pool.query(
        `
          SELECT
            'source-supply' AS "groupKey",
            '货源推单' AS "groupLabel",
            SUM(CASE WHEN order_status IN ('pending_push', 'processing') THEN 1 ELSE 0 END) AS "pendingCount",
            SUM(CASE WHEN order_status = 'failed' THEN 1 ELSE 0 END) AS "failedCount",
            SUM(CASE WHEN order_status = 'manual_review' THEN 1 ELSE 0 END) AS "manualCount",
            MAX(updated_at) AS "latestUpdatedAt"
          FROM supply_source_orders
        `,
      ),
      this.pool.query(
        `
          SELECT
            'store-health' AS "groupKey",
            '店铺体检' AS "groupLabel",
            SUM(
              CASE
                WHEN enabled = 1
                  AND (
                    last_health_check_at IS NULL
                    OR last_health_check_at < to_char(CURRENT_TIMESTAMP - INTERVAL '1 day', 'YYYY-MM-DD HH24:MI:SS')
                  )
                THEN 1
                ELSE 0
              END
            ) AS "pendingCount",
            SUM(CASE WHEN health_status IN ('offline', 'abnormal') THEN 1 ELSE 0 END) AS "failedCount",
            SUM(CASE WHEN health_status = 'warning' THEN 1 ELSE 0 END) AS "manualCount",
            MAX(last_health_check_at) AS "latestUpdatedAt"
          FROM managed_stores
        `,
      ),
      this.pool.query(`SELECT pg_database_size(current_database()) AS "databaseSizeBytes"`),
    ]);

    const fallbackJobMonitorMap = new Map(
      fallback.jobMonitors.map((item) => [item.groupKey, item]),
    );
    const alerts = alertsResult.rows.map((row) => ({
      id: toNumber(row.id),
      alertType: String(row.alertType) as SystemMonitoringDetail['alerts'][number]['alertType'],
      alertTypeText: this.getSystemAlertTypeText(String(row.alertType ?? '')),
      severity: String(row.severity ?? 'warning') as SystemMonitoringDetail['alerts'][number]['severity'],
      status: String(row.status ?? 'open') as SystemMonitoringDetail['alerts'][number]['status'],
      sourceCount: toNumber(row.sourceCount),
      title: String(row.title ?? ''),
      detail: String(row.detail ?? ''),
      firstTriggeredAt: String(row.firstTriggeredAt ?? ''),
      lastTriggeredAt: String(row.lastTriggeredAt ?? ''),
      acknowledgedAt: row.acknowledgedAt ? String(row.acknowledgedAt) : null,
      resolvedAt: row.resolvedAt ? String(row.resolvedAt) : null,
      updatedAt: String(row.updatedAt ?? ''),
    }));
    const backups = backupsResult.rows.map((row) => ({
      id: toNumber(row.id),
      backupNo: String(row.backupNo ?? ''),
      backupType: String(row.backupType ?? 'manual') as SystemMonitoringDetail['backups'][number]['backupType'],
      runStatus: String(row.runStatus ?? 'failed') as SystemMonitoringDetail['backups'][number]['runStatus'],
      fileName: String(row.fileName ?? ''),
      filePath: String(row.filePath ?? ''),
      fileSize: toNumber(row.fileSize),
      detail: String(row.detail ?? ''),
      startedAt: String(row.startedAt ?? ''),
      finishedAt: row.finishedAt ? String(row.finishedAt) : null,
      triggeredByName: row.triggeredByName ? String(row.triggeredByName) : null,
    }));
    const logArchives = logArchivesResult.rows.map((row) => ({
      id: toNumber(row.id),
      archiveNo: String(row.archiveNo ?? ''),
      periodStart: String(row.periodStart ?? ''),
      periodEnd: String(row.periodEnd ?? ''),
      logCount: toNumber(row.logCount),
      fileName: String(row.fileName ?? ''),
      filePath: String(row.filePath ?? ''),
      archiveStatus: String(row.archiveStatus ?? 'failed') as SystemMonitoringDetail['logArchives'][number]['archiveStatus'],
      detail: String(row.detail ?? ''),
      createdAt: String(row.createdAt ?? ''),
      triggeredByName: row.triggeredByName ? String(row.triggeredByName) : null,
    }));
    const recoveryDrills = recoveryDrillsResult.rows.map((row) => ({
      id: toNumber(row.id),
      drillNo: String(row.drillNo ?? ''),
      backupNo: row.backupNo ? String(row.backupNo) : null,
      drillStatus: String(row.drillStatus ?? 'failed') as SystemMonitoringDetail['recoveryDrills'][number]['drillStatus'],
      targetPath: String(row.targetPath ?? ''),
      durationSeconds: toNumber(row.durationSeconds),
      detail: String(row.detail ?? ''),
      startedAt: String(row.startedAt ?? ''),
      finishedAt: row.finishedAt ? String(row.finishedAt) : null,
      triggeredByName: row.triggeredByName ? String(row.triggeredByName) : null,
    }));
    const jobMonitors = [
      cardDeliveryMonitorResult.rows[0],
      directChargeMonitorResult.rows[0],
      sourceSupplyMonitorResult.rows[0],
      storeHealthMonitorResult.rows[0],
    ]
      .filter(Boolean)
      .map((row) => {
        const groupKey = String(row.groupKey ?? '');
        const fallbackJobMonitor = fallbackJobMonitorMap.get(groupKey);
        return {
          groupKey,
          groupLabel: String(row.groupLabel ?? fallbackJobMonitor?.groupLabel ?? groupKey),
          pendingCount: toNumber(row.pendingCount),
          failedCount: toNumber(row.failedCount),
          manualCount: toNumber(row.manualCount),
          latestUpdatedAt: row.latestUpdatedAt ? String(row.latestUpdatedAt) : null,
          note:
            fallbackJobMonitor?.note ??
            (groupKey === 'store-health'
              ? 'Focus on stale checks, offline stores, and warning states.'
              : 'Focus on failed jobs, manual intervention, and long-running items.'),
        };
      });

    const activeAlertCount = alerts.filter((item) => item.status !== 'resolved').length;
    const criticalAlertCount = alerts.filter(
      (item) => item.status !== 'resolved' && item.severity === 'critical',
    ).length;
    const latestBackup = backups.find((item) => item.runStatus === 'success');
    const latestDrill = recoveryDrills[0];
    const successfulBackupCount = backups.filter((item) => item.runStatus === 'success').length;
    const metrics = fallback.metrics.length >= 4
      ? [
          { ...fallback.metrics[0], value: activeAlertCount },
          { ...fallback.metrics[1], value: criticalAlertCount },
          { ...fallback.metrics[2], value: successfulBackupCount },
          { ...fallback.metrics[3], value: logArchives.length },
        ]
      : fallback.metrics;

    return {
      ...fallback,
      metrics,
      health: {
        ...fallback.health,
        apiStatus: activeAlertCount > 0 ? 'warning' : 'healthy',
        databaseSizeBytes: toNumber(databaseSizeResult.rows[0]?.databaseSizeBytes),
        latestBackupAt: latestBackup?.startedAt ?? fallback.health.latestBackupAt,
        latestRecoveryAt: latestDrill?.finishedAt ?? fallback.health.latestRecoveryAt,
      },
      alerts,
      jobMonitors: jobMonitors.length > 0 ? jobMonitors : fallback.jobMonitors,
      backups,
      logArchives,
      recoveryDrills,
      notes: fallback.notes,
    };
  }

  private async buildBusinessReportSnapshot(filters: QueryFilters) {
    const range = resolveDateRange(filters);
    const [orders, cases] = await Promise.all([
      this.getBusinessReportOrderRows(filters, range),
      this.getBusinessReportCaseRows(filters, range),
    ]);
    const metrics = this.summarizeBusinessReportMetrics(orders, cases);
    const nowText = format(new Date(), 'yyyy-MM-dd HH:mm:ss');
    const caseCountByOrderId = new Map<number, number>();

    cases.forEach((row) => {
      caseCountByOrderId.set(row.orderId, (caseCountByOrderId.get(row.orderId) ?? 0) + 1);
    });

    const storeMap = new Map<number, {
      storeId: number;
      storeName: string;
      orderCount: number;
      salesAmount: number;
      refundAmount: number;
      netSalesAmount: number;
      grossProfit: number;
      completedOrders: number;
      afterSaleCases: number;
      successFulfillmentCount: number;
      manualReviewCount: number;
      deliveryHoursTotal: number;
      deliveryHoursCount: number;
    }>();
    const productMap = new Map<number, {
      productId: number;
      productName: string;
      productSku: string;
      storeName: string;
      category: string;
      orderCount: number;
      soldQuantity: number;
      salesAmount: number;
      refundAmount: number;
      netSalesAmount: number;
      grossProfit: number;
      afterSaleCases: number;
      successFulfillmentCount: number;
    }>();
    const sourceMap = new Map<string, { source: string; orderCount: number; salesAmount: number }>();
    const mainStatusMap = new Map<string, { status: string; label: string; orderCount: number }>();
    const fulfillmentMap = new Map<string, { queue: string; label: string; orderCount: number }>();
    const trendMap = new Map<string, {
      reportDate: string;
      grossAmount: number;
      receivedAmount: number;
      refundAmount: number;
      netProfit: number;
      orderCount: number;
      afterSaleCaseCount: number;
    }>();

    for (
      let cursor = startOfDay(parseISO(range.startDate));
      cursor <= endOfDay(parseISO(range.endDate));
      cursor = addDays(cursor, 1)
    ) {
      const reportDate = format(cursor, 'yyyy-MM-dd');
      trendMap.set(reportDate, {
        reportDate,
        grossAmount: 0,
        receivedAmount: 0,
        refundAmount: 0,
        netProfit: 0,
        orderCount: 0,
        afterSaleCaseCount: 0,
      });
    }

    orders.forEach((row) => {
      const netSalesAmount = row.receivedAmount - row.refundAmount;
      const grossProfit = netSalesAmount - row.unitCost * row.quantity;
      const reportDate = row.paidAt.slice(0, 10);

      const storeRow = storeMap.get(row.storeId) ?? {
        storeId: row.storeId,
        storeName: row.storeName,
        orderCount: 0,
        salesAmount: 0,
        refundAmount: 0,
        netSalesAmount: 0,
        grossProfit: 0,
        completedOrders: 0,
        afterSaleCases: 0,
        successFulfillmentCount: 0,
        manualReviewCount: 0,
        deliveryHoursTotal: 0,
        deliveryHoursCount: 0,
      };
      storeRow.orderCount += 1;
      storeRow.salesAmount += row.receivedAmount;
      storeRow.refundAmount += row.refundAmount;
      storeRow.netSalesAmount += netSalesAmount;
      storeRow.grossProfit += grossProfit;
      storeRow.completedOrders += row.orderStatus === 'completed' ? 1 : 0;
      storeRow.afterSaleCases += caseCountByOrderId.get(row.id) ?? 0;
      storeRow.successFulfillmentCount += row.fulfillmentQueue === 'success' ? 1 : 0;
      storeRow.manualReviewCount += row.fulfillmentQueue === 'manual_review' ? 1 : 0;
      if (row.deliveryHours > 0) {
        storeRow.deliveryHoursTotal += row.deliveryHours;
        storeRow.deliveryHoursCount += 1;
      }
      storeMap.set(row.storeId, storeRow);

      const productRow = productMap.get(row.productId) ?? {
        productId: row.productId,
        productName: row.productName,
        productSku: row.productSku,
        storeName: row.storeName,
        category: row.category,
        orderCount: 0,
        soldQuantity: 0,
        salesAmount: 0,
        refundAmount: 0,
        netSalesAmount: 0,
        grossProfit: 0,
        afterSaleCases: 0,
        successFulfillmentCount: 0,
      };
      productRow.orderCount += 1;
      productRow.soldQuantity += row.quantity;
      productRow.salesAmount += row.receivedAmount;
      productRow.refundAmount += row.refundAmount;
      productRow.netSalesAmount += netSalesAmount;
      productRow.grossProfit += grossProfit;
      productRow.afterSaleCases += caseCountByOrderId.get(row.id) ?? 0;
      productRow.successFulfillmentCount += row.fulfillmentQueue === 'success' ? 1 : 0;
      productMap.set(row.productId, productRow);

      const sourceKey = row.source || 'unknown';
      const sourceRow = sourceMap.get(sourceKey) ?? { source: sourceKey, orderCount: 0, salesAmount: 0 };
      sourceRow.orderCount += 1;
      sourceRow.salesAmount += row.receivedAmount;
      sourceMap.set(sourceKey, sourceRow);

      const statusRow = mainStatusMap.get(row.mainStatus) ?? {
        status: row.mainStatus,
        label: getOrderMainStatusText(row.mainStatus),
        orderCount: 0,
      };
      statusRow.orderCount += 1;
      mainStatusMap.set(row.mainStatus, statusRow);

      const fulfillmentRow = fulfillmentMap.get(row.fulfillmentQueue) ?? {
        queue: row.fulfillmentQueue,
        label: getOrderFulfillmentQueueText(row.fulfillmentQueue),
        orderCount: 0,
      };
      fulfillmentRow.orderCount += 1;
      fulfillmentMap.set(row.fulfillmentQueue, fulfillmentRow);

      const trendRow = trendMap.get(reportDate);
      if (trendRow) {
        trendRow.grossAmount += row.grossAmount;
        trendRow.receivedAmount += row.receivedAmount;
        trendRow.refundAmount += row.refundAmount;
        trendRow.netProfit += grossProfit;
        trendRow.orderCount += 1;
      }
    });

    const typeMap = new Map<string, {
      caseType: string;
      caseTypeText: string;
      caseCount: number;
      resolvedCount: number;
      timeoutCount: number;
      refundAmount: number;
      compensationAmount: number;
    }>();
    const caseStatusMap = new Map<string, {
      caseStatus: string;
      caseStatusText: string;
      caseCount: number;
    }>();

    cases.forEach((row) => {
      const reportDate = row.createdAt.slice(0, 10);
      const timeout = isTimeoutAfterSaleCase(row.caseStatus, row.deadlineAt, nowText);

      const typeRow = typeMap.get(row.caseType) ?? {
        caseType: row.caseType,
        caseTypeText: getAfterSaleCaseTypeText(row.caseType),
        caseCount: 0,
        resolvedCount: 0,
        timeoutCount: 0,
        refundAmount: 0,
        compensationAmount: 0,
      };
      typeRow.caseCount += 1;
      typeRow.resolvedCount += row.caseStatus === 'resolved' ? 1 : 0;
      typeRow.timeoutCount += timeout ? 1 : 0;
      typeRow.refundAmount += Number(row.approvedAmount ?? row.requestedAmount ?? 0);
      typeRow.compensationAmount += Number(row.compensationAmount ?? 0);
      typeMap.set(row.caseType, typeRow);

      const statusRow = caseStatusMap.get(row.caseStatus) ?? {
        caseStatus: row.caseStatus,
        caseStatusText: getAfterSaleCaseStatusText(row.caseStatus),
        caseCount: 0,
      };
      statusRow.caseCount += 1;
      caseStatusMap.set(row.caseStatus, statusRow);

      const trendRow = trendMap.get(reportDate);
      if (trendRow) {
        trendRow.afterSaleCaseCount += 1;
        trendRow.netProfit -= Number(row.compensationAmount ?? 0);
      }
    });

    const totalAfterSaleCases = cases.length;
    const timeoutCases = cases.filter((row) => isTimeoutAfterSaleCase(row.caseStatus, row.deadlineAt, nowText)).length;
    const pendingCases = cases.filter((row) =>
      ['pending_review', 'processing', 'waiting_execute'].includes(row.caseStatus),
    ).length;
    const resolvedCases = cases.filter((row) => row.caseStatus === 'resolved').length;
    const rejectedCases = cases.filter((row) => row.caseStatus === 'rejected').length;
    const successFulfillmentCount = orders.filter((row) => row.fulfillmentQueue === 'success').length;
    const manualReviewCount = orders.filter((row) => row.fulfillmentQueue === 'manual_review').length;

    return {
      metrics,
      storeStats: Array.from(storeMap.values())
        .map((row) => ({
          storeId: row.storeId,
          storeName: row.storeName,
          orderCount: row.orderCount,
          salesAmount: Number(row.salesAmount.toFixed(2)),
          refundAmount: Number(row.refundAmount.toFixed(2)),
          netSalesAmount: Number(row.netSalesAmount.toFixed(2)),
          grossProfit: Number(row.grossProfit.toFixed(2)),
          grossMargin: row.netSalesAmount === 0 ? 0 : toPercentage((row.grossProfit / row.netSalesAmount) * 100),
          completedOrders: row.completedOrders,
          afterSaleCases: row.afterSaleCases,
          successFulfillmentCount: row.successFulfillmentCount,
          manualReviewCount: row.manualReviewCount,
          successFulfillmentRate: row.orderCount === 0 ? 0 : toPercentage((row.successFulfillmentCount / row.orderCount) * 100),
          averageDeliveryHours:
            row.deliveryHoursCount === 0 ? 0 : Number((row.deliveryHoursTotal / row.deliveryHoursCount).toFixed(2)),
        }))
        .sort((left, right) => right.netSalesAmount - left.netSalesAmount),
      productStats: Array.from(productMap.values())
        .map((row) => ({
          productId: row.productId,
          productName: row.productName,
          productSku: row.productSku,
          storeName: row.storeName,
          category: row.category,
          orderCount: row.orderCount,
          soldQuantity: row.soldQuantity,
          salesAmount: Number(row.salesAmount.toFixed(2)),
          refundAmount: Number(row.refundAmount.toFixed(2)),
          netSalesAmount: Number(row.netSalesAmount.toFixed(2)),
          grossProfit: Number(row.grossProfit.toFixed(2)),
          grossMargin: row.netSalesAmount === 0 ? 0 : toPercentage((row.grossProfit / row.netSalesAmount) * 100),
          afterSaleCases: row.afterSaleCases,
          successFulfillmentRate: row.orderCount === 0 ? 0 : toPercentage((row.successFulfillmentCount / row.orderCount) * 100),
        }))
        .sort((left, right) => right.netSalesAmount - left.netSalesAmount),
      orderStats: {
        overview: [
          { key: 'totalOrders', label: '订单总数', value: orders.length, unit: '单', description: '按支付时间命中过滤条件的订单总量。' },
          {
            key: 'completedOrders',
            label: '已完成订单',
            value: orders.filter((row) => row.orderStatus === 'completed').length,
            unit: '单',
            description: '订单状态为已完成，用于复盘闭环订单规模。',
          },
          {
            key: 'afterSaleOrders',
            label: '售后订单',
            value: orders.filter((row) => row.afterSaleStatus !== 'none').length,
            unit: '单',
            description: '订单主线已产生售后处理的订单数。',
          },
          {
            key: 'refundOrders',
            label: '退款订单',
            value: orders.filter((row) => row.refundAmount > 0).length,
            unit: '单',
            description: '订单已回写退款金额的订单数。',
          },
          {
            key: 'successFulfillmentRate',
            label: '履约成功率',
            value: orders.length === 0 ? 0 : toPercentage((successFulfillmentCount / orders.length) * 100),
            unit: '%',
            description: '来自统一履约队列，成功单数 / 订单总数。',
          },
          {
            key: 'manualReviewCount',
            label: '人工处理单',
            value: manualReviewCount,
            unit: '单',
            description: '履约队列落到人工处理的订单数。',
          },
          {
            key: 'averageDeliveryHours',
            label: '平均发货时长',
            value: metrics.averageDeliveryHours,
            unit: '小时',
            description: '仅统计已写入 delivery_hours 的订单。',
          },
        ],
        statusDistribution: Array.from(mainStatusMap.values()).sort((left, right) => right.orderCount - left.orderCount),
        sourceDistribution: Array.from(sourceMap.values())
          .map((row) => ({
            source: row.source,
            orderCount: row.orderCount,
            salesAmount: Number(row.salesAmount.toFixed(2)),
          }))
          .sort((left, right) => right.salesAmount - left.salesAmount),
        fulfillmentDistribution: Array.from(fulfillmentMap.values()).sort((left, right) => right.orderCount - left.orderCount),
      },
      afterSaleStats: {
        overview: [
          { key: 'totalCases', label: '售后总单量', value: totalAfterSaleCases, unit: '单', description: '售后主单 after_sale_cases 的过滤结果。' },
          { key: 'pendingCases', label: '处理中售后', value: pendingCases, unit: '单', description: '包含待审核、处理中、待执行三类开放状态。' },
          { key: 'resolvedCases', label: '已完结售后', value: resolvedCases, unit: '单', description: 'case_status = resolved。' },
          { key: 'rejectedCases', label: '已驳回售后', value: rejectedCases, unit: '单', description: 'case_status = rejected。' },
          { key: 'timeoutCases', label: '超时售后', value: timeoutCases, unit: '单', description: '当前时间超过 SLA 且未完结的售后。' },
          {
            key: 'refundAmount',
            label: '退款金额',
            value: metrics.refundAmount,
            unit: 'CNY',
            description: '回写到订单主线的退款金额，用于和订单口径保持一致。',
          },
          {
            key: 'resolvedRate',
            label: '售后完结率',
            value: totalAfterSaleCases === 0 ? 0 : toPercentage((resolvedCases / totalAfterSaleCases) * 100),
            unit: '%',
            description: '已完结售后 / 售后总单量。',
          },
        ],
        typeDistribution: Array.from(typeMap.values())
          .map((row) => ({
            ...row,
            caseType:
              row.caseType as BusinessReportsResponse['afterSaleStats']['typeDistribution'][number]['caseType'],
            refundAmount: Number(row.refundAmount.toFixed(2)),
            compensationAmount: Number(row.compensationAmount.toFixed(2)),
          }))
          .sort((left, right) => right.caseCount - left.caseCount),
        statusDistribution: Array.from(caseStatusMap.values())
          .map((row) => ({
            ...row,
            caseStatus:
              row.caseStatus as BusinessReportsResponse['afterSaleStats']['statusDistribution'][number]['caseStatus'],
          }))
          .sort((left, right) => right.caseCount - left.caseCount),
      },
      trend: Array.from(trendMap.values())
        .sort((left, right) => left.reportDate.localeCompare(right.reportDate))
        .map((row) => ({
          reportDate: row.reportDate,
          grossAmount: Number(row.grossAmount.toFixed(2)),
          receivedAmount: Number(row.receivedAmount.toFixed(2)),
          refundAmount: Number(row.refundAmount.toFixed(2)),
          netProfit: Number(row.netProfit.toFixed(2)),
          orderCount: row.orderCount,
          afterSaleCaseCount: row.afterSaleCaseCount,
        })),
    };
  }

  private async getBusinessReportOrderRows(filters: QueryFilters, range: DateRange): Promise<ReportOrderRow[]> {
    const { whereSql, values } = buildOrderFilter(filters, range);
    const result = await this.pool.query(
      `
        SELECT
          o.id,
          o.order_no AS "orderNo",
          o.store_id AS "storeId",
          COALESCE(s.name, '未命名店铺') AS "storeName",
          o.product_id AS "productId",
          COALESCE(p.name, '未命名商品') AS "productName",
          COALESCE(p.sku, '') AS "productSku",
          COALESCE(p.category, '') AS category,
          COALESCE(o.source, 'unknown') AS source,
          o.quantity,
          o.paid_amount AS "paidAmount",
          o.refund_amount AS "refundAmount",
          COALESCE(op."grossAmount", o.paid_amount + o.discount_amount) AS "grossAmount",
          COALESCE(op."discountAmount", o.discount_amount) AS "discountAmount",
          COALESCE(op."receivedAmount", o.paid_amount) AS "receivedAmount",
          COALESCE(op."paymentCount", 0) AS "paymentCount",
          COALESCE(p.cost, 0) AS "unitCost",
          o.main_status AS "mainStatus",
          o.payment_status AS "paymentStatus",
          o.delivery_status AS "deliveryStatus",
          o.order_status AS "orderStatus",
          o.after_sale_status AS "afterSaleStatus",
          o.paid_at AS "paidAt",
          o.completed_at AS "completedAt",
          COALESCE(o.delivery_hours, 0) AS "deliveryHours",
          COALESCE(o.is_new_customer, 0) AS "isNewCustomer",
          CASE
            WHEN dci.id IS NOT NULL THEN 'direct_charge'
            WHEN cdi.id IS NOT NULL THEN 'card'
            ELSE 'standard'
          END AS "fulfillmentType",
          CASE
            WHEN o.delivery_status = 'manual_review' THEN 'manual_review'
            WHEN o.order_status IN ('closed', 'cancelled') THEN 'failed'
            WHEN o.main_status IN ('fulfilled', 'completed') OR o.order_status = 'completed' OR o.delivery_status = 'delivered' THEN 'success'
            WHEN o.main_status = 'processing' OR o.delivery_status = 'shipped' THEN 'processing'
            ELSE 'pending'
          END AS "fulfillmentQueue"
        FROM orders o
        LEFT JOIN products p ON p.id = o.product_id
        LEFT JOIN stores s ON s.id = o.store_id
        LEFT JOIN customers c ON c.id = o.customer_id
        LEFT JOIN (
          SELECT
            order_id,
            SUM(gross_amount) AS "grossAmount",
            SUM(discount_amount) AS "discountAmount",
            SUM(paid_amount) AS "receivedAmount",
            COUNT(*) AS "paymentCount"
          FROM order_payments
          GROUP BY order_id
        ) op ON op.order_id = o.id
        LEFT JOIN (
          SELECT product_id, MIN(id) AS id
          FROM card_delivery_items
          GROUP BY product_id
        ) cdi ON cdi.product_id = o.product_id
        LEFT JOIN (
          SELECT product_id, MIN(id) AS id
          FROM direct_charge_items
          GROUP BY product_id
        ) dci ON dci.product_id = o.product_id
        ${whereSql}
        ORDER BY o.paid_at ASC, o.id ASC
      `,
      values,
    );

    return result.rows.map((row) => ({
      id: toNumber(row.id),
      orderNo: String(row.orderNo ?? ''),
      storeId: toNumber(row.storeId),
      storeName: String(row.storeName ?? ''),
      productId: toNumber(row.productId),
      productName: String(row.productName ?? ''),
      productSku: String(row.productSku ?? ''),
      category: String(row.category ?? ''),
      source: String(row.source ?? 'unknown'),
      quantity: toNumber(row.quantity),
      paidAmount: toNumber(row.paidAmount, 2),
      refundAmount: toNumber(row.refundAmount, 2),
      grossAmount: toNumber(row.grossAmount, 2),
      discountAmount: toNumber(row.discountAmount, 2),
      receivedAmount: toNumber(row.receivedAmount, 2),
      paymentCount: toNumber(row.paymentCount),
      unitCost: toNumber(row.unitCost, 2),
      mainStatus: String(row.mainStatus ?? ''),
      paymentStatus: String(row.paymentStatus ?? ''),
      deliveryStatus: String(row.deliveryStatus ?? ''),
      orderStatus: String(row.orderStatus ?? ''),
      afterSaleStatus: String(row.afterSaleStatus ?? ''),
      paidAt: String(row.paidAt ?? ''),
      completedAt: row.completedAt ? String(row.completedAt) : null,
      deliveryHours: toNumber(row.deliveryHours, 2),
      isNewCustomer: toNumber(row.isNewCustomer),
      fulfillmentType: String(row.fulfillmentType ?? 'standard'),
      fulfillmentQueue: String(row.fulfillmentQueue ?? 'pending'),
    }));
  }

  private async getBusinessReportCaseRows(filters: QueryFilters, range: DateRange): Promise<ReportCaseRow[]> {
    const { whereSql, values } = buildAfterSaleFilter(filters, range);
    const result = await this.pool.query(
      `
        SELECT
          ac.id AS "caseId",
          ac.case_no AS "caseNo",
          ac.order_id AS "orderId",
          o.order_no AS "orderNo",
          o.store_id AS "storeId",
          COALESCE(s.name, '未命名店铺') AS "storeName",
          o.product_id AS "productId",
          COALESCE(p.name, '未命名商品') AS "productName",
          COALESCE(p.category, '') AS category,
          ac.case_type AS "caseType",
          ac.case_status AS "caseStatus",
          ac.priority,
          ac.latest_result AS "latestResult",
          ac.created_at AS "createdAt",
          ac.sla_deadline_at AS "deadlineAt",
          rf.refund_status AS "refundStatus",
          rf.requested_amount AS "requestedAmount",
          rf.approved_amount AS "approvedAmount",
          rs.resend_status AS "resendStatus",
          ad.dispute_status AS "disputeStatus",
          ad.compensation_amount AS "compensationAmount"
        FROM after_sale_cases ac
        INNER JOIN orders o ON o.id = ac.order_id
        LEFT JOIN stores s ON s.id = o.store_id
        LEFT JOIN products p ON p.id = o.product_id
        LEFT JOIN customers c ON c.id = o.customer_id
        LEFT JOIN after_sale_refunds rf ON rf.case_id = ac.id
        LEFT JOIN after_sale_resends rs ON rs.case_id = ac.id
        LEFT JOIN after_sale_disputes ad ON ad.case_id = ac.id
        ${whereSql}
        ORDER BY ac.created_at ASC, ac.id ASC
      `,
      values,
    );

    return result.rows.map((row) => ({
      caseId: toNumber(row.caseId),
      caseNo: String(row.caseNo ?? ''),
      orderId: toNumber(row.orderId),
      orderNo: String(row.orderNo ?? ''),
      storeId: toNumber(row.storeId),
      storeName: String(row.storeName ?? ''),
      productId: toNumber(row.productId),
      productName: String(row.productName ?? ''),
      category: String(row.category ?? ''),
      caseType: String(row.caseType ?? ''),
      caseStatus: String(row.caseStatus ?? ''),
      priority: String(row.priority ?? ''),
      latestResult: row.latestResult ? String(row.latestResult) : null,
      createdAt: String(row.createdAt ?? ''),
      deadlineAt: String(row.deadlineAt ?? ''),
      refundStatus: row.refundStatus ? String(row.refundStatus) : null,
      requestedAmount: row.requestedAmount == null ? null : toNumber(row.requestedAmount, 2),
      approvedAmount: row.approvedAmount == null ? null : toNumber(row.approvedAmount, 2),
      resendStatus: row.resendStatus ? String(row.resendStatus) : null,
      disputeStatus: row.disputeStatus ? String(row.disputeStatus) : null,
      compensationAmount: row.compensationAmount == null ? null : toNumber(row.compensationAmount, 2),
    }));
  }

  private summarizeBusinessReportMetrics(orders: ReportOrderRow[], cases: ReportCaseRow[]): MetricSummary {
    const grossAmount = orders.reduce((sum, row) => sum + row.grossAmount, 0);
    const receivedAmount = orders.reduce((sum, row) => sum + row.receivedAmount, 0);
    const discountAmount = orders.reduce((sum, row) => sum + row.discountAmount, 0);
    const refundAmount = orders.reduce((sum, row) => sum + row.refundAmount, 0);
    const costAmount = orders.reduce((sum, row) => sum + row.unitCost * row.quantity, 0);
    const compensationAmount = cases.reduce((sum, row) => sum + Number(row.compensationAmount ?? 0), 0);
    const netSalesAmount = receivedAmount - refundAmount;
    const grossProfit = netSalesAmount - costAmount;
    const deliveryRows = orders.filter((row) => row.deliveryHours > 0);

    return {
      grossAmount: Number(grossAmount.toFixed(2)),
      receivedAmount: Number(receivedAmount.toFixed(2)),
      discountAmount: Number(discountAmount.toFixed(2)),
      salesAmount: Number(receivedAmount.toFixed(2)),
      orderCount: orders.length,
      averageOrderValue: orders.length === 0 ? 0 : Number((receivedAmount / orders.length).toFixed(2)),
      refundAmount: Number(refundAmount.toFixed(2)),
      newCustomerCount: orders.reduce((sum, row) => sum + Number(row.isNewCustomer ?? 0), 0),
      costAmount: Number(costAmount.toFixed(2)),
      compensationAmount: Number(compensationAmount.toFixed(2)),
      grossProfit: Number(grossProfit.toFixed(2)),
      grossMargin: netSalesAmount === 0 ? 0 : toPercentage((grossProfit / netSalesAmount) * 100),
      netProfit: Number((grossProfit - compensationAmount).toFixed(2)),
      paymentCount: orders.reduce((sum, row) => sum + row.paymentCount, 0),
      averageDeliveryHours:
        deliveryRows.length === 0
          ? 0
          : Number((deliveryRows.reduce((sum, row) => sum + row.deliveryHours, 0) / deliveryRows.length).toFixed(2)),
    };
  }

  private async getMetricSummary(filters: QueryFilters): Promise<MetricSummary> {
    const range = resolveDateRange(filters);
    const { whereSql, values } = buildOrderFilter(filters, range);
    const orderSummary = await this.pool.query(
      `
        SELECT
          SUM(o.paid_amount) AS "salesAmount",
          COUNT(*) AS "orderCount",
          AVG(o.paid_amount) AS "averageOrderValue",
          SUM(o.refund_amount) AS "refundAmount",
          SUM(CASE WHEN o.is_new_customer = 1 THEN 1 ELSE 0 END) AS "newCustomerCount",
          SUM(COALESCE(p.cost, 0) * o.quantity) AS "costAmount",
          AVG(NULLIF(o.delivery_hours, 0)) AS "averageDeliveryHours"
        FROM orders o
        LEFT JOIN products p ON p.id = o.product_id
        LEFT JOIN customers c ON c.id = o.customer_id
        ${whereSql}
      `,
      values,
    );
    const paymentSummary = await this.pool.query(
      `
        SELECT
          SUM(op.gross_amount) AS "grossAmount",
          SUM(op.discount_amount) AS "discountAmount",
          SUM(op.paid_amount) AS "receivedAmount",
          COUNT(op.id) AS "paymentCount"
        FROM order_payments op
        INNER JOIN orders o ON o.id = op.order_id
        LEFT JOIN products p ON p.id = o.product_id
        LEFT JOIN customers c ON c.id = o.customer_id
        ${whereSql}
      `,
      values,
    );
    const afterSaleSummary = await this.pool.query(
      `
        SELECT
          SUM(COALESCE(ad.compensation_amount, 0)) AS "compensationAmount"
        FROM after_sale_cases ac
        INNER JOIN orders o ON o.id = ac.order_id
        LEFT JOIN products p ON p.id = o.product_id
        LEFT JOIN customers c ON c.id = o.customer_id
        LEFT JOIN after_sale_disputes ad ON ad.case_id = ac.id
        ${whereSql}
      `,
      values,
    );

    const orderRow = orderSummary.rows[0] ?? {};
    const paymentRow = paymentSummary.rows[0] ?? {};
    const afterSaleRow = afterSaleSummary.rows[0] ?? {};

    const receivedAmount = toNumber(paymentRow.receivedAmount ?? orderRow.salesAmount, 2);
    const refundAmount = toNumber(orderRow.refundAmount, 2);
    const costAmount = toNumber(orderRow.costAmount, 2);
    const compensationAmount = toNumber(afterSaleRow.compensationAmount, 2);
    const grossProfit = toNumber(receivedAmount - refundAmount - costAmount, 2);
    const netProfit = toNumber(grossProfit - compensationAmount, 2);
    const grossMargin = receivedAmount > 0 ? toPercentage((grossProfit / receivedAmount) * 100) : 0;

    return {
      grossAmount: toNumber(paymentRow.grossAmount ?? receivedAmount, 2),
      receivedAmount,
      discountAmount: toNumber(paymentRow.discountAmount, 2),
      salesAmount: toNumber(orderRow.salesAmount, 2),
      orderCount: toNumber(orderRow.orderCount),
      averageOrderValue: toNumber(orderRow.averageOrderValue, 2),
      averageDeliveryHours: toNumber(orderRow.averageDeliveryHours, 2),
      refundAmount,
      newCustomerCount: toNumber(orderRow.newCustomerCount),
      costAmount,
      compensationAmount,
      grossProfit,
      grossMargin,
      netProfit,
      paymentCount: toNumber(paymentRow.paymentCount),
    };
  }

  private async getTrend(filters: QueryFilters) {
    const range = resolveDateRange(filters);
    const { whereSql, values } = buildOrderFilter(filters, range);
    const result = await this.pool.query(
      `
        SELECT
          substring(o.paid_at, 1, 10) AS "reportDate",
          SUM(o.paid_amount) AS "salesAmount",
          COUNT(*) AS "orderCount",
          SUM(o.refund_amount) AS "refundAmount"
        FROM orders o
        LEFT JOIN products p ON p.id = o.product_id
        LEFT JOIN customers c ON c.id = o.customer_id
        ${whereSql}
        GROUP BY substring(o.paid_at, 1, 10)
        ORDER BY "reportDate" ASC
      `,
      values,
    );
    return result.rows.map((row) => ({
      reportDate: String(row.reportDate),
      salesAmount: toNumber(row.salesAmount, 2),
      orderCount: toNumber(row.orderCount),
      refundAmount: toNumber(row.refundAmount, 2),
    }));
  }

  private async getSourceDistribution(filters: QueryFilters) {
    const range = resolveDateRange(filters);
    const { whereSql, values } = buildOrderFilter(filters, range);
    const result = await this.pool.query(
      `
        SELECT
          o.source AS source,
          COUNT(*) AS "orderCount",
          SUM(o.paid_amount) AS "salesAmount"
        FROM orders o
        LEFT JOIN products p ON p.id = o.product_id
        LEFT JOIN customers c ON c.id = o.customer_id
        ${whereSql}
        GROUP BY o.source
        ORDER BY COUNT(*) DESC, o.source ASC
      `,
      values,
    );
    return result.rows.map((row) => ({
      source: String(row.source ?? 'unknown'),
      orderCount: toNumber(row.orderCount),
      salesAmount: toNumber(row.salesAmount, 2),
    }));
  }

  private async getOrderStatusDistribution(filters: QueryFilters) {
    const range = resolveDateRange(filters);
    const { whereSql, values } = buildOrderFilter(filters, range);
    const result = await this.pool.query(
      `
        SELECT
          o.order_status AS status,
          COUNT(*) AS "orderCount"
        FROM orders o
        LEFT JOIN products p ON p.id = o.product_id
        LEFT JOIN customers c ON c.id = o.customer_id
        ${whereSql}
        GROUP BY o.order_status
        ORDER BY COUNT(*) DESC, o.order_status ASC
      `,
      values,
    );
    return result.rows.map((row) => ({
      status: String(row.status ?? 'unknown'),
      orderCount: toNumber(row.orderCount),
    }));
  }

  private async getTopProducts(filters: QueryFilters) {
    const range = resolveDateRange(filters);
    const { whereSql, values } = buildOrderFilter(filters, range);
    const result = await this.pool.query(
      `
        SELECT
          COALESCE(p.name, '未命名商品') AS name,
          COALESCE(s.name, '未命名店铺') AS "storeName",
          COALESCE(p.category, '') AS category,
          SUM(o.quantity) AS "soldQuantity",
          SUM(o.paid_amount) AS "salesAmount",
          SUM(o.refund_amount) AS "refundAmount"
        FROM orders o
        LEFT JOIN products p ON p.id = o.product_id
        LEFT JOIN stores s ON s.id = o.store_id
        LEFT JOIN customers c ON c.id = o.customer_id
        ${whereSql}
        GROUP BY p.id, p.name, s.name, p.category
        ORDER BY SUM(o.paid_amount) DESC, SUM(o.quantity) DESC, p.name ASC
        LIMIT 6
      `,
      values,
    );
    return result.rows.map((row) => ({
      name: String(row.name),
      storeName: String(row.storeName),
      category: String(row.category ?? ''),
      soldQuantity: toNumber(row.soldQuantity),
      salesAmount: toNumber(row.salesAmount, 2),
      refundAmount: toNumber(row.refundAmount, 2),
    }));
  }

  async createFundWithdrawal(input: {
    featureKey: string;
    amount: number;
    storeId?: number;
    method: string;
    receivingAccount: string;
  }) {
    if (input.featureKey !== 'fund-withdrawals') {
      return null;
    }

    const amount = Number(input.amount.toFixed(2));
    if (amount <= 0) {
      return null;
    }

    const now = format(new Date(), 'yyyy-MM-dd HH:mm:ss');
    const serial = now.replace(/[-:\s]/g, '').slice(0, 12);
    const fee = Number(Math.max(2, amount * 0.015).toFixed(2));
    const arrivalAmount = Number(Math.max(0, amount - fee).toFixed(2));
    if (arrivalAmount <= 0) {
      return null;
    }

    const client = await this.pool.connect();
    let transactionOpen = false;
    try {
      await client.query('BEGIN');
      transactionOpen = true;

      const accountResult = await client.query(
        `
          SELECT
            id,
            available_balance AS "availableBalance",
            pending_withdrawal AS "pendingWithdrawal"
          FROM fund_accounts
          ORDER BY id
          LIMIT 1
        `,
      );
      const account = accountResult.rows[0] as
        | { id: number; availableBalance: number; pendingWithdrawal: number }
        | undefined;
      if (!account || amount > Number(account.availableBalance ?? 0)) {
        await client.query('ROLLBACK');
        transactionOpen = false;
        return null;
      }

      const nextId = await this.nextTableId(client, 'fund_withdrawals');
      const availableBalance = Number((Number(account.availableBalance ?? 0) - amount).toFixed(2));
      const pendingWithdrawal = Number((Number(account.pendingWithdrawal ?? 0) + amount).toFixed(2));

      await client.query(
        `
          INSERT INTO fund_withdrawals (
            id,
            withdrawal_no,
            trade_time,
            trade_no,
            store_id,
            trade_type,
            amount,
            fee,
            arrival_amount,
            available_balance,
            status,
            method,
            receiving_account,
            review_remark
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'pending', $11, $12, $13)
        `,
        [
          nextId,
          `TX${serial}${String(nextId).padStart(3, '0')}`,
          now,
          `CAP${serial}${String(nextId).padStart(3, '0')}`,
          input.storeId ?? null,
          '余额提现',
          amount,
          fee,
          arrivalAmount,
          availableBalance,
          input.method,
          input.receivingAccount,
          '已提交提现申请，等待财务审核。',
        ],
      );

      await client.query(
        `
          UPDATE fund_accounts
          SET
            available_balance = $1,
            pending_withdrawal = $2,
            updated_at = $3
          WHERE id = $4
        `,
        [availableBalance, pendingWithdrawal, now, account.id],
      );

      await this.insertWorkspaceLog(
        client,
        input.featureKey,
        'withdrawal',
        '新增提现申请',
        `提现 ${amount.toFixed(2)} 元已进入审核队列。`,
        now,
      );
      await this.touchWorkspace(client, input.featureKey, now);
      await this.touchWorkspace(client, 'fund-accounts', now);
      await this.upsertFundReconciliation(client, {
        refType: 'withdrawal',
        refId: nextId,
        storeId: input.storeId ?? null,
        billCategory: 'withdrawal',
        platformAmount: 0,
        ledgerAmount: arrivalAmount,
        note: '提现待审核完成后对平。',
        updatedAt: now,
      });
      if (fee > 0) {
        await this.upsertFundReconciliation(client, {
          refType: 'withdrawal_fee',
          refId: nextId,
          storeId: input.storeId ?? null,
          billCategory: 'fee',
          platformAmount: 0,
          ledgerAmount: fee,
          note: '提现手续费待审核完成后确认。',
          updatedAt: now,
        });
      }

      await client.query('COMMIT');
      transactionOpen = false;
      return {
        success: true,
        status: 'pending' as const,
      };
    } catch (error) {
      if (transactionOpen) {
        await client.query('ROLLBACK');
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async updateFundWithdrawalStatus(
    featureKey: string,
    withdrawalId: number,
    status: 'pending' | 'paid' | 'rejected',
  ) {
    if (featureKey !== 'fund-withdrawals') {
      return null;
    }

    const client = await this.pool.connect();
    let transactionOpen = false;
    try {
      await client.query('BEGIN');
      transactionOpen = true;

      const withdrawalResult = await client.query(
        `
          SELECT
            id,
            withdrawal_no AS "withdrawalNo",
            store_id AS "storeId",
            amount,
            fee,
            arrival_amount AS "arrivalAmount",
            trade_time AS "tradeTime",
            method,
            status
          FROM fund_withdrawals
          WHERE id = $1
        `,
        [withdrawalId],
      );
      const row = withdrawalResult.rows[0] as
        | {
            id: number;
            withdrawalNo: string;
            storeId: number | null;
            amount: number;
            fee: number;
            arrivalAmount: number;
            tradeTime: string;
            method: string;
            status: 'pending' | 'paid' | 'rejected';
          }
        | undefined;
      if (!row) {
        await client.query('ROLLBACK');
        transactionOpen = false;
        return null;
      }
      if (row.status === status) {
        await client.query('ROLLBACK');
        transactionOpen = false;
        return { status };
      }

      const now = format(new Date(), 'yyyy-MM-dd HH:mm:ss');
      const accountResult = await client.query(
        `
          SELECT
            id,
            available_balance AS "availableBalance",
            pending_withdrawal AS "pendingWithdrawal",
            total_paid_out AS "totalPaidOut"
          FROM fund_accounts
          ORDER BY id
          LIMIT 1
        `,
      );
      const account = accountResult.rows[0] as
        | {
            id: number;
            availableBalance: number;
            pendingWithdrawal: number;
            totalPaidOut: number;
          }
        | undefined;

      await client.query(
        `
          UPDATE fund_withdrawals
          SET status = $1, review_remark = $2
          WHERE id = $3
        `,
        [
          status,
          status === 'paid'
            ? '财务已放款，等待收款账户回执。'
            : status === 'rejected'
              ? '已驳回并释放冻结金额。'
              : '已重新回到待审核队列。',
          withdrawalId,
        ],
      );

      if (account) {
        let nextAvailable = Number(account.availableBalance ?? 0);
        let nextPending = Number(account.pendingWithdrawal ?? 0);
        let nextTotalPaidOut = Number(account.totalPaidOut ?? 0);

        if (row.status === 'pending') {
          nextPending = Math.max(0, Number((nextPending - Number(row.amount ?? 0)).toFixed(2)));
        } else if (row.status === 'rejected') {
          nextAvailable = Number((nextAvailable - Number(row.amount ?? 0)).toFixed(2));
        } else if (row.status === 'paid') {
          nextTotalPaidOut = Number(
            (nextTotalPaidOut - Number(row.arrivalAmount ?? 0)).toFixed(2),
          );
        }

        if (status === 'pending') {
          nextPending = Number((nextPending + Number(row.amount ?? 0)).toFixed(2));
        } else if (status === 'rejected') {
          nextAvailable = Number((nextAvailable + Number(row.amount ?? 0)).toFixed(2));
        } else if (status === 'paid') {
          nextTotalPaidOut = Number(
            (nextTotalPaidOut + Number(row.arrivalAmount ?? 0)).toFixed(2),
          );
        }

        await client.query(
          `
            UPDATE fund_accounts
            SET
              available_balance = $1,
              pending_withdrawal = $2,
              total_paid_out = $3,
              updated_at = $4
            WHERE id = $5
          `,
          [nextAvailable, nextPending, nextTotalPaidOut, now, account.id],
        );
      }

      const statusLabel =
        {
          pending: '审核中',
          paid: '已完成',
          rejected: '已拒绝',
        }[status] ?? status;

      await this.insertWorkspaceLog(
        client,
        featureKey,
        'withdrawal',
        `${row.withdrawalNo}状态已更新`,
        `提现状态已切换为${statusLabel}。`,
        now,
      );
      await this.touchWorkspace(client, featureKey, now);
      await this.touchWorkspace(client, 'fund-accounts', now);
      await this.touchWorkspace(client, 'fund-bills', now);
      await this.upsertFundReconciliation(client, {
        refType: 'withdrawal',
        refId: withdrawalId,
        storeId: row.storeId,
        billCategory: 'withdrawal',
        platformAmount: status === 'paid' ? Number(row.arrivalAmount ?? 0) : 0,
        ledgerAmount: status === 'rejected' ? 0 : Number(row.arrivalAmount ?? 0),
        note:
          status === 'paid'
            ? '提现打款已完成。'
            : status === 'rejected'
              ? '提现已驳回，无需出账。'
              : '提现待审核完成后对平。',
        updatedAt: row.tradeTime,
      });
      if (Number(row.fee ?? 0) > 0) {
        await this.upsertFundReconciliation(client, {
          refType: 'withdrawal_fee',
          refId: withdrawalId,
          storeId: row.storeId,
          billCategory: 'fee',
          platformAmount: status === 'paid' ? Number(row.fee ?? 0) : 0,
          ledgerAmount: status === 'rejected' ? 0 : Number(row.fee ?? 0),
          note:
            status === 'paid'
              ? '提现手续费已完成记账。'
              : status === 'rejected'
                ? '提现已驳回，手续费不再生效。'
                : '提现手续费待审核完成后确认。',
          updatedAt: row.tradeTime,
        });
      }

      await client.query('COMMIT');
      transactionOpen = false;
      return { status };
    } catch (error) {
      if (transactionOpen) {
        await client.query('ROLLBACK');
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async updateFundReconciliationStatus(
    featureKey: string,
    reconciliationId: number,
    status: 'matched' | 'anomaly' | 'reviewed',
    note?: string,
  ) {
    if (!['fund-accounts', 'fund-bills'].includes(featureKey)) {
      return null;
    }

    const client = await this.pool.connect();
    let transactionOpen = false;
    try {
      await client.query('BEGIN');
      transactionOpen = true;

      const rowResult = await client.query(
        `
          SELECT
            id,
            reconcile_no AS "reconcileNo",
            note
          FROM fund_reconciliations
          WHERE id = $1
        `,
        [reconciliationId],
      );
      const row = rowResult.rows[0] as { id: number; reconcileNo: string; note: string } | undefined;
      if (!row) {
        await client.query('ROLLBACK');
        transactionOpen = false;
        return null;
      }

      const now = format(new Date(), 'yyyy-MM-dd HH:mm:ss');
      await client.query(
        `
          UPDATE fund_reconciliations
          SET
            reconcile_status = $1,
            manual_status = 1,
            note = $2,
            reviewed_at = $3,
            updated_at = $3
          WHERE id = $4
        `,
        [status, note ?? row.note, now, reconciliationId],
      );

      await this.insertWorkspaceLog(
        client,
        featureKey,
        'reconcile',
        `${row.reconcileNo} 对账状态已更新`,
        `对账状态已切换为${this.getFundReconcileStatusText(status)}。`,
        now,
      );
      await this.touchWorkspace(client, featureKey, now);
      await this.touchWorkspace(client, 'fund-accounts', now);
      await this.touchWorkspace(client, 'fund-bills', now);

      await client.query('COMMIT');
      transactionOpen = false;
      return { status };
    } catch (error) {
      if (transactionOpen) {
        await client.query('ROLLBACK');
      }
      throw error;
    } finally {
      client.release();
    }
  }

  private getBackupRootDir() {
    return appConfig.backupDir;
  }

  private getLogArchiveRootDir() {
    return path.join(appConfig.logDir, 'archive');
  }

  private getRecoveryDrillRootDir() {
    return path.join(this.getBackupRootDir(), 'recovery-drills');
  }

  private toErrorMessage(error: unknown, fallback: string) {
    if (error instanceof Error && error.message.trim()) {
      return error.message;
    }
    return fallback;
  }

  private buildColumnSignature(
    columns: Array<{
      columnName?: string;
      dataType?: string;
      udtName?: string;
      isNullable?: boolean;
    }>,
  ) {
    const normalized = [...columns]
      .map((column) => ({
        columnName: String(column.columnName ?? ''),
        dataType: String(column.dataType ?? ''),
        udtName: String(column.udtName ?? ''),
        isNullable: Boolean(column.isNullable),
      }))
      .sort((left, right) => left.columnName.localeCompare(right.columnName));
    return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
  }

  private async collectPostgresOperationalSnapshot(): Promise<PostgresOperationalSnapshot> {
    const [databaseResult, tableResult, columnResult] = await Promise.all([
      this.pool.query(
        `
          SELECT
            current_database() AS "databaseName",
            pg_database_size(current_database()) AS "sizeBytes"
        `,
      ),
      this.pool.query(
        `
          SELECT
            n.nspname AS "schemaName",
            c.relname AS "tableName",
            GREATEST(c.reltuples, 0)::bigint AS "rowEstimate",
            pg_total_relation_size(c.oid) AS "totalBytes"
          FROM pg_class c
          INNER JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE c.relkind = 'r'
            AND n.nspname = 'public'
          ORDER BY c.relname ASC
        `,
      ),
      this.pool.query(
        `
          SELECT
            table_schema AS "schemaName",
            table_name AS "tableName",
            column_name AS "columnName",
            data_type AS "dataType",
            udt_name AS "udtName",
            is_nullable = 'YES' AS "isNullable"
          FROM information_schema.columns
          WHERE table_schema = 'public'
          ORDER BY table_name ASC, ordinal_position ASC
        `,
      ),
    ]);

    const columnMap = new Map<string, PostgresOperationalSnapshot['tables'][number]['columns']>();
    for (const row of columnResult.rows) {
      const key = `${String(row.schemaName ?? 'public')}.${String(row.tableName ?? '')}`;
      const list = columnMap.get(key) ?? [];
      list.push({
        columnName: String(row.columnName ?? ''),
        dataType: String(row.dataType ?? ''),
        udtName: String(row.udtName ?? ''),
        isNullable: Boolean(row.isNullable),
      });
      columnMap.set(key, list);
    }

    const databaseRow = databaseResult.rows[0] ?? {};
    return {
      database: {
        databaseName: String(databaseRow.databaseName ?? 'tenant-business'),
        sizeBytes: toNumber(databaseRow.sizeBytes),
      },
      tables: tableResult.rows.map((row) => {
        const schemaName = String(row.schemaName ?? 'public');
        const tableName = String(row.tableName ?? '');
        return {
          schemaName,
          tableName,
          rowEstimate: toNumber(row.rowEstimate),
          totalBytes: toNumber(row.totalBytes),
          columns: columnMap.get(`${schemaName}.${tableName}`) ?? [],
        };
      }),
    };
  }

  private async createPostgresBackupArtifact(input: {
    backupNo: string;
    startedAt: string;
    triggeredByName?: string | null;
  }) {
    fs.mkdirSync(this.getBackupRootDir(), { recursive: true });
    const snapshot = await this.collectPostgresOperationalSnapshot();
    const fileName = `${input.backupNo}.json`;
    const filePath = path.resolve(path.join(this.getBackupRootDir(), fileName));
    const manifest = {
      kind: 'postgres-backup-snapshot',
      backupNo: input.backupNo,
      createdAt: input.startedAt,
      triggeredByName: input.triggeredByName ?? null,
      database: snapshot.database,
      tables: snapshot.tables,
    };
    fs.writeFileSync(filePath, JSON.stringify(manifest, null, 2), 'utf8');
    const stat = fs.statSync(filePath);
    return {
      fileName,
      filePath,
      fileSize: stat.size,
      detail: `PostgreSQL snapshot manifest created for ${snapshot.tables.length} tables.`,
    };
  }

  private async recordSystemBackupRun(
    client: pg.PoolClient,
    input: {
      backupNo: string;
      backupType: 'manual' | 'scheduled';
      runStatus: 'success' | 'failed';
      fileName: string;
      filePath: string;
      fileSize: number;
      detail: string;
      startedAt: string;
      finishedAt: string | null;
      triggeredByName?: string | null;
    },
  ) {
    const nextId = await this.nextTableId(client, 'system_backup_runs');
    await client.query(
      `
        INSERT INTO system_backup_runs (
          id,
          backup_no,
          backup_type,
          run_status,
          file_name,
          file_path,
          file_size,
          detail,
          started_at,
          finished_at,
          triggered_by_name
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      `,
      [
        nextId,
        input.backupNo,
        input.backupType,
        input.runStatus,
        input.fileName,
        input.filePath,
        input.fileSize,
        input.detail,
        input.startedAt,
        input.finishedAt,
        input.triggeredByName ?? null,
      ],
    );

    const rowResult = await client.query(
      `
        SELECT
          id,
          backup_no AS "backupNo",
          backup_type AS "backupType",
          run_status AS "runStatus",
          file_name AS "fileName",
          file_path AS "filePath",
          file_size AS "fileSize",
          detail,
          started_at AS "startedAt",
          finished_at AS "finishedAt",
          triggered_by_name AS "triggeredByName"
        FROM system_backup_runs
        WHERE id = $1
      `,
      [nextId],
    );
    return rowResult.rows[0] as SystemBackupRun;
  }

  private async createPostgresLogArchiveArtifact(input: {
    archiveNo: string;
    createdAt: string;
  }) {
    const logsResult = await this.pool.query(
      `
        SELECT
          created_at AS "createdAt",
          action,
          target_type AS "targetType",
          target_id AS "targetId",
          detail,
          result
        FROM audit_logs
        ORDER BY created_at DESC, id DESC
        LIMIT 120
      `,
    );
    const logs = logsResult.rows;
    const sortedLogs = [...logs].sort((left, right) =>
      String(left.createdAt ?? '').localeCompare(String(right.createdAt ?? '')),
    );
    const periodStart = String(sortedLogs[0]?.createdAt ?? input.createdAt);
    const periodEnd = String(sortedLogs.at(-1)?.createdAt ?? input.createdAt);
    const fileName = `${input.archiveNo}.json`;
    const filePath = path.resolve(path.join(this.getLogArchiveRootDir(), fileName));
    fs.mkdirSync(this.getLogArchiveRootDir(), { recursive: true });
    fs.writeFileSync(
      filePath,
      JSON.stringify(
        {
          kind: 'postgres-audit-log-archive',
          archiveNo: input.archiveNo,
          createdAt: input.createdAt,
          periodStart,
          periodEnd,
          logCount: logs.length,
          logs,
        },
        null,
        2,
      ),
      'utf8',
    );
    return {
      periodStart,
      periodEnd,
      logCount: logs.length,
      fileName,
      filePath,
      detail: 'PostgreSQL audit logs archived to a JSON artifact.',
    };
  }

  private async recordSystemLogArchive(
    client: pg.PoolClient,
    input: {
      archiveNo: string;
      periodStart: string;
      periodEnd: string;
      logCount: number;
      fileName: string;
      filePath: string;
      archiveStatus: 'ready' | 'failed';
      detail: string;
      createdAt: string;
      triggeredByName?: string | null;
    },
  ) {
    const nextId = await this.nextTableId(client, 'system_log_archives');
    await client.query(
      `
        INSERT INTO system_log_archives (
          id,
          archive_no,
          period_start,
          period_end,
          log_count,
          file_name,
          file_path,
          archive_status,
          detail,
          created_at,
          triggered_by_name
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      `,
      [
        nextId,
        input.archiveNo,
        input.periodStart,
        input.periodEnd,
        input.logCount,
        input.fileName,
        input.filePath,
        input.archiveStatus,
        input.detail,
        input.createdAt,
        input.triggeredByName ?? null,
      ],
    );
  }

  private async persistRecoveryDrillResult(input: {
    featureKey: string;
    drillNo: string;
    backupRunId: number | null;
    backupNo: string | null;
    drillStatus: 'success' | 'failed';
    targetPath: string;
    detail: string;
    startedAt: string;
    started: Date;
    triggeredByName?: string | null;
  }): Promise<SystemRecoveryDrillRun> {
    const finishedAt = format(new Date(), 'yyyy-MM-dd HH:mm:ss');
    const durationSeconds = Math.max(Math.round((Date.now() - input.started.getTime()) / 1000), 1);
    const client = await this.pool.connect();
    let transactionOpen = false;
    try {
      await client.query('BEGIN');
      transactionOpen = true;
      const nextId = await this.nextTableId(client, 'system_recovery_drills');
      await client.query(
        `
          INSERT INTO system_recovery_drills (
            id,
            drill_no,
            backup_run_id,
            backup_no_snapshot,
            drill_status,
            target_path,
            duration_seconds,
            detail,
            started_at,
            finished_at,
            triggered_by_name
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        `,
        [
          nextId,
          input.drillNo,
          input.backupRunId,
          input.backupNo,
          input.drillStatus,
          input.targetPath,
          durationSeconds,
          input.detail,
          input.startedAt,
          finishedAt,
          input.triggeredByName ?? null,
        ],
      );
      await this.insertWorkspaceLog(
        client,
        input.featureKey,
        'recovery',
        input.drillStatus === 'success' ? 'PostgreSQL recovery drill completed' : 'PostgreSQL recovery drill failed',
        input.detail,
        finishedAt,
      );
      await this.touchWorkspace(client, input.featureKey, finishedAt);
      await client.query('COMMIT');
      transactionOpen = false;
    } catch (error) {
      if (transactionOpen) {
        await client.query('ROLLBACK');
      }
      throw error;
    } finally {
      client.release();
    }

    return {
      drillNo: input.drillNo,
      backupNo: input.backupNo ?? '',
      targetPath: path.resolve(input.targetPath),
      durationSeconds,
      detail: input.detail,
      finishedAt,
      status: input.drillStatus,
    };
  }

  private async insertWorkspaceLog(
    client: pg.PoolClient,
    featureKey: string,
    logType: string,
    title: string,
    detail: string,
    createdAt: string,
  ) {
    const nextLogId = await this.nextTableId(client, 'workspace_logs');
    await client.query(
      `
        INSERT INTO workspace_logs (id, feature_key, log_type, title, detail, created_at)
        VALUES ($1, $2, $3, $4, $5, $6)
      `,
      [nextLogId, featureKey, logType, title, detail, createdAt],
    );
  }

  private async touchWorkspace(client: pg.PoolClient, featureKey: string, updatedAt: string) {
    await client.query(
      `
        UPDATE workspace_modules
        SET updated_at = $1
        WHERE feature_key = $2
      `,
      [updatedAt, featureKey],
    );
  }

  private getFundReconcileStatusText(status: string) {
    return (
      {
        matched: '已对平',
        anomaly: '异常待核',
        reviewed: '已复核',
      }[status] ?? status
    );
  }

  private async upsertFundReconciliation(
    client: pg.PoolClient,
    input: {
      refType: string;
      refId: number;
      storeId: number | null;
      billCategory: string;
      platformAmount: number;
      ledgerAmount: number;
      note: string;
      updatedAt: string;
    },
  ) {
    const diffAmount = Number((input.ledgerAmount - input.platformAmount).toFixed(2));
    const autoStatus = Math.abs(diffAmount) < 0.01 ? 'matched' : 'anomaly';
    const existingResult = await client.query(
      `
        SELECT
          id,
          reconcile_no AS "reconcileNo",
          reconcile_status AS "reconcileStatus",
          manual_status AS "manualStatus",
          note,
          created_at AS "createdAt"
        FROM fund_reconciliations
        WHERE ref_type = $1 AND ref_id = $2
      `,
      [input.refType, input.refId],
    );
    const existing = existingResult.rows[0] as
      | {
          id: number;
          reconcileNo: string;
          reconcileStatus: string;
          manualStatus: number;
          note: string;
          createdAt: string;
        }
      | undefined;

    if (existing) {
      await client.query(
        `
          UPDATE fund_reconciliations
          SET
            store_id = $1,
            bill_category = $2,
            platform_amount = $3,
            ledger_amount = $4,
            diff_amount = $5,
            reconcile_status = $6,
            note = $7,
            updated_at = $8
          WHERE id = $9
        `,
        [
          input.storeId,
          input.billCategory,
          input.platformAmount,
          input.ledgerAmount,
          diffAmount,
          existing.manualStatus ? existing.reconcileStatus : autoStatus,
          existing.manualStatus ? existing.note : input.note,
          input.updatedAt,
          existing.id,
        ],
      );
      return existing.id;
    }

    const nextId = await this.nextTableId(client, 'fund_reconciliations');
    const reconcileNo = `DZ${input.updatedAt.replace(/[-:\s]/g, '').slice(0, 12)}${String(nextId).padStart(3, '0')}`;
    await client.query(
      `
        INSERT INTO fund_reconciliations (
          id,
          ref_type,
          ref_id,
          store_id,
          reconcile_no,
          bill_category,
          platform_amount,
          ledger_amount,
          diff_amount,
          reconcile_status,
          manual_status,
          note,
          created_at,
          updated_at
        )
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 0, $11, $12, $12)
      `,
      [
        nextId,
        input.refType,
        input.refId,
        input.storeId,
        reconcileNo,
        input.billCategory,
        input.platformAmount,
        input.ledgerAmount,
        diffAmount,
        autoStatus,
        input.note,
        input.updatedAt,
      ],
    );
    return nextId;
  }

  private async getDirectChargeJobContext(client: pg.PoolClient, jobId: number) {
    const result = await client.query(
      `
        SELECT
          dcj.id,
          dcj.order_id AS "orderId",
          dcj.supplier_id AS "supplierId",
          dcj.item_id AS "itemId",
          dcj.task_no AS "taskNo",
          dcj.supplier_order_no AS "supplierOrderNo",
          dcj.adapter_key AS "adapterKey",
          dcj.target_account AS "targetAccount",
          dcj.target_zone AS "targetZone",
          dcj.face_value AS "faceValue",
          dcj.task_status AS "taskStatus",
          dcj.supplier_status AS "supplierStatus",
          dcj.callback_status AS "callbackStatus",
          dcj.verification_status AS "verificationStatus",
          dcj.retry_count AS "retryCount",
          dcj.max_retry AS "maxRetry",
          dcj.error_message AS "errorMessage",
          dcj.result_detail AS "resultDetail",
          dcj.last_dispatch_at AS "lastDispatchAt",
          dcj.last_callback_at AS "lastCallbackAt",
          dcj.timeout_at AS "timeoutAt",
          dcj.manual_reason AS "manualReason",
          o.order_no AS "orderNo",
          o.after_sale_status AS "afterSaleStatus",
          o.paid_at AS "paidAt",
          dcs.supplier_key AS "supplierKey",
          dcs.supplier_name AS "supplierName",
          dcs.callback_token AS "callbackToken",
          dcs.enabled AS "supplierEnabled",
          dcs.supplier_status AS "supplierHealthStatus",
          dcs.timeout_minutes AS "timeoutMinutes",
          dci.product_title AS "productTitle",
          dci.enabled AS "itemEnabled",
          dci.status AS "itemStatus"
        FROM direct_charge_jobs dcj
        INNER JOIN orders o ON o.id = dcj.order_id
        INNER JOIN direct_charge_suppliers dcs ON dcs.id = dcj.supplier_id
        INNER JOIN direct_charge_items dci ON dci.id = dcj.item_id
        WHERE dcj.id = $1
      `,
      [jobId],
    );
    return result.rows[0] as
      | {
          id: number;
          orderId: number;
          supplierId: number;
          itemId: number;
          taskNo: string;
          supplierOrderNo: string | null;
          adapterKey: string;
          targetAccount: string;
          targetZone: string | null;
          faceValue: number;
          taskStatus: string;
          supplierStatus: string | null;
          callbackStatus: string;
          verificationStatus: string;
          retryCount: number;
          maxRetry: number;
          errorMessage: string | null;
          resultDetail: string | null;
          lastDispatchAt: string | null;
          lastCallbackAt: string | null;
          timeoutAt: string | null;
          manualReason: string | null;
          orderNo: string;
          afterSaleStatus: string | null;
          paidAt: string | null;
          supplierKey: string;
          supplierName: string;
          callbackToken: string;
          supplierEnabled: number;
          supplierHealthStatus: string;
          timeoutMinutes: number;
          productTitle: string;
          itemEnabled: number;
          itemStatus: string;
        }
      | undefined;
  }

  async toggleDirectChargeSupplierStatus(featureKey: string, supplierId: number) {
    if (featureKey !== 'distribution-source') {
      return null;
    }

    const client = await this.pool.connect();
    let transactionOpen = false;
    try {
      await client.query('BEGIN');
      transactionOpen = true;

      const supplierResult = await client.query(
        `
          SELECT
            id,
            supplier_name AS "supplierName",
            enabled,
            supplier_status AS "supplierStatus",
            success_rate AS "successRate"
          FROM direct_charge_suppliers
          WHERE id = $1
        `,
        [supplierId],
      );
      const supplier = supplierResult.rows[0] as
        | {
            id: number;
            supplierName: string;
            enabled: number;
            supplierStatus: string;
            successRate: number;
          }
        | undefined;
      if (!supplier) {
        await client.query('ROLLBACK');
        transactionOpen = false;
        return null;
      }

      const nextEnabled = supplier.enabled ? 0 : 1;
      const nextStatus = nextEnabled ? (supplier.successRate >= 95 ? 'online' : 'warning') : 'offline';
      const now = format(new Date(), 'yyyy-MM-dd HH:mm:ss');

      await client.query(
        `
          UPDATE direct_charge_suppliers
          SET
            enabled = $1,
            supplier_status = $2,
            updated_at = $3
          WHERE id = $4
        `,
        [nextEnabled, nextStatus, now, supplierId],
      );

      await this.insertWorkspaceLog(
        client,
        featureKey,
        'supplier_status',
        `${supplier.supplierName} ${nextEnabled ? 'enabled' : 'disabled'}`,
        nextEnabled
          ? 'Direct charge supplier was re-enabled.'
          : 'Direct charge supplier was disabled.',
        now,
      );
      await this.touchWorkspace(client, featureKey, now);
      await this.touchWorkspace(client, 'distribution-supply', now);

      await client.query('COMMIT');
      transactionOpen = false;
      return {
        enabled: Boolean(nextEnabled),
        supplierStatus: nextStatus,
      };
    } catch (error) {
      if (transactionOpen) {
        await client.query('ROLLBACK');
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async rotateDirectChargeSupplierToken(featureKey: string, supplierId: number) {
    if (featureKey !== 'distribution-source') {
      return null;
    }

    const client = await this.pool.connect();
    let transactionOpen = false;
    try {
      await client.query('BEGIN');
      transactionOpen = true;

      const supplierResult = await client.query(
        `
          SELECT id, supplier_name AS "supplierName"
          FROM direct_charge_suppliers
          WHERE id = $1
        `,
        [supplierId],
      );
      const supplier = supplierResult.rows[0] as { id: number; supplierName: string } | undefined;
      if (!supplier) {
        await client.query('ROLLBACK');
        transactionOpen = false;
        return null;
      }

      const nextToken = `dct-${randomUUID().replace(/-/g, '').slice(0, 20)}`;
      const maskedToken = this.maskSecret(nextToken);
      const now = format(new Date(), 'yyyy-MM-dd HH:mm:ss');

      await client.query(
        `
          UPDATE direct_charge_suppliers
          SET
            callback_token = $1,
            callback_token_masked = $2,
            updated_at = $3
          WHERE id = $4
        `,
        [nextToken, maskedToken, now, supplierId],
      );

      await this.insertWorkspaceLog(
        client,
        featureKey,
        'supplier_token',
        `${supplier.supplierName} token rotated`,
        'The previous token is no longer valid and must not be reused.',
        now,
      );
      await this.touchWorkspace(client, featureKey, now);

      await client.query('COMMIT');
      transactionOpen = false;
      return {
        supplierId,
        callbackTokenMasked: maskedToken,
        rotatedAt: now,
      };
    } catch (error) {
      if (transactionOpen) {
        await client.query('ROLLBACK');
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async queueDirectChargeJobDispatch(
    featureKey: string,
    jobId: number,
    mode: 'dispatch' | 'retry' = 'dispatch',
  ) {
    if (featureKey !== 'distribution-supply') {
      return null;
    }

    const now = format(new Date(), 'yyyy-MM-dd HH:mm:ss');
    const client = await this.pool.connect();
    let transactionOpen = false;
    try {
      await client.query('BEGIN');
      transactionOpen = true;

      const context = await this.getDirectChargeJobContext(client, jobId);
      if (!context) {
        await client.query('ROLLBACK');
        transactionOpen = false;
        return null;
      }

      if (context.taskStatus === 'success') {
        await client.query('COMMIT');
        transactionOpen = false;
        return {
          success: true,
          accepted: false,
          queued: false,
          idempotent: true,
          jobId: context.id,
          taskStatus: context.taskStatus,
          supplierOrderNo: context.supplierOrderNo,
          detail: context.resultDetail ?? 'Task is already complete.',
          timeoutAt: context.timeoutAt,
        };
      }

      if (
        context.taskStatus === 'processing' &&
        context.timeoutAt &&
        new Date(context.timeoutAt.replace(' ', 'T')).getTime() > new Date(now.replace(' ', 'T')).getTime()
      ) {
        await client.query('COMMIT');
        transactionOpen = false;
        return {
          success: true,
          accepted: false,
          queued: false,
          idempotent: true,
          jobId: context.id,
          taskStatus: context.taskStatus,
          supplierOrderNo: context.supplierOrderNo,
          detail: context.resultDetail ?? 'Task is still being processed.',
          timeoutAt: context.timeoutAt,
        };
      }

      const detail =
        mode === 'retry'
          ? 'Task queued for background retry dispatch.'
          : 'Task queued for background dispatch.';
      await client.query(
        `
          UPDATE direct_charge_jobs
          SET
            task_status = 'pending_dispatch',
            callback_status = 'pending',
            verification_status = 'pending',
            error_message = NULL,
            result_detail = $1,
            timeout_at = NULL,
            manual_reason = NULL,
            updated_at = $2
          WHERE id = $3
        `,
        [detail, now, context.id],
      );
      await this.insertWorkspaceLog(
        client,
        featureKey,
        mode === 'retry' ? 'retry_queued' : 'dispatch_queued',
        mode === 'retry'
          ? `Task ${context.taskNo} queued for background retry`
          : `Task ${context.taskNo} queued for background dispatch`,
        detail,
        now,
      );
      await this.touchWorkspace(client, featureKey, now);

      await client.query('COMMIT');
      transactionOpen = false;
      return {
        success: true,
        accepted: true,
        queued: true,
        idempotent: false,
        jobId: context.id,
        taskStatus: 'pending_dispatch' as const,
        supplierOrderNo: context.supplierOrderNo,
        detail,
      };
    } catch (error) {
      if (transactionOpen) {
        await client.query('ROLLBACK');
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async queueDirectChargeJobManualReview(featureKey: string, jobId: number, reason: string) {
    if (featureKey !== 'distribution-supply') {
      return null;
    }

    const client = await this.pool.connect();
    let transactionOpen = false;
    try {
      await client.query('BEGIN');
      transactionOpen = true;

      const context = await this.getDirectChargeJobContext(client, jobId);
      if (!context || context.taskStatus === 'success') {
        await client.query('ROLLBACK');
        transactionOpen = false;
        return null;
      }

      const normalizedReason = reason.trim() || 'Task moved to manual review.';
      const now = format(new Date(), 'yyyy-MM-dd HH:mm:ss');
      await client.query(
        `
          UPDATE direct_charge_jobs
          SET
            error_message = $1,
            result_detail = $1,
            manual_reason = $1,
            updated_at = $2
          WHERE id = $3
        `,
        [normalizedReason, now, context.id],
      );
      await this.insertWorkspaceLog(
        client,
        featureKey,
        'manual_review_queued',
        `Task ${context.taskNo} queued for manual review`,
        normalizedReason,
        now,
      );
      await this.touchWorkspace(client, featureKey, now);

      await client.query('COMMIT');
      transactionOpen = false;
      return {
        success: true,
        accepted: true,
        queued: true,
        idempotent: false,
        taskStatus: 'manual_review_pending' as const,
        reason: normalizedReason,
      };
    } catch (error) {
      if (transactionOpen) {
        await client.query('ROLLBACK');
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async toggleSupplySourceSystemStatus(featureKey: string, systemId: number) {
    const client = await this.pool.connect();
    let transactionOpen = false;
    try {
      await client.query('BEGIN');
      transactionOpen = true;

      const systemResult = await client.query(
        `
          SELECT
            id,
            system_name AS "systemName",
            enabled
          FROM supply_source_systems
          WHERE id = $1
        `,
        [systemId],
      );
      const system = systemResult.rows[0] as
        | {
            id: number;
            systemName: string;
            enabled: number;
          }
        | undefined;
      if (!system) {
        const diagnostics = await client.query(
          `
            SELECT id, system_name AS "systemName"
            FROM supply_source_systems
            ORDER BY id ASC
            LIMIT 5
          `,
        );
        await client.query('ROLLBACK');
        transactionOpen = false;
        this.logger.warn(
          {
            event: 'tenant_pg_supply_source_system_missing',
            featureKey,
            systemId,
            candidates: diagnostics.rows,
          },
          'Tenant PostgreSQL supply-source system write target was not found.',
        );
        return null;
      }

      const nextEnabled = system.enabled ? 0 : 1;
      const nextStatus = nextEnabled ? (system.id === 1 ? 'online' : 'warning') : 'offline';
      const now = format(new Date(), 'yyyy-MM-dd HH:mm:ss');

      await client.query(
        `
          UPDATE supply_source_systems
          SET
            enabled = $1,
            system_status = $2,
            updated_at = $3
          WHERE id = $4
        `,
        [nextEnabled, nextStatus, now, systemId],
      );

      await this.insertWorkspaceLog(
        client,
        featureKey,
        'source_system_status',
        `${system.systemName} ${nextEnabled ? 'enabled' : 'disabled'}`,
        nextEnabled
          ? 'Supply-source system was re-enabled for sync and push workflows.'
          : 'Supply-source system was removed from sync and push workflows.',
        now,
      );
      await this.touchWorkspace(client, featureKey, now);
      await this.touchWorkspace(client, 'distribution-supply', now);

      await client.query('COMMIT');
      transactionOpen = false;
      return {
        enabled: Boolean(nextEnabled),
        systemStatus: nextStatus,
      };
    } catch (error) {
      if (transactionOpen) {
        await client.query('ROLLBACK');
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async rotateSupplySourceSystemToken(featureKey: string, systemId: number) {
    const client = await this.pool.connect();
    let transactionOpen = false;
    try {
      await client.query('BEGIN');
      transactionOpen = true;

      const systemResult = await client.query(
        `
          SELECT id, system_name AS "systemName"
          FROM supply_source_systems
          WHERE id = $1
        `,
        [systemId],
      );
      const system = systemResult.rows[0] as { id: number; systemName: string } | undefined;
      if (!system) {
        const diagnostics = await client.query(
          `
            SELECT id, system_name AS "systemName"
            FROM supply_source_systems
            ORDER BY id ASC
            LIMIT 5
          `,
        );
        await client.query('ROLLBACK');
        transactionOpen = false;
        this.logger.warn(
          {
            event: 'tenant_pg_supply_source_system_missing',
            featureKey,
            systemId,
            candidates: diagnostics.rows,
          },
          'Tenant PostgreSQL supply-source system token rotation target was not found.',
        );
        return null;
      }

      const nextToken = `sst-${randomUUID().replace(/-/g, '').slice(0, 20)}`;
      const maskedToken = this.maskSecret(nextToken);
      const now = format(new Date(), 'yyyy-MM-dd HH:mm:ss');

      await client.query(
        `
          UPDATE supply_source_systems
          SET
            callback_token = $1,
            callback_token_masked = $2,
            updated_at = $3
          WHERE id = $4
        `,
        [nextToken, maskedToken, now, systemId],
      );

      await this.insertWorkspaceLog(
        client,
        featureKey,
        'source_system_token',
        `${system.systemName} token rotated`,
        'The previous source-system callback token is no longer valid.',
        now,
      );
      await this.touchWorkspace(client, featureKey, now);

      await client.query('COMMIT');
      transactionOpen = false;
      return {
        systemId,
        callbackTokenMasked: maskedToken,
        rotatedAt: now,
      };
    } catch (error) {
      if (transactionOpen) {
        await client.query('ROLLBACK');
      }
      throw error;
    } finally {
      client.release();
    }
  }

  private async getSupplySourceSystemContext(client: pg.PoolClient, systemId: number) {
    const result = await client.query(
      `
        SELECT
          id,
          system_key AS "systemKey",
          system_name AS "systemName",
          adapter_key AS "adapterKey",
          callback_token AS "callbackToken",
          enabled,
          system_status AS "systemStatus",
          sync_mode AS "syncMode",
          sync_interval_minutes AS "syncIntervalMinutes",
          order_push_enabled AS "orderPushEnabled",
          refund_callback_enabled AS "refundCallbackEnabled"
        FROM supply_source_systems
        WHERE id = $1
      `,
      [systemId],
    );
    return result.rows[0] as
      | {
          id: number;
          systemKey: string;
          systemName: string;
          adapterKey: string;
          callbackToken: string;
          enabled: number;
          systemStatus: SupplySourceSystemStatus;
          syncMode: SupplySourceSyncMode;
          syncIntervalMinutes: number;
          orderPushEnabled: number;
          refundCallbackEnabled: number;
        }
      | undefined;
  }

  private async createSupplySourceSyncRun(
    client: pg.PoolClient,
    input: {
      systemId: number;
      syncType: SupplySourceSyncType;
      runMode: SupplySourceSyncMode;
      runStatus: SupplySourceSyncRunStatus;
      totalCount: number;
      successCount: number;
      failureCount: number;
      detail: string;
      createdAt: string;
    },
  ) {
    const result = await client.query(
      `
        INSERT INTO supply_source_sync_runs (
          system_id,
          sync_type,
          run_mode,
          run_status,
          total_count,
          success_count,
          failure_count,
          detail,
          created_at,
          finished_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $9
        )
        RETURNING id
      `,
      [
        input.systemId,
        input.syncType,
        input.runMode,
        input.runStatus,
        input.totalCount,
        input.successCount,
        input.failureCount,
        input.detail,
        input.createdAt,
      ],
    );
    return Number(result.rows[0]?.id);
  }

  private async upsertSupplySourceReconciliation(
    client: pg.PoolClient,
    input: {
      systemId: number;
      mappingId?: number | null;
      orderId?: number | null;
      reconcileType: string;
      reconcileNo: string;
      platformRef: string;
      sourceRef: string;
      platformPrice?: number | null;
      sourcePrice?: number | null;
      platformStock?: number | null;
      sourceStock?: number | null;
      platformAmount?: number | null;
      sourceAmount?: number | null;
      diffAmount: number;
      reconcileStatus: SupplySourceReconcileStatus;
      detail: string;
      now: string;
    },
  ) {
    await client.query(
      `
        INSERT INTO supply_source_reconciliations (
          system_id,
          mapping_id,
          order_id,
          reconcile_type,
          reconcile_no,
          platform_ref,
          source_ref,
          platform_price,
          source_price,
          platform_stock,
          source_stock,
          platform_amount,
          source_amount,
          diff_amount,
          reconcile_status,
          detail,
          created_at,
          updated_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $17
        )
        ON CONFLICT (reconcile_no) DO UPDATE SET
          mapping_id = EXCLUDED.mapping_id,
          order_id = EXCLUDED.order_id,
          platform_ref = EXCLUDED.platform_ref,
          source_ref = EXCLUDED.source_ref,
          platform_price = EXCLUDED.platform_price,
          source_price = EXCLUDED.source_price,
          platform_stock = EXCLUDED.platform_stock,
          source_stock = EXCLUDED.source_stock,
          platform_amount = EXCLUDED.platform_amount,
          source_amount = EXCLUDED.source_amount,
          diff_amount = EXCLUDED.diff_amount,
          reconcile_status = EXCLUDED.reconcile_status,
          detail = EXCLUDED.detail,
          updated_at = EXCLUDED.updated_at
      `,
      [
        input.systemId,
        input.mappingId ?? null,
        input.orderId ?? null,
        input.reconcileType,
        input.reconcileNo,
        input.platformRef,
        input.sourceRef,
        input.platformPrice ?? null,
        input.sourcePrice ?? null,
        input.platformStock ?? null,
        input.sourceStock ?? null,
        input.platformAmount ?? null,
        input.sourceAmount ?? null,
        input.diffAmount,
        input.reconcileStatus,
        input.detail,
        input.now,
      ],
    );
  }

  private async appendOrderEvent(
    client: pg.PoolClient,
    orderId: number,
    eventType: string,
    eventTitle: string,
    eventDetail: string,
    operatorName: string,
    createdAt: string,
  ) {
    const nextId = await this.nextTableId(client, 'order_events');
    await client.query(
      `
        INSERT INTO order_events (
          id,
          order_id,
          event_type,
          event_title,
          event_detail,
          operator_name,
          created_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7
        )
      `,
      [nextId, orderId, eventType, eventTitle, eventDetail, operatorName, createdAt],
    );
  }

  private async runSupplySourceSyncInternal(
    client: pg.PoolClient,
    featureKey: string,
    systemId: number,
    syncType: SupplySourceSyncType,
    runMode: SupplySourceSyncMode,
    now: string,
    options: { applyPlatformUpdates?: boolean } = {},
  ) {
    const system = await this.getSupplySourceSystemContext(client, systemId);
    if (!system) {
      return null;
    }

    const mappingsResult = await client.query(
      `
        SELECT
          ssp.id,
          ssp.external_product_id AS "externalProductId",
          ssp.external_sku AS "externalSku",
          ssp.external_product_name AS "externalProductName",
          ssp.platform_product_id AS "platformProductId",
          ssp.platform_product_name AS "platformProductName",
          ssp.category,
          ssp.sale_price AS "salePrice",
          p.stock AS "platformStock"
        FROM supply_source_products ssp
        INNER JOIN products p ON p.id = ssp.platform_product_id
        WHERE ssp.system_id = $1
        ORDER BY ssp.id ASC
      `,
      [systemId],
    );
    const mappings = mappingsResult.rows as Array<{
      id: number;
      externalProductId: string;
      externalSku: string;
      externalProductName: string;
      platformProductId: number;
      platformProductName: string;
      category: string;
      salePrice: number;
      platformStock: number;
    }>;

    const syncTypeText = syncType === 'product' ? 'product' : syncType === 'inventory' ? 'inventory' : 'price';
    const failSync = async (detail: string, runStatus: SupplySourceSyncRunStatus = 'failed') => {
      const runId = await this.createSupplySourceSyncRun(client, {
        systemId,
        syncType,
        runMode,
        runStatus,
        totalCount: mappings.length,
        successCount: 0,
        failureCount: mappings.length,
        detail,
        createdAt: now,
      });
      await this.insertWorkspaceLog(
        client,
        featureKey,
        'source_sync_failed',
        `${system.systemName} ${syncTypeText} sync failed`,
        detail,
        now,
      );
      await this.touchWorkspace(client, featureKey, now);

      return {
        id: runId,
        systemId,
        syncType,
        runMode,
        runStatus,
        totalCount: mappings.length,
        successCount: 0,
        failureCount: mappings.length,
        detail,
      };
    };

    if (mappings.length === 0) {
      return failSync('No supply-source product mappings are configured.');
    }

    if (!system.enabled || system.systemStatus === 'offline') {
      return failSync('Supply-source system is disabled or offline.');
    }

    const adapter = getSupplySourceAdapter(system.adapterKey);
    if (!adapter) {
      return failSync('Supply-source adapter is not registered.');
    }

    const syncResult = adapter.syncProducts(
      syncType,
      mappings.map((item) => ({
        externalProductId: item.externalProductId,
        externalSku: item.externalSku,
        externalProductName: item.externalProductName,
        category: item.category,
        mappedProductName: item.platformProductName,
        salePrice: Number(item.salePrice ?? 0),
        platformStock: Number(item.platformStock ?? 0),
      })),
    );
    const successCount = syncResult.items.filter((item) => item.syncStatus === 'synced').length;
    const failureCount = syncResult.items.length - successCount;
    const runStatus: SupplySourceSyncRunStatus =
      failureCount === 0 ? 'success' : successCount === 0 ? 'failed' : 'partial';
    const applyPlatformUpdates = options.applyPlatformUpdates ?? true;

    for (const item of syncResult.items) {
      const mapping = mappings.find((entry) => entry.externalProductId === item.externalProductId);
      if (!mapping) {
        continue;
      }

      await client.query(
        `
          UPDATE supply_source_products
          SET
            source_price = $1,
            source_stock = $2,
            sync_status = $3,
            last_sync_at = $4,
            updated_at = $4
          WHERE id = $5
        `,
        [item.sourcePrice, item.sourceStock, item.syncStatus, now, mapping.id],
      );

      if (applyPlatformUpdates) {
        await client.query(
          `
            UPDATE products
            SET
              cost = CASE
                WHEN $1 IN ('product', 'price') THEN $2
                ELSE cost
              END,
              stock = CASE
                WHEN $1 IN ('product', 'inventory') THEN $3
                ELSE stock
              END
            WHERE id = $4
          `,
          [syncType, item.sourcePrice, item.sourceStock, mapping.platformProductId],
        );
      }

      const diffAmount =
        syncType === 'inventory'
          ? Number((Number(mapping.platformStock ?? 0) - item.sourceStock).toFixed(2))
          : Number((Number(mapping.salePrice ?? 0) - item.sourcePrice).toFixed(2));
      const reconcileStatus: SupplySourceReconcileStatus =
        item.syncStatus === 'synced' ? 'matched' : item.syncStatus === 'warning' ? 'pending' : 'anomaly';

      await this.upsertSupplySourceReconciliation(client, {
        systemId,
        mappingId: mapping.id,
        reconcileType: syncType,
        reconcileNo: `SSR-${syncType.toUpperCase()}-${mapping.id}`,
        platformRef: mapping.platformProductName,
        sourceRef: item.externalProductId,
        platformPrice: Number(mapping.salePrice ?? 0),
        sourcePrice: item.sourcePrice,
        platformStock: Number(mapping.platformStock ?? 0),
        sourceStock: item.sourceStock,
        diffAmount,
        reconcileStatus,
        detail: item.detail,
        now,
      });
    }

    await client.query(
      `
        UPDATE supply_source_systems
        SET
          system_status = $1,
          updated_at = $2,
          last_product_sync_at = CASE
            WHEN $3 = 'product' THEN $2
            ELSE last_product_sync_at
          END,
          last_inventory_sync_at = CASE
            WHEN $3 = 'inventory' THEN $2
            ELSE last_inventory_sync_at
          END,
          last_price_sync_at = CASE
            WHEN $3 = 'price' THEN $2
            ELSE last_price_sync_at
          END
        WHERE id = $4
      `,
      [runStatus === 'success' ? 'online' : 'warning', now, syncType, systemId],
    );

    const runId = await this.createSupplySourceSyncRun(client, {
      systemId,
      syncType,
      runMode,
      runStatus,
      totalCount: syncResult.items.length,
      successCount,
      failureCount,
      detail: syncResult.detail,
      createdAt: now,
    });

    await this.insertWorkspaceLog(
      client,
      featureKey,
      'source_sync',
      `${system.systemName} ${syncTypeText} sync executed`,
      `${syncResult.detail} Success ${successCount}, anomalies ${failureCount}.`,
      now,
    );
    await this.touchWorkspace(client, featureKey, now);

    return {
      id: runId,
      systemId,
      syncType,
      runMode,
      runStatus,
      totalCount: syncResult.items.length,
      successCount,
      failureCount,
      detail: syncResult.detail,
    };
  }

  async runSupplySourceSync(featureKey: string, systemId: number, syncType: SupplySourceSyncType) {
    if (featureKey !== 'distribution-source') {
      return null;
    }

    const now = format(new Date(), 'yyyy-MM-dd HH:mm:ss');
    const client = await this.pool.connect();
    let transactionOpen = false;
    try {
      await client.query('BEGIN');
      transactionOpen = true;
      const result = await this.runSupplySourceSyncInternal(client, featureKey, systemId, syncType, 'manual', now);
      await client.query('COMMIT');
      transactionOpen = false;
      return result;
    } catch (error) {
      if (transactionOpen) {
        await client.query('ROLLBACK');
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async retrySupplySourceSyncRun(featureKey: string, runId: number) {
    if (featureKey !== 'distribution-source') {
      return null;
    }

    const client = await this.pool.connect();
    let transactionOpen = false;
    try {
      await client.query('BEGIN');
      transactionOpen = true;
      const runResult = await client.query(
        `
          SELECT
            id,
            system_id AS "systemId",
            sync_type AS "syncType"
          FROM supply_source_sync_runs
          WHERE id = $1
        `,
        [runId],
      );
      const run = runResult.rows[0] as
        | {
            id: number;
            systemId: number;
            syncType: SupplySourceSyncType;
          }
        | undefined;
      if (!run) {
        await client.query('ROLLBACK');
        transactionOpen = false;
        return null;
      }

      const now = format(new Date(), 'yyyy-MM-dd HH:mm:ss');
      const result = await this.runSupplySourceSyncInternal(
        client,
        featureKey,
        Number(run.systemId),
        run.syncType,
        'manual',
        now,
      );
      await client.query('COMMIT');
      transactionOpen = false;
      return result;
    } catch (error) {
      if (transactionOpen) {
        await client.query('ROLLBACK');
      }
      throw error;
    } finally {
      client.release();
    }
  }

  private async getSupplySourceOrderContext(client: pg.PoolClient, sourceOrderId: number) {
    const result = await client.query(
      `
        SELECT
          sso.id,
          sso.system_id AS "systemId",
          sso.mapping_id AS "mappingId",
          sso.order_id AS "orderId",
          sso.task_no AS "taskNo",
          sso.source_order_no AS "sourceOrderNo",
          sso.order_status AS "orderStatus",
          sso.source_status AS "sourceStatus",
          sso.verification_status AS "verificationStatus",
          sso.retry_count AS "retryCount",
          sso.max_retry AS "maxRetry",
          sso.failure_reason AS "failureReason",
          sso.result_detail AS "resultDetail",
          sso.pushed_at AS "pushedAt",
          sso.callback_at AS "callbackAt",
          sss.system_key AS "systemKey",
          sss.system_name AS "systemName",
          sss.adapter_key AS "adapterKey",
          sss.callback_token AS "callbackToken",
          sss.enabled AS "systemEnabled",
          sss.system_status AS "systemStatus",
          sss.order_push_enabled AS "orderPushEnabled",
          ssp.external_product_id AS "externalProductId",
          ssp.external_product_name AS "externalProductName",
          ssp.platform_product_name AS "platformProductName",
          ssp.enabled AS "mappingEnabled",
          o.order_no AS "orderNo",
          o.quantity,
          o.paid_amount AS "paidAmount",
          o.store_id AS "storeId",
          st.name AS "storeName"
        FROM supply_source_orders sso
        INNER JOIN supply_source_systems sss ON sss.id = sso.system_id
        INNER JOIN supply_source_products ssp ON ssp.id = sso.mapping_id
        INNER JOIN orders o ON o.id = sso.order_id
        LEFT JOIN stores st ON st.id = o.store_id
        WHERE sso.id = $1
      `,
      [sourceOrderId],
    );
    return result.rows[0] as
      | {
          id: number;
          systemId: number;
          mappingId: number;
          orderId: number;
          taskNo: string;
          sourceOrderNo: string | null;
          orderStatus: SupplySourceOrderStatus;
          sourceStatus: string | null;
          verificationStatus: SupplySourceVerificationStatus;
          retryCount: number;
          maxRetry: number;
          failureReason: string | null;
          resultDetail: string | null;
          pushedAt: string | null;
          callbackAt: string | null;
          systemKey: string;
          systemName: string;
          adapterKey: string;
          callbackToken: string;
          systemEnabled: number;
          systemStatus: SupplySourceSystemStatus;
          orderPushEnabled: number;
          externalProductId: string;
          externalProductName: string;
          platformProductName: string;
          mappingEnabled: number;
          orderNo: string;
          quantity: number;
          paidAmount: number;
          storeId: number;
          storeName: string | null;
        }
      | undefined;
  }

  private async dispatchSupplySourceOrderInternal(
    client: pg.PoolClient,
    sourceOrderId: number,
    now: string,
    retry = false,
  ) {
    const context = await this.getSupplySourceOrderContext(client, sourceOrderId);
    if (!context) {
      return null;
    }

    if (context.orderStatus === 'success') {
      return {
        success: true,
        idempotent: true,
        sourceOrderId: context.id,
        orderStatus: context.orderStatus,
        sourceOrderNo: context.sourceOrderNo,
        detail: context.resultDetail ?? 'Supply-source order is already complete.',
        pushedAt: context.pushedAt,
      };
    }

    if (context.orderStatus === 'processing' && context.pushedAt) {
      return {
        success: true,
        idempotent: true,
        sourceOrderId: context.id,
        orderStatus: context.orderStatus,
        sourceOrderNo: context.sourceOrderNo,
        detail: context.resultDetail ?? 'Supply-source order is still processing.',
        pushedAt: context.pushedAt,
      };
    }

    const failDispatch = async (errorMessage: string) => {
      await client.query(
        `
          UPDATE supply_source_orders
          SET
            order_status = 'manual_review',
            failure_reason = $1,
            result_detail = $1,
            updated_at = $2
          WHERE id = $3
        `,
        [errorMessage, now, context.id],
      );

      await client.query(
        `
          UPDATE orders
          SET
            order_status = 'pending_shipment',
            delivery_status = 'manual_review',
            main_status = 'processing',
            updated_at = $1
          WHERE id = $2
        `,
        [now, context.orderId],
      );

      await this.appendOrderEvent(
        client,
        context.orderId,
        'source_supply_manual_review',
        'Supply-source order moved to manual review',
        errorMessage,
        'Supply-source engine',
        now,
      );
      await this.upsertSupplySourceReconciliation(client, {
        systemId: context.systemId,
        mappingId: context.mappingId,
        orderId: context.orderId,
        reconcileType: 'order',
        reconcileNo: `SSR-ORDER-${context.id}`,
        platformRef: context.orderNo,
        sourceRef: context.sourceOrderNo ?? context.taskNo,
        platformAmount: Number(context.paidAmount ?? 0),
        sourceAmount: Number(context.paidAmount ?? 0),
        diffAmount: 0,
        reconcileStatus: 'anomaly',
        detail: errorMessage,
        now,
      });

      return {
        success: false,
        idempotent: false,
        sourceOrderId: context.id,
        orderStatus: 'manual_review' as const,
        errorMessage,
      };
    };

    if (!context.systemEnabled || context.systemStatus === 'offline' || !context.orderPushEnabled) {
      return failDispatch('Supply-source system is disabled, offline, or order push is disabled.');
    }

    if (!context.mappingEnabled) {
      return failDispatch('Supply-source product mapping is disabled.');
    }

    const adapter = getSupplySourceAdapter(context.adapterKey);
    if (!adapter) {
      return failDispatch('Supply-source adapter is not registered.');
    }

    const dispatchResult = adapter.dispatchOrder({
      taskNo: context.taskNo,
      orderNo: context.orderNo,
      productTitle: context.platformProductName,
      quantity: Number(context.quantity ?? 1),
      paidAmount: Number(context.paidAmount ?? 0),
      targetStoreName: context.storeName ?? `Store ${context.storeId}`,
    });

    await client.query(
      `
        UPDATE supply_source_orders
        SET
          source_order_no = $1,
          source_status = $2,
          order_status = 'processing',
          verification_status = 'pending',
          retry_count = CASE
            WHEN $3 = 1 THEN retry_count + 1
            ELSE retry_count
          END,
          failure_reason = NULL,
          result_detail = $4,
          pushed_at = $5,
          updated_at = $5
        WHERE id = $6
      `,
      [
        dispatchResult.sourceOrderNo,
        dispatchResult.sourceStatus,
        retry ? 1 : 0,
        dispatchResult.detail,
        now,
        context.id,
      ],
    );

    await client.query(
      `
        UPDATE supply_source_systems
        SET
          last_order_push_at = $1,
          updated_at = $1
        WHERE id = $2
      `,
      [now, context.systemId],
    );

    await client.query(
      `
        UPDATE orders
        SET
          order_status = 'shipped',
          delivery_status = 'shipped',
          main_status = 'processing',
          shipped_at = COALESCE(shipped_at, $1),
          updated_at = $1
        WHERE id = $2
      `,
      [now, context.orderId],
    );

    await this.appendOrderEvent(
      client,
      context.orderId,
      retry ? 'source_supply_redispatch' : 'source_supply_dispatch',
      retry ? 'Supply-source order redispatched' : 'Supply-source order dispatched',
      `${context.systemName} accepted task ${context.taskNo}.`,
      'Supply-source engine',
      now,
    );
    await this.upsertSupplySourceReconciliation(client, {
      systemId: context.systemId,
      mappingId: context.mappingId,
      orderId: context.orderId,
      reconcileType: 'order',
      reconcileNo: `SSR-ORDER-${context.id}`,
      platformRef: context.orderNo,
      sourceRef: dispatchResult.sourceOrderNo,
      platformAmount: Number(context.paidAmount ?? 0),
      sourceAmount: Number(context.paidAmount ?? 0),
      diffAmount: 0,
      reconcileStatus: 'pending',
      detail: dispatchResult.detail,
      now,
    });

    return {
      success: true,
      idempotent: false,
      sourceOrderId: context.id,
      orderStatus: 'processing' as const,
      sourceOrderNo: dispatchResult.sourceOrderNo,
      detail: dispatchResult.detail,
      pushedAt: now,
    };
  }

  async dispatchSupplySourceOrder(featureKey: string, sourceOrderId: number) {
    if (featureKey !== 'distribution-supply') {
      return null;
    }

    const now = format(new Date(), 'yyyy-MM-dd HH:mm:ss');
    const client = await this.pool.connect();
    let transactionOpen = false;
    try {
      await client.query('BEGIN');
      transactionOpen = true;
      const context = await this.getSupplySourceOrderContext(client, sourceOrderId);
      if (!context) {
        await client.query('ROLLBACK');
        transactionOpen = false;
        return null;
      }

      const result = await this.dispatchSupplySourceOrderInternal(client, sourceOrderId, now, false);
      if (!result) {
        await client.query('ROLLBACK');
        transactionOpen = false;
        return null;
      }

      await this.insertWorkspaceLog(
        client,
        featureKey,
        result.success ? 'source_order_dispatch' : 'source_order_dispatch_failed',
        result.success ? `Task ${context.taskNo} dispatched` : `Task ${context.taskNo} dispatch failed`,
        result.success
          ? 'detail' in result
            ? result.detail ?? 'Supply-source order is processing.'
            : 'Supply-source order is processing.'
          : 'errorMessage' in result
            ? result.errorMessage ?? 'Supply-source system did not return a failure reason.'
            : 'Supply-source system did not return a failure reason.',
        now,
      );
      await this.touchWorkspace(client, featureKey, now);

      await client.query('COMMIT');
      transactionOpen = false;
      return result;
    } catch (error) {
      if (transactionOpen) {
        await client.query('ROLLBACK');
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async retrySupplySourceOrder(featureKey: string, sourceOrderId: number) {
    if (featureKey !== 'distribution-supply') {
      return null;
    }

    const now = format(new Date(), 'yyyy-MM-dd HH:mm:ss');
    const client = await this.pool.connect();
    let transactionOpen = false;
    try {
      await client.query('BEGIN');
      transactionOpen = true;
      const context = await this.getSupplySourceOrderContext(client, sourceOrderId);
      if (!context) {
        await client.query('ROLLBACK');
        transactionOpen = false;
        return null;
      }

      const result = await this.dispatchSupplySourceOrderInternal(client, sourceOrderId, now, true);
      if (!result) {
        await client.query('ROLLBACK');
        transactionOpen = false;
        return null;
      }

      await this.insertWorkspaceLog(
        client,
        featureKey,
        result.success ? 'source_order_retry' : 'source_order_retry_failed',
        result.success ? `Task ${context.taskNo} retried` : `Task ${context.taskNo} retry failed`,
        result.success
          ? 'detail' in result
            ? result.detail ?? 'Supply-source order is processing.'
            : 'Supply-source order is processing.'
          : 'errorMessage' in result
            ? result.errorMessage ?? 'Supply-source system did not return a failure reason.'
            : 'Supply-source system did not return a failure reason.',
        now,
      );
      await this.touchWorkspace(client, featureKey, now);

      await client.query('COMMIT');
      transactionOpen = false;
      return result;
    } catch (error) {
      if (transactionOpen) {
        await client.query('ROLLBACK');
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async markSupplySourceOrderManualReview(featureKey: string, sourceOrderId: number, reason: string) {
    if (featureKey !== 'distribution-supply') {
      return null;
    }

    const client = await this.pool.connect();
    let transactionOpen = false;
    try {
      await client.query('BEGIN');
      transactionOpen = true;
      const context = await this.getSupplySourceOrderContext(client, sourceOrderId);
      if (!context || context.orderStatus === 'success') {
        await client.query('ROLLBACK');
        transactionOpen = false;
        return null;
      }

      const now = format(new Date(), 'yyyy-MM-dd HH:mm:ss');
      await client.query(
        `
          UPDATE supply_source_orders
          SET
            order_status = 'manual_review',
            failure_reason = $1,
            result_detail = $1,
            updated_at = $2
          WHERE id = $3
        `,
        [reason, now, sourceOrderId],
      );

      await client.query(
        `
          UPDATE orders
          SET
            order_status = 'pending_shipment',
            delivery_status = 'manual_review',
            main_status = 'processing',
            updated_at = $1
          WHERE id = $2
        `,
        [now, context.orderId],
      );

      await this.appendOrderEvent(
        client,
        context.orderId,
        'source_supply_manual_review',
        'Supply-source order moved to manual review',
        reason,
        'Supply-source engine',
        now,
      );
      await this.upsertSupplySourceReconciliation(client, {
        systemId: context.systemId,
        mappingId: context.mappingId,
        orderId: context.orderId,
        reconcileType: 'order',
        reconcileNo: `SSR-ORDER-${context.id}`,
        platformRef: context.orderNo,
        sourceRef: context.sourceOrderNo ?? context.taskNo,
        platformAmount: Number(context.paidAmount ?? 0),
        sourceAmount: Number(context.paidAmount ?? 0),
        diffAmount: 0,
        reconcileStatus: 'anomaly',
        detail: reason,
        now,
      });

      await this.insertWorkspaceLog(
        client,
        featureKey,
        'source_order_manual_review',
        `Task ${context.taskNo} moved to manual review`,
        reason,
        now,
      );
      await this.touchWorkspace(client, featureKey, now);

      await client.query('COMMIT');
      transactionOpen = false;
      return {
        sourceOrderId,
        orderStatus: 'manual_review' as const,
        reason,
      };
    } catch (error) {
      if (transactionOpen) {
        await client.query('ROLLBACK');
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async toggleCardDeliveryItem(featureKey: string, deliveryId: number) {
    if (featureKey !== 'card-delivery') {
      return null;
    }

    const client = await this.pool.connect();
    let transactionOpen = false;
    try {
      await client.query('BEGIN');
      transactionOpen = true;

      const deliveryResult = await client.query(
        `
          SELECT
            id,
            product_title AS "productTitle",
            enabled,
            status
          FROM card_delivery_items
          WHERE id = $1
        `,
        [deliveryId],
      );
      const delivery = deliveryResult.rows[0] as
        | {
            id: number;
            productTitle: string;
            enabled: number;
            status: string;
          }
        | undefined;
      if (!delivery) {
        await client.query('ROLLBACK');
        transactionOpen = false;
        return null;
      }

      const nextEnabled = delivery.enabled ? 0 : 1;
      const nextStatus = nextEnabled && delivery.status === '手动下架' ? '销售中' : delivery.status;
      const now = format(new Date(), 'yyyy-MM-dd HH:mm:ss');

      await client.query(
        `
          UPDATE card_delivery_items
          SET
            enabled = $1,
            status = $2,
            updated_at = $3
          WHERE id = $4
        `,
        [nextEnabled, nextStatus, now, deliveryId],
      );

      await this.insertWorkspaceLog(
        client,
        featureKey,
        'delivery',
        `${delivery.productTitle}${nextEnabled ? '已启用发货设置' : '已停用发货设置'}`,
        nextEnabled
          ? '商品重新加入自动发货链路。'
          : '商品已从自动发货链路中移出，等待人工复核。',
        now,
      );
      await this.touchWorkspace(client, featureKey, now);

      await client.query('COMMIT');
      transactionOpen = false;
      return { enabled: Boolean(nextEnabled) };
    } catch (error) {
      if (transactionOpen) {
        await client.query('ROLLBACK');
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async toggleCardComboStatus(featureKey: string, comboId: number) {
    if (featureKey !== 'card-combos') {
      return null;
    }

    const client = await this.pool.connect();
    let transactionOpen = false;
    try {
      await client.query('BEGIN');
      transactionOpen = true;

      const comboResult = await client.query(
        `
          SELECT
            id,
            combo_name AS "comboName",
            status
          FROM card_combos
          WHERE id = $1
        `,
        [comboId],
      );
      const combo = comboResult.rows[0] as
        | {
            id: number;
            comboName: string;
            status: string;
          }
        | undefined;
      if (!combo) {
        await client.query('ROLLBACK');
        transactionOpen = false;
        return null;
      }

      const nextStatus = combo.status === '销售中' ? '手动下架' : '销售中';
      const now = format(new Date(), 'yyyy-MM-dd HH:mm:ss');

      await client.query(
        `
          UPDATE card_combos
          SET
            status = $1,
            updated_at = $2
          WHERE id = $3
        `,
        [nextStatus, now, comboId],
      );

      await this.insertWorkspaceLog(
        client,
        featureKey,
        'combo',
        `${combo.comboName}状态已更新`,
        `组合状态已切换为${nextStatus}。`,
        now,
      );
      await this.touchWorkspace(client, featureKey, now);

      await client.query('COMMIT');
      transactionOpen = false;
      return { status: nextStatus };
    } catch (error) {
      if (transactionOpen) {
        await client.query('ROLLBACK');
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async toggleCardTemplateRandom(featureKey: string, templateId: number) {
    if (featureKey !== 'card-templates') {
      return null;
    }

    const client = await this.pool.connect();
    let transactionOpen = false;
    try {
      await client.query('BEGIN');
      transactionOpen = true;

      const templateResult = await client.query(
        `
          SELECT
            id,
            template_name AS "templateName",
            random_enabled AS "randomEnabled"
          FROM card_templates
          WHERE id = $1
        `,
        [templateId],
      );
      const template = templateResult.rows[0] as
        | {
            id: number;
            templateName: string;
            randomEnabled: number;
          }
        | undefined;
      if (!template) {
        await client.query('ROLLBACK');
        transactionOpen = false;
        return null;
      }

      const nextEnabled = template.randomEnabled ? 0 : 1;
      const now = format(new Date(), 'yyyy-MM-dd HH:mm:ss');

      await client.query(
        `
          UPDATE card_templates
          SET
            random_enabled = $1,
            updated_at = $2
          WHERE id = $3
        `,
        [nextEnabled, now, templateId],
      );

      await this.insertWorkspaceLog(
        client,
        featureKey,
        'template',
        `${template.templateName}${nextEnabled ? '已加入' : '已移出'}随机模板列表`,
        nextEnabled ? '后续发货时可随机抽取该模板。' : '该模板已停止参与随机发货。',
        now,
      );
      await this.touchWorkspace(client, featureKey, now);

      await client.query('COMMIT');
      transactionOpen = false;
      return { randomEnabled: Boolean(nextEnabled) };
    } catch (error) {
      if (transactionOpen) {
        await client.query('ROLLBACK');
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async restoreCardType(featureKey: string, cardTypeId: number) {
    if (featureKey !== 'card-trash') {
      return null;
    }

    const client = await this.pool.connect();
    let transactionOpen = false;
    try {
      await client.query('BEGIN');
      transactionOpen = true;

      const cardType = await this.getCardTypeBase(client, cardTypeId);
      if (!cardType || !cardType.isDeleted) {
        await client.query('ROLLBACK');
        transactionOpen = false;
        return null;
      }

      const now = format(new Date(), 'yyyy-MM-dd HH:mm:ss');
      await client.query(
        `
          UPDATE card_types
          SET
            is_deleted = 0,
            deleted_at = NULL,
            deleted_by = NULL,
            updated_at = $1
          WHERE id = $2
        `,
        [now, cardTypeId],
      );

      await this.insertWorkspaceLog(
        client,
        featureKey,
        'recovery',
        `${cardType.typeName} restored`,
        'Card type was restored from trash.',
        now,
      );
      await this.insertWorkspaceLog(
        client,
        'card-types',
        'inventory',
        `${cardType.typeName} restored to inventory`,
        'Trash recovery was synced back to card type management.',
        now,
      );
      await this.touchWorkspace(client, featureKey, now);
      await this.touchWorkspace(client, 'card-types', now);

      await client.query('COMMIT');
      transactionOpen = false;
      return { restored: true };
    } catch (error) {
      if (transactionOpen) {
        await client.query('ROLLBACK');
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async importCardInventory(featureKey: string, cardTypeId: number, lines: string[]) {
    if (featureKey !== 'card-delivery') {
      return null;
    }

    const client = await this.pool.connect();
    let transactionOpen = false;
    try {
      await client.query('BEGIN');
      transactionOpen = true;

      const cardType = await this.getCardTypeBase(client, cardTypeId);
      if (!cardType) {
        await client.query('ROLLBACK');
        transactionOpen = false;
        return null;
      }

      const importedAt = format(new Date(), 'yyyy-MM-dd HH:mm:ss');
      const sourceLabel = '工作台导入';
      const normalizedLines =
        lines.length > 0 ? lines : this.generateCardImportLines(cardType, 4, true);

      const batchId = await this.nextTableId(client, 'card_batches');
      const batchNo = `BAT-${format(new Date(importedAt.replace(' ', 'T')), 'yyyyMMddHHmmss')}-${randomUUID()
        .slice(0, 6)
        .toUpperCase()}`;

      await client.query(
        `
          INSERT INTO card_batches (
            id,
            card_type_id,
            batch_no,
            source_label,
            imported_count,
            duplicate_count,
            invalid_count,
            disabled_count,
            available_count,
            imported_at,
            created_at,
            updated_at
          )
          VALUES ($1, $2, $3, $4, 0, 0, 0, 0, 0, $5, $5, $5)
        `,
        [batchId, cardTypeId, batchNo, sourceLabel, importedAt],
      );

      let importedCount = 0;
      let duplicateCount = 0;
      let invalidCount = 0;
      for (const line of normalizedLines) {
        const parsed = this.parseCardImportLine(cardType, line);
        if (!parsed) {
          invalidCount += 1;
          continue;
        }

        try {
          const itemId = await this.nextTableId(client, 'card_inventory_items');
          await client.query(
            `
              INSERT INTO card_inventory_items (
                id,
                card_type_id,
                batch_id,
                card_no,
                card_secret,
                card_masked,
                item_status,
                imported_at,
                updated_at
              )
              VALUES ($1, $2, $3, $4, $5, $6, 'available', $7, $7)
            `,
            [itemId, cardTypeId, batchId, parsed.cardNo, parsed.cardSecret, parsed.cardMasked, importedAt],
          );
          importedCount += 1;
        } catch {
          duplicateCount += 1;
        }
      }

      const inventorySummary = await this.refreshCardStockAlert(client, cardTypeId, importedAt);
      await client.query(
        `
          UPDATE card_batches
          SET
            imported_count = $1,
            duplicate_count = $2,
            invalid_count = $3,
            disabled_count = $4,
            available_count = $5,
            updated_at = $6
          WHERE id = $7
        `,
        [
          importedCount,
          duplicateCount,
          invalidCount,
          0,
          inventorySummary?.availableCount ?? importedCount,
          importedAt,
          batchId,
        ],
      );

      await this.insertWorkspaceLog(
        client,
        featureKey,
        'inventory_import',
        `${cardType.typeName} inventory imported`,
        `Imported ${importedCount}, duplicate ${duplicateCount}, invalid ${invalidCount}.`,
        importedAt,
      );
      await this.touchWorkspace(client, 'card-types', importedAt);
      await this.touchWorkspace(client, 'card-records', importedAt);

      await client.query('COMMIT');
      transactionOpen = false;
      return {
        success: true,
        batchId,
        batchNo,
        importedCount,
        duplicateCount,
        invalidCount,
        availableCount: inventorySummary?.availableCount ?? importedCount,
      };
    } catch (error) {
      if (transactionOpen) {
        await client.query('ROLLBACK');
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async toggleCardInventorySample(featureKey: string, cardTypeId: number) {
    if (!['card-delivery', 'card-types'].includes(featureKey)) {
      return null;
    }

    const client = await this.pool.connect();
    let transactionOpen = false;
    try {
      await client.query('BEGIN');
      transactionOpen = true;

      const rowResult = await client.query(
        `
          SELECT
            id,
            card_masked AS "cardMasked",
            item_status AS "itemStatus"
          FROM card_inventory_items
          WHERE card_type_id = $1
            AND item_status IN ('disabled', 'available')
          ORDER BY
            CASE WHEN item_status = 'disabled' THEN 0 ELSE 1 END,
            id ASC
          LIMIT 1
        `,
        [cardTypeId],
      );
      const row = rowResult.rows[0] as
        | {
            id: number;
            cardMasked: string;
            itemStatus: string;
          }
        | undefined;
      if (!row) {
        await client.query('ROLLBACK');
        transactionOpen = false;
        return null;
      }

      const nextStatus = row.itemStatus === 'disabled' ? 'available' : 'disabled';
      const now = format(new Date(), 'yyyy-MM-dd HH:mm:ss');
      await client.query(
        `
          UPDATE card_inventory_items
          SET
            item_status = $1,
            disabled_reason = $2,
            updated_at = $3
          WHERE id = $4
        `,
        [nextStatus, nextStatus === 'disabled' ? 'Disabled from workspace console.' : null, now, row.id],
      );

      const alert = await this.refreshCardStockAlert(client, cardTypeId, now);
      const actionText = nextStatus === 'disabled' ? 'disabled' : 'restored';
      await this.insertWorkspaceLog(
        client,
        featureKey,
        'inventory_status',
        `Sample card ${actionText}`,
        `${row.cardMasked} switched to ${nextStatus}.`,
        now,
      );
      await this.touchWorkspace(client, featureKey, now);
      if (featureKey !== 'card-types') {
        await this.touchWorkspace(client, 'card-types', now);
      }

      await client.query('COMMIT');
      transactionOpen = false;
      return {
        success: true,
        itemId: row.id,
        itemStatus: nextStatus,
        currentStock: alert?.availableCount ?? 0,
      };
    } catch (error) {
      if (transactionOpen) {
        await client.query('ROLLBACK');
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async queueCardFulfillment(featureKey: string, orderId: number) {
    if (featureKey !== 'card-delivery') {
      return null;
    }

    const now = format(new Date(), 'yyyy-MM-dd HH:mm:ss');
    const client = await this.pool.connect();
    let transactionOpen = false;
    try {
      await client.query('BEGIN');
      transactionOpen = true;

      const context = await this.getCardFulfillmentContext(client, orderId);
      if (!context?.cardTypeId) {
        await client.query('ROLLBACK');
        transactionOpen = false;
        return null;
      }

      const existingOutboundResult = await client.query(
        `
          SELECT
            cor.id,
            cor.outbound_no AS "outboundNo",
            cor.outbound_status AS "outboundStatus",
            cor.attempt_no AS "attemptNo",
            cii.card_masked AS "cardMasked"
          FROM card_outbound_records cor
          INNER JOIN card_inventory_items cii ON cii.id = cor.inventory_item_id
          WHERE cor.order_id = $1
            AND cor.outbound_status IN ('sent', 'resent')
          ORDER BY cor.id DESC
          LIMIT 1
        `,
        [orderId],
      );
      const existingOutbound = existingOutboundResult.rows[0] as
        | {
            id: number;
            outboundNo: string;
            outboundStatus: string;
            attemptNo: number;
            cardMasked: string;
          }
        | undefined;
      if (existingOutbound) {
        await client.query('COMMIT');
        transactionOpen = false;
        return {
          success: true,
          accepted: false,
          queued: false,
          idempotent: true,
          jobStatus: 'success' as const,
          outboundRecord: existingOutbound,
        };
      }

      const jobId = await this.ensureCardDeliveryJobRecord(client, orderId, context.cardTypeId, 'auto_fulfill', now);
      const existingJobResult = await client.query(
        `
          SELECT job_status AS "jobStatus"
          FROM card_delivery_jobs
          WHERE id = $1
        `,
        [jobId],
      );
      const existingJobStatus = String(existingJobResult.rows[0]?.jobStatus ?? '');

      await client.query(
        `
          UPDATE card_delivery_jobs
          SET
            job_status = 'pending',
            error_message = NULL,
            updated_at = $1
          WHERE id = $2
        `,
        [now, jobId],
      );
      await this.insertWorkspaceLog(
        client,
        featureKey,
        'delivery_queued',
        `${context.orderNo} queued for card fulfillment`,
        `Task #${jobId} will be executed by the background worker.`,
        now,
      );
      await this.touchWorkspace(client, featureKey, now);
      await this.touchWorkspace(client, 'card-records', now);

      await client.query('COMMIT');
      transactionOpen = false;
      return {
        success: true,
        accepted: true,
        queued: true,
        idempotent: existingJobStatus === 'pending',
        jobId,
        jobStatus: 'pending' as const,
      };
    } catch (error) {
      if (transactionOpen) {
        await client.query('ROLLBACK');
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async queueCardDeliveryJob(featureKey: string, jobId: number) {
    if (featureKey !== 'card-delivery') {
      return null;
    }

    const client = await this.pool.connect();
    let transactionOpen = false;
    try {
      await client.query('BEGIN');
      transactionOpen = true;

      const rowResult = await client.query(
        `
          SELECT
            cdj.id,
            cdj.order_id AS "orderId",
            cdj.job_type AS "jobType",
            cdj.job_status AS "jobStatus",
            cdj.related_outbound_record_id AS "relatedOutboundRecordId",
            o.order_no AS "orderNo"
          FROM card_delivery_jobs cdj
          INNER JOIN orders o ON o.id = cdj.order_id
          WHERE cdj.id = $1
        `,
        [jobId],
      );
      const row = rowResult.rows[0] as
        | {
            id: number;
            orderId: number;
            jobType: 'auto_fulfill' | 'manual_resend';
            jobStatus: string;
            relatedOutboundRecordId: number | null;
            orderNo: string;
          }
        | undefined;
      if (!row) {
        await client.query('ROLLBACK');
        transactionOpen = false;
        return null;
      }

      if (row.jobType === 'auto_fulfill') {
        await client.query('ROLLBACK');
        transactionOpen = false;
        return await this.queueCardFulfillment(featureKey, row.orderId);
      }

      const now = format(new Date(), 'yyyy-MM-dd HH:mm:ss');
      await client.query(
        `
          UPDATE card_delivery_jobs
          SET
            job_status = 'pending',
            error_message = NULL,
            updated_at = $1
          WHERE id = $2
        `,
        [now, row.id],
      );
      await this.insertWorkspaceLog(
        client,
        featureKey,
        'delivery_resend_queued',
        `${row.orderNo} queued for card resend`,
        `Resend task #${row.id} will be executed by the background worker.`,
        now,
      );
      await this.touchWorkspace(client, featureKey, now);
      await this.touchWorkspace(client, 'card-records', now);

      await client.query('COMMIT');
      transactionOpen = false;
      return {
        success: true,
        accepted: true,
        queued: true,
        idempotent: row.jobStatus === 'pending',
        jobId: row.id,
        jobStatus: 'pending' as const,
        relatedOutboundRecordId: row.relatedOutboundRecordId,
      };
    } catch (error) {
      if (transactionOpen) {
        await client.query('ROLLBACK');
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async queueCardOutboundResend(featureKey: string, outboundRecordId: number) {
    if (featureKey !== 'card-records') {
      return null;
    }

    const now = format(new Date(), 'yyyy-MM-dd HH:mm:ss');
    const client = await this.pool.connect();
    let transactionOpen = false;
    try {
      await client.query('BEGIN');
      transactionOpen = true;

      const rowResult = await client.query(
        `
          SELECT
            cor.id,
            cor.order_id AS "orderId",
            cor.card_type_id AS "cardTypeId",
            cor.outbound_no AS "outboundNo",
            cor.outbound_status AS "outboundStatus",
            o.order_no AS "orderNo"
          FROM card_outbound_records cor
          INNER JOIN orders o ON o.id = cor.order_id
          WHERE cor.id = $1
        `,
        [outboundRecordId],
      );
      const row = rowResult.rows[0] as
        | {
            id: number;
            orderId: number;
            cardTypeId: number;
            outboundNo: string;
            outboundStatus: string;
            orderNo: string;
          }
        | undefined;
      if (!row || ['recycled', 'revoked'].includes(String(row.outboundStatus ?? ''))) {
        await client.query('ROLLBACK');
        transactionOpen = false;
        return null;
      }

      const nextJobId = await this.nextTableId(client, 'card_delivery_jobs');
      await client.query(
        `
          INSERT INTO card_delivery_jobs (
            id,
            order_id,
            card_type_id,
            job_type,
            job_status,
            attempt_count,
            related_outbound_record_id,
            created_at,
            updated_at
          ) VALUES (
            $1, $2, $3, 'manual_resend', 'pending', 0, $4, $5, $5
          )
        `,
        [nextJobId, row.orderId, row.cardTypeId, row.id, now],
      );
      await this.insertWorkspaceLog(
        client,
        featureKey,
        'delivery_resend_queued',
        `${row.orderNo} queued for card resend`,
        `Resend task #${nextJobId} was created from outbound ${row.outboundNo}.`,
        now,
      );
      await this.touchWorkspace(client, featureKey, now);
      await this.touchWorkspace(client, 'card-delivery', now);

      await client.query('COMMIT');
      transactionOpen = false;
      return {
        success: true,
        accepted: true,
        queued: true,
        idempotent: false,
        jobId: nextJobId,
        relatedOutboundRecordId: row.id,
        outboundNo: row.outboundNo,
      };
    } catch (error) {
      if (transactionOpen) {
        await client.query('ROLLBACK');
      }
      throw error;
    } finally {
      client.release();
    }
  }

  private createDashboardFallback(): DashboardResponse {
    return {
      range: {
        startDate: '',
        endDate: '',
        preset: 'last30Days',
      },
      summary: [],
      modules: {
        todayCards: [],
        businessCards: {
          productStats: [],
          orderStats: [],
          afterSaleStats: [],
        },
      },
      trend: [],
      sourceDistribution: [],
      orderStatusDistribution: [],
      topProducts: [],
      filters: {
        stores: [],
        products: [],
        categories: [],
        sources: [],
      },
    };
  }

  private matchOpenPlatformIpRule(ruleValue: string, ipAddress: string) {
    const escaped = ruleValue
      .trim()
      .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*');
    const pattern = new RegExp(`^${escaped}$`);
    return pattern.test(ipAddress.trim());
  }

  private async getOpenPlatformAppSecret(secretSettingKey: string) {
    const result = await this.pool.query(
      `
        SELECT value_encrypted AS "valueEncrypted"
        FROM secure_settings
        WHERE key = $1
        LIMIT 1
      `,
      [secretSettingKey],
    );
    const row = result.rows[0] as { valueEncrypted?: string } | undefined;
    if (!row?.valueEncrypted) {
      return null;
    }

    return decryptSecret(row.valueEncrypted, appConfig.secureConfigSecret);
  }

  private async getAiServiceSettingsRow() {
    const rowResult = await this.pool.query(
      `
        SELECT
          ai_enabled AS "aiEnabled",
          auto_reply_enabled AS "autoReplyEnabled",
          faq_enabled AS "faqEnabled",
          order_query_enabled AS "orderQueryEnabled",
          after_sale_suggestion_enabled AS "afterSaleSuggestionEnabled",
          high_risk_manual_only AS "highRiskManualOnly",
          boundary_note AS "boundaryNote",
          sensitive_words_text AS "sensitiveWordsText",
          updated_at AS "updatedAt"
        FROM ai_service_settings
        WHERE id = 1
      `,
    );
    const row = rowResult.rows[0];
    if (!row) {
      return null;
    }

    const secureSettingResult = await this.pool.query(
      `
        SELECT value_masked AS "maskedValue"
        FROM secure_settings
        WHERE key = 'openai_api_key'
        LIMIT 1
      `,
    );
    const secureSetting = secureSettingResult.rows[0] as { maskedValue?: string } | undefined;

    return {
      aiEnabled: Boolean(row.aiEnabled),
      autoReplyEnabled: Boolean(row.autoReplyEnabled),
      faqEnabled: Boolean(row.faqEnabled),
      orderQueryEnabled: Boolean(row.orderQueryEnabled),
      afterSaleSuggestionEnabled: Boolean(row.afterSaleSuggestionEnabled),
      highRiskManualOnly: Boolean(row.highRiskManualOnly),
      boundaryNote: String(row.boundaryNote ?? ''),
      sensitiveWordsText: String(row.sensitiveWordsText ?? ''),
      modelKeyMasked: secureSetting?.maskedValue ?? 'not configured',
      updatedAt: String(row.updatedAt ?? ''),
    };
  }

  private async getOpenPlatformSettingsRow() {
    const result = await this.pool.query(
      `
        SELECT
          webhook_base_url AS "webhookBaseUrl",
          notify_email AS "notifyEmail",
          published_version AS "publishedVersion",
          default_rate_limit_per_minute AS "defaultRateLimitPerMinute",
          signature_ttl_seconds AS "signatureTtlSeconds",
          whitelist_enforced AS "whitelistEnforced"
        FROM open_platform_settings
        WHERE id = 1
      `,
    );
    const row = result.rows[0];
    if (!row) {
      return null;
    }

    return {
      webhookBaseUrl: String(row.webhookBaseUrl ?? ''),
      notifyEmail: String(row.notifyEmail ?? ''),
      publishedVersion: String(row.publishedVersion ?? 'v2'),
      defaultRateLimitPerMinute: toNumber(row.defaultRateLimitPerMinute),
      signatureTtlSeconds: toNumber(row.signatureTtlSeconds),
      whitelistEnforced: Boolean(row.whitelistEnforced),
    };
  }

  private async upsertSecureSetting(
    client: pg.PoolClient,
    key: string,
    description: string,
    value: string,
    updatedByUserId: number | null,
    now: string,
  ) {
    const encryptedValue = encryptSecret(value, appConfig.secureConfigSecret);
    const maskedValue = maskSecret(value);
    await client.query(
      `
        INSERT INTO secure_settings (key, description, value_encrypted, value_masked, updated_by, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (key) DO UPDATE SET
          description = EXCLUDED.description,
          value_encrypted = EXCLUDED.value_encrypted,
          value_masked = EXCLUDED.value_masked,
          updated_by = EXCLUDED.updated_by,
          updated_at = EXCLUDED.updated_at
      `,
      [key, description, encryptedValue, maskedValue, updatedByUserId, now],
    );
    return { maskedValue };
  }

  private maskSecret(value: string) {
    if (!value) {
      return 'not configured';
    }

    if (value.length <= 6) {
      return `${value.slice(0, 1)}***${value.slice(-1)}`;
    }

    return `${value.slice(0, 3)}***${value.slice(-3)}`;
  }

  private getSystemAlertTypeText(alertType: string) {
    return (
      {
        api_failure: '接口失败',
        delivery_failure: '发货失败',
        inventory_abnormal: '库存异常',
        store_offline: '店铺掉线',
      }[alertType] ?? alertType
    );
  }

  private async nextTableId(
    queryable: pg.Pool | pg.PoolClient,
    tableName:
      | 'ai_bargain_logs'
      | 'ai_bargain_sessions'
      | 'ai_bargain_strategies'
      | 'ai_service_conversations'
      | 'ai_service_messages'
      | 'ai_service_takeovers'
      | 'audit_logs'
      | 'card_delivery_jobs'
      | 'card_batches'
      | 'card_inventory_items'
      | 'customers'
      | 'fund_reconciliations'
      | 'fund_withdrawals'
      | 'managed_stores'
      | 'store_credential_events'
      | 'store_owner_accounts'
      | 'store_platform_credentials'
      | 'workspace_logs'
      | 'workspace_tasks'
      | 'system_backup_runs'
      | 'system_log_archives'
      | 'system_recovery_drills'
      | 'card_batches'
      | 'card_inventory_items'
      | 'open_platform_apps'
      | 'open_platform_call_logs'
      | 'open_platform_whitelist_rules'
      | 'order_events'
      | 'store_credential_events'
      | 'store_owner_accounts',
  ) {
    const result = await queryable.query(
      `SELECT COALESCE(MAX(id), 0) + 1 AS "nextId" FROM ${tableName}`,
    );
    return Math.max(1, toNumber(result.rows[0]?.nextId));
  }
}
