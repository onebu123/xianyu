import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

import Database from 'better-sqlite3';
import {
  addMinutes,
  addDays,
  differenceInCalendarDays,
  endOfDay,
  format,
  isValid,
  parseISO,
  startOfDay,
  subDays,
} from 'date-fns';

import { decryptSecret, encryptSecret, hashPassword, maskSecret } from './auth.js';
import { createSqliteBackup, restoreSqliteBackup } from './backup-utils.js';
import { CURRENT_SCHEMA_VERSION } from './db-ops.js';
import { OrderReadRepository } from './order-read-repository.js';
import { StoreAccessReadRepository } from './store-access-read-repository.js';
import { StoreAccessWriteRepository } from './store-access-write-repository.js';
import type {
  BootstrapAdminConfig,
  DatabaseInitializeOptions,
  FilterOptions,
  PaginationParams,
  QueryFilters,
  StoreAuthIntegrationMode,
  SystemUserRecord,
  SystemUserRole,
  SystemUserStatus,
} from './types.js';
import { systemUserRoles } from './access-control.js';
import {
  cardComboSeeds,
  cardDeliverySeeds,
  cardRecordSeeds,
  cardTemplateSeeds,
  cardTypeSeeds,
  fundAccountSeed,
  fundAgentSeeds,
  fundBillSeeds,
  fundDepositSeeds,
  fundOrderSeeds,
  fundWithdrawalSeeds,
} from './workspace-business-data.js';
import { getWorkspaceDefinition, workspaceDefinitions } from './workspace-config.js';
import { appConfig } from './config.js';
import {
  parseStoreAuthSessionIdFromState,
  resolveStoreAuthProviderPlan,
  validateStoreAuthProviderState,
} from './store-auth-providers.js';
import type { DirectChargeCallbackPayload } from './direct-charge-adapters.js';
import { getDirectChargeAdapter } from './direct-charge-adapters.js';
import type {
  SupplySourceCallbackPayload,
  SupplySourceRefundPayload,
  SupplySourceSyncType,
} from './source-system-adapters.js';
import { getSupplySourceAdapter } from './source-system-adapters.js';
import type { XianyuWebBargainSession, XianyuWebSocketAuthCache } from './xianyu-web-session.js';

type SqlParams = Record<string, string | number>;

interface DateRange {
  start: Date;
  end: Date;
  startIso: string;
  endIso: string;
  previousStartIso: string;
  previousEndIso: string;
  dayCount: number;
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
  mainStatus: OrderMainStatus;
  paymentStatus: OrderPaymentStatus;
  deliveryStatus: OrderDeliveryStatus;
  orderStatus: string;
  afterSaleStatus: string;
  paidAt: string;
  completedAt: string | null;
  deliveryHours: number;
  isNewCustomer: number;
  fulfillmentType: OrderFulfillmentType;
  fulfillmentQueue: OrderFulfillmentQueue;
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
  caseType: AfterSaleCaseType;
  caseStatus: AfterSaleCaseStatus;
  priority: string;
  latestResult: string | null;
  createdAt: string;
  deadlineAt: string;
  refundStatus: AfterSaleRefundStatus | null;
  requestedAmount: number | null;
  approvedAmount: number | null;
  resendStatus: AfterSaleResendStatus | null;
  disputeStatus: AfterSaleDisputeStatus | null;
  compensationAmount: number | null;
}

interface ReportSnapshot {
  orders: ReportOrderRow[];
  cases: ReportCaseRow[];
  metrics: MetricSummary;
  storeStats: Array<{
    storeId: number;
    storeName: string;
    orderCount: number;
    salesAmount: number;
    refundAmount: number;
    netSalesAmount: number;
    grossProfit: number;
    grossMargin: number;
    completedOrders: number;
    afterSaleCases: number;
    successFulfillmentCount: number;
    manualReviewCount: number;
    successFulfillmentRate: number;
    averageDeliveryHours: number;
  }>;
  productStats: Array<{
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
    grossMargin: number;
    afterSaleCases: number;
    successFulfillmentRate: number;
  }>;
  orderStats: {
    overview: Array<{ key: string; label: string; value: number; unit: string; description: string }>;
    statusDistribution: Array<{ status: string; label: string; orderCount: number }>;
    sourceDistribution: Array<{ source: string; orderCount: number; salesAmount: number }>;
    fulfillmentDistribution: Array<{ queue: string; label: string; orderCount: number }>;
  };
  afterSaleStats: {
    overview: Array<{ key: string; label: string; value: number; unit: string; description: string }>;
    typeDistribution: Array<{
      caseType: AfterSaleCaseType;
      caseTypeText: string;
      caseCount: number;
      resolvedCount: number;
      timeoutCount: number;
      refundAmount: number;
      compensationAmount: number;
    }>;
    statusDistribution: Array<{
      caseStatus: AfterSaleCaseStatus;
      caseStatusText: string;
      caseCount: number;
    }>;
  };
  trend: Array<{
    reportDate: string;
    grossAmount: number;
    receivedAmount: number;
    refundAmount: number;
    netProfit: number;
    orderCount: number;
    afterSaleCaseCount: number;
  }>;
}

interface SeedProduct {
  id: number;
  sku: string;
  name: string;
  category: string;
  price: number;
  cost: number;
  stock: number;
  storeId: number;
}

interface WorkspaceSummaryRow {
  label: string;
  value: number;
  unit: string;
  meta: string;
}

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
type OrderMainStatus = 'paid' | 'processing' | 'fulfilled' | 'completed' | 'after_sale' | 'closed';
type OrderPaymentStatus = 'paid' | 'refunded_partial' | 'refunded_full';
type OrderDeliveryStatus = 'pending' | 'shipped' | 'delivered' | 'manual_review';
type OrderFulfillmentType = 'standard' | 'card' | 'direct_charge';
type OrderFulfillmentQueue = 'pending' | 'processing' | 'success' | 'failed' | 'manual_review';
type AfterSaleCaseType = 'refund' | 'resend' | 'dispute';
type AfterSaleCaseStatus =
  | 'pending_review'
  | 'processing'
  | 'waiting_execute'
  | 'resolved'
  | 'rejected';
type AfterSaleRefundStatus = 'pending_review' | 'approved' | 'rejected' | 'refunded';
type AfterSaleResendStatus =
  | 'requested'
  | 'approved'
  | 'processing'
  | 'succeeded'
  | 'failed'
  | 'rejected';
type AfterSaleDisputeStatus =
  | 'open'
  | 'processing'
  | 'buyer_win'
  | 'seller_win'
  | 'refunded'
  | 'resent';
type AfterSaleReminderType = 'pending' | 'timeout';
type AfterSaleReminderStatus = 'active' | 'resolved';
type CardInventoryStatus = 'available' | 'locked' | 'sold' | 'disabled';
type CardDeliveryJobStatus = 'pending' | 'success' | 'failed' | 'recycled';
type CardOutboundStatus = 'sent' | 'resent' | 'recycled' | 'revoked';
type CardRecycleAction = 'recycle' | 'revoke';
type DirectChargeSupplierStatus = 'online' | 'warning' | 'offline';
type DirectChargeJobStatus =
  | 'pending_dispatch'
  | 'processing'
  | 'success'
  | 'failed'
  | 'manual_review';
type DirectChargeCallbackStatus = 'pending' | 'verified' | 'rejected' | 'timeout';
type DirectChargeVerificationStatus = 'pending' | 'passed' | 'failed';
type DirectChargeReconcileStatus = 'pending' | 'matched' | 'anomaly';
type SupplySourceSystemStatus = 'online' | 'warning' | 'offline';
type SupplySourceSyncMode = 'scheduled' | 'manual';
type SupplySourceSyncRunStatus = 'success' | 'failed' | 'partial';
type SupplySourceProductSyncStatus = 'synced' | 'warning' | 'anomaly';
type SupplySourceOrderStatus = 'pending_push' | 'processing' | 'success' | 'failed' | 'manual_review';
type SupplySourceVerificationStatus = 'pending' | 'passed' | 'failed';
type SupplySourceRefundStatus = 'processing' | 'resolved' | 'failed';
type SupplySourceReconcileStatus = 'pending' | 'matched' | 'anomaly';

interface OrderListRow {
  id: number;
  orderNo: string;
  storeId: number;
  storeName: string;
  productId: number;
  productName: string;
  productSku: string;
  category: string;
  customerId: number;
  customerName: string;
  quantity: number;
  paidAmount: number;
  discountAmount: number;
  refundAmount: number;
  mainStatus: OrderMainStatus;
  deliveryStatus: OrderDeliveryStatus;
  paymentStatus: OrderPaymentStatus;
  orderStatus: string;
  afterSaleStatus: string;
  source: string;
  paidAt: string;
  shippedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
  latestEventAt: string | null;
}

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

const CARD_LOW_STOCK_THRESHOLD = 40;
const DIRECT_CHARGE_TIMEOUT_MINUTES = 15;
const CARD_VIRTUAL_PRODUCTS = [
  {
    deliveryId: 1,
    productId: 101,
    storeId: 1,
    sku: 'CARD-001',
    name: '王者荣耀 648 点券直充',
    category: '游戏充值',
    price: 68.8,
    cost: 48.5,
    stock: 999,
  },
  {
    deliveryId: 2,
    productId: 102,
    storeId: 4,
    sku: 'CARD-002',
    name: '爱奇艺会员周卡',
    category: '影音会员',
    price: 19.9,
    cost: 12.2,
    stock: 999,
  },
  {
    deliveryId: 3,
    productId: 103,
    storeId: 2,
    sku: 'CARD-003',
    name: '网易云黑胶月卡',
    category: '音乐会员',
    price: 14.5,
    cost: 9.1,
    stock: 999,
  },
  {
    deliveryId: 4,
    productId: 104,
    storeId: 1,
    sku: 'CARD-004',
    name: 'Switch 在线会员季卡',
    category: '游戏会员',
    price: 92,
    cost: 69,
    stock: 999,
  },
] as const;

const DIRECT_CHARGE_SUPPLIER_SEEDS = [
  {
    id: 1,
    supplierKey: 'sim-topup',
    supplierName: '标准模拟直充供应商',
    adapterKey: 'sim-topup',
    accountName: 'SIM-PRIMARY',
    endpointUrl: 'https://supplier.example.com/direct-charge/callback',
    callbackToken: 'sim-topup-callback-token',
    enabled: 1,
    supplierStatus: 'online' as DirectChargeSupplierStatus,
    balance: 26880,
    successRate: 98.6,
  },
  {
    id: 2,
    supplierKey: 'sim-topup-backup',
    supplierName: '标准模拟备用供应商',
    adapterKey: 'sim-topup',
    accountName: 'SIM-BACKUP',
    endpointUrl: 'https://backup-supplier.example.com/direct-charge/callback',
    callbackToken: 'sim-topup-backup-token',
    enabled: 0,
    supplierStatus: 'warning' as DirectChargeSupplierStatus,
    balance: 9680,
    successRate: 94.2,
  },
] as const;

const DIRECT_CHARGE_PRODUCT_SEEDS = [
  {
    itemId: 1,
    productId: 201,
    supplierId: 1,
    storeId: 2,
    sku: 'TOPUP-001',
    name: '移动话费直充 50 元',
    category: '话费直充',
    price: 50,
    cost: 47.5,
    stock: 999,
    targetType: 'mobile',
    zoneRequired: 0,
    faceValue: 50,
    enabled: 1,
    status: '销售中',
  },
  {
    itemId: 2,
    productId: 202,
    supplierId: 1,
    storeId: 1,
    sku: 'TOPUP-002',
    name: '王者荣耀点券代充 60 元',
    category: '游戏直充',
    price: 60,
    cost: 56,
    stock: 999,
    targetType: 'game_account',
    zoneRequired: 1,
    faceValue: 60,
    enabled: 1,
    status: '销售中',
  },
  {
    itemId: 3,
    productId: 203,
    supplierId: 1,
    storeId: 4,
    sku: 'TOPUP-003',
    name: '腾讯视频月卡直充',
    category: '影音直充',
    price: 25,
    cost: 21.9,
    stock: 999,
    targetType: 'mobile',
    zoneRequired: 0,
    faceValue: 25,
    enabled: 1,
    status: '销售中',
  },
  {
    itemId: 4,
    productId: 204,
    supplierId: 2,
    storeId: 2,
    sku: 'TOPUP-004',
    name: 'Steam 钱包直充 100 元',
    category: '游戏直充',
    price: 100,
    cost: 96,
    stock: 999,
    targetType: 'game_account',
    zoneRequired: 1,
    faceValue: 100,
    enabled: 0,
    status: '手动下架',
  },
] as const;

const DIRECT_CHARGE_DEMO_ORDER_SEEDS = [
  {
    orderNoSuffix: '99001',
    itemId: 1,
    customerId: 5,
    source: '客服跟进',
    paidAmount: 50,
    targetAccount: '13800138000',
    targetZone: null,
    dayShift: -1,
    hour: 10,
    minute: 18,
    seedMode: 'pending_dispatch' as const,
  },
  {
    orderNoSuffix: '99002',
    itemId: 2,
    customerId: 6,
    source: '自然成交',
    paidAmount: 60,
    targetAccount: 'player-2333',
    targetZone: '微信-安卓-5区',
    dayShift: -1,
    hour: 11,
    minute: 46,
    seedMode: 'processing_timeout' as const,
  },
  {
    orderNoSuffix: '99003',
    itemId: 3,
    customerId: 7,
    source: '短视频导流',
    paidAmount: 25,
    targetAccount: '13800138123',
    targetZone: null,
    dayShift: 0,
    hour: 9,
    minute: 12,
    seedMode: 'success' as const,
  },
  {
    orderNoSuffix: '99004',
    itemId: 2,
    customerId: 8,
    source: '复购推荐',
    paidAmount: 60,
    targetAccount: 'player-9988',
    targetZone: 'QQ-安卓-9区',
    dayShift: 0,
    hour: 9,
    minute: 38,
    seedMode: 'failed' as const,
  },
] as const;

const SUPPLY_SOURCE_SYSTEM_SEEDS = [
  {
    id: 1,
    systemKey: 'own-supply-core',
    systemName: '自有货源主站',
    adapterKey: 'sim-own-supply',
    endpointUrl: 'https://supply.example.com/source/callback',
    callbackToken: 'own-supply-core-token',
    enabled: 1,
    systemStatus: 'online' as SupplySourceSystemStatus,
    syncMode: 'scheduled' as SupplySourceSyncMode,
    syncIntervalMinutes: 60,
    orderPushEnabled: 1,
    refundCallbackEnabled: 1,
  },
  {
    id: 2,
    systemKey: 'own-supply-legacy',
    systemName: '旧版货源中台',
    adapterKey: 'sim-own-supply',
    endpointUrl: 'https://legacy-supply.example.com/source/callback',
    callbackToken: 'own-supply-legacy-token',
    enabled: 1,
    systemStatus: 'warning' as SupplySourceSystemStatus,
    syncMode: 'manual' as SupplySourceSyncMode,
    syncIntervalMinutes: 180,
    orderPushEnabled: 1,
    refundCallbackEnabled: 1,
  },
] as const;

const SUPPLY_SOURCE_ORDER_SEEDS = [
  {
    taskNoSuffix: '77001',
    systemId: 1,
    platformProductId: 5,
    customerId: 9,
    source: '供应链推单',
    paidAmount: 359,
    quantity: 1,
    dayShift: -1,
    hour: 13,
    minute: 20,
    seedMode: 'pending_push' as const,
  },
  {
    taskNoSuffix: '77002',
    systemId: 1,
    platformProductId: 9,
    customerId: 10,
    source: '活动分发',
    paidAmount: 239,
    quantity: 1,
    dayShift: 0,
    hour: 10,
    minute: 5,
    seedMode: 'processing' as const,
  },
  {
    taskNoSuffix: '77003',
    systemId: 2,
    platformProductId: 13,
    customerId: 11,
    source: '店铺直发',
    paidAmount: 139,
    quantity: 1,
    dayShift: 0,
    hour: 11,
    minute: 40,
    seedMode: 'delivered' as const,
  },
] as const;

const SUPPLY_SOURCE_PRODUCT_SEEDS = [
  {
    systemId: 1,
    externalProductId: 'OWN-3C-001',
    externalSku: 'OWN-3C-001-A',
    externalProductName: '自营蓝牙降噪耳机',
    platformProductId: 5,
    category: '3C数码',
    sourcePrice: 278,
    sourceStock: 46,
    syncStatus: 'synced' as SupplySourceProductSyncStatus,
    enabled: 1,
  },
  {
    systemId: 1,
    externalProductId: 'OWN-JJ-001',
    externalSku: 'OWN-JJ-001-A',
    externalProductName: '仓配极简收纳柜',
    platformProductId: 9,
    category: '家居',
    sourcePrice: 168,
    sourceStock: 18,
    syncStatus: 'warning' as SupplySourceProductSyncStatus,
    enabled: 1,
  },
  {
    systemId: 2,
    externalProductId: 'OWN-MZ-001',
    externalSku: 'OWN-MZ-001-A',
    externalProductName: '香水小样套盒货源包',
    platformProductId: 13,
    category: '美妆',
    sourcePrice: 101,
    sourceStock: 12,
    syncStatus: 'anomaly' as SupplySourceProductSyncStatus,
    enabled: 1,
  },
] as const;

const CARD_DEMO_ORDER_SEEDS = [
  {
    orderNoSuffix: '98001',
    productId: 101,
    customerId: 1,
    source: '客服跟进',
    quantity: 1,
    paidAmount: 68.8,
    discountAmount: 0,
    orderStatus: 'pending_shipment',
    afterSaleStatus: 'none',
    refundAmount: 0,
    dayShift: -1,
    hour: 10,
    minute: 15,
  },
  {
    orderNoSuffix: '98002',
    productId: 102,
    customerId: 2,
    source: '自然成交',
    quantity: 1,
    paidAmount: 19.9,
    discountAmount: 0,
    orderStatus: 'pending_shipment',
    afterSaleStatus: 'none',
    refundAmount: 0,
    dayShift: -1,
    hour: 11,
    minute: 5,
  },
  {
    orderNoSuffix: '98003',
    productId: 103,
    customerId: 3,
    source: '短视频导流',
    quantity: 1,
    paidAmount: 14.5,
    discountAmount: 0,
    orderStatus: 'pending_shipment',
    afterSaleStatus: 'none',
    refundAmount: 0,
    dayShift: -1,
    hour: 14,
    minute: 25,
  },
  {
    orderNoSuffix: '98004',
    productId: 104,
    customerId: 4,
    source: '复购推荐',
    quantity: 1,
    paidAmount: 92,
    discountAmount: 0,
    orderStatus: 'pending_shipment',
    afterSaleStatus: 'none',
    refundAmount: 0,
    dayShift: 0,
    hour: 9,
    minute: 40,
  },
] as const;

const STORE_SEEDS = [
  { id: 1, name: '潮玩优选店', manager: '陈北川' },
  { id: 2, name: '3C数码仓', manager: '宋知言' },
  { id: 3, name: '家居清仓号', manager: '杨砚青' },
  { id: 4, name: '美妆折扣馆', manager: '林时安' },
];

const PRODUCT_SEEDS: SeedProduct[] = [
  {
    id: 1,
    sku: 'CW-001',
    name: '限量潮玩盲盒',
    category: '潮玩',
    price: 149,
    cost: 72,
    stock: 82,
    storeId: 1,
  },
  {
    id: 2,
    sku: 'CW-002',
    name: '联名手办套装',
    category: '潮玩',
    price: 299,
    cost: 155,
    stock: 44,
    storeId: 1,
  },
  {
    id: 3,
    sku: 'CW-003',
    name: '收藏级徽章礼盒',
    category: '潮玩',
    price: 89,
    cost: 38,
    stock: 65,
    storeId: 1,
  },
  {
    id: 4,
    sku: 'CW-004',
    name: 'IP周边福袋',
    category: '潮玩',
    price: 199,
    cost: 91,
    stock: 28,
    storeId: 1,
  },
  {
    id: 5,
    sku: '3C-001',
    name: '蓝牙降噪耳机',
    category: '3C数码',
    price: 359,
    cost: 211,
    stock: 58,
    storeId: 2,
  },
  {
    id: 6,
    sku: '3C-002',
    name: '二手平板电脑',
    category: '3C数码',
    price: 999,
    cost: 760,
    stock: 16,
    storeId: 2,
  },
  {
    id: 7,
    sku: '3C-003',
    name: '机械键盘',
    category: '3C数码',
    price: 269,
    cost: 141,
    stock: 34,
    storeId: 2,
  },
  {
    id: 8,
    sku: '3C-004',
    name: '便携显示器',
    category: '3C数码',
    price: 639,
    cost: 487,
    stock: 21,
    storeId: 2,
  },
  {
    id: 9,
    sku: 'JJ-001',
    name: '极简收纳柜',
    category: '家居',
    price: 239,
    cost: 126,
    stock: 73,
    storeId: 3,
  },
  {
    id: 10,
    sku: 'JJ-002',
    name: '北欧落地灯',
    category: '家居',
    price: 329,
    cost: 174,
    stock: 31,
    storeId: 3,
  },
  {
    id: 11,
    sku: 'JJ-003',
    name: '床边推车',
    category: '家居',
    price: 119,
    cost: 53,
    stock: 88,
    storeId: 3,
  },
  {
    id: 12,
    sku: 'JJ-004',
    name: '可折叠小茶几',
    category: '家居',
    price: 179,
    cost: 92,
    stock: 39,
    storeId: 3,
  },
  {
    id: 13,
    sku: 'MZ-001',
    name: '热门香水小样套盒',
    category: '美妆',
    price: 139,
    cost: 62,
    stock: 69,
    storeId: 4,
  },
  {
    id: 14,
    sku: 'MZ-002',
    name: '护肤精华双支装',
    category: '美妆',
    price: 259,
    cost: 147,
    stock: 27,
    storeId: 4,
  },
  {
    id: 15,
    sku: 'MZ-003',
    name: '彩妆礼盒',
    category: '美妆',
    price: 179,
    cost: 81,
    stock: 49,
    storeId: 4,
  },
  {
    id: 16,
    sku: 'MZ-004',
    name: '品牌面膜组合',
    category: '美妆',
    price: 99,
    cost: 41,
    stock: 91,
    storeId: 4,
  },
];

const SOURCES = ['自然成交', '客服跟进', '复购推荐', '短视频导流'];
const PROVINCES = ['广东', '浙江', '江苏', '上海', '北京', '四川', '湖北', '山东', '福建', '河南'];
const CUSTOMER_PREFIXES = [
  '安',
  '北',
  '晨',
  '大',
  '凡',
  '顾',
  '禾',
  '景',
  '乐',
  '沐',
  '宁',
  '时',
  '晚',
  '言',
  '知',
];
const CUSTOMER_SUFFIXES = ['青', '舟', '岚', '宁', '安', '夏', '川', '笙', '辰', '霖', '棠', '语'];
const ORDER_STATUSES = ['pending_shipment', 'shipped', 'completed'];
const ORDER_MAIN_STATUSES = ['paid', 'processing', 'fulfilled', 'completed', 'after_sale', 'closed'];
const ORDER_SORT_FIELDS = {
  paidAt: 'o.paid_at',
  paidAmount: 'o.paid_amount',
  completedAt: 'o.completed_at',
  updatedAt: 'o.updated_at',
} as const;
const DEMO_SECURE_SETTINGS = [
  {
    key: 'openai_api_key',
    description: 'AI 客服与议价模型调用密钥',
    value: 'sk-demo-openai-private-key',
  },
  {
    key: 'xianyu_callback_secret',
    description: '闲鱼授权与回调签名密钥',
    value: 'xianyu-demo-callback-secret',
  },
  {
    key: 'supplier_webhook_token',
    description: '货源系统回调校验令牌',
    value: 'supplier-demo-webhook-token',
  },
];

function createRandom(seed: number) {
  let value = seed;
  return () => {
    value = (value * 16807) % 2147483647;
    return (value - 1) / 2147483646;
  };
}

function chooseRandom<T>(items: T[], random: () => number): T {
  return items[Math.floor(random() * items.length)];
}

function toPercentage(value: number) {
  return Number(value.toFixed(2));
}

function formatDateTime(date: Date, hour: number, minute: number, dayShift = 0) {
  const shifted = addDays(date, dayShift);
  return `${format(shifted, 'yyyy-MM-dd')} ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00`;
}

function formatShiftedDateTime(date: Date, dayShift: number, hour: number, minute: number) {
  return formatDateTime(date, hour, minute, dayShift);
}

function formatNullableShiftedDateTime(
  date: Date,
  dayShift: number | null,
  hour: number | null,
  minute: number | null,
) {
  if (dayShift === null || hour === null || minute === null) {
    return null;
  }
  return formatShiftedDateTime(date, dayShift, hour, minute);
}

export class StatisticsDatabase {
  private db: Database.Database;
  private usersTokenVersionColumnEnsured = false;
  private readonly orderReadRepository: OrderReadRepository;
  private readonly storeAccessReadRepository: StoreAccessReadRepository;
  private readonly storeAccessWriteRepository: StoreAccessWriteRepository;

  constructor(private readonly dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.orderReadRepository = new OrderReadRepository(() => this.db, {
      resolveDateRange: (filters) => this.resolveDateRange(filters),
      buildOrderWhere: (filters, range) => this.buildOrderWhere(filters, range),
      resolveOrderSort: (sortBy, sortOrder) => this.resolveOrderSort(sortBy, sortOrder),
      loadOrderFulfillmentMeta: (orderIds) => this.loadOrderFulfillmentMeta(orderIds),
      getOrderMainStatusText: (status) => this.getOrderMainStatusText(status),
      getOrderDeliveryStatusText: (status) => this.getOrderDeliveryStatusText(status),
      getOrderPaymentStatusText: (status) => this.getOrderPaymentStatusText(status),
      getOrderFulfillmentTypeText: (type) => this.getOrderFulfillmentTypeText(type),
      getOrderFulfillmentQueueText: (queue) => this.getOrderFulfillmentQueueText(queue),
    });
    this.storeAccessReadRepository = new StoreAccessReadRepository(
      () => this.db,
      appConfig.secureConfigSecret,
    );
    this.storeAccessWriteRepository = new StoreAccessWriteRepository(
      () => this.db,
      appConfig.secureConfigSecret,
    );
  }

  private usesDefaultDataRoot() {
    return path.resolve(this.dbPath) === path.resolve(appConfig.dbPath);
  }

  private getBackupRootDir() {
    return this.usesDefaultDataRoot()
      ? appConfig.backupDir
      : path.join(path.dirname(this.dbPath), 'backups');
  }

  private getLogArchiveRootDir() {
    return this.usesDefaultDataRoot()
      ? path.join(appConfig.logDir, 'archive')
      : path.join(path.dirname(this.dbPath), 'log-archives');
  }

  private getRecoveryDrillRootDir() {
    return path.join(this.getBackupRootDir(), 'recovery-drills');
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
    payloadType: 'provider_callback' | 'web_session_capture' | 'legacy_scrubbed';
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

  private hasSensitiveStoreAuthPayloadText(payloadText: string | null | undefined) {
    const normalized = payloadText?.trim().toLowerCase() ?? '';
    if (!normalized) {
      return false;
    }

    return [
      'cookietext',
      'access_token',
      'refresh_token',
      '_m_h5_tk',
      'cookie2=',
      'unb=',
      'cna=',
      'set-cookie',
    ].some((keyword) => normalized.includes(keyword));
  }

  private scrubSensitiveStoreAuthPayloads() {
    const rows = this.db
      .prepare(
        `
          SELECT
            session_id AS sessionId,
            provider_payload_text AS providerPayloadText,
            provider_access_token_masked AS providerAccessTokenMasked,
            provider_access_token_received_at AS providerAccessTokenReceivedAt
          FROM store_auth_sessions
          WHERE provider_payload_text IS NOT NULL
            AND TRIM(provider_payload_text) <> ''
        `,
      )
      .all() as Array<{
      sessionId: string;
      providerPayloadText: string;
      providerAccessTokenMasked: string | null;
      providerAccessTokenReceivedAt: string | null;
    }>;

    if (rows.length === 0) {
      return;
    }

    const dirtyRows = rows.filter((row) =>
      this.hasSensitiveStoreAuthPayloadText(row.providerPayloadText),
    );
    if (dirtyRows.length === 0) {
      return;
    }

    const updateStatement = this.db.prepare(
      `
        UPDATE store_auth_sessions
        SET provider_payload_text = @providerPayloadText
        WHERE session_id = @sessionId
      `,
    );
    const now = format(new Date(), 'yyyy-MM-dd HH:mm:ss');
    const scrubRows = this.db.transaction(
      (
        records: Array<{
          sessionId: string;
          providerPayloadText: string;
          providerAccessTokenMasked: string | null;
          providerAccessTokenReceivedAt: string | null;
        }>,
      ) => {
        for (const row of records) {
          updateStatement.run({
            sessionId: row.sessionId,
            providerPayloadText: this.buildStoreAuthPayloadSummary({
              payloadType: 'legacy_scrubbed',
              capturedAt: row.providerAccessTokenReceivedAt ?? now,
              maskedValue: row.providerAccessTokenMasked,
              rawText: row.providerPayloadText,
              note: '历史原始凭据已自动脱敏清理。',
            }),
          });
        }
      },
    );

    scrubRows(dirtyRows);
  }

  initialize(options: DatabaseInitializeOptions = {}) {
    const forceReseed = options.forceReseed ?? false;
    const runtimeMode = options.runtimeMode ?? 'demo';
    const seedDemoData = options.seedDemoData ?? runtimeMode === 'demo';

    if (forceReseed) {
      this.db.close();
      if (fs.existsSync(this.dbPath)) {
        fs.rmSync(this.dbPath, { force: true });
      }
      this.db = new Database(this.dbPath);
      this.db.pragma('journal_mode = WAL');
    }

    this.createTables();
    this.runSchemaMigrations();
    this.db.pragma(`user_version = ${CURRENT_SCHEMA_VERSION}`);
    this.scrubSensitiveStoreAuthPayloads();

    const state = this.db
      .prepare(
        `
        SELECT
          (SELECT COUNT(*) FROM users) AS userCount,
          (SELECT COUNT(*) FROM orders) AS orderCount
      `,
      )
      .get() as { userCount: number; orderCount: number };

    const isEmptyDatabase = state.userCount === 0 && state.orderCount === 0;

    if (seedDemoData && isEmptyDatabase) {
      this.seedDemoData();
      this.ensureDemoUsers();
      this.ensureSecureSettings(true);
      this.ensureWorkspaceData(true);
      this.ensureWorkspaceBusinessData();
      this.ensureCardDeliveryEngineData(true);
      this.ensureDirectChargeEngineData(true);
      this.ensureStoreManagementData(true);
      this.ensureOrderCenterData(true);
      this.ensureAfterSaleCenterData(true);
      this.ensureAiServiceData(true);
      this.ensureAiBargainData(true);
      this.ensureSupplySourceIntegrationData(true);
      this.ensureSystemMonitoringData(new Date(), true);
      return;
    }

    if (state.userCount === 0) {
      this.ensureBootstrapAdmin(options.bootstrapAdmin);
    }

    if (seedDemoData) {
      this.refreshDemoTimelineIfNeeded();
      this.ensureDemoUsers();
      this.ensureSecureSettings(true);
      this.ensureWorkspaceData(true);
      this.ensureWorkspaceBusinessData();
      this.ensureCardDeliveryEngineData(true);
      this.ensureDirectChargeEngineData(true);
      this.ensureStoreManagementData(true);
      this.ensureOrderCenterData(true);
      this.ensureAfterSaleCenterData(true);
      this.ensureAiServiceData(true);
      this.ensureAiBargainData(true);
      this.ensureSupplySourceIntegrationData(true);
      return;
    }

    this.ensureSecureSettings(false);
    this.ensureWorkspaceData(false);
    this.ensureCardDeliveryEngineData(false);
    this.ensureDirectChargeEngineData(false);
    this.ensureStoreManagementData(false);
    this.ensureOrderCenterData(false);
    this.ensureAfterSaleCenterData(false);
    this.ensureAiServiceData(false);
    this.ensureAiBargainData(false);
    this.ensureSupplySourceIntegrationData(false);
  }

  close() {
    this.db.close();
  }

  private ensureBootstrapAdmin(config: BootstrapAdminConfig | null | undefined) {
    const userCount = this.db.prepare('SELECT COUNT(*) AS count FROM users').get() as { count: number };
    if (userCount.count > 0) {
      return;
    }

    if (!config?.username || !config.password) {
      throw new Error(
        '非 demo 模式首次初始化必须提供 APP_INIT_ADMIN_USERNAME 和 APP_INIT_ADMIN_PASSWORD。',
      );
    }

    this.db
      .prepare(
        `
        INSERT INTO users (username, display_name, role, password_hash)
        VALUES (?, ?, 'admin', ?)
      `,
      )
      .run(config.username, config.displayName, hashPassword(config.password));
  }

  private runSchemaMigrations() {
    const hasTable = (tableName: string) => {
      const row = this.db
        .prepare(
          `
            SELECT name
            FROM sqlite_master
            WHERE type = 'table' AND name = ?
          `,
        )
        .get(tableName) as { name: string } | undefined;
      return Boolean(row);
    };

    const ensureColumn = (tableName: string, columnName: string, definition: string) => {
      if (!hasTable(tableName)) {
        return;
      }

      const columns = this.db
        .prepare(`PRAGMA table_info(${tableName})`)
        .all() as Array<{ name: string }>;
      if (!columns.some((column) => column.name === columnName)) {
        this.db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${definition}`);
      }
    };

    const ensureTable = (sql: string) => {
      this.db.exec(sql);
    };

    ensureColumn('users', 'status', "status TEXT NOT NULL DEFAULT 'active'");
    ensureColumn('users', 'created_at', 'created_at TEXT');
    ensureColumn('users', 'updated_at', 'updated_at TEXT');
    ensureColumn('users', 'last_login_at', 'last_login_at TEXT');

    ensureColumn('orders', 'main_status', "main_status TEXT NOT NULL DEFAULT 'paid'");
    ensureColumn('orders', 'payment_status', "payment_status TEXT NOT NULL DEFAULT 'paid'");
    ensureColumn('orders', 'delivery_status', "delivery_status TEXT NOT NULL DEFAULT 'pending'");
    ensureColumn('orders', 'buyer_note', "buyer_note TEXT NOT NULL DEFAULT ''");
    ensureColumn('orders', 'seller_remark', "seller_remark TEXT NOT NULL DEFAULT ''");
    ensureColumn('orders', 'created_at', 'created_at TEXT');
    ensureColumn('orders', 'updated_at', 'updated_at TEXT');
    ensureColumn('ai_service_conversations', 'item_main_pic', 'item_main_pic TEXT');
    ensureColumn('ai_service_messages', 'external_message_id', 'external_message_id TEXT');
    ensureColumn('ai_service_messages', 'sender_name', "sender_name TEXT NOT NULL DEFAULT ''");
    ensureColumn('ai_service_messages', 'sender_user_id', 'sender_user_id TEXT');
    ensureTable(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_service_messages_conversation_external
        ON ai_service_messages(conversation_id, external_message_id)
        WHERE external_message_id IS NOT NULL;
    `);

    ensureColumn('card_delivery_items', 'product_id', 'product_id INTEGER');
    ensureColumn('fund_bills', 'store_id', 'store_id INTEGER');
    ensureColumn('fund_withdrawals', 'store_id', 'store_id INTEGER');
    ensureColumn('fund_deposits', 'store_id', 'store_id INTEGER');
    ensureColumn('fund_orders', 'store_id', 'store_id INTEGER');

    ensureTable(`
      CREATE TABLE IF NOT EXISTS order_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id INTEGER NOT NULL,
        line_no INTEGER NOT NULL,
        product_id INTEGER,
        product_name_snapshot TEXT NOT NULL,
        sku_snapshot TEXT NOT NULL,
        category_snapshot TEXT NOT NULL,
        quantity INTEGER NOT NULL,
        unit_price REAL NOT NULL,
        paid_amount REAL NOT NULL,
        delivery_status TEXT NOT NULL,
        after_sale_status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS order_payments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id INTEGER NOT NULL,
        payment_no TEXT NOT NULL UNIQUE,
        payment_channel TEXT NOT NULL,
        payment_status TEXT NOT NULL,
        gross_amount REAL NOT NULL,
        discount_amount REAL NOT NULL,
        paid_amount REAL NOT NULL,
        paid_at TEXT NOT NULL,
        settled_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS order_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        event_title TEXT NOT NULL,
        event_detail TEXT NOT NULL,
        operator_name TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_orders_paid_at ON orders(paid_at);
      CREATE INDEX IF NOT EXISTS idx_orders_store_paid_at ON orders(store_id, paid_at);
      CREATE INDEX IF NOT EXISTS idx_orders_main_status ON orders(main_status);
      CREATE INDEX IF NOT EXISTS idx_orders_delivery_status ON orders(delivery_status);
      CREATE INDEX IF NOT EXISTS idx_order_items_order_id ON order_items(order_id);
      CREATE INDEX IF NOT EXISTS idx_order_payments_order_id ON order_payments(order_id);
      CREATE INDEX IF NOT EXISTS idx_order_events_order_id_created_at ON order_events(order_id, created_at);
    `);

    ensureTable(`
      CREATE TABLE IF NOT EXISTS customer_external_refs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider TEXT NOT NULL,
        external_customer_id TEXT NOT NULL,
        customer_id INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(provider, external_customer_id),
        FOREIGN KEY(customer_id) REFERENCES customers(id)
      );

      CREATE INDEX IF NOT EXISTS idx_customer_external_refs_customer_id
        ON customer_external_refs(customer_id);
    `);

    ensureTable(`
      CREATE TABLE IF NOT EXISTS fund_settlements (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        payment_id INTEGER NOT NULL UNIQUE,
        order_id INTEGER NOT NULL,
        store_id INTEGER NOT NULL,
        settlement_no TEXT NOT NULL UNIQUE,
        order_no TEXT NOT NULL,
        payment_no TEXT NOT NULL,
        gross_amount REAL NOT NULL,
        received_amount REAL NOT NULL,
        fee_amount REAL NOT NULL,
        settled_amount REAL NOT NULL,
        settlement_status TEXT NOT NULL,
        settled_at TEXT NOT NULL,
        note TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS fund_refunds (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        case_id INTEGER NOT NULL UNIQUE,
        order_id INTEGER NOT NULL,
        store_id INTEGER NOT NULL,
        refund_no TEXT NOT NULL UNIQUE,
        case_no TEXT NOT NULL,
        order_no TEXT NOT NULL,
        requested_amount REAL NOT NULL,
        approved_amount REAL NOT NULL,
        refunded_amount REAL NOT NULL DEFAULT 0,
        refund_status TEXT NOT NULL,
        refund_channel TEXT NOT NULL DEFAULT '原路退回',
        reviewed_at TEXT,
        refunded_at TEXT,
        note TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS fund_reconciliations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ref_type TEXT NOT NULL,
        ref_id INTEGER NOT NULL,
        store_id INTEGER,
        reconcile_no TEXT NOT NULL UNIQUE,
        bill_category TEXT NOT NULL,
        platform_amount REAL NOT NULL,
        ledger_amount REAL NOT NULL,
        diff_amount REAL NOT NULL,
        reconcile_status TEXT NOT NULL,
        manual_status INTEGER NOT NULL DEFAULT 0,
        note TEXT NOT NULL DEFAULT '',
        reviewed_by TEXT,
        reviewed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(ref_type, ref_id)
      );

      CREATE INDEX IF NOT EXISTS idx_fund_bills_store_time ON fund_bills(store_id, trade_time DESC);
      CREATE INDEX IF NOT EXISTS idx_fund_withdrawals_store_time ON fund_withdrawals(store_id, trade_time DESC);
      CREATE INDEX IF NOT EXISTS idx_fund_deposits_store_time ON fund_deposits(store_id, trade_time DESC);
      CREATE INDEX IF NOT EXISTS idx_fund_orders_store_time ON fund_orders(store_id, paid_at DESC);
      CREATE INDEX IF NOT EXISTS idx_fund_settlements_store_time ON fund_settlements(store_id, settled_at DESC);
      CREATE INDEX IF NOT EXISTS idx_fund_refunds_store_time ON fund_refunds(store_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_fund_reconciliations_store_time ON fund_reconciliations(store_id, updated_at DESC);
    `);

    ensureTable(`
      CREATE TABLE IF NOT EXISTS after_sale_cases (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        case_no TEXT NOT NULL UNIQUE,
        order_id INTEGER NOT NULL,
        case_type TEXT NOT NULL,
        case_status TEXT NOT NULL,
        priority TEXT NOT NULL DEFAULT 'normal',
        source_channel TEXT NOT NULL DEFAULT 'manual',
        reason TEXT NOT NULL,
        customer_request TEXT NOT NULL DEFAULT '',
        expectation TEXT NOT NULL DEFAULT '',
        latest_result TEXT,
        sla_deadline_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        closed_at TEXT,
        FOREIGN KEY(order_id) REFERENCES orders(id)
      );

      CREATE TABLE IF NOT EXISTS after_sale_refunds (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        case_id INTEGER NOT NULL UNIQUE,
        refund_no TEXT NOT NULL UNIQUE,
        requested_amount REAL NOT NULL,
        approved_amount REAL NOT NULL DEFAULT 0,
        refund_status TEXT NOT NULL,
        review_note TEXT NOT NULL DEFAULT '',
        reviewed_by TEXT,
        reviewed_at TEXT,
        refunded_at TEXT,
        FOREIGN KEY(case_id) REFERENCES after_sale_cases(id)
      );

      CREATE TABLE IF NOT EXISTS after_sale_resends (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        case_id INTEGER NOT NULL UNIQUE,
        resend_no TEXT NOT NULL UNIQUE,
        fulfillment_type TEXT NOT NULL,
        resend_status TEXT NOT NULL,
        request_reason TEXT NOT NULL,
        result_detail TEXT NOT NULL DEFAULT '',
        related_outbound_no TEXT,
        related_task_no TEXT,
        executed_at TEXT,
        completed_at TEXT,
        FOREIGN KEY(case_id) REFERENCES after_sale_cases(id)
      );

      CREATE TABLE IF NOT EXISTS after_sale_disputes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        case_id INTEGER NOT NULL UNIQUE,
        dispute_no TEXT NOT NULL UNIQUE,
        dispute_type TEXT NOT NULL,
        dispute_status TEXT NOT NULL,
        responsibility TEXT NOT NULL DEFAULT '',
        conclusion TEXT NOT NULL DEFAULT '',
        compensation_amount REAL NOT NULL DEFAULT 0,
        concluded_by TEXT,
        concluded_at TEXT,
        FOREIGN KEY(case_id) REFERENCES after_sale_cases(id)
      );

      CREATE TABLE IF NOT EXISTS after_sale_records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        case_id INTEGER NOT NULL,
        record_type TEXT NOT NULL,
        title TEXT NOT NULL,
        detail TEXT NOT NULL,
        operator_name TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY(case_id) REFERENCES after_sale_cases(id)
      );

      CREATE TABLE IF NOT EXISTS after_sale_reminders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        case_id INTEGER NOT NULL,
        reminder_type TEXT NOT NULL,
        reminder_status TEXT NOT NULL,
        title TEXT NOT NULL,
        detail TEXT NOT NULL,
        remind_at TEXT NOT NULL,
        resolved_at TEXT,
        FOREIGN KEY(case_id) REFERENCES after_sale_cases(id)
      );

      CREATE INDEX IF NOT EXISTS idx_after_sale_cases_type_status ON after_sale_cases(case_type, case_status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_after_sale_cases_order_id ON after_sale_cases(order_id);
      CREATE INDEX IF NOT EXISTS idx_after_sale_records_case_id ON after_sale_records(case_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_after_sale_reminders_case_id ON after_sale_reminders(case_id, reminder_status, remind_at DESC);
      CREATE INDEX IF NOT EXISTS idx_after_sale_refunds_status ON after_sale_refunds(refund_status, reviewed_at DESC);
      CREATE INDEX IF NOT EXISTS idx_after_sale_resends_status ON after_sale_resends(resend_status, executed_at DESC);
      CREATE INDEX IF NOT EXISTS idx_after_sale_disputes_status ON after_sale_disputes(dispute_status, concluded_at DESC);
    `);

    ensureTable(`
      CREATE TABLE IF NOT EXISTS card_batches (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        card_type_id INTEGER NOT NULL,
        batch_no TEXT NOT NULL UNIQUE,
        source_label TEXT NOT NULL,
        imported_count INTEGER NOT NULL DEFAULT 0,
        duplicate_count INTEGER NOT NULL DEFAULT 0,
        invalid_count INTEGER NOT NULL DEFAULT 0,
        disabled_count INTEGER NOT NULL DEFAULT 0,
        available_count INTEGER NOT NULL DEFAULT 0,
        imported_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(card_type_id) REFERENCES card_types(id)
      );

      CREATE TABLE IF NOT EXISTS card_inventory_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        card_type_id INTEGER NOT NULL,
        batch_id INTEGER,
        card_no TEXT NOT NULL,
        card_secret TEXT NOT NULL,
        card_masked TEXT NOT NULL,
        item_status TEXT NOT NULL,
        locked_order_id INTEGER,
        locked_at TEXT,
        outbound_record_id INTEGER,
        disabled_reason TEXT,
        imported_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_used_at TEXT,
        UNIQUE(card_type_id, card_no, card_secret),
        FOREIGN KEY(card_type_id) REFERENCES card_types(id),
        FOREIGN KEY(batch_id) REFERENCES card_batches(id),
        FOREIGN KEY(locked_order_id) REFERENCES orders(id)
      );

      CREATE TABLE IF NOT EXISTS card_outbound_records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id INTEGER NOT NULL,
        card_type_id INTEGER NOT NULL,
        inventory_item_id INTEGER NOT NULL,
        outbound_no TEXT NOT NULL UNIQUE,
        outbound_status TEXT NOT NULL,
        attempt_no INTEGER NOT NULL DEFAULT 1,
        parent_outbound_id INTEGER,
        template_id INTEGER,
        message_content TEXT NOT NULL,
        send_channel TEXT NOT NULL,
        reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(order_id) REFERENCES orders(id),
        FOREIGN KEY(card_type_id) REFERENCES card_types(id),
        FOREIGN KEY(inventory_item_id) REFERENCES card_inventory_items(id),
        FOREIGN KEY(parent_outbound_id) REFERENCES card_outbound_records(id),
        FOREIGN KEY(template_id) REFERENCES card_templates(id)
      );

      CREATE TABLE IF NOT EXISTS card_recycle_records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id INTEGER NOT NULL,
        outbound_record_id INTEGER NOT NULL,
        inventory_item_id INTEGER NOT NULL,
        recycle_action TEXT NOT NULL,
        reason TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(order_id) REFERENCES orders(id),
        FOREIGN KEY(outbound_record_id) REFERENCES card_outbound_records(id),
        FOREIGN KEY(inventory_item_id) REFERENCES card_inventory_items(id)
      );

      CREATE TABLE IF NOT EXISTS card_delivery_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id INTEGER NOT NULL,
        card_type_id INTEGER NOT NULL,
        job_type TEXT NOT NULL,
        job_status TEXT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        latest_outbound_record_id INTEGER,
        related_outbound_record_id INTEGER,
        error_message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_attempt_at TEXT,
        FOREIGN KEY(order_id) REFERENCES orders(id),
        FOREIGN KEY(card_type_id) REFERENCES card_types(id),
        FOREIGN KEY(latest_outbound_record_id) REFERENCES card_outbound_records(id),
        FOREIGN KEY(related_outbound_record_id) REFERENCES card_outbound_records(id)
      );

      CREATE TABLE IF NOT EXISTS card_stock_alerts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        card_type_id INTEGER NOT NULL UNIQUE,
        alert_level TEXT NOT NULL,
        threshold_value INTEGER NOT NULL,
        current_stock INTEGER NOT NULL,
        status TEXT NOT NULL,
        detail TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(card_type_id) REFERENCES card_types(id)
      );

      CREATE INDEX IF NOT EXISTS idx_card_batches_type_imported_at ON card_batches(card_type_id, imported_at DESC);
      CREATE INDEX IF NOT EXISTS idx_card_inventory_type_status ON card_inventory_items(card_type_id, item_status);
      CREATE INDEX IF NOT EXISTS idx_card_inventory_locked_order ON card_inventory_items(locked_order_id);
      CREATE INDEX IF NOT EXISTS idx_card_outbound_order_created_at ON card_outbound_records(order_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_card_delivery_jobs_status ON card_delivery_jobs(job_status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_card_recycle_outbound_id ON card_recycle_records(outbound_record_id);
    `);

    ensureTable(`
      CREATE TABLE IF NOT EXISTS direct_charge_suppliers (
        id INTEGER PRIMARY KEY,
        supplier_key TEXT NOT NULL UNIQUE,
        supplier_name TEXT NOT NULL,
        adapter_key TEXT NOT NULL,
        account_name TEXT NOT NULL,
        endpoint_url TEXT NOT NULL,
        callback_token TEXT NOT NULL,
        callback_token_masked TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        supplier_status TEXT NOT NULL,
        balance REAL NOT NULL DEFAULT 0,
        success_rate REAL NOT NULL DEFAULT 0,
        timeout_minutes INTEGER NOT NULL DEFAULT 15,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_dispatch_at TEXT,
        last_callback_at TEXT
      );

      CREATE TABLE IF NOT EXISTS direct_charge_items (
        id INTEGER PRIMARY KEY,
        supplier_id INTEGER NOT NULL,
        product_id INTEGER NOT NULL,
        product_title TEXT NOT NULL,
        category TEXT NOT NULL,
        store_name TEXT NOT NULL,
        target_type TEXT NOT NULL,
        zone_required INTEGER NOT NULL DEFAULT 0,
        face_value REAL NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(supplier_id) REFERENCES direct_charge_suppliers(id),
        FOREIGN KEY(product_id) REFERENCES products(id)
      );

      CREATE TABLE IF NOT EXISTS direct_charge_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id INTEGER NOT NULL UNIQUE,
        supplier_id INTEGER NOT NULL,
        item_id INTEGER NOT NULL,
        task_no TEXT NOT NULL UNIQUE,
        supplier_order_no TEXT,
        adapter_key TEXT NOT NULL,
        target_account TEXT NOT NULL,
        target_zone TEXT,
        face_value REAL NOT NULL,
        task_status TEXT NOT NULL,
        supplier_status TEXT,
        callback_status TEXT NOT NULL,
        verification_status TEXT NOT NULL,
        retry_count INTEGER NOT NULL DEFAULT 0,
        max_retry INTEGER NOT NULL DEFAULT 2,
        error_message TEXT,
        result_detail TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_dispatch_at TEXT,
        last_callback_at TEXT,
        timeout_at TEXT,
        manual_reason TEXT,
        FOREIGN KEY(order_id) REFERENCES orders(id),
        FOREIGN KEY(supplier_id) REFERENCES direct_charge_suppliers(id),
        FOREIGN KEY(item_id) REFERENCES direct_charge_items(id)
      );

      CREATE TABLE IF NOT EXISTS direct_charge_callbacks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        supplier_id INTEGER NOT NULL,
        job_id INTEGER,
        order_id INTEGER,
        callback_no TEXT NOT NULL UNIQUE,
        task_no TEXT NOT NULL,
        supplier_order_no TEXT,
        supplier_status TEXT NOT NULL,
        verification_status TEXT NOT NULL,
        mapped_status TEXT,
        callback_token TEXT,
        payload_text TEXT NOT NULL,
        detail TEXT NOT NULL,
        received_at TEXT NOT NULL,
        FOREIGN KEY(supplier_id) REFERENCES direct_charge_suppliers(id),
        FOREIGN KEY(job_id) REFERENCES direct_charge_jobs(id),
        FOREIGN KEY(order_id) REFERENCES orders(id)
      );

      CREATE TABLE IF NOT EXISTS direct_charge_reconciliations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id INTEGER NOT NULL UNIQUE,
        supplier_id INTEGER NOT NULL,
        order_id INTEGER NOT NULL,
        reconcile_status TEXT NOT NULL,
        supplier_status TEXT,
        mapped_status TEXT,
        detail TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(job_id) REFERENCES direct_charge_jobs(id),
        FOREIGN KEY(supplier_id) REFERENCES direct_charge_suppliers(id),
        FOREIGN KEY(order_id) REFERENCES orders(id)
      );

      CREATE INDEX IF NOT EXISTS idx_direct_charge_items_supplier_id ON direct_charge_items(supplier_id);
      CREATE INDEX IF NOT EXISTS idx_direct_charge_jobs_status ON direct_charge_jobs(task_status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_direct_charge_callbacks_job_id ON direct_charge_callbacks(job_id, received_at DESC);
      CREATE INDEX IF NOT EXISTS idx_direct_charge_reconciliations_status ON direct_charge_reconciliations(reconcile_status, updated_at DESC);
    `);

    ensureTable(`
      CREATE TABLE IF NOT EXISTS supply_source_systems (
        id INTEGER PRIMARY KEY,
        system_key TEXT NOT NULL UNIQUE,
        system_name TEXT NOT NULL,
        adapter_key TEXT NOT NULL,
        endpoint_url TEXT NOT NULL,
        callback_token TEXT NOT NULL,
        callback_token_masked TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        system_status TEXT NOT NULL,
        sync_mode TEXT NOT NULL DEFAULT 'manual',
        sync_interval_minutes INTEGER NOT NULL DEFAULT 60,
        order_push_enabled INTEGER NOT NULL DEFAULT 1,
        refund_callback_enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_product_sync_at TEXT,
        last_inventory_sync_at TEXT,
        last_price_sync_at TEXT,
        last_order_push_at TEXT,
        last_callback_at TEXT,
        last_refund_notice_at TEXT
      );

      CREATE TABLE IF NOT EXISTS supply_source_products (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        system_id INTEGER NOT NULL,
        external_product_id TEXT NOT NULL,
        external_sku TEXT NOT NULL,
        external_product_name TEXT NOT NULL,
        platform_product_id INTEGER NOT NULL UNIQUE,
        platform_product_name TEXT NOT NULL,
        store_id INTEGER NOT NULL,
        store_name TEXT NOT NULL,
        category TEXT NOT NULL,
        sale_price REAL NOT NULL,
        source_price REAL NOT NULL,
        source_stock INTEGER NOT NULL,
        sync_status TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        last_sync_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(system_id, external_product_id),
        FOREIGN KEY(system_id) REFERENCES supply_source_systems(id),
        FOREIGN KEY(platform_product_id) REFERENCES products(id)
      );

      CREATE TABLE IF NOT EXISTS supply_source_sync_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        system_id INTEGER NOT NULL,
        sync_type TEXT NOT NULL,
        run_mode TEXT NOT NULL,
        run_status TEXT NOT NULL,
        total_count INTEGER NOT NULL DEFAULT 0,
        success_count INTEGER NOT NULL DEFAULT 0,
        failure_count INTEGER NOT NULL DEFAULT 0,
        detail TEXT NOT NULL,
        created_at TEXT NOT NULL,
        finished_at TEXT NOT NULL,
        FOREIGN KEY(system_id) REFERENCES supply_source_systems(id)
      );

      CREATE TABLE IF NOT EXISTS supply_source_orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        system_id INTEGER NOT NULL,
        mapping_id INTEGER NOT NULL,
        order_id INTEGER NOT NULL UNIQUE,
        task_no TEXT NOT NULL UNIQUE,
        source_order_no TEXT,
        order_status TEXT NOT NULL,
        source_status TEXT,
        verification_status TEXT NOT NULL DEFAULT 'pending',
        retry_count INTEGER NOT NULL DEFAULT 0,
        max_retry INTEGER NOT NULL DEFAULT 2,
        failure_reason TEXT,
        result_detail TEXT,
        pushed_at TEXT,
        callback_at TEXT,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(system_id) REFERENCES supply_source_systems(id),
        FOREIGN KEY(mapping_id) REFERENCES supply_source_products(id),
        FOREIGN KEY(order_id) REFERENCES orders(id)
      );

      CREATE TABLE IF NOT EXISTS supply_source_callbacks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        system_id INTEGER NOT NULL,
        supply_order_id INTEGER,
        order_id INTEGER,
        callback_no TEXT NOT NULL UNIQUE,
        task_no TEXT NOT NULL,
        source_order_no TEXT NOT NULL,
        source_status TEXT NOT NULL,
        verification_status TEXT NOT NULL,
        mapped_status TEXT,
        detail TEXT NOT NULL,
        received_at TEXT NOT NULL,
        FOREIGN KEY(system_id) REFERENCES supply_source_systems(id),
        FOREIGN KEY(supply_order_id) REFERENCES supply_source_orders(id),
        FOREIGN KEY(order_id) REFERENCES orders(id)
      );

      CREATE TABLE IF NOT EXISTS supply_source_refund_notices (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        system_id INTEGER NOT NULL,
        order_id INTEGER NOT NULL,
        case_id INTEGER,
        notice_no TEXT NOT NULL UNIQUE,
        source_order_no TEXT NOT NULL,
        refund_status TEXT NOT NULL,
        detail TEXT NOT NULL,
        notified_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(system_id) REFERENCES supply_source_systems(id),
        FOREIGN KEY(order_id) REFERENCES orders(id),
        FOREIGN KEY(case_id) REFERENCES after_sale_cases(id)
      );

      CREATE TABLE IF NOT EXISTS supply_source_reconciliations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        system_id INTEGER NOT NULL,
        mapping_id INTEGER,
        order_id INTEGER,
        reconcile_type TEXT NOT NULL,
        reconcile_no TEXT NOT NULL UNIQUE,
        platform_ref TEXT NOT NULL,
        source_ref TEXT NOT NULL,
        platform_price REAL,
        source_price REAL,
        platform_stock INTEGER,
        source_stock INTEGER,
        platform_amount REAL,
        source_amount REAL,
        diff_amount REAL NOT NULL DEFAULT 0,
        reconcile_status TEXT NOT NULL,
        detail TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(system_id) REFERENCES supply_source_systems(id),
        FOREIGN KEY(mapping_id) REFERENCES supply_source_products(id),
        FOREIGN KEY(order_id) REFERENCES orders(id)
      );

      CREATE INDEX IF NOT EXISTS idx_supply_source_products_system_id ON supply_source_products(system_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_supply_source_sync_runs_system_id ON supply_source_sync_runs(system_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_supply_source_orders_status ON supply_source_orders(order_status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_supply_source_callbacks_system_id ON supply_source_callbacks(system_id, received_at DESC);
      CREATE INDEX IF NOT EXISTS idx_supply_source_refund_notices_system_id ON supply_source_refund_notices(system_id, notified_at DESC);
      CREATE INDEX IF NOT EXISTS idx_supply_source_reconciliations_status ON supply_source_reconciliations(reconcile_status, updated_at DESC);
    `);

    ensureTable(`
      CREATE TABLE IF NOT EXISTS ai_bargain_settings (
        id INTEGER PRIMARY KEY CHECK(id = 1),
        ai_enabled INTEGER NOT NULL DEFAULT 1,
        auto_bargain_enabled INTEGER NOT NULL DEFAULT 1,
        high_risk_manual_only INTEGER NOT NULL DEFAULT 1,
        allow_auto_accept INTEGER NOT NULL DEFAULT 1,
        boundary_note TEXT NOT NULL,
        sensitive_words_text TEXT NOT NULL DEFAULT '',
        blacklist_notice TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL,
        updated_by INTEGER
      );

      CREATE TABLE IF NOT EXISTS ai_bargain_strategies (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        product_id INTEGER,
        store_id INTEGER,
        strategy_name TEXT NOT NULL,
        product_name_snapshot TEXT NOT NULL,
        listed_price REAL NOT NULL,
        min_price REAL NOT NULL,
        target_price REAL NOT NULL,
        step_price REAL NOT NULL,
        max_rounds INTEGER NOT NULL DEFAULT 3,
        enabled INTEGER NOT NULL DEFAULT 1,
        risk_tags_text TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS ai_bargain_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_no TEXT NOT NULL UNIQUE,
        channel TEXT NOT NULL,
        topic TEXT NOT NULL,
        customer_id INTEGER,
        customer_name TEXT NOT NULL,
        store_id INTEGER,
        product_id INTEGER,
        order_id INTEGER,
        strategy_id INTEGER,
        product_name_snapshot TEXT NOT NULL,
        listed_price REAL NOT NULL,
        min_price REAL NOT NULL,
        target_price REAL NOT NULL,
        latest_buyer_offer REAL,
        latest_counter_price REAL,
        current_round INTEGER NOT NULL DEFAULT 0,
        max_rounds INTEGER NOT NULL DEFAULT 3,
        session_status TEXT NOT NULL,
        ai_status TEXT NOT NULL,
        risk_level TEXT NOT NULL,
        risk_reason TEXT NOT NULL DEFAULT '',
        assigned_user_id INTEGER,
        boundary_label TEXT NOT NULL DEFAULT '',
        tags_text TEXT NOT NULL DEFAULT '',
        last_message_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS ai_bargain_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id INTEGER NOT NULL,
        actor_type TEXT NOT NULL,
        action_type TEXT NOT NULL,
        offer_price REAL,
        message_text TEXT NOT NULL,
        related_template_id INTEGER,
        operator_user_id INTEGER,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS ai_bargain_templates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        scene TEXT NOT NULL,
        title TEXT NOT NULL,
        trigger_text TEXT NOT NULL,
        template_content TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS ai_bargain_blacklist (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        customer_id INTEGER,
        customer_name TEXT NOT NULL,
        reason TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_ai_bargain_sessions_status ON ai_bargain_sessions(session_status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_ai_bargain_logs_session ON ai_bargain_logs(session_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_ai_bargain_strategies_product ON ai_bargain_strategies(product_id, enabled);
      CREATE INDEX IF NOT EXISTS idx_ai_bargain_blacklist_customer ON ai_bargain_blacklist(customer_id, enabled);
    `);

    ensureTable(`
      CREATE TABLE IF NOT EXISTS store_owner_accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        platform TEXT NOT NULL,
        owner_name TEXT NOT NULL,
        mobile TEXT NOT NULL,
        login_mode TEXT,
        account_status TEXT NOT NULL,
        last_authorized_at TEXT,
        last_authorized_by INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS store_health_checks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        store_id INTEGER NOT NULL,
        status TEXT NOT NULL,
        detail TEXT NOT NULL,
        checked_at TEXT NOT NULL,
        triggered_by_user_id INTEGER,
        trigger_mode TEXT NOT NULL
      );
    `);

    ensureTable(`
      CREATE TABLE IF NOT EXISTS system_alerts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        alert_key TEXT NOT NULL UNIQUE,
        alert_type TEXT NOT NULL,
        severity TEXT NOT NULL,
        status TEXT NOT NULL,
        source_count INTEGER NOT NULL DEFAULT 0,
        title TEXT NOT NULL,
        detail TEXT NOT NULL,
        first_triggered_at TEXT NOT NULL,
        last_triggered_at TEXT NOT NULL,
        acknowledged_at TEXT,
        resolved_at TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS system_backup_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        backup_no TEXT NOT NULL UNIQUE,
        backup_type TEXT NOT NULL,
        run_status TEXT NOT NULL,
        file_name TEXT NOT NULL,
        file_path TEXT NOT NULL,
        file_size INTEGER NOT NULL DEFAULT 0,
        detail TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        triggered_by_name TEXT
      );

      CREATE TABLE IF NOT EXISTS system_log_archives (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        archive_no TEXT NOT NULL UNIQUE,
        period_start TEXT NOT NULL,
        period_end TEXT NOT NULL,
        log_count INTEGER NOT NULL DEFAULT 0,
        file_name TEXT NOT NULL,
        file_path TEXT NOT NULL,
        archive_status TEXT NOT NULL,
        detail TEXT NOT NULL,
        created_at TEXT NOT NULL,
        triggered_by_name TEXT
      );

      CREATE TABLE IF NOT EXISTS system_recovery_drills (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        drill_no TEXT NOT NULL UNIQUE,
        backup_run_id INTEGER,
        backup_no_snapshot TEXT,
        drill_status TEXT NOT NULL,
        target_path TEXT NOT NULL,
        duration_seconds INTEGER NOT NULL DEFAULT 0,
        detail TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        triggered_by_name TEXT,
        FOREIGN KEY(backup_run_id) REFERENCES system_backup_runs(id)
      );
    `);

    ensureColumn('managed_stores', 'owner_account_id', 'owner_account_id INTEGER');
    ensureColumn('managed_stores', 'created_by_user_id', 'created_by_user_id INTEGER');
    ensureColumn('managed_stores', 'group_name', "group_name TEXT NOT NULL DEFAULT '未分组'");
    ensureColumn('managed_stores', 'tags_text', "tags_text TEXT NOT NULL DEFAULT ''");
    ensureColumn('managed_stores', 'remark', "remark TEXT NOT NULL DEFAULT ''");
    ensureColumn('managed_stores', 'enabled', 'enabled INTEGER NOT NULL DEFAULT 1');
    ensureColumn(
      'managed_stores',
      'connection_status',
      "connection_status TEXT NOT NULL DEFAULT 'pending_activation'",
    );
    ensureColumn(
      'managed_stores',
      'auth_status',
      "auth_status TEXT NOT NULL DEFAULT 'authorized'",
    );
    ensureColumn('managed_stores', 'auth_expires_at', 'auth_expires_at TEXT');
    ensureColumn('managed_stores', 'last_sync_at', 'last_sync_at TEXT');
    ensureColumn(
      'managed_stores',
      'health_status',
      "health_status TEXT NOT NULL DEFAULT 'warning'",
    );
    ensureColumn('managed_stores', 'last_health_check_at', 'last_health_check_at TEXT');
    ensureColumn('managed_stores', 'last_health_check_detail', "last_health_check_detail TEXT");
    ensureColumn('managed_stores', 'last_session_id', 'last_session_id TEXT');
    ensureColumn('managed_stores', 'last_reauthorize_at', 'last_reauthorize_at TEXT');
    ensureColumn('managed_stores', 'provider_store_id', 'provider_store_id TEXT');
    ensureColumn('managed_stores', 'provider_user_id', 'provider_user_id TEXT');
    ensureColumn('managed_stores', 'credential_id', 'credential_id INTEGER');
    ensureColumn(
      'managed_stores',
      'profile_sync_status',
      "profile_sync_status TEXT NOT NULL DEFAULT 'pending'",
    );
    ensureColumn('managed_stores', 'profile_sync_error', 'profile_sync_error TEXT');
    ensureColumn('managed_stores', 'last_profile_sync_at', 'last_profile_sync_at TEXT');
    ensureColumn('managed_stores', 'last_verified_at', 'last_verified_at TEXT');

    ensureColumn('store_auth_sessions', 'expires_at', 'expires_at TEXT');
    ensureColumn('store_auth_sessions', 'invalid_reason', 'invalid_reason TEXT');
    ensureColumn('store_auth_sessions', 'store_id', 'store_id INTEGER');
    ensureColumn('store_auth_sessions', 'owner_account_id', 'owner_account_id INTEGER');
    ensureColumn('store_auth_sessions', 'created_by_user_id', 'created_by_user_id INTEGER');
    ensureColumn('store_auth_sessions', 'reauthorize', 'reauthorize INTEGER NOT NULL DEFAULT 0');
    ensureColumn(
      'store_auth_sessions',
      'integration_mode',
      "integration_mode TEXT NOT NULL DEFAULT 'simulated'",
    );
    ensureColumn('store_auth_sessions', 'provider_key', 'provider_key TEXT');
    ensureColumn('store_auth_sessions', 'provider_label', 'provider_label TEXT');
    ensureColumn('store_auth_sessions', 'provider_state', 'provider_state TEXT');
    ensureColumn('store_auth_sessions', 'provider_auth_url', 'provider_auth_url TEXT');
    ensureColumn('store_auth_sessions', 'callback_url', 'callback_url TEXT');
    ensureColumn(
      'store_auth_sessions',
      'provider_access_token_masked',
      'provider_access_token_masked TEXT',
    );
    ensureColumn(
      'store_auth_sessions',
      'provider_access_token_received_at',
      'provider_access_token_received_at TEXT',
    );
    ensureColumn('store_auth_sessions', 'provider_payload_text', 'provider_payload_text TEXT');
    ensureColumn(
      'store_auth_sessions',
      'next_step',
      "next_step TEXT NOT NULL DEFAULT 'manual_complete'",
    );
    ensureColumn('store_auth_sessions', 'callback_received_at', 'callback_received_at TEXT');
    ensureColumn(
      'store_auth_sessions',
      'profile_sync_status',
      "profile_sync_status TEXT NOT NULL DEFAULT 'pending'",
    );
    ensureColumn('store_auth_sessions', 'profile_sync_error', 'profile_sync_error TEXT');
    ensureColumn('store_auth_sessions', 'profile_synced_at', 'profile_synced_at TEXT');
    ensureColumn('store_auth_sessions', 'provider_error_code', 'provider_error_code TEXT');
    ensureColumn('store_auth_sessions', 'provider_error_message', 'provider_error_message TEXT');
    ensureColumn('store_platform_credentials', 'session_id', 'session_id TEXT');
    ensureColumn('store_platform_credentials', 'updated_at', 'updated_at TEXT');
    ensureColumn('store_platform_credentials', 'last_sync_status', "last_sync_status TEXT NOT NULL DEFAULT 'pending_profile_sync'");
    ensureColumn(
      'store_platform_credentials',
      'credential_source',
      "credential_source TEXT NOT NULL DEFAULT 'manual'",
    );
    ensureColumn(
      'store_platform_credentials',
      'risk_level',
      "risk_level TEXT NOT NULL DEFAULT 'pending'",
    );
    ensureColumn('store_platform_credentials', 'risk_reason', "risk_reason TEXT NOT NULL DEFAULT ''");
    ensureColumn('store_platform_credentials', 'verification_url', 'verification_url TEXT');
    ensureColumn('store_platform_credentials', 'last_renewed_at', 'last_renewed_at TEXT');
    ensureColumn(
      'store_platform_credentials',
      'last_renew_status',
      "last_renew_status TEXT NOT NULL DEFAULT ''",
    );

    const now = format(new Date(), 'yyyy-MM-dd HH:mm:ss');
    this.db.prepare(`UPDATE users SET role = 'operator' WHERE role = 'analyst'`).run();
    this.db
      .prepare(
        `
          UPDATE users
          SET
            status = COALESCE(status, 'active'),
            created_at = COALESCE(created_at, @now),
            updated_at = COALESCE(updated_at, created_at, @now)
        `,
      )
      .run({ now });

    this.db
      .prepare(
        `
          UPDATE orders
          SET
            created_at = COALESCE(paid_at, created_at, @now),
            updated_at = COALESCE(completed_at, shipped_at, paid_at, updated_at, @now),
            delivery_status = CASE
              WHEN delivery_status IS NULL OR delivery_status = '' OR delivery_status = 'pending' THEN
                CASE
                  WHEN order_status = 'pending_shipment' THEN 'pending'
                  WHEN order_status = 'shipped' THEN 'shipped'
                  WHEN order_status = 'completed' THEN 'delivered'
                  ELSE 'manual_review'
                END
              ELSE delivery_status
            END,
            payment_status = CASE
              WHEN payment_status IS NULL OR payment_status = '' OR payment_status = 'paid' THEN
                CASE
                  WHEN refund_amount >= paid_amount AND paid_amount > 0 THEN 'refunded_full'
                  WHEN refund_amount > 0 THEN 'refunded_partial'
                  ELSE 'paid'
                END
              ELSE payment_status
            END,
            main_status = CASE
              WHEN main_status IS NULL OR main_status = '' OR main_status = 'paid' THEN
                CASE
                  WHEN after_sale_status = 'processing' THEN 'after_sale'
                  WHEN order_status = 'pending_shipment' THEN 'paid'
                  WHEN order_status = 'shipped' THEN 'fulfilled'
                  WHEN order_status = 'completed' THEN 'completed'
                  ELSE 'processing'
                END
              ELSE main_status
            END,
            buyer_note = COALESCE(buyer_note, ''),
            seller_remark = COALESCE(seller_remark, '')
        `,
      )
      .run({ now });

    this.db
      .prepare(
        `
          UPDATE managed_stores
          SET
            group_name = COALESCE(NULLIF(group_name, ''), '未分组'),
            tags_text = COALESCE(tags_text, ''),
            remark = COALESCE(remark, ''),
            enabled = COALESCE(enabled, 1),
            connection_status = COALESCE(
              connection_status,
              CASE
                WHEN activation_status = 'pending_activation' THEN 'pending_activation'
                ELSE 'active'
              END
            ),
            auth_status = COALESCE(auth_status, 'authorized'),
            health_status = COALESCE(
              health_status,
              CASE
                WHEN activation_status = 'pending_activation' THEN 'warning'
                ELSE 'healthy'
              END
            ),
            last_health_check_detail = COALESCE(last_health_check_detail, '')
        `,
      )
      .run();

    this.db
      .prepare(
        `
          UPDATE store_auth_sessions
          SET
            expires_at = COALESCE(expires_at, datetime(created_at, '+15 minutes')),
            reauthorize = COALESCE(reauthorize, 0)
        `,
      )
      .run();
  }

  private ensureDemoUsers() {
    const now = format(new Date(), 'yyyy-MM-dd HH:mm:ss');
    const ensureUser = this.db.prepare(
      `
        INSERT INTO users (
          username,
          display_name,
          role,
          password_hash,
          status,
          created_at,
          updated_at
        )
        VALUES (
          @username,
          @displayName,
          @role,
          @passwordHash,
          'active',
          @now,
          @now
        )
        ON CONFLICT(username) DO UPDATE SET
          display_name = excluded.display_name,
          role = excluded.role,
          status = 'active',
          password_hash = excluded.password_hash,
          updated_at = excluded.updated_at
      `,
    );

    [
      { username: 'admin', displayName: '系统管理员', role: 'admin' as const, password: 'Admin@123456' },
      { username: 'operator', displayName: '运营专员', role: 'operator' as const, password: 'Operator@123456' },
      { username: 'support', displayName: '客服专员', role: 'support' as const, password: 'Support@123456' },
      { username: 'finance', displayName: '财务专员', role: 'finance' as const, password: 'Finance@123456' },
    ].forEach((user) =>
      ensureUser.run({
        ...user,
        now,
        passwordHash: hashPassword(user.password),
      }),
    );

    this.db.prepare(`UPDATE users SET role = 'operator' WHERE username = 'analyst'`).run();
  }

  private ensureSecureSettings(includeSampleData: boolean) {
    if (!includeSampleData) {
      return;
    }

    const row = this.db
      .prepare('SELECT COUNT(*) AS count FROM secure_settings')
      .get() as { count: number };
    if (row.count > 0) {
      return;
    }

    DEMO_SECURE_SETTINGS.forEach((setting) => {
      this.upsertSecureSetting(setting.key, setting.description, setting.value, null);
    });
  }

  getFilterOptions(): FilterOptions {
    const stores = this.db
      .prepare('SELECT id AS value, name AS label FROM stores ORDER BY id')
      .all() as FilterOptions['stores'];
    const products = this.db
      .prepare('SELECT id AS value, name AS label FROM products ORDER BY name')
      .all() as FilterOptions['products'];
    const categories = this.db
      .prepare(
        'SELECT DISTINCT category AS value, category AS label FROM products ORDER BY category',
      )
      .all() as FilterOptions['categories'];
    const sources = this.db
      .prepare('SELECT DISTINCT source AS value, source AS label FROM orders ORDER BY source')
      .all() as FilterOptions['sources'];

    return { stores, products, categories, sources };
  }

  private getOrderMainStatusText(status: OrderMainStatus) {
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

  private getOrderDeliveryStatusText(status: OrderDeliveryStatus) {
    return (
      {
        pending: '待发货',
        shipped: '已发货',
        delivered: '已交付',
        manual_review: '人工处理',
      }[status] ?? status
    );
  }

  private getOrderPaymentStatusText(status: OrderPaymentStatus) {
    return (
      {
        paid: '已支付',
        refunded_partial: '部分退款',
        refunded_full: '全额退款',
      }[status] ?? status
    );
  }

  private getOrderFulfillmentTypeText(type: OrderFulfillmentType) {
    return (
      {
        standard: '普通实物',
        card: '卡密履约',
        direct_charge: '直充履约',
      }[type] ?? type
    );
  }

  private getOrderFulfillmentQueueText(queue: OrderFulfillmentQueue) {
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

  private getAfterSaleCaseTypeText(type: AfterSaleCaseType) {
    return (
      {
        refund: '退款单',
        resend: '补发单',
        dispute: '争议单',
      }[type] ?? type
    );
  }

  private getAfterSaleCaseStatusText(status: AfterSaleCaseStatus) {
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

  private getAfterSaleRefundStatusText(status: AfterSaleRefundStatus) {
    return (
      {
        pending_review: '待审核',
        approved: '已通过',
        rejected: '已驳回',
        refunded: '已退款',
      }[status] ?? status
    );
  }

  private getAfterSaleResendStatusText(status: AfterSaleResendStatus) {
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

  private getAfterSaleDisputeStatusText(status: AfterSaleDisputeStatus) {
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

  private getAfterSaleReminderTypeText(type: AfterSaleReminderType) {
    return (
      {
        pending: '待处理提醒',
        timeout: '超时提醒',
      }[type] ?? type
    );
  }

  private getAfterSalePriorityText(priority: string) {
    return (
      {
        low: '低',
        normal: '中',
        high: '高',
        urgent: '紧急',
      }[priority] ?? priority
    );
  }

  private getDerivedOrderMainStatus(
    orderStatus: string,
    deliveryStatus: OrderDeliveryStatus,
    afterSaleStatus: string,
  ): OrderMainStatus {
    if (afterSaleStatus === 'processing') {
      return 'after_sale';
    }
    if (deliveryStatus === 'delivered' || orderStatus === 'completed') {
      return 'completed';
    }
    if (deliveryStatus === 'shipped' || orderStatus === 'shipped') {
      return 'fulfilled';
    }
    return 'paid';
  }

  private getDerivedOrderPaymentStatus(paidAmount: number, refundAmount: number): OrderPaymentStatus {
    if (refundAmount >= paidAmount && paidAmount > 0) {
      return 'refunded_full';
    }
    if (refundAmount > 0) {
      return 'refunded_partial';
    }
    return 'paid';
  }

  private getFulfillmentEventFilterSql(alias = 'oe') {
    return `(${alias}.event_type LIKE 'card_%' OR ${alias}.event_type LIKE 'direct_charge_%' OR ${alias}.event_type LIKE 'fulfillment_%')`;
  }

  private loadOrderFulfillmentMeta(orderIds: number[]) {
    const idList = Array.from(new Set(orderIds.filter((id) => Number.isInteger(id) && id > 0)));
    const metaMap = new Map<
      number,
      {
        fulfillmentType: OrderFulfillmentType;
        fulfillmentTypeText: string;
        fulfillmentQueue: OrderFulfillmentQueue;
        fulfillmentQueueText: string;
        fulfillmentStage: string;
        fulfillmentStageDetail: string;
        latestTaskNo: string | null;
        latestSupplierOrderNo: string | null;
        latestOutboundNo: string | null;
        retryCount: number;
        maxRetry: number;
        manualReason: string | null;
        latestLogTitle: string | null;
        latestLogDetail: string | null;
        latestLogAt: string | null;
        canRetry: boolean;
        canResend: boolean;
        canTerminate: boolean;
        canNote: boolean;
      }
    >();

    if (idList.length === 0) {
      return metaMap;
    }

    const idsSql = idList.join(', ');

    const orderRows = this.db
      .prepare(
        `
          SELECT
            o.id,
            o.order_status AS orderStatus,
            o.main_status AS mainStatus,
            o.delivery_status AS deliveryStatus,
            o.completed_at AS completedAt,
            cdi.id AS cardDeliveryId,
            dci.id AS directChargeItemId
          FROM orders o
          LEFT JOIN card_delivery_items cdi ON cdi.product_id = o.product_id
          LEFT JOIN direct_charge_items dci ON dci.product_id = o.product_id
          WHERE o.id IN (${idsSql})
        `,
      )
      .all() as Array<{
      id: number;
      orderStatus: string;
      mainStatus: OrderMainStatus;
      deliveryStatus: OrderDeliveryStatus;
      completedAt: string | null;
      cardDeliveryId: number | null;
      directChargeItemId: number | null;
    }>;

    const cardRows = this.db
      .prepare(
        `
          SELECT
            base.orderId,
            base.cardDeliveryId,
            latestJob.id AS latestJobId,
            latestJob.jobStatus,
            latestJob.attemptCount,
            latestJob.errorMessage,
            latestJob.latestOutboundNo
          FROM (
            SELECT
              o.id AS orderId,
              cdi.id AS cardDeliveryId
            FROM orders o
            INNER JOIN card_delivery_items cdi ON cdi.product_id = o.product_id
            WHERE o.id IN (${idsSql})
          ) base
          LEFT JOIN (
            SELECT
              cdj.order_id AS orderId,
              cdj.id,
              cdj.job_status AS jobStatus,
              cdj.attempt_count AS attemptCount,
              cdj.error_message AS errorMessage,
              cor.outbound_no AS latestOutboundNo
            FROM card_delivery_jobs cdj
            INNER JOIN (
              SELECT order_id, MAX(id) AS latestId
              FROM card_delivery_jobs
              WHERE order_id IN (${idsSql})
              GROUP BY order_id
            ) latest ON latest.latestId = cdj.id
            LEFT JOIN card_outbound_records cor ON cor.id = cdj.latest_outbound_record_id
          ) latestJob ON latestJob.orderId = base.orderId
        `,
      )
      .all() as Array<{
      orderId: number;
      cardDeliveryId: number;
      latestJobId: number | null;
      jobStatus: CardDeliveryJobStatus | null;
      attemptCount: number | null;
      errorMessage: string | null;
      latestOutboundNo: string | null;
    }>;

    const directRows = this.db
      .prepare(
        `
          SELECT
            base.orderId,
            base.directChargeItemId,
            latestJob.id AS latestJobId,
            latestJob.taskNo,
            latestJob.supplierOrderNo,
            latestJob.taskStatus,
            latestJob.callbackStatus,
            latestJob.retryCount,
            latestJob.maxRetry,
            latestJob.errorMessage,
            latestJob.resultDetail,
            latestJob.manualReason
          FROM (
            SELECT
              o.id AS orderId,
              dci.id AS directChargeItemId
            FROM orders o
            LEFT JOIN direct_charge_items dci ON dci.product_id = o.product_id
            WHERE o.id IN (${idsSql})
          ) base
          LEFT JOIN (
            SELECT
              dcj.order_id AS orderId,
              dcj.id,
              dcj.task_no AS taskNo,
              dcj.supplier_order_no AS supplierOrderNo,
              dcj.task_status AS taskStatus,
              dcj.callback_status AS callbackStatus,
              dcj.retry_count AS retryCount,
              dcj.max_retry AS maxRetry,
              dcj.error_message AS errorMessage,
              dcj.result_detail AS resultDetail,
              dcj.manual_reason AS manualReason
            FROM direct_charge_jobs dcj
            INNER JOIN (
              SELECT order_id, MAX(id) AS latestId
              FROM direct_charge_jobs
              WHERE order_id IN (${idsSql})
              GROUP BY order_id
            ) latest ON latest.latestId = dcj.id
          ) latestJob ON latestJob.orderId = base.orderId
        `,
      )
      .all() as Array<{
      orderId: number;
      directChargeItemId: number | null;
      latestJobId: number | null;
      taskNo: string | null;
      supplierOrderNo: string | null;
      taskStatus: DirectChargeJobStatus | null;
      callbackStatus: DirectChargeCallbackStatus | null;
      retryCount: number | null;
      maxRetry: number | null;
      errorMessage: string | null;
      resultDetail: string | null;
      manualReason: string | null;
    }>;

    const eventRows = this.db
      .prepare(
        `
          SELECT
            latest.orderId,
            oe.event_title AS eventTitle,
            oe.event_detail AS eventDetail,
            oe.created_at AS createdAt
          FROM (
            SELECT order_id AS orderId, MAX(id) AS latestId
            FROM order_events
            WHERE order_id IN (${idsSql})
              AND ${this.getFulfillmentEventFilterSql('order_events')}
            GROUP BY order_id
          ) latest
          INNER JOIN order_events oe ON oe.id = latest.latestId
        `,
      )
      .all() as Array<{
      orderId: number;
      eventTitle: string;
      eventDetail: string;
      createdAt: string;
    }>;

    const cardMap = new Map(cardRows.map((row) => [row.orderId, row]));
    const directMap = new Map(directRows.map((row) => [row.orderId, row]));
    const eventMap = new Map(eventRows.map((row) => [row.orderId, row]));

    orderRows.forEach((orderRow) => {
      const cardRow = cardMap.get(orderRow.id);
      const directRow = directMap.get(orderRow.id);
      const eventRow = eventMap.get(orderRow.id);
      const fulfillmentType: OrderFulfillmentType = cardRow?.cardDeliveryId
        ? 'card'
        : directRow?.directChargeItemId || directRow?.latestJobId
          ? 'direct_charge'
          : 'standard';

      let fulfillmentQueue: OrderFulfillmentQueue = 'pending';
      if (orderRow.mainStatus === 'closed') {
        fulfillmentQueue = 'failed';
      } else if (fulfillmentType === 'card') {
        if (cardRow?.jobStatus === 'failed') {
          fulfillmentQueue = 'failed';
        } else if (orderRow.deliveryStatus === 'manual_review') {
          fulfillmentQueue = 'manual_review';
        } else if (
          cardRow?.jobStatus === 'success' ||
          orderRow.deliveryStatus === 'delivered' ||
          ['fulfilled', 'completed'].includes(orderRow.mainStatus)
        ) {
          fulfillmentQueue = 'success';
        } else if (orderRow.mainStatus === 'processing' || orderRow.deliveryStatus === 'shipped') {
          fulfillmentQueue = 'processing';
        }
      } else if (fulfillmentType === 'direct_charge') {
        if (directRow?.taskStatus === 'failed') {
          fulfillmentQueue = 'failed';
        } else if (
          directRow?.taskStatus === 'manual_review' ||
          orderRow.deliveryStatus === 'manual_review'
        ) {
          fulfillmentQueue = 'manual_review';
        } else if (
          directRow?.taskStatus === 'success' ||
          orderRow.deliveryStatus === 'delivered' ||
          orderRow.mainStatus === 'completed'
        ) {
          fulfillmentQueue = 'success';
        } else if (
          directRow?.taskStatus === 'processing' ||
          orderRow.mainStatus === 'processing' ||
          orderRow.deliveryStatus === 'shipped'
        ) {
          fulfillmentQueue = 'processing';
        }
      } else if (orderRow.deliveryStatus === 'manual_review') {
        fulfillmentQueue = 'manual_review';
      } else if (
        orderRow.deliveryStatus === 'delivered' ||
        ['fulfilled', 'completed'].includes(orderRow.mainStatus)
      ) {
        fulfillmentQueue = 'success';
      } else if (orderRow.mainStatus === 'processing' || orderRow.deliveryStatus === 'shipped') {
        fulfillmentQueue = 'processing';
      }

      let fulfillmentStage = '待履约';
      let fulfillmentStageDetail = '订单已进入统一履约主线，等待后续处理。';

      if (fulfillmentType === 'card') {
        if (fulfillmentQueue === 'failed') {
          fulfillmentStage = '卡密发货失败';
          fulfillmentStageDetail = cardRow?.errorMessage ?? '卡密自动发货失败，等待人工复核。';
        } else if (fulfillmentQueue === 'manual_review') {
          fulfillmentStage = '卡密待人工处理';
          fulfillmentStageDetail = cardRow?.errorMessage ?? '卡密订单已转人工处理。';
        } else if (fulfillmentQueue === 'success') {
          fulfillmentStage = '卡密已交付';
          fulfillmentStageDetail = cardRow?.latestOutboundNo
            ? `最新出库单号 ${cardRow.latestOutboundNo}。`
            : '卡密订单已完成交付。';
        } else if (fulfillmentQueue === 'processing') {
          fulfillmentStage = '卡密处理中';
          fulfillmentStageDetail = '订单已进入卡密履约链路。';
        } else {
          fulfillmentStage = '待锁卡发货';
          fulfillmentStageDetail = '等待卡密引擎锁卡并执行发货。';
        }
      } else if (fulfillmentType === 'direct_charge') {
        if (fulfillmentQueue === 'failed') {
          fulfillmentStage = '直充回执失败';
          fulfillmentStageDetail = directRow?.errorMessage ?? '供应商返回失败结果，等待后续处理。';
        } else if (fulfillmentQueue === 'manual_review') {
          fulfillmentStage = '直充待人工接管';
          fulfillmentStageDetail =
            directRow?.manualReason ?? directRow?.errorMessage ?? '直充任务已转人工处理。';
        } else if (fulfillmentQueue === 'success') {
          fulfillmentStage = '直充已完成';
          fulfillmentStageDetail =
            directRow?.resultDetail ?? '供应商回执成功，订单已进入完成状态。';
        } else if (fulfillmentQueue === 'processing') {
          fulfillmentStage = '供应商处理中';
          fulfillmentStageDetail =
            directRow?.resultDetail ?? '已下发至供应商，等待异步回调。';
        } else {
          fulfillmentStage = '待供应商下发';
          fulfillmentStageDetail = '等待直充任务首次下发。';
        }
      } else if (fulfillmentQueue === 'manual_review') {
        fulfillmentStage = '待人工处理';
        fulfillmentStageDetail = '当前订单不在自动履约链路，需人工处理。';
      } else if (fulfillmentQueue === 'success') {
        fulfillmentStage = '履约完成';
        fulfillmentStageDetail = '订单已完成发货交付。';
      } else if (fulfillmentQueue === 'processing') {
        fulfillmentStage = '履约处理中';
        fulfillmentStageDetail = '订单已进入处理中状态。';
      }

      metaMap.set(orderRow.id, {
        fulfillmentType,
        fulfillmentTypeText: this.getOrderFulfillmentTypeText(fulfillmentType),
        fulfillmentQueue,
        fulfillmentQueueText: this.getOrderFulfillmentQueueText(fulfillmentQueue),
        fulfillmentStage,
        fulfillmentStageDetail,
        latestTaskNo: directRow?.taskNo ?? null,
        latestSupplierOrderNo: directRow?.supplierOrderNo ?? null,
        latestOutboundNo: cardRow?.latestOutboundNo ?? null,
        retryCount: fulfillmentType === 'direct_charge' ? Number(directRow?.retryCount ?? 0) : Number(cardRow?.attemptCount ?? 0),
        maxRetry: fulfillmentType === 'direct_charge' ? Number(directRow?.maxRetry ?? 0) : 1,
        manualReason: directRow?.manualReason ?? null,
        latestLogTitle: eventRow?.eventTitle ?? null,
        latestLogDetail: eventRow?.eventDetail ?? null,
        latestLogAt: eventRow?.createdAt ?? null,
        canRetry:
          fulfillmentType === 'card'
            ? ['pending', 'failed', 'manual_review'].includes(fulfillmentQueue)
            : fulfillmentType === 'direct_charge'
              ? ['pending', 'failed', 'manual_review'].includes(fulfillmentQueue)
              : false,
        canResend: fulfillmentType === 'card' && Boolean(cardRow?.latestOutboundNo),
        canTerminate: orderRow.mainStatus !== 'closed' && fulfillmentQueue !== 'success',
        canNote: true,
      });
    });

    return metaMap;
  }

  private resolveOrderSort(sortBy?: string, sortOrder?: string) {
    const column =
      ORDER_SORT_FIELDS[(sortBy as keyof typeof ORDER_SORT_FIELDS) ?? 'paidAt'] ??
      ORDER_SORT_FIELDS.paidAt;
    const direction = sortOrder === 'asc' ? 'ASC' : 'DESC';
    return `${column} ${direction}, o.id DESC`;
  }

  getDashboard(filters: QueryFilters) {
    const range = this.resolveDateRange(filters);
    const currentSummary = this.getMetricSummary({
      ...filters,
      startDate: range.startIso,
      endDate: range.endIso,
    });
    const previousSummary = this.getMetricSummary({
      ...filters,
      startDate: range.previousStartIso,
      endDate: range.previousEndIso,
    });

    const compareMetric = (current: number, previous: number) => {
      if (previous === 0) {
        return current === 0 ? 0 : 100;
      }
      return toPercentage(((current - previous) / previous) * 100);
    };

    return {
      range: {
        startDate: range.startIso,
        endDate: range.endIso,
        preset: filters.preset ?? 'last30Days',
      },
      summary: [
        {
          key: 'receivedAmount',
          label: '实收金额',
          value: currentSummary.receivedAmount,
          unit: 'CNY',
          compareRate: compareMetric(
            currentSummary.receivedAmount,
            previousSummary.receivedAmount,
          ),
        },
        {
          key: 'netSalesAmount',
          label: '净销售额',
          value: Number((currentSummary.receivedAmount - currentSummary.refundAmount).toFixed(2)),
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
        todayCards: this.queryTodayCards(),
        businessCards: this.queryBusinessCards(filters, range),
      },
      trend: this.queryTrendRows(filters, range),
      sourceDistribution: this.queryGroupBySource(filters, range),
      orderStatusDistribution: this.queryOrderStatusDistribution(filters, range),
      topProducts: this.queryTopProducts(filters, range, 6),
      filters: this.getFilterOptions(),
    };
  }

  getOrdersOverview(filters: QueryFilters) {
    return this.orderReadRepository.getOrdersOverview(filters);
  }

  getOrdersList(filters: QueryFilters, pagination: PaginationParams) {
    return this.orderReadRepository.getOrdersList(filters, pagination);
  }

  getOrderDetail(orderId: number) {
    return this.orderReadRepository.getOrderDetail(orderId);
  }

  private getOrderFulfillmentActionContext(orderId: number) {
    const order = this.db
      .prepare(
        `
          SELECT
            o.id,
            o.order_no AS orderNo,
            o.main_status AS mainStatus,
            o.delivery_status AS deliveryStatus,
            o.order_status AS orderStatus,
            o.seller_remark AS sellerRemark,
            cdi.id AS cardDeliveryId,
            dci.id AS directChargeItemId
          FROM orders o
          LEFT JOIN card_delivery_items cdi ON cdi.product_id = o.product_id
          LEFT JOIN direct_charge_items dci ON dci.product_id = o.product_id
          WHERE o.id = ?
        `,
      )
      .get(orderId) as
      | {
          id: number;
          orderNo: string;
          mainStatus: OrderMainStatus;
          deliveryStatus: OrderDeliveryStatus;
          orderStatus: string;
          sellerRemark: string;
          cardDeliveryId: number | null;
          directChargeItemId: number | null;
        }
      | undefined;

    if (!order) {
      return null;
    }

    const cardJob = this.db
      .prepare(
        `
          SELECT
            id,
            job_status AS jobStatus
          FROM card_delivery_jobs
          WHERE order_id = ?
          ORDER BY id DESC
          LIMIT 1
        `,
      )
      .get(orderId) as { id: number; jobStatus: CardDeliveryJobStatus } | undefined;

    const outbound = this.db
      .prepare(
        `
          SELECT
            id,
            outbound_no AS outboundNo
          FROM card_outbound_records
          WHERE order_id = ?
            AND outbound_status IN ('sent', 'resent')
          ORDER BY id DESC
          LIMIT 1
        `,
      )
      .get(orderId) as { id: number; outboundNo: string } | undefined;

    const directJob = this.db
      .prepare(
        `
          SELECT
            id,
            task_no AS taskNo,
            task_status AS taskStatus
          FROM direct_charge_jobs
          WHERE order_id = ?
          ORDER BY id DESC
          LIMIT 1
        `,
      )
      .get(orderId) as
      | {
          id: number;
          taskNo: string;
          taskStatus: DirectChargeJobStatus;
        }
      | undefined;

    const fulfillmentType: OrderFulfillmentType = order.cardDeliveryId
      ? 'card'
      : order.directChargeItemId || directJob
        ? 'direct_charge'
        : 'standard';

    return {
      ...order,
      fulfillmentType,
      cardJobId: cardJob?.id ?? null,
      cardJobStatus: cardJob?.jobStatus ?? null,
      latestOutboundId: outbound?.id ?? null,
      latestOutboundNo: outbound?.outboundNo ?? null,
      directJobId: directJob?.id ?? null,
      directTaskNo: directJob?.taskNo ?? null,
      directTaskStatus: directJob?.taskStatus ?? null,
    };
  }

  getOrderFulfillmentWorkbench(filters: QueryFilters) {
    const range = this.resolveDateRange(filters);
    const { whereSql, params } = this.buildOrderWhere(filters, range);
    const rows = this.db
      .prepare(
        `
          SELECT
            o.id,
            o.order_no AS orderNo,
            o.store_id AS storeId,
            s.name AS storeName,
            p.name AS productName,
            o.paid_amount AS paidAmount,
            o.main_status AS mainStatus,
            o.delivery_status AS deliveryStatus,
            o.updated_at AS updatedAt
          FROM orders o
          LEFT JOIN stores s ON s.id = o.store_id
          LEFT JOIN products p ON p.id = o.product_id
          LEFT JOIN customers c ON c.id = o.customer_id
          ${whereSql}
          ORDER BY o.updated_at DESC, o.id DESC
        `,
      )
      .all(params) as Array<{
      id: number;
      orderNo: string;
      storeId: number;
      storeName: string;
      productName: string;
      paidAmount: number;
      mainStatus: OrderMainStatus;
      deliveryStatus: OrderDeliveryStatus;
      updatedAt: string;
    }>;

    const metaMap = this.loadOrderFulfillmentMeta(rows.map((row) => row.id));
    const enrichedRows = rows.map((row) => {
      const meta = metaMap.get(row.id);
      return {
        ...row,
        fulfillmentType: meta?.fulfillmentType ?? 'standard',
        fulfillmentTypeText: meta?.fulfillmentTypeText ?? this.getOrderFulfillmentTypeText('standard'),
        fulfillmentQueue: meta?.fulfillmentQueue ?? 'pending',
        fulfillmentQueueText: meta?.fulfillmentQueueText ?? this.getOrderFulfillmentQueueText('pending'),
        fulfillmentStage: meta?.fulfillmentStage ?? '待履约',
        fulfillmentStageDetail: meta?.fulfillmentStageDetail ?? '等待进入统一履约处理链路。',
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

    const logs = this.db
      .prepare(
        `
          SELECT
            oe.id,
            o.id AS orderId,
            o.order_no AS orderNo,
            s.name AS storeName,
            p.name AS productName,
            oe.event_type AS eventType,
            oe.event_title AS eventTitle,
            oe.event_detail AS eventDetail,
            oe.operator_name AS operatorName,
            oe.created_at AS createdAt
          FROM order_events oe
          INNER JOIN orders o ON o.id = oe.order_id
          LEFT JOIN stores s ON s.id = o.store_id
          LEFT JOIN products p ON p.id = o.product_id
          LEFT JOIN customers c ON c.id = o.customer_id
          ${whereSql ? `${whereSql} AND ${this.getFulfillmentEventFilterSql('oe')}` : `WHERE ${this.getFulfillmentEventFilterSql('oe')}`}
          ORDER BY oe.created_at DESC, oe.id DESC
          LIMIT 24
        `,
      )
      .all(params) as Array<{
      id: number;
      orderId: number;
      orderNo: string;
      storeName: string;
      productName: string;
      eventType: string;
      eventTitle: string;
      eventDetail: string;
      operatorName: string | null;
      createdAt: string;
    }>;

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
      .map((item) => ({
        ...item[1],
        successRate:
          item[1].totalOrders > 0
            ? Number(((item[1].successCount / item[1].totalOrders) * 100).toFixed(1))
            : 0,
        failedRate:
          item[1].totalOrders > 0
            ? Number(((item[1].failedCount / item[1].totalOrders) * 100).toFixed(1))
            : 0,
        manualRate:
          item[1].totalOrders > 0
            ? Number(((item[1].manualCount / item[1].totalOrders) * 100).toFixed(1))
            : 0,
      }))
      .sort((left, right) => right.totalOrders - left.totalOrders || left.storeId - right.storeId);

    return {
      queueSummary,
      exceptionOrders: enrichedRows
        .filter((row) => ['failed', 'manual_review'].includes(row.fulfillmentQueue))
        .slice(0, 12),
      logs,
      storeStats,
    };
  }

  retryOrderFulfillment(orderId: number) {
    const context = this.getOrderFulfillmentActionContext(orderId);
    if (!context) {
      return null;
    }

    if (context.fulfillmentType === 'card') {
      if (context.cardJobId) {
        return this.runCardDeliveryJob('card-delivery', context.cardJobId);
      }
      return this.fulfillCardOrder('card-delivery', orderId);
    }

    if (context.fulfillmentType === 'direct_charge' && context.directJobId) {
      if (context.directTaskStatus === 'pending_dispatch') {
        return this.dispatchDirectChargeJob('distribution-supply', context.directJobId);
      }
      return this.retryDirectChargeJob('distribution-supply', context.directJobId);
    }

    return null;
  }

  resendOrderFulfillment(orderId: number) {
    const context = this.getOrderFulfillmentActionContext(orderId);
    if (!context || context.fulfillmentType !== 'card' || !context.latestOutboundId) {
      return null;
    }

    return this.resendCardOutbound('card-records', context.latestOutboundId);
  }

  terminateOrderFulfillment(orderId: number, reason: string, operatorName: string) {
    const context = this.getOrderFulfillmentActionContext(orderId);
    if (!context || context.mainStatus === 'closed') {
      return null;
    }

    const now = format(new Date(), 'yyyy-MM-dd HH:mm:ss');

    this.db.transaction(() => {
      this.db
        .prepare(
          `
            UPDATE orders
            SET
              main_status = 'closed',
              delivery_status = 'manual_review',
              order_status = 'closed',
              updated_at = @updatedAt
            WHERE id = @id
          `,
        )
        .run({
          id: orderId,
          updatedAt: now,
        });

      this.db
        .prepare(
          `
            UPDATE order_items
            SET
              delivery_status = 'manual_review',
              updated_at = @updatedAt
            WHERE order_id = @orderId
          `,
        )
        .run({
          orderId,
          updatedAt: now,
        });

      if (context.fulfillmentType === 'card' && context.cardJobId) {
        this.db
          .prepare(
            `
              UPDATE card_delivery_jobs
              SET
                job_status = 'failed',
                error_message = @errorMessage,
                last_attempt_at = @updatedAt,
                updated_at = @updatedAt
              WHERE id = @id
            `,
          )
          .run({
            id: context.cardJobId,
            errorMessage: reason,
            updatedAt: now,
          });
      }

      if (context.fulfillmentType === 'direct_charge' && context.directJobId) {
        this.db
          .prepare(
            `
              UPDATE direct_charge_jobs
              SET
                task_status = 'failed',
                error_message = @errorMessage,
                result_detail = @resultDetail,
                manual_reason = @manualReason,
                updated_at = @updatedAt
              WHERE id = @id
            `,
          )
          .run({
            id: context.directJobId,
            errorMessage: reason,
            resultDetail: reason,
            manualReason: reason,
            updatedAt: now,
          });
      }

      this.appendOrderEvent(
        orderId,
        'fulfillment_terminated',
        '履约已终止',
        reason,
        operatorName,
        now,
      );
    })();

    return {
      success: true,
      mainStatus: 'closed' as const,
      deliveryStatus: 'manual_review' as const,
      reason,
    };
  }

  noteOrderFulfillment(orderId: number, note: string, operatorName: string) {
    const context = this.getOrderFulfillmentActionContext(orderId);
    if (!context) {
      return null;
    }

    const now = format(new Date(), 'yyyy-MM-dd HH:mm:ss');
    const noteLine = `[${now}] ${operatorName}：${note}`;
    const nextRemark = context.sellerRemark ? `${context.sellerRemark}\n${noteLine}` : noteLine;

    this.db.transaction(() => {
      this.db
        .prepare(
          `
            UPDATE orders
            SET
              seller_remark = @sellerRemark,
              updated_at = @updatedAt
            WHERE id = @id
          `,
        )
        .run({
          id: orderId,
          sellerRemark: nextRemark,
          updatedAt: now,
        });

      this.appendOrderEvent(
        orderId,
        'fulfillment_note',
        '履约备注已更新',
        note,
        operatorName,
        now,
      );
    })();

    return {
      success: true,
      sellerRemark: nextRemark,
    };
  }

  private appendAfterSaleRecord(
    caseId: number,
    recordType: string,
    title: string,
    detail: string,
    operatorName: string | null,
    createdAt: string,
  ) {
    this.db
      .prepare(
        `
          INSERT INTO after_sale_records (
            case_id,
            record_type,
            title,
            detail,
            operator_name,
            created_at
          ) VALUES (
            @caseId,
            @recordType,
            @title,
            @detail,
            @operatorName,
            @createdAt
          )
        `,
      )
      .run({
        caseId,
        recordType,
        title,
        detail,
        operatorName,
        createdAt,
      });
  }

  private syncOrderAfterSaleState(orderId: number, updatedAt: string, nextRefundAmount?: number) {
    const order = this.db
      .prepare(
        `
          SELECT
            id,
            order_status AS orderStatus,
            paid_amount AS paidAmount,
            refund_amount AS refundAmount,
            delivery_status AS deliveryStatus
          FROM orders
          WHERE id = ?
        `,
      )
      .get(orderId) as
      | {
          id: number;
          orderStatus: string;
          paidAmount: number;
          refundAmount: number;
          deliveryStatus: OrderDeliveryStatus;
        }
      | undefined;

    if (!order) {
      return null;
    }

    const openCaseCount = this.db
      .prepare(
        `
          SELECT COUNT(*) AS count
          FROM after_sale_cases
          WHERE order_id = ?
            AND case_status IN ('pending_review', 'processing', 'waiting_execute')
        `,
      )
      .get(orderId) as { count: number };

    const refundAmount =
      nextRefundAmount === undefined ? Number(order.refundAmount ?? 0) : Number(nextRefundAmount);
    const afterSaleStatus = openCaseCount.count > 0 ? 'processing' : 'resolved';
    const paymentStatus = this.getDerivedOrderPaymentStatus(order.paidAmount, refundAmount);
    const mainStatus = this.getDerivedOrderMainStatus(
      order.orderStatus,
      order.deliveryStatus,
      afterSaleStatus,
    );

    this.db
      .prepare(
        `
          UPDATE orders
          SET
            after_sale_status = @afterSaleStatus,
            refund_amount = @refundAmount,
            payment_status = @paymentStatus,
            main_status = @mainStatus,
            updated_at = @updatedAt
          WHERE id = @id
        `,
      )
      .run({
        id: orderId,
        afterSaleStatus,
        refundAmount,
        paymentStatus,
        mainStatus,
        updatedAt,
      });

    this.db
      .prepare(
        `
          UPDATE order_items
          SET
            after_sale_status = @afterSaleStatus,
            updated_at = @updatedAt
          WHERE order_id = @orderId
        `,
      )
      .run({
        orderId,
        afterSaleStatus,
        updatedAt,
      });

    return {
      afterSaleStatus,
      paymentStatus,
      mainStatus,
      refundAmount,
    };
  }

  private refreshAfterSaleReminders(caseId: number, currentTime: string) {
    const row = this.db
      .prepare(
        `
          SELECT
            case_no AS caseNo,
            case_status AS caseStatus,
            sla_deadline_at AS deadlineAt
          FROM after_sale_cases
          WHERE id = ?
        `,
      )
      .get(caseId) as
      | {
          caseNo: string;
          caseStatus: AfterSaleCaseStatus;
          deadlineAt: string;
        }
      | undefined;

    if (!row) {
      return;
    }

    const isOpen = ['pending_review', 'processing', 'waiting_execute'].includes(row.caseStatus);
    const reminderConfigs: Array<{
      type: AfterSaleReminderType;
      shouldBeActive: boolean;
      title: string;
      detail: string;
      remindAt: string;
    }> = [
      {
        type: 'pending',
        shouldBeActive: isOpen,
        title: '待处理售后单',
        detail: `售后单 ${row.caseNo} 仍在处理中，请尽快跟进。`,
        remindAt: currentTime,
      },
      {
        type: 'timeout',
        shouldBeActive: isOpen && row.deadlineAt < currentTime,
        title: '售后单已超时',
        detail: `售后单 ${row.caseNo} 已超过承诺处理时限。`,
        remindAt: row.deadlineAt,
      },
    ];

    reminderConfigs.forEach((config) => {
      const activeReminder = this.db
        .prepare(
          `
            SELECT id
            FROM after_sale_reminders
            WHERE case_id = ?
              AND reminder_type = ?
              AND reminder_status = 'active'
            ORDER BY id DESC
            LIMIT 1
          `,
        )
        .get(caseId, config.type) as { id: number } | undefined;

      if (config.shouldBeActive) {
        if (activeReminder) {
          this.db
            .prepare(
              `
                UPDATE after_sale_reminders
                SET
                  title = @title,
                  detail = @detail,
                  remind_at = @remindAt
                WHERE id = @id
              `,
            )
            .run({
              id: activeReminder.id,
              title: config.title,
              detail: config.detail,
              remindAt: config.remindAt,
            });
        } else {
          this.db
            .prepare(
              `
                INSERT INTO after_sale_reminders (
                  case_id,
                  reminder_type,
                  reminder_status,
                  title,
                  detail,
                  remind_at
                ) VALUES (
                  @caseId,
                  @type,
                  'active',
                  @title,
                  @detail,
                  @remindAt
                )
              `,
            )
            .run({
              caseId,
              type: config.type,
              title: config.title,
              detail: config.detail,
              remindAt: config.remindAt,
            });
        }
      } else if (activeReminder) {
        this.db
          .prepare(
            `
              UPDATE after_sale_reminders
              SET
                reminder_status = 'resolved',
                resolved_at = @resolvedAt
              WHERE id = @id
            `,
          )
          .run({
            id: activeReminder.id,
            resolvedAt: currentTime,
          });
      }
    });
  }

  private getAfterSaleCaseContext(caseId: number) {
    const row = this.db
      .prepare(
        `
          SELECT
            ac.id,
            ac.case_no AS caseNo,
            ac.order_id AS orderId,
            ac.case_type AS caseType,
            ac.case_status AS caseStatus,
            ac.reason,
            ac.priority,
            ac.latest_result AS latestResult,
            ac.sla_deadline_at AS deadlineAt,
            ac.created_at AS createdAt,
            ac.updated_at AS updatedAt,
            o.order_no AS orderNo,
            o.order_status AS orderStatus,
            o.paid_amount AS paidAmount,
            o.refund_amount AS refundAmount,
            o.delivery_status AS deliveryStatus,
            o.after_sale_status AS afterSaleStatus,
            rf.id AS refundId,
            rf.requested_amount AS requestedAmount,
            rf.approved_amount AS approvedAmount,
            rf.refund_status AS refundStatus,
            rs.id AS resendId,
            rs.resend_status AS resendStatus,
            rs.fulfillment_type AS resendFulfillmentType,
            rs.related_outbound_no AS relatedOutboundNo,
            rs.related_task_no AS relatedTaskNo,
            dp.id AS disputeId,
            dp.dispute_status AS disputeStatus,
            dp.compensation_amount AS compensationAmount
          FROM after_sale_cases ac
          INNER JOIN orders o ON o.id = ac.order_id
          LEFT JOIN after_sale_refunds rf ON rf.case_id = ac.id
          LEFT JOIN after_sale_resends rs ON rs.case_id = ac.id
          LEFT JOIN after_sale_disputes dp ON dp.case_id = ac.id
          WHERE ac.id = ?
        `,
      )
      .get(caseId) as
      | {
          id: number;
          caseNo: string;
          orderId: number;
          caseType: AfterSaleCaseType;
          caseStatus: AfterSaleCaseStatus;
          reason: string;
          priority: string;
          latestResult: string | null;
          deadlineAt: string;
          createdAt: string;
          updatedAt: string;
          orderNo: string;
          orderStatus: string;
          paidAmount: number;
          refundAmount: number;
          deliveryStatus: OrderDeliveryStatus;
          afterSaleStatus: string;
          refundId: number | null;
          requestedAmount: number | null;
          approvedAmount: number | null;
          refundStatus: AfterSaleRefundStatus | null;
          resendId: number | null;
          resendStatus: AfterSaleResendStatus | null;
          resendFulfillmentType: OrderFulfillmentType | null;
          relatedOutboundNo: string | null;
          relatedTaskNo: string | null;
          disputeId: number | null;
          disputeStatus: AfterSaleDisputeStatus | null;
          compensationAmount: number | null;
        }
      | undefined;

    if (!row) {
      return null;
    }

    return row;
  }

  getAfterSaleWorkbench(filters: QueryFilters) {
    const range = this.resolveDateRange(filters);
    const { whereSql, params } = this.buildAfterSaleWhere(filters, range);

    const summary = this.db
      .prepare(
        `
          SELECT
            COUNT(*) AS totalCases,
            SUM(CASE WHEN ac.case_status IN ('pending_review', 'processing', 'waiting_execute') THEN 1 ELSE 0 END) AS pendingCases,
            SUM(CASE WHEN ac.case_status = 'processing' THEN 1 ELSE 0 END) AS processingCases,
            SUM(CASE WHEN ac.case_status = 'resolved' THEN 1 ELSE 0 END) AS resolvedCases,
            SUM(CASE WHEN ac.case_type = 'refund' THEN 1 ELSE 0 END) AS refundCases,
            SUM(CASE WHEN ac.case_type = 'resend' THEN 1 ELSE 0 END) AS resendCases,
            SUM(CASE WHEN ac.case_type = 'dispute' THEN 1 ELSE 0 END) AS disputeCases,
            SUM(CASE WHEN rm.reminder_type = 'timeout' AND rm.reminder_status = 'active' THEN 1 ELSE 0 END) AS timeoutCases,
            SUM(CASE WHEN rf.refund_status IN ('pending_review', 'approved') THEN rf.requested_amount ELSE 0 END) AS pendingRefundAmount
          FROM after_sale_cases ac
          INNER JOIN orders o ON o.id = ac.order_id
          LEFT JOIN products p ON p.id = o.product_id
          LEFT JOIN stores s ON s.id = o.store_id
          LEFT JOIN customers c ON c.id = o.customer_id
          LEFT JOIN after_sale_refunds rf ON rf.case_id = ac.id
          LEFT JOIN after_sale_reminders rm ON rm.case_id = ac.id AND rm.reminder_status = 'active'
          ${whereSql}
        `,
      )
      .get(params) as Record<string, number | null>;

    const reminders = this.db
      .prepare(
        `
          SELECT
            rm.id,
            ac.id AS caseId,
            ac.case_no AS caseNo,
            ac.case_type AS caseType,
            ac.case_status AS caseStatus,
            o.order_no AS orderNo,
            s.name AS storeName,
            p.name AS productName,
            rm.reminder_type AS reminderType,
            rm.title,
            rm.detail,
            rm.remind_at AS remindAt,
            ac.sla_deadline_at AS deadlineAt
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
      )
      .all(params) as Array<{
      id: number;
      caseId: number;
      caseNo: string;
      caseType: AfterSaleCaseType;
      caseStatus: AfterSaleCaseStatus;
      orderNo: string;
      storeName: string;
      productName: string;
      reminderType: AfterSaleReminderType;
      title: string;
      detail: string;
      remindAt: string;
      deadlineAt: string;
    }>;

    const listRows = this.db
      .prepare(
        `
          SELECT
            ac.id,
            ac.case_no AS caseNo,
            ac.order_id AS orderId,
            ac.case_type AS caseType,
            ac.case_status AS caseStatus,
            ac.reason,
            ac.latest_result AS latestResult,
            ac.priority,
            ac.sla_deadline_at AS deadlineAt,
            ac.updated_at AS updatedAt,
            o.order_no AS orderNo,
            s.name AS storeName,
            p.name AS productName,
            c.name AS customerName,
            rf.refund_status AS refundStatus,
            rf.requested_amount AS requestedAmount,
            rs.resend_status AS resendStatus,
            dp.dispute_status AS disputeStatus,
            MAX(CASE WHEN rm.reminder_type = 'timeout' AND rm.reminder_status = 'active' THEN 1 ELSE 0 END) AS hasTimeoutReminder
          FROM after_sale_cases ac
          INNER JOIN orders o ON o.id = ac.order_id
          LEFT JOIN products p ON p.id = o.product_id
          LEFT JOIN stores s ON s.id = o.store_id
          LEFT JOIN customers c ON c.id = o.customer_id
          LEFT JOIN after_sale_refunds rf ON rf.case_id = ac.id
          LEFT JOIN after_sale_resends rs ON rs.case_id = ac.id
          LEFT JOIN after_sale_disputes dp ON dp.case_id = ac.id
          LEFT JOIN after_sale_reminders rm ON rm.case_id = ac.id
          ${whereSql}
          GROUP BY ac.id
          ORDER BY hasTimeoutReminder DESC, ac.updated_at DESC, ac.id DESC
          LIMIT 18
        `,
      )
      .all(params) as Array<{
      id: number;
      caseNo: string;
      orderId: number;
      caseType: AfterSaleCaseType;
      caseStatus: AfterSaleCaseStatus;
      reason: string;
      latestResult: string | null;
      priority: string;
      deadlineAt: string;
      updatedAt: string;
      orderNo: string;
      storeName: string;
      productName: string;
      customerName: string;
      refundStatus: AfterSaleRefundStatus | null;
      requestedAmount: number | null;
      resendStatus: AfterSaleResendStatus | null;
      disputeStatus: AfterSaleDisputeStatus | null;
      hasTimeoutReminder: number;
    }>;

    const decorateCase = (row: (typeof listRows)[number]) => ({
      ...row,
      caseTypeText: this.getAfterSaleCaseTypeText(row.caseType),
      caseStatusText: this.getAfterSaleCaseStatusText(row.caseStatus),
      priorityText: this.getAfterSalePriorityText(row.priority),
      refundStatusText: row.refundStatus ? this.getAfterSaleRefundStatusText(row.refundStatus) : null,
      resendStatusText: row.resendStatus ? this.getAfterSaleResendStatusText(row.resendStatus) : null,
      disputeStatusText: row.disputeStatus ? this.getAfterSaleDisputeStatusText(row.disputeStatus) : null,
    });

    return {
      summary: {
        totalCases: Number(summary.totalCases ?? 0),
        pendingCases: Number(summary.pendingCases ?? 0),
        processingCases: Number(summary.processingCases ?? 0),
        resolvedCases: Number(summary.resolvedCases ?? 0),
        timeoutCases: Number(summary.timeoutCases ?? 0),
        refundCases: Number(summary.refundCases ?? 0),
        resendCases: Number(summary.resendCases ?? 0),
        disputeCases: Number(summary.disputeCases ?? 0),
        pendingRefundAmount: Number(summary.pendingRefundAmount ?? 0),
      },
      reminders: reminders.map((row) => ({
        ...row,
        caseTypeText: this.getAfterSaleCaseTypeText(row.caseType),
        caseStatusText: this.getAfterSaleCaseStatusText(row.caseStatus),
        reminderTypeText: this.getAfterSaleReminderTypeText(row.reminderType),
      })),
      pendingCases: listRows
        .filter((row) => ['pending_review', 'processing', 'waiting_execute'].includes(row.caseStatus))
        .map(decorateCase)
        .slice(0, 8),
      timeoutCases: listRows.filter((row) => row.hasTimeoutReminder).map(decorateCase).slice(0, 8),
    };
  }

  getAfterSaleCases(filters: QueryFilters, pagination: PaginationParams) {
    const range = this.resolveDateRange(filters);
    const { whereSql, params } = this.buildAfterSaleWhere(filters, range);
    const page = Math.max(1, pagination.page);
    const pageSize = Math.min(50, Math.max(1, pagination.pageSize));
    const offset = (page - 1) * pageSize;

    const totalRow = this.db
      .prepare(
        `
          SELECT COUNT(*) AS total
          FROM after_sale_cases ac
          INNER JOIN orders o ON o.id = ac.order_id
          LEFT JOIN products p ON p.id = o.product_id
          LEFT JOIN stores s ON s.id = o.store_id
          LEFT JOIN customers c ON c.id = o.customer_id
          ${whereSql}
        `,
      )
      .get(params) as { total: number };

    const rows = this.db
      .prepare(
        `
          SELECT
            ac.id,
            ac.case_no AS caseNo,
            ac.order_id AS orderId,
            ac.case_type AS caseType,
            ac.case_status AS caseStatus,
            ac.reason,
            ac.priority,
            ac.latest_result AS latestResult,
            ac.sla_deadline_at AS deadlineAt,
            ac.created_at AS createdAt,
            ac.updated_at AS updatedAt,
            o.order_no AS orderNo,
            s.name AS storeName,
            p.name AS productName,
            c.name AS customerName,
            rf.requested_amount AS requestedAmount,
            rf.approved_amount AS approvedAmount,
            rf.refund_status AS refundStatus,
            rs.resend_status AS resendStatus,
            dp.dispute_status AS disputeStatus,
            dp.compensation_amount AS compensationAmount,
            GROUP_CONCAT(DISTINCT CASE WHEN rm.reminder_status = 'active' THEN rm.reminder_type END) AS reminderTypesText,
            MAX(CASE WHEN rm.reminder_type = 'timeout' AND rm.reminder_status = 'active' THEN 1 ELSE 0 END) AS hasTimeoutReminder
          FROM after_sale_cases ac
          INNER JOIN orders o ON o.id = ac.order_id
          LEFT JOIN products p ON p.id = o.product_id
          LEFT JOIN stores s ON s.id = o.store_id
          LEFT JOIN customers c ON c.id = o.customer_id
          LEFT JOIN after_sale_refunds rf ON rf.case_id = ac.id
          LEFT JOIN after_sale_resends rs ON rs.case_id = ac.id
          LEFT JOIN after_sale_disputes dp ON dp.case_id = ac.id
          LEFT JOIN after_sale_reminders rm ON rm.case_id = ac.id
          ${whereSql}
          GROUP BY ac.id
          ORDER BY hasTimeoutReminder DESC, ac.updated_at DESC, ac.id DESC
          LIMIT @limit OFFSET @offset
        `,
      )
      .all({
        ...params,
        limit: pageSize,
        offset,
      }) as Array<{
      id: number;
      caseNo: string;
      orderId: number;
      caseType: AfterSaleCaseType;
      caseStatus: AfterSaleCaseStatus;
      reason: string;
      priority: string;
      latestResult: string | null;
      deadlineAt: string;
      createdAt: string;
      updatedAt: string;
      orderNo: string;
      storeName: string;
      productName: string;
      customerName: string;
      requestedAmount: number | null;
      approvedAmount: number | null;
      refundStatus: AfterSaleRefundStatus | null;
      resendStatus: AfterSaleResendStatus | null;
      disputeStatus: AfterSaleDisputeStatus | null;
      compensationAmount: number | null;
      reminderTypesText: string | null;
      hasTimeoutReminder: number;
    }>;

    return {
      total: Number(totalRow.total ?? 0),
      page,
      pageSize,
      list: rows.map((row) => ({
        ...row,
        caseTypeText: this.getAfterSaleCaseTypeText(row.caseType),
        caseStatusText: this.getAfterSaleCaseStatusText(row.caseStatus),
        priorityText: this.getAfterSalePriorityText(row.priority),
        refundStatusText: row.refundStatus ? this.getAfterSaleRefundStatusText(row.refundStatus) : null,
        resendStatusText: row.resendStatus ? this.getAfterSaleResendStatusText(row.resendStatus) : null,
        disputeStatusText: row.disputeStatus ? this.getAfterSaleDisputeStatusText(row.disputeStatus) : null,
        reminderTypes: row.reminderTypesText
          ? (row.reminderTypesText.split(',').filter(Boolean) as AfterSaleReminderType[])
          : [],
        canReviewRefund:
          row.caseType === 'refund' &&
          Boolean(row.refundStatus && ['pending_review', 'approved'].includes(row.refundStatus)),
        canExecuteResend:
          row.caseType === 'resend' &&
          Boolean(row.resendStatus && ['requested', 'approved', 'failed'].includes(row.resendStatus)),
        canConcludeDispute:
          row.caseType === 'dispute' &&
          Boolean(row.disputeStatus && ['open', 'processing'].includes(row.disputeStatus)),
        canNote: true,
      })),
    };
  }

  getAfterSaleDetail(caseId: number) {
    const context = this.getAfterSaleCaseContext(caseId);
    if (!context) {
      return null;
    }

    const orderRow = this.db
      .prepare(
        `
          SELECT
            o.id,
            o.order_no AS orderNo,
            s.name AS storeName,
            p.name AS productName,
            c.name AS customerName,
            o.paid_amount AS paidAmount,
            o.refund_amount AS refundAmount,
            o.main_status AS mainStatus,
            o.delivery_status AS deliveryStatus,
            o.after_sale_status AS afterSaleStatus,
            o.paid_at AS paidAt,
            o.updated_at AS updatedAt
          FROM orders o
          LEFT JOIN stores s ON s.id = o.store_id
          LEFT JOIN products p ON p.id = o.product_id
          LEFT JOIN customers c ON c.id = o.customer_id
          WHERE o.id = ?
        `,
      )
      .get(context.orderId) as {
      id: number;
      orderNo: string;
      storeName: string;
      productName: string;
      customerName: string;
      paidAmount: number;
      refundAmount: number;
      mainStatus: OrderMainStatus;
      deliveryStatus: OrderDeliveryStatus;
      afterSaleStatus: string;
      paidAt: string;
      updatedAt: string;
    };

    const records = this.db
      .prepare(
        `
          SELECT
            id,
            record_type AS recordType,
            title,
            detail,
            operator_name AS operatorName,
            created_at AS createdAt
          FROM after_sale_records
          WHERE case_id = ?
          ORDER BY created_at DESC, id DESC
        `,
      )
      .all(caseId) as Array<{
      id: number;
      recordType: string;
      title: string;
      detail: string;
      operatorName: string | null;
      createdAt: string;
    }>;

    const reminders = this.db
      .prepare(
        `
          SELECT
            id,
            reminder_type AS reminderType,
            reminder_status AS reminderStatus,
            title,
            detail,
            remind_at AS remindAt,
            resolved_at AS resolvedAt
          FROM after_sale_reminders
          WHERE case_id = ?
          ORDER BY remind_at DESC, id DESC
        `,
      )
      .all(caseId) as Array<{
      id: number;
      reminderType: AfterSaleReminderType;
      reminderStatus: AfterSaleReminderStatus;
      title: string;
      detail: string;
      remindAt: string;
      resolvedAt: string | null;
    }>;

    const cardOutbounds = this.db
      .prepare(
        `
          SELECT
            outbound_no AS outboundNo,
            outbound_status AS outboundStatus,
            reason,
            created_at AS createdAt
          FROM card_outbound_records
          WHERE order_id = ?
          ORDER BY id DESC
          LIMIT 5
        `,
      )
      .all(context.orderId) as Array<{
      outboundNo: string;
      outboundStatus: CardOutboundStatus;
      reason: string | null;
      createdAt: string;
    }>;

    const directJobs = this.db
      .prepare(
        `
          SELECT
            task_no AS taskNo,
            supplier_order_no AS supplierOrderNo,
            task_status AS taskStatus,
            result_detail AS resultDetail,
            updated_at AS updatedAt
          FROM direct_charge_jobs
          WHERE order_id = ?
          ORDER BY id DESC
          LIMIT 5
        `,
      )
      .all(context.orderId) as Array<{
      taskNo: string;
      supplierOrderNo: string | null;
      taskStatus: DirectChargeJobStatus;
      resultDetail: string | null;
      updatedAt: string;
    }>;

    const fulfillment = this.loadOrderFulfillmentMeta([context.orderId]).get(context.orderId);

    return {
      caseInfo: {
        id: context.id,
        caseNo: context.caseNo,
        orderId: context.orderId,
        orderNo: context.orderNo,
        caseType: context.caseType,
        caseTypeText: this.getAfterSaleCaseTypeText(context.caseType),
        caseStatus: context.caseStatus,
        caseStatusText: this.getAfterSaleCaseStatusText(context.caseStatus),
        reason: context.reason,
        priority: context.priority,
        priorityText: this.getAfterSalePriorityText(context.priority),
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
            refundStatusText: this.getAfterSaleRefundStatusText(context.refundStatus!),
          }
        : null,
      resend: context.resendId
        ? {
            resendStatus: context.resendStatus!,
            resendStatusText: this.getAfterSaleResendStatusText(context.resendStatus!),
            fulfillmentType: context.resendFulfillmentType,
            relatedOutboundNo: context.relatedOutboundNo,
            relatedTaskNo: context.relatedTaskNo,
          }
        : null,
      dispute: context.disputeId
        ? {
            disputeStatus: context.disputeStatus!,
            disputeStatusText: this.getAfterSaleDisputeStatusText(context.disputeStatus!),
            compensationAmount: Number(context.compensationAmount ?? 0),
          }
        : null,
      order: {
        ...orderRow,
        mainStatusText: this.getOrderMainStatusText(orderRow.mainStatus),
        deliveryStatusText: this.getOrderDeliveryStatusText(orderRow.deliveryStatus),
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
        cardOutbounds,
        directJobs,
      },
      records,
      reminders: reminders.map((row) => ({
        ...row,
        reminderTypeText: this.getAfterSaleReminderTypeText(row.reminderType),
      })),
    };
  }

  reviewAfterSaleRefund(
    caseId: number,
    decision: 'approve' | 'reject' | 'refund',
    approvedAmount: number | undefined,
    note: string,
    operatorName: string,
  ) {
    const context = this.getAfterSaleCaseContext(caseId);
    if (!context || context.caseType !== 'refund' || !context.refundStatus) {
      return null;
    }

    const now = format(new Date(), 'yyyy-MM-dd HH:mm:ss');

    if (decision === 'approve') {
      if (context.refundStatus !== 'pending_review') {
        return null;
      }

      const nextApprovedAmount = Number(
        Math.min(context.paidAmount, Math.max(0, approvedAmount ?? context.requestedAmount ?? 0)).toFixed(2),
      );
      if (nextApprovedAmount <= 0) {
        return null;
      }

      this.db.transaction(() => {
        this.db
          .prepare(
            `
              UPDATE after_sale_refunds
              SET
                approved_amount = @approvedAmount,
                refund_status = 'approved',
                review_note = @reviewNote,
                reviewed_by = @reviewedBy,
                reviewed_at = @reviewedAt
              WHERE case_id = @caseId
            `,
          )
          .run({
            caseId,
            approvedAmount: nextApprovedAmount,
            reviewNote: note,
            reviewedBy: operatorName,
            reviewedAt: now,
          });

        this.db
          .prepare(
            `
              UPDATE after_sale_cases
              SET
                case_status = 'processing',
                latest_result = @latestResult,
                updated_at = @updatedAt
              WHERE id = @id
            `,
          )
          .run({
            id: caseId,
            latestResult: `退款审核通过，待退款 ${nextApprovedAmount} 元。`,
            updatedAt: now,
          });

        this.appendAfterSaleRecord(
          caseId,
          'refund_approved',
          '退款审核通过',
          note || `退款审核通过，待退款 ${nextApprovedAmount} 元。`,
          operatorName,
          now,
        );
        this.appendOrderEvent(
          context.orderId,
          'after_sale_refund_approved',
          '退款审核通过',
          `售后单 ${context.caseNo} 已通过退款审核，待退款 ${nextApprovedAmount} 元。`,
          operatorName,
          now,
        );
        this.syncOrderAfterSaleState(context.orderId, now);
        this.refreshAfterSaleReminders(caseId, now);
      })();

      this.syncFundCenterLedger();

      return {
        success: true,
        caseStatus: 'processing' as const,
        refundStatus: 'approved' as const,
        approvedAmount: nextApprovedAmount,
      };
    }

    if (decision === 'reject') {
      if (context.refundStatus !== 'pending_review') {
        return null;
      }

      this.db.transaction(() => {
        this.db
          .prepare(
            `
              UPDATE after_sale_refunds
              SET
                approved_amount = 0,
                refund_status = 'rejected',
                review_note = @reviewNote,
                reviewed_by = @reviewedBy,
                reviewed_at = @reviewedAt
              WHERE case_id = @caseId
            `,
          )
          .run({
            caseId,
            reviewNote: note,
            reviewedBy: operatorName,
            reviewedAt: now,
          });

        this.db
          .prepare(
            `
              UPDATE after_sale_cases
              SET
                case_status = 'rejected',
                latest_result = @latestResult,
                updated_at = @updatedAt,
                closed_at = @closedAt
              WHERE id = @id
            `,
          )
          .run({
            id: caseId,
            latestResult: note || '退款申请已驳回。',
            updatedAt: now,
            closedAt: now,
          });

        this.appendAfterSaleRecord(
          caseId,
          'refund_rejected',
          '退款审核驳回',
          note || '退款申请已驳回。',
          operatorName,
          now,
        );
        this.appendOrderEvent(
          context.orderId,
          'after_sale_refund_rejected',
          '退款审核驳回',
          `售后单 ${context.caseNo} 的退款申请已驳回。`,
          operatorName,
          now,
        );
        this.syncOrderAfterSaleState(context.orderId, now);
        this.refreshAfterSaleReminders(caseId, now);
      })();

      this.syncFundCenterLedger();

      return {
        success: true,
        caseStatus: 'rejected' as const,
        refundStatus: 'rejected' as const,
      };
    }

    if (context.refundStatus !== 'approved') {
      return null;
    }

    const finalRefundAmount = Number(
      Math.min(context.paidAmount, Math.max(context.refundAmount, context.approvedAmount ?? 0)).toFixed(2),
    );

    this.db.transaction(() => {
      this.db
        .prepare(
          `
            UPDATE after_sale_refunds
            SET
              refund_status = 'refunded',
              refunded_at = @refundedAt,
              review_note = CASE
                WHEN review_note = '' THEN @reviewNote
                ELSE review_note
              END
            WHERE case_id = @caseId
          `,
        )
        .run({
          caseId,
          refundedAt: now,
          reviewNote: note,
        });

      this.db
        .prepare(
          `
            UPDATE after_sale_cases
            SET
              case_status = 'resolved',
              latest_result = @latestResult,
              updated_at = @updatedAt,
              closed_at = @closedAt
            WHERE id = @id
          `,
        )
        .run({
          id: caseId,
          latestResult: `退款已完成，退款金额 ${finalRefundAmount} 元。`,
          updatedAt: now,
          closedAt: now,
        });

      this.appendAfterSaleRecord(
        caseId,
        'refund_completed',
        '退款完成',
        note || `退款 ${finalRefundAmount} 元已原路退回。`,
        operatorName,
        now,
      );
      this.appendOrderEvent(
        context.orderId,
        'after_sale_refunded',
        '售后退款完成',
        `售后单 ${context.caseNo} 已完成退款，金额 ${finalRefundAmount} 元。`,
        operatorName,
        now,
      );
      this.syncOrderAfterSaleState(context.orderId, now, finalRefundAmount);
      this.refreshAfterSaleReminders(caseId, now);
    })();

    this.syncFundCenterLedger();

    return {
      success: true,
      caseStatus: 'resolved' as const,
      refundStatus: 'refunded' as const,
      refundAmount: finalRefundAmount,
    };
  }

  executeAfterSaleResend(
    caseId: number,
    decision: 'approve' | 'reject' | 'success' | 'failed',
    note: string,
    operatorName: string,
  ) {
    const context = this.getAfterSaleCaseContext(caseId);
    if (!context || context.caseType !== 'resend' || !context.resendStatus) {
      return null;
    }

    const now = format(new Date(), 'yyyy-MM-dd HH:mm:ss');

    if (decision === 'approve') {
      if (context.resendStatus !== 'requested') {
        return null;
      }

      this.db.transaction(() => {
        this.db
          .prepare(
            `
              UPDATE after_sale_resends
              SET
                resend_status = 'approved',
                result_detail = @detail
              WHERE case_id = @caseId
            `,
          )
          .run({
            caseId,
            detail: note || '补发申请已通过，等待执行。',
          });
        this.db
          .prepare(
            `
              UPDATE after_sale_cases
              SET
                case_status = 'waiting_execute',
                latest_result = @latestResult,
                updated_at = @updatedAt
              WHERE id = @id
            `,
          )
          .run({
            id: caseId,
            latestResult: note || '补发申请已通过，等待执行。',
            updatedAt: now,
          });
        this.appendAfterSaleRecord(
          caseId,
          'resend_approved',
          '补发审核通过',
          note || '补发申请已通过。',
          operatorName,
          now,
        );
        this.appendOrderEvent(
          context.orderId,
          'after_sale_resend_approved',
          '补发申请已通过',
          `售后单 ${context.caseNo} 已通过补发审核。`,
          operatorName,
          now,
        );
        this.syncOrderAfterSaleState(context.orderId, now);
        this.refreshAfterSaleReminders(caseId, now);
      })();

      return {
        success: true,
        caseStatus: 'waiting_execute' as const,
        resendStatus: 'approved' as const,
      };
    }

    if (decision === 'reject') {
      if (!['requested', 'approved'].includes(context.resendStatus)) {
        return null;
      }

      this.db.transaction(() => {
        this.db
          .prepare(
            `
              UPDATE after_sale_resends
              SET
                resend_status = 'rejected',
                result_detail = @detail
              WHERE case_id = @caseId
            `,
          )
          .run({
            caseId,
            detail: note || '补发申请已驳回。',
          });
        this.db
          .prepare(
            `
              UPDATE after_sale_cases
              SET
                case_status = 'rejected',
                latest_result = @latestResult,
                updated_at = @updatedAt,
                closed_at = @closedAt
              WHERE id = @id
            `,
          )
          .run({
            id: caseId,
            latestResult: note || '补发申请已驳回。',
            updatedAt: now,
            closedAt: now,
          });
        this.appendAfterSaleRecord(
          caseId,
          'resend_rejected',
          '补发申请驳回',
          note || '补发申请已驳回。',
          operatorName,
          now,
        );
        this.appendOrderEvent(
          context.orderId,
          'after_sale_resend_rejected',
          '补发申请驳回',
          `售后单 ${context.caseNo} 的补发申请已驳回。`,
          operatorName,
          now,
        );
        this.syncOrderAfterSaleState(context.orderId, now);
        this.refreshAfterSaleReminders(caseId, now);
      })();

      return {
        success: true,
        caseStatus: 'rejected' as const,
        resendStatus: 'rejected' as const,
      };
    }

    if (decision === 'failed') {
      if (!['requested', 'approved', 'failed'].includes(context.resendStatus)) {
        return null;
      }

      this.db.transaction(() => {
        this.db
          .prepare(
            `
              UPDATE after_sale_resends
              SET
                resend_status = 'failed',
                result_detail = @detail,
                executed_at = @executedAt
              WHERE case_id = @caseId
            `,
          )
          .run({
            caseId,
            detail: note || '补发执行失败，待重新处理。',
            executedAt: now,
          });
        this.db
          .prepare(
            `
              UPDATE after_sale_cases
              SET
                case_status = 'processing',
                latest_result = @latestResult,
                updated_at = @updatedAt
              WHERE id = @id
            `,
          )
          .run({
            id: caseId,
            latestResult: note || '补发执行失败，待重新处理。',
            updatedAt: now,
          });
        this.appendAfterSaleRecord(
          caseId,
          'resend_failed',
          '补发执行失败',
          note || '补发执行失败。',
          operatorName,
          now,
        );
        this.appendOrderEvent(
          context.orderId,
          'after_sale_resend_failed',
          '补发执行失败',
          `售后单 ${context.caseNo} 的补发执行失败，等待继续处理。`,
          operatorName,
          now,
        );
        this.syncOrderAfterSaleState(context.orderId, now);
        this.refreshAfterSaleReminders(caseId, now);
      })();

      return {
        success: true,
        caseStatus: 'processing' as const,
        resendStatus: 'failed' as const,
      };
    }

    if (!['requested', 'approved', 'failed'].includes(context.resendStatus)) {
      return null;
    }

    const resendResult = this.resendOrderFulfillment(context.orderId);
    if (!resendResult?.success) {
      return null;
    }

    const outboundNo =
      resendResult.resendRecord?.outboundNo ??
      context.relatedOutboundNo ??
      null;

    this.db.transaction(() => {
      this.db
        .prepare(
          `
            UPDATE after_sale_resends
            SET
              resend_status = 'succeeded',
              result_detail = @detail,
              related_outbound_no = COALESCE(@relatedOutboundNo, related_outbound_no),
              executed_at = @executedAt,
              completed_at = @completedAt
            WHERE case_id = @caseId
          `,
        )
        .run({
          caseId,
          detail: note || '补发已执行完成。',
          relatedOutboundNo: outboundNo,
          executedAt: now,
          completedAt: now,
        });
      this.db
        .prepare(
          `
            UPDATE after_sale_cases
            SET
              case_status = 'resolved',
              latest_result = @latestResult,
              updated_at = @updatedAt,
              closed_at = @closedAt
            WHERE id = @id
          `,
        )
        .run({
          id: caseId,
          latestResult: outboundNo ? `补发执行完成，出库单号 ${outboundNo}。` : '补发执行完成。',
          updatedAt: now,
          closedAt: now,
        });
      this.appendAfterSaleRecord(
        caseId,
        'resend_completed',
        '补发执行完成',
        outboundNo ? `补发已完成，出库单号 ${outboundNo}。` : '补发已完成。',
        operatorName,
        now,
      );
      this.appendOrderEvent(
        context.orderId,
        'after_sale_resend_completed',
        '售后补发完成',
        outboundNo ? `售后单 ${context.caseNo} 已完成补发，出库单号 ${outboundNo}。` : `售后单 ${context.caseNo} 已完成补发。`,
        operatorName,
        now,
      );
      this.syncOrderAfterSaleState(context.orderId, now);
      this.refreshAfterSaleReminders(caseId, now);
    })();

    this.syncFundCenterLedger();

    return {
      success: true,
      caseStatus: 'resolved' as const,
      resendStatus: 'succeeded' as const,
      outboundNo,
    };
  }

  concludeAfterSaleDispute(
    caseId: number,
    decision: 'buyer_win' | 'seller_win' | 'refund' | 'resend',
    note: string,
    compensationAmount: number | undefined,
    operatorName: string,
  ) {
    const context = this.getAfterSaleCaseContext(caseId);
    if (!context || context.caseType !== 'dispute' || !context.disputeStatus) {
      return null;
    }

    if (!['open', 'processing'].includes(context.disputeStatus)) {
      return null;
    }

    const now = format(new Date(), 'yyyy-MM-dd HH:mm:ss');
    const nextCompensationAmount = Number(Math.max(0, compensationAmount ?? context.compensationAmount ?? 0).toFixed(2));
    const conclusionText =
      {
        buyer_win: '争议判定支持买家。',
        seller_win: '争议判定支持卖家。',
        refund: '争议判定转退款处理。',
        resend: '争议判定转补发处理。',
      }[decision] ?? note;

    this.db.transaction(() => {
      this.db
        .prepare(
          `
            UPDATE after_sale_disputes
            SET
              dispute_status = @disputeStatus,
              responsibility = @responsibility,
              conclusion = @conclusion,
              compensation_amount = @compensationAmount,
              concluded_by = @concludedBy,
              concluded_at = @concludedAt
            WHERE case_id = @caseId
          `,
        )
        .run({
          caseId,
          disputeStatus: decision,
          responsibility:
            decision === 'buyer_win' || decision === 'refund'
              ? 'seller'
              : decision === 'seller_win'
                ? 'buyer'
                : 'shared',
          conclusion: note || conclusionText,
          compensationAmount: nextCompensationAmount,
          concludedBy: operatorName,
          concludedAt: now,
        });
      this.db
        .prepare(
          `
            UPDATE after_sale_cases
            SET
              case_status = 'resolved',
              latest_result = @latestResult,
              updated_at = @updatedAt,
              closed_at = @closedAt
            WHERE id = @id
          `,
        )
        .run({
          id: caseId,
          latestResult: note || conclusionText,
          updatedAt: now,
          closedAt: now,
        });
      this.appendAfterSaleRecord(
        caseId,
        'dispute_concluded',
        '争议结论已登记',
        note || conclusionText,
        operatorName,
        now,
      );
      this.appendOrderEvent(
        context.orderId,
        'after_sale_dispute_concluded',
        '争议结论已登记',
        `售后单 ${context.caseNo} 已登记争议结论：${note || conclusionText}`,
        operatorName,
        now,
      );
      this.syncOrderAfterSaleState(context.orderId, now);
      this.refreshAfterSaleReminders(caseId, now);
    })();

    return {
      success: true,
      caseStatus: 'resolved' as const,
      disputeStatus: decision,
      compensationAmount: nextCompensationAmount,
    };
  }

  noteAfterSaleCase(caseId: number, note: string, operatorName: string) {
    const context = this.getAfterSaleCaseContext(caseId);
    if (!context) {
      return null;
    }

    const now = format(new Date(), 'yyyy-MM-dd HH:mm:ss');
    const noteLine = `[${now}] ${operatorName}：${note}`;
    const currentRemarkRow = this.db
      .prepare('SELECT seller_remark AS sellerRemark FROM orders WHERE id = ?')
      .get(context.orderId) as { sellerRemark: string };
    const nextRemark = currentRemarkRow.sellerRemark
      ? `${currentRemarkRow.sellerRemark}\n${noteLine}`
      : noteLine;

    this.db.transaction(() => {
      this.db
        .prepare(
          `
            UPDATE after_sale_cases
            SET
              updated_at = @updatedAt
            WHERE id = @id
          `,
        )
        .run({
          id: caseId,
          updatedAt: now,
        });
      this.db
        .prepare(
          `
            UPDATE orders
            SET
              seller_remark = @sellerRemark,
              updated_at = @updatedAt
            WHERE id = @id
          `,
        )
        .run({
          id: context.orderId,
          sellerRemark: nextRemark,
          updatedAt: now,
        });
      this.appendAfterSaleRecord(caseId, 'note', '售后备注已更新', note, operatorName, now);
      this.appendOrderEvent(
        context.orderId,
        'after_sale_note',
        '售后备注已更新',
        `售后单 ${context.caseNo} 追加备注：${note}`,
        operatorName,
        now,
      );
      this.refreshAfterSaleReminders(caseId, now);
    })();

    return {
      success: true,
      sellerRemark: nextRemark,
    };
  }

  private ensureProductFulfillmentRulesTable() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS product_fulfillment_rules (
        product_id INTEGER PRIMARY KEY,
        fulfillment_type TEXT NOT NULL,
        supplier_id TEXT,
        external_sku TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(product_id) REFERENCES products(id)
      );
    `);
  }

  getProductFulfillmentRule(productId: number) {
    this.ensureProductFulfillmentRulesTable();

    const row = this.db
      .prepare(
        `
          SELECT
            product_id AS productId,
            fulfillment_type AS fulfillmentType,
            supplier_id AS supplierId,
            external_sku AS externalSku
          FROM product_fulfillment_rules
          WHERE product_id = ?
        `,
      )
      .get(productId) as
      | {
          productId: number;
          fulfillmentType: 'standard' | 'direct_charge' | 'source_system';
          supplierId: string | null;
          externalSku: string | null;
        }
      | undefined;

    return (
      row ?? {
        productId,
        fulfillmentType: 'standard',
        supplierId: null,
        externalSku: null,
      }
    );
  }

  upsertProductFulfillmentRule(
    productId: number,
    input: {
      fulfillmentType: 'standard' | 'direct_charge' | 'source_system';
      supplierId?: string | null;
      externalSku?: string | null;
    },
  ) {
    this.ensureProductFulfillmentRulesTable();

    const now = format(new Date(), 'yyyy-MM-dd HH:mm:ss');
    const supplierId = input.fulfillmentType === 'standard' ? null : input.supplierId?.trim() || null;
    const externalSku =
      input.fulfillmentType === 'source_system' ? input.externalSku?.trim() || null : null;

    this.db
      .prepare(
        `
          INSERT INTO product_fulfillment_rules (
            product_id,
            fulfillment_type,
            supplier_id,
            external_sku,
            created_at,
            updated_at
          ) VALUES (
            @productId,
            @fulfillmentType,
            @supplierId,
            @externalSku,
            @createdAt,
            @updatedAt
          )
          ON CONFLICT(product_id) DO UPDATE SET
            fulfillment_type = excluded.fulfillment_type,
            supplier_id = excluded.supplier_id,
            external_sku = excluded.external_sku,
            updated_at = excluded.updated_at
        `,
      )
      .run({
        productId,
        fulfillmentType: input.fulfillmentType,
        supplierId,
        externalSku,
        createdAt: now,
        updatedAt: now,
      });

    return this.getProductFulfillmentRule(productId);
  }

  getProductsView(filters: QueryFilters) {
    const range = this.resolveDateRange(filters);
    const { whereSql, params } = this.buildOrderWhere(filters, range);
    const { whereSql: productWhereSql, params: productParams } = this.buildProductWhere(filters);
    const activitySummary = this.db
      .prepare(
        `
        SELECT
          COUNT(DISTINCT p.id) AS activeProducts,
          SUM(o.quantity) AS soldQuantity,
          SUM(o.paid_amount) AS salesAmount
        FROM orders o
        LEFT JOIN products p ON p.id = o.product_id
        LEFT JOIN customers c ON c.id = o.customer_id
        ${whereSql}
      `,
      )
      .get(params) as Record<string, number | null>;

    const inventorySummary = this.db
      .prepare(
        `
        SELECT
          COUNT(*) AS totalProducts,
          SUM(stock) AS totalStock,
          SUM(CASE WHEN stock <= 30 THEN 1 ELSE 0 END) AS lowStockProducts,
          COUNT(DISTINCT category) AS categoryCount
        FROM products p
        ${productWhereSql}
      `,
      )
      .get(productParams) as Record<string, number | null>;

    const categorySales = this.db
      .prepare(
        `
        SELECT
          p.category AS category,
          SUM(o.paid_amount) AS salesAmount,
          SUM(o.quantity) AS soldQuantity
        FROM orders o
        LEFT JOIN products p ON p.id = o.product_id
        LEFT JOIN customers c ON c.id = o.customer_id
        ${whereSql}
        GROUP BY p.category
        ORDER BY salesAmount DESC
      `,
      )
      .all(params);

    const ranking = this.db
      .prepare(
        `
        WITH order_agg AS (
          SELECT
            o.product_id AS productId,
            SUM(o.quantity) AS soldQuantity,
            SUM(o.paid_amount) AS salesAmount,
            COUNT(*) AS orderCount,
            SUM(CASE WHEN o.after_sale_status != 'none' THEN 1 ELSE 0 END) AS afterSaleCount,
            MIN(o.paid_at) AS firstSaleAt,
            MAX(o.updated_at) AS latestSaleAt
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
          s.name AS storeName,
          p.stock,
          COALESCE(oa.soldQuantity, 0) AS soldQuantity,
          COALESCE(oa.salesAmount, 0) AS salesAmount,
          COALESCE(oa.orderCount, 0) AS orderCount,
          COALESCE(oa.afterSaleCount, 0) AS afterSaleCount,
          oa.firstSaleAt AS firstSaleAt,
          oa.latestSaleAt AS latestSaleAt
        FROM products p
        LEFT JOIN stores s ON s.id = p.store_id
        LEFT JOIN order_agg oa ON oa.productId = p.id
        ${productWhereSql}
        ORDER BY COALESCE(oa.salesAmount, 0) DESC, p.id DESC
        LIMIT 12
      `,
      )
      .all({ ...params, ...productParams });

    return {
      summary: {
        totalProducts: Number(inventorySummary.totalProducts ?? 0),
        totalStock: Number(inventorySummary.totalStock ?? 0),
        activeProducts: Number(activitySummary.activeProducts ?? 0),
        soldQuantity: Number(activitySummary.soldQuantity ?? 0),
        salesAmount: Number((activitySummary.salesAmount ?? 0).toFixed(2)),
        lowStockProducts: Number(inventorySummary.lowStockProducts ?? 0),
        categoryCount: Number(inventorySummary.categoryCount ?? 0),
      },
      categorySales,
      ranking,
    };
  }

  getCustomersView(filters: QueryFilters) {
    const range = this.resolveDateRange(filters);
    const { whereSql, params } = this.buildOrderWhere(filters, range);
    const summary = this.db
      .prepare(
        `
        SELECT
          COUNT(DISTINCT o.customer_id) AS customerCount,
          COUNT(DISTINCT CASE WHEN o.is_new_customer = 1 THEN o.customer_id END) AS newCustomers,
          COUNT(DISTINCT CASE WHEN o.is_new_customer = 0 THEN o.customer_id END) AS repeatCustomers,
          SUM(o.paid_amount) AS salesAmount
        FROM orders o
        LEFT JOIN products p ON p.id = o.product_id
        LEFT JOIN customers c ON c.id = o.customer_id
        ${whereSql}
      `,
      )
      .get(params) as Record<string, number | null>;

    const provinceRows = this.db
      .prepare(
        `
        SELECT
          c.province,
          COUNT(DISTINCT o.customer_id) AS customerCount,
          SUM(o.paid_amount) AS salesAmount
        FROM orders o
        LEFT JOIN products p ON p.id = o.product_id
        LEFT JOIN customers c ON c.id = o.customer_id
        ${whereSql}
        GROUP BY c.province
        ORDER BY salesAmount DESC
        LIMIT 10
      `,
      )
      .all(params);

    const customerList = this.db
      .prepare(
        `
        SELECT
          c.id,
          c.name,
          c.province,
          COUNT(o.id) AS orderCount,
          SUM(o.paid_amount) AS totalSpend,
          MAX(o.paid_at) AS latestOrderAt
        FROM orders o
        LEFT JOIN products p ON p.id = o.product_id
        LEFT JOIN customers c ON c.id = o.customer_id
        ${whereSql}
        GROUP BY c.id
        ORDER BY totalSpend DESC
        LIMIT 12
      `,
      )
      .all(params);

    const customerCount = Number(summary.customerCount ?? 0);
    const repeatCustomers = Number(summary.repeatCustomers ?? 0);
    const salesAmount = Number(summary.salesAmount ?? 0);

    return {
      summary: {
        customerCount,
        newCustomers: Number(summary.newCustomers ?? 0),
        repeatCustomers,
        averageSpend: customerCount === 0 ? 0 : Number((salesAmount / customerCount).toFixed(2)),
        repeatRate: customerCount === 0 ? 0 : toPercentage((repeatCustomers / customerCount) * 100),
      },
      provinceRows,
      customerList,
    };
  }

  getBusinessReports(filters: QueryFilters) {
    const range = this.resolveDateRange(filters);
    const currentSnapshot = this.getReportSnapshot({
      ...filters,
      startDate: range.startIso,
      endDate: range.endIso,
      preset: filters.preset,
    });
    const previousSnapshot = this.getReportSnapshot({
      ...filters,
      startDate: range.previousStartIso,
      endDate: range.previousEndIso,
      preset: filters.preset,
    });

    const compareMetric = (current: number, previous: number) => {
      if (previous === 0) {
        return current === 0 ? 0 : 100;
      }
      return toPercentage(((current - previous) / previous) * 100);
    };

    const netSalesAmount = currentSnapshot.metrics.receivedAmount - currentSnapshot.metrics.refundAmount;
    const previousNetSalesAmount =
      previousSnapshot.metrics.receivedAmount - previousSnapshot.metrics.refundAmount;

    return {
      range: {
        startDate: range.startIso,
        endDate: range.endIso,
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
          compareRate: compareMetric(
            currentSnapshot.metrics.netProfit,
            previousSnapshot.metrics.netProfit,
          ),
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
      filters: this.getFilterOptions(),
    };
  }

  exportBusinessReportsCsv(filters: QueryFilters) {
    const report = this.getBusinessReports(filters);
    const sections: string[] = [];

    const appendSection = (title: string, headers: string[], rows: Array<Array<string | number>>) => {
      sections.push(title);
      sections.push(headers.join(','));
      rows.forEach((row) => {
        sections.push(row.map((cell) => this.escapeCsvCell(cell)).join(','));
      });
      sections.push('');
    };

    appendSection(
      '报表摘要',
      ['指标', '数值', '单位', '环比'],
      report.summary.map((item) => [
        item.label,
        item.value,
        item.unit,
        `${item.compareRate.toFixed(2)}%`,
      ]),
    );

    appendSection(
      '统计口径',
      ['指标', '数值', '单位', '公式', '说明'],
      report.formulas.map((item) => [
        item.label,
        item.value,
        item.unit,
        item.formula,
        item.description,
      ]),
    );

    appendSection(
      '店铺维度统计',
      [
        '店铺',
        '订单数',
        '实收金额',
        '退款金额',
        '净销售额',
        '毛利',
        '毛利率',
        '售后单数',
        '履约成功率',
        '人工处理单',
        '平均发货时长',
      ],
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
      [
        '商品',
        'SKU',
        '店铺',
        '分类',
        '订单数',
        '销量',
        '实收金额',
        '退款金额',
        '净销售额',
        '毛利',
        '毛利率',
        '售后单数',
        '履约成功率',
      ],
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
      report.orderStats.sourceDistribution.map((item) => [
        item.source,
        item.orderCount,
        item.salesAmount,
      ]),
    );

    appendSection(
      '履约队列分布',
      ['履约队列', '订单数'],
      report.orderStats.fulfillmentDistribution.map((item) => [item.label, item.orderCount]),
    );

    appendSection(
      '售后维度概览',
      ['指标', '数值', '单位', '说明'],
      report.afterSaleStats.overview.map((item) => [
        item.label,
        item.value,
        item.unit,
        item.description,
      ]),
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
      report.afterSaleStats.statusDistribution.map((item) => [
        item.caseStatusText,
        item.caseCount,
      ]),
    );

    appendSection(
      '时间趋势',
      ['日期', '订单原额', '实收金额', '退款金额', '净利润', '订单数', '售后单数'],
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

  private getReportSnapshot(filters: QueryFilters): ReportSnapshot {
    const range = this.resolveDateRange(filters);
    const orders = this.getReportOrderRows(filters, range);
    const cases = this.getReportCaseRows(filters, range);
    const metrics = this.summarizeReportMetrics(orders, cases);
    const nowText = format(new Date(), 'yyyy-MM-dd HH:mm:ss');
    const caseCountByOrderId = new Map<number, number>();

    cases.forEach((row) => {
      caseCountByOrderId.set(row.orderId, (caseCountByOrderId.get(row.orderId) ?? 0) + 1);
    });

    const storeMap = new Map<
      number,
      {
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
      }
    >();
    const productMap = new Map<
      number,
      {
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
      }
    >();
    const sourceMap = new Map<string, { source: string; orderCount: number; salesAmount: number }>();
    const mainStatusMap = new Map<string, { status: string; label: string; orderCount: number }>();
    const fulfillmentMap = new Map<string, { queue: string; label: string; orderCount: number }>();
    const trendMap = new Map<
      string,
      {
        reportDate: string;
        grossAmount: number;
        receivedAmount: number;
        refundAmount: number;
        netProfit: number;
        orderCount: number;
        afterSaleCaseCount: number;
      }
    >();

    for (let cursor = range.start; cursor <= range.end; cursor = addDays(cursor, 1)) {
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

      const sourceRow = sourceMap.get(row.source) ?? { source: row.source, orderCount: 0, salesAmount: 0 };
      sourceRow.orderCount += 1;
      sourceRow.salesAmount += row.receivedAmount;
      sourceMap.set(row.source, sourceRow);

      const statusRow = mainStatusMap.get(row.mainStatus) ?? {
        status: row.mainStatus,
        label: this.getOrderMainStatusText(row.mainStatus),
        orderCount: 0,
      };
      statusRow.orderCount += 1;
      mainStatusMap.set(row.mainStatus, statusRow);

      const fulfillmentRow = fulfillmentMap.get(row.fulfillmentQueue) ?? {
        queue: row.fulfillmentQueue,
        label: this.getOrderFulfillmentQueueText(row.fulfillmentQueue),
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

    const typeMap = new Map<
      AfterSaleCaseType,
      {
        caseType: AfterSaleCaseType;
        caseTypeText: string;
        caseCount: number;
        resolvedCount: number;
        timeoutCount: number;
        refundAmount: number;
        compensationAmount: number;
      }
    >();
    const caseStatusMap = new Map<
      AfterSaleCaseStatus,
      {
        caseStatus: AfterSaleCaseStatus;
        caseStatusText: string;
        caseCount: number;
      }
    >();

    cases.forEach((row) => {
      const reportDate = row.createdAt.slice(0, 10);
      const timeout = this.isTimeoutAfterSaleCase(row.caseStatus, row.deadlineAt, nowText);

      const typeRow = typeMap.get(row.caseType) ?? {
        caseType: row.caseType,
        caseTypeText: this.getAfterSaleCaseTypeText(row.caseType),
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
        caseStatusText: this.getAfterSaleCaseStatusText(row.caseStatus),
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
    const timeoutCases = cases.filter((row) =>
      this.isTimeoutAfterSaleCase(row.caseStatus, row.deadlineAt, nowText),
    ).length;
    const pendingCases = cases.filter((row) =>
      ['pending_review', 'processing', 'waiting_execute'].includes(row.caseStatus),
    ).length;
    const resolvedCases = cases.filter((row) => row.caseStatus === 'resolved').length;
    const rejectedCases = cases.filter((row) => row.caseStatus === 'rejected').length;
    const successFulfillmentCount = orders.filter((row) => row.fulfillmentQueue === 'success').length;
    const manualReviewCount = orders.filter((row) => row.fulfillmentQueue === 'manual_review').length;

    return {
      orders,
      cases,
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
          grossMargin:
            row.netSalesAmount === 0 ? 0 : toPercentage((row.grossProfit / row.netSalesAmount) * 100),
          completedOrders: row.completedOrders,
          afterSaleCases: row.afterSaleCases,
          successFulfillmentCount: row.successFulfillmentCount,
          manualReviewCount: row.manualReviewCount,
          successFulfillmentRate:
            row.orderCount === 0 ? 0 : toPercentage((row.successFulfillmentCount / row.orderCount) * 100),
          averageDeliveryHours:
            row.deliveryHoursCount === 0
              ? 0
              : Number((row.deliveryHoursTotal / row.deliveryHoursCount).toFixed(2)),
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
          grossMargin:
            row.netSalesAmount === 0 ? 0 : toPercentage((row.grossProfit / row.netSalesAmount) * 100),
          afterSaleCases: row.afterSaleCases,
          successFulfillmentRate:
            row.orderCount === 0 ? 0 : toPercentage((row.successFulfillmentCount / row.orderCount) * 100),
        }))
        .sort((left, right) => right.netSalesAmount - left.netSalesAmount),
      orderStats: {
        overview: [
          {
            key: 'totalOrders',
            label: '订单总数',
            value: orders.length,
            unit: '单',
            description: '按支付时间命中过滤条件的订单总量。',
          },
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
            value:
              orders.length === 0 ? 0 : toPercentage((successFulfillmentCount / orders.length) * 100),
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
        statusDistribution: Array.from(mainStatusMap.values()).sort(
          (left, right) => right.orderCount - left.orderCount,
        ),
        sourceDistribution: Array.from(sourceMap.values())
          .map((row) => ({
            source: row.source,
            orderCount: row.orderCount,
            salesAmount: Number(row.salesAmount.toFixed(2)),
          }))
          .sort((left, right) => right.salesAmount - left.salesAmount),
        fulfillmentDistribution: Array.from(fulfillmentMap.values()).sort(
          (left, right) => right.orderCount - left.orderCount,
        ),
      },
      afterSaleStats: {
        overview: [
          {
            key: 'totalCases',
            label: '售后总单量',
            value: totalAfterSaleCases,
            unit: '单',
            description: '售后主单 after_sale_cases 的过滤结果。',
          },
          {
            key: 'pendingCases',
            label: '处理中售后',
            value: pendingCases,
            unit: '单',
            description: '包含待审核、处理中、待执行三类开放状态。',
          },
          {
            key: 'resolvedCases',
            label: '已完结售后',
            value: resolvedCases,
            unit: '单',
            description: 'case_status = resolved。',
          },
          {
            key: 'rejectedCases',
            label: '已驳回售后',
            value: rejectedCases,
            unit: '单',
            description: 'case_status = rejected。',
          },
          {
            key: 'timeoutCases',
            label: '超时售后',
            value: timeoutCases,
            unit: '单',
            description: '当前时间超过 SLA 且未完结的售后。',
          },
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
            value:
              totalAfterSaleCases === 0 ? 0 : toPercentage((resolvedCases / totalAfterSaleCases) * 100),
            unit: '%',
            description: '已完结售后 / 售后总单量。',
          },
        ],
        typeDistribution: Array.from(typeMap.values())
          .map((row) => ({
            ...row,
            refundAmount: Number(row.refundAmount.toFixed(2)),
            compensationAmount: Number(row.compensationAmount.toFixed(2)),
          }))
          .sort((left, right) => right.caseCount - left.caseCount),
        statusDistribution: Array.from(caseStatusMap.values()).sort(
          (left, right) => right.caseCount - left.caseCount,
        ),
      },
      trend: Array.from(trendMap.values())
        .map((row) => ({
          reportDate: row.reportDate,
          grossAmount: Number(row.grossAmount.toFixed(2)),
          receivedAmount: Number(row.receivedAmount.toFixed(2)),
          refundAmount: Number(row.refundAmount.toFixed(2)),
          netProfit: Number(row.netProfit.toFixed(2)),
          orderCount: row.orderCount,
          afterSaleCaseCount: row.afterSaleCaseCount,
        }))
        .sort((left, right) => left.reportDate.localeCompare(right.reportDate)),
    };
  }

  private getReportOrderRows(filters: QueryFilters, range: DateRange) {
    const { whereSql, params } = this.buildOrderWhere(filters, range);
    const rows = this.db
      .prepare(
        `
        SELECT
          o.id,
          o.order_no AS orderNo,
          o.store_id AS storeId,
          s.name AS storeName,
          o.product_id AS productId,
          p.name AS productName,
          p.sku AS productSku,
          p.category AS category,
          o.source,
          o.quantity,
          o.paid_amount AS paidAmount,
          o.refund_amount AS refundAmount,
          COALESCE(op.grossAmount, o.paid_amount + o.discount_amount) AS grossAmount,
          COALESCE(op.discountAmount, o.discount_amount) AS discountAmount,
          COALESCE(op.receivedAmount, o.paid_amount) AS receivedAmount,
          COALESCE(op.paymentCount, 0) AS paymentCount,
          p.cost AS unitCost,
          o.main_status AS mainStatus,
          o.payment_status AS paymentStatus,
          o.delivery_status AS deliveryStatus,
          o.order_status AS orderStatus,
          o.after_sale_status AS afterSaleStatus,
          o.paid_at AS paidAt,
          o.completed_at AS completedAt,
          o.delivery_hours AS deliveryHours,
          o.is_new_customer AS isNewCustomer
        FROM orders o
        LEFT JOIN products p ON p.id = o.product_id
        LEFT JOIN stores s ON s.id = o.store_id
        LEFT JOIN customers c ON c.id = o.customer_id
        LEFT JOIN (
          SELECT
            order_id,
            SUM(gross_amount) AS grossAmount,
            SUM(discount_amount) AS discountAmount,
            SUM(paid_amount) AS receivedAmount,
            COUNT(*) AS paymentCount
          FROM order_payments
          GROUP BY order_id
        ) op ON op.order_id = o.id
        ${whereSql}
        ORDER BY o.paid_at ASC, o.id ASC
      `,
      )
      .all(params) as Array<
      Omit<ReportOrderRow, 'fulfillmentType' | 'fulfillmentQueue'>
    >;

    const fulfillmentMetaMap = this.loadOrderFulfillmentMeta(rows.map((row) => row.id));

    return rows.map((row) => {
      const meta = fulfillmentMetaMap.get(row.id);
      return {
        ...row,
        grossAmount: Number(row.grossAmount ?? 0),
        discountAmount: Number(row.discountAmount ?? 0),
        receivedAmount: Number(row.receivedAmount ?? row.paidAmount ?? 0),
        paymentCount: Number(row.paymentCount ?? 0),
        unitCost: Number(row.unitCost ?? 0),
        fulfillmentType: meta?.fulfillmentType ?? 'standard',
        fulfillmentQueue: meta?.fulfillmentQueue ?? 'pending',
      };
    });
  }

  private getReportCaseRows(filters: QueryFilters, range: DateRange) {
    const { whereSql, params } = this.buildAfterSaleWhere(filters, range);
    return this.db
      .prepare(
        `
        SELECT
          ac.id AS caseId,
          ac.case_no AS caseNo,
          ac.order_id AS orderId,
          o.order_no AS orderNo,
          o.store_id AS storeId,
          s.name AS storeName,
          o.product_id AS productId,
          p.name AS productName,
          p.category AS category,
          ac.case_type AS caseType,
          ac.case_status AS caseStatus,
          ac.priority,
          ac.latest_result AS latestResult,
          ac.created_at AS createdAt,
          ac.sla_deadline_at AS deadlineAt,
          rf.refund_status AS refundStatus,
          rf.requested_amount AS requestedAmount,
          rf.approved_amount AS approvedAmount,
          rs.resend_status AS resendStatus,
          ad.dispute_status AS disputeStatus,
          ad.compensation_amount AS compensationAmount
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
      )
      .all(params) as ReportCaseRow[];
  }

  private summarizeReportMetrics(orders: ReportOrderRow[], cases: ReportCaseRow[]): MetricSummary {
    const grossAmount = orders.reduce((sum, row) => sum + row.grossAmount, 0);
    const receivedAmount = orders.reduce((sum, row) => sum + row.receivedAmount, 0);
    const discountAmount = orders.reduce((sum, row) => sum + row.discountAmount, 0);
    const refundAmount = orders.reduce((sum, row) => sum + row.refundAmount, 0);
    const costAmount = orders.reduce((sum, row) => sum + row.unitCost * row.quantity, 0);
    const compensationAmount = cases.reduce(
      (sum, row) => sum + Number(row.compensationAmount ?? 0),
      0,
    );
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
          : Number(
              (
                deliveryRows.reduce((sum, row) => sum + row.deliveryHours, 0) / deliveryRows.length
              ).toFixed(2),
            ),
    };
  }

  private isTimeoutAfterSaleCase(
    caseStatus: AfterSaleCaseStatus,
    deadlineAt: string,
    nowText = format(new Date(), 'yyyy-MM-dd HH:mm:ss'),
  ) {
    return !['resolved', 'rejected'].includes(caseStatus) && deadlineAt < nowText;
  }

  private escapeCsvCell(value: string | number | null | undefined) {
    return `"${String(value ?? '').replaceAll('"', '""')}"`;
  }

  private getAdminUserId() {
    const row = this.db
      .prepare(
        `
          SELECT id
          FROM users
          WHERE role = 'admin'
          ORDER BY id
          LIMIT 1
        `,
      )
      .get() as { id: number } | undefined;
    return row?.id ?? null;
  }

  private normalizeStoreTags(tags: string[] | string | null | undefined) {
    const raw = Array.isArray(tags) ? tags : typeof tags === 'string' ? tags.split(',') : [];
    return Array.from(new Set(raw.map((item) => item.trim()).filter(Boolean))).join(',');
  }

  private parseStoreTags(tagsText: string) {
    return tagsText
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
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
        browser_qr_login_started: '浏览器扫码启动',
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

  private syncStoreAccessState() {
    this.db
      .prepare(
        `
          UPDATE store_auth_sessions
          SET
            status = 'expired',
            invalid_reason = COALESCE(NULLIF(invalid_reason, ''), '授权会话已过期')
          WHERE status = 'pending'
            AND expires_at IS NOT NULL
            AND datetime(expires_at) < datetime('now', 'localtime')
        `,
      )
      .run();

    this.db
      .prepare(
        `
          UPDATE managed_stores
          SET
            auth_status = 'expired',
            connection_status = CASE
              WHEN connection_status = 'pending_activation' THEN 'pending_activation'
              WHEN enabled = 0 THEN connection_status
              ELSE 'offline'
            END,
            activation_status = CASE
              WHEN connection_status = 'pending_activation' THEN 'pending_activation'
              WHEN enabled = 0 THEN activation_status
              ELSE 'offline'
            END,
            health_status = CASE
              WHEN enabled = 0 THEN health_status
              ELSE 'offline'
            END,
            last_health_check_detail = CASE
              WHEN COALESCE(last_health_check_detail, '') = ''
              THEN '授权已过期，需要重新授权。'
              ELSE last_health_check_detail
            END,
            status_text = CASE
              WHEN enabled = 0 THEN '已停用'
              WHEN connection_status = 'pending_activation' THEN '未激活'
              ELSE '掉线'
            END
          WHERE auth_status = 'authorized'
            AND auth_expires_at IS NOT NULL
            AND datetime(auth_expires_at) < datetime('now', 'localtime')
        `,
      )
      .run();
  }

  private upsertStoreOwnerAccount(input: {
    accountId?: number | null;
    platform: StorePlatform;
    ownerName: string;
    mobile: string;
    loginMode: 'sms' | 'password' | 'oauth' | 'cookie';
    authorizedByUserId: number | null;
  }) {
    const now = format(new Date(), 'yyyy-MM-dd HH:mm:ss');
    const existingById = input.accountId
      ? (this.db
          .prepare('SELECT id FROM store_owner_accounts WHERE id = ?')
          .get(input.accountId) as { id: number } | undefined)
      : undefined;
    const existingByMobile = !existingById
      ? (this.db
          .prepare(
            `
              SELECT id
              FROM store_owner_accounts
              WHERE platform = ? AND mobile = ?
              ORDER BY id DESC
              LIMIT 1
            `,
          )
          .get(input.platform, input.mobile) as { id: number } | undefined)
      : undefined;

    const accountId = existingById?.id ?? existingByMobile?.id;

    if (accountId) {
      this.db
        .prepare(
          `
            UPDATE store_owner_accounts
            SET
              owner_name = @ownerName,
              mobile = @mobile,
              login_mode = @loginMode,
              account_status = 'active',
              last_authorized_at = @lastAuthorizedAt,
              last_authorized_by = @lastAuthorizedBy,
              updated_at = @updatedAt
            WHERE id = @id
          `,
        )
        .run({
          id: accountId,
          ownerName: input.ownerName,
          mobile: input.mobile,
          loginMode: input.loginMode,
          lastAuthorizedAt: now,
          lastAuthorizedBy: input.authorizedByUserId,
          updatedAt: now,
        });

      return accountId;
    }

    const result = this.db
      .prepare(
        `
          INSERT INTO store_owner_accounts (
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
            @platform,
            @ownerName,
            @mobile,
            @loginMode,
            'active',
            @lastAuthorizedAt,
            @lastAuthorizedBy,
            @createdAt,
            @updatedAt
          )
        `,
      )
      .run({
        platform: input.platform,
        ownerName: input.ownerName,
        mobile: input.mobile,
        loginMode: input.loginMode,
        lastAuthorizedAt: now,
        lastAuthorizedBy: input.authorizedByUserId,
        createdAt: now,
        updatedAt: now,
      });

    return Number(result.lastInsertRowid);
  }

  private listManagedStores() {
    this.syncStoreAccessState();

    const rows = this.db
      .prepare(
        `
          SELECT
            ms.id,
            ms.platform,
            ms.shop_type_label AS shopTypeLabel,
            ms.shop_name AS shopName,
            ms.seller_no AS sellerNo,
            ms.nickname,
            ms.status_text AS statusText,
            ms.activation_status AS activationStatus,
            ms.package_text AS packageText,
            ms.publish_limit_text AS publishLimitText,
            ms.created_at AS createdAt,
            ms.updated_at AS updatedAt,
            ms.owner_account_id AS ownerAccountId,
            oa.owner_name AS ownerAccountName,
            oa.mobile AS ownerMobile,
            ms.created_by_user_id AS createdByUserId,
            u.display_name AS createdByName,
            ms.group_name AS groupName,
            ms.tags_text AS tagsText,
            ms.remark,
            ms.enabled,
            ms.connection_status AS connectionStatus,
            ms.auth_status AS authStatus,
            ms.auth_expires_at AS authExpiresAt,
            ms.last_sync_at AS lastSyncAt,
            ms.health_status AS healthStatus,
            ms.last_health_check_at AS lastHealthCheckAt,
            ms.last_health_check_detail AS lastHealthCheckDetail,
            ms.last_session_id AS lastSessionId,
            ms.last_reauthorize_at AS lastReauthorizeAt,
            ms.provider_store_id AS providerStoreId,
            ms.provider_user_id AS providerUserId,
            ms.credential_id AS credentialId,
            spc.credential_type AS credentialType,
            spc.credential_source AS credentialSource,
            spc.risk_level AS credentialRiskLevel,
            spc.risk_reason AS credentialRiskReason,
            spc.verification_url AS credentialVerificationUrl,
            spc.last_renewed_at AS lastCredentialRenewAt,
            spc.last_renew_status AS lastCredentialRenewStatus,
            ms.profile_sync_status AS profileSyncStatus,
            ms.profile_sync_error AS profileSyncError,
            ms.last_profile_sync_at AS lastProfileSyncAt,
            ms.last_verified_at AS lastVerifiedAt
          FROM managed_stores ms
          LEFT JOIN store_owner_accounts oa ON oa.id = ms.owner_account_id
          LEFT JOIN users u ON u.id = ms.created_by_user_id
          LEFT JOIN store_platform_credentials spc ON spc.id = ms.credential_id
          ORDER BY ms.updated_at DESC, ms.id DESC
        `,
      )
      .all() as ManagedStoreRecord[];

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
          connectionStatus === 'pending_activation'
            ? '授权已完成，激活后才会进入正式调度。'
            : null,
      };
    });
  }

  private getStoreAuthCallbackSigningSecret() {
    const row = this.db
      .prepare(
        `
          SELECT value_encrypted AS valueEncrypted
          FROM secure_settings
          WHERE key = 'xianyu_callback_secret'
          LIMIT 1
        `,
      )
      .get() as { valueEncrypted: string } | undefined;

    if (!row?.valueEncrypted) {
      return appConfig.secureConfigSecret;
    }

    try {
      return decryptSecret(row.valueEncrypted, appConfig.secureConfigSecret);
    } catch {
      return appConfig.secureConfigSecret;
    }
  }

  private isLegacyStoreAuthProviderState(state: string, expectedSessionId: string) {
    const segments = state.split('.');
    return segments.length === 2 && parseStoreAuthSessionIdFromState(state) === expectedSessionId;
  }

  private getStoreCredentialBySessionId(sessionId: string) {
    return this.db
      .prepare(
        `
          SELECT
            id,
            platform,
            store_id AS storeId,
            owner_account_id AS ownerAccountId,
            provider_key AS providerKey,
            credential_type AS credentialType,
            access_token_masked AS accessTokenMasked,
            expires_at AS expiresAt,
            provider_user_id AS providerUserId,
            provider_shop_id AS providerShopId,
            provider_shop_name AS providerShopName,
            scope_text AS scopeText
          FROM store_platform_credentials
          WHERE session_id = ?
          ORDER BY id DESC
          LIMIT 1
        `,
      )
      .get(sessionId) as
      | {
          id: number;
          platform: StorePlatform;
          storeId: number | null;
          ownerAccountId: number | null;
          providerKey: string;
          credentialType: string;
          accessTokenMasked: string;
          expiresAt: string | null;
          providerUserId: string | null;
          providerShopId: string | null;
          providerShopName: string | null;
          scopeText: string;
        }
      | undefined;
  }

  private deleteScopedStoreCredential(input: {
    sessionId: string;
    platform: StorePlatform;
    providerKey: string;
    credentialType: 'access_token' | 'web_session';
    storeId: number | null;
    ownerAccountId: number | null;
    keepCredentialId?: number | null;
  }) {
    if (input.keepCredentialId !== null && input.keepCredentialId !== undefined) {
      this.db
        .prepare(
          `
            DELETE FROM store_platform_credentials
            WHERE platform = @platform
              AND provider_key = @providerKey
              AND credential_type = @credentialType
              AND session_id = @sessionId
              AND id <> @keepCredentialId
          `,
        )
        .run({
          sessionId: input.sessionId,
          platform: input.platform,
          providerKey: input.providerKey,
          credentialType: input.credentialType,
          keepCredentialId: input.keepCredentialId,
        });
    } else {
      this.db
        .prepare(
          `
            DELETE FROM store_platform_credentials
            WHERE platform = @platform
              AND provider_key = @providerKey
              AND credential_type = @credentialType
              AND session_id = @sessionId
          `,
        )
        .run({
          sessionId: input.sessionId,
          platform: input.platform,
          providerKey: input.providerKey,
          credentialType: input.credentialType,
        });
    }

    if (input.storeId !== null) {
      this.db
        .prepare(
          `
            DELETE FROM store_platform_credentials
            WHERE platform = @platform
              AND provider_key = @providerKey
              AND credential_type = @credentialType
              AND store_id = @storeId
              AND (session_id IS NULL OR session_id <> @sessionId)
              AND (@keepCredentialId IS NULL OR id <> @keepCredentialId)
          `,
        )
        .run({
          sessionId: input.sessionId,
          platform: input.platform,
          providerKey: input.providerKey,
          credentialType: input.credentialType,
          storeId: input.storeId,
          keepCredentialId: input.keepCredentialId ?? null,
        });
      return;
    }

    if (input.ownerAccountId !== null) {
      this.db
        .prepare(
          `
            DELETE FROM store_platform_credentials
            WHERE platform = @platform
              AND provider_key = @providerKey
              AND credential_type = @credentialType
              AND store_id IS NULL
              AND owner_account_id = @ownerAccountId
              AND (session_id IS NULL OR session_id <> @sessionId)
              AND (@keepCredentialId IS NULL OR id <> @keepCredentialId)
          `,
        )
        .run({
          sessionId: input.sessionId,
          platform: input.platform,
          providerKey: input.providerKey,
          credentialType: input.credentialType,
          ownerAccountId: input.ownerAccountId,
          keepCredentialId: input.keepCredentialId ?? null,
        });
    }
  }

  recordStoreCredentialEvent(input: {
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
    const now = format(new Date(), 'yyyy-MM-dd HH:mm:ss');
    this.db
      .prepare(
        `
          INSERT INTO store_credential_events (
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
            @storeId,
            @sessionId,
            @credentialId,
            @eventType,
            @status,
            @detail,
            @source,
            @riskLevel,
            @verificationUrl,
            @operatorUserId,
            @createdAt
          )
        `,
      )
      .run({
        storeId: input.storeId ?? null,
        sessionId: input.sessionId ?? null,
        credentialId: input.credentialId ?? null,
        eventType: input.eventType,
        status: input.status,
        detail: input.detail.trim(),
        source: input.source?.trim() || null,
        riskLevel: input.riskLevel ?? null,
        verificationUrl: input.verificationUrl?.trim() || null,
        operatorUserId: input.operatorUserId ?? null,
        createdAt: now,
      });

    return {
      eventType: input.eventType,
      status: input.status,
      detail: input.detail.trim(),
      createdAt: now,
    };
  }

  private bindStoreCredentialEventsToStore(
    sessionId: string,
    input: { storeId: number; credentialId?: number | null },
  ) {
    this.db
      .prepare(
        `
          UPDATE store_credential_events
          SET
            store_id = @storeId,
            credential_id = COALESCE(credential_id, @credentialId)
          WHERE session_id = @sessionId
        `,
      )
      .run({
        sessionId,
        storeId: input.storeId,
        credentialId: input.credentialId ?? null,
      });
  }

  getStoreCredentialEvents(storeId: number, limit = 40) {
    return this.storeAccessReadRepository.getStoreCredentialEvents(storeId, limit);
  }

  getStoreCredentialEventsBySession(sessionId: string, limit = 40) {
    return this.storeAccessReadRepository.getStoreCredentialEventsBySession(sessionId, limit);
  }

  private findManagedStoreByProviderShopId(platform: StorePlatform, providerShopId: string) {
    return this.db
      .prepare(
        `
          SELECT
            id,
            seller_no AS sellerNo,
            connection_status AS connectionStatus,
            enabled
          FROM managed_stores
          WHERE platform = ? AND provider_store_id = ?
          LIMIT 1
        `,
      )
      .get(platform, providerShopId) as
      | {
          id: number;
          sellerNo: string;
          connectionStatus: StoreConnectionStatus;
          enabled: number;
        }
      | undefined;
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
          nextStepText: '正在同步卖家与店铺资料，请稍候刷新。',
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
        nextStepText: '等待跳转到闲鱼授权页并接收官方回调。',
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

  private listStoreAuthSessions(limit = 24) {
    this.syncStoreAccessState();

    const rows = this.db
      .prepare(
        `
          SELECT
            sas.session_id AS sessionId,
            sas.platform,
            sas.source,
            sas.auth_type AS authType,
            sas.status,
            sas.integration_mode AS integrationMode,
            sas.provider_label AS providerLabel,
            sas.next_step AS nextStep,
            sas.profile_sync_status AS profileSyncStatus,
            sas.profile_sync_error AS profileSyncError,
            sas.created_at AS createdAt,
            sas.expires_at AS expiresAt,
            sas.completed_at AS completedAt,
            sas.invalid_reason AS invalidReason,
            sas.provider_access_token_received_at AS providerAccessTokenReceivedAt,
            sas.store_id AS storeId,
            sas.owner_account_id AS ownerAccountId,
            sas.mobile,
            sas.nickname,
            sas.reauthorize,
            ms.shop_name AS storeName,
            oa.owner_name AS ownerAccountName,
            u.display_name AS createdByName
          FROM store_auth_sessions sas
          LEFT JOIN managed_stores ms ON ms.id = sas.store_id
          LEFT JOIN store_owner_accounts oa ON oa.id = sas.owner_account_id
          LEFT JOIN users u ON u.id = sas.created_by_user_id
          ORDER BY sas.created_at DESC, sas.session_id DESC
          LIMIT ?
        `,
      )
      .all(limit) as Array<{
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

  private listStoreHealthChecks(limit = 24) {
    const rows = this.db
      .prepare(
        `
          SELECT
            shc.id,
            shc.store_id AS storeId,
            ms.shop_name AS storeName,
            shc.status,
            shc.detail,
            shc.checked_at AS checkedAt,
            shc.trigger_mode AS triggerMode,
            u.display_name AS triggeredByName
          FROM store_health_checks shc
          LEFT JOIN managed_stores ms ON ms.id = shc.store_id
          LEFT JOIN users u ON u.id = shc.triggered_by_user_id
          ORDER BY shc.checked_at DESC, shc.id DESC
          LIMIT ?
        `,
      )
      .all(limit) as Array<{
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

  getStoreManagementOverview() {
    this.syncStoreAccessState();
    return this.storeAccessReadRepository.getStoreManagementOverview();
  }

  createStoreAuthSession(input: {
    platform: StorePlatform;
    source: string;
    authType: number;
    storeId?: number | null;
    createdByUserId?: number | null;
  }) {
    this.syncStoreAccessState();
    return this.storeAccessWriteRepository.createStoreAuthSession(input);
  }

  refreshStoreAuthSessionWindow(
    sessionId: string,
    input?: {
      minutes?: number;
      reviveExpiredWebSession?: boolean;
    },
  ) {
    this.syncStoreAccessState();
    return this.storeAccessWriteRepository.refreshStoreAuthSessionWindow(sessionId, input);
  }

  getStoreAuthSessionDetail(sessionId: string) {
    this.syncStoreAccessState();
    return this.storeAccessReadRepository.getStoreAuthSessionDetail(sessionId);
  }

  receiveStoreAuthProviderCallback(input: {
    sessionId: string;
    state: string;
    accessToken: string;
    tokenType?: string | null;
    expiresInSeconds?: number | null;
    rawCallback?: string | null;
  }) {
    this.syncStoreAccessState();
    return this.storeAccessWriteRepository.receiveStoreAuthProviderCallback(input);
  }

  receiveStoreAuthSessionWebCredential(
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
    this.syncStoreAccessState();
    return this.storeAccessWriteRepository.receiveStoreAuthSessionWebCredential(sessionId, input);
  }

  syncStoreAuthSessionWebSession(
    sessionId: string,
    input: {
      cookieText?: string | null;
      providerUserId: string;
      providerShopId: string;
      providerShopName: string;
      mobile: string;
      nickname?: string | null;
      scopeText?: string | null;
      refreshToken?: string | null;
    },
    syncedByUserId: number,
  ) {
    this.syncStoreAccessState();
    return this.storeAccessWriteRepository.syncStoreAuthSessionWebSession(
      sessionId,
      input,
      syncedByUserId,
    );
  }

  syncStoreAuthSessionProfile(
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
    this.syncStoreAccessState();
    return this.storeAccessWriteRepository.syncStoreAuthSessionProfile(sessionId, input, syncedByUserId);
  }

  completeStoreAuthSession(
    sessionId: string,
    payload: { mobile: string; nickname: string; loginMode: 'sms' | 'password' },
    completedByUserId: number | null,
  ) {
    this.syncStoreAccessState();
    return this.storeAccessWriteRepository.completeStoreAuthSession(
      sessionId,
      payload,
      completedByUserId,
    );
  }

  activateManagedStore(storeId: number) {
    this.syncStoreAccessState();
    return this.storeAccessWriteRepository.activateManagedStore(storeId);
  }

  getStoreAuthSessionWebSessionCredential(sessionId: string) {
    return this.storeAccessReadRepository.getStoreAuthSessionWebSessionCredential(sessionId);
  }

  getManagedStoreWebSessionCredential(storeId: number) {
    return this.storeAccessReadRepository.getManagedStoreWebSessionCredential(storeId);
  }

  private parseXianyuWebSocketAuthCache(payloadText: string | null) {
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
      } satisfies XianyuWebSocketAuthCache;
    } catch {
      return null;
    }
  }

  saveManagedStoreXianyuImAuthCache(
    storeId: number,
    cache: XianyuWebSocketAuthCache,
    source = 'ai_bargain_sync',
  ) {
    const now = format(new Date(), 'yyyy-MM-dd HH:mm:ss');
    this.db
      .prepare(
        `
          INSERT INTO xianyu_im_session_auth_cache (
            store_id,
            auth_snapshot_encrypted,
            source,
            captured_at,
            expires_at,
            updated_at
          ) VALUES (
            @storeId,
            @authSnapshotEncrypted,
            @source,
            @capturedAt,
            @expiresAt,
            @updatedAt
          )
          ON CONFLICT(store_id) DO UPDATE SET
            auth_snapshot_encrypted = excluded.auth_snapshot_encrypted,
            source = excluded.source,
            captured_at = excluded.captured_at,
            expires_at = excluded.expires_at,
            updated_at = excluded.updated_at
        `,
      )
      .run({
        storeId,
        authSnapshotEncrypted: encryptSecret(
          JSON.stringify(cache),
          appConfig.secureConfigSecret,
        ),
        source: source.trim() || 'ai_bargain_sync',
        capturedAt: cache.capturedAt,
        expiresAt: cache.expiresAt,
        updatedAt: now,
      });
  }

  clearManagedStoreXianyuImAuthCache(storeId: number) {
    this.db.prepare('DELETE FROM xianyu_im_session_auth_cache WHERE store_id = ?').run(storeId);
  }

  listManagedStoreProductSyncTargets(storeIds?: number[]) {
    return this.storeAccessReadRepository.listManagedStoreProductSyncTargets(storeIds);
  }

  listManagedStoreOrderSyncTargets(storeIds?: number[]) {
    return this.storeAccessReadRepository.listManagedStoreOrderSyncTargets(storeIds);
  }

  listManagedStoreAiBargainSyncTargets(storeIds?: number[]) {
    return this.storeAccessReadRepository.listManagedStoreAiBargainSyncTargets(storeIds);
  }

  getManagedStoreXianyuImSyncTarget(storeId: number) {
    return this.storeAccessReadRepository.getManagedStoreXianyuImSyncTarget(storeId);
  }

  private markManagedStoreBusinessSyncHealthy(
    storeId: number,
    input: {
      detail: string;
      verifiedAt: string;
    },
  ) {
    this.db
      .prepare(
        `
          UPDATE store_platform_credentials
          SET
            risk_level = 'healthy',
            risk_reason = @riskReason,
            verification_url = NULL,
            last_verified_at = @lastVerifiedAt,
            updated_at = @updatedAt
          WHERE store_id = @storeId
            AND credential_type = 'web_session'
        `,
      )
      .run({
        storeId,
        riskReason: input.detail,
        lastVerifiedAt: input.verifiedAt,
        updatedAt: input.verifiedAt,
      });

    this.db
      .prepare(
        `
          UPDATE managed_stores
          SET
            connection_status = 'active',
            activation_status = 'active',
            auth_status = 'authorized',
            health_status = 'healthy',
            last_health_check_at = @lastHealthCheckAt,
            last_health_check_detail = @lastHealthCheckDetail,
            last_verified_at = @lastVerifiedAt,
            status_text = @statusText,
            last_sync_at = @lastSyncAt,
            updated_at = @updatedAt
          WHERE id = @id
        `,
      )
      .run({
        id: storeId,
        lastHealthCheckAt: input.verifiedAt,
        lastHealthCheckDetail: input.detail,
        lastVerifiedAt: input.verifiedAt,
        lastSyncAt: input.verifiedAt,
        statusText: this.getManagedStoreStatusText('active', true),
        updatedAt: input.verifiedAt,
      });
  }

  syncManagedStoreProducts(input: {
    storeId: number;
    items: Array<{
      id: string;
      title: string;
      categoryLabel: string;
      price: number;
      stock: number;
    }>;
  }) {
    const store = this.db
      .prepare(
        `
          SELECT
            ms.id,
            ms.shop_name AS shopName,
            COALESCE(oa.owner_name, ms.nickname, ms.shop_name) AS ownerName
          FROM managed_stores ms
          LEFT JOIN store_owner_accounts oa ON oa.id = ms.owner_account_id
          WHERE ms.id = ?
        `,
      )
      .get(input.storeId) as { id: number; shopName: string; ownerName: string } | undefined;

    if (!store) {
      return null;
    }

    const now = format(new Date(), 'yyyy-MM-dd HH:mm:ss');
    this.db
      .prepare(
        `
          INSERT INTO stores (id, name, manager)
          VALUES (@id, @name, @manager)
          ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            manager = excluded.manager
        `,
      )
      .run({
        id: store.id,
        name: store.shopName,
        manager: store.ownerName,
      });

    const upsertProduct = this.db.prepare(
      `
        INSERT INTO products (id, store_id, sku, name, category, price, cost, stock)
        VALUES (@id, @storeId, @sku, @name, @category, @price, @cost, @stock)
        ON CONFLICT(id) DO UPDATE SET
          store_id = excluded.store_id,
          sku = excluded.sku,
          name = excluded.name,
          category = excluded.category,
          price = excluded.price,
          stock = excluded.stock
      `,
    );

    let syncedCount = 0;
    let skippedCount = 0;
    for (const item of input.items) {
      const productId = Number(item.id);
      if (!Number.isSafeInteger(productId) || productId <= 0) {
        skippedCount += 1;
        continue;
      }

      upsertProduct.run({
        id: productId,
        storeId: store.id,
        sku: item.id,
        name: item.title.trim() || `闲鱼商品 ${item.id}`,
        category: item.categoryLabel.trim() || '未分类',
        price: Number.isFinite(item.price) ? item.price : 0,
        cost: 0,
        stock: Math.max(0, Math.trunc(item.stock)),
      });
      syncedCount += 1;
    }

    this.markManagedStoreBusinessSyncHealthy(store.id, {
      detail: '真实商品同步成功，当前凭据可用于业务接口调用。',
      verifiedAt: now,
    });

    return {
      storeId: store.id,
      shopName: store.shopName,
      syncedCount,
      skippedCount,
      syncedAt: now,
    };
  }

  syncManagedStoreOrders(input: {
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
    const store = this.db
      .prepare(
        `
          SELECT
            ms.id,
            ms.shop_name AS shopName,
            COALESCE(oa.owner_name, ms.nickname, ms.shop_name) AS ownerName
          FROM managed_stores ms
          LEFT JOIN store_owner_accounts oa ON oa.id = ms.owner_account_id
          WHERE ms.id = ?
        `,
      )
      .get(input.storeId) as { id: number; shopName: string; ownerName: string } | undefined;

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

    this.db
      .prepare(
        `
          INSERT INTO stores (id, name, manager)
          VALUES (@id, @name, @manager)
          ON CONFLICT(id) DO UPDATE SET
            name = excluded.name,
            manager = excluded.manager
        `,
      )
      .run({
        id: store.id,
        name: store.shopName,
        manager: store.ownerName,
      });

    const selectProduct = this.db.prepare(
      `
        SELECT
          id,
          category,
          cost,
          stock
        FROM products
        WHERE id = ?
      `,
    );
    const upsertProduct = this.db.prepare(
      `
        INSERT INTO products (id, store_id, sku, name, category, price, cost, stock)
        VALUES (@id, @storeId, @sku, @name, @category, @price, @cost, @stock)
        ON CONFLICT(id) DO UPDATE SET
          store_id = excluded.store_id,
          sku = excluded.sku,
          name = excluded.name,
          category = CASE
            WHEN COALESCE(products.category, '') = '' OR products.category = '未分类' THEN excluded.category
            ELSE products.category
          END,
          price = excluded.price
      `,
    );
    const selectCustomerRef = this.db.prepare(
      `
        SELECT
          cer.customer_id AS customerId
        FROM customer_external_refs cer
        WHERE cer.provider = @provider
          AND cer.external_customer_id = @externalCustomerId
        LIMIT 1
      `,
    );
    const insertCustomer = this.db.prepare(
      `
        INSERT INTO customers (name, province, registered_at)
        VALUES (@name, @province, @registeredAt)
      `,
    );
    const updateCustomer = this.db.prepare(
      `
        UPDATE customers
        SET
          name = @name,
          province = @province
        WHERE id = @id
      `,
    );
    const insertCustomerRef = this.db.prepare(
      `
        INSERT INTO customer_external_refs (provider, external_customer_id, customer_id, created_at)
        VALUES (@provider, @externalCustomerId, @customerId, @createdAt)
        ON CONFLICT(provider, external_customer_id) DO UPDATE SET
          customer_id = excluded.customer_id
      `,
    );
    const selectOrder = this.db.prepare(
      `
        SELECT
          id,
          buyer_note AS buyerNote,
          seller_remark AS sellerRemark
        FROM orders
        WHERE order_no = ?
        LIMIT 1
      `,
    );
    const insertOrder = this.db.prepare(
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
          @orderNo,
          @storeId,
          @productId,
          @customerId,
          @source,
          @quantity,
          @paidAmount,
          @discountAmount,
          @orderStatus,
          @mainStatus,
          @paymentStatus,
          @deliveryStatus,
          @afterSaleStatus,
          @refundAmount,
          @paidAt,
          @shippedAt,
          @completedAt,
          @deliveryHours,
          @isNewCustomer,
          @buyerNote,
          @sellerRemark,
          @createdAt,
          @updatedAt
        )
      `,
    );
    const updateOrder = this.db.prepare(
      `
        UPDATE orders
        SET
          store_id = @storeId,
          product_id = @productId,
          customer_id = @customerId,
          source = @source,
          quantity = @quantity,
          paid_amount = @paidAmount,
          discount_amount = @discountAmount,
          order_status = @orderStatus,
          main_status = @mainStatus,
          payment_status = @paymentStatus,
          delivery_status = @deliveryStatus,
          after_sale_status = @afterSaleStatus,
          refund_amount = @refundAmount,
          paid_at = @paidAt,
          shipped_at = @shippedAt,
          completed_at = @completedAt,
          delivery_hours = @deliveryHours,
          is_new_customer = @isNewCustomer,
          buyer_note = @buyerNote,
          seller_remark = @sellerRemark,
          updated_at = @updatedAt
        WHERE id = @id
      `,
    );
    const deleteOrderItems = this.db.prepare('DELETE FROM order_items WHERE order_id = ?');
    const deleteOrderPayments = this.db.prepare('DELETE FROM order_payments WHERE order_id = ?');
    const deleteOrderEvents = this.db.prepare("DELETE FROM order_events WHERE order_id = ? AND event_type LIKE 'xianyu_%'");
    const insertOrderItem = this.db.prepare(
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
          @orderId,
          1,
          @productId,
          @productName,
          @productSku,
          @category,
          @quantity,
          @unitPrice,
          @paidAmount,
          @deliveryStatus,
          @afterSaleStatus,
          @createdAt,
          @updatedAt
        )
      `,
    );
    const insertOrderPayment = this.db.prepare(
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
          @orderId,
          @paymentNo,
          '支付宝',
          @paymentStatus,
          @grossAmount,
          @discountAmount,
          @paidAmount,
          @paidAt,
          @settledAt,
          @createdAt,
          @updatedAt
        )
      `,
    );
    const selectOrderPayment = this.db.prepare(
      `
        SELECT id
        FROM order_payments
        WHERE order_id = ?
        ORDER BY id ASC
        LIMIT 1
      `,
    );
    const updateOrderPayment = this.db.prepare(
      `
        UPDATE order_payments
        SET
          order_id = @orderId,
          payment_no = @paymentNo,
          payment_channel = '支付宝',
          payment_status = @paymentStatus,
          gross_amount = @grossAmount,
          discount_amount = @discountAmount,
          paid_amount = @paidAmount,
          paid_at = @paidAt,
          settled_at = @settledAt,
          updated_at = @updatedAt
        WHERE id = @id
      `,
    );
    const insertOrderEvent = this.db.prepare(
      `
        INSERT INTO order_events (
          order_id,
          event_type,
          event_title,
          event_detail,
          operator_name,
          created_at
        ) VALUES (
          @orderId,
          @eventType,
          @eventTitle,
          @eventDetail,
          @operatorName,
          @createdAt
        )
      `,
    );
    const countCustomerOrders = this.db.prepare(
      `
        SELECT COUNT(*) AS total
        FROM orders
        WHERE customer_id = @customerId
          AND order_no <> @orderNo
      `,
    );
    const sortedOrders = [...input.orders].sort(
      (left, right) => left.paidAt.localeCompare(right.paidAt) || left.orderNo.localeCompare(right.orderNo),
    );

    let syncedCount = 0;
    let skippedCount = 0;
    this.db.transaction(() => {
      for (const order of sortedOrders) {
        const orderNo = order.orderNo.trim();
        const paidAt = order.paidAt.trim();
        if (!orderNo || !paidAt) {
          skippedCount += 1;
          continue;
        }

        const productId = resolveProductId(order.itemId, orderNo);
        const existingProduct = selectProduct.get(productId) as
          | { id: number; category: string; cost: number; stock: number }
          | undefined;
        const productSku = order.itemId?.trim() || String(productId);
        const category = existingProduct?.category?.trim() || '闲鱼真实成交';
        upsertProduct.run({
          id: productId,
          storeId: store.id,
          sku: productSku,
          name: order.itemTitle.trim() || `闲鱼成交商品 ${orderNo}`,
          category,
          price: Number.isFinite(order.unitPrice) ? order.unitPrice : 0,
          cost: existingProduct?.cost ?? 0,
          stock: existingProduct?.stock ?? 0,
        });

        const externalCustomerId =
          order.buyerUserId?.trim() ||
          (order.buyerName?.trim() ? `nick:${order.buyerName.trim()}` : `trade:${orderNo}`);
        const existingCustomerRef = selectCustomerRef.get({
          provider: 'xianyu',
          externalCustomerId,
        }) as { customerId: number } | undefined;
        let customerId = existingCustomerRef?.customerId ?? null;
        if (!customerId) {
          const inserted = insertCustomer.run({
            name: order.buyerName?.trim() || `闲鱼买家 ${externalCustomerId}`,
            province: '未知',
            registeredAt: paidAt,
          });
          customerId = Number(inserted.lastInsertRowid);
          insertCustomerRef.run({
            provider: 'xianyu',
            externalCustomerId,
            customerId,
            createdAt: now,
          });
        } else {
          updateCustomer.run({
            id: customerId,
            name: order.buyerName?.trim() || `闲鱼买家 ${externalCustomerId}`,
            province: '未知',
          });
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
        const existingOrder = selectOrder.get(orderNo) as
          | { id: number; buyerNote: string; sellerRemark: string }
          | undefined;
        const isNewCustomer =
          ((countCustomerOrders.get({
            customerId,
            orderNo,
          }) as { total: number } | undefined)?.total ?? 0) === 0
            ? 1
            : 0;
        const payload = {
          orderNo,
          storeId: store.id,
          productId,
          customerId,
          source: '闲鱼真实成交',
          quantity: Math.max(1, Math.trunc(order.quantity || 1)),
          paidAmount,
          discountAmount,
          orderStatus,
          mainStatus: 'completed' as OrderMainStatus,
          paymentStatus,
          deliveryStatus,
          afterSaleStatus: refundAmount > 0 ? 'resolved' : 'none',
          refundAmount,
          paidAt,
          shippedAt: order.shippedAt?.trim() || null,
          completedAt: order.completedAt?.trim() || null,
          deliveryHours,
          isNewCustomer,
          buyerNote: existingOrder?.buyerNote ?? '',
          sellerRemark: existingOrder?.sellerRemark ?? '',
          createdAt: existingOrder ? paidAt : paidAt,
          updatedAt: now,
        };

        let orderId = existingOrder?.id ?? null;
        if (orderId) {
          updateOrder.run({
            id: orderId,
            ...payload,
          });
        } else {
          const inserted = insertOrder.run(payload);
          orderId = Number(inserted.lastInsertRowid);
        }

        deleteOrderItems.run(orderId);
        deleteOrderEvents.run(orderId);

        insertOrderItem.run({
          orderId,
          productId,
          productName: order.itemTitle.trim() || `闲鱼成交商品 ${orderNo}`,
          productSku,
          category,
          quantity: Math.max(1, Math.trunc(order.quantity || 1)),
          unitPrice: Number.isFinite(order.unitPrice) ? order.unitPrice : 0,
          paidAmount,
          deliveryStatus,
          afterSaleStatus: refundAmount > 0 ? 'resolved' : 'none',
          createdAt: paidAt,
          updatedAt: now,
        });

        const paymentPayload = {
          orderId,
          paymentNo: order.paymentNo?.trim() || `XYPAY-${orderNo}`,
          paymentStatus,
          grossAmount,
          discountAmount,
          paidAmount,
          paidAt,
          settledAt: order.completedAt?.trim() || order.shippedAt?.trim() || paidAt,
          createdAt: paidAt,
          updatedAt: now,
        };
        const existingPayment = selectOrderPayment.get(orderId) as { id: number } | undefined;
        // 保留既有 payment_id，避免重复同步时打断资金结算等外键引用。
        if (existingPayment) {
          updateOrderPayment.run({
            id: existingPayment.id,
            ...paymentPayload,
          });
        } else {
          insertOrderPayment.run(paymentPayload);
        }

        const events =
          order.events.length > 0
            ? order.events
            : [
                {
                  eventType: 'xianyu_completed',
                  eventTitle: order.orderStatusName?.trim() || '交易成功',
                  eventDetail: '闲鱼真实成交订单已同步',
                  operatorName: null,
                  createdAt: order.completedAt?.trim() || paidAt,
                },
              ];

        for (const event of events) {
          insertOrderEvent.run({
            orderId,
            eventType: event.eventType.trim() || 'xianyu_event',
            eventTitle: event.eventTitle.trim() || '闲鱼订单事件',
            eventDetail: event.eventDetail.trim() || '闲鱼订单状态已更新',
            operatorName: event.operatorName?.trim() || null,
            createdAt: event.createdAt.trim() || paidAt,
          });
        }

        syncedCount += 1;
      }

      this.markManagedStoreBusinessSyncHealthy(store.id, {
        detail: '真实订单同步成功，当前凭据可用于业务接口调用。',
        verifiedAt: now,
      });
    })();

    return {
      storeId: store.id,
      shopName: store.shopName,
      syncedCount,
      skippedCount,
      syncedAt: now,
    };
  }

  markManagedStoreCredentialRenew(
    storeId: number,
    input: {
      cookieText?: string | null;
      detail: string;
      renewed: boolean;
      verificationUrl?: string | null;
    },
  ) {
    this.syncStoreAccessState();
    return this.storeAccessWriteRepository.markManagedStoreCredentialRenew(storeId, input);
  }

  markManagedStoreXianyuImRisk(
    storeId: number,
    input: {
      riskLevel: Extract<StoreCredentialRiskLevel, 'warning' | 'offline' | 'abnormal'>;
      detail: string;
      verificationUrl?: string | null;
      source: string;
      operatorUserId?: number | null;
    },
  ) {
    const context = this.db
      .prepare(
        `
          SELECT
            ms.id AS storeId,
            ms.platform,
            ms.shop_name AS shopName,
            ms.enabled,
            ms.connection_status AS connectionStatus,
            ms.auth_status AS authStatus,
            ms.health_status AS healthStatus,
            ms.last_health_check_detail AS lastHealthCheckDetail,
            ms.credential_id AS credentialId,
            spc.risk_level AS credentialRiskLevel,
            spc.risk_reason AS credentialRiskReason,
            spc.verification_url AS credentialVerificationUrl
          FROM managed_stores ms
          LEFT JOIN store_platform_credentials spc ON spc.id = ms.credential_id
          WHERE ms.id = ?
        `,
      )
      .get(storeId) as
      | {
          storeId: number;
          platform: StorePlatform;
          shopName: string;
          enabled: number;
          connectionStatus: StoreConnectionStatus;
          authStatus: StoreAuthStatus;
          healthStatus: StoreHealthStatus;
          lastHealthCheckDetail: string | null;
          credentialId: number | null;
          credentialRiskLevel: StoreCredentialRiskLevel | null;
          credentialRiskReason: string | null;
          credentialVerificationUrl: string | null;
        }
      | undefined;
    if (!context) {
      return null;
    }

    const credentialContext = context!;

    if (!credentialContext.credentialId) {
      return null;
    }

    const detail = input.detail.trim();
    const verificationUrl = input.verificationUrl?.trim() || null;
    const now = format(new Date(), 'yyyy-MM-dd HH:mm:ss');
    const nextConnectionStatus: StoreConnectionStatus =
      input.riskLevel === 'warning'
        ? context.connectionStatus === 'pending_activation'
          ? 'pending_activation'
          : 'active'
        : input.riskLevel === 'offline'
          ? 'offline'
          : 'abnormal';
    const nextHealthStatus: StoreHealthStatus =
      input.riskLevel === 'warning'
        ? 'warning'
        : input.riskLevel === 'offline'
          ? 'offline'
          : 'abnormal';
    const nextAuthStatus: StoreAuthStatus =
      input.riskLevel === 'offline'
        ? 'expired'
        : input.riskLevel === 'abnormal'
          ? 'invalidated'
          : 'authorized';

    this.db
      .prepare(
        `
          UPDATE store_platform_credentials
          SET
            risk_level = @riskLevel,
            risk_reason = @riskReason,
            verification_url = @verificationUrl,
            last_verified_at = @lastVerifiedAt,
            updated_at = @updatedAt
          WHERE id = @id
        `,
      )
      .run({
        id: context.credentialId,
        riskLevel: input.riskLevel,
        riskReason: detail,
        verificationUrl,
        lastVerifiedAt: now,
        updatedAt: now,
      });

    this.db
      .prepare(
        `
          UPDATE managed_stores
          SET
            connection_status = @connectionStatus,
            activation_status = @activationStatus,
            auth_status = @authStatus,
            health_status = @healthStatus,
            last_health_check_at = @lastHealthCheckAt,
            last_health_check_detail = @lastHealthCheckDetail,
            last_verified_at = @lastVerifiedAt,
            status_text = @statusText,
            updated_at = @updatedAt
          WHERE id = @id
        `,
      )
      .run({
        id: storeId,
        connectionStatus: nextConnectionStatus,
        activationStatus: nextConnectionStatus,
        authStatus: nextAuthStatus,
        healthStatus: nextHealthStatus,
        lastHealthCheckAt: now,
        lastHealthCheckDetail: detail,
        lastVerifiedAt: now,
        statusText: this.getManagedStoreStatusText(nextConnectionStatus, Boolean(context.enabled)),
        updatedAt: now,
      });

    const changed =
      context.credentialRiskLevel !== input.riskLevel ||
      (context.credentialRiskReason?.trim() ?? '') !== detail ||
      (context.credentialVerificationUrl?.trim() ?? '') !== (verificationUrl ?? '') ||
      context.connectionStatus !== nextConnectionStatus ||
      context.authStatus !== nextAuthStatus ||
      context.healthStatus !== nextHealthStatus ||
      (context.lastHealthCheckDetail?.trim() ?? '') !== detail;

    if (changed) {
      this.recordStoreCredentialEvent({
        storeId,
        credentialId: context.credentialId,
        eventType: 'manual_takeover_required',
        status: 'warning',
        detail,
        source: input.source,
        riskLevel: input.riskLevel,
        verificationUrl,
        operatorUserId: input.operatorUserId ?? null,
      });
    }

    return {
      storeId,
      shopName: context.shopName,
      riskLevel: input.riskLevel,
      connectionStatus: nextConnectionStatus,
      authStatus: nextAuthStatus,
      healthStatus: nextHealthStatus,
      detail,
      verificationUrl,
      changed,
      updatedAt: now,
    };
  }

  saveManagedStoreCredentialCheckResult(
    storeId: number,
    input: {
      riskLevel: Exclude<StoreCredentialRiskLevel, 'pending'>;
      detail: string;
      verificationUrl?: string | null;
      refreshedCookieText?: string | null;
    },
    triggeredByUserId: number | null,
    triggerMode: 'manual' | 'batch' = 'manual',
  ) {
    this.syncStoreAccessState();
    return this.storeAccessWriteRepository.saveManagedStoreCredentialCheckResult(
      storeId,
      input,
      triggeredByUserId,
      triggerMode,
    );
  }

  updateManagedStoreMeta(
    storeId: number,
    input: { groupName: string; tags: string[]; remark: string },
  ) {
    const current = this.db
      .prepare('SELECT id FROM managed_stores WHERE id = ?')
      .get(storeId) as { id: number } | undefined;
    if (!current) {
      throw new Error('店铺不存在。');
    }

    const now = format(new Date(), 'yyyy-MM-dd HH:mm:ss');
    this.db
      .prepare(
        `
          UPDATE managed_stores
          SET
            group_name = @groupName,
            tags_text = @tagsText,
            remark = @remark,
            updated_at = @updatedAt
          WHERE id = @id
        `,
      )
      .run({
        id: storeId,
        groupName: input.groupName.trim() || '未分组',
        tagsText: this.normalizeStoreTags(input.tags),
        remark: input.remark.trim(),
        updatedAt: now,
      });

    return this.listManagedStores().find((store) => store.id === storeId) ?? null;
  }

  setManagedStoreEnabled(storeId: number, enabled: boolean) {
    const current = this.db
      .prepare(
        `
          SELECT
            id,
            connection_status AS connectionStatus
          FROM managed_stores
          WHERE id = ?
        `,
      )
      .get(storeId) as { id: number; connectionStatus: StoreConnectionStatus } | undefined;

    if (!current) {
      throw new Error('店铺不存在。');
    }

    const now = format(new Date(), 'yyyy-MM-dd HH:mm:ss');
    this.db
      .prepare(
        `
          UPDATE managed_stores
          SET
            enabled = @enabled,
            status_text = @statusText,
            updated_at = @updatedAt
          WHERE id = @id
        `,
      )
      .run({
        id: storeId,
        enabled: enabled ? 1 : 0,
        statusText: this.getManagedStoreStatusText(current.connectionStatus, enabled),
        updatedAt: now,
      });

    return this.listManagedStores().find((store) => store.id === storeId) ?? null;
  }

  batchSetManagedStoreEnabled(storeIds: number[], enabled: boolean) {
    const uniqueStoreIds = Array.from(
      new Set(storeIds.filter((storeId) => Number.isInteger(storeId) && storeId > 0)),
    );
    return uniqueStoreIds
      .map((storeId) => this.setManagedStoreEnabled(storeId, enabled))
      .filter(Boolean);
  }

  runStoreHealthCheck(
    storeId: number,
    triggeredByUserId: number | null,
    triggerMode: 'manual' | 'batch' = 'manual',
    realStatusContext?: {
      status: StoreHealthStatus;
      detail: string;
      nextConnectionStatus: StoreConnectionStatus;
      nextHealthStatus: StoreHealthStatus;
    },
  ) {
    const store = this.listManagedStores().find((row) => row.id === storeId);
    if (!store) {
      return null;
    }

    const now = format(new Date(), 'yyyy-MM-dd HH:mm:ss');
    let status: StoreHealthStatus = 'healthy';
    let detail = '店铺连接正常，可继续参与任务调度。';
    let nextConnectionStatus = store.connectionStatus;
    let nextHealthStatus: StoreHealthStatus = store.healthStatus;

    if (!store.enabled) {
      status = 'skipped';
      nextHealthStatus = 'skipped';
      detail = '店铺已停用，已跳过健康检查与任务调度。';
    } else if (realStatusContext) {
      status = realStatusContext.status;
      detail = realStatusContext.detail;
      nextConnectionStatus = realStatusContext.nextConnectionStatus;
      nextHealthStatus = realStatusContext.nextHealthStatus;
    } else if (store.connectionStatus === 'pending_activation') {
      status = 'warning';
      nextHealthStatus = 'warning';
      detail = '店铺授权已完成，但尚未激活，暂不参与正式调度。';
    } else if (store.authStatus === 'expired' || store.connectionStatus === 'offline') {
      status = 'offline';
      nextHealthStatus = 'offline';
      nextConnectionStatus = 'offline';
      detail = '检测到授权过期或最近同步失败，店铺当前处于掉线状态。';
    } else if (store.authStatus === 'invalidated' || store.connectionStatus === 'abnormal') {
      status = 'abnormal';
      nextHealthStatus = 'abnormal';
      nextConnectionStatus = 'abnormal';
      detail = '检测到授权失效或接口响应异常，需要重新授权或人工复核。';
    } else {
      status = 'healthy';
      nextHealthStatus = 'healthy';
      nextConnectionStatus = 'active';
    }

    this.db
      .prepare(
        `
          INSERT INTO store_health_checks (
            store_id,
            status,
            detail,
            checked_at,
            triggered_by_user_id,
            trigger_mode
          ) VALUES (
            @storeId,
            @status,
            @detail,
            @checkedAt,
            @triggeredByUserId,
            @triggerMode
          )
        `,
      )
      .run({
        storeId,
        status,
        detail,
        checkedAt: now,
        triggeredByUserId,
        triggerMode,
      });

    this.db
      .prepare(
        `
          UPDATE managed_stores
          SET
            connection_status = @connectionStatus,
            activation_status = @activationStatus,
            health_status = @healthStatus,
            last_health_check_at = @lastHealthCheckAt,
            last_health_check_detail = @lastHealthCheckDetail,
            last_sync_at = CASE
              WHEN @status = 'healthy' AND enabled = 1 THEN @lastSyncAt
              ELSE last_sync_at
            END,
            status_text = @statusText,
            updated_at = @updatedAt
          WHERE id = @id
        `,
      )
      .run({
        id: storeId,
        connectionStatus: nextConnectionStatus,
        activationStatus: nextConnectionStatus,
        healthStatus: nextHealthStatus,
        lastHealthCheckAt: now,
        lastHealthCheckDetail: detail,
        lastSyncAt: now,
        status,
        statusText: this.getManagedStoreStatusText(nextConnectionStatus, store.enabled),
        updatedAt: now,
      });

    return this.listStoreHealthChecks(1)[0] ?? null;
  }

  batchRunStoreHealthCheck(storeIds: number[], triggeredByUserId: number | null) {
    const uniqueStoreIds = Array.from(
      new Set(storeIds.filter((storeId) => Number.isInteger(storeId) && storeId > 0)),
    );
    return uniqueStoreIds
      .map((storeId) => this.runStoreHealthCheck(storeId, triggeredByUserId, 'batch'))
      .filter(Boolean);
  }

  exportOrdersCsv(filters: QueryFilters) {
    return this.orderReadRepository.exportOrdersCsv(filters);
  }

  private ensureUsersTokenVersionColumn() {
    if (this.usersTokenVersionColumnEnsured) {
      return;
    }

    const columns = this.db.prepare('PRAGMA table_info(users)').all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === 'token_version')) {
      this.db.exec("ALTER TABLE users ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0;");
    }

    this.usersTokenVersionColumnEnsured = true;
  }

  getUserByUsername(username: string) {
    this.ensureUsersTokenVersionColumn();
    return this.db
      .prepare(
        `
          SELECT
            id,
            username,
            display_name AS displayName,
            role,
            status,
            token_version AS tokenVersion,
            password_hash AS passwordHash,
            created_at AS createdAt,
            updated_at AS updatedAt,
            last_login_at AS lastLoginAt
          FROM users
          WHERE username = ?
        `,
      )
      .get(username) as SystemUserRecord | undefined;
  }

  getUserById(userId: number) {
    this.ensureUsersTokenVersionColumn();
    return this.db
      .prepare(
        `
          SELECT
            id,
            username,
            display_name AS displayName,
            role,
            status,
            token_version AS tokenVersion,
            password_hash AS passwordHash,
            created_at AS createdAt,
            updated_at AS updatedAt,
            last_login_at AS lastLoginAt
          FROM users
          WHERE id = ?
        `,
      )
      .get(userId) as SystemUserRecord | undefined;
  }

  listSystemUsers() {
    this.ensureUsersTokenVersionColumn();
    return this.db
      .prepare(
        `
          SELECT
            id,
            username,
            display_name AS displayName,
            role,
            status,
            token_version AS tokenVersion,
            created_at AS createdAt,
            updated_at AS updatedAt,
            last_login_at AS lastLoginAt
          FROM users
          ORDER BY
            CASE role
              WHEN 'admin' THEN 0
              WHEN 'operator' THEN 1
              WHEN 'support' THEN 2
              WHEN 'finance' THEN 3
              ELSE 9
            END,
            id ASC
        `,
      )
      .all() as SystemUserRecord[];
  }

  createSystemUser(input: {
    username: string;
    displayName: string;
    password: string;
    role: SystemUserRole;
  }) {
    this.ensureUsersTokenVersionColumn();
    if (!systemUserRoles.includes(input.role)) {
      throw new Error('角色类型不合法。');
    }

    const existing = this.getUserByUsername(input.username);
    if (existing) {
      throw new Error('用户名已存在。');
    }

    const now = format(new Date(), 'yyyy-MM-dd HH:mm:ss');
    const result = this.db
      .prepare(
        `
          INSERT INTO users (
            username,
            display_name,
            role,
            status,
            password_hash,
            created_at,
            updated_at
          )
          VALUES (?, ?, ?, 'active', ?, ?, ?)
        `,
      )
      .run(input.username, input.displayName, input.role, hashPassword(input.password), now, now);

    return this.getUserById(Number(result.lastInsertRowid));
  }

  updateSystemUserRole(userId: number, role: SystemUserRole) {
    if (!systemUserRoles.includes(role)) {
      throw new Error('角色类型不合法。');
    }

    const current = this.getUserById(userId);
    if (!current) {
      throw new Error('账号不存在。');
    }

    if (current.role === role) {
      return current;
    }

    if (current.role === 'admin' && role !== 'admin' && this.countActiveAdmins() <= 1) {
      throw new Error('至少需要保留一个启用中的管理员。');
    }

    this.db
      .prepare(
        `
          UPDATE users
          SET role = ?, updated_at = ?
          WHERE id = ?
        `,
      )
      .run(role, format(new Date(), 'yyyy-MM-dd HH:mm:ss'), userId);

    return this.getUserById(userId);
  }

  updateSystemUserStatus(userId: number, status: SystemUserStatus) {
    const current = this.getUserById(userId);
    if (!current) {
      throw new Error('账号不存在。');
    }

    if (current.status === status) {
      return current;
    }

    if (current.role === 'admin' && status === 'disabled' && this.countActiveAdmins() <= 1) {
      throw new Error('至少需要保留一个启用中的管理员。');
    }

    this.db
      .prepare(
        `
          UPDATE users
          SET status = ?, updated_at = ?
          WHERE id = ?
        `,
      )
      .run(status, format(new Date(), 'yyyy-MM-dd HH:mm:ss'), userId);

    return this.getUserById(userId);
  }

  touchUserLastLogin(userId: number) {
    this.ensureUsersTokenVersionColumn();
    this.db
      .prepare(
        `
          UPDATE users
          SET last_login_at = ?, updated_at = ?
          WHERE id = ?
        `,
      )
      .run(
        format(new Date(), 'yyyy-MM-dd HH:mm:ss'),
        format(new Date(), 'yyyy-MM-dd HH:mm:ss'),
        userId,
      );
  }

  updateUserPasswordHash(userId: number, passwordHash: string) {
    this.ensureUsersTokenVersionColumn();

    const now = format(new Date(), 'yyyy-MM-dd HH:mm:ss');
    this.db
      .prepare(
        `
          UPDATE users
          SET
            password_hash = @passwordHash,
            token_version = COALESCE(token_version, 0) + 1,
            updated_at = @updatedAt
          WHERE id = @id
        `,
      )
      .run({
        id: userId,
        passwordHash,
        updatedAt: now,
      });

    return this.getUserById(userId);
  }

  bumpUserTokenVersion(userId: number) {
    this.ensureUsersTokenVersionColumn();

    const now = format(new Date(), 'yyyy-MM-dd HH:mm:ss');
    this.db
      .prepare(
        `
          UPDATE users
          SET
            token_version = COALESCE(token_version, 0) + 1,
            updated_at = @updatedAt
          WHERE id = @id
        `,
      )
      .run({
        id: userId,
        updatedAt: now,
      });

    return this.getUserById(userId);
  }

  listAuditLogs(limit = 100) {
    return this.db
      .prepare(
        `
          SELECT
            id,
            action,
            target_type AS targetType,
            target_id AS targetId,
            detail,
            result,
            operator_username AS operatorUsername,
            operator_display_name AS operatorDisplayName,
            ip_address AS ipAddress,
            created_at AS createdAt
          FROM audit_logs
          ORDER BY id DESC
          LIMIT ?
        `,
      )
      .all(limit) as Array<{
      id: number;
      action: string;
      targetType: string;
      targetId: string | null;
      detail: string;
      result: string;
      operatorUsername: string | null;
      operatorDisplayName: string | null;
      ipAddress: string | null;
      createdAt: string;
    }>;
  }

  recordAuditLog(input: {
    action: string;
    targetType: string;
    targetId?: string | null;
    detail: string;
    result: 'success' | 'failure' | 'blocked';
    operator?: Pick<SystemUserRecord, 'id' | 'username' | 'displayName'> | null;
    ipAddress?: string | null;
  }) {
    const now = format(new Date(), 'yyyy-MM-dd HH:mm:ss');
    this.db
      .prepare(
        `
          INSERT INTO audit_logs (
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
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
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
      );
  }

  listSecureSettings() {
    return this.db
      .prepare(
        `
          SELECT
            ss.key,
            ss.description,
            ss.value_masked AS maskedValue,
            ss.updated_at AS updatedAt,
            u.display_name AS updatedByName
          FROM secure_settings ss
          LEFT JOIN users u ON u.id = ss.updated_by
          ORDER BY ss.key ASC
        `,
      )
      .all() as Array<{
      key: string;
      description: string;
      maskedValue: string;
      updatedAt: string;
      updatedByName: string | null;
    }>;
  }

  upsertSecureSetting(
    key: string,
    description: string,
    value: string,
    updatedByUserId: number | null,
  ) {
    const now = format(new Date(), 'yyyy-MM-dd HH:mm:ss');
    const encryptedValue = encryptSecret(value, appConfig.secureConfigSecret);
    this.db
      .prepare(
        `
          INSERT INTO secure_settings (key, description, value_encrypted, value_masked, updated_by, updated_at)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(key) DO UPDATE SET
            description = excluded.description,
            value_encrypted = excluded.value_encrypted,
            value_masked = excluded.value_masked,
            updated_by = excluded.updated_by,
            updated_at = excluded.updated_at
        `,
      )
      .run(key, description, encryptedValue, maskSecret(value), updatedByUserId, now);

    return this.db
      .prepare(
        `
          SELECT
            ss.key,
            ss.description,
            ss.value_masked AS maskedValue,
            ss.updated_at AS updatedAt,
            u.display_name AS updatedByName
          FROM secure_settings ss
          LEFT JOIN users u ON u.id = ss.updated_by
          WHERE ss.key = ?
        `,
      )
      .get(key) as {
      key: string;
      description: string;
      maskedValue: string;
      updatedAt: string;
      updatedByName: string | null;
    };
  }

  private countActiveAdmins() {
    const row = this.db
      .prepare(
        `
          SELECT COUNT(*) AS count
          FROM users
          WHERE role = 'admin' AND status = 'active'
        `,
      )
      .get() as { count: number };
    return row.count;
  }

  private getSecurityWorkspaceOverview(
    featureKey: 'system-accounts' | 'open-logs' | 'system-configs',
    moduleRow:
      | {
          featureKey: string;
          featureLabel: string;
          groupKey: string;
          groupLabel: string;
          statusTag: string;
          updatedAt: string;
        }
      | undefined,
  ) {
    const base =
      moduleRow ??
      ({
        featureKey,
        featureLabel: featureKey,
        groupKey: 'system',
        groupLabel: '系统其他',
        statusTag: '安全加固',
        updatedAt: format(new Date(), 'yyyy-MM-dd HH:mm:ss'),
      } as const);

    const auditLogs = this.listAuditLogs(8).map((row) => ({
      id: row.id,
      type: row.action,
      title: row.operatorDisplayName ?? row.operatorUsername ?? '匿名操作',
      detail: row.detail,
      createdAt: row.createdAt,
    }));

    if (featureKey === 'system-accounts') {
      const users = this.listSystemUsers();
      return {
        ...base,
        summary: [
          { label: '账号总数', value: users.length, unit: '个', meta: `启用 ${users.filter((row) => row.status === 'active').length} 个` },
          { label: '管理员', value: users.filter((row) => row.role === 'admin').length, unit: '个', meta: '系统最高权限角色' },
          { label: '最近登录', value: users.filter((row) => row.lastLoginAt).length, unit: '次', meta: '已写入登录记录' },
        ],
        actions: [],
        rules: [],
        tasks: [],
        logs: auditLogs,
        insights: [
          { title: '角色隔离', content: '管理员、运营、客服、财务四类角色已分离，账号状态支持启用与停用。' },
          { title: '登录安全', content: '停用账号和越权访问都会被后端拒绝，并写入审计日志。' },
        ],
      };
    }

    if (featureKey === 'open-logs') {
      return {
        ...base,
        summary: [
          { label: '最近日志', value: auditLogs.length, unit: '条', meta: '按时间倒序展示' },
          { label: '失败动作', value: auditLogs.filter((row) => row.type.includes('failure')).length, unit: '次', meta: '登录失败和操作失败' },
          { label: '拦截动作', value: auditLogs.filter((row) => row.type.includes('unauthorized') || row.type.includes('rate_limited')).length, unit: '次', meta: '越权和限流记录' },
        ],
        actions: [],
        rules: [],
        tasks: [],
        logs: auditLogs,
        insights: [
          { title: '可追溯性', content: '关键登录、越权访问、提现审核、账号管理和敏感配置变更都会进入审计链路。' },
          { title: '安全基线', content: '审计记录已包含操作人、时间、目标对象、结果和来源 IP。' },
        ],
      };
    }

    const secureSettings = this.listSecureSettings();
    return {
      ...base,
      summary: [
        { label: '配置项', value: secureSettings.length, unit: '项', meta: '已启用加密存储' },
        { label: '脱敏展示', value: secureSettings.length, unit: '项', meta: '页面不返回明文' },
        { label: '最近操作', value: auditLogs.filter((row) => row.type === 'secure_setting_updated').length, unit: '次', meta: '密钥轮换记录' },
      ],
      actions: [],
      rules: [],
      tasks: [],
      logs: auditLogs,
      insights: [
        { title: '密文存储', content: '敏感配置保存为加密密文和掩码值，明文不会出现在接口响应和日志里。' },
        { title: '配置轮换', content: '管理员可以在线轮换密钥，所有更新会进入审计日志。' },
      ],
    };
  }

  getWorkspaceOverview(featureKey: string) {
    const definition = getWorkspaceDefinition(featureKey);
    if (!definition) {
      return null;
    }

    const moduleRow = this.db
      .prepare(
        `
        SELECT
          feature_key AS featureKey,
          feature_label AS featureLabel,
          group_key AS groupKey,
          group_label AS groupLabel,
          status_tag AS statusTag,
          updated_at AS updatedAt
        FROM workspace_modules
        WHERE feature_key = ?
      `,
      )
      .get(featureKey) as
      | {
          featureKey: string;
          featureLabel: string;
          groupKey: string;
          groupLabel: string;
          statusTag: string;
          updatedAt: string;
        }
      | undefined;

    if (
      featureKey === 'system-accounts' ||
      featureKey === 'open-logs' ||
      featureKey === 'system-configs'
    ) {
      return this.getSecurityWorkspaceOverview(featureKey, moduleRow);
    }

    const actions = this.db
      .prepare(
        `
        SELECT
          id,
          title,
          description,
          status,
          run_count AS runCount,
          last_run_at AS lastRunAt
        FROM workspace_actions
        WHERE feature_key = ?
        ORDER BY id
      `,
      )
      .all(featureKey) as Array<{
      id: number;
      title: string;
      description: string;
      status: string;
      runCount: number;
      lastRunAt: string | null;
    }>;

    const rulesRaw = this.db
      .prepare(
        `
        SELECT
          id,
          name,
          description,
          enabled,
          scope_text AS scope,
          updated_at AS updatedAt
        FROM workspace_rules
        WHERE feature_key = ?
        ORDER BY id
      `,
      )
      .all(featureKey) as Array<{
        id: number;
        name: string;
        description: string;
        enabled: number;
        scope: string;
        updatedAt: string;
      }>;
    const rules = rulesRaw
      .map((item) => ({
        ...item,
        enabled: Boolean(item.enabled),
      }));

    const tasks = this.db
      .prepare(
        `
        SELECT
          id,
          title,
          description,
          owner,
          priority,
          status,
          due_at AS dueAt
        FROM workspace_tasks
        WHERE feature_key = ?
        ORDER BY
          CASE status
            WHEN 'todo' THEN 1
            WHEN 'in_progress' THEN 2
            ELSE 3
          END,
          due_at ASC,
          id ASC
      `,
      )
      .all(featureKey) as Array<{
      id: number;
      title: string;
      description: string;
      owner: string;
      priority: string;
      status: 'todo' | 'in_progress' | 'done';
      dueAt: string;
    }>;

    const logs = this.db
      .prepare(
        `
        SELECT
          id,
          log_type AS type,
          title,
          detail,
          created_at AS createdAt
        FROM workspace_logs
        WHERE feature_key = ?
        ORDER BY created_at DESC, id DESC
        LIMIT 8
      `,
      )
      .all(featureKey) as Array<{
      id: number;
      type: string;
      title: string;
      detail: string;
      createdAt: string;
    }>;

    const taskStats = this.db
      .prepare(
        `
        SELECT
          SUM(CASE WHEN status IN ('todo', 'in_progress') THEN 1 ELSE 0 END) AS pendingTaskCount,
          SUM(CASE WHEN status = 'done' THEN 1 ELSE 0 END) AS doneTaskCount,
          SUM(CASE WHEN status != 'done' AND due_at < datetime('now', 'localtime') THEN 1 ELSE 0 END) AS overdueTaskCount
        FROM workspace_tasks
        WHERE feature_key = ?
      `,
      )
      .get(featureKey) as Record<string, number | null>;

    const enabledRuleCount = rules.filter((item) => item.enabled).length;
    const recentLogCount = logs.length;
    const actionRunCount = actions.reduce<number>(
      (total, item) => total + Number(item.runCount ?? 0),
      0,
    );

    const summary: WorkspaceSummaryRow[] = [
      {
        label: definition.summaryLabels[0],
        value: Number(taskStats.pendingTaskCount ?? 0),
        unit: '项',
        meta: `已完成 ${Number(taskStats.doneTaskCount ?? 0)} 项`,
      },
      {
        label: definition.summaryLabels[1],
        value: enabledRuleCount,
        unit: '条',
        meta: `共 ${rules.length} 条规则`,
      },
      {
        label: definition.summaryLabels[2],
        value: recentLogCount,
        unit: '条',
        meta: `累计执行 ${actionRunCount} 次`,
      },
    ];

    const insights = [
      {
        title: definition.insightTitles[0],
        content: `${definition.featureLabel} 当前有 ${Number(taskStats.pendingTaskCount ?? 0)} 项待办，${enabledRuleCount} 条规则处于启用状态。`,
      },
      {
        title: definition.insightTitles[1],
        content:
          Number(taskStats.overdueTaskCount ?? 0) > 0
            ? `建议优先处理 ${Number(taskStats.overdueTaskCount ?? 0)} 项已到期任务，并复核最近执行日志。`
            : '建议先执行一次当前模块动作，再根据日志结果调整规则开关。',
      },
    ];

    return {
      ...(moduleRow ?? {
        featureKey: definition.featureKey,
        featureLabel: definition.featureLabel,
        groupKey: definition.groupKey,
        groupLabel: definition.groupLabel,
        statusTag: '待配置',
        updatedAt: format(new Date(), 'yyyy-MM-dd HH:mm:ss'),
      }),
      summary,
      actions,
      rules,
      tasks,
      logs,
      insights,
    };
  }

  getWorkspaceBusinessDetail(featureKey: string, filters: QueryFilters = {}) {
    const definition = getWorkspaceDefinition(featureKey);
    if (!definition) {
      return null;
    }

    if (featureKey.startsWith('fund-')) {
      this.syncFundCenterLedger();
    }

    switch (featureKey) {
      case 'ai-service':
        return this.getAiServiceDetail();
      case 'ai-bargain':
        return this.getAiBargainDetail();
      case 'distribution-source':
        return this.getDirectChargeSupplierDetail();
      case 'distribution-supply':
        return this.getDirectChargeSupplyDetail();
      case 'card-types':
        return this.getCardTypesDetail();
      case 'card-delivery':
        return this.getCardDeliveryDetail();
      case 'card-combos':
        return this.getCardCombosDetail();
      case 'card-templates':
        return this.getCardTemplatesDetail();
      case 'card-records':
        return this.getCardRecordsDetail();
      case 'card-trash':
        return this.getCardTrashDetail();
      case 'fund-accounts':
        return this.getFundAccountsDetail(filters);
      case 'fund-bills':
        return this.getFundBillsDetail(filters);
      case 'fund-withdrawals':
        return this.getFundWithdrawalsDetail(filters);
      case 'fund-deposit':
        return this.getFundDepositDetail(filters);
      case 'fund-orders':
        return this.getFundOrdersDetail(filters);
      case 'fund-agents':
        return this.getFundAgentsDetail(filters);
      case 'system-monitoring':
        return this.getSystemMonitoringDetail();
      case 'system-accounts':
        return this.getSystemAccountsDetail();
      case 'open-logs':
        return this.getOpenLogsDetail();
      case 'system-configs':
        return this.getSystemConfigsDetail();
      default:
        return { kind: 'none' as const };
    }
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

  private getAiServiceMessageTypeText(senderType: string) {
    return (
      {
        customer: '买家消息',
        seller: '卖家消息',
        ai: 'AI 回复',
        suggestion: '建议回复',
        manual: '人工回复',
        system: '系统记录',
      }[senderType] ?? senderType
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

  private getAiServiceSettingsRow() {
    const row = this.db
      .prepare(
        `
          SELECT
            ai_enabled AS aiEnabled,
            auto_reply_enabled AS autoReplyEnabled,
            faq_enabled AS faqEnabled,
            order_query_enabled AS orderQueryEnabled,
            after_sale_suggestion_enabled AS afterSaleSuggestionEnabled,
            high_risk_manual_only AS highRiskManualOnly,
            boundary_note AS boundaryNote,
            sensitive_words_text AS sensitiveWordsText,
            updated_at AS updatedAt
          FROM ai_service_settings
          WHERE id = 1
        `,
      )
      .get() as
      | {
          aiEnabled: number;
          autoReplyEnabled: number;
          faqEnabled: number;
          orderQueryEnabled: number;
          afterSaleSuggestionEnabled: number;
          highRiskManualOnly: number;
          boundaryNote: string;
          sensitiveWordsText: string;
          updatedAt: string;
        }
      | undefined;

    if (!row) {
      return null;
    }

    const secureSetting = this.db
      .prepare(
        `
          SELECT value_masked AS maskedValue
          FROM secure_settings
          WHERE key = 'openai_api_key'
        `,
      )
      .get() as { maskedValue: string } | undefined;

    return {
      aiEnabled: Boolean(row.aiEnabled),
      autoReplyEnabled: Boolean(row.autoReplyEnabled),
      faqEnabled: Boolean(row.faqEnabled),
      orderQueryEnabled: Boolean(row.orderQueryEnabled),
      afterSaleSuggestionEnabled: Boolean(row.afterSaleSuggestionEnabled),
      highRiskManualOnly: Boolean(row.highRiskManualOnly),
      boundaryNote: row.boundaryNote,
      sensitiveWordsText: row.sensitiveWordsText,
      modelKeyMasked: secureSetting?.maskedValue ?? '未配置',
      updatedAt: row.updatedAt,
    };
  }

  private parseAiServiceSensitiveWords(text: string) {
    return text
      .split(/[,，\n]/)
      .map((item) => item.trim())
      .filter(Boolean);
  }

  private getAiServiceConversationContext(conversationId: number) {
    return this.db
      .prepare(
        `
          SELECT
            c.id,
            c.session_no AS sessionNo,
            c.channel,
            c.source,
            c.customer_name AS customerName,
            c.store_id AS storeId,
            s.name AS storeName,
            c.order_id AS orderId,
            o.order_no AS orderNo,
            c.case_id AS caseId,
            ac.case_no AS caseNo,
            c.topic,
            c.latest_user_intent AS latestUserIntent,
            c.conversation_status AS conversationStatus,
            c.ai_status AS aiStatus,
            c.risk_level AS riskLevel,
            c.priority,
            c.unread_count AS unreadCount,
            c.assigned_user_id AS assignedUserId,
            u.display_name AS assignedUserName,
            c.boundary_label AS boundaryLabel,
            c.tags_text AS tagsText,
            c.last_message_at AS lastMessageAt,
            c.created_at AS createdAt,
            c.updated_at AS updatedAt
          FROM ai_service_conversations c
          LEFT JOIN stores s ON s.id = c.store_id
          LEFT JOIN orders o ON o.id = c.order_id
          LEFT JOIN after_sale_cases ac ON ac.id = c.case_id
          LEFT JOIN users u ON u.id = c.assigned_user_id
          WHERE c.id = ?
        `,
      )
      .get(conversationId) as
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

  private findAiServiceKnowledgeMatch(message: string) {
    const normalizedMessage = message.toLowerCase();
    const knowledgeItems = this.db
      .prepare(
        `
          SELECT
            id,
            category,
            title,
            keywords_text AS keywordsText,
            answer_text AS answerText
          FROM ai_service_knowledge_items
          WHERE enabled = 1
          ORDER BY id ASC
        `,
      )
      .all() as Array<{
      id: number;
      category: string;
      title: string;
      keywordsText: string;
      answerText: string;
    }>;

    return (
      knowledgeItems.find((item) =>
        item.keywordsText
          .split(/[,，]/)
          .map((entry) => entry.trim().toLowerCase())
          .filter(Boolean)
          .some((keyword) => normalizedMessage.includes(keyword)),
      ) ?? null
    );
  }

  private findAiServiceTemplate(scene: string) {
    return this.db
      .prepare(
        `
          SELECT
            id,
            scene,
            title,
            trigger_text AS triggerText,
            template_content AS templateContent
          FROM ai_service_reply_templates
          WHERE enabled = 1
            AND scene = ?
          ORDER BY id ASC
          LIMIT 1
        `,
      )
      .get(scene) as
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
    return Object.entries(replacements).reduce((content, [key, value]) => {
      return content.replaceAll(`{${key}}`, value === null ? '-' : String(value));
    }, template);
  }

  private getAiServiceLatestCustomerMessage(conversationId: number) {
    return this.db
      .prepare(
        `
          SELECT
            id,
            content,
            created_at AS createdAt
          FROM ai_service_messages
          WHERE conversation_id = ?
            AND sender_type = 'customer'
          ORDER BY id DESC
          LIMIT 1
        `,
      )
      .get(conversationId) as
      | {
          id: number;
          content: string;
          createdAt: string;
        }
      | undefined;
  }

  private getAiServiceLatestOutboundMessage(conversationId: number) {
    return this.db
      .prepare(
        `
          SELECT
            id,
            sender_type AS senderType,
            scene,
            content,
            status,
            created_at AS createdAt
          FROM ai_service_messages
          WHERE conversation_id = ?
            AND sender_type != 'customer'
          ORDER BY id DESC
          LIMIT 1
        `,
      )
      .get(conversationId) as
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

  private isAiServiceHighRiskMessage(message: string, sensitiveWords: string[]) {
    return (
      sensitiveWords.some((word) => word && message.includes(word)) ||
      ['投诉', '差评', '举报', '起诉', '骗子', '赔偿', '维权'].some((word) =>
        message.includes(word),
      )
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
    if (input.caseNo) {
      return '售后咨询';
    }
    if (this.isAiServiceAfterSaleMessage(input.latestCustomerText)) {
      return '售后咨询';
    }
    if (this.isAiServiceOrderQueryMessage(input.latestCustomerText)) {
      return '订单状态查询';
    }
    if (input.productName?.trim()) {
      return `${input.productName.trim()}咨询`;
    }

    const normalized = input.latestCustomerText.trim();
    return normalized ? normalized.slice(0, 20) : '买家咨询';
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

  private buildAiServiceOrderReply(orderId: number) {
    const detail = this.getOrderDetail(orderId);
    if (!detail) {
      return null;
    }

    const template = this.findAiServiceTemplate('order_query');
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

  private buildAiServiceAfterSaleSuggestion(caseId: number) {
    const detail = this.getAfterSaleDetail(caseId);
    if (!detail) {
      return null;
    }

    const template = this.findAiServiceTemplate('after_sale');
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

  private appendAiServiceMessage(input: {
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
  }) {
    const createdAt = input.createdAt ?? format(new Date(), 'yyyy-MM-dd HH:mm:ss');
    this.db
      .prepare(
        `
          INSERT INTO ai_service_messages (
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
            @conversationId,
            @externalMessageId,
            @senderType,
            @senderName,
            @senderUserId,
            @scene,
            @content,
            @status,
            @relatedKnowledgeId,
            @relatedTemplateId,
            @operatorUserId,
            @createdAt
          )
        `,
      )
      .run({
        conversationId: input.conversationId,
        externalMessageId: input.externalMessageId ?? null,
        senderType: input.senderType,
        senderName: input.senderName?.trim() || '',
        senderUserId: input.senderUserId ?? null,
        scene: input.scene,
        content: input.content,
        status: input.status,
        relatedKnowledgeId: input.relatedKnowledgeId ?? null,
        relatedTemplateId: input.relatedTemplateId ?? null,
        operatorUserId: input.operatorUserId ?? null,
        createdAt,
      });
    return createdAt;
  }

  private updateAiServiceConversationState(
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
    this.db
      .prepare(
        `
          UPDATE ai_service_conversations
          SET
            conversation_status = @conversationStatus,
            ai_status = @aiStatus,
            assigned_user_id = @assignedUserId,
            latest_user_intent = COALESCE(@latestUserIntent, latest_user_intent),
            boundary_label = COALESCE(@boundaryLabel, boundary_label),
            unread_count = COALESCE(@unreadCount, unread_count),
            last_message_at = @lastMessageAt,
            updated_at = @updatedAt
          WHERE id = @conversationId
        `,
      )
      .run({
        conversationId,
        conversationStatus: input.conversationStatus,
        aiStatus: input.aiStatus,
        assignedUserId: input.assignedUserId ?? null,
        latestUserIntent: input.latestUserIntent ?? null,
        boundaryLabel: input.boundaryLabel ?? null,
        unreadCount: input.unreadCount ?? null,
        lastMessageAt: updatedAt,
        updatedAt,
      });
    return updatedAt;
  }

  private appendAiServiceTakeoverRecord(input: {
    conversationId: number;
    actionType: string;
    operatorUserId?: number | null;
    operatorName: string;
    note: string;
    createdAt?: string;
  }) {
    this.db
      .prepare(
        `
          INSERT INTO ai_service_takeovers (
            conversation_id,
            action_type,
            operator_user_id,
            operator_name,
            note,
            created_at
          ) VALUES (
            @conversationId,
            @actionType,
            @operatorUserId,
            @operatorName,
            @note,
            @createdAt
          )
        `,
      )
      .run({
        conversationId: input.conversationId,
        actionType: input.actionType,
        operatorUserId: input.operatorUserId ?? null,
        operatorName: input.operatorName,
        note: input.note,
        createdAt: input.createdAt ?? format(new Date(), 'yyyy-MM-dd HH:mm:ss'),
      });
  }

  private getAiServiceDetail() {
    const settings = this.getAiServiceSettingsRow();
    const summary = this.db
      .prepare(
        `
          SELECT
            COUNT(*) AS totalConversationCount,
            SUM(CASE WHEN conversation_status IN ('open', 'pending_manual', 'manual_active') THEN 1 ELSE 0 END) AS activeConversationCount,
            SUM(CASE WHEN conversation_status = 'pending_manual' THEN 1 ELSE 0 END) AS pendingManualCount,
            SUM(CASE WHEN ai_status = 'auto_replied' THEN 1 ELSE 0 END) AS autoReplyCount,
            SUM(CASE WHEN risk_level = 'high' THEN 1 ELSE 0 END) AS highRiskCount
          FROM ai_service_conversations
        `,
      )
      .get() as Record<string, number | null>;
    const conversations = this.db
      .prepare(
        `
          SELECT
            c.id,
            c.session_no AS sessionNo,
            c.channel,
            c.source,
            c.customer_name AS customerName,
            c.topic,
            c.store_id AS storeId,
            s.name AS storeName,
            o.order_no AS orderNo,
            ac.case_no AS caseNo,
            c.latest_user_intent AS latestUserIntent,
            c.item_main_pic AS itemMainPic,
            c.conversation_status AS conversationStatus,
            c.ai_status AS aiStatus,
            c.risk_level AS riskLevel,
            c.priority,
            c.unread_count AS unreadCount,
            c.boundary_label AS boundaryLabel,
            c.tags_text AS tagsText,
            c.last_message_at AS lastMessageAt,
            u.display_name AS assignedUserName
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
      )
      .all() as Array<{
      id: number;
      sessionNo: string;
      channel: string;
      source: string;
      customerName: string;
      topic: string;
      storeId: number | null;
      storeName: string | null;
      orderNo: string | null;
      caseNo: string | null;
      latestUserIntent: string;
      itemMainPic: string | null;
      conversationStatus: string;
      aiStatus: string;
      riskLevel: string;
      priority: string;
      unreadCount: number;
      boundaryLabel: string;
      tagsText: string;
      lastMessageAt: string;
      assignedUserName: string | null;
    }>;
    const recentMessages = this.db
      .prepare(
        `
          SELECT
            m.id,
            m.conversation_id AS conversationId,
            c.session_no AS sessionNo,
            c.customer_name AS customerName,
            m.sender_name AS senderName,
            m.sender_type AS senderType,
            m.scene,
            m.content,
            m.status,
            m.created_at AS createdAt
          FROM ai_service_messages m
          INNER JOIN ai_service_conversations c ON c.id = m.conversation_id
          ORDER BY
            c.last_message_at DESC,
            m.created_at ASC,
            m.id ASC
        `,
      )
      .all() as Array<{
      id: number;
      conversationId: number;
      sessionNo: string;
      customerName: string;
      senderName: string;
      senderType: string;
      scene: string;
      content: string;
      status: string;
      createdAt: string;
    }>;
    const takeovers = this.db
      .prepare(
        `
          SELECT
            t.id,
            t.conversation_id AS conversationId,
            c.session_no AS sessionNo,
            c.customer_name AS customerName,
            t.action_type AS actionType,
            t.operator_name AS operatorName,
            t.note,
            t.created_at AS createdAt
          FROM ai_service_takeovers t
          INNER JOIN ai_service_conversations c ON c.id = t.conversation_id
          ORDER BY t.created_at DESC, t.id DESC
          LIMIT 12
        `,
      )
      .all() as Array<{
      id: number;
      conversationId: number;
      sessionNo: string;
      customerName: string;
      actionType: string;
      operatorName: string;
      note: string;
      createdAt: string;
    }>;
    const knowledgeItems = this.db
      .prepare(
        `
          SELECT
            id,
            category,
            title,
            keywords_text AS keywordsText,
            question_text AS questionText,
            answer_text AS answerText,
            enabled,
            risk_level AS riskLevel,
            updated_at AS updatedAt
          FROM ai_service_knowledge_items
          ORDER BY enabled DESC, id ASC
        `,
      )
      .all() as Array<{
      id: number;
      category: string;
      title: string;
      keywordsText: string;
      questionText: string;
      answerText: string;
      enabled: number;
      riskLevel: string;
      updatedAt: string;
    }>;
    const replyTemplates = this.db
      .prepare(
        `
          SELECT
            id,
            scene,
            title,
            trigger_text AS triggerText,
            template_content AS templateContent,
            enabled,
            updated_at AS updatedAt
          FROM ai_service_reply_templates
          ORDER BY enabled DESC, id ASC
        `,
      )
      .all() as Array<{
      id: number;
      scene: string;
      title: string;
      triggerText: string;
      templateContent: string;
      enabled: number;
      updatedAt: string;
    }>;
    const syncNotices = this.db
      .prepare(
        `
          SELECT
            ms.id AS storeId,
            ms.shop_name AS storeName,
            spc.risk_level AS riskLevel,
            spc.risk_reason AS detail,
            spc.verification_url AS verificationUrl,
            COALESCE(ms.last_health_check_at, spc.last_verified_at, spc.updated_at, ms.updated_at) AS updatedAt
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
            updatedAt DESC,
            ms.id DESC
        `,
      )
      .all() as Array<{
      storeId: number;
      storeName: string;
      riskLevel: StoreCredentialRiskLevel;
      detail: string | null;
      verificationUrl: string | null;
      updatedAt: string | null;
    }>;

    return {
      kind: 'ai-service' as const,
      title: 'AI 客服工作台',
      description: '在 FAQ、订单查询和售后建议三个场景下提供受控辅助，并支持人工接管与纠偏。',
      metrics: [
        {
          label: '待处理会话',
          value: Number(summary.activeConversationCount ?? 0),
          unit: '个',
          helper: `待人工 ${Number(summary.pendingManualCount ?? 0)} 个`,
        },
        {
          label: 'AI 自动回复',
          value: Number(summary.autoReplyCount ?? 0),
          unit: '次',
          helper: '标准 FAQ 与订单状态可自动答复',
        },
        {
          label: '高风险会话',
          value: Number(summary.highRiskCount ?? 0),
          unit: '个',
          helper: '命中敏感词或高风险标签后仅转人工',
        },
        {
          label: '知识库条目',
          value: knowledgeItems.filter((item) => Boolean(item.enabled)).length,
          unit: '条',
          helper: `话术模板 ${replyTemplates.filter((item) => Boolean(item.enabled)).length} 条`,
        },
      ],
      settings,
      conversations: conversations.map((row) => ({
        ...row,
        tags: row.tagsText
          .split(/[,，]/)
          .map((item) => item.trim())
          .filter(Boolean),
        conversationStatusText: this.getAiServiceConversationStatusText(row.conversationStatus),
        aiStatusText: this.getAiServiceAiStatusText(row.aiStatus),
        riskLevelText: this.getAiServiceRiskLevelText(row.riskLevel),
      })),
      recentMessages: recentMessages.map((row) => ({
        ...row,
        senderTypeText: this.getAiServiceMessageTypeText(row.senderType),
      })),
      takeovers,
      knowledgeItems: knowledgeItems.map((row) => ({
        ...row,
        enabled: Boolean(row.enabled),
        riskLevelText: this.getAiServiceRiskLevelText(row.riskLevel),
      })),
      replyTemplates: replyTemplates.map((row) => ({
        ...row,
        enabled: Boolean(row.enabled),
      })),
      syncNotices: syncNotices.map((row) => ({
        ...row,
        detail:
          row.detail?.trim() ||
          (row.verificationUrl
            ? '闲鱼消息链路命中验证码，请点击入口继续处理。'
            : row.riskLevel === 'offline'
              ? '闲鱼网页登录态已失效，请重新登录或续登。'
              : '闲鱼消息链路当前需要人工处理。'),
        verificationUrl: row.verificationUrl?.trim() || null,
        updatedAt: row.updatedAt ?? '',
      })),
      notes: [
        'AI 自动答复仅覆盖 FAQ 和订单状态查询，售后默认只生成建议，不直接对外发送。',
        '命中敏感词、赔付、投诉、争议等高风险话题时会强制转人工，避免失控自动化。',
        '所有 AI 回复、建议回复、人工接管和人工纠偏都会保留消息与接管留痕。',
      ],
    };
  }

  private getSystemAccountsDetail() {
    const rows = this.listSystemUsers();
    const recentLoginCount = this.db
      .prepare(
        `
          SELECT COUNT(*) AS count
          FROM users
          WHERE last_login_at IS NOT NULL
            AND datetime(last_login_at) >= datetime('now', '-7 day')
        `,
      )
      .get() as { count: number };

    return {
      kind: 'system-accounts' as const,
      title: '账号管理',
      description: '管理后台账号、角色边界、启停状态和最近登录情况。',
      metrics: [
        { label: '账号总数', value: rows.length, unit: '个', helper: '当前已创建后台账号' },
        {
          label: '启用账号',
          value: rows.filter((row) => row.status === 'active').length,
          unit: '个',
          helper: '可正常登录与操作',
        },
        {
          label: '停用账号',
          value: rows.filter((row) => row.status === 'disabled').length,
          unit: '个',
          helper: '已被安全停用',
        },
        {
          label: '近7天登录',
          value: Number(recentLoginCount.count ?? 0),
          unit: '次',
          helper: '登录成功写入的最近记录',
        },
      ],
      rows,
    };
  }

  private getOpenLogsDetail() {
    const rows = this.listAuditLogs(80);
    const summary = this.db
      .prepare(
        `
          SELECT
            COUNT(*) AS totalCount,
            SUM(CASE WHEN action = 'login_failure' THEN 1 ELSE 0 END) AS loginFailureCount,
            SUM(CASE WHEN action = 'unauthorized_access' THEN 1 ELSE 0 END) AS unauthorizedCount,
            SUM(CASE WHEN result = 'failure' THEN 1 ELSE 0 END) AS failureCount
          FROM audit_logs
          WHERE datetime(created_at) >= datetime('now', '-7 day')
        `,
      )
      .get() as Record<string, number | null>;

    return {
      kind: 'open-logs' as const,
      title: '审计日志',
      description: '记录登录、权限拒绝、配置变更、提现审核和关键后台操作。',
      metrics: [
        { label: '近7天日志', value: Number(summary.totalCount ?? 0), unit: '条', helper: '审计落库记录' },
        {
          label: '登录失败',
          value: Number(summary.loginFailureCount ?? 0),
          unit: '次',
          helper: '异常口令或停用账号',
        },
        {
          label: '越权访问',
          value: Number(summary.unauthorizedCount ?? 0),
          unit: '次',
          helper: '接口或页面权限拒绝',
        },
        {
          label: '失败动作',
          value: Number(summary.failureCount ?? 0),
          unit: '次',
          helper: '关键操作失败记录',
        },
      ],
      rows,
    };
  }

  private getSystemConfigsDetail() {
    const rows = this.listSecureSettings();
    const recentUpdates = this.db
      .prepare(
        `
          SELECT COUNT(*) AS count
          FROM secure_settings
          WHERE datetime(updated_at) >= datetime('now', '-7 day')
        `,
      )
      .get() as { count: number };

    return {
      kind: 'system-configs' as const,
      title: '安全配置',
      description: '仅展示脱敏后的敏感配置摘要，明文不会出现在页面、接口响应和日志中。',
      metrics: [
        { label: '配置项', value: rows.length, unit: '项', helper: '已接入加密存储的敏感配置' },
        {
          label: '近7天更新',
          value: Number(recentUpdates.count ?? 0),
          unit: '次',
          helper: '配置轮换与更新记录',
        },
        {
          label: '脱敏展示',
          value: rows.length,
          unit: '项',
          helper: '页面只返回掩码值',
        },
        {
          label: '存储状态',
          value: rows.length > 0 ? rows.length : 0,
          unit: '项',
          helper: '数据库内保存密文',
        },
      ],
      rows,
    };
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

  private syncSystemMonitoringAlerts(now = format(new Date(), 'yyyy-MM-dd HH:mm:ss')) {
    const auditFailureCount = this.db
      .prepare(
        `
          SELECT COUNT(*) AS count
          FROM audit_logs
          WHERE result = 'failure'
            AND datetime(created_at) >= datetime('now', '-7 day')
        `,
      )
      .get() as { count: number };
    const directCallbackFailureCount = this.db
      .prepare(
        `
          SELECT COUNT(*) AS count
          FROM direct_charge_callbacks
          WHERE verification_status = 'failed'
        `,
      )
      .get() as { count: number };
    const sourceCallbackFailureCount = this.db
      .prepare(
        `
          SELECT COUNT(*) AS count
          FROM supply_source_callbacks
          WHERE verification_status = 'failed'
        `,
      )
      .get() as { count: number };
    const cardJobFailureCount = this.db
      .prepare(
        `
          SELECT COUNT(*) AS count
          FROM card_delivery_jobs
          WHERE job_status = 'failed'
        `,
      )
      .get() as { count: number };
    const directJobFailureStats = this.db
      .prepare(
        `
          SELECT
            SUM(CASE WHEN task_status = 'failed' THEN 1 ELSE 0 END) AS failedCount,
            SUM(CASE WHEN task_status = 'manual_review' THEN 1 ELSE 0 END) AS manualCount
          FROM direct_charge_jobs
        `,
      )
      .get() as { failedCount: number | null; manualCount: number | null };
    const sourceOrderFailureStats = this.db
      .prepare(
        `
          SELECT
            SUM(CASE WHEN order_status = 'failed' THEN 1 ELSE 0 END) AS failedCount,
            SUM(CASE WHEN order_status = 'manual_review' THEN 1 ELSE 0 END) AS manualCount
          FROM supply_source_orders
        `,
      )
      .get() as { failedCount: number | null; manualCount: number | null };
    const inventoryAlertCount = this.db
      .prepare(
        `
          SELECT COUNT(*) AS count
          FROM card_stock_alerts
          WHERE status = 'open'
        `,
      )
      .get() as { count: number };
    const storeOfflineStats = this.db
      .prepare(
        `
          SELECT
            SUM(CASE WHEN connection_status = 'offline' OR health_status = 'offline' THEN 1 ELSE 0 END) AS offlineCount,
            SUM(CASE WHEN connection_status = 'abnormal' OR health_status = 'abnormal' THEN 1 ELSE 0 END) AS abnormalCount
          FROM managed_stores
          WHERE enabled = 1
        `,
      )
      .get() as { offlineCount: number | null; abnormalCount: number | null };

    const apiFailureTotal =
      Number(auditFailureCount.count ?? 0) +
      Number(directCallbackFailureCount.count ?? 0) +
      Number(sourceCallbackFailureCount.count ?? 0);
    const deliveryFailureTotal =
      Number(cardJobFailureCount.count ?? 0) +
      Number(directJobFailureStats.failedCount ?? 0) +
      Number(directJobFailureStats.manualCount ?? 0) +
      Number(sourceOrderFailureStats.failedCount ?? 0) +
      Number(sourceOrderFailureStats.manualCount ?? 0);
    const inventoryAbnormalTotal = Number(inventoryAlertCount.count ?? 0);
    const storeOfflineTotal =
      Number(storeOfflineStats.offlineCount ?? 0) + Number(storeOfflineStats.abnormalCount ?? 0);

    const definitions = [
      {
        alertKey: 'api-failure',
        alertType: 'api_failure',
        severity: apiFailureTotal >= 3 ? 'critical' : 'warning',
        sourceCount: apiFailureTotal,
        title:
          apiFailureTotal > 0
            ? `最近7天接口失败 ${apiFailureTotal} 次`
            : '最近7天未发现新的接口失败',
        detail:
          apiFailureTotal > 0
            ? `审计失败 ${Number(auditFailureCount.count ?? 0)} 次，直充回调验签失败 ${Number(
                directCallbackFailureCount.count ?? 0,
              )} 次，货源回调验签失败 ${Number(sourceCallbackFailureCount.count ?? 0)} 次。`
            : '接口调用、回调验签与审计链路均处于正常状态。',
      },
      {
        alertKey: 'delivery-failure',
        alertType: 'delivery_failure',
        severity: deliveryFailureTotal >= 3 ? 'critical' : 'warning',
        sourceCount: deliveryFailureTotal,
        title:
          deliveryFailureTotal > 0
            ? `待处理发货异常 ${deliveryFailureTotal} 单`
            : '当前没有待处理发货异常',
        detail:
          deliveryFailureTotal > 0
            ? `卡密失败 ${Number(cardJobFailureCount.count ?? 0)} 单，直充失败/人工 ${Number(
                directJobFailureStats.failedCount ?? 0,
              ) + Number(directJobFailureStats.manualCount ?? 0)} 单，货源失败/人工 ${Number(
                sourceOrderFailureStats.failedCount ?? 0,
              ) + Number(sourceOrderFailureStats.manualCount ?? 0)} 单。`
            : '卡密、直充和货源推单链路均未出现未闭环异常。',
      },
      {
        alertKey: 'inventory-abnormal',
        alertType: 'inventory_abnormal',
        severity: inventoryAbnormalTotal >= 2 ? 'critical' : 'warning',
        sourceCount: inventoryAbnormalTotal,
        title:
          inventoryAbnormalTotal > 0
            ? `低库存告警 ${inventoryAbnormalTotal} 条`
            : '当前没有库存异常告警',
        detail:
          inventoryAbnormalTotal > 0
            ? '卡密库存已触发低库存阈值，请尽快补库或调整发货策略。'
            : '库存水位处于安全区间。',
      },
      {
        alertKey: 'store-offline',
        alertType: 'store_offline',
        severity: storeOfflineTotal > 0 ? 'critical' : 'warning',
        sourceCount: storeOfflineTotal,
        title:
          storeOfflineTotal > 0
            ? `掉线或异常店铺 ${storeOfflineTotal} 家`
            : '当前没有掉线店铺',
        detail:
          storeOfflineTotal > 0
            ? `掉线店铺 ${Number(storeOfflineStats.offlineCount ?? 0)} 家，异常店铺 ${Number(
                storeOfflineStats.abnormalCount ?? 0,
              )} 家。`
            : '店铺连接状态与健康体检均处于可调度状态。',
      },
    ] as const;

    const selectAlert = this.db.prepare(
      `
        SELECT
          id,
          status,
          first_triggered_at AS firstTriggeredAt,
          acknowledged_at AS acknowledgedAt,
          resolved_at AS resolvedAt
        FROM system_alerts
        WHERE alert_key = ?
      `,
    );
    const insertAlert = this.db.prepare(
      `
        INSERT INTO system_alerts (
          alert_key,
          alert_type,
          severity,
          status,
          source_count,
          title,
          detail,
          first_triggered_at,
          last_triggered_at,
          acknowledged_at,
          resolved_at,
          updated_at
        ) VALUES (
          @alertKey,
          @alertType,
          @severity,
          @status,
          @sourceCount,
          @title,
          @detail,
          @firstTriggeredAt,
          @lastTriggeredAt,
          @acknowledgedAt,
          @resolvedAt,
          @updatedAt
        )
      `,
    );
    const updateAlert = this.db.prepare(
      `
        UPDATE system_alerts
        SET
          alert_type = @alertType,
          severity = @severity,
          status = @status,
          source_count = @sourceCount,
          title = @title,
          detail = @detail,
          first_triggered_at = @firstTriggeredAt,
          last_triggered_at = @lastTriggeredAt,
          acknowledged_at = @acknowledgedAt,
          resolved_at = @resolvedAt,
          updated_at = @updatedAt
        WHERE id = @id
      `,
    );

    definitions.forEach((item) => {
      const existing = selectAlert.get(item.alertKey) as
        | {
            id: number;
            status: 'open' | 'acknowledged' | 'resolved';
            firstTriggeredAt: string;
            acknowledgedAt: string | null;
            resolvedAt: string | null;
          }
        | undefined;

      const hasIssue = item.sourceCount > 0;
      const nextStatus =
        hasIssue
          ? existing?.status === 'acknowledged'
            ? 'acknowledged'
            : 'open'
          : 'resolved';
      const payload = {
        alertKey: item.alertKey,
        alertType: item.alertType,
        severity: item.severity,
        status: nextStatus,
        sourceCount: item.sourceCount,
        title: item.title,
        detail: item.detail,
        firstTriggeredAt: existing?.firstTriggeredAt ?? now,
        lastTriggeredAt: now,
        acknowledgedAt: nextStatus === 'acknowledged' ? existing?.acknowledgedAt ?? now : null,
        resolvedAt: nextStatus === 'resolved' ? existing?.resolvedAt ?? now : null,
        updatedAt: now,
      };

      if (existing) {
        updateAlert.run({
          id: existing.id,
          ...payload,
        });
      } else {
        insertAlert.run(payload);
      }
    });

    const rows = this.db
      .prepare(
        `
          SELECT
            id,
            alert_type AS alertType,
            severity,
            status,
            source_count AS sourceCount,
            title,
            detail,
            first_triggered_at AS firstTriggeredAt,
            last_triggered_at AS lastTriggeredAt,
            acknowledged_at AS acknowledgedAt,
            resolved_at AS resolvedAt,
            updated_at AS updatedAt
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
            updated_at DESC,
            id DESC
        `,
      )
      .all() as Array<{
      id: number;
      alertType: string;
      severity: 'critical' | 'warning';
      status: 'open' | 'acknowledged' | 'resolved';
      sourceCount: number;
      title: string;
      detail: string;
      firstTriggeredAt: string;
      lastTriggeredAt: string;
      acknowledgedAt: string | null;
      resolvedAt: string | null;
      updatedAt: string;
    }>;

    return rows.map((row) => ({
      ...row,
      alertTypeText: this.getSystemAlertTypeText(row.alertType),
    }));
  }

  getAiServiceConversationDispatchTarget(featureKey: string, conversationId: number) {
    if (featureKey !== 'ai-service') {
      return null;
    }

    const row = this.db
      .prepare(
        `
          SELECT
            session_no AS sessionNo,
            store_id AS storeId,
            source
          FROM ai_service_conversations
          WHERE id = ?
        `,
      )
      .get(conversationId) as
      | {
          sessionNo: string;
          storeId: number | null;
          source: string;
        }
      | undefined;

    if (!row?.storeId || row.source !== '真实会话同步') {
      return null;
    }

    const parsed = this.parseAiServiceRealSessionNo(row.sessionNo);
    if (!parsed || parsed.storeId !== row.storeId) {
      return null;
    }

    return parsed;
  }

  private recordSystemBackupRun(input: {
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
  }) {
    this.db
      .prepare(
        `
          INSERT INTO system_backup_runs (
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
          ) VALUES (
            @backupNo,
            @backupType,
            @runStatus,
            @fileName,
            @filePath,
            @fileSize,
            @detail,
            @startedAt,
            @finishedAt,
            @triggeredByName
          )
        `,
      )
      .run({
        ...input,
        triggeredByName: input.triggeredByName ?? null,
      });

    return this.db
      .prepare(
        `
          SELECT
            id,
            backup_no AS backupNo,
            backup_type AS backupType,
            run_status AS runStatus,
            file_name AS fileName,
            file_path AS filePath,
            file_size AS fileSize,
            detail,
            started_at AS startedAt,
            finished_at AS finishedAt,
            triggered_by_name AS triggeredByName
          FROM system_backup_runs
          WHERE backup_no = ?
        `,
      )
      .get(input.backupNo) as {
      id: number;
      backupNo: string;
      backupType: 'manual' | 'scheduled';
      runStatus: 'success' | 'failed';
      fileName: string;
      filePath: string;
      fileSize: number;
      detail: string;
      startedAt: string;
      finishedAt: string | null;
      triggeredByName: string | null;
    };
  }

  private recordSystemLogArchive(input: {
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
  }) {
    this.db
      .prepare(
        `
          INSERT INTO system_log_archives (
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
          ) VALUES (
            @archiveNo,
            @periodStart,
            @periodEnd,
            @logCount,
            @fileName,
            @filePath,
            @archiveStatus,
            @detail,
            @createdAt,
            @triggeredByName
          )
        `,
      )
      .run({
        ...input,
        triggeredByName: input.triggeredByName ?? null,
      });
  }

  private recordSystemRecoveryDrill(input: {
    drillNo: string;
    backupRunId: number | null;
    backupNoSnapshot: string | null;
    drillStatus: 'success' | 'failed';
    targetPath: string;
    durationSeconds: number;
    detail: string;
    startedAt: string;
    finishedAt: string | null;
    triggeredByName?: string | null;
  }) {
    this.db
      .prepare(
        `
          INSERT INTO system_recovery_drills (
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
          ) VALUES (
            @drillNo,
            @backupRunId,
            @backupNoSnapshot,
            @drillStatus,
            @targetPath,
            @durationSeconds,
            @detail,
            @startedAt,
            @finishedAt,
            @triggeredByName
          )
        `,
      )
      .run({
        ...input,
        triggeredByName: input.triggeredByName ?? null,
      });
  }

  runSystemBackup(featureKey: string, triggeredByName?: string | null) {
    if (featureKey !== 'system-monitoring') {
      return null;
    }

    const started = new Date();
    const startedAt = format(started, 'yyyy-MM-dd HH:mm:ss');
    const backupNo = `BK-${format(started, 'yyyyMMddHHmmss')}-${randomUUID().slice(0, 6)}`;

    try {
      const artifact = createSqliteBackup({
        sourceDbPath: this.dbPath,
        outputDir: this.getBackupRootDir(),
        prefix: 'goofish-db',
        createdAt: started,
      });
      const row = this.recordSystemBackupRun({
        backupNo,
        backupType: 'manual',
        runStatus: 'success',
        fileName: artifact.fileName,
        filePath: artifact.filePath,
        fileSize: artifact.fileSize,
        detail: `备份已生成，附带清单 ${artifact.manifestPath}。`,
        startedAt,
        finishedAt: format(new Date(), 'yyyy-MM-dd HH:mm:ss'),
        triggeredByName,
      });

      this.insertWorkspaceLog(
        featureKey,
        'backup',
        '数据库备份已完成',
        `备份编号 ${row.backupNo}，文件 ${row.fileName}，大小 ${row.fileSize} 字节。`,
      );
      this.touchWorkspace(featureKey, row.finishedAt ?? startedAt);
      return row;
    } catch (error) {
      const row = this.recordSystemBackupRun({
        backupNo,
        backupType: 'manual',
        runStatus: 'failed',
        fileName: '',
        filePath: this.getBackupRootDir(),
        fileSize: 0,
        detail: error instanceof Error ? error.message : '备份执行失败',
        startedAt,
        finishedAt: format(new Date(), 'yyyy-MM-dd HH:mm:ss'),
        triggeredByName,
      });

      this.insertWorkspaceLog(featureKey, 'backup', '数据库备份失败', row.detail);
      this.touchWorkspace(featureKey, row.finishedAt ?? startedAt);
      return row;
    }
  }

  runSystemLogArchive(featureKey: string, triggeredByName?: string | null) {
    if (featureKey !== 'system-monitoring') {
      return null;
    }

    const createdAt = format(new Date(), 'yyyy-MM-dd HH:mm:ss');
    const archiveNo = `LOG-${format(new Date(), 'yyyyMMddHHmmss')}-${randomUUID().slice(0, 6)}`;
    const logs = this.listAuditLogs(120);
    const sortedLogs = [...logs].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
    const periodStart = sortedLogs[0]?.createdAt ?? createdAt;
    const periodEnd = sortedLogs.at(-1)?.createdAt ?? createdAt;
    const fileName = `${archiveNo}.json`;
    const filePath = path.join(this.getLogArchiveRootDir(), fileName);

    fs.mkdirSync(this.getLogArchiveRootDir(), { recursive: true });
    fs.writeFileSync(
      filePath,
      JSON.stringify(
        {
          archiveNo,
          createdAt,
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

    this.recordSystemLogArchive({
      archiveNo,
      periodStart,
      periodEnd,
      logCount: logs.length,
      fileName,
      filePath: path.resolve(filePath),
      archiveStatus: 'ready',
      detail: '审计日志已归档为 JSON 文件，可离线检索与恢复排障上下文。',
      createdAt,
      triggeredByName,
    });

    this.insertWorkspaceLog(
      featureKey,
      'archive',
      '日志归档已生成',
      `归档编号 ${archiveNo}，共写入 ${logs.length} 条审计日志。`,
    );
    this.touchWorkspace(featureKey, createdAt);

    return {
      archiveNo,
      fileName,
      filePath: path.resolve(filePath),
      logCount: logs.length,
      createdAt,
    };
  }

  runSystemRecoveryDrill(featureKey: string, triggeredByName?: string | null) {
    if (featureKey !== 'system-monitoring') {
      return null;
    }

    const latestBackup = this.db
      .prepare(
        `
          SELECT
            id,
            backup_no AS backupNo,
            file_path AS filePath
          FROM system_backup_runs
          WHERE run_status = 'success'
          ORDER BY started_at DESC, id DESC
          LIMIT 1
        `,
      )
      .get() as
      | {
          id: number;
          backupNo: string;
          filePath: string;
        }
      | undefined;

    const fallbackBackup =
      latestBackup && fs.existsSync(latestBackup.filePath)
        ? latestBackup
        : this.runSystemBackup(featureKey, triggeredByName);
    if (!fallbackBackup || !fallbackBackup.filePath || !fs.existsSync(fallbackBackup.filePath)) {
      return null;
    }

    const drillNo = `DRILL-${format(new Date(), 'yyyyMMddHHmmss')}-${randomUUID().slice(0, 6)}`;
    const started = new Date();
    const startedAt = format(started, 'yyyy-MM-dd HH:mm:ss');
    const targetPath = path.join(this.getRecoveryDrillRootDir(), drillNo, 'restored.db');

    try {
      const restored = restoreSqliteBackup({
        backupFilePath: fallbackBackup.filePath,
        targetDbPath: targetPath,
      });
      const finishedAt = format(new Date(), 'yyyy-MM-dd HH:mm:ss');
      const durationSeconds = Math.max(Math.round((Date.now() - started.getTime()) / 1000), 1);
      const detail = `已恢复 ${restored.tableCount} 张表，校验订单 ${restored.orderCount} 条、账号 ${restored.userCount} 条。`;

      this.recordSystemRecoveryDrill({
        drillNo,
        backupRunId: fallbackBackup.id ?? null,
        backupNoSnapshot: fallbackBackup.backupNo ?? null,
        drillStatus: 'success',
        targetPath: path.resolve(targetPath),
        durationSeconds,
        detail,
        startedAt,
        finishedAt,
        triggeredByName,
      });

      this.insertWorkspaceLog(
        featureKey,
        'recovery',
        '恢复演练已完成',
        `演练编号 ${drillNo}，基于备份 ${fallbackBackup.backupNo ?? '临时备份'} 完成恢复验证。`,
      );
      this.touchWorkspace(featureKey, finishedAt);

      return {
        drillNo,
        backupNo: fallbackBackup.backupNo ?? null,
        targetPath: path.resolve(targetPath),
        durationSeconds,
        detail,
        finishedAt,
        status: 'success' as const,
      };
    } catch (error) {
      const finishedAt = format(new Date(), 'yyyy-MM-dd HH:mm:ss');
      const durationSeconds = Math.max(Math.round((Date.now() - started.getTime()) / 1000), 1);
      const detail = error instanceof Error ? error.message : '恢复演练失败';

      this.recordSystemRecoveryDrill({
        drillNo,
        backupRunId: fallbackBackup.id ?? null,
        backupNoSnapshot: fallbackBackup.backupNo ?? null,
        drillStatus: 'failed',
        targetPath: path.resolve(targetPath),
        durationSeconds,
        detail,
        startedAt,
        finishedAt,
        triggeredByName,
      });

      this.insertWorkspaceLog(featureKey, 'recovery', '恢复演练失败', detail);
      this.touchWorkspace(featureKey, finishedAt);
      return {
        drillNo,
        backupNo: fallbackBackup.backupNo ?? null,
        targetPath: path.resolve(targetPath),
        durationSeconds,
        detail,
        finishedAt,
        status: 'failed' as const,
      };
    }
  }

  updateSystemAlertStatus(
    featureKey: string,
    alertId: number,
    status: 'acknowledged' | 'resolved',
  ) {
    if (featureKey !== 'system-monitoring') {
      return null;
    }

    const row = this.db
      .prepare(
        `
          SELECT id, alert_type AS alertType, title
          FROM system_alerts
          WHERE id = ?
        `,
      )
      .get(alertId) as { id: number; alertType: string; title: string } | undefined;

    if (!row) {
      return null;
    }

    const now = format(new Date(), 'yyyy-MM-dd HH:mm:ss');
    this.db
      .prepare(
        `
          UPDATE system_alerts
          SET
            status = @status,
            acknowledged_at = CASE
              WHEN @status = 'acknowledged' THEN COALESCE(acknowledged_at, @now)
              ELSE acknowledged_at
            END,
            resolved_at = CASE
              WHEN @status = 'resolved' THEN COALESCE(resolved_at, @now)
              ELSE NULL
            END,
            updated_at = @now
          WHERE id = @id
        `,
      )
      .run({
        id: alertId,
        status,
        now,
      });

    this.insertWorkspaceLog(
      featureKey,
      'alert',
      `${this.getSystemAlertTypeText(row.alertType)}告警已${status === 'acknowledged' ? '确认' : '处理'}`,
      status === 'acknowledged'
        ? `${row.title} 已由运维人员确认，等待后续处理。`
        : `${row.title} 已手动标记为处理完成，系统将在下次体检时继续复核。`,
    );
    this.touchWorkspace(featureKey, now);

    return { status };
  }

  getSystemHealthSnapshot() {
    const alerts = this.syncSystemMonitoringAlerts();
    const latestBackup = this.db
      .prepare(
        `
          SELECT
            backup_no AS backupNo,
            started_at AS startedAt
          FROM system_backup_runs
          WHERE run_status = 'success'
          ORDER BY started_at DESC, id DESC
          LIMIT 1
        `,
      )
      .get() as { backupNo: string; startedAt: string } | undefined;
    const activeAlertCount = alerts.filter((item) => item.status !== 'resolved').length;
    const criticalAlertCount = alerts.filter(
      (item) => item.status !== 'resolved' && item.severity === 'critical',
    ).length;
    const jobStats = this.db
      .prepare(
        `
          SELECT
            (SELECT COUNT(*) FROM card_delivery_jobs WHERE job_status = 'failed') +
            (SELECT COUNT(*) FROM direct_charge_jobs WHERE task_status IN ('failed', 'manual_review')) +
            (SELECT COUNT(*) FROM supply_source_orders WHERE order_status IN ('failed', 'manual_review')) AS failedJobs,
            (SELECT COUNT(*) FROM card_delivery_jobs WHERE job_status = 'pending') +
            (SELECT COUNT(*) FROM direct_charge_jobs WHERE task_status IN ('pending_dispatch', 'processing')) +
            (SELECT COUNT(*) FROM supply_source_orders WHERE order_status IN ('pending_push', 'processing')) AS pendingJobs
        `,
      )
      .get() as { failedJobs: number | null; pendingJobs: number | null };
    const backupCount = this.db
      .prepare(
        `
          SELECT COUNT(*) AS count
          FROM system_backup_runs
          WHERE run_status = 'success'
        `,
      )
      .get() as { count: number };

    return {
      database: {
        path: path.resolve(this.dbPath),
        sizeBytes: fs.existsSync(this.dbPath) ? fs.statSync(this.dbPath).size : 0,
      },
      alerts: {
        activeCount: activeAlertCount,
        criticalCount: criticalAlertCount,
      },
      jobs: {
        failedCount: Number(jobStats.failedJobs ?? 0),
        pendingCount: Number(jobStats.pendingJobs ?? 0),
      },
      backups: {
        successCount: Number(backupCount.count ?? 0),
        latestBackupNo: latestBackup?.backupNo ?? null,
        latestBackupAt: latestBackup?.startedAt ?? null,
      },
      paths: {
        backupDir: this.getBackupRootDir(),
        logArchiveDir: this.getLogArchiveRootDir(),
        recoveryDir: this.getRecoveryDrillRootDir(),
      },
    };
  }

  private getSystemMonitoringDetail() {
    const alerts = this.syncSystemMonitoringAlerts();
    const backupRootDir = this.getBackupRootDir();
    const logArchiveRootDir = this.getLogArchiveRootDir();
    const recoveryRootDir = this.getRecoveryDrillRootDir();
    const dbSizeBytes = fs.existsSync(this.dbPath) ? fs.statSync(this.dbPath).size : 0;

    const jobMonitors = [
      this.db
        .prepare(
          `
            SELECT
              'card-delivery' AS groupKey,
              '卡密发货' AS groupLabel,
              SUM(CASE WHEN job_status = 'pending' THEN 1 ELSE 0 END) AS pendingCount,
              SUM(CASE WHEN job_status = 'failed' THEN 1 ELSE 0 END) AS failedCount,
              SUM(CASE WHEN job_status = 'recycled' THEN 1 ELSE 0 END) AS manualCount,
              MAX(updated_at) AS latestUpdatedAt
            FROM card_delivery_jobs
          `,
        )
        .get(),
      this.db
        .prepare(
          `
            SELECT
              'direct-charge' AS groupKey,
              '直充发货' AS groupLabel,
              SUM(CASE WHEN task_status IN ('pending_dispatch', 'processing') THEN 1 ELSE 0 END) AS pendingCount,
              SUM(CASE WHEN task_status = 'failed' THEN 1 ELSE 0 END) AS failedCount,
              SUM(CASE WHEN task_status = 'manual_review' THEN 1 ELSE 0 END) AS manualCount,
              MAX(updated_at) AS latestUpdatedAt
            FROM direct_charge_jobs
          `,
        )
        .get(),
      this.db
        .prepare(
          `
            SELECT
              'source-supply' AS groupKey,
              '货源推单' AS groupLabel,
              SUM(CASE WHEN order_status IN ('pending_push', 'processing') THEN 1 ELSE 0 END) AS pendingCount,
              SUM(CASE WHEN order_status = 'failed' THEN 1 ELSE 0 END) AS failedCount,
              SUM(CASE WHEN order_status = 'manual_review' THEN 1 ELSE 0 END) AS manualCount,
              MAX(updated_at) AS latestUpdatedAt
            FROM supply_source_orders
          `,
        )
        .get(),
      this.db
        .prepare(
          `
            SELECT
              'store-health' AS groupKey,
              '店铺体检' AS groupLabel,
              SUM(
                CASE
                  WHEN enabled = 1
                    AND (last_health_check_at IS NULL OR datetime(last_health_check_at) < datetime('now', '-1 day'))
                  THEN 1
                  ELSE 0
                END
              ) AS pendingCount,
              SUM(CASE WHEN health_status IN ('offline', 'abnormal') THEN 1 ELSE 0 END) AS failedCount,
              SUM(CASE WHEN health_status = 'warning' THEN 1 ELSE 0 END) AS manualCount,
              MAX(last_health_check_at) AS latestUpdatedAt
            FROM managed_stores
          `,
        )
        .get(),
    ].map((row) => {
      const record = row as {
        groupKey: string;
        groupLabel: string;
        pendingCount: number | null;
        failedCount: number | null;
        manualCount: number | null;
        latestUpdatedAt: string | null;
      };

      return {
        ...record,
        pendingCount: Number(record.pendingCount ?? 0),
        failedCount: Number(record.failedCount ?? 0),
        manualCount: Number(record.manualCount ?? 0),
        latestUpdatedAt: record.latestUpdatedAt,
        note:
          record.groupKey === 'store-health'
            ? '关注体检过期、掉线和异常店铺。'
            : '关注失败、人工接管和长时间未完成任务。',
      };
    });

    const backups = this.db
      .prepare(
        `
          SELECT
            id,
            backup_no AS backupNo,
            backup_type AS backupType,
            run_status AS runStatus,
            file_name AS fileName,
            file_path AS filePath,
            file_size AS fileSize,
            detail,
            started_at AS startedAt,
            finished_at AS finishedAt,
            triggered_by_name AS triggeredByName
          FROM system_backup_runs
          ORDER BY started_at DESC, id DESC
          LIMIT 8
        `,
      )
      .all() as Array<{
      id: number;
      backupNo: string;
      backupType: 'manual' | 'scheduled';
      runStatus: 'success' | 'failed';
      fileName: string;
      filePath: string;
      fileSize: number;
      detail: string;
      startedAt: string;
      finishedAt: string | null;
      triggeredByName: string | null;
    }>;

    const logArchives = this.db
      .prepare(
        `
          SELECT
            id,
            archive_no AS archiveNo,
            period_start AS periodStart,
            period_end AS periodEnd,
            log_count AS logCount,
            file_name AS fileName,
            file_path AS filePath,
            archive_status AS archiveStatus,
            detail,
            created_at AS createdAt,
            triggered_by_name AS triggeredByName
          FROM system_log_archives
          ORDER BY created_at DESC, id DESC
          LIMIT 8
        `,
      )
      .all() as Array<{
      id: number;
      archiveNo: string;
      periodStart: string;
      periodEnd: string;
      logCount: number;
      fileName: string;
      filePath: string;
      archiveStatus: 'ready' | 'failed';
      detail: string;
      createdAt: string;
      triggeredByName: string | null;
    }>;

    const recoveryDrills = this.db
      .prepare(
        `
          SELECT
            id,
            drill_no AS drillNo,
            backup_no_snapshot AS backupNo,
            drill_status AS drillStatus,
            target_path AS targetPath,
            duration_seconds AS durationSeconds,
            detail,
            started_at AS startedAt,
            finished_at AS finishedAt,
            triggered_by_name AS triggeredByName
          FROM system_recovery_drills
          ORDER BY started_at DESC, id DESC
          LIMIT 8
        `,
      )
      .all() as Array<{
      id: number;
      drillNo: string;
      backupNo: string | null;
      drillStatus: 'success' | 'failed';
      targetPath: string;
      durationSeconds: number;
      detail: string;
      startedAt: string;
      finishedAt: string | null;
      triggeredByName: string | null;
    }>;

    const activeAlertCount = alerts.filter((item) => item.status !== 'resolved').length;
    const criticalAlertCount = alerts.filter(
      (item) => item.status !== 'resolved' && item.severity === 'critical',
    ).length;
    const latestBackup = backups.find((item) => item.runStatus === 'success');
    const latestDrill = recoveryDrills[0];
    const successfulBackupCount = backups.filter((item) => item.runStatus === 'success').length;

    return {
      kind: 'system-monitoring' as const,
      title: '系统监控与恢复',
      description: '统一查看告警、任务监控、备份归档和恢复演练结果。',
      metrics: [
        { label: '活跃告警', value: activeAlertCount, unit: '条', helper: '未恢复的系统告警' },
        { label: '严重告警', value: criticalAlertCount, unit: '条', helper: '需优先处理的高风险项' },
        { label: '有效备份', value: successfulBackupCount, unit: '份', helper: '最近成功生成的数据库备份' },
        { label: '日志归档', value: logArchives.length, unit: '份', helper: '已生成的审计归档文件' },
      ],
      health: {
        apiStatus: activeAlertCount > 0 ? 'warning' : 'healthy',
        databasePath: path.resolve(this.dbPath),
        databaseSizeBytes: dbSizeBytes,
        backupRootDir,
        logArchiveRootDir,
        recoveryRootDir,
        latestBackupAt: latestBackup?.startedAt ?? null,
        latestRecoveryAt: latestDrill?.finishedAt ?? null,
      },
      alerts,
      jobMonitors,
      backups,
      logArchives,
      recoveryDrills,
      notes: [
        `备份目录：${backupRootDir}`,
        `日志归档目录：${logArchiveRootDir}`,
        `恢复演练目录：${recoveryRootDir}`,
        '告警按“接口失败、发货失败、库存异常、店铺掉线”四类自动同步。',
        '日志查询采用“工作台近期审计 + JSON 归档文件”双通道方案。',
      ],
    };
  }

  private getDirectChargeSupplierDetail() {
    const suppliers = this.db
      .prepare(
        `
          SELECT
            dcs.id,
            dcs.supplier_key AS supplierKey,
            dcs.supplier_name AS supplierName,
            dcs.adapter_key AS adapterKey,
            dcs.account_name AS accountName,
            dcs.endpoint_url AS endpointUrl,
            dcs.callback_token_masked AS callbackTokenMasked,
            dcs.enabled,
            dcs.supplier_status AS supplierStatus,
            dcs.balance,
            dcs.success_rate AS successRate,
            dcs.timeout_minutes AS timeoutMinutes,
            dcs.created_at AS createdAt,
            dcs.updated_at AS updatedAt,
            dcs.last_dispatch_at AS lastDispatchAt,
            dcs.last_callback_at AS lastCallbackAt,
            COALESCE(itemStats.itemCount, 0) AS itemCount,
            COALESCE(itemStats.activeItemCount, 0) AS activeItemCount,
            COALESCE(jobStats.processingCount, 0) AS processingCount,
            COALESCE(jobStats.anomalyCount, 0) AS anomalyCount
          FROM direct_charge_suppliers dcs
          LEFT JOIN (
            SELECT
              supplier_id AS supplierId,
              COUNT(*) AS itemCount,
              SUM(CASE WHEN enabled = 1 THEN 1 ELSE 0 END) AS activeItemCount
            FROM direct_charge_items
            GROUP BY supplier_id
          ) itemStats ON itemStats.supplierId = dcs.id
          LEFT JOIN (
            SELECT
              supplier_id AS supplierId,
              SUM(CASE WHEN task_status = 'processing' THEN 1 ELSE 0 END) AS processingCount,
              SUM(CASE WHEN task_status IN ('failed', 'manual_review') THEN 1 ELSE 0 END) AS anomalyCount
            FROM direct_charge_jobs
            GROUP BY supplier_id
          ) jobStats ON jobStats.supplierId = dcs.id
          ORDER BY dcs.updated_at DESC, dcs.id ASC
        `,
      )
      .all() as Array<{
      id: number;
      supplierKey: string;
      supplierName: string;
      adapterKey: string;
      accountName: string;
      endpointUrl: string;
      callbackTokenMasked: string;
      enabled: number;
      supplierStatus: DirectChargeSupplierStatus;
      balance: number;
      successRate: number;
      timeoutMinutes: number;
      createdAt: string;
      updatedAt: string;
      lastDispatchAt: string | null;
      lastCallbackAt: string | null;
      itemCount: number;
      activeItemCount: number;
      processingCount: number;
      anomalyCount: number;
    }>;

    const items = this.db
      .prepare(
        `
          SELECT
            dci.id,
            dci.supplier_id AS supplierId,
            dcs.supplier_name AS supplierName,
            dci.product_id AS productId,
            dci.product_title AS productTitle,
            dci.category,
            dci.store_name AS storeName,
            dci.target_type AS targetType,
            dci.zone_required AS zoneRequired,
            dci.face_value AS faceValue,
            dci.enabled,
            dci.status,
            dci.updated_at AS updatedAt
          FROM direct_charge_items dci
          INNER JOIN direct_charge_suppliers dcs ON dcs.id = dci.supplier_id
          ORDER BY dci.updated_at DESC, dci.id ASC
        `,
      )
      .all() as Array<{
      id: number;
      supplierId: number;
      supplierName: string;
      productId: number;
      productTitle: string;
      category: string;
      storeName: string;
      targetType: string;
      zoneRequired: number;
      faceValue: number;
      enabled: number;
      status: string;
      updatedAt: string;
    }>;

    const sourceSystems = this.db
      .prepare(
        `
          SELECT
            sss.id,
            sss.system_key AS systemKey,
            sss.system_name AS systemName,
            sss.adapter_key AS adapterKey,
            sss.endpoint_url AS endpointUrl,
            sss.callback_token_masked AS callbackTokenMasked,
            sss.enabled,
            sss.system_status AS systemStatus,
            sss.sync_mode AS syncMode,
            sss.sync_interval_minutes AS syncIntervalMinutes,
            sss.order_push_enabled AS orderPushEnabled,
            sss.refund_callback_enabled AS refundCallbackEnabled,
            sss.created_at AS createdAt,
            sss.updated_at AS updatedAt,
            sss.last_product_sync_at AS lastProductSyncAt,
            sss.last_inventory_sync_at AS lastInventorySyncAt,
            sss.last_price_sync_at AS lastPriceSyncAt,
            sss.last_order_push_at AS lastOrderPushAt,
            sss.last_callback_at AS lastCallbackAt,
            sss.last_refund_notice_at AS lastRefundNoticeAt,
            COALESCE(mappingStats.mappingCount, 0) AS mappingCount,
            COALESCE(mappingStats.anomalyCount, 0) AS anomalyCount
          FROM supply_source_systems sss
          LEFT JOIN (
            SELECT
              system_id AS systemId,
              COUNT(*) AS mappingCount,
              SUM(CASE WHEN sync_status != 'synced' THEN 1 ELSE 0 END) AS anomalyCount
            FROM supply_source_products
            GROUP BY system_id
          ) mappingStats ON mappingStats.systemId = sss.id
          ORDER BY sss.updated_at DESC, sss.id ASC
        `,
      )
      .all() as Array<{
      id: number;
      systemKey: string;
      systemName: string;
      adapterKey: string;
      endpointUrl: string;
      callbackTokenMasked: string;
      enabled: number;
      systemStatus: SupplySourceSystemStatus;
      syncMode: SupplySourceSyncMode;
      syncIntervalMinutes: number;
      orderPushEnabled: number;
      refundCallbackEnabled: number;
      createdAt: string;
      updatedAt: string;
      lastProductSyncAt: string | null;
      lastInventorySyncAt: string | null;
      lastPriceSyncAt: string | null;
      lastOrderPushAt: string | null;
      lastCallbackAt: string | null;
      lastRefundNoticeAt: string | null;
      mappingCount: number;
      anomalyCount: number;
    }>;

    const sourceProducts = this.db
      .prepare(
        `
          SELECT
            ssp.id,
            ssp.system_id AS systemId,
            sss.system_name AS systemName,
            ssp.external_product_id AS externalProductId,
            ssp.external_sku AS externalSku,
            ssp.external_product_name AS externalProductName,
            ssp.platform_product_id AS platformProductId,
            ssp.platform_product_name AS platformProductName,
            ssp.store_name AS storeName,
            ssp.category,
            ssp.sale_price AS salePrice,
            ssp.source_price AS sourcePrice,
            ssp.source_stock AS sourceStock,
            ssp.sync_status AS syncStatus,
            ssp.enabled,
            ssp.last_sync_at AS lastSyncAt,
            ssp.updated_at AS updatedAt
          FROM supply_source_products ssp
          INNER JOIN supply_source_systems sss ON sss.id = ssp.system_id
          ORDER BY
            CASE ssp.sync_status
              WHEN 'anomaly' THEN 0
              WHEN 'warning' THEN 1
              ELSE 2
            END,
            ssp.updated_at DESC,
            ssp.id DESC
        `,
      )
      .all() as Array<{
      id: number;
      systemId: number;
      systemName: string;
      externalProductId: string;
      externalSku: string;
      externalProductName: string;
      platformProductId: number;
      platformProductName: string;
      storeName: string;
      category: string;
      salePrice: number;
      sourcePrice: number;
      sourceStock: number;
      syncStatus: SupplySourceProductSyncStatus;
      enabled: number;
      lastSyncAt: string;
      updatedAt: string;
    }>;

    const sourceSyncRuns = this.db
      .prepare(
        `
          SELECT
            ssr.id,
            ssr.system_id AS systemId,
            sss.system_name AS systemName,
            ssr.sync_type AS syncType,
            ssr.run_mode AS runMode,
            ssr.run_status AS runStatus,
            ssr.total_count AS totalCount,
            ssr.success_count AS successCount,
            ssr.failure_count AS failureCount,
            ssr.detail,
            ssr.created_at AS createdAt,
            ssr.finished_at AS finishedAt
          FROM supply_source_sync_runs ssr
          INNER JOIN supply_source_systems sss ON sss.id = ssr.system_id
          ORDER BY ssr.created_at DESC, ssr.id DESC
          LIMIT 16
        `,
      )
      .all() as Array<{
      id: number;
      systemId: number;
      systemName: string;
      syncType: SupplySourceSyncType;
      runMode: SupplySourceSyncMode;
      runStatus: SupplySourceSyncRunStatus;
      totalCount: number;
      successCount: number;
      failureCount: number;
      detail: string;
      createdAt: string;
      finishedAt: string;
    }>;

    return {
      kind: 'distribution-source' as const,
      title: '供应链接入中心',
      description: '统一管理直充供应商与自有货源系统，覆盖账号配置、商品映射、同步策略与回调令牌。',
      metrics: [
        {
          label: '直充供应商',
          value: suppliers.length,
          unit: '个',
          helper: '直充供应商账号总数',
        },
        {
          label: '货源系统',
          value: sourceSystems.length,
          unit: '个',
          helper: '已接入的自有货源系统',
        },
        {
          label: '映射商品',
          value: items.length + sourceProducts.length,
          unit: '个',
          helper: '含直充商品与自有货源映射',
        },
        {
          label: '同步异常',
          value:
            suppliers.filter((item) => item.supplierStatus !== 'online').length +
            sourceProducts.filter((item) => item.syncStatus !== 'synced').length,
          unit: '个',
          helper: '含预警供应商与货源同步异常',
        },
      ],
      suppliers: suppliers.map((item) => ({
        ...item,
        enabled: Boolean(item.enabled),
      })),
      items: items.map((item) => ({
        ...item,
        enabled: Boolean(item.enabled),
        zoneRequired: Boolean(item.zoneRequired),
      })),
      sourceSystems: sourceSystems.map((item) => ({
        ...item,
        enabled: Boolean(item.enabled),
        orderPushEnabled: Boolean(item.orderPushEnabled),
        refundCallbackEnabled: Boolean(item.refundCallbackEnabled),
      })),
      sourceProducts: sourceProducts.map((item) => ({
        ...item,
        enabled: Boolean(item.enabled),
      })),
      sourceSyncRuns,
    };
  }

  private upsertDirectChargeReconciliation(
    jobId: number,
    supplierId: number,
    orderId: number,
    reconcileStatus: DirectChargeReconcileStatus,
    supplierStatus: string | null,
    mappedStatus: string | null,
    detail: string,
    now: string,
  ) {
    this.db
      .prepare(
        `
          INSERT INTO direct_charge_reconciliations (
            job_id,
            supplier_id,
            order_id,
            reconcile_status,
            supplier_status,
            mapped_status,
            detail,
            created_at,
            updated_at
          ) VALUES (
            @jobId,
            @supplierId,
            @orderId,
            @reconcileStatus,
            @supplierStatus,
            @mappedStatus,
            @detail,
            @createdAt,
            @updatedAt
          )
          ON CONFLICT(job_id) DO UPDATE SET
            supplier_id = excluded.supplier_id,
            order_id = excluded.order_id,
            reconcile_status = excluded.reconcile_status,
            supplier_status = excluded.supplier_status,
            mapped_status = excluded.mapped_status,
            detail = excluded.detail,
            updated_at = excluded.updated_at
        `,
      )
      .run({
        jobId,
        supplierId,
        orderId,
        reconcileStatus,
        supplierStatus,
        mappedStatus,
        detail,
        createdAt: now,
        updatedAt: now,
      });
  }

  private getDirectChargeJobContext(jobId: number) {
    return this.db
      .prepare(
        `
          SELECT
            dcj.id,
            dcj.order_id AS orderId,
            dcj.supplier_id AS supplierId,
            dcj.item_id AS itemId,
            dcj.task_no AS taskNo,
            dcj.supplier_order_no AS supplierOrderNo,
            dcj.adapter_key AS adapterKey,
            dcj.target_account AS targetAccount,
            dcj.target_zone AS targetZone,
            dcj.face_value AS faceValue,
            dcj.task_status AS taskStatus,
            dcj.supplier_status AS supplierStatus,
            dcj.callback_status AS callbackStatus,
            dcj.verification_status AS verificationStatus,
            dcj.retry_count AS retryCount,
            dcj.max_retry AS maxRetry,
            dcj.error_message AS errorMessage,
            dcj.result_detail AS resultDetail,
            dcj.last_dispatch_at AS lastDispatchAt,
            dcj.last_callback_at AS lastCallbackAt,
            dcj.timeout_at AS timeoutAt,
            dcj.manual_reason AS manualReason,
            o.order_no AS orderNo,
            o.after_sale_status AS afterSaleStatus,
            o.paid_at AS paidAt,
            dcs.supplier_key AS supplierKey,
            dcs.supplier_name AS supplierName,
            dcs.callback_token AS callbackToken,
            dcs.enabled AS supplierEnabled,
            dcs.supplier_status AS supplierHealthStatus,
            dcs.timeout_minutes AS timeoutMinutes,
            dci.product_title AS productTitle,
            dci.enabled AS itemEnabled,
            dci.status AS itemStatus
          FROM direct_charge_jobs dcj
          INNER JOIN orders o ON o.id = dcj.order_id
          INNER JOIN direct_charge_suppliers dcs ON dcs.id = dcj.supplier_id
          INNER JOIN direct_charge_items dci ON dci.id = dcj.item_id
          WHERE dcj.id = ?
        `,
      )
      .get(jobId) as
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
          taskStatus: DirectChargeJobStatus;
          supplierStatus: string | null;
          callbackStatus: DirectChargeCallbackStatus;
          verificationStatus: DirectChargeVerificationStatus;
          retryCount: number;
          maxRetry: number;
          errorMessage: string | null;
          resultDetail: string | null;
          lastDispatchAt: string | null;
          lastCallbackAt: string | null;
          timeoutAt: string | null;
          manualReason: string | null;
          orderNo: string;
          afterSaleStatus: string;
          paidAt: string;
          supplierKey: string;
          supplierName: string;
          callbackToken: string;
          supplierEnabled: number;
          supplierHealthStatus: DirectChargeSupplierStatus;
          timeoutMinutes: number;
          productTitle: string;
          itemEnabled: number;
          itemStatus: string;
        }
      | undefined;
  }

  private refreshDirectChargeTimeoutJobs(now: string) {
    const overdueJobs = this.db
      .prepare(
        `
          SELECT
            id,
            order_id AS orderId,
            supplier_id AS supplierId,
            task_no AS taskNo,
            retry_count AS retryCount,
            max_retry AS maxRetry
          FROM direct_charge_jobs
          WHERE task_status = 'processing'
            AND timeout_at IS NOT NULL
            AND datetime(timeout_at) <= datetime(@now)
        `,
      )
      .all({ now }) as Array<{
      id: number;
      orderId: number;
      supplierId: number;
      taskNo: string;
      retryCount: number;
      maxRetry: number;
    }>;

    overdueJobs.forEach((job) => {
      const shouldRetry = job.retryCount < job.maxRetry;
      const nextTaskStatus: DirectChargeJobStatus = shouldRetry ? 'pending_dispatch' : 'manual_review';
      const detail = shouldRetry
        ? '供应商超时未回调，任务已转入重试队列。'
        : '供应商超时未回调，任务已转人工处理。';

      this.db
        .prepare(
          `
            UPDATE direct_charge_jobs
            SET
              task_status = @taskStatus,
              callback_status = 'timeout',
              error_message = @errorMessage,
              result_detail = @resultDetail,
              manual_reason = @manualReason,
              updated_at = @updatedAt
            WHERE id = @id
          `,
        )
        .run({
          id: job.id,
          taskStatus: nextTaskStatus,
          errorMessage: detail,
          resultDetail: detail,
          manualReason: shouldRetry ? null : detail,
          updatedAt: now,
        });

      this.db
        .prepare(
          `
            UPDATE orders
            SET
              order_status = 'pending_shipment',
              delivery_status = @deliveryStatus,
              main_status = 'processing',
              updated_at = @updatedAt
            WHERE id = @id
          `,
        )
        .run({
          id: job.orderId,
          deliveryStatus: shouldRetry ? 'pending' : 'manual_review',
          updatedAt: now,
        });

      this.appendOrderEvent(
        job.orderId,
        'direct_charge_timeout',
        shouldRetry ? '直充任务超时待重试' : '直充任务超时转人工',
        `任务号 ${job.taskNo} 超时未收到回调，${shouldRetry ? '系统已加入重试队列。' : '系统已转人工接管。'}`,
        '直充发货引擎',
        now,
      );
      this.upsertDirectChargeReconciliation(
        job.id,
        job.supplierId,
        job.orderId,
        shouldRetry ? 'pending' : 'anomaly',
        'TIMEOUT',
        shouldRetry ? 'processing' : 'failed',
        detail,
        now,
      );
    });

    if (overdueJobs.length > 0) {
      this.insertWorkspaceLog(
        'distribution-supply',
        'timeout_refresh',
        '直充超时任务已刷新',
        `共处理 ${overdueJobs.length} 条超时任务，已自动转入重试或人工处理。`,
      );
      this.touchWorkspace('distribution-supply', now);
    }
  }

  private dispatchDirectChargeJobInternal(jobId: number, now: string, retry = false) {
    const context = this.getDirectChargeJobContext(jobId);
    if (!context) {
      return null;
    }

    if (context.taskStatus === 'success') {
      return {
        success: true,
        idempotent: true,
        jobId: context.id,
        taskStatus: context.taskStatus,
        supplierOrderNo: context.supplierOrderNo,
        detail: context.resultDetail ?? '任务已完成。',
        timeoutAt: context.timeoutAt,
      };
    }

    if (
      context.taskStatus === 'processing' &&
      context.timeoutAt &&
      new Date(context.timeoutAt.replace(' ', 'T')).getTime() > new Date(now.replace(' ', 'T')).getTime()
    ) {
      return {
        success: true,
        idempotent: true,
        jobId: context.id,
        taskStatus: context.taskStatus,
        supplierOrderNo: context.supplierOrderNo,
        detail: context.resultDetail ?? '任务仍在处理中。',
        timeoutAt: context.timeoutAt,
      };
    }

    const failDispatch = (errorMessage: string) => {
      this.db
        .prepare(
          `
            UPDATE direct_charge_jobs
            SET
              task_status = 'manual_review',
              error_message = @errorMessage,
              result_detail = @resultDetail,
              manual_reason = @manualReason,
              updated_at = @updatedAt
            WHERE id = @id
          `,
        )
        .run({
          id: context.id,
          errorMessage,
          resultDetail: errorMessage,
          manualReason: errorMessage,
          updatedAt: now,
        });

      this.db
        .prepare(
          `
            UPDATE orders
            SET
              order_status = 'pending_shipment',
              delivery_status = 'manual_review',
              main_status = 'processing',
              updated_at = @updatedAt
            WHERE id = @id
          `,
        )
        .run({
          id: context.orderId,
          updatedAt: now,
        });

      this.appendOrderEvent(
        context.orderId,
        'direct_charge_manual_review',
        '直充任务转人工',
        errorMessage,
        '直充发货引擎',
        now,
      );
      this.upsertDirectChargeReconciliation(
        context.id,
        context.supplierId,
        context.orderId,
        'anomaly',
        context.supplierStatus,
        'failed',
        errorMessage,
        now,
      );

      return {
        success: false,
        idempotent: false,
        jobId: context.id,
        taskStatus: 'manual_review' as const,
        errorMessage,
      };
    };

    if (!context.supplierEnabled || context.supplierHealthStatus === 'offline') {
      return failDispatch('供应商未启用或当前离线，任务已转人工处理。');
    }

    if (!context.itemEnabled || context.itemStatus !== '销售中') {
      return failDispatch('直充商品配置未启用，任务已转人工处理。');
    }

    const adapter = getDirectChargeAdapter(context.adapterKey);
    if (!adapter) {
      return failDispatch('供应商适配器不存在，无法执行下发。');
    }

    const dispatchResult = adapter.dispatch({
      taskNo: context.taskNo,
      orderNo: context.orderNo,
      productTitle: context.productTitle,
      targetAccount: context.targetAccount,
      targetZone: context.targetZone,
      amount: context.faceValue,
      retryCount: context.retryCount,
    });
    const timeoutAt = format(
      addMinutes(
        new Date(now.replace(' ', 'T')),
        context.timeoutMinutes > 0 ? context.timeoutMinutes : DIRECT_CHARGE_TIMEOUT_MINUTES,
      ),
      'yyyy-MM-dd HH:mm:ss',
    );

    this.db.transaction(() => {
      this.db
        .prepare(
          `
            UPDATE direct_charge_jobs
            SET
              supplier_order_no = @supplierOrderNo,
              supplier_status = @supplierStatus,
              task_status = 'processing',
              callback_status = 'pending',
              verification_status = 'pending',
              retry_count = CASE
                WHEN @retry = 1 THEN retry_count + 1
                ELSE retry_count
              END,
              error_message = NULL,
              result_detail = @resultDetail,
              last_dispatch_at = @lastDispatchAt,
              timeout_at = @timeoutAt,
              manual_reason = NULL,
              updated_at = @updatedAt
            WHERE id = @id
          `,
        )
        .run({
          id: context.id,
          supplierOrderNo: dispatchResult.supplierOrderNo,
          supplierStatus: dispatchResult.supplierStatus,
          retry: retry ? 1 : 0,
          resultDetail: dispatchResult.detail,
          lastDispatchAt: now,
          timeoutAt,
          updatedAt: now,
        });

      this.db
        .prepare(
          `
            UPDATE direct_charge_suppliers
            SET
              last_dispatch_at = @lastDispatchAt,
              updated_at = @updatedAt
            WHERE id = @id
          `,
        )
        .run({
          id: context.supplierId,
          lastDispatchAt: now,
          updatedAt: now,
        });

      this.db
        .prepare(
          `
            UPDATE orders
            SET
              order_status = 'shipped',
              delivery_status = 'shipped',
              main_status = 'processing',
              shipped_at = COALESCE(shipped_at, @shippedAt),
              updated_at = @updatedAt
            WHERE id = @id
          `,
        )
        .run({
          id: context.orderId,
          shippedAt: now,
          updatedAt: now,
        });

      this.appendOrderEvent(
        context.orderId,
        retry ? 'direct_charge_redispatch' : 'direct_charge_dispatch',
        retry ? '直充任务已重试下发' : '直充任务已下发',
        `${context.productTitle} 已提交至 ${context.supplierName}，任务号 ${context.taskNo}。`,
        '直充发货引擎',
        now,
      );
      this.upsertDirectChargeReconciliation(
        context.id,
        context.supplierId,
        context.orderId,
        'pending',
        dispatchResult.supplierStatus,
        'processing',
        dispatchResult.detail,
        now,
      );
    })();

    return {
      success: true,
      idempotent: false,
      jobId: context.id,
      taskStatus: 'processing' as const,
      supplierOrderNo: dispatchResult.supplierOrderNo,
      detail: dispatchResult.detail,
      timeoutAt,
    };
  }

  private getDirectChargeSupplyDetail() {
    const now = format(new Date(), 'yyyy-MM-dd HH:mm:ss');
    this.refreshDirectChargeTimeoutJobs(now);

    const jobs = this.db
      .prepare(
        `
          SELECT
            dcj.id,
            dcj.order_id AS orderId,
            o.order_no AS orderNo,
            dci.product_title AS productTitle,
            dcs.supplier_name AS supplierName,
            dcj.task_no AS taskNo,
            dcj.supplier_order_no AS supplierOrderNo,
            dcj.target_account AS targetAccount,
            dcj.target_zone AS targetZone,
            dcj.face_value AS faceValue,
            dcj.task_status AS taskStatus,
            dcj.supplier_status AS supplierStatus,
            dcj.callback_status AS callbackStatus,
            dcj.verification_status AS verificationStatus,
            dcj.retry_count AS retryCount,
            dcj.max_retry AS maxRetry,
            dcj.error_message AS errorMessage,
            dcj.result_detail AS resultDetail,
            dcj.last_dispatch_at AS lastDispatchAt,
            dcj.last_callback_at AS lastCallbackAt,
            dcj.timeout_at AS timeoutAt,
            dcj.manual_reason AS manualReason,
            dcj.updated_at AS updatedAt
          FROM direct_charge_jobs dcj
          INNER JOIN orders o ON o.id = dcj.order_id
          INNER JOIN direct_charge_items dci ON dci.id = dcj.item_id
          INNER JOIN direct_charge_suppliers dcs ON dcs.id = dcj.supplier_id
          ORDER BY dcj.updated_at DESC, dcj.id DESC
        `,
      )
      .all() as Array<{
      id: number;
      orderId: number;
      orderNo: string;
      productTitle: string;
      supplierName: string;
      taskNo: string;
      supplierOrderNo: string | null;
      targetAccount: string;
      targetZone: string | null;
      faceValue: number;
      taskStatus: DirectChargeJobStatus;
      supplierStatus: string | null;
      callbackStatus: DirectChargeCallbackStatus;
      verificationStatus: DirectChargeVerificationStatus;
      retryCount: number;
      maxRetry: number;
      errorMessage: string | null;
      resultDetail: string | null;
      lastDispatchAt: string | null;
      lastCallbackAt: string | null;
      timeoutAt: string | null;
      manualReason: string | null;
      updatedAt: string;
    }>;

    const callbacks = this.db
      .prepare(
        `
          SELECT
            dcc.id,
            dcc.callback_no AS callbackNo,
            dcs.supplier_name AS supplierName,
            o.order_no AS orderNo,
            dcc.task_no AS taskNo,
            dcc.supplier_order_no AS supplierOrderNo,
            dcc.supplier_status AS supplierStatus,
            dcc.verification_status AS verificationStatus,
            dcc.mapped_status AS mappedStatus,
            dcc.detail,
            dcc.received_at AS receivedAt
          FROM direct_charge_callbacks dcc
          INNER JOIN direct_charge_suppliers dcs ON dcs.id = dcc.supplier_id
          LEFT JOIN orders o ON o.id = dcc.order_id
          ORDER BY dcc.received_at DESC, dcc.id DESC
        `,
      )
      .all() as Array<{
      id: number;
      callbackNo: string;
      supplierName: string;
      orderNo: string | null;
      taskNo: string;
      supplierOrderNo: string | null;
      supplierStatus: string;
      verificationStatus: DirectChargeVerificationStatus;
      mappedStatus: string | null;
      detail: string;
      receivedAt: string;
    }>;

    const reconciliations = this.db
      .prepare(
        `
          SELECT
            dcr.id,
            o.order_no AS orderNo,
            dcs.supplier_name AS supplierName,
            dcr.reconcile_status AS reconcileStatus,
            dcr.supplier_status AS supplierStatus,
            dcr.mapped_status AS mappedStatus,
            dcr.detail,
            dcr.updated_at AS updatedAt
          FROM direct_charge_reconciliations dcr
          INNER JOIN orders o ON o.id = dcr.order_id
          INNER JOIN direct_charge_suppliers dcs ON dcs.id = dcr.supplier_id
          ORDER BY
            CASE WHEN dcr.reconcile_status = 'anomaly' THEN 0 WHEN dcr.reconcile_status = 'pending' THEN 1 ELSE 2 END,
            dcr.updated_at DESC,
            dcr.id DESC
        `,
      )
      .all() as Array<{
      id: number;
      orderNo: string;
      supplierName: string;
      reconcileStatus: DirectChargeReconcileStatus;
      supplierStatus: string | null;
      mappedStatus: string | null;
      detail: string;
      updatedAt: string;
    }>;

    const sourceOrders = this.db
      .prepare(
        `
          SELECT
            sso.id,
            sso.system_id AS systemId,
            sss.system_name AS systemName,
            sso.order_id AS orderId,
            o.order_no AS orderNo,
            COALESCE(ssp.platform_product_name, p.name) AS productName,
            sso.task_no AS taskNo,
            sso.source_order_no AS sourceOrderNo,
            sso.order_status AS orderStatus,
            sso.source_status AS sourceStatus,
            sso.verification_status AS verificationStatus,
            sso.retry_count AS retryCount,
            sso.max_retry AS maxRetry,
            sso.failure_reason AS failureReason,
            sso.result_detail AS resultDetail,
            sso.pushed_at AS pushedAt,
            sso.callback_at AS callbackAt,
            sso.updated_at AS updatedAt
          FROM supply_source_orders sso
          INNER JOIN supply_source_systems sss ON sss.id = sso.system_id
          LEFT JOIN supply_source_products ssp ON ssp.id = sso.mapping_id
          LEFT JOIN orders o ON o.id = sso.order_id
          LEFT JOIN products p ON p.id = o.product_id
          ORDER BY
            CASE sso.order_status
              WHEN 'manual_review' THEN 0
              WHEN 'failed' THEN 1
              WHEN 'pending_push' THEN 2
              WHEN 'processing' THEN 3
              ELSE 4
            END,
            sso.updated_at DESC,
            sso.id DESC
        `,
      )
      .all() as Array<{
      id: number;
      systemId: number;
      systemName: string;
      orderId: number;
      orderNo: string;
      productName: string | null;
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
      updatedAt: string;
    }>;

    const sourceCallbacks = this.db
      .prepare(
        `
          SELECT
            ssc.id,
            sss.system_name AS systemName,
            o.order_no AS orderNo,
            ssc.callback_no AS callbackNo,
            ssc.task_no AS taskNo,
            ssc.source_order_no AS sourceOrderNo,
            ssc.source_status AS sourceStatus,
            ssc.verification_status AS verificationStatus,
            ssc.mapped_status AS mappedStatus,
            ssc.detail,
            ssc.received_at AS receivedAt
          FROM supply_source_callbacks ssc
          INNER JOIN supply_source_systems sss ON sss.id = ssc.system_id
          LEFT JOIN orders o ON o.id = ssc.order_id
          ORDER BY ssc.received_at DESC, ssc.id DESC
        `,
      )
      .all() as Array<{
      id: number;
      systemName: string;
      orderNo: string | null;
      callbackNo: string;
      taskNo: string;
      sourceOrderNo: string;
      sourceStatus: string;
      verificationStatus: SupplySourceVerificationStatus;
      mappedStatus: string | null;
      detail: string;
      receivedAt: string;
    }>;

    const sourceRefundNotices = this.db
      .prepare(
        `
          SELECT
            ssrn.id,
            sss.system_name AS systemName,
            o.order_no AS orderNo,
            ac.case_no AS caseNo,
            ssrn.notice_no AS noticeNo,
            ssrn.source_order_no AS sourceOrderNo,
            ssrn.refund_status AS refundStatus,
            ssrn.detail,
            ssrn.notified_at AS notifiedAt,
            ssrn.updated_at AS updatedAt
          FROM supply_source_refund_notices ssrn
          INNER JOIN supply_source_systems sss ON sss.id = ssrn.system_id
          INNER JOIN orders o ON o.id = ssrn.order_id
          LEFT JOIN after_sale_cases ac ON ac.id = ssrn.case_id
          ORDER BY ssrn.notified_at DESC, ssrn.id DESC
        `,
      )
      .all() as Array<{
      id: number;
      systemName: string;
      orderNo: string;
      caseNo: string | null;
      noticeNo: string;
      sourceOrderNo: string;
      refundStatus: SupplySourceRefundStatus;
      detail: string;
      notifiedAt: string;
      updatedAt: string;
    }>;

    const sourceReconciliations = this.db
      .prepare(
        `
          SELECT
            ssr.id,
            sss.system_name AS systemName,
            ssr.reconcile_type AS reconcileType,
            ssr.reconcile_no AS reconcileNo,
            ssr.platform_ref AS platformRef,
            ssr.source_ref AS sourceRef,
            ssr.diff_amount AS diffAmount,
            ssr.reconcile_status AS reconcileStatus,
            ssr.detail,
            ssr.updated_at AS updatedAt
          FROM supply_source_reconciliations ssr
          INNER JOIN supply_source_systems sss ON sss.id = ssr.system_id
          ORDER BY
            CASE ssr.reconcile_status
              WHEN 'anomaly' THEN 0
              WHEN 'pending' THEN 1
              ELSE 2
            END,
            ssr.updated_at DESC,
            ssr.id DESC
        `,
      )
      .all() as Array<{
      id: number;
      systemName: string;
      reconcileType: string;
      reconcileNo: string;
      platformRef: string;
      sourceRef: string;
      diffAmount: number;
      reconcileStatus: SupplySourceReconcileStatus;
      detail: string;
      updatedAt: string;
    }>;

    const jobStatusCounts = jobs.reduce<Record<string, number>>((accumulator, job) => {
      accumulator[job.taskStatus] = (accumulator[job.taskStatus] ?? 0) + 1;
      return accumulator;
    }, {});
    const sourceOrderStatusCounts = sourceOrders.reduce<Record<string, number>>((accumulator, order) => {
      accumulator[order.orderStatus] = (accumulator[order.orderStatus] ?? 0) + 1;
      return accumulator;
    }, {});

    return {
      kind: 'distribution-supply' as const,
      title: '供应链履约面板',
      description: '统一查看直充任务与自有货源订单的推送、回调、退款通知和对账异常，并支持重试与人工接管。',
      metrics: [
        {
          label: '直充任务',
          value: jobs.length,
          unit: '个',
          helper: '直充订单主任务数',
        },
        {
          label: '货源订单',
          value: sourceOrders.length,
          unit: '个',
          helper: '自有货源推单主任务数',
        },
        {
          label: '处理中',
          value: Number(jobStatusCounts.processing ?? 0) + Number(sourceOrderStatusCounts.processing ?? 0),
          unit: '个',
          helper: '等待供应商或货源系统回执',
        },
        {
          label: '异常待处理',
          value:
            Number(jobStatusCounts.failed ?? 0) +
            Number(jobStatusCounts.manual_review ?? 0) +
            Number(sourceOrderStatusCounts.failed ?? 0) +
            Number(sourceOrderStatusCounts.manual_review ?? 0) +
            reconciliations.filter((item) => item.reconcileStatus === 'anomaly').length +
            sourceReconciliations.filter((item) => item.reconcileStatus === 'anomaly').length,
          unit: '个',
          helper: '含失败、人工接管和对账异常',
        },
      ],
      statuses: [
        { label: '待下发', count: Number(jobStatusCounts.pending_dispatch ?? 0) },
        { label: '处理中', count: Number(jobStatusCounts.processing ?? 0) },
        { label: '已成功', count: Number(jobStatusCounts.success ?? 0) },
        {
          label: '异常',
          count: Number(jobStatusCounts.failed ?? 0) + Number(jobStatusCounts.manual_review ?? 0),
        },
        { label: '待推单', count: Number(sourceOrderStatusCounts.pending_push ?? 0) },
        { label: '货源处理中', count: Number(sourceOrderStatusCounts.processing ?? 0) },
        { label: '货源成功', count: Number(sourceOrderStatusCounts.success ?? 0) },
        {
          label: '货源异常',
          count:
            Number(sourceOrderStatusCounts.failed ?? 0) +
            Number(sourceOrderStatusCounts.manual_review ?? 0),
        },
      ],
      jobs,
      callbacks,
      reconciliations,
      sourceOrders,
      sourceCallbacks,
      sourceRefundNotices,
      sourceReconciliations,
    };
  }

  toggleDirectChargeSupplierStatus(featureKey: string, supplierId: number) {
    if (featureKey !== 'distribution-source') {
      return null;
    }

    const supplier = this.db
      .prepare(
        `
          SELECT
            id,
            supplier_name AS supplierName,
            enabled,
            supplier_status AS supplierStatus,
            success_rate AS successRate
          FROM direct_charge_suppliers
          WHERE id = ?
        `,
      )
      .get(supplierId) as
      | {
          id: number;
          supplierName: string;
          enabled: number;
          supplierStatus: DirectChargeSupplierStatus;
          successRate: number;
        }
      | undefined;

    if (!supplier) {
      return null;
    }

    const nextEnabled = supplier.enabled ? 0 : 1;
    const nextStatus: DirectChargeSupplierStatus = nextEnabled
      ? supplier.successRate >= 95
        ? 'online'
        : 'warning'
      : 'offline';
    const now = format(new Date(), 'yyyy-MM-dd HH:mm:ss');

    this.db
      .prepare(
        `
          UPDATE direct_charge_suppliers
          SET
            enabled = @enabled,
            supplier_status = @supplierStatus,
            updated_at = @updatedAt
          WHERE id = @id
        `,
      )
      .run({
        id: supplierId,
        enabled: nextEnabled,
        supplierStatus: nextStatus,
        updatedAt: now,
      });

    this.insertWorkspaceLog(
      featureKey,
      'supplier_status',
      `${supplier.supplierName}${nextEnabled ? '已启用' : '已停用'}`,
      nextEnabled ? '供应商已重新加入直充下发链路。' : '供应商已从直充下发链路中移除。',
    );
    this.touchWorkspace(featureKey, now);
    this.touchWorkspace('distribution-supply', now);

    return {
      enabled: Boolean(nextEnabled),
      supplierStatus: nextStatus,
    };
  }

  rotateDirectChargeSupplierToken(featureKey: string, supplierId: number) {
    if (featureKey !== 'distribution-source') {
      return null;
    }

    const supplier = this.db
      .prepare(
        `
          SELECT id, supplier_name AS supplierName
          FROM direct_charge_suppliers
          WHERE id = ?
        `,
      )
      .get(supplierId) as { id: number; supplierName: string } | undefined;

    if (!supplier) {
      return null;
    }

    const nextToken = `dct-${randomUUID().replace(/-/g, '').slice(0, 20)}`;
    const maskedToken = maskSecret(nextToken);
    const now = format(new Date(), 'yyyy-MM-dd HH:mm:ss');

    this.db
      .prepare(
        `
          UPDATE direct_charge_suppliers
          SET
            callback_token = @callbackToken,
            callback_token_masked = @callbackTokenMasked,
            updated_at = @updatedAt
          WHERE id = @id
        `,
      )
      .run({
        id: supplierId,
        callbackToken: nextToken,
        callbackTokenMasked: maskedToken,
        updatedAt: now,
      });

    this.insertWorkspaceLog(
      featureKey,
      'supplier_token',
      `${supplier.supplierName} 已轮换回调令牌`,
      '旧令牌已失效，后续回调必须使用新令牌完成校验。',
    );
    this.touchWorkspace(featureKey, now);

    return {
      supplierId,
      callbackTokenMasked: maskedToken,
      rotatedAt: now,
    };
  }

  dispatchDirectChargeJob(featureKey: string, jobId: number) {
    if (featureKey !== 'distribution-supply') {
      return null;
    }

    const now = format(new Date(), 'yyyy-MM-dd HH:mm:ss');
    this.refreshDirectChargeTimeoutJobs(now);
    const context = this.getDirectChargeJobContext(jobId);
    if (!context) {
      return null;
    }

    const result = this.dispatchDirectChargeJobInternal(jobId, now, false);
    if (!result) {
      return null;
    }
    const detailText =
      result.success
        ? 'detail' in result
          ? result.detail ?? '任务已进入处理中。'
          : '任务已进入处理中。'
        : 'errorMessage' in result
          ? result.errorMessage ?? '系统未返回失败原因。'
          : '系统未返回失败原因。';

    this.insertWorkspaceLog(
      featureKey,
      result.success ? 'dispatch' : 'dispatch_failed',
      result.success ? `任务 ${context.taskNo} 已下发` : `任务 ${context.taskNo} 下发失败`,
      detailText,
    );
    this.touchWorkspace(featureKey, now);

    return result;
  }

  retryDirectChargeJob(featureKey: string, jobId: number) {
    if (featureKey !== 'distribution-supply') {
      return null;
    }

    const now = format(new Date(), 'yyyy-MM-dd HH:mm:ss');
    this.refreshDirectChargeTimeoutJobs(now);
    const context = this.getDirectChargeJobContext(jobId);
    if (!context) {
      return null;
    }

    const result = this.dispatchDirectChargeJobInternal(jobId, now, true);
    if (!result) {
      return null;
    }
    const detailText =
      result.success
        ? 'detail' in result
          ? result.detail ?? '任务已重新进入处理中。'
          : '任务已重新进入处理中。'
        : 'errorMessage' in result
          ? result.errorMessage ?? '系统未返回失败原因。'
          : '系统未返回失败原因。';

    this.insertWorkspaceLog(
      featureKey,
      result.success ? 'retry' : 'retry_failed',
      result.success ? `任务 ${context.taskNo} 已重试下发` : `任务 ${context.taskNo} 重试失败`,
      detailText,
    );
    this.touchWorkspace(featureKey, now);

    return result;
  }

  markDirectChargeJobManualReview(featureKey: string, jobId: number, reason: string) {
    if (featureKey !== 'distribution-supply') {
      return null;
    }

    const context = this.getDirectChargeJobContext(jobId);
    if (!context || context.taskStatus === 'success') {
      return null;
    }

    const now = format(new Date(), 'yyyy-MM-dd HH:mm:ss');

    this.db
      .prepare(
        `
          UPDATE direct_charge_jobs
          SET
            task_status = 'manual_review',
            error_message = @errorMessage,
            result_detail = @resultDetail,
            manual_reason = @manualReason,
            updated_at = @updatedAt
          WHERE id = @id
        `,
      )
      .run({
        id: jobId,
        errorMessage: reason,
        resultDetail: reason,
        manualReason: reason,
        updatedAt: now,
      });

    this.db
      .prepare(
        `
          UPDATE orders
          SET
            order_status = 'pending_shipment',
            delivery_status = 'manual_review',
            main_status = 'processing',
            updated_at = @updatedAt
          WHERE id = @id
        `,
      )
      .run({
        id: context.orderId,
        updatedAt: now,
      });

    this.appendOrderEvent(
      context.orderId,
      'direct_charge_manual_review',
      '直充任务人工接管',
      reason,
      '直充发货引擎',
      now,
    );
    this.upsertDirectChargeReconciliation(
      context.id,
      context.supplierId,
      context.orderId,
      'anomaly',
      context.supplierStatus,
      'failed',
      reason,
      now,
    );

    this.insertWorkspaceLog(
      featureKey,
      'manual_review',
      `任务 ${context.taskNo} 已转人工处理`,
      reason,
    );
    this.touchWorkspace(featureKey, now);

    return {
      success: true,
      taskStatus: 'manual_review' as const,
      reason,
    };
  }

  processDirectChargeCallback(supplierKey: string, payload: DirectChargeCallbackPayload) {
    const supplier = this.db
      .prepare(
        `
          SELECT
            id,
            supplier_key AS supplierKey,
            supplier_name AS supplierName,
            adapter_key AS adapterKey,
            callback_token AS callbackToken
          FROM direct_charge_suppliers
          WHERE supplier_key = ?
        `,
      )
      .get(supplierKey) as
      | {
          id: number;
          supplierKey: string;
          supplierName: string;
          adapterKey: string;
          callbackToken: string;
        }
      | undefined;

    if (!supplier) {
      return null;
    }

    const adapter = getDirectChargeAdapter(supplier.adapterKey);
    const now = format(new Date(), 'yyyy-MM-dd HH:mm:ss');
    const callbackNo = `DCB-${format(new Date(), 'yyyyMMddHHmmss')}-${randomUUID().slice(0, 6).toUpperCase()}`;
    const job = this.db
      .prepare(
        `
          SELECT
            dcj.id,
            dcj.order_id AS orderId,
            dcj.supplier_order_no AS currentSupplierOrderNo,
            dcj.task_status AS taskStatus,
            o.order_no AS orderNo
          FROM direct_charge_jobs dcj
          LEFT JOIN orders o ON o.id = dcj.order_id
          WHERE dcj.supplier_id = @supplierId
            AND dcj.task_no = @taskNo
          LIMIT 1
        `,
      )
      .get({
        supplierId: supplier.id,
        taskNo: payload.taskNo,
      }) as
      | {
          id: number;
          orderId: number;
          currentSupplierOrderNo: string | null;
          taskStatus: DirectChargeJobStatus;
          orderNo: string;
        }
      | undefined;

    if (!adapter) {
      this.db
        .prepare(
          `
            INSERT INTO direct_charge_callbacks (
              supplier_id,
              job_id,
              order_id,
              callback_no,
              task_no,
              supplier_order_no,
              supplier_status,
              verification_status,
              mapped_status,
              callback_token,
              payload_text,
              detail,
              received_at
            ) VALUES (
              @supplierId,
              @jobId,
              @orderId,
              @callbackNo,
              @taskNo,
              @supplierOrderNo,
              @supplierStatus,
              'failed',
              NULL,
              @callbackToken,
              @payloadText,
              @detail,
              @receivedAt
            )
          `,
        )
        .run({
          supplierId: supplier.id,
          jobId: job?.id ?? null,
          orderId: job?.orderId ?? null,
          callbackNo,
          taskNo: payload.taskNo,
          supplierOrderNo: payload.supplierOrderNo,
          supplierStatus: payload.supplierStatus,
          callbackToken: payload.token,
          payloadText: JSON.stringify(payload),
          detail: '供应商适配器不存在，回调已记录为异常。',
          receivedAt: now,
        });

      return {
        accepted: false,
        verificationStatus: 'failed' as const,
        mappedStatus: null,
        taskStatus: job?.taskStatus ?? 'manual_review',
      };
    }

    const verified = adapter.verifyCallbackToken(payload, supplier.callbackToken);
    const normalized = adapter.normalizeCallback(payload);
    const verificationStatus: DirectChargeVerificationStatus = verified ? 'passed' : 'failed';
    const callbackDetail = verified
      ? normalized.detail
      : payload.detail?.trim() || '回调验签失败，任务已记录为异常。';

    this.db.transaction(() => {
      this.db
        .prepare(
          `
            INSERT INTO direct_charge_callbacks (
              supplier_id,
              job_id,
              order_id,
              callback_no,
              task_no,
              supplier_order_no,
              supplier_status,
              verification_status,
              mapped_status,
              callback_token,
              payload_text,
              detail,
              received_at
            ) VALUES (
              @supplierId,
              @jobId,
              @orderId,
              @callbackNo,
              @taskNo,
              @supplierOrderNo,
              @supplierStatus,
              @verificationStatus,
              @mappedStatus,
              @callbackToken,
              @payloadText,
              @detail,
              @receivedAt
            )
          `,
        )
        .run({
          supplierId: supplier.id,
          jobId: job?.id ?? null,
          orderId: job?.orderId ?? null,
          callbackNo,
          taskNo: payload.taskNo,
          supplierOrderNo: payload.supplierOrderNo,
          supplierStatus: payload.supplierStatus,
          verificationStatus,
          mappedStatus: verified ? normalized.mappedStatus : null,
          callbackToken: payload.token,
          payloadText: JSON.stringify(payload),
          detail: callbackDetail,
          receivedAt: now,
        });

      this.db
        .prepare(
          `
            UPDATE direct_charge_suppliers
            SET
              last_callback_at = @lastCallbackAt,
              updated_at = @updatedAt
            WHERE id = @id
          `,
        )
        .run({
          id: supplier.id,
          lastCallbackAt: now,
          updatedAt: now,
        });

      if (!job) {
        return;
      }

      if (!verified) {
        this.db
          .prepare(
            `
              UPDATE direct_charge_jobs
              SET
                task_status = 'manual_review',
                callback_status = 'rejected',
                verification_status = 'failed',
                supplier_status = @supplierStatus,
                error_message = @errorMessage,
                result_detail = @resultDetail,
                last_callback_at = @lastCallbackAt,
                manual_reason = @manualReason,
                updated_at = @updatedAt
              WHERE id = @id
            `,
          )
          .run({
            id: job.id,
            supplierStatus: payload.supplierStatus,
            errorMessage: callbackDetail,
            resultDetail: callbackDetail,
            lastCallbackAt: now,
            manualReason: '回调验签失败',
            updatedAt: now,
          });

        this.db
          .prepare(
            `
              UPDATE orders
              SET
                order_status = 'pending_shipment',
                delivery_status = 'manual_review',
                main_status = 'processing',
                updated_at = @updatedAt
              WHERE id = @id
            `,
          )
          .run({
            id: job.orderId,
            updatedAt: now,
          });

        this.appendOrderEvent(
          job.orderId,
          'direct_charge_callback_rejected',
          '直充回调验签失败',
          `${supplier.supplierName} 回调未通过验签，任务已转人工处理。`,
          '直充发货引擎',
          now,
        );
        this.upsertDirectChargeReconciliation(
          job.id,
          supplier.id,
          job.orderId,
          'anomaly',
          payload.supplierStatus,
          null,
          callbackDetail,
          now,
        );
        return;
      }

      const nextTaskStatus: DirectChargeJobStatus =
        normalized.mappedStatus === 'success'
          ? 'success'
          : normalized.mappedStatus === 'failed'
            ? 'failed'
            : 'processing';
      const reconcileStatus: DirectChargeReconcileStatus =
        normalized.mappedStatus === 'success'
          ? 'matched'
          : normalized.mappedStatus === 'failed'
            ? 'anomaly'
            : 'pending';

      this.db
        .prepare(
          `
            UPDATE direct_charge_jobs
            SET
              supplier_order_no = @supplierOrderNo,
              supplier_status = @supplierStatus,
              task_status = @taskStatus,
              callback_status = 'verified',
              verification_status = 'passed',
              error_message = @errorMessage,
              result_detail = @resultDetail,
              last_callback_at = @lastCallbackAt,
              manual_reason = @manualReason,
              updated_at = @updatedAt
            WHERE id = @id
          `,
        )
        .run({
          id: job.id,
          supplierOrderNo: payload.supplierOrderNo || job.currentSupplierOrderNo,
          supplierStatus: payload.supplierStatus,
          taskStatus: nextTaskStatus,
          errorMessage: normalized.mappedStatus === 'failed' ? normalized.detail : null,
          resultDetail: normalized.detail,
          lastCallbackAt: now,
          manualReason: normalized.mappedStatus === 'failed' ? '供应商回执失败' : null,
          updatedAt: now,
        });

      if (normalized.mappedStatus === 'success') {
        this.db
          .prepare(
            `
              UPDATE orders
              SET
                order_status = 'completed',
                delivery_status = 'delivered',
                main_status = CASE
                  WHEN after_sale_status = 'processing' THEN 'after_sale'
                  ELSE 'completed'
                END,
                shipped_at = COALESCE(shipped_at, @shippedAt),
                completed_at = COALESCE(completed_at, @completedAt),
                updated_at = @updatedAt,
                delivery_hours = CASE
                  WHEN paid_at IS NULL THEN delivery_hours
                  ELSE ROUND((julianday(@updatedAt) - julianday(paid_at)) * 24, 1)
                END
              WHERE id = @id
            `,
          )
          .run({
            id: job.orderId,
            shippedAt: now,
            completedAt: now,
            updatedAt: now,
          });

        this.appendOrderEvent(
          job.orderId,
          'direct_charge_success',
          '直充回调成功',
          `${supplier.supplierName} 已确认到账，任务号 ${payload.taskNo}。`,
          '直充发货引擎',
          now,
        );
      } else if (normalized.mappedStatus === 'processing') {
        this.db
          .prepare(
            `
              UPDATE orders
              SET
                order_status = 'shipped',
                delivery_status = 'shipped',
                main_status = 'processing',
                shipped_at = COALESCE(shipped_at, @shippedAt),
                updated_at = @updatedAt
              WHERE id = @id
            `,
          )
          .run({
            id: job.orderId,
            shippedAt: now,
            updatedAt: now,
          });

        this.appendOrderEvent(
          job.orderId,
          'direct_charge_processing',
          '直充任务处理中',
          `${supplier.supplierName} 返回处理中状态，等待后续回执。`,
          '直充发货引擎',
          now,
        );
      } else {
        this.db
          .prepare(
            `
              UPDATE orders
              SET
                order_status = 'pending_shipment',
                delivery_status = 'manual_review',
                main_status = 'processing',
                updated_at = @updatedAt
              WHERE id = @id
            `,
          )
          .run({
            id: job.orderId,
            updatedAt: now,
          });

        this.appendOrderEvent(
          job.orderId,
          'direct_charge_failed',
          '直充回调失败',
          `${supplier.supplierName} 返回失败回执，任务已转人工处理。`,
          '直充发货引擎',
          now,
        );
      }

      this.upsertDirectChargeReconciliation(
        job.id,
        supplier.id,
        job.orderId,
        reconcileStatus,
        payload.supplierStatus,
        normalized.mappedStatus,
        normalized.detail,
        now,
      );
    })();

    this.insertWorkspaceLog(
      'distribution-supply',
      verified ? 'callback' : 'callback_rejected',
      verified ? `${supplier.supplierName} 回调已处理` : `${supplier.supplierName} 回调验签失败`,
      verified
        ? `任务号 ${payload.taskNo} 已映射为 ${normalized.mappedStatus}。`
        : `任务号 ${payload.taskNo} 未通过回调验签，已记录异常。`,
    );
    this.touchWorkspace('distribution-source', now);
    this.touchWorkspace('distribution-supply', now);

    return {
      accepted: verified,
      verificationStatus,
      mappedStatus: verified ? normalized.mappedStatus : null,
      taskStatus: job
        ? verified
          ? normalized.mappedStatus === 'success'
            ? 'success'
            : normalized.mappedStatus === 'failed'
              ? 'failed'
              : 'processing'
          : 'manual_review'
        : 'manual_review',
    };
  }

  private getSupplySourceSystemContext(systemId: number) {
    return this.db
      .prepare(
        `
          SELECT
            id,
            system_key AS systemKey,
            system_name AS systemName,
            adapter_key AS adapterKey,
            callback_token AS callbackToken,
            enabled,
            system_status AS systemStatus,
            sync_mode AS syncMode,
            sync_interval_minutes AS syncIntervalMinutes,
            order_push_enabled AS orderPushEnabled,
            refund_callback_enabled AS refundCallbackEnabled
          FROM supply_source_systems
          WHERE id = ?
        `,
      )
      .get(systemId) as
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

  private getSupplySourceOrderContext(sourceOrderId: number) {
    return this.db
      .prepare(
        `
          SELECT
            sso.id,
            sso.system_id AS systemId,
            sso.mapping_id AS mappingId,
            sso.order_id AS orderId,
            sso.task_no AS taskNo,
            sso.source_order_no AS sourceOrderNo,
            sso.order_status AS orderStatus,
            sso.source_status AS sourceStatus,
            sso.verification_status AS verificationStatus,
            sso.retry_count AS retryCount,
            sso.max_retry AS maxRetry,
            sso.failure_reason AS failureReason,
            sso.result_detail AS resultDetail,
            sso.pushed_at AS pushedAt,
            sso.callback_at AS callbackAt,
            sss.system_key AS systemKey,
            sss.system_name AS systemName,
            sss.adapter_key AS adapterKey,
            sss.callback_token AS callbackToken,
            sss.enabled AS systemEnabled,
            sss.system_status AS systemStatus,
            sss.order_push_enabled AS orderPushEnabled,
            ssp.external_product_id AS externalProductId,
            ssp.external_product_name AS externalProductName,
            ssp.platform_product_name AS platformProductName,
            ssp.enabled AS mappingEnabled,
            o.order_no AS orderNo,
            o.quantity,
            o.paid_amount AS paidAmount,
            o.store_id AS storeId,
            st.name AS storeName
          FROM supply_source_orders sso
          INNER JOIN supply_source_systems sss ON sss.id = sso.system_id
          INNER JOIN supply_source_products ssp ON ssp.id = sso.mapping_id
          INNER JOIN orders o ON o.id = sso.order_id
          LEFT JOIN stores st ON st.id = o.store_id
          WHERE sso.id = ?
        `,
      )
      .get(sourceOrderId) as
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

  private upsertSupplySourceReconciliation(input: {
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
  }) {
    this.db
      .prepare(
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
            @systemId,
            @mappingId,
            @orderId,
            @reconcileType,
            @reconcileNo,
            @platformRef,
            @sourceRef,
            @platformPrice,
            @sourcePrice,
            @platformStock,
            @sourceStock,
            @platformAmount,
            @sourceAmount,
            @diffAmount,
            @reconcileStatus,
            @detail,
            @createdAt,
            @updatedAt
          )
          ON CONFLICT(reconcile_no) DO UPDATE SET
            mapping_id = excluded.mapping_id,
            order_id = excluded.order_id,
            platform_ref = excluded.platform_ref,
            source_ref = excluded.source_ref,
            platform_price = excluded.platform_price,
            source_price = excluded.source_price,
            platform_stock = excluded.platform_stock,
            source_stock = excluded.source_stock,
            platform_amount = excluded.platform_amount,
            source_amount = excluded.source_amount,
            diff_amount = excluded.diff_amount,
            reconcile_status = excluded.reconcile_status,
            detail = excluded.detail,
            updated_at = excluded.updated_at
        `,
      )
      .run({
        systemId: input.systemId,
        mappingId: input.mappingId ?? null,
        orderId: input.orderId ?? null,
        reconcileType: input.reconcileType,
        reconcileNo: input.reconcileNo,
        platformRef: input.platformRef,
        sourceRef: input.sourceRef,
        platformPrice: input.platformPrice ?? null,
        sourcePrice: input.sourcePrice ?? null,
        platformStock: input.platformStock ?? null,
        sourceStock: input.sourceStock ?? null,
        platformAmount: input.platformAmount ?? null,
        sourceAmount: input.sourceAmount ?? null,
        diffAmount: input.diffAmount,
        reconcileStatus: input.reconcileStatus,
        detail: input.detail,
        createdAt: input.now,
        updatedAt: input.now,
      });
  }

  private runSupplySourceSyncInternal(
    featureKey: string,
    systemId: number,
    syncType: SupplySourceSyncType,
    runMode: SupplySourceSyncMode,
    now: string,
    options: {
      applyPlatformUpdates?: boolean;
    } = {},
  ) {
    const system = this.getSupplySourceSystemContext(systemId);
    if (!system) {
      return null;
    }

    const mappings = this.db
      .prepare(
        `
          SELECT
            ssp.id,
            ssp.external_product_id AS externalProductId,
            ssp.external_sku AS externalSku,
            ssp.external_product_name AS externalProductName,
            ssp.platform_product_id AS platformProductId,
            ssp.platform_product_name AS platformProductName,
            ssp.category,
            ssp.sale_price AS salePrice,
            p.stock AS platformStock
          FROM supply_source_products ssp
          INNER JOIN products p ON p.id = ssp.platform_product_id
          WHERE ssp.system_id = ?
          ORDER BY ssp.id ASC
        `,
      )
      .all(systemId) as Array<{
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

    const createRun = (input: {
      runStatus: SupplySourceSyncRunStatus;
      totalCount: number;
      successCount: number;
      failureCount: number;
      detail: string;
    }) => {
      const result = this.db
        .prepare(
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
              @systemId,
              @syncType,
              @runMode,
              @runStatus,
              @totalCount,
              @successCount,
              @failureCount,
              @detail,
              @createdAt,
              @finishedAt
            )
          `,
        )
        .run({
          systemId,
          syncType,
          runMode,
          runStatus: input.runStatus,
          totalCount: input.totalCount,
          successCount: input.successCount,
          failureCount: input.failureCount,
          detail: input.detail,
          createdAt: now,
          finishedAt: now,
        });

      return Number(result.lastInsertRowid);
    };

    const syncTypeText =
      syncType === 'product' ? '商品主数据' : syncType === 'inventory' ? '库存' : '价格';
    const failSync = (detail: string, runStatus: SupplySourceSyncRunStatus = 'failed') => {
      const runId = createRun({
        runStatus,
        totalCount: mappings.length,
        successCount: 0,
        failureCount: mappings.length,
        detail,
      });

      this.insertWorkspaceLog(
        featureKey,
        'source_sync_failed',
        `${system.systemName}${syncTypeText}同步失败`,
        detail,
      );
      this.touchWorkspace(featureKey, now);

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
      return failSync('当前系统未绑定任何货源商品映射，无法执行同步。');
    }

    if (!system.enabled || system.systemStatus === 'offline') {
      return failSync('货源系统未启用或当前离线，无法执行同步。');
    }

    const adapter = getSupplySourceAdapter(system.adapterKey);
    if (!adapter) {
      return failSync('货源适配器不存在，无法执行同步。');
    }

    const syncResult = adapter.syncProducts(
      syncType,
      mappings.map((item) => ({
        externalProductId: item.externalProductId,
        externalSku: item.externalSku,
        externalProductName: item.externalProductName,
        category: item.category,
        mappedProductName: item.platformProductName,
        salePrice: item.salePrice,
        platformStock: item.platformStock,
      })),
    );
    const successCount = syncResult.items.filter((item) => item.syncStatus === 'synced').length;
    const failureCount = syncResult.items.length - successCount;
    const runStatus: SupplySourceSyncRunStatus =
      failureCount === 0 ? 'success' : successCount === 0 ? 'failed' : 'partial';
    const applyPlatformUpdates = options.applyPlatformUpdates ?? true;

    const runId = this.db.transaction(() => {
      syncResult.items.forEach((item) => {
        const mapping = mappings.find((entry) => entry.externalProductId === item.externalProductId);
        if (!mapping) {
          return;
        }

        this.db
          .prepare(
            `
              UPDATE supply_source_products
              SET
                source_price = @sourcePrice,
                source_stock = @sourceStock,
                sync_status = @syncStatus,
                last_sync_at = @lastSyncAt,
                updated_at = @updatedAt
              WHERE id = @id
            `,
          )
          .run({
            id: mapping.id,
            sourcePrice: item.sourcePrice,
            sourceStock: item.sourceStock,
            syncStatus: item.syncStatus,
            lastSyncAt: now,
            updatedAt: now,
          });

        if (applyPlatformUpdates) {
          this.db
            .prepare(
              `
                UPDATE products
                SET
                  cost = CASE
                    WHEN @syncType IN ('product', 'price') THEN @sourcePrice
                    ELSE cost
                  END,
                  stock = CASE
                    WHEN @syncType IN ('product', 'inventory') THEN @sourceStock
                    ELSE stock
                  END
                WHERE id = @id
              `,
            )
            .run({
              id: mapping.platformProductId,
              syncType,
              sourcePrice: item.sourcePrice,
              sourceStock: item.sourceStock,
            });
        }

        const diffAmount =
          syncType === 'inventory'
            ? Number((mapping.platformStock - item.sourceStock).toFixed(2))
            : Number((mapping.salePrice - item.sourcePrice).toFixed(2));
        const reconcileStatus: SupplySourceReconcileStatus =
          item.syncStatus === 'synced'
            ? 'matched'
            : item.syncStatus === 'warning'
              ? 'pending'
              : 'anomaly';

        this.upsertSupplySourceReconciliation({
          systemId,
          mappingId: mapping.id,
          reconcileType: syncType,
          reconcileNo: `SSR-${syncType.toUpperCase()}-${mapping.id}`,
          platformRef: mapping.platformProductName,
          sourceRef: item.externalProductId,
          platformPrice: mapping.salePrice,
          sourcePrice: item.sourcePrice,
          platformStock: mapping.platformStock,
          sourceStock: item.sourceStock,
          diffAmount,
          reconcileStatus,
          detail: item.detail,
          now,
        });
      });

      this.db
        .prepare(
          `
            UPDATE supply_source_systems
            SET
              system_status = @systemStatus,
              updated_at = @updatedAt,
              last_product_sync_at = CASE
                WHEN @syncType = 'product' THEN @lastSyncedAt
                ELSE last_product_sync_at
              END,
              last_inventory_sync_at = CASE
                WHEN @syncType = 'inventory' THEN @lastSyncedAt
                ELSE last_inventory_sync_at
              END,
              last_price_sync_at = CASE
                WHEN @syncType = 'price' THEN @lastSyncedAt
                ELSE last_price_sync_at
              END
            WHERE id = @id
          `,
        )
        .run({
          id: systemId,
          syncType,
          lastSyncedAt: now,
          updatedAt: now,
          systemStatus: runStatus === 'success' ? 'online' : 'warning',
        });

      return createRun({
        runStatus,
        totalCount: syncResult.items.length,
        successCount,
        failureCount,
        detail: syncResult.detail,
      });
    })();

    this.insertWorkspaceLog(
      featureKey,
      'source_sync',
      `${system.systemName}${syncTypeText}同步已执行`,
      `${syncResult.detail} 成功 ${successCount} 条，异常 ${failureCount} 条。`,
    );
    this.touchWorkspace(featureKey, now);

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

  toggleSupplySourceSystemStatus(featureKey: string, systemId: number) {
    if (featureKey !== 'distribution-source') {
      return null;
    }

    const system = this.db
      .prepare(
        `
          SELECT
            id,
            system_name AS systemName,
            enabled
          FROM supply_source_systems
          WHERE id = ?
        `,
      )
      .get(systemId) as
      | {
          id: number;
          systemName: string;
          enabled: number;
        }
      | undefined;

    if (!system) {
      return null;
    }

    const nextEnabled = system.enabled ? 0 : 1;
    const nextStatus: SupplySourceSystemStatus = nextEnabled
      ? system.id === 1
        ? 'online'
        : 'warning'
      : 'offline';
    const now = format(new Date(), 'yyyy-MM-dd HH:mm:ss');

    this.db
      .prepare(
        `
          UPDATE supply_source_systems
          SET
            enabled = @enabled,
            system_status = @systemStatus,
            updated_at = @updatedAt
          WHERE id = @id
        `,
      )
      .run({
        id: systemId,
        enabled: nextEnabled,
        systemStatus: nextStatus,
        updatedAt: now,
      });

    this.insertWorkspaceLog(
      featureKey,
      'source_system_status',
      `${system.systemName}${nextEnabled ? '已启用' : '已停用'}`,
      nextEnabled ? '货源系统已重新加入同步与推单链路。' : '货源系统已从同步与推单链路中移除。',
    );
    this.touchWorkspace(featureKey, now);
    this.touchWorkspace('distribution-supply', now);

    return {
      enabled: Boolean(nextEnabled),
      systemStatus: nextStatus,
    };
  }

  rotateSupplySourceSystemToken(featureKey: string, systemId: number) {
    if (featureKey !== 'distribution-source') {
      return null;
    }

    const system = this.db
      .prepare(
        `
          SELECT id, system_name AS systemName
          FROM supply_source_systems
          WHERE id = ?
        `,
      )
      .get(systemId) as { id: number; systemName: string } | undefined;

    if (!system) {
      return null;
    }

    const nextToken = `sst-${randomUUID().replace(/-/g, '').slice(0, 20)}`;
    const maskedToken = maskSecret(nextToken);
    const now = format(new Date(), 'yyyy-MM-dd HH:mm:ss');

    this.db
      .prepare(
        `
          UPDATE supply_source_systems
          SET
            callback_token = @callbackToken,
            callback_token_masked = @callbackTokenMasked,
            updated_at = @updatedAt
          WHERE id = @id
        `,
      )
      .run({
        id: systemId,
        callbackToken: nextToken,
        callbackTokenMasked: maskedToken,
        updatedAt: now,
      });

    this.insertWorkspaceLog(
      featureKey,
      'source_system_token',
      `${system.systemName} 已轮换回调令牌`,
      '旧令牌已失效，后续发货回调与退款通知必须改用新令牌。',
    );
    this.touchWorkspace(featureKey, now);

    return {
      systemId,
      callbackTokenMasked: maskedToken,
      rotatedAt: now,
    };
  }

  runSupplySourceSync(featureKey: string, systemId: number, syncType: SupplySourceSyncType) {
    if (featureKey !== 'distribution-source') {
      return null;
    }

    const now = format(new Date(), 'yyyy-MM-dd HH:mm:ss');
    return this.runSupplySourceSyncInternal(featureKey, systemId, syncType, 'manual', now);
  }

  retrySupplySourceSyncRun(featureKey: string, runId: number) {
    if (featureKey !== 'distribution-source') {
      return null;
    }

    const run = this.db
      .prepare(
        `
          SELECT
            id,
            system_id AS systemId,
            sync_type AS syncType
          FROM supply_source_sync_runs
          WHERE id = ?
        `,
      )
      .get(runId) as
      | {
          id: number;
          systemId: number;
          syncType: SupplySourceSyncType;
        }
      | undefined;

    if (!run) {
      return null;
    }

    const now = format(new Date(), 'yyyy-MM-dd HH:mm:ss');
    return this.runSupplySourceSyncInternal(featureKey, run.systemId, run.syncType, 'manual', now);
  }

  private dispatchSupplySourceOrderInternal(sourceOrderId: number, now: string, retry = false) {
    const context = this.getSupplySourceOrderContext(sourceOrderId);
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
        detail: context.resultDetail ?? '货源订单已完成。',
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
        detail: context.resultDetail ?? '货源订单仍在处理中。',
        pushedAt: context.pushedAt,
      };
    }

    const failDispatch = (errorMessage: string) => {
      this.db
        .prepare(
          `
            UPDATE supply_source_orders
            SET
              order_status = 'manual_review',
              failure_reason = @failureReason,
              result_detail = @resultDetail,
              updated_at = @updatedAt
            WHERE id = @id
          `,
        )
        .run({
          id: context.id,
          failureReason: errorMessage,
          resultDetail: errorMessage,
          updatedAt: now,
        });

      this.db
        .prepare(
          `
            UPDATE orders
            SET
              order_status = 'pending_shipment',
              delivery_status = 'manual_review',
              main_status = 'processing',
              updated_at = @updatedAt
            WHERE id = @id
          `,
        )
        .run({
          id: context.orderId,
          updatedAt: now,
        });

      this.appendOrderEvent(
        context.orderId,
        'source_supply_manual_review',
        '货源订单转人工',
        errorMessage,
        '自有货源系统',
        now,
      );
      this.upsertSupplySourceReconciliation({
        systemId: context.systemId,
        mappingId: context.mappingId,
        orderId: context.orderId,
        reconcileType: 'order',
        reconcileNo: `SSR-ORDER-${context.id}`,
        platformRef: context.orderNo,
        sourceRef: context.sourceOrderNo ?? context.taskNo,
        platformAmount: context.paidAmount,
        sourceAmount: context.paidAmount,
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
      return failDispatch('货源系统未启用、离线或未开启推单，任务已转人工处理。');
    }

    if (!context.mappingEnabled) {
      return failDispatch('货源商品映射未启用，任务已转人工处理。');
    }

    const adapter = getSupplySourceAdapter(context.adapterKey);
    if (!adapter) {
      return failDispatch('货源适配器不存在，无法执行推单。');
    }

    const dispatchResult = adapter.dispatchOrder({
      taskNo: context.taskNo,
      orderNo: context.orderNo,
      productTitle: context.platformProductName,
      quantity: context.quantity,
      paidAmount: context.paidAmount,
      targetStoreName: context.storeName ?? `店铺 ${context.storeId}`,
    });

    this.db.transaction(() => {
      this.db
        .prepare(
          `
            UPDATE supply_source_orders
            SET
              source_order_no = @sourceOrderNo,
              source_status = @sourceStatus,
              order_status = 'processing',
              verification_status = 'pending',
              retry_count = CASE
                WHEN @retry = 1 THEN retry_count + 1
                ELSE retry_count
              END,
              failure_reason = NULL,
              result_detail = @resultDetail,
              pushed_at = @pushedAt,
              updated_at = @updatedAt
            WHERE id = @id
          `,
        )
        .run({
          id: context.id,
          sourceOrderNo: dispatchResult.sourceOrderNo,
          sourceStatus: dispatchResult.sourceStatus,
          retry: retry ? 1 : 0,
          resultDetail: dispatchResult.detail,
          pushedAt: now,
          updatedAt: now,
        });

      this.db
        .prepare(
          `
            UPDATE supply_source_systems
            SET
              last_order_push_at = @lastOrderPushAt,
              updated_at = @updatedAt
            WHERE id = @id
          `,
        )
        .run({
          id: context.systemId,
          lastOrderPushAt: now,
          updatedAt: now,
        });

      this.db
        .prepare(
          `
            UPDATE orders
            SET
              order_status = 'shipped',
              delivery_status = 'shipped',
              main_status = 'processing',
              shipped_at = COALESCE(shipped_at, @shippedAt),
              updated_at = @updatedAt
            WHERE id = @id
          `,
        )
        .run({
          id: context.orderId,
          shippedAt: now,
          updatedAt: now,
        });

      this.appendOrderEvent(
        context.orderId,
        retry ? 'source_supply_redispatch' : 'source_supply_dispatch',
        retry ? '货源订单已重推' : '货源订单已推送',
        `${context.systemName} 已受理任务 ${context.taskNo}。`,
        '自有货源系统',
        now,
      );
      this.upsertSupplySourceReconciliation({
        systemId: context.systemId,
        mappingId: context.mappingId,
        orderId: context.orderId,
        reconcileType: 'order',
        reconcileNo: `SSR-ORDER-${context.id}`,
        platformRef: context.orderNo,
        sourceRef: dispatchResult.sourceOrderNo,
        platformAmount: context.paidAmount,
        sourceAmount: context.paidAmount,
        diffAmount: 0,
        reconcileStatus: 'pending',
        detail: dispatchResult.detail,
        now,
      });
    })();

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

  dispatchSupplySourceOrder(featureKey: string, sourceOrderId: number) {
    if (featureKey !== 'distribution-supply') {
      return null;
    }

    const now = format(new Date(), 'yyyy-MM-dd HH:mm:ss');
    const context = this.getSupplySourceOrderContext(sourceOrderId);
    if (!context) {
      return null;
    }

    const result = this.dispatchSupplySourceOrderInternal(sourceOrderId, now, false);
    if (!result) {
      return null;
    }

    this.insertWorkspaceLog(
      featureKey,
      result.success ? 'source_order_dispatch' : 'source_order_dispatch_failed',
      result.success ? `任务 ${context.taskNo} 已推单` : `任务 ${context.taskNo} 推单失败`,
      result.success
        ? 'detail' in result
          ? result.detail ?? '货源订单已进入处理中。'
          : '货源订单已进入处理中。'
        : 'errorMessage' in result
          ? result.errorMessage ?? '系统未返回失败原因。'
          : '系统未返回失败原因。',
    );
    this.touchWorkspace(featureKey, now);

    return result;
  }

  retrySupplySourceOrder(featureKey: string, sourceOrderId: number) {
    if (featureKey !== 'distribution-supply') {
      return null;
    }

    const now = format(new Date(), 'yyyy-MM-dd HH:mm:ss');
    const context = this.getSupplySourceOrderContext(sourceOrderId);
    if (!context) {
      return null;
    }

    const result = this.dispatchSupplySourceOrderInternal(sourceOrderId, now, true);
    if (!result) {
      return null;
    }

    this.insertWorkspaceLog(
      featureKey,
      result.success ? 'source_order_retry' : 'source_order_retry_failed',
      result.success ? `任务 ${context.taskNo} 已重试推单` : `任务 ${context.taskNo} 重试失败`,
      result.success
        ? 'detail' in result
          ? result.detail ?? '货源订单已重新进入处理中。'
          : '货源订单已重新进入处理中。'
        : 'errorMessage' in result
          ? result.errorMessage ?? '系统未返回失败原因。'
          : '系统未返回失败原因。',
    );
    this.touchWorkspace(featureKey, now);

    return result;
  }

  markSupplySourceOrderManualReview(featureKey: string, sourceOrderId: number, reason: string) {
    if (featureKey !== 'distribution-supply') {
      return null;
    }

    const context = this.getSupplySourceOrderContext(sourceOrderId);
    if (!context || context.orderStatus === 'success') {
      return null;
    }

    const now = format(new Date(), 'yyyy-MM-dd HH:mm:ss');

    this.db
      .prepare(
        `
          UPDATE supply_source_orders
          SET
            order_status = 'manual_review',
            failure_reason = @failureReason,
            result_detail = @resultDetail,
            updated_at = @updatedAt
          WHERE id = @id
        `,
      )
      .run({
        id: sourceOrderId,
        failureReason: reason,
        resultDetail: reason,
        updatedAt: now,
      });

    this.db
      .prepare(
        `
          UPDATE orders
          SET
            order_status = 'pending_shipment',
            delivery_status = 'manual_review',
            main_status = 'processing',
            updated_at = @updatedAt
          WHERE id = @id
        `,
      )
      .run({
        id: context.orderId,
        updatedAt: now,
      });

    this.appendOrderEvent(
      context.orderId,
      'source_supply_manual_review',
      '货源订单人工接管',
      reason,
      '自有货源系统',
      now,
    );
    this.upsertSupplySourceReconciliation({
      systemId: context.systemId,
      mappingId: context.mappingId,
      orderId: context.orderId,
      reconcileType: 'order',
      reconcileNo: `SSR-ORDER-${context.id}`,
      platformRef: context.orderNo,
      sourceRef: context.sourceOrderNo ?? context.taskNo,
      platformAmount: context.paidAmount,
      sourceAmount: context.paidAmount,
      diffAmount: 0,
      reconcileStatus: 'anomaly',
      detail: reason,
      now,
    });

    this.insertWorkspaceLog(
      featureKey,
      'source_order_manual_review',
      `任务 ${context.taskNo} 已转人工处理`,
      reason,
    );
    this.touchWorkspace(featureKey, now);

    return {
      success: true,
      orderStatus: 'manual_review' as const,
      reason,
    };
  }

  private ensureSupplySourceRefundCase(
    orderId: number,
    detail: string,
    mappedStatus: Exclude<SupplySourceRefundStatus, 'failed'>,
    now: string,
  ) {
    const order = this.db
      .prepare(
        `
          SELECT
            id,
            order_no AS orderNo,
            paid_amount AS paidAmount
          FROM orders
          WHERE id = ?
        `,
      )
      .get(orderId) as
      | {
          id: number;
          orderNo: string;
          paidAmount: number;
        }
      | undefined;

    if (!order) {
      return null;
    }

    const existingCase = this.db
      .prepare(
        `
          SELECT id, case_no AS caseNo
          FROM after_sale_cases
          WHERE order_id = ?
            AND case_type = 'refund'
          ORDER BY id DESC
          LIMIT 1
        `,
      )
      .get(orderId) as
      | {
          id: number;
          caseNo: string;
        }
      | undefined;

    const caseStatus = mappedStatus === 'resolved' ? 'resolved' : 'processing';
    const refundStatus = mappedStatus === 'resolved' ? 'refunded' : 'approved';
    const title = mappedStatus === 'resolved' ? '货源退款已完成' : '货源退款处理中';
    const latestResult =
      mappedStatus === 'resolved'
        ? `货源系统已完成退款：${detail}`
        : `货源系统已接收退款通知：${detail}`;
    let caseId = existingCase?.id ?? null;
    let caseNo = existingCase?.caseNo ?? null;

    if (!existingCase) {
      caseNo = `ASR${format(new Date(), 'yyyyMMddHHmmss')}${String(orderId).padStart(4, '0')}`;
      const inserted = this.db
        .prepare(
          `
            INSERT INTO after_sale_cases (
              case_no,
              order_id,
              case_type,
              case_status,
              priority,
              source_channel,
              reason,
              customer_request,
              expectation,
              latest_result,
              sla_deadline_at,
              created_at,
              updated_at,
              closed_at
            ) VALUES (
              @caseNo,
              @orderId,
              'refund',
              @caseStatus,
              'high',
              'source_system',
              '货源系统退款通知',
              '同步货源退款结果',
              '保证平台订单与货源退款状态一致',
              @latestResult,
              @slaDeadlineAt,
              @createdAt,
              @updatedAt,
              @closedAt
            )
          `,
        )
        .run({
          caseNo,
          orderId,
          caseStatus,
          latestResult,
          slaDeadlineAt: format(addDays(new Date(now.replace(' ', 'T')), 1), 'yyyy-MM-dd HH:mm:ss'),
          createdAt: now,
          updatedAt: now,
          closedAt: mappedStatus === 'resolved' ? now : null,
        });
      caseId = Number(inserted.lastInsertRowid);

      this.db
        .prepare(
          `
            INSERT INTO after_sale_refunds (
              case_id,
              refund_no,
              requested_amount,
              approved_amount,
              refund_status,
              review_note,
              reviewed_by,
              reviewed_at,
              refunded_at
            ) VALUES (
              @caseId,
              @refundNo,
              @requestedAmount,
              @approvedAmount,
              @refundStatus,
              @reviewNote,
              @reviewedBy,
              @reviewedAt,
              @refundedAt
            )
          `,
        )
        .run({
          caseId,
          refundNo: `RF${caseNo}`,
          requestedAmount: order.paidAmount,
          approvedAmount: order.paidAmount,
          refundStatus,
          reviewNote: detail,
          reviewedBy: '自有货源系统',
          reviewedAt: now,
          refundedAt: mappedStatus === 'resolved' ? now : null,
        });
    } else {
      this.db
        .prepare(
          `
            UPDATE after_sale_cases
            SET
              case_status = @caseStatus,
              latest_result = @latestResult,
              updated_at = @updatedAt,
              closed_at = @closedAt
            WHERE id = @id
          `,
        )
        .run({
          id: existingCase.id,
          caseStatus,
          latestResult,
          updatedAt: now,
          closedAt: mappedStatus === 'resolved' ? now : null,
        });

      const refund = this.db
        .prepare(
          `
            SELECT id
            FROM after_sale_refunds
            WHERE case_id = ?
          `,
        )
        .get(existingCase.id) as { id: number } | undefined;

      if (refund) {
        this.db
          .prepare(
            `
              UPDATE after_sale_refunds
              SET
                requested_amount = @requestedAmount,
                approved_amount = @approvedAmount,
                refund_status = @refundStatus,
                review_note = @reviewNote,
                reviewed_by = @reviewedBy,
                reviewed_at = @reviewedAt,
                refunded_at = @refundedAt
              WHERE case_id = @caseId
            `,
          )
          .run({
            caseId: existingCase.id,
            requestedAmount: order.paidAmount,
            approvedAmount: order.paidAmount,
            refundStatus,
            reviewNote: detail,
            reviewedBy: '自有货源系统',
            reviewedAt: now,
            refundedAt: mappedStatus === 'resolved' ? now : null,
          });
      } else {
        this.db
          .prepare(
            `
              INSERT INTO after_sale_refunds (
                case_id,
                refund_no,
                requested_amount,
                approved_amount,
                refund_status,
                review_note,
                reviewed_by,
                reviewed_at,
                refunded_at
              ) VALUES (
                @caseId,
                @refundNo,
                @requestedAmount,
                @approvedAmount,
                @refundStatus,
                @reviewNote,
                @reviewedBy,
                @reviewedAt,
                @refundedAt
              )
            `,
          )
          .run({
            caseId: existingCase.id,
            refundNo: `RF${existingCase.caseNo}`,
            requestedAmount: order.paidAmount,
            approvedAmount: order.paidAmount,
            refundStatus,
            reviewNote: detail,
            reviewedBy: '自有货源系统',
            reviewedAt: now,
            refundedAt: mappedStatus === 'resolved' ? now : null,
          });
      }
    }

    if (!caseId || !caseNo) {
      return null;
    }

    this.appendAfterSaleRecord(
      caseId,
      mappedStatus === 'resolved' ? 'source_refund_resolved' : 'source_refund_processing',
      title,
      detail,
      '自有货源系统',
      now,
    );
    this.appendOrderEvent(
      orderId,
      mappedStatus === 'resolved' ? 'source_supply_refund_resolved' : 'source_supply_refund_processing',
      title,
      `${caseNo}：${detail}`,
      '自有货源系统',
      now,
    );
    this.syncOrderAfterSaleState(orderId, now, mappedStatus === 'resolved' ? order.paidAmount : undefined);
    this.refreshAfterSaleReminders(caseId, now);

    return {
      caseId,
      caseNo,
      orderNo: order.orderNo,
    };
  }

  processSupplySourceCallback(systemKey: string, payload: SupplySourceCallbackPayload) {
    const system = this.db
      .prepare(
        `
          SELECT
            id,
            system_key AS systemKey,
            system_name AS systemName,
            adapter_key AS adapterKey,
            callback_token AS callbackToken
          FROM supply_source_systems
          WHERE system_key = ?
        `,
      )
      .get(systemKey) as
      | {
          id: number;
          systemKey: string;
          systemName: string;
          adapterKey: string;
          callbackToken: string;
        }
      | undefined;

    if (!system) {
      return null;
    }

    const adapter = getSupplySourceAdapter(system.adapterKey);
    const now = format(new Date(), 'yyyy-MM-dd HH:mm:ss');
    const callbackNo = `SSC-${format(new Date(), 'yyyyMMddHHmmss')}-${randomUUID().slice(0, 6).toUpperCase()}`;
    const sourceOrder = this.db
      .prepare(
        `
          SELECT
            sso.id,
            sso.order_id AS orderId,
            sso.mapping_id AS mappingId,
            sso.source_order_no AS currentSourceOrderNo,
            sso.order_status AS orderStatus,
            o.order_no AS orderNo,
            o.paid_amount AS paidAmount
          FROM supply_source_orders sso
          INNER JOIN orders o ON o.id = sso.order_id
          WHERE sso.system_id = @systemId
            AND sso.task_no = @taskNo
          LIMIT 1
        `,
      )
      .get({
        systemId: system.id,
        taskNo: payload.taskNo,
      }) as
      | {
          id: number;
          orderId: number;
          mappingId: number;
          currentSourceOrderNo: string | null;
          orderStatus: SupplySourceOrderStatus;
          orderNo: string;
          paidAmount: number;
        }
      | undefined;

    if (!adapter) {
      return {
        accepted: false,
        verificationStatus: 'failed' as const,
        mappedStatus: null,
        orderStatus: sourceOrder?.orderStatus ?? 'manual_review',
      };
    }

    const verified = adapter.verifyCallbackToken(payload.token, system.callbackToken);
    const normalized = adapter.normalizeCallback(payload);
    const verificationStatus: SupplySourceVerificationStatus = verified ? 'passed' : 'failed';
    const callbackDetail = verified
      ? normalized.detail
      : payload.detail?.trim() || '货源回调验签失败，任务已记录为异常。';

    this.db.transaction(() => {
      this.db
        .prepare(
          `
            INSERT INTO supply_source_callbacks (
              system_id,
              supply_order_id,
              order_id,
              callback_no,
              task_no,
              source_order_no,
              source_status,
              verification_status,
              mapped_status,
              detail,
              received_at
            ) VALUES (
              @systemId,
              @supplyOrderId,
              @orderId,
              @callbackNo,
              @taskNo,
              @sourceOrderNo,
              @sourceStatus,
              @verificationStatus,
              @mappedStatus,
              @detail,
              @receivedAt
            )
          `,
        )
        .run({
          systemId: system.id,
          supplyOrderId: sourceOrder?.id ?? null,
          orderId: sourceOrder?.orderId ?? null,
          callbackNo,
          taskNo: payload.taskNo,
          sourceOrderNo: payload.sourceOrderNo,
          sourceStatus: payload.sourceStatus,
          verificationStatus,
          mappedStatus: verified ? normalized.mappedStatus : null,
          detail: callbackDetail,
          receivedAt: now,
        });

      this.db
        .prepare(
          `
            UPDATE supply_source_systems
            SET
              last_callback_at = @lastCallbackAt,
              updated_at = @updatedAt
            WHERE id = @id
          `,
        )
        .run({
          id: system.id,
          lastCallbackAt: now,
          updatedAt: now,
        });

      if (!sourceOrder) {
        return;
      }

      if (!verified) {
        this.db
          .prepare(
            `
              UPDATE supply_source_orders
              SET
                order_status = 'manual_review',
                source_status = @sourceStatus,
                verification_status = 'failed',
                failure_reason = @failureReason,
                result_detail = @resultDetail,
                callback_at = @callbackAt,
                updated_at = @updatedAt
              WHERE id = @id
            `,
          )
          .run({
            id: sourceOrder.id,
            sourceStatus: payload.sourceStatus,
            failureReason: callbackDetail,
            resultDetail: callbackDetail,
            callbackAt: now,
            updatedAt: now,
          });

        this.db
          .prepare(
            `
              UPDATE orders
              SET
                order_status = 'pending_shipment',
                delivery_status = 'manual_review',
                main_status = 'processing',
                updated_at = @updatedAt
              WHERE id = @id
            `,
          )
          .run({
            id: sourceOrder.orderId,
            updatedAt: now,
          });

        this.appendOrderEvent(
          sourceOrder.orderId,
          'source_supply_callback_rejected',
          '货源回调验签失败',
          `${system.systemName} 回调未通过验签，任务已转人工处理。`,
          '自有货源系统',
          now,
        );
        this.upsertSupplySourceReconciliation({
          systemId: system.id,
          mappingId: sourceOrder.mappingId,
          orderId: sourceOrder.orderId,
          reconcileType: 'order',
          reconcileNo: `SSR-ORDER-${sourceOrder.id}`,
          platformRef: sourceOrder.orderNo,
          sourceRef: payload.sourceOrderNo,
          platformAmount: sourceOrder.paidAmount,
          sourceAmount: sourceOrder.paidAmount,
          diffAmount: 0,
          reconcileStatus: 'anomaly',
          detail: callbackDetail,
          now,
        });
        return;
      }

      const nextOrderStatus: SupplySourceOrderStatus =
        normalized.mappedStatus === 'success'
          ? 'success'
          : normalized.mappedStatus === 'failed'
            ? 'failed'
            : 'processing';
      const reconcileStatus: SupplySourceReconcileStatus =
        normalized.mappedStatus === 'success'
          ? 'matched'
          : normalized.mappedStatus === 'failed'
            ? 'anomaly'
            : 'pending';

      this.db
        .prepare(
          `
            UPDATE supply_source_orders
            SET
              source_order_no = @sourceOrderNo,
              source_status = @sourceStatus,
              verification_status = 'passed',
              order_status = @orderStatus,
              failure_reason = @failureReason,
              result_detail = @resultDetail,
              callback_at = @callbackAt,
              updated_at = @updatedAt
            WHERE id = @id
          `,
        )
        .run({
          id: sourceOrder.id,
          sourceOrderNo: payload.sourceOrderNo || sourceOrder.currentSourceOrderNo,
          sourceStatus: payload.sourceStatus,
          orderStatus: nextOrderStatus,
          failureReason: normalized.mappedStatus === 'failed' ? normalized.detail : null,
          resultDetail: normalized.detail,
          callbackAt: now,
          updatedAt: now,
        });

      if (normalized.mappedStatus === 'success') {
        this.db
          .prepare(
            `
              UPDATE orders
              SET
                order_status = 'completed',
                delivery_status = 'delivered',
                main_status = CASE
                  WHEN after_sale_status = 'processing' THEN 'after_sale'
                  ELSE 'completed'
                END,
                shipped_at = COALESCE(shipped_at, @shippedAt),
                completed_at = COALESCE(completed_at, @completedAt),
                updated_at = @updatedAt,
                delivery_hours = CASE
                  WHEN paid_at IS NULL THEN delivery_hours
                  ELSE ROUND((julianday(@updatedAt) - julianday(paid_at)) * 24, 1)
                END
              WHERE id = @id
            `,
          )
          .run({
            id: sourceOrder.orderId,
            shippedAt: now,
            completedAt: now,
            updatedAt: now,
          });

        this.appendOrderEvent(
          sourceOrder.orderId,
          'source_supply_success',
          '货源发货完成',
          `${system.systemName} 已确认完成发货，任务号 ${payload.taskNo}。`,
          '自有货源系统',
          now,
        );
      } else if (normalized.mappedStatus === 'processing') {
        this.db
          .prepare(
            `
              UPDATE orders
              SET
                order_status = 'shipped',
                delivery_status = 'shipped',
                main_status = 'processing',
                shipped_at = COALESCE(shipped_at, @shippedAt),
                updated_at = @updatedAt
              WHERE id = @id
            `,
          )
          .run({
            id: sourceOrder.orderId,
            shippedAt: now,
            updatedAt: now,
          });

        this.appendOrderEvent(
          sourceOrder.orderId,
          'source_supply_processing',
          '货源订单处理中',
          `${system.systemName} 返回处理中状态，等待后续发货回执。`,
          '自有货源系统',
          now,
        );
      } else {
        this.db
          .prepare(
            `
              UPDATE orders
              SET
                order_status = 'pending_shipment',
                delivery_status = 'manual_review',
                main_status = 'processing',
                updated_at = @updatedAt
              WHERE id = @id
            `,
          )
          .run({
            id: sourceOrder.orderId,
            updatedAt: now,
          });

        this.appendOrderEvent(
          sourceOrder.orderId,
          'source_supply_failed',
          '货源发货失败',
          `${system.systemName} 返回失败回执，任务已转人工处理。`,
          '自有货源系统',
          now,
        );
      }

      this.upsertSupplySourceReconciliation({
        systemId: system.id,
        mappingId: sourceOrder.mappingId,
        orderId: sourceOrder.orderId,
        reconcileType: 'order',
        reconcileNo: `SSR-ORDER-${sourceOrder.id}`,
        platformRef: sourceOrder.orderNo,
        sourceRef: payload.sourceOrderNo,
        platformAmount: sourceOrder.paidAmount,
        sourceAmount: sourceOrder.paidAmount,
        diffAmount: 0,
        reconcileStatus,
        detail: normalized.detail,
        now,
      });
    })();

    this.insertWorkspaceLog(
      'distribution-supply',
      verified ? 'source_callback' : 'source_callback_rejected',
      verified ? `${system.systemName} 发货回调已处理` : `${system.systemName} 发货回调验签失败`,
      verified
        ? `任务号 ${payload.taskNo} 已映射为 ${normalized.mappedStatus}。`
        : `任务号 ${payload.taskNo} 未通过回调验签，已记录异常。`,
    );
    this.touchWorkspace('distribution-source', now);
    this.touchWorkspace('distribution-supply', now);

    return {
      accepted: verified,
      verificationStatus,
      mappedStatus: verified ? normalized.mappedStatus : null,
      orderStatus: sourceOrder
        ? verified
          ? normalized.mappedStatus === 'success'
            ? 'success'
            : normalized.mappedStatus === 'failed'
              ? 'failed'
              : 'processing'
          : 'manual_review'
        : 'manual_review',
    };
  }

  processSupplySourceRefundNotice(systemKey: string, payload: SupplySourceRefundPayload) {
    const system = this.db
      .prepare(
        `
          SELECT
            id,
            system_key AS systemKey,
            system_name AS systemName,
            adapter_key AS adapterKey,
            callback_token AS callbackToken
          FROM supply_source_systems
          WHERE system_key = ?
        `,
      )
      .get(systemKey) as
      | {
          id: number;
          systemKey: string;
          systemName: string;
          adapterKey: string;
          callbackToken: string;
        }
      | undefined;

    if (!system) {
      return null;
    }

    const adapter = getSupplySourceAdapter(system.adapterKey);
    const now = format(new Date(), 'yyyy-MM-dd HH:mm:ss');
    const sourceOrder = this.db
      .prepare(
        `
          SELECT
            sso.id,
            sso.order_id AS orderId,
            sso.mapping_id AS mappingId,
            o.order_no AS orderNo,
            o.paid_amount AS paidAmount
          FROM supply_source_orders sso
          INNER JOIN orders o ON o.id = sso.order_id
          WHERE sso.system_id = @systemId
            AND sso.source_order_no = @sourceOrderNo
          LIMIT 1
        `,
      )
      .get({
        systemId: system.id,
        sourceOrderNo: payload.sourceOrderNo,
      }) as
      | {
          id: number;
          orderId: number;
          mappingId: number;
          orderNo: string;
          paidAmount: number;
        }
      | undefined;

    if (!adapter) {
      return {
        accepted: false,
        mappedStatus: null,
        caseNo: null,
        detail: '货源适配器不存在，退款通知未能完成映射。',
      };
    }

    const verified = adapter.verifyCallbackToken(payload.token, system.callbackToken);
    const normalized = adapter.normalizeRefundNotice(payload);
    const noticeDetail = verified
      ? normalized.detail
      : payload.detail?.trim() || '退款通知验签失败，已记录为异常。';
    let caseInfo:
      | {
          caseId: number;
          caseNo: string;
          orderNo: string;
        }
      | null = null;

    this.db.transaction(() => {
      this.db
        .prepare(
          `
            UPDATE supply_source_systems
            SET
              last_refund_notice_at = @lastRefundNoticeAt,
              updated_at = @updatedAt
            WHERE id = @id
          `,
        )
        .run({
          id: system.id,
          lastRefundNoticeAt: now,
          updatedAt: now,
        });

      if (sourceOrder && verified && normalized.mappedStatus !== 'failed') {
        caseInfo = this.ensureSupplySourceRefundCase(
          sourceOrder.orderId,
          noticeDetail,
          normalized.mappedStatus,
          now,
        );
      } else if (sourceOrder) {
        const existingCase = this.db
          .prepare(
            `
              SELECT id, case_no AS caseNo
              FROM after_sale_cases
              WHERE order_id = ?
                AND case_type = 'refund'
              ORDER BY id DESC
              LIMIT 1
            `,
          )
          .get(sourceOrder.orderId) as { id: number; caseNo: string } | undefined;
        if (existingCase) {
          caseInfo = {
            caseId: existingCase.id,
            caseNo: existingCase.caseNo,
            orderNo: sourceOrder.orderNo,
          };
        }
      }

      if (sourceOrder) {
        this.db
          .prepare(
            `
              INSERT INTO supply_source_refund_notices (
                system_id,
                order_id,
                case_id,
                notice_no,
                source_order_no,
                refund_status,
                detail,
                notified_at,
                updated_at
              ) VALUES (
                @systemId,
                @orderId,
                @caseId,
                @noticeNo,
                @sourceOrderNo,
                @refundStatus,
                @detail,
                @notifiedAt,
                @updatedAt
              )
              ON CONFLICT(notice_no) DO UPDATE SET
                case_id = excluded.case_id,
                refund_status = excluded.refund_status,
                detail = excluded.detail,
                updated_at = excluded.updated_at
            `,
          )
          .run({
            systemId: system.id,
            orderId: sourceOrder.orderId,
            caseId: caseInfo?.caseId ?? null,
            noticeNo: payload.noticeNo,
            sourceOrderNo: payload.sourceOrderNo,
            refundStatus: verified ? normalized.mappedStatus : 'failed',
            detail: noticeDetail,
            notifiedAt: now,
            updatedAt: now,
          });

        this.upsertSupplySourceReconciliation({
          systemId: system.id,
          mappingId: sourceOrder.mappingId,
          orderId: sourceOrder.orderId,
          reconcileType: 'refund',
          reconcileNo: `SSR-REFUND-${payload.noticeNo}`,
          platformRef: caseInfo?.caseNo ?? sourceOrder.orderNo,
          sourceRef: payload.noticeNo,
          platformAmount: sourceOrder.paidAmount,
          sourceAmount: sourceOrder.paidAmount,
          diffAmount: 0,
          reconcileStatus: verified
            ? normalized.mappedStatus === 'resolved'
              ? 'matched'
              : normalized.mappedStatus === 'processing'
                ? 'pending'
                : 'anomaly'
            : 'anomaly',
          detail: noticeDetail,
          now,
        });

        if (!verified || normalized.mappedStatus === 'failed') {
          this.appendOrderEvent(
            sourceOrder.orderId,
            'source_supply_refund_anomaly',
            '货源退款通知异常',
            `${system.systemName} 的退款通知需要人工复核。`,
            '自有货源系统',
            now,
          );
        }
      }
    })();

    this.insertWorkspaceLog(
      'distribution-supply',
      verified ? 'source_refund_notice' : 'source_refund_notice_rejected',
      verified ? `${system.systemName} 退款通知已处理` : `${system.systemName} 退款通知验签失败`,
      sourceOrder
        ? `${payload.noticeNo} 已写入货源退款通知记录。`
        : `${payload.noticeNo} 未能匹配到货源订单，仅保留系统侧接收记录。`,
    );
    this.touchWorkspace('distribution-source', now);
    this.touchWorkspace('distribution-supply', now);

    return {
      accepted: verified,
      mappedStatus: verified ? normalized.mappedStatus : null,
      caseNo: (caseInfo as { caseNo: string } | null)?.caseNo ?? null,
      detail: noticeDetail,
    };
  }

  private ensureDirectChargeEngineData(includeSampleData: boolean) {
    if (!includeSampleData) {
      return;
    }

    const now = format(new Date(), 'yyyy-MM-dd HH:mm:ss');

    const insertProduct = this.db.prepare(
      `
        INSERT OR IGNORE INTO products (
          id,
          store_id,
          sku,
          name,
          category,
          price,
          cost,
          stock
        ) VALUES (
          @id,
          @storeId,
          @sku,
          @name,
          @category,
          @price,
          @cost,
          @stock
        )
      `,
    );
    const updateProduct = this.db.prepare(
      `
        UPDATE products
        SET
          store_id = @storeId,
          sku = @sku,
          name = @name,
          category = @category,
          price = @price,
          cost = @cost,
          stock = @stock
        WHERE id = @id
      `,
    );
    DIRECT_CHARGE_PRODUCT_SEEDS.forEach((product) => {
      insertProduct.run({
        id: product.productId,
        storeId: product.storeId,
        sku: product.sku,
        name: product.name,
        category: product.category,
        price: product.price,
        cost: product.cost,
        stock: product.stock,
      });
      updateProduct.run({
        id: product.productId,
        storeId: product.storeId,
        sku: product.sku,
        name: product.name,
        category: product.category,
        price: product.price,
        cost: product.cost,
        stock: product.stock,
      });
    });

    const upsertSupplier = this.db.prepare(
      `
        INSERT INTO direct_charge_suppliers (
          id,
          supplier_key,
          supplier_name,
          adapter_key,
          account_name,
          endpoint_url,
          callback_token,
          callback_token_masked,
          enabled,
          supplier_status,
          balance,
          success_rate,
          timeout_minutes,
          created_at,
          updated_at
        ) VALUES (
          @id,
          @supplierKey,
          @supplierName,
          @adapterKey,
          @accountName,
          @endpointUrl,
          @callbackToken,
          @callbackTokenMasked,
          @enabled,
          @supplierStatus,
          @balance,
          @successRate,
          @timeoutMinutes,
          @createdAt,
          @updatedAt
        )
        ON CONFLICT(id) DO UPDATE SET
          supplier_key = excluded.supplier_key,
          supplier_name = excluded.supplier_name,
          adapter_key = excluded.adapter_key,
          account_name = excluded.account_name,
          endpoint_url = excluded.endpoint_url,
          callback_token = excluded.callback_token,
          callback_token_masked = excluded.callback_token_masked,
          enabled = excluded.enabled,
          supplier_status = excluded.supplier_status,
          balance = excluded.balance,
          success_rate = excluded.success_rate,
          timeout_minutes = excluded.timeout_minutes,
          updated_at = excluded.updated_at
      `,
    );

    DIRECT_CHARGE_SUPPLIER_SEEDS.forEach((supplier) => {
      upsertSupplier.run({
        id: supplier.id,
        supplierKey: supplier.supplierKey,
        supplierName: supplier.supplierName,
        adapterKey: supplier.adapterKey,
        accountName: supplier.accountName,
        endpointUrl: supplier.endpointUrl,
        callbackToken: supplier.callbackToken,
        callbackTokenMasked: maskSecret(supplier.callbackToken),
        enabled: supplier.enabled,
        supplierStatus: supplier.supplierStatus,
        balance: supplier.balance,
        successRate: supplier.successRate,
        timeoutMinutes: DIRECT_CHARGE_TIMEOUT_MINUTES,
        createdAt: now,
        updatedAt: now,
      });
    });

    const upsertItem = this.db.prepare(
      `
        INSERT INTO direct_charge_items (
          id,
          supplier_id,
          product_id,
          product_title,
          category,
          store_name,
          target_type,
          zone_required,
          face_value,
          enabled,
          status,
          updated_at
        ) VALUES (
          @id,
          @supplierId,
          @productId,
          @productTitle,
          @category,
          @storeName,
          @targetType,
          @zoneRequired,
          @faceValue,
          @enabled,
          @status,
          @updatedAt
        )
        ON CONFLICT(id) DO UPDATE SET
          supplier_id = excluded.supplier_id,
          product_id = excluded.product_id,
          product_title = excluded.product_title,
          category = excluded.category,
          store_name = excluded.store_name,
          target_type = excluded.target_type,
          zone_required = excluded.zone_required,
          face_value = excluded.face_value,
          enabled = excluded.enabled,
          status = excluded.status,
          updated_at = excluded.updated_at
      `,
    );
    DIRECT_CHARGE_PRODUCT_SEEDS.forEach((item) => {
      const store = this.db
        .prepare('SELECT name FROM stores WHERE id = ?')
        .get(item.storeId) as { name: string } | undefined;
      upsertItem.run({
        id: item.itemId,
        supplierId: item.supplierId,
        productId: item.productId,
        productTitle: item.name,
        category: item.category,
        storeName: store?.name ?? `店铺 ${item.storeId}`,
        targetType: item.targetType,
        zoneRequired: item.zoneRequired,
        faceValue: item.faceValue,
        enabled: item.enabled,
        status: item.status,
        updatedAt: now,
      });
    });

    const insertOrder = this.db.prepare(
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
          @orderNo,
          @storeId,
          @productId,
          @customerId,
          @source,
          1,
          @paidAmount,
          0,
          'pending_shipment',
          'paid',
          'paid',
          'pending',
          'none',
          0,
          @paidAt,
          NULL,
          NULL,
          0,
          0,
          @buyerNote,
          @sellerRemark,
          @createdAt,
          @updatedAt
        )
      `,
    );

    const ensureJob = (
      orderId: number,
      seed: (typeof DIRECT_CHARGE_DEMO_ORDER_SEEDS)[number],
      createdAt: string,
    ) => {
      const existing = this.db
        .prepare(
          `
            SELECT id
            FROM direct_charge_jobs
            WHERE order_id = ?
          `,
        )
        .get(orderId) as { id: number } | undefined;
      if (existing) {
        return existing.id;
      }

      const item = DIRECT_CHARGE_PRODUCT_SEEDS.find((entry) => entry.itemId === seed.itemId);
      const supplier = DIRECT_CHARGE_SUPPLIER_SEEDS.find((entry) => entry.id === item?.supplierId);
      if (!item || !supplier) {
        return null;
      }

      const result = this.db
        .prepare(
          `
            INSERT INTO direct_charge_jobs (
              order_id,
              supplier_id,
              item_id,
              task_no,
              supplier_order_no,
              adapter_key,
              target_account,
              target_zone,
              face_value,
              task_status,
              supplier_status,
              callback_status,
              verification_status,
              retry_count,
              max_retry,
              error_message,
              result_detail,
              created_at,
              updated_at
            ) VALUES (
              @orderId,
              @supplierId,
              @itemId,
              @taskNo,
              NULL,
              @adapterKey,
              @targetAccount,
              @targetZone,
              @faceValue,
              'pending_dispatch',
              NULL,
              'pending',
              'pending',
              0,
              2,
              NULL,
              NULL,
              @createdAt,
              @updatedAt
            )
          `,
        )
        .run({
          orderId,
          supplierId: supplier.id,
          itemId: item.itemId,
          taskNo: `DC${format(addDays(new Date(), seed.dayShift), 'yyyyMMdd')}${seed.orderNoSuffix}`,
          adapterKey: supplier.adapterKey,
          targetAccount: seed.targetAccount,
          targetZone: seed.targetZone,
          faceValue: item.faceValue,
          createdAt,
          updatedAt: createdAt,
        });

      return Number(result.lastInsertRowid);
    };

    DIRECT_CHARGE_DEMO_ORDER_SEEDS.forEach((seed) => {
      const item = DIRECT_CHARGE_PRODUCT_SEEDS.find((entry) => entry.itemId === seed.itemId);
      if (!item) {
        return;
      }

      const orderDate = addDays(new Date(), seed.dayShift);
      const orderNo = `GF${format(orderDate, 'yyyyMMdd')}${seed.orderNoSuffix}`;
      const exists = this.db
        .prepare('SELECT id FROM orders WHERE order_no = ?')
        .get(orderNo) as { id: number } | undefined;
      const paidAt = formatDateTime(new Date(), seed.hour, seed.minute, seed.dayShift);

      if (!exists) {
        insertOrder.run({
          orderNo,
          storeId: item.storeId,
          productId: item.productId,
          customerId: seed.customerId,
          source: seed.source,
          paidAmount: seed.paidAmount,
          paidAt,
          buyerNote: `充值账号：${seed.targetAccount}`,
          sellerRemark: seed.targetZone ? `充值区服：${seed.targetZone}` : '直充订单无区服信息',
          createdAt: paidAt,
          updatedAt: paidAt,
        });
      }
    });

    DIRECT_CHARGE_DEMO_ORDER_SEEDS.forEach((seed) => {
      const orderDate = addDays(new Date(), seed.dayShift);
      const orderNo = `GF${format(orderDate, 'yyyyMMdd')}${seed.orderNoSuffix}`;
      const order = this.db
        .prepare('SELECT id FROM orders WHERE order_no = ?')
        .get(orderNo) as { id: number } | undefined;
      if (!order) {
        return;
      }

      const createdAt = formatDateTime(new Date(), seed.hour, seed.minute, seed.dayShift);
      const jobId = ensureJob(order.id, seed, createdAt);
      if (!jobId) {
        return;
      }

      const jobContext = this.getDirectChargeJobContext(jobId);
      if (!jobContext) {
        return;
      }

      if (seed.seedMode === 'pending_dispatch') {
        return;
      }

      if (seed.seedMode === 'processing_timeout') {
        const result = this.dispatchDirectChargeJobInternal(jobId, createdAt, false);
        if (result?.success) {
          const expiredTimeoutAt = format(
            addMinutes(new Date(createdAt.replace(' ', 'T')), 1),
            'yyyy-MM-dd HH:mm:ss',
          );
          this.db
            .prepare(
              `
                UPDATE direct_charge_jobs
                SET timeout_at = @timeoutAt
                WHERE id = @id
              `,
            )
            .run({
              id: jobId,
              timeoutAt: expiredTimeoutAt,
            });
        }
        return;
      }

      const dispatchResult = this.dispatchDirectChargeJobInternal(jobId, createdAt, false);
      if (!dispatchResult?.success) {
        return;
      }

      const latestContext = this.getDirectChargeJobContext(jobId);
      if (!latestContext) {
        return;
      }

      if (seed.seedMode === 'success' || seed.seedMode === 'failed') {
        this.processDirectChargeCallback(jobContext.supplierKey, {
          taskNo: latestContext.taskNo,
          supplierOrderNo: latestContext.supplierOrderNo ?? `SIM-${seed.orderNoSuffix}`,
          supplierStatus: seed.seedMode === 'success' ? 'SUCCESS' : 'FAILED',
          resultCode: seed.seedMode === 'success' ? '0000' : 'E_TOPUP_FAIL',
          detail:
            seed.seedMode === 'success'
              ? '模拟供应商回执：充值成功。'
              : '模拟供应商回执：充值失败，已进入人工处理。',
          token: latestContext.callbackToken,
        });
      }
    });
  }

  private ensureSupplySourceIntegrationData(includeSampleData: boolean) {
    if (!includeSampleData) {
      return;
    }

    const now = format(new Date(), 'yyyy-MM-dd HH:mm:ss');
    const upsertSystem = this.db.prepare(
      `
        INSERT INTO supply_source_systems (
          id,
          system_key,
          system_name,
          adapter_key,
          endpoint_url,
          callback_token,
          callback_token_masked,
          enabled,
          system_status,
          sync_mode,
          sync_interval_minutes,
          order_push_enabled,
          refund_callback_enabled,
          created_at,
          updated_at
        ) VALUES (
          @id,
          @systemKey,
          @systemName,
          @adapterKey,
          @endpointUrl,
          @callbackToken,
          @callbackTokenMasked,
          @enabled,
          @systemStatus,
          @syncMode,
          @syncIntervalMinutes,
          @orderPushEnabled,
          @refundCallbackEnabled,
          @createdAt,
          @updatedAt
        )
        ON CONFLICT(id) DO UPDATE SET
          system_key = excluded.system_key,
          system_name = excluded.system_name,
          adapter_key = excluded.adapter_key,
          endpoint_url = excluded.endpoint_url,
          callback_token = excluded.callback_token,
          callback_token_masked = excluded.callback_token_masked,
          enabled = excluded.enabled,
          system_status = excluded.system_status,
          sync_mode = excluded.sync_mode,
          sync_interval_minutes = excluded.sync_interval_minutes,
          order_push_enabled = excluded.order_push_enabled,
          refund_callback_enabled = excluded.refund_callback_enabled,
          updated_at = excluded.updated_at
      `,
    );

    SUPPLY_SOURCE_SYSTEM_SEEDS.forEach((system) => {
      upsertSystem.run({
        id: system.id,
        systemKey: system.systemKey,
        systemName: system.systemName,
        adapterKey: system.adapterKey,
        endpointUrl: system.endpointUrl,
        callbackToken: system.callbackToken,
        callbackTokenMasked: maskSecret(system.callbackToken),
        enabled: system.enabled,
        systemStatus: system.systemStatus,
        syncMode: system.syncMode,
        syncIntervalMinutes: system.syncIntervalMinutes,
        orderPushEnabled: system.orderPushEnabled,
        refundCallbackEnabled: system.refundCallbackEnabled,
        createdAt: now,
        updatedAt: now,
      });
    });

    const upsertProduct = this.db.prepare(
      `
        INSERT INTO supply_source_products (
          system_id,
          external_product_id,
          external_sku,
          external_product_name,
          platform_product_id,
          platform_product_name,
          store_id,
          store_name,
          category,
          sale_price,
          source_price,
          source_stock,
          sync_status,
          enabled,
          last_sync_at,
          updated_at
        ) VALUES (
          @systemId,
          @externalProductId,
          @externalSku,
          @externalProductName,
          @platformProductId,
          @platformProductName,
          @storeId,
          @storeName,
          @category,
          @salePrice,
          @sourcePrice,
          @sourceStock,
          @syncStatus,
          @enabled,
          @lastSyncAt,
          @updatedAt
        )
        ON CONFLICT(platform_product_id) DO UPDATE SET
          system_id = excluded.system_id,
          external_product_id = excluded.external_product_id,
          external_sku = excluded.external_sku,
          external_product_name = excluded.external_product_name,
          platform_product_name = excluded.platform_product_name,
          store_id = excluded.store_id,
          store_name = excluded.store_name,
          category = excluded.category,
          sale_price = excluded.sale_price,
          source_price = excluded.source_price,
          source_stock = excluded.source_stock,
          sync_status = excluded.sync_status,
          enabled = excluded.enabled,
          last_sync_at = excluded.last_sync_at,
          updated_at = excluded.updated_at
      `,
    );

    SUPPLY_SOURCE_PRODUCT_SEEDS.forEach((seed) => {
      const product = this.db
        .prepare(
          `
            SELECT
              p.id,
              p.name,
              p.price,
              s.id AS storeId,
              s.name AS storeName
            FROM products p
            INNER JOIN stores s ON s.id = p.store_id
            WHERE p.id = ?
          `,
        )
        .get(seed.platformProductId) as
        | {
            id: number;
            name: string;
            price: number;
            storeId: number;
            storeName: string;
          }
        | undefined;
      if (!product) {
        return;
      }

      upsertProduct.run({
        systemId: seed.systemId,
        externalProductId: seed.externalProductId,
        externalSku: seed.externalSku,
        externalProductName: seed.externalProductName,
        platformProductId: product.id,
        platformProductName: product.name,
        storeId: product.storeId,
        storeName: product.storeName,
        category: seed.category,
        salePrice: product.price,
        sourcePrice: seed.sourcePrice,
        sourceStock: seed.sourceStock,
        syncStatus: seed.syncStatus,
        enabled: seed.enabled,
        lastSyncAt: now,
        updatedAt: now,
      });
    });

    const syncRunCount = this.db
      .prepare('SELECT COUNT(*) AS count FROM supply_source_sync_runs')
      .get() as { count: number };
    if (syncRunCount.count === 0) {
      this.runSupplySourceSyncInternal(
        'distribution-source',
        1,
        'product',
        'scheduled',
        formatDateTime(new Date(), 8, 30, -1),
        { applyPlatformUpdates: false },
      );
      this.runSupplySourceSyncInternal(
        'distribution-source',
        1,
        'inventory',
        'manual',
        formatDateTime(new Date(), 14, 10, -1),
        { applyPlatformUpdates: false },
      );
      this.runSupplySourceSyncInternal(
        'distribution-source',
        2,
        'price',
        'manual',
        formatDateTime(new Date(), 9, 45, 0),
        { applyPlatformUpdates: false },
      );
    }

    const insertOrder = this.db.prepare(
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
          @orderNo,
          @storeId,
          @productId,
          @customerId,
          @source,
          @quantity,
          @paidAmount,
          0,
          'pending_shipment',
          'paid',
          'paid',
          'pending',
          'none',
          0,
          @paidAt,
          NULL,
          NULL,
          0,
          0,
          @buyerNote,
          @sellerRemark,
          @createdAt,
          @updatedAt
        )
      `,
    );

    const ensureSourceOrder = (
      orderId: number,
      seed: (typeof SUPPLY_SOURCE_ORDER_SEEDS)[number],
      createdAt: string,
    ) => {
      const existing = this.db
        .prepare(
          `
            SELECT id
            FROM supply_source_orders
            WHERE order_id = ?
          `,
        )
        .get(orderId) as { id: number } | undefined;
      if (existing) {
        return existing.id;
      }

      const mapping = this.db
        .prepare(
          `
            SELECT id
            FROM supply_source_products
            WHERE system_id = @systemId
              AND platform_product_id = @platformProductId
            LIMIT 1
          `,
        )
        .get({
          systemId: seed.systemId,
          platformProductId: seed.platformProductId,
        }) as { id: number } | undefined;
      if (!mapping) {
        return null;
      }

      const orderDate = addDays(new Date(), seed.dayShift);
      const result = this.db
        .prepare(
          `
            INSERT INTO supply_source_orders (
              system_id,
              mapping_id,
              order_id,
              task_no,
              source_order_no,
              order_status,
              source_status,
              verification_status,
              retry_count,
              max_retry,
              failure_reason,
              result_detail,
              pushed_at,
              callback_at,
              updated_at
            ) VALUES (
              @systemId,
              @mappingId,
              @orderId,
              @taskNo,
              NULL,
              'pending_push',
              NULL,
              'pending',
              0,
              2,
              NULL,
              NULL,
              NULL,
              NULL,
              @updatedAt
            )
          `,
        )
        .run({
          systemId: seed.systemId,
          mappingId: mapping.id,
          orderId,
          taskNo: `SS${format(orderDate, 'yyyyMMdd')}${seed.taskNoSuffix}`,
          updatedAt: createdAt,
        });

      return Number(result.lastInsertRowid);
    };

    SUPPLY_SOURCE_ORDER_SEEDS.forEach((seed) => {
      const product = this.db
        .prepare(
          `
            SELECT
              p.id,
              p.store_id AS storeId,
              p.name
            FROM products p
            WHERE p.id = ?
          `,
        )
        .get(seed.platformProductId) as
        | {
            id: number;
            storeId: number;
            name: string;
          }
        | undefined;
      const system = SUPPLY_SOURCE_SYSTEM_SEEDS.find((item) => item.id === seed.systemId);
      if (!product || !system) {
        return;
      }

      const orderDate = addDays(new Date(), seed.dayShift);
      const orderNo = `GF${format(orderDate, 'yyyyMMdd')}${seed.taskNoSuffix}`;
      const paidAt = formatDateTime(new Date(), seed.hour, seed.minute, seed.dayShift);
      const existingOrder = this.db
        .prepare('SELECT id FROM orders WHERE order_no = ?')
        .get(orderNo) as { id: number } | undefined;

      if (!existingOrder) {
        insertOrder.run({
          orderNo,
          storeId: product.storeId,
          productId: product.id,
          customerId: seed.customerId,
          source: seed.source,
          quantity: seed.quantity,
          paidAmount: seed.paidAmount,
          paidAt,
          buyerNote: `货源推单商品：${product.name}`,
          sellerRemark: `自有货源系统：${system.systemName}`,
          createdAt: paidAt,
          updatedAt: paidAt,
        });
      }

      const order = this.db
        .prepare('SELECT id FROM orders WHERE order_no = ?')
        .get(orderNo) as { id: number } | undefined;
      if (!order) {
        return;
      }

      const sourceOrderId = ensureSourceOrder(order.id, seed, paidAt);
      if (!sourceOrderId) {
        return;
      }

      const context = this.getSupplySourceOrderContext(sourceOrderId);
      if (!context) {
        return;
      }

      if (seed.seedMode === 'pending_push') {
        return;
      }

      if (context.orderStatus === 'pending_push') {
        const dispatchResult = this.dispatchSupplySourceOrderInternal(sourceOrderId, paidAt, false);
        if (!dispatchResult?.success) {
          return;
        }
      }

      const latestContext = this.getSupplySourceOrderContext(sourceOrderId);
      if (!latestContext || seed.seedMode !== 'delivered' || latestContext.orderStatus === 'success') {
        return;
      }

      this.processSupplySourceCallback(latestContext.systemKey, {
        taskNo: latestContext.taskNo,
        sourceOrderNo: latestContext.sourceOrderNo ?? `SRC-${seed.taskNoSuffix}`,
        sourceStatus: 'DELIVERED',
        detail: '模拟货源回调：已完成发货。',
        token: latestContext.callbackToken,
      });
    });

    this.ensureOrderCenterData(false);
  }

  private getCardTypeBase(cardTypeId: number) {
    return this.db
      .prepare(
        `
          SELECT
            id,
            type_name AS typeName,
            card_prefix AS cardPrefix,
            password_prefix AS passwordPrefix,
            separator_text AS separatorText
          FROM card_types
          WHERE id = ?
        `,
      )
      .get(cardTypeId) as
      | {
          id: number;
          typeName: string;
          cardPrefix: string;
          passwordPrefix: string;
          separatorText: string;
        }
      | undefined;
  }

  private maskCardPart(value: string) {
    const trimmed = value.trim();
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

  private generateCardImportLines(cardTypeId: number, count = 4, includeNoise = true) {
    const cardType = this.getCardTypeBase(cardTypeId);
    if (!cardType) {
      return [];
    }

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

  private syncCardTypeInventorySummary(cardTypeId: number, now: string) {
    const summary = this.db
      .prepare(
        `
          SELECT
            COUNT(*) AS totalCount,
            SUM(CASE WHEN item_status = 'available' THEN 1 ELSE 0 END) AS availableCount,
            SUM(CASE WHEN item_status = 'locked' THEN 1 ELSE 0 END) AS lockedCount,
            SUM(CASE WHEN item_status = 'sold' THEN 1 ELSE 0 END) AS soldCount,
            SUM(CASE WHEN item_status = 'disabled' THEN 1 ELSE 0 END) AS disabledCount
          FROM card_inventory_items
          WHERE card_type_id = ?
        `,
      )
      .get(cardTypeId) as Record<string, number | null>;

    this.db
      .prepare(
        `
          UPDATE card_types
          SET
            unsold_count = @availableCount,
            sold_count = @soldCount,
            total_stock = @totalCount,
            updated_at = @updatedAt
          WHERE id = @cardTypeId
        `,
      )
      .run({
        cardTypeId,
        availableCount: Number(summary.availableCount ?? 0),
        soldCount: Number(summary.soldCount ?? 0),
        totalCount: Number(summary.totalCount ?? 0),
        updatedAt: now,
      });

    return {
      totalCount: Number(summary.totalCount ?? 0),
      availableCount: Number(summary.availableCount ?? 0),
      lockedCount: Number(summary.lockedCount ?? 0),
      soldCount: Number(summary.soldCount ?? 0),
      disabledCount: Number(summary.disabledCount ?? 0),
    };
  }

  private refreshCardStockAlert(cardTypeId: number, now: string) {
    const cardType = this.db
      .prepare(
        `
          SELECT id, type_name AS typeName
          FROM card_types
          WHERE id = ?
        `,
      )
      .get(cardTypeId) as { id: number; typeName: string } | undefined;
    if (!cardType) {
      return null;
    }

    const summary = this.syncCardTypeInventorySummary(cardTypeId, now);
    const status = summary.availableCount <= CARD_LOW_STOCK_THRESHOLD ? 'open' : 'resolved';
    const detail =
      status === 'open'
        ? `${cardType.typeName} 可用库存仅剩 ${summary.availableCount} 张，已低于阈值 ${CARD_LOW_STOCK_THRESHOLD}。`
        : `${cardType.typeName} 库存已恢复到 ${summary.availableCount} 张。`;

    this.db
      .prepare(
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
          ) VALUES (
            @cardTypeId,
            'low_stock',
            @thresholdValue,
            @currentStock,
            @status,
            @detail,
            @createdAt,
            @updatedAt
          )
          ON CONFLICT(card_type_id) DO UPDATE SET
            alert_level = excluded.alert_level,
            threshold_value = excluded.threshold_value,
            current_stock = excluded.current_stock,
            status = excluded.status,
            detail = excluded.detail,
            updated_at = excluded.updated_at
        `,
      )
      .run({
        cardTypeId,
        thresholdValue: CARD_LOW_STOCK_THRESHOLD,
        currentStock: summary.availableCount,
        status,
        detail,
        createdAt: now,
        updatedAt: now,
      });

    return { ...summary, status, detail };
  }

  private selectCardTemplate() {
    return this.db
      .prepare(
        `
          SELECT
            id,
            template_name AS templateName,
            template_content AS templateContent
          FROM card_templates
          WHERE template_status = '启用'
          ORDER BY random_enabled DESC, updated_at DESC, id DESC
          LIMIT 1
        `,
      )
      .get() as
      | {
          id: number;
          templateName: string;
          templateContent: string;
        }
      | undefined;
  }

  private buildCardDeliveryMessage(input: {
    orderNo: string;
    cardTypeName: string;
    cardNo: string;
    cardSecret: string;
    templateContent: string;
  }) {
    return [
      input.templateContent,
      `订单号：${input.orderNo}`,
      `卡种：${input.cardTypeName}`,
      `卡号：${input.cardNo}`,
      `密码：${input.cardSecret}`,
    ].join('\n');
  }

  private appendOrderEvent(
    orderId: number,
    eventType: string,
    eventTitle: string,
    eventDetail: string,
    operatorName: string,
    createdAt: string,
  ) {
    this.db
      .prepare(
        `
          INSERT INTO order_events (
            order_id,
            event_type,
            event_title,
            event_detail,
            operator_name,
            created_at
          ) VALUES (
            @orderId,
            @eventType,
            @eventTitle,
            @eventDetail,
            @operatorName,
            @createdAt
          )
        `,
      )
      .run({
        orderId,
        eventType,
        eventTitle,
        eventDetail,
        operatorName,
        createdAt,
      });
  }

  private getCardFulfillmentContext(orderId: number) {
    return this.db
      .prepare(
        `
          SELECT
            o.id,
            o.order_no AS orderNo,
            o.product_id AS productId,
            o.quantity,
            o.paid_at AS paidAt,
            p.name AS productName,
            s.name AS storeName,
            c.name AS customerName,
            cdi.id AS deliveryId,
            cdi.enabled AS deliveryEnabled,
            cdi.status AS deliveryItemStatus,
            cdi.delivery_policy AS deliveryPolicy,
            ct.id AS cardTypeId,
            ct.type_name AS cardTypeName
          FROM orders o
          LEFT JOIN products p ON p.id = o.product_id
          LEFT JOIN stores s ON s.id = o.store_id
          LEFT JOIN customers c ON c.id = o.customer_id
          LEFT JOIN card_delivery_items cdi ON cdi.product_id = o.product_id
          LEFT JOIN card_types ct ON ct.id = cdi.card_type_id
          WHERE o.id = ?
        `,
      )
      .get(orderId) as
      | {
          id: number;
          orderNo: string;
          productId: number;
          quantity: number;
          paidAt: string;
          productName: string;
          storeName: string;
          customerName: string;
          deliveryId: number | null;
          deliveryEnabled: number | null;
          deliveryItemStatus: string | null;
          deliveryPolicy: string | null;
          cardTypeId: number | null;
          cardTypeName: string | null;
        }
      | undefined;
  }

  private ensureCardDeliveryJobRecord(
    orderId: number,
    cardTypeId: number,
    jobType: 'auto_fulfill' | 'manual_resend',
    now: string,
  ) {
    const row = this.db
      .prepare(
        `
          SELECT id
          FROM card_delivery_jobs
          WHERE order_id = @orderId AND job_type = @jobType
          ORDER BY id DESC
          LIMIT 1
        `,
      )
      .get({ orderId, jobType }) as { id: number } | undefined;

    if (row) {
      return row.id;
    }

    const result = this.db
      .prepare(
        `
          INSERT INTO card_delivery_jobs (
            order_id,
            card_type_id,
            job_type,
            job_status,
            attempt_count,
            created_at,
            updated_at
          ) VALUES (
            @orderId,
            @cardTypeId,
            @jobType,
            'pending',
            0,
            @createdAt,
            @updatedAt
          )
        `,
      )
      .run({
        orderId,
        cardTypeId,
        jobType,
        createdAt: now,
        updatedAt: now,
      });

    return Number(result.lastInsertRowid);
  }

  private importCardBatch(
    cardTypeId: number,
    lines: string[],
    sourceLabel: string,
    importedAt: string,
    logFeatureKey: string | null,
  ) {
    const cardType = this.getCardTypeBase(cardTypeId);
    if (!cardType) {
      return null;
    }

    const insertBatch = this.db.prepare(
      `
        INSERT INTO card_batches (
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
        ) VALUES (
          @cardTypeId,
          @batchNo,
          @sourceLabel,
          0,
          0,
          0,
          0,
          0,
          @importedAt,
          @createdAt,
          @updatedAt
        )
      `,
    );
    const insertItem = this.db.prepare(
      `
        INSERT INTO card_inventory_items (
          card_type_id,
          batch_id,
          card_no,
          card_secret,
          card_masked,
          item_status,
          imported_at,
          updated_at
        ) VALUES (
          @cardTypeId,
          @batchId,
          @cardNo,
          @cardSecret,
          @cardMasked,
          'available',
          @importedAt,
          @updatedAt
        )
      `,
    );
    const updateBatch = this.db.prepare(
      `
        UPDATE card_batches
        SET
          imported_count = @importedCount,
          duplicate_count = @duplicateCount,
          invalid_count = @invalidCount,
          disabled_count = @disabledCount,
          available_count = @availableCount,
          updated_at = @updatedAt
        WHERE id = @batchId
      `,
    );

    const summary = this.db.transaction(() => {
      const batchNo = `BAT-${format(new Date(importedAt.replace(' ', 'T')), 'yyyyMMddHHmmss')}-${randomUUID()
        .slice(0, 6)
        .toUpperCase()}`;
      const batchResult = insertBatch.run({
        cardTypeId,
        batchNo,
        sourceLabel,
        importedAt,
        createdAt: importedAt,
        updatedAt: importedAt,
      });
      const batchId = Number(batchResult.lastInsertRowid);
      let importedCount = 0;
      let duplicateCount = 0;
      let invalidCount = 0;

      lines.forEach((line) => {
        const parsed = this.parseCardImportLine(cardType, line);
        if (!parsed) {
          invalidCount += 1;
          return;
        }

        try {
          insertItem.run({
            cardTypeId,
            batchId,
            cardNo: parsed.cardNo,
            cardSecret: parsed.cardSecret,
            cardMasked: parsed.cardMasked,
            importedAt,
            updatedAt: importedAt,
          });
          importedCount += 1;
        } catch {
          duplicateCount += 1;
        }
      });

      updateBatch.run({
        batchId,
        importedCount,
        duplicateCount,
        invalidCount,
        disabledCount: 0,
        availableCount: importedCount,
        updatedAt: importedAt,
      });
      const inventorySummary = this.refreshCardStockAlert(cardTypeId, importedAt);

      return {
        batchId,
        batchNo,
        importedCount,
        duplicateCount,
        invalidCount,
        availableCount: inventorySummary?.availableCount ?? 0,
      };
    })();

    if (logFeatureKey) {
      this.insertWorkspaceLog(
        logFeatureKey,
        'inventory_import',
        `${cardType.typeName}完成卡密导入`,
        `新增 ${summary.importedCount} 张，重复 ${summary.duplicateCount} 张，格式异常 ${summary.invalidCount} 张。`,
      );
      this.touchWorkspace(logFeatureKey, importedAt);
    }

    return {
      cardTypeId,
      typeName: cardType.typeName,
      ...summary,
    };
  }

  private getCardTypesDetail() {
    const rows = this.db
      .prepare(
        `
          SELECT
            ct.id,
            ct.type_name AS typeName,
            ct.delivery_channel AS deliveryChannel,
            ct.inventory_cost AS inventoryCost,
            ct.average_price AS averagePrice,
            ct.template_count AS templateCount,
            ct.card_prefix AS cardPrefix,
            ct.password_prefix AS passwordPrefix,
            ct.separator_text AS separatorText,
            COALESCE(inv.availableCount, 0) AS availableCount,
            COALESCE(inv.lockedCount, 0) AS lockedCount,
            COALESCE(inv.soldCount, 0) AS soldCount,
            COALESCE(inv.disabledCount, 0) AS disabledCount,
            COALESCE(batch.lastImportedAt, ct.updated_at) AS lastImportedAt,
            outbound.lastOutboundAt AS lastOutboundAt,
            ct.updated_at AS updatedAt
          FROM card_types ct
          LEFT JOIN (
            SELECT
              card_type_id AS cardTypeId,
              SUM(CASE WHEN item_status = 'available' THEN 1 ELSE 0 END) AS availableCount,
              SUM(CASE WHEN item_status = 'locked' THEN 1 ELSE 0 END) AS lockedCount,
              SUM(CASE WHEN item_status = 'sold' THEN 1 ELSE 0 END) AS soldCount,
              SUM(CASE WHEN item_status = 'disabled' THEN 1 ELSE 0 END) AS disabledCount
            FROM card_inventory_items
            GROUP BY card_type_id
          ) inv ON inv.cardTypeId = ct.id
          LEFT JOIN (
            SELECT
              card_type_id AS cardTypeId,
              MAX(imported_at) AS lastImportedAt
            FROM card_batches
            GROUP BY card_type_id
          ) batch ON batch.cardTypeId = ct.id
          LEFT JOIN (
            SELECT
              card_type_id AS cardTypeId,
              MAX(created_at) AS lastOutboundAt
            FROM card_outbound_records
            GROUP BY card_type_id
          ) outbound ON outbound.cardTypeId = ct.id
          WHERE ct.is_deleted = 0
          ORDER BY ct.updated_at DESC, ct.id DESC
        `,
      )
      .all() as Array<{
        id: number;
        typeName: string;
        deliveryChannel: string;
        inventoryCost: number;
        averagePrice: number;
        templateCount: number;
        cardPrefix: string;
        passwordPrefix: string;
        separatorText: string;
        availableCount: number;
        lockedCount: number;
        soldCount: number;
        disabledCount: number;
        lastImportedAt: string;
        lastOutboundAt: string | null;
        updatedAt: string;
      }>;

    const typeCount = rows.length;
    const availableCount = rows.reduce((total, row) => total + Number(row.availableCount ?? 0), 0);
    const lockedCount = rows.reduce((total, row) => total + Number(row.lockedCount ?? 0), 0);
    const lowStockCount = rows.filter((row) => Number(row.availableCount ?? 0) <= CARD_LOW_STOCK_THRESHOLD).length;

    return {
      kind: 'card-types' as const,
      title: '卡密库存模型',
      description: '按卡种查看可用、锁定、已售与禁用库存，作为自动履约的基础模型。',
      metrics: [
        { label: '卡种数量', value: typeCount, unit: '种', helper: '已接入自动履约的卡种' },
        { label: '可用库存', value: availableCount, unit: '张', helper: '可立即锁卡发货' },
        { label: '锁定库存', value: lockedCount, unit: '张', helper: '已锁定等待履约落账' },
        { label: '低库存提醒', value: lowStockCount, unit: '种', helper: `阈值 ${CARD_LOW_STOCK_THRESHOLD} 张` },
      ],
      rows,
    };
  }

  private getCardDeliveryDetail() {
    const rows = this.db
      .prepare(
        `
          SELECT
            cdi.id,
            cdi.card_type_id AS cardTypeId,
            cdi.product_id AS productId,
            cdi.product_title AS productTitle,
            cdi.sale_price AS salePrice,
            cdi.category,
            cdi.store_name AS storeName,
            cdi.content_mode AS contentMode,
            cdi.delivery_policy AS deliveryPolicy,
            cdi.enabled,
            cdi.status,
            ct.type_name AS cardTypeName,
            COALESCE(inv.availableCount, 0) AS availableCount,
            COALESCE(inv.lockedCount, 0) AS lockedCount,
            COALESCE(inv.soldCount, 0) AS soldCount,
            COALESCE(inv.disabledCount, 0) AS disabledCount,
            tpl.templateName,
            outbound.lastOutboundAt AS lastOutboundAt,
            cdi.updated_at AS updatedAt
          FROM card_delivery_items cdi
          INNER JOIN card_types ct ON ct.id = cdi.card_type_id
          LEFT JOIN (
            SELECT
              card_type_id AS cardTypeId,
              SUM(CASE WHEN item_status = 'available' THEN 1 ELSE 0 END) AS availableCount,
              SUM(CASE WHEN item_status = 'locked' THEN 1 ELSE 0 END) AS lockedCount,
              SUM(CASE WHEN item_status = 'sold' THEN 1 ELSE 0 END) AS soldCount,
              SUM(CASE WHEN item_status = 'disabled' THEN 1 ELSE 0 END) AS disabledCount
            FROM card_inventory_items
            GROUP BY card_type_id
          ) inv ON inv.cardTypeId = cdi.card_type_id
          LEFT JOIN (
            SELECT
              card_type_id AS cardTypeId,
              MAX(created_at) AS lastOutboundAt
            FROM card_outbound_records
            GROUP BY card_type_id
          ) outbound ON outbound.cardTypeId = cdi.card_type_id
          LEFT JOIN (
            SELECT
              id,
              template_name AS templateName
            FROM card_templates
            WHERE template_status = '启用'
            ORDER BY random_enabled DESC, updated_at DESC, id DESC
            LIMIT 1
          ) tpl ON 1 = 1
          ORDER BY cdi.updated_at DESC, cdi.id DESC
        `,
      )
      .all() as Array<{
        id: number;
        cardTypeId: number;
        productId: number | null;
        productTitle: string;
        salePrice: number;
        category: string;
        storeName: string;
        contentMode: string;
        deliveryPolicy: string;
        enabled: number;
        status: string;
        cardTypeName: string;
        availableCount: number;
        lockedCount: number;
        soldCount: number;
        disabledCount: number;
        templateName: string | null;
        lastOutboundAt: string | null;
        updatedAt: string;
      }>;

    const policyCounts = this.db
      .prepare(
        `
          SELECT delivery_policy AS label, COUNT(*) AS count
          FROM card_delivery_items
          GROUP BY delivery_policy
        `,
      )
      .all() as Array<{ label: string; count: number }>;

    const jobs = this.db
      .prepare(
        `
          SELECT
            cdj.id,
            cdj.order_id AS orderId,
            o.order_no AS orderNo,
            p.name AS productTitle,
            ct.type_name AS cardTypeName,
            cdj.job_type AS jobType,
            cdj.job_status AS jobStatus,
            cdj.attempt_count AS attemptCount,
            cdj.error_message AS errorMessage,
            cor.outbound_no AS latestOutboundNo,
            cdj.updated_at AS updatedAt
          FROM card_delivery_jobs cdj
          INNER JOIN orders o ON o.id = cdj.order_id
          INNER JOIN card_types ct ON ct.id = cdj.card_type_id
          LEFT JOIN products p ON p.id = o.product_id
          LEFT JOIN card_outbound_records cor ON cor.id = cdj.latest_outbound_record_id
          ORDER BY cdj.updated_at DESC, cdj.id DESC
        `,
      )
      .all() as Array<{
        id: number;
        orderId: number;
        orderNo: string;
        productTitle: string;
        cardTypeName: string;
        jobType: string;
        jobStatus: CardDeliveryJobStatus;
        attemptCount: number;
        errorMessage: string | null;
        latestOutboundNo: string | null;
        updatedAt: string;
      }>;

    const alerts = this.db
      .prepare(
        `
          SELECT
            csa.id,
            ct.type_name AS cardTypeName,
            csa.current_stock AS currentStock,
            csa.threshold_value AS thresholdValue,
            csa.status,
            csa.detail,
            csa.updated_at AS updatedAt
          FROM card_stock_alerts csa
          INNER JOIN card_types ct ON ct.id = csa.card_type_id
          ORDER BY
            CASE WHEN csa.status = 'open' THEN 0 ELSE 1 END,
            csa.updated_at DESC,
            csa.id DESC
        `,
      )
      .all() as Array<{
        id: number;
        cardTypeName: string;
        currentStock: number;
        thresholdValue: number;
        status: string;
        detail: string;
        updatedAt: string;
      }>;

    const jobStatusCounts = jobs.reduce<Record<string, number>>((accumulator, job) => {
      accumulator[job.jobStatus] = (accumulator[job.jobStatus] ?? 0) + 1;
      return accumulator;
    }, {});

    return {
      kind: 'card-delivery' as const,
      title: '卡密发货引擎',
      description: '统一查看发货配置、低库存预警和履约任务，并执行导入、发货、重试等动作。',
      metrics: [
        { label: '发货商品', value: rows.length, unit: '个', helper: '已绑定卡密履约配置' },
        {
          label: '启用中',
          value: rows.filter((row) => Boolean(row.enabled)).length,
          unit: '个',
          helper: '当前可自动发货的商品',
        },
        {
          label: '待处理任务',
          value: Number(jobStatusCounts.pending ?? 0) + Number(jobStatusCounts.failed ?? 0),
          unit: '个',
          helper: '含待执行和失败待重试任务',
        },
        {
          label: '低库存提醒',
          value: alerts.filter((row) => row.status === 'open').length,
          unit: '个',
          helper: `库存低于 ${CARD_LOW_STOCK_THRESHOLD} 张`,
        },
      ],
      filters: policyCounts,
      statuses: [
        { label: '待执行', count: Number(jobStatusCounts.pending ?? 0) },
        { label: '已成功', count: Number(jobStatusCounts.success ?? 0) },
        { label: '失败待重试', count: Number(jobStatusCounts.failed ?? 0) },
      ],
      rows: rows.map((row) => ({
        ...row,
        enabled: Boolean(row.enabled),
        lowStock: Number(row.availableCount ?? 0) <= CARD_LOW_STOCK_THRESHOLD,
      })),
      jobs,
      alerts,
    };
  }

  private getCardCombosDetail() {
    const rows = this.db
      .prepare(
        `
        SELECT
          id,
          combo_name AS comboName,
          combo_content AS comboContent,
          combo_type AS comboType,
          status,
          created_at AS createdAt,
          updated_at AS updatedAt
        FROM card_combos
        ORDER BY updated_at DESC, id DESC
      `,
      )
      .all() as Array<{
      id: number;
      comboName: string;
      comboContent: string;
      comboType: string;
      status: string;
      createdAt: string;
      updatedAt: string;
    }>;

    return {
      kind: 'card-combos' as const,
      title: '发卡组合',
      description: '支持固定组合、活动组合和阶梯组合。',
      metrics: [
        { label: '组合数量', value: rows.length, unit: '个', helper: '已创建的发卡组合' },
        {
          label: '销售中',
          value: rows.filter((row) => row.status === '销售中').length,
          unit: '个',
          helper: '当前可售组合',
        },
        {
          label: '已下架',
          value: rows.filter((row) => row.status !== '销售中').length,
          unit: '个',
          helper: '等待重新上架',
        },
        {
          label: '覆盖卡种',
          value: new Set(rows.flatMap((row) => String(row.comboContent).split(' + '))).size,
          unit: '种',
          helper: '组合涉及的卡种数',
        },
      ],
      rows,
    };
  }

  private getCardTemplatesDetail() {
    const rows = this.db
      .prepare(
        `
        SELECT
          id,
          template_name AS templateName,
          template_content AS templateContent,
          template_status AS templateStatus,
          random_enabled AS randomEnabled,
          created_at AS createdAt,
          updated_at AS updatedAt
        FROM card_templates
        ORDER BY updated_at DESC, id DESC
      `,
      )
      .all() as Array<Record<string, string | number>>;

    return {
      kind: 'card-templates' as const,
      title: '内容模板',
      description: '保留“从模板库创建”和“加入随机模板列表”两类关键动作。',
      metrics: [
        { label: '模板数量', value: rows.length, unit: '个', helper: '当前模板总数' },
        {
          label: '启用模板',
          value: rows.filter((row) => row.templateStatus === '启用').length,
          unit: '个',
          helper: '可直接用于发货',
        },
        {
          label: '随机模板',
          value: rows.filter((row) => Boolean(row.randomEnabled)).length,
          unit: '个',
          helper: '参与随机抽取',
        },
        {
          label: '停用模板',
          value: rows.filter((row) => row.templateStatus !== '启用').length,
          unit: '个',
          helper: '仅保留历史规则',
        },
      ],
      rows: rows.map((row) => ({
        ...row,
        randomEnabled: Boolean(row.randomEnabled),
      })),
    };
  }

  private getCardRecordsDetail() {
    const outboundRows = this.db
      .prepare(
        `
          SELECT
            cor.id,
            cor.order_id AS orderId,
            o.order_no AS orderNo,
            cor.outbound_no AS outboundNo,
            cor.outbound_status AS outboundStatus,
            ct.type_name AS cardTypeName,
            cii.card_masked AS cardMasked,
            tpl.template_name AS templateName,
            parent.outbound_no AS parentOutboundNo,
            cor.attempt_no AS attemptNo,
            cor.created_at AS createdAt
          FROM card_outbound_records cor
          INNER JOIN orders o ON o.id = cor.order_id
          INNER JOIN card_types ct ON ct.id = cor.card_type_id
          INNER JOIN card_inventory_items cii ON cii.id = cor.inventory_item_id
          LEFT JOIN card_templates tpl ON tpl.id = cor.template_id
          LEFT JOIN card_outbound_records parent ON parent.id = cor.parent_outbound_id
          ORDER BY cor.created_at DESC, cor.id DESC
        `,
      )
      .all() as Array<{
        id: number;
        orderId: number;
        orderNo: string;
        outboundNo: string;
        outboundStatus: CardOutboundStatus;
        cardTypeName: string;
        cardMasked: string;
        templateName: string | null;
        parentOutboundNo: string | null;
        attemptNo: number;
        createdAt: string;
      }>;

    const recycleRows = this.db
      .prepare(
        `
          SELECT
            crr.id,
            crr.recycle_action AS recycleAction,
            o.order_no AS orderNo,
            cor.outbound_no AS outboundNo,
            ct.type_name AS cardTypeName,
            cii.card_masked AS cardMasked,
            crr.reason,
            crr.created_at AS createdAt
          FROM card_recycle_records crr
          INNER JOIN orders o ON o.id = crr.order_id
          INNER JOIN card_outbound_records cor ON cor.id = crr.outbound_record_id
          INNER JOIN card_types ct ON ct.id = cor.card_type_id
          INNER JOIN card_inventory_items cii ON cii.id = crr.inventory_item_id
          ORDER BY crr.created_at DESC, crr.id DESC
        `,
      )
      .all() as Array<{
        id: number;
        recycleAction: CardRecycleAction;
        orderNo: string;
        outboundNo: string;
        cardTypeName: string;
        cardMasked: string;
        reason: string;
        createdAt: string;
      }>;

    const batchRows = this.db
      .prepare(
        `
          SELECT
            cb.id,
            cb.batch_no AS batchNo,
            ct.type_name AS cardTypeName,
            cb.source_label AS sourceLabel,
            cb.imported_count AS importedCount,
            cb.duplicate_count AS duplicateCount,
            cb.invalid_count AS invalidCount,
            COALESCE(inv.disabledCount, 0) AS disabledCount,
            COALESCE(inv.availableCount, 0) AS availableCount,
            cb.imported_at AS importedAt
          FROM card_batches cb
          INNER JOIN card_types ct ON ct.id = cb.card_type_id
          LEFT JOIN (
            SELECT
              batch_id AS batchId,
              SUM(CASE WHEN item_status = 'available' THEN 1 ELSE 0 END) AS availableCount,
              SUM(CASE WHEN item_status = 'disabled' THEN 1 ELSE 0 END) AS disabledCount
            FROM card_inventory_items
            GROUP BY batch_id
          ) inv ON inv.batchId = cb.id
          ORDER BY cb.imported_at DESC, cb.id DESC
        `,
      )
      .all() as Array<{
        id: number;
        batchNo: string;
        cardTypeName: string;
        sourceLabel: string;
        importedCount: number;
        duplicateCount: number;
        invalidCount: number;
        disabledCount: number;
        availableCount: number;
        importedAt: string;
      }>;

    const tabs = [
      { key: 'outbound', label: '出库记录', count: outboundRows.length },
      { key: 'recycle', label: '回收记录', count: recycleRows.length },
      { key: 'batch', label: '批次导入', count: batchRows.length },
    ];

    return {
      kind: 'card-records' as const,
      title: '卡密履约记录',
      description: '统一保留出库、补发、回收与导入批次，确保每次履约动作都可追溯。',
      metrics: [
        { label: '出库记录', value: outboundRows.length, unit: '条', helper: '含自动发货和补发' },
        {
          label: '补发记录',
          value: outboundRows.filter((row) => row.outboundStatus === 'resent').length,
          unit: '条',
          helper: '可回溯到原始出库单',
        },
        {
          label: '回收记录',
          value: recycleRows.length,
          unit: '条',
          helper: '包含返库与撤回禁用',
        },
        {
          label: '导入批次',
          value: batchRows.length,
          unit: '个',
          helper: '保留去重与格式校验结果',
        },
      ],
      tabs,
      outboundRows,
      recycleRows,
      batchRows,
    };
  }

  private getCardTrashDetail() {
    const rows = this.db
      .prepare(
        `
        SELECT
          id,
          type_name AS typeName,
          unsold_count AS unsoldCount,
          sold_count AS soldCount,
          total_stock AS totalStock,
          deleted_at AS deletedAt,
          deleted_by AS deletedBy
        FROM card_types
        WHERE is_deleted = 1
        ORDER BY deleted_at DESC, id DESC
      `,
      )
      .all() as Array<{
      id: number;
      typeName: string;
      unsoldCount: number;
      soldCount: number;
      totalStock: number;
      deletedAt: string;
      deletedBy: string;
    }>;

    return {
      kind: 'card-trash' as const,
      title: '卡种回收站',
      description: '删除的卡种保留 14 天，可在回收站直接恢复。',
      metrics: [
        { label: '回收卡种', value: rows.length, unit: '种', helper: '仍在保留期内' },
        {
          label: '可恢复库存',
          value: rows.reduce<number>((total, row) => total + Number(row.unsoldCount ?? 0), 0),
          unit: '张',
          helper: '恢复后可重新发货',
        },
        {
          label: '已售历史',
          value: rows.reduce<number>((total, row) => total + Number(row.soldCount ?? 0), 0),
          unit: '张',
          helper: '用于追踪历史订单',
        },
        { label: '清理周期', value: 14, unit: '天', helper: '超期自动清理' },
      ],
      rows,
    };
  }

  private buildFundWhere(
    filters: QueryFilters,
    range: DateRange,
    timeColumn: string,
    storeColumn?: string,
    prefix = 'fund',
  ) {
    const clauses = [`${timeColumn} >= @startDate`, `${timeColumn} <= @endDate`];
    const params: SqlParams = {
      startDate: `${range.startIso} 00:00:00`,
      endDate: `${range.endIso} 23:59:59`,
    };

    if (storeColumn) {
      this.appendStoreScopeClause(clauses, params, storeColumn, filters, prefix);
    }

    return {
      whereSql: `WHERE ${clauses.join(' AND ')}`,
      params,
    };
  }

  private calculateSettlementFee(receivedAmount: number) {
    return Number(Math.max(0.2, receivedAmount * 0.02).toFixed(2));
  }

  private getFundBillCategoryText(category: string) {
    return (
      {
        income: '收入',
        refund: '退款',
        fee: '手续费',
        withdrawal: '提现',
        adjustment: '调整',
        deposit: '保证金',
        subscription: '订购',
      }[category] ?? category
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

  private getFundSettlementStatusText(status: string) {
    return (
      {
        settled: '已结算',
        pending: '待结算',
      }[status] ?? status
    );
  }

  private getFundRefundStatusText(status: string) {
    return (
      {
        pending_review: '待审核',
        approved: '待退款',
        rejected: '已驳回',
        refunded: '已退款',
      }[status] ?? status
    );
  }

  private determineManualFundBillCategory(row: {
    merchantOrderNo: string;
    itemName: string;
    amount: number;
  }) {
    const merchantOrderNo = String(row.merchantOrderNo).toUpperCase();
    if (merchantOrderNo.startsWith('DEPOSIT-')) {
      return 'deposit';
    }
    if (merchantOrderNo.startsWith('ORDER-SUB') || merchantOrderNo.startsWith('ORDER-WX')) {
      return 'subscription';
    }
    if (String(row.itemName).includes('提现')) {
      return 'withdrawal';
    }
    return row.amount >= 0 ? 'adjustment' : 'adjustment';
  }

  private upsertFundReconciliation(input: {
    refType: string;
    refId: number;
    storeId: number | null;
    billCategory: string;
    platformAmount: number;
    ledgerAmount: number;
    note: string;
    updatedAt: string;
  }) {
    const diffAmount = Number((input.ledgerAmount - input.platformAmount).toFixed(2));
    const autoStatus = Math.abs(diffAmount) < 0.01 ? 'matched' : 'anomaly';
    const existing = this.db
      .prepare(
        `
          SELECT
            id,
            reconcile_no AS reconcileNo,
            reconcile_status AS reconcileStatus,
            manual_status AS manualStatus,
            note,
            created_at AS createdAt
          FROM fund_reconciliations
          WHERE ref_type = ? AND ref_id = ?
        `,
      )
      .get(input.refType, input.refId) as
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
      this.db
        .prepare(
          `
            UPDATE fund_reconciliations
            SET
              store_id = @storeId,
              bill_category = @billCategory,
              platform_amount = @platformAmount,
              ledger_amount = @ledgerAmount,
              diff_amount = @diffAmount,
              reconcile_status = @reconcileStatus,
              note = @note,
              updated_at = @updatedAt
            WHERE id = @id
          `,
        )
        .run({
          id: existing.id,
          storeId: input.storeId,
          billCategory: input.billCategory,
          platformAmount: input.platformAmount,
          ledgerAmount: input.ledgerAmount,
          diffAmount,
          reconcileStatus: existing.manualStatus ? existing.reconcileStatus : autoStatus,
          note: existing.manualStatus ? existing.note : input.note,
          updatedAt: input.updatedAt,
        });
      return;
    }

    this.db
      .prepare(
        `
          INSERT INTO fund_reconciliations (
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
          ) VALUES (
            @refType,
            @refId,
            @storeId,
            @reconcileNo,
            @billCategory,
            @platformAmount,
            @ledgerAmount,
            @diffAmount,
            @reconcileStatus,
            0,
            @note,
            @createdAt,
            @updatedAt
          )
        `,
      )
      .run({
        refType: input.refType,
        refId: input.refId,
        storeId: input.storeId,
        reconcileNo: `DZ${randomUUID().replace(/-/g, '').slice(0, 12).toUpperCase()}`,
        billCategory: input.billCategory,
        platformAmount: input.platformAmount,
        ledgerAmount: input.ledgerAmount,
        diffAmount,
        reconcileStatus: autoStatus,
        note: input.note,
        createdAt: input.updatedAt,
        updatedAt: input.updatedAt,
      });
  }

  private syncFundSettlements() {
    const rows = this.db
      .prepare(
        `
          SELECT
            op.id AS paymentId,
            op.order_id AS orderId,
            o.store_id AS storeId,
            o.order_no AS orderNo,
            op.payment_no AS paymentNo,
            op.gross_amount AS grossAmount,
            op.paid_amount AS receivedAmount,
            op.payment_status AS paymentStatus,
            COALESCE(op.settled_at, op.paid_at) AS settledAt,
            op.updated_at AS updatedAt
          FROM order_payments op
          INNER JOIN orders o ON o.id = op.order_id
        `,
      )
      .all() as Array<{
      paymentId: number;
      orderId: number;
      storeId: number;
      orderNo: string;
      paymentNo: string;
      grossAmount: number;
      receivedAmount: number;
      paymentStatus: string;
      settledAt: string;
      updatedAt: string;
    }>;

    const getExisting = this.db.prepare(
      `
        SELECT id
        FROM fund_settlements
        WHERE payment_id = ?
      `,
    );
    const insertSettlement = this.db.prepare(
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
    );
    const updateSettlement = this.db.prepare(
      `
        UPDATE fund_settlements
        SET
          order_id = @orderId,
          store_id = @storeId,
          order_no = @orderNo,
          payment_no = @paymentNo,
          gross_amount = @grossAmount,
          received_amount = @receivedAmount,
          fee_amount = @feeAmount,
          settled_amount = @settledAmount,
          settlement_status = @settlementStatus,
          settled_at = @settledAt,
          note = @note,
          updated_at = @updatedAt
        WHERE payment_id = @paymentId
      `,
    );

    rows.forEach((row) => {
      const feeAmount = this.calculateSettlementFee(row.receivedAmount);
      const settledAmount = Number((row.receivedAmount - feeAmount).toFixed(2));
      const settlementStatus = row.paymentStatus === 'paid' ? 'settled' : 'pending';
      const payload = {
        paymentId: row.paymentId,
        orderId: row.orderId,
        storeId: row.storeId,
        settlementNo: `JS${String(row.paymentId).padStart(6, '0')}${row.paymentNo.slice(-6)}`,
        orderNo: row.orderNo,
        paymentNo: row.paymentNo,
        grossAmount: row.grossAmount,
        receivedAmount: row.receivedAmount,
        feeAmount,
        settledAmount,
        settlementStatus,
        settledAt: row.settledAt,
        note: settlementStatus === 'settled' ? '订单实收已同步至结算账本。' : '订单待平台结算完成后入账。',
        updatedAt: row.updatedAt,
      };

      const existing = getExisting.get(row.paymentId) as { id: number } | undefined;
      if (existing) {
        updateSettlement.run(payload);
        return;
      }
      insertSettlement.run(payload);
    });
  }

  private syncFundRefunds() {
    const rows = this.db
      .prepare(
        `
          SELECT
            rf.case_id AS caseId,
            ac.order_id AS orderId,
            o.store_id AS storeId,
            rf.refund_no AS refundNo,
            ac.case_no AS caseNo,
            o.order_no AS orderNo,
            rf.requested_amount AS requestedAmount,
            rf.approved_amount AS approvedAmount,
            rf.refund_status AS refundStatus,
            rf.review_note AS note,
            rf.reviewed_at AS reviewedAt,
            rf.refunded_at AS refundedAt,
            ac.updated_at AS updatedAt
          FROM after_sale_refunds rf
          INNER JOIN after_sale_cases ac ON ac.id = rf.case_id
          INNER JOIN orders o ON o.id = ac.order_id
        `,
      )
      .all() as Array<{
      caseId: number;
      orderId: number;
      storeId: number;
      refundNo: string;
      caseNo: string;
      orderNo: string;
      requestedAmount: number;
      approvedAmount: number;
      refundStatus: string;
      note: string;
      reviewedAt: string | null;
      refundedAt: string | null;
      updatedAt: string;
    }>;

    const getExisting = this.db.prepare(
      `
        SELECT id
        FROM fund_refunds
        WHERE case_id = ?
      `,
    );
    const insertRefund = this.db.prepare(
      `
        INSERT INTO fund_refunds (
          case_id,
          order_id,
          store_id,
          refund_no,
          case_no,
          order_no,
          requested_amount,
          approved_amount,
          refunded_amount,
          refund_status,
          refund_channel,
          reviewed_at,
          refunded_at,
          note,
          updated_at
        ) VALUES (
          @caseId,
          @orderId,
          @storeId,
          @refundNo,
          @caseNo,
          @orderNo,
          @requestedAmount,
          @approvedAmount,
          @refundedAmount,
          @refundStatus,
          '原路退回',
          @reviewedAt,
          @refundedAt,
          @note,
          @updatedAt
        )
      `,
    );
    const updateRefund = this.db.prepare(
      `
        UPDATE fund_refunds
        SET
          order_id = @orderId,
          store_id = @storeId,
          refund_no = @refundNo,
          case_no = @caseNo,
          order_no = @orderNo,
          requested_amount = @requestedAmount,
          approved_amount = @approvedAmount,
          refunded_amount = @refundedAmount,
          refund_status = @refundStatus,
          reviewed_at = @reviewedAt,
          refunded_at = @refundedAt,
          note = @note,
          updated_at = @updatedAt
        WHERE case_id = @caseId
      `,
    );

    rows.forEach((row) => {
      const refundedAmount =
        row.refundStatus === 'refunded'
          ? Number((row.approvedAmount || row.requestedAmount).toFixed(2))
          : 0;
      const payload = {
        caseId: row.caseId,
        orderId: row.orderId,
        storeId: row.storeId,
        refundNo: row.refundNo,
        caseNo: row.caseNo,
        orderNo: row.orderNo,
        requestedAmount: row.requestedAmount,
        approvedAmount: row.approvedAmount,
        refundedAmount,
        refundStatus: row.refundStatus,
        reviewedAt: row.reviewedAt,
        refundedAt: row.refundedAt,
        note: row.note || '售后退款状态已同步至资金账本。',
        updatedAt: row.updatedAt,
      };

      const existing = getExisting.get(row.caseId) as { id: number } | undefined;
      if (existing) {
        updateRefund.run(payload);
        return;
      }
      insertRefund.run(payload);
    });
  }

  private syncFundReconciliations() {
    const manualBills = this.db
      .prepare(
        `
          SELECT
            id,
            store_id AS storeId,
            merchant_order_no AS merchantOrderNo,
            item_name AS itemName,
            amount,
            remark,
            trade_time AS tradeTime
          FROM fund_bills
        `,
      )
      .all() as Array<{
      id: number;
      storeId: number | null;
      merchantOrderNo: string;
      itemName: string;
      amount: number;
      remark: string;
      tradeTime: string;
    }>;

    manualBills.forEach((row) => {
      this.upsertFundReconciliation({
        refType: 'manual_bill',
        refId: row.id,
        storeId: row.storeId,
        billCategory: this.determineManualFundBillCategory(row),
        platformAmount: Math.abs(Number(row.amount)),
        ledgerAmount: Math.abs(Number(row.amount)),
        note: row.remark || '手工账单已完成记账。',
        updatedAt: row.tradeTime,
      });
    });

    const settlements = this.db
      .prepare(
        `
          SELECT
            id,
            store_id AS storeId,
            received_amount AS receivedAmount,
            fee_amount AS feeAmount,
            settled_amount AS settledAmount,
            settlement_status AS settlementStatus,
            updated_at AS updatedAt
          FROM fund_settlements
        `,
      )
      .all() as Array<{
      id: number;
      storeId: number;
      receivedAmount: number;
      feeAmount: number;
      settledAmount: number;
      settlementStatus: string;
      updatedAt: string;
    }>;

    settlements.forEach((row) => {
      const settled = row.settlementStatus === 'settled';
      this.upsertFundReconciliation({
        refType: 'settlement_income',
        refId: row.id,
        storeId: row.storeId,
        billCategory: 'income',
        platformAmount: settled ? row.receivedAmount : 0,
        ledgerAmount: row.receivedAmount,
        note: settled ? '订单收入已对平。' : '订单收入待平台结算回执。',
        updatedAt: row.updatedAt,
      });
      if (row.feeAmount > 0) {
        this.upsertFundReconciliation({
          refType: 'settlement_fee',
          refId: row.id,
          storeId: row.storeId,
          billCategory: 'fee',
          platformAmount: settled ? row.feeAmount : 0,
          ledgerAmount: row.feeAmount,
          note: settled ? '平台手续费已完成结算。' : '平台手续费待结算同步。',
          updatedAt: row.updatedAt,
        });
      }
    });

    const refunds = this.db
      .prepare(
        `
          SELECT
            id,
            store_id AS storeId,
            approved_amount AS approvedAmount,
            requested_amount AS requestedAmount,
            refunded_amount AS refundedAmount,
            refund_status AS refundStatus,
            updated_at AS updatedAt
          FROM fund_refunds
        `,
      )
      .all() as Array<{
      id: number;
      storeId: number;
      approvedAmount: number;
      requestedAmount: number;
      refundedAmount: number;
      refundStatus: string;
      updatedAt: string;
    }>;

    refunds.forEach((row) => {
      let ledgerAmount = 0;
      let platformAmount = 0;
      if (row.refundStatus === 'pending_review') {
        ledgerAmount = row.requestedAmount;
      } else if (row.refundStatus === 'approved') {
        ledgerAmount = row.approvedAmount;
      } else if (row.refundStatus === 'refunded') {
        ledgerAmount = row.refundedAmount || row.approvedAmount;
        platformAmount = ledgerAmount;
      }

      this.upsertFundReconciliation({
        refType: 'refund',
        refId: row.id,
        storeId: row.storeId,
        billCategory: 'refund',
        platformAmount,
        ledgerAmount,
        note:
          row.refundStatus === 'refunded'
            ? '退款出账已完成对平。'
            : row.refundStatus === 'rejected'
              ? '退款已驳回，无需出账。'
              : '退款待资金回执完成对账。',
        updatedAt: row.updatedAt,
      });
    });

    const withdrawals = this.db
      .prepare(
        `
          SELECT
            id,
            store_id AS storeId,
            arrival_amount AS arrivalAmount,
            fee,
            status,
            trade_time AS tradeTime
          FROM fund_withdrawals
        `,
      )
      .all() as Array<{
      id: number;
      storeId: number | null;
      arrivalAmount: number;
      fee: number;
      status: 'pending' | 'paid' | 'rejected';
      tradeTime: string;
    }>;

    withdrawals.forEach((row) => {
      const ledgerAmount = row.status === 'rejected' ? 0 : row.arrivalAmount;
      const platformAmount = row.status === 'paid' ? row.arrivalAmount : 0;
      this.upsertFundReconciliation({
        refType: 'withdrawal',
        refId: row.id,
        storeId: row.storeId,
        billCategory: 'withdrawal',
        platformAmount,
        ledgerAmount,
        note:
          row.status === 'paid'
            ? '提现打款已完成。'
            : row.status === 'rejected'
              ? '提现已驳回，无需出账。'
              : '提现待审核完成后对平。',
        updatedAt: row.tradeTime,
      });
      if (row.fee > 0) {
        this.upsertFundReconciliation({
          refType: 'withdrawal_fee',
          refId: row.id,
          storeId: row.storeId,
          billCategory: 'fee',
          platformAmount: row.status === 'paid' ? row.fee : 0,
          ledgerAmount: row.status === 'rejected' ? 0 : row.fee,
          note:
            row.status === 'paid'
              ? '提现手续费已完成记账。'
              : row.status === 'rejected'
                ? '提现已驳回，手续费不再生效。'
                : '提现手续费待审核完成后确认。',
          updatedAt: row.tradeTime,
        });
      }
    });
  }

  private syncFundCenterLedger() {
    this.db.transaction(() => {
      this.syncFundSettlements();
      this.syncFundRefunds();
      this.syncFundReconciliations();
    })();
  }

  private getFundReconciliationMap() {
    const rows = this.db
      .prepare(
        `
          SELECT
            id,
            ref_type AS refType,
            ref_id AS refId,
            reconcile_status AS reconcileStatus,
            note
          FROM fund_reconciliations
        `,
      )
      .all() as Array<{
      id: number;
      refType: string;
      refId: number;
      reconcileStatus: string;
      note: string;
    }>;

    return new Map(
      rows.map((row) => [`${row.refType}:${row.refId}`, row] as const),
    );
  }

  private getFundBillsDetailRows(filters: QueryFilters) {
    const range = this.resolveDateRange(filters);
    const reconciliationMap = this.getFundReconciliationMap();
    const manualFilter = this.buildFundWhere(filters, range, 'fb.trade_time', 'fb.store_id', 'fundBill');
    const manualRows = this.db
      .prepare(
        `
          SELECT
            fb.id,
            fb.trade_time AS tradeTime,
            fb.bill_no AS billNo,
            fb.merchant_order_no AS merchantOrderNo,
            fb.payment_no AS paymentNo,
            fb.store_id AS storeId,
            s.name AS storeName,
            fb.item_name AS itemName,
            fb.item_info AS itemInfo,
            fb.amount,
            fb.trade_type AS tradeType,
            fb.trade_method AS tradeMethod,
            fb.balance_after AS balanceAfter,
            fb.remark
          FROM fund_bills fb
          LEFT JOIN stores s ON s.id = fb.store_id
          ${manualFilter.whereSql}
        `,
      )
      .all(manualFilter.params) as Array<{
      id: number;
      tradeTime: string;
      billNo: string;
      merchantOrderNo: string;
      paymentNo: string;
      storeId: number | null;
      storeName: string | null;
      itemName: string;
      itemInfo: string;
      amount: number;
      tradeType: string;
      tradeMethod: string;
      balanceAfter: number;
      remark: string;
    }>;

    const settlementFilter = this.buildFundWhere(
      filters,
      range,
      'fs.settled_at',
      'fs.store_id',
      'fundSettlement',
    );
    const settlementRows = this.db
      .prepare(
        `
          SELECT
            fs.id,
            fs.settlement_no AS settlementNo,
            fs.order_no AS orderNo,
            fs.payment_no AS paymentNo,
            fs.store_id AS storeId,
            s.name AS storeName,
            fs.received_amount AS receivedAmount,
            fs.fee_amount AS feeAmount,
            fs.settlement_status AS settlementStatus,
            fs.settled_at AS settledAt
          FROM fund_settlements fs
          INNER JOIN stores s ON s.id = fs.store_id
          ${settlementFilter.whereSql}
        `,
      )
      .all(settlementFilter.params) as Array<{
      id: number;
      settlementNo: string;
      orderNo: string;
      paymentNo: string;
      storeId: number;
      storeName: string;
      receivedAmount: number;
      feeAmount: number;
      settlementStatus: string;
      settledAt: string;
    }>;

    const refundFilter = this.buildFundWhere(filters, range, 'fr.updated_at', 'fr.store_id', 'fundRefund');
    const refundRows = this.db
      .prepare(
        `
          SELECT
            fr.id,
            fr.refund_no AS refundNo,
            fr.case_no AS caseNo,
            fr.order_no AS orderNo,
            fr.store_id AS storeId,
            s.name AS storeName,
            fr.requested_amount AS requestedAmount,
            fr.approved_amount AS approvedAmount,
            fr.refunded_amount AS refundedAmount,
            fr.refund_status AS refundStatus,
            fr.updated_at AS updatedAt
          FROM fund_refunds fr
          INNER JOIN stores s ON s.id = fr.store_id
          ${refundFilter.whereSql}
        `,
      )
      .all(refundFilter.params) as Array<{
      id: number;
      refundNo: string;
      caseNo: string;
      orderNo: string;
      storeId: number;
      storeName: string;
      requestedAmount: number;
      approvedAmount: number;
      refundedAmount: number;
      refundStatus: string;
      updatedAt: string;
    }>;

    const withdrawalFilter = this.buildFundWhere(
      filters,
      range,
      'fw.trade_time',
      'fw.store_id',
      'fundWithdrawal',
    );
    const withdrawalRows = this.db
      .prepare(
        `
          SELECT
            fw.id,
            fw.withdrawal_no AS withdrawalNo,
            fw.trade_time AS tradeTime,
            fw.store_id AS storeId,
            s.name AS storeName,
            fw.arrival_amount AS arrivalAmount,
            fw.fee,
            fw.status,
            fw.method
          FROM fund_withdrawals fw
          LEFT JOIN stores s ON s.id = fw.store_id
          ${withdrawalFilter.whereSql}
        `,
      )
      .all(withdrawalFilter.params) as Array<{
      id: number;
      withdrawalNo: string;
      tradeTime: string;
      storeId: number | null;
      storeName: string | null;
      arrivalAmount: number;
      fee: number;
      status: 'pending' | 'paid' | 'rejected';
      method: string;
    }>;

    const rows: Array<{
      rowKey: string;
      tradeTime: string;
      billNo: string;
      merchantOrderNo: string;
      paymentNo: string;
      storeId: number | null;
      storeName: string | null;
      itemName: string;
      itemInfo: string;
      amount: number;
      billCategory: string;
      billCategoryText: string;
      tradeType: string;
      tradeMethod: string;
      balanceAfter: number | null;
      businessStatus: string;
      reconcileStatus: string;
      reconcileStatusText: string;
      reconciliationId: number | null;
      remark: string;
    }> = [];

    manualRows.forEach((row) => {
      const billCategory = this.determineManualFundBillCategory(row);
      const reconciliation = reconciliationMap.get(`manual_bill:${row.id}`);
      rows.push({
        rowKey: `manual-${row.id}`,
        tradeTime: row.tradeTime,
        billNo: row.billNo,
        merchantOrderNo: row.merchantOrderNo,
        paymentNo: row.paymentNo,
        storeId: row.storeId,
        storeName: row.storeName,
        itemName: row.itemName,
        itemInfo: row.itemInfo,
        amount: row.amount,
        billCategory,
        billCategoryText: this.getFundBillCategoryText(billCategory),
        tradeType: row.tradeType,
        tradeMethod: row.tradeMethod,
        balanceAfter: row.balanceAfter,
        businessStatus: '已记账',
        reconcileStatus: reconciliation?.reconcileStatus ?? 'matched',
        reconcileStatusText: this.getFundReconcileStatusText(
          reconciliation?.reconcileStatus ?? 'matched',
        ),
        reconciliationId: reconciliation?.id ?? null,
        remark: row.remark,
      });
    });

    settlementRows.forEach((row) => {
      const incomeReconciliation = reconciliationMap.get(`settlement_income:${row.id}`);
      rows.push({
        rowKey: `settlement-income-${row.id}`,
        tradeTime: row.settledAt,
        billNo: `${row.settlementNo}-IN`,
        merchantOrderNo: row.orderNo,
        paymentNo: row.paymentNo,
        storeId: row.storeId,
        storeName: row.storeName,
        itemName: '订单收入入账',
        itemInfo: `${row.orderNo} 结算收入`,
        amount: row.receivedAmount,
        billCategory: 'income',
        billCategoryText: this.getFundBillCategoryText('income'),
        tradeType: '入账',
        tradeMethod: '平台结算',
        balanceAfter: null,
        businessStatus: this.getFundSettlementStatusText(row.settlementStatus),
        reconcileStatus: incomeReconciliation?.reconcileStatus ?? 'matched',
        reconcileStatusText: this.getFundReconcileStatusText(
          incomeReconciliation?.reconcileStatus ?? 'matched',
        ),
        reconciliationId: incomeReconciliation?.id ?? null,
        remark: '订单实收同步入账。',
      });

      if (row.feeAmount > 0) {
        const feeReconciliation = reconciliationMap.get(`settlement_fee:${row.id}`);
        rows.push({
          rowKey: `settlement-fee-${row.id}`,
          tradeTime: row.settledAt,
          billNo: `${row.settlementNo}-FEE`,
          merchantOrderNo: row.orderNo,
          paymentNo: row.paymentNo,
          storeId: row.storeId,
          storeName: row.storeName,
          itemName: '平台手续费',
          itemInfo: `${row.orderNo} 结算手续费`,
          amount: -row.feeAmount,
          billCategory: 'fee',
          billCategoryText: this.getFundBillCategoryText('fee'),
          tradeType: '支出',
          tradeMethod: '平台结算',
          balanceAfter: null,
          businessStatus: this.getFundSettlementStatusText(row.settlementStatus),
          reconcileStatus: feeReconciliation?.reconcileStatus ?? 'matched',
          reconcileStatusText: this.getFundReconcileStatusText(
            feeReconciliation?.reconcileStatus ?? 'matched',
          ),
          reconciliationId: feeReconciliation?.id ?? null,
          remark: '平台按固定费率扣除手续费。',
        });
      }
    });

    refundRows
      .filter((row) => row.refundStatus !== 'rejected')
      .forEach((row) => {
        const reconcile = reconciliationMap.get(`refund:${row.id}`);
        const effectiveAmount =
          row.refundStatus === 'refunded'
            ? row.refundedAmount || row.approvedAmount || row.requestedAmount
            : row.approvedAmount || row.requestedAmount;
        rows.push({
          rowKey: `refund-${row.id}`,
          tradeTime: row.updatedAt,
          billNo: `TK-${row.refundNo}`,
          merchantOrderNo: row.orderNo,
          paymentNo: row.refundNo,
          storeId: row.storeId,
          storeName: row.storeName,
          itemName: '售后退款出账',
          itemInfo: `${row.caseNo} 退款处理`,
          amount: -effectiveAmount,
          billCategory: 'refund',
          billCategoryText: this.getFundBillCategoryText('refund'),
          tradeType: '支出',
          tradeMethod: '原路退回',
          balanceAfter: null,
          businessStatus: this.getFundRefundStatusText(row.refundStatus),
          reconcileStatus: reconcile?.reconcileStatus ?? 'matched',
          reconcileStatusText: this.getFundReconcileStatusText(
            reconcile?.reconcileStatus ?? 'matched',
          ),
          reconciliationId: reconcile?.id ?? null,
          remark: row.refundStatus === 'refunded' ? '退款已完成回写。' : '退款待平台回执。',
        });
      });

    withdrawalRows
      .filter((row) => row.status !== 'rejected')
      .forEach((row) => {
        const reconcile = reconciliationMap.get(`withdrawal:${row.id}`);
        rows.push({
          rowKey: `withdrawal-${row.id}`,
          tradeTime: row.tradeTime,
          billNo: `TX-${row.withdrawalNo}`,
          merchantOrderNo: row.withdrawalNo,
          paymentNo: row.withdrawalNo,
          storeId: row.storeId,
          storeName: row.storeName,
          itemName: '提现出账',
          itemInfo: `${row.withdrawalNo} 提现申请`,
          amount: -row.arrivalAmount,
          billCategory: 'withdrawal',
          billCategoryText: this.getFundBillCategoryText('withdrawal'),
          tradeType: '支出',
          tradeMethod: row.method,
          balanceAfter: null,
          businessStatus: this.getFundWithdrawalStatusText(row.status),
          reconcileStatus: reconcile?.reconcileStatus ?? 'matched',
          reconcileStatusText: this.getFundReconcileStatusText(
            reconcile?.reconcileStatus ?? 'matched',
          ),
          reconciliationId: reconcile?.id ?? null,
          remark: row.status === 'paid' ? '提现已打款完成。' : '提现待审核完成。',
        });

        if (row.fee > 0) {
          const feeReconcile = reconciliationMap.get(`withdrawal_fee:${row.id}`);
          rows.push({
            rowKey: `withdrawal-fee-${row.id}`,
            tradeTime: row.tradeTime,
            billNo: `TXF-${row.withdrawalNo}`,
            merchantOrderNo: row.withdrawalNo,
            paymentNo: row.withdrawalNo,
            storeId: row.storeId,
            storeName: row.storeName,
            itemName: '提现手续费',
            itemInfo: `${row.withdrawalNo} 手续费`,
            amount: -row.fee,
            billCategory: 'fee',
            billCategoryText: this.getFundBillCategoryText('fee'),
            tradeType: '支出',
            tradeMethod: row.method,
            balanceAfter: null,
            businessStatus: this.getFundWithdrawalStatusText(row.status),
            reconcileStatus: feeReconcile?.reconcileStatus ?? 'matched',
            reconcileStatusText: this.getFundReconcileStatusText(
              feeReconcile?.reconcileStatus ?? 'matched',
            ),
            reconciliationId: feeReconcile?.id ?? null,
            remark: row.status === 'paid' ? '提现手续费已确认。' : '提现手续费待审核确认。',
          });
        }
      });

    return rows.sort((left, right) => {
      const timeCompare = String(right.tradeTime).localeCompare(String(left.tradeTime));
      if (timeCompare !== 0) {
        return timeCompare;
      }
      return left.rowKey.localeCompare(right.rowKey);
    });
  }

  private getFundWithdrawalStatusText(status: 'pending' | 'paid' | 'rejected') {
    return (
      {
        pending: '审核中',
        paid: '已打款',
        rejected: '已驳回',
      }[status] ?? status
    );
  }

  private getFundAccountsDetail(filters: QueryFilters) {
    const range = this.resolveDateRange(filters);
    const settlementFilter = this.buildFundWhere(
      filters,
      range,
      'fs.settled_at',
      'fs.store_id',
      'fundAccountSettlement',
    );
    const refundFilter = this.buildFundWhere(
      filters,
      range,
      'fr.updated_at',
      'fr.store_id',
      'fundAccountRefund',
    );
    const withdrawalFilter = this.buildFundWhere(
      filters,
      range,
      'fw.trade_time',
      'fw.store_id',
      'fundAccountWithdrawal',
    );
    const reconciliationFilter = this.buildFundWhere(
      filters,
      range,
      'frc.updated_at',
      'frc.store_id',
      'fundAccountReconcile',
    );

    const account = this.db
      .prepare(
        `
          SELECT
            id,
            account_name AS accountName,
            available_balance AS availableBalance,
            pending_withdrawal AS pendingWithdrawal,
            frozen_balance AS frozenBalance,
            deposit_balance AS depositBalance,
            total_recharged AS totalRecharged,
            total_paid_out AS totalPaidOut,
            status,
            updated_at AS updatedAt
          FROM fund_accounts
          ORDER BY id
          LIMIT 1
        `,
      )
      .get() as
      | {
          id: number;
          accountName: string;
          availableBalance: number;
          pendingWithdrawal: number;
          frozenBalance: number;
          depositBalance: number;
          totalRecharged: number;
          totalPaidOut: number;
          status: string;
          updatedAt: string;
        }
      | undefined;

    const settlementSummary = this.db
      .prepare(
        `
          SELECT
            COUNT(*) AS settlementCount,
            SUM(settled_amount) AS settledAmount,
            SUM(fee_amount) AS feeAmount
          FROM fund_settlements fs
          ${settlementFilter.whereSql}
        `,
      )
      .get(settlementFilter.params) as {
      settlementCount: number;
      settledAmount: number | null;
      feeAmount: number | null;
    };

    const refundSummary = this.db
      .prepare(
        `
          SELECT
            SUM(
              CASE
                WHEN refund_status = 'refunded' THEN refunded_amount
                WHEN refund_status = 'approved' THEN approved_amount
                ELSE requested_amount
              END
            ) AS refundAmount
          FROM fund_refunds fr
          ${refundFilter.whereSql}
        `,
      )
      .get(refundFilter.params) as { refundAmount: number | null };

    const pendingWithdrawalSummary = this.db
      .prepare(
        `
          SELECT
            SUM(CASE WHEN status = 'pending' THEN amount ELSE 0 END) AS pendingAmount
          FROM fund_withdrawals fw
          ${withdrawalFilter.whereSql}
        `,
      )
      .get(withdrawalFilter.params) as { pendingAmount: number | null };

    const anomalySummary = this.db
      .prepare(
        `
          SELECT
            SUM(CASE WHEN reconcile_status = 'anomaly' THEN ABS(diff_amount) ELSE 0 END) AS anomalyAmount,
            SUM(CASE WHEN reconcile_status = 'anomaly' THEN 1 ELSE 0 END) AS anomalyCount
          FROM fund_reconciliations frc
          ${reconciliationFilter.whereSql}
        `,
      )
      .get(reconciliationFilter.params) as {
      anomalyAmount: number | null;
      anomalyCount: number | null;
    };

    const settlements = this.db
      .prepare(
        `
          SELECT
            fs.id,
            fs.settlement_no AS settlementNo,
            fs.order_no AS orderNo,
            fs.payment_no AS paymentNo,
            fs.store_id AS storeId,
            s.name AS storeName,
            fs.received_amount AS receivedAmount,
            fs.fee_amount AS feeAmount,
            fs.settled_amount AS settledAmount,
            fs.settlement_status AS settlementStatus,
            fs.settled_at AS settledAt
          FROM fund_settlements fs
          INNER JOIN stores s ON s.id = fs.store_id
          ${settlementFilter.whereSql}
          ORDER BY fs.settled_at DESC, fs.id DESC
          LIMIT 6
        `,
      )
      .all(settlementFilter.params) as Array<{
      id: number;
      settlementNo: string;
      orderNo: string;
      paymentNo: string;
      storeId: number;
      storeName: string;
      receivedAmount: number;
      feeAmount: number;
      settledAmount: number;
      settlementStatus: string;
      settledAt: string;
    }>;

    const refunds = this.db
      .prepare(
        `
          SELECT
            fr.id,
            fr.refund_no AS refundNo,
            fr.case_no AS caseNo,
            fr.order_no AS orderNo,
            fr.store_id AS storeId,
            s.name AS storeName,
            fr.requested_amount AS requestedAmount,
            fr.approved_amount AS approvedAmount,
            fr.refunded_amount AS refundedAmount,
            fr.refund_status AS refundStatus,
            fr.updated_at AS updatedAt
          FROM fund_refunds fr
          INNER JOIN stores s ON s.id = fr.store_id
          ${refundFilter.whereSql}
          ORDER BY fr.updated_at DESC, fr.id DESC
          LIMIT 6
        `,
      )
      .all(refundFilter.params) as Array<{
      id: number;
      refundNo: string;
      caseNo: string;
      orderNo: string;
      storeId: number;
      storeName: string;
      requestedAmount: number;
      approvedAmount: number;
      refundedAmount: number;
      refundStatus: string;
      updatedAt: string;
    }>;

    const reconciliations = this.db
      .prepare(
        `
          SELECT
            frc.id,
            frc.reconcile_no AS reconcileNo,
            frc.bill_category AS billCategory,
            frc.store_id AS storeId,
            s.name AS storeName,
            frc.platform_amount AS platformAmount,
            frc.ledger_amount AS ledgerAmount,
            frc.diff_amount AS diffAmount,
            frc.reconcile_status AS reconcileStatus,
            frc.note,
            frc.updated_at AS updatedAt
          FROM fund_reconciliations frc
          LEFT JOIN stores s ON s.id = frc.store_id
          ${reconciliationFilter.whereSql}
          ORDER BY CASE WHEN frc.reconcile_status = 'anomaly' THEN 0 ELSE 1 END, frc.updated_at DESC, frc.id DESC
          LIMIT 8
        `,
      )
      .all(reconciliationFilter.params) as Array<{
      id: number;
      reconcileNo: string;
      billCategory: string;
      storeId: number | null;
      storeName: string | null;
      platformAmount: number;
      ledgerAmount: number;
      diffAmount: number;
      reconcileStatus: string;
      note: string;
      updatedAt: string;
    }>;

    return {
      kind: 'fund-accounts' as const,
      title: '资金账户总览',
      description: '账户余额、结算收入、售后退款和对账结果在同一账本统一联动。',
      metrics: [
        {
          label: '可用余额',
          value: Number(account?.availableBalance ?? 0).toFixed(2),
          unit: '元',
          helper: '账户当前可继续支配的余额快照',
        },
        {
          label: '本期结算净收入',
          value: Number(settlementSummary.settledAmount ?? 0).toFixed(2),
          unit: '元',
          helper: `含手续费 ${Number(settlementSummary.feeAmount ?? 0).toFixed(2)} 元`,
        },
        {
          label: '本期退款支出',
          value: Number(refundSummary.refundAmount ?? 0).toFixed(2),
          unit: '元',
          helper: '含待退款和已退款金额',
        },
        {
          label: '异常对账',
          value: Number(anomalySummary.anomalyCount ?? 0),
          unit: '笔',
          helper: `差额 ${Number(anomalySummary.anomalyAmount ?? 0).toFixed(2)} 元`,
        },
      ],
      account,
      settlements: settlements.map((row) => ({
        ...row,
        settlementStatusText: this.getFundSettlementStatusText(row.settlementStatus),
      })),
      refunds: refunds.map((row) => ({
        ...row,
        refundStatusText: this.getFundRefundStatusText(row.refundStatus),
      })),
      reconciliations: reconciliations.map((row) => ({
        ...row,
        billCategoryText: this.getFundBillCategoryText(row.billCategory),
        reconcileStatusText: this.getFundReconcileStatusText(row.reconcileStatus),
      })),
      notes: [
        `当前筛选范围：${range.startIso} 至 ${range.endIso}。`,
        `待审核提现金额 ${Number(pendingWithdrawalSummary.pendingAmount ?? 0).toFixed(2)} 元，会占用可用余额。`,
        '对账状态支持标记异常、复核和恢复已对平，账单可追溯到订单付款、退款或提现来源。',
      ],
    };
  }

  private getFundBillsDetail(filters: QueryFilters) {
    const rows = this.getFundBillsDetailRows(filters);
    const account = this.db
      .prepare(
        `
          SELECT available_balance AS availableBalance
          FROM fund_accounts
          ORDER BY id
          LIMIT 1
        `,
      )
      .get() as { availableBalance: number } | undefined;
    const income = rows
      .filter((row) => Number(row.amount) > 0)
      .reduce<number>((total, row) => total + Number(row.amount), 0);
    const expense = rows
      .filter((row) => Number(row.amount) < 0)
      .reduce<number>((total, row) => total + Math.abs(Number(row.amount)), 0);

    return {
      kind: 'fund-bills' as const,
      title: '资金账单',
      description: '聚合收入、退款、手续费、提现和调整流水，并保留对账状态与来源追溯。',
      metrics: [
        { label: '入账金额', value: income.toFixed(2), unit: '元', helper: '当前筛选范围内的正向流水' },
        { label: '支出金额', value: expense.toFixed(2), unit: '元', helper: '含退款、手续费和提现' },
        {
          label: '异常账单',
          value: rows.filter((row) => row.reconcileStatus === 'anomaly').length,
          unit: '条',
          helper: '支持在工作台直接复核',
        },
        {
          label: '最新余额',
          value: Number(account?.availableBalance ?? 0).toFixed(2),
          unit: '元',
          helper: '账户余额快照',
        },
      ],
      rows,
    };
  }

  private getFundWithdrawalsDetail(filters: QueryFilters) {
    const range = this.resolveDateRange(filters);
    const withdrawalFilter = this.buildFundWhere(
      filters,
      range,
      'fw.trade_time',
      'fw.store_id',
      'fundWithdrawalDetail',
    );
    const rows = this.db
      .prepare(
        `
          SELECT
            fw.id,
            fw.withdrawal_no AS withdrawalNo,
            fw.trade_time AS tradeTime,
            fw.trade_no AS tradeNo,
            fw.store_id AS storeId,
            s.name AS storeName,
            fw.trade_type AS tradeType,
            fw.amount,
            fw.fee,
            fw.arrival_amount AS arrivalAmount,
            fw.available_balance AS availableBalance,
            fw.status,
            fw.method,
            fw.receiving_account AS receivingAccount,
            fw.review_remark AS reviewRemark
          FROM fund_withdrawals fw
          LEFT JOIN stores s ON s.id = fw.store_id
          ${withdrawalFilter.whereSql}
          ORDER BY fw.trade_time DESC, fw.id DESC
        `,
      )
      .all(withdrawalFilter.params) as Array<{
      id: number;
      withdrawalNo: string;
      tradeTime: string;
      tradeNo: string;
      storeId: number | null;
      storeName: string | null;
      tradeType: string;
      amount: number;
      fee: number;
      arrivalAmount: number;
      availableBalance: number;
      status: 'pending' | 'paid' | 'rejected';
      method: string;
      receivingAccount: string;
      reviewRemark: string;
    }>;

    return {
      kind: 'fund-withdrawals' as const,
      title: '提现申请与审核',
      description: '支持提现申请、审核状态流转，并回写到账金额、手续费和店铺维度。',
      metrics: [
        {
          label: '审核中金额',
          value: rows
            .filter((row) => row.status === 'pending')
            .reduce<number>((total, row) => total + Number(row.amount), 0)
            .toFixed(2),
          unit: '元',
          helper: '待财务处理',
        },
        {
          label: '已完成金额',
          value: rows
            .filter((row) => row.status === 'paid')
            .reduce<number>((total, row) => total + Number(row.arrivalAmount), 0)
            .toFixed(2),
          unit: '元',
          helper: '已实际到账',
        },
        {
          label: '已拒绝笔数',
          value: rows.filter((row) => row.status === 'rejected').length,
          unit: '笔',
          helper: '需要重新提交',
        },
        { label: '提现单数', value: rows.length, unit: '笔', helper: '保留完整审核轨迹' },
      ],
      rows,
    };
  }

  private getFundDepositDetail(filters: QueryFilters) {
    const range = this.resolveDateRange(filters);
    const depositFilter = this.buildFundWhere(filters, range, 'fd.trade_time', 'fd.store_id', 'fundDeposit');
    const rows = this.db
      .prepare(
        `
          SELECT
            fd.id,
            fd.deposit_type AS depositType,
            fd.store_id AS storeId,
            s.name AS storeName,
            fd.industry,
            fd.status,
            fd.amount,
            fd.operate_time AS operateTime,
            fd.action_label AS actionLabel,
            fd.trade_time AS tradeTime,
            fd.payment_no AS paymentNo,
            fd.trade_amount AS tradeAmount,
            fd.trade_type AS tradeType,
            fd.description
          FROM fund_deposits fd
          LEFT JOIN stores s ON s.id = fd.store_id
          ${depositFilter.whereSql}
          ORDER BY fd.trade_time DESC, fd.id DESC
        `,
      )
      .all(depositFilter.params) as Array<{
      id: number;
      depositType: string;
      storeId: number | null;
      storeName: string | null;
      industry: string;
      status: string;
      amount: number;
      operateTime: string;
      actionLabel: string;
      tradeTime: string;
      paymentNo: string;
      tradeAmount: number;
      tradeType: string;
      description: string;
    }>;

    return {
      kind: 'fund-deposit' as const,
      title: '保证金概览',
      description: '支持按店铺查看保证金缴退、状态和关联交易记录。',
      metrics: [
        {
          label: '保证金余额',
          value: rows.reduce<number>((total, row) => total + Number(row.amount), 0).toFixed(2),
          unit: '元',
          helper: '当前关联保证金总额',
        },
        {
          label: '退保处理中',
          value: rows.filter((row) => row.status === '退保审核中').length,
          unit: '项',
          helper: '待处理退保申请',
        },
        {
          label: '已缴纳',
          value: rows.filter((row) => row.status === '已缴纳').length,
          unit: '项',
          helper: '稳定履约中的保证金',
        },
        { label: '交易记录', value: rows.length, unit: '条', helper: '可追溯历史缴退记录' },
      ],
      overview: rows.map((row) => ({
        label: row.depositType,
        value: `${Number(row.amount).toFixed(2)} 元`,
        helper: `${row.status} · ${row.storeName ?? row.industry}`,
      })),
      rows,
    };
  }

  private getFundOrdersDetail(filters: QueryFilters) {
    const range = this.resolveDateRange(filters);
    const fundOrderFilter = this.buildFundWhere(filters, range, 'fo.paid_at', 'fo.store_id', 'fundOrder');
    const rows = this.db
      .prepare(
        `
          SELECT
            fo.id,
            fo.store_id AS storeId,
            s.name AS storeName,
            fo.created_at AS createdAt,
            fo.paid_at AS paidAt,
            fo.order_item AS orderItem,
            fo.cycle_text AS cycleText,
            fo.order_content AS orderContent,
            fo.paid_amount AS paidAmount,
            fo.merchant_order_no AS merchantOrderNo,
            fo.bill_no AS billNo,
            fo.payment_no AS paymentNo
          FROM fund_orders fo
          LEFT JOIN stores s ON s.id = fo.store_id
          ${fundOrderFilter.whereSql}
          ORDER BY fo.paid_at DESC, fo.id DESC
        `,
      )
      .all(fundOrderFilter.params) as Array<{
      id: number;
      storeId: number | null;
      storeName: string | null;
      createdAt: string;
      paidAt: string;
      orderItem: string;
      cycleText: string;
      orderContent: string;
      paidAmount: number;
      merchantOrderNo: string;
      billNo: string;
      paymentNo: string;
    }>;

    return {
      kind: 'fund-orders' as const,
      title: '订购记录',
      description: '订购记录与资金账单联动，可按店铺和时间回查账务来源。',
      metrics: [
        { label: '订购笔数', value: rows.length, unit: '笔', helper: '全部服务订购记录' },
        {
          label: '订购金额',
          value: rows.reduce<number>((total, row) => total + Number(row.paidAmount), 0).toFixed(2),
          unit: '元',
          helper: '已支付金额汇总',
        },
        {
          label: '年度服务',
          value: rows.filter((row) => String(row.cycleText).includes('年')).length,
          unit: '笔',
          helper: '按年购买的服务',
        },
        { label: '账单关联', value: rows.length, unit: '条', helper: '可直接跳转账单核对' },
      ],
      rows,
    };
  }

  private getFundAgentsDetail(filters: QueryFilters) {
    const range = this.resolveDateRange(filters);
    const agentFilter = this.buildFundWhere(filters, range, 'fa.joined_at', undefined, 'fundAgent');
    const rows = this.db
      .prepare(
        `
          SELECT
            fa.id,
            fa.member_name AS memberName,
            fa.version_name AS versionName,
            fa.user_info AS userInfo,
            fa.subscription_info AS subscriptionInfo,
            fa.discount_info AS discountInfo,
            fa.commission_text AS commissionText,
            fa.commission_status AS commissionStatus,
            fa.withdrawal_time AS withdrawalTime,
            fa.withdrawal_status AS withdrawalStatus,
            fa.withdrawal_amount AS withdrawalAmount,
            fa.joined_at AS joinedAt,
            fa.agent_level AS agentLevel
          FROM fund_agents fa
          ${agentFilter.whereSql}
          ORDER BY fa.joined_at DESC, fa.id DESC
        `,
      )
      .all(agentFilter.params) as Array<{
      id: number;
      memberName: string;
      versionName: string;
      userInfo: string;
      subscriptionInfo: string;
      discountInfo: string;
      commissionText: string;
      commissionStatus: string;
      withdrawalTime: string | null;
      withdrawalStatus: string;
      withdrawalAmount: number;
      joinedAt: string;
      agentLevel: string;
    }>;

    const tierNames = ['实习代理', '铜牌代理', '银牌代理', '金牌代理'];

    return {
      kind: 'fund-agents' as const,
      title: '代理商中心',
      description: '保留代理等级、资料完善、折扣与佣金状态几个关键区块。',
      metrics: [
        { label: '代理成员', value: rows.length, unit: '人', helper: '已进入代理链路的用户' },
        {
          label: '可提现佣金',
          value: rows
            .filter((row) => row.commissionStatus === '可提现')
            .reduce<number>((total, row) => total + Number(row.withdrawalAmount), 0)
            .toFixed(2),
          unit: '元',
          helper: '等待发起提现',
        },
        {
          label: '待完善资料',
          value: rows.filter((row) => String(row.userInfo).includes('等待完善')).length,
          unit: '人',
          helper: '需要继续引导开通',
        },
        {
          label: '已结算佣金',
          value: rows.filter((row) => row.withdrawalStatus === '已完成').length,
          unit: '笔',
          helper: '已完成历史提现',
        },
      ],
      tiers: tierNames.map((name, index) => ({
        name,
        unlocked: rows.some((row) => row.agentLevel === name) || index === 0,
        description:
          name === '实习代理'
            ? '完成实习任务后可升级并解锁佣金。'
            : `${name}对应更高折扣和更高佣金比例。`,
      })),
      rows,
    };
  }

  runWorkspaceAction(featureKey: string, actionId: number) {
    const action = this.db
      .prepare(
        'SELECT id, title, run_count AS runCount FROM workspace_actions WHERE id = ? AND feature_key = ?',
      )
      .get(actionId, featureKey) as { id: number; title: string; runCount: number } | undefined;

    if (!action) {
      return null;
    }

    const now = format(new Date(), 'yyyy-MM-dd HH:mm:ss');

    this.db
      .prepare(
        `
        UPDATE workspace_actions
        SET
          status = @status,
          run_count = run_count + 1,
          last_run_at = @lastRunAt
        WHERE id = @id AND feature_key = @featureKey
      `,
      )
      .run({
        id: actionId,
        featureKey,
        status: '已执行',
        lastRunAt: now,
      });

    const pendingTask = this.db
      .prepare(
        `
        SELECT id, title
        FROM workspace_tasks
        WHERE feature_key = ? AND status = 'todo'
        ORDER BY due_at ASC, id ASC
        LIMIT 1
      `,
      )
      .get(featureKey) as { id: number; title: string } | undefined;

    if (pendingTask) {
      this.db
        .prepare(
          `
          UPDATE workspace_tasks
          SET status = 'in_progress'
          WHERE id = ? AND feature_key = ?
        `,
        )
        .run(pendingTask.id, featureKey);
    } else {
      this.db
        .prepare(
          `
          INSERT INTO workspace_tasks (feature_key, title, description, owner, priority, status, due_at)
          VALUES (@featureKey, @title, @description, @owner, @priority, @status, @dueAt)
        `,
        )
        .run({
          featureKey,
          title: `${getWorkspaceDefinition(featureKey)?.featureLabel ?? '模块'}执行结果复核`,
          description: '本次动作执行后自动生成的复核任务，请确认结果是否符合预期。',
          owner: '系统管理员',
          priority: 'medium',
          status: 'todo',
          dueAt: format(addDays(new Date(), 1), 'yyyy-MM-dd HH:mm:ss'),
        });
    }

    this.insertWorkspaceLog(featureKey, 'action', `${action.title}已执行`, '已记录本次动作执行结果。');
    this.touchWorkspace(featureKey, now);

    return { ok: true };
  }

  toggleWorkspaceRule(featureKey: string, ruleId: number) {
    const rule = this.db
      .prepare(
        'SELECT id, name, enabled FROM workspace_rules WHERE id = ? AND feature_key = ?',
      )
      .get(ruleId, featureKey) as { id: number; name: string; enabled: number } | undefined;

    if (!rule) {
      return null;
    }

    const nextEnabled = rule.enabled ? 0 : 1;
    const now = format(new Date(), 'yyyy-MM-dd HH:mm:ss');

    this.db
      .prepare(
        `
        UPDATE workspace_rules
        SET enabled = @enabled, updated_at = @updatedAt
        WHERE id = @id AND feature_key = @featureKey
      `,
      )
      .run({
        enabled: nextEnabled,
        updatedAt: now,
        id: ruleId,
        featureKey,
      });

    this.insertWorkspaceLog(
      featureKey,
      'rule',
      `${rule.name}${nextEnabled ? '已启用' : '已停用'}`,
      nextEnabled ? '规则已重新加入当前模块执行范围。' : '规则已从当前模块执行范围中移除。',
    );
    this.touchWorkspace(featureKey, now);

    return { enabled: Boolean(nextEnabled) };
  }

  updateWorkspaceTaskStatus(featureKey: string, taskId: number, status: 'todo' | 'in_progress' | 'done') {
    const task = this.db
      .prepare(
        'SELECT id, title FROM workspace_tasks WHERE id = ? AND feature_key = ?',
      )
      .get(taskId, featureKey) as { id: number; title: string } | undefined;

    if (!task) {
      return null;
    }

    const now = format(new Date(), 'yyyy-MM-dd HH:mm:ss');

    this.db
      .prepare(
        `
        UPDATE workspace_tasks
        SET status = @status
        WHERE id = @id AND feature_key = @featureKey
      `,
      )
      .run({
        status,
        id: taskId,
        featureKey,
      });

    const statusLabel =
      {
        todo: '待处理',
        in_progress: '进行中',
        done: '已完成',
      }[status] ?? status;

    this.insertWorkspaceLog(
      featureKey,
      'task',
      `${task.title}状态已更新`,
      `任务已切换为${statusLabel}。`,
    );
    this.touchWorkspace(featureKey, now);

    return { status };
  }

  toggleCardDeliveryItem(featureKey: string, deliveryId: number) {
    if (featureKey !== 'card-delivery') {
      return null;
    }

    const row = this.db
      .prepare(
        `
        SELECT id, product_title AS productTitle, enabled, status
        FROM card_delivery_items
        WHERE id = ?
      `,
      )
      .get(deliveryId) as
      | {
          id: number;
          productTitle: string;
          enabled: number;
          status: string;
        }
      | undefined;

    if (!row) {
      return null;
    }

    const nextEnabled = row.enabled ? 0 : 1;
    const nextStatus = nextEnabled && row.status === '手动下架' ? '销售中' : row.status;
    const now = format(new Date(), 'yyyy-MM-dd HH:mm:ss');

    this.db
      .prepare(
        `
        UPDATE card_delivery_items
        SET enabled = @enabled, status = @status, updated_at = @updatedAt
        WHERE id = @id
      `,
      )
      .run({
        id: deliveryId,
        enabled: nextEnabled,
        status: nextStatus,
        updatedAt: now,
      });

    this.insertWorkspaceLog(
      featureKey,
      'delivery',
      `${row.productTitle}${nextEnabled ? '已启用发货设置' : '已停用发货设置'}`,
      nextEnabled
        ? '商品重新加入自动发货链路。'
        : '商品已从自动发货链路中移出，等待人工复核。',
    );
    this.touchWorkspace(featureKey, now);

    return { enabled: Boolean(nextEnabled) };
  }

  toggleCardComboStatus(featureKey: string, comboId: number) {
    if (featureKey !== 'card-combos') {
      return null;
    }

    const row = this.db
      .prepare(
        `
        SELECT id, combo_name AS comboName, status
        FROM card_combos
        WHERE id = ?
      `,
      )
      .get(comboId) as { id: number; comboName: string; status: string } | undefined;

    if (!row) {
      return null;
    }

    const nextStatus = row.status === '销售中' ? '手动下架' : '销售中';
    const now = format(new Date(), 'yyyy-MM-dd HH:mm:ss');

    this.db
      .prepare(
        `
        UPDATE card_combos
        SET status = @status, updated_at = @updatedAt
        WHERE id = @id
      `,
      )
      .run({
        id: comboId,
        status: nextStatus,
        updatedAt: now,
      });

    this.insertWorkspaceLog(
      featureKey,
      'combo',
      `${row.comboName}状态已更新`,
      `组合状态已切换为${nextStatus}。`,
    );
    this.touchWorkspace(featureKey, now);

    return { status: nextStatus };
  }

  toggleCardTemplateRandom(featureKey: string, templateId: number) {
    if (featureKey !== 'card-templates') {
      return null;
    }

    const row = this.db
      .prepare(
        `
        SELECT id, template_name AS templateName, random_enabled AS randomEnabled
        FROM card_templates
        WHERE id = ?
      `,
      )
      .get(templateId) as { id: number; templateName: string; randomEnabled: number } | undefined;

    if (!row) {
      return null;
    }

    const nextEnabled = row.randomEnabled ? 0 : 1;
    const now = format(new Date(), 'yyyy-MM-dd HH:mm:ss');

    this.db
      .prepare(
        `
        UPDATE card_templates
        SET random_enabled = @randomEnabled, updated_at = @updatedAt
        WHERE id = @id
      `,
      )
      .run({
        id: templateId,
        randomEnabled: nextEnabled,
        updatedAt: now,
      });

    this.insertWorkspaceLog(
      featureKey,
      'template',
      `${row.templateName}${nextEnabled ? '已加入' : '已移出'}随机模板列表`,
      nextEnabled ? '后续发货时可随机抽取该模板。' : '该模板已停止参与随机发货。',
    );
    this.touchWorkspace(featureKey, now);

    return { randomEnabled: Boolean(nextEnabled) };
  }

  restoreCardType(featureKey: string, cardTypeId: number) {
    if (featureKey !== 'card-trash') {
      return null;
    }

    const row = this.db
      .prepare(
        `
        SELECT id, type_name AS typeName, is_deleted AS isDeleted
        FROM card_types
        WHERE id = ?
      `,
      )
      .get(cardTypeId) as { id: number; typeName: string; isDeleted: number } | undefined;

    if (!row || !row.isDeleted) {
      return null;
    }

    const now = format(new Date(), 'yyyy-MM-dd HH:mm:ss');

    this.db
      .prepare(
        `
        UPDATE card_types
        SET
          is_deleted = 0,
          deleted_at = NULL,
          deleted_by = NULL,
          updated_at = @updatedAt
        WHERE id = @id
      `,
      )
      .run({
        id: cardTypeId,
        updatedAt: now,
      });

    this.insertWorkspaceLog(
      featureKey,
      'recovery',
      `${row.typeName}已恢复`,
      '卡种已从回收站恢复，并重新回到卡种列表。',
    );
    this.insertWorkspaceLog(
      'card-types',
      'inventory',
      `${row.typeName}已恢复到库存`,
      '回收站恢复操作已同步至卡种管理。',
    );
    this.touchWorkspace(featureKey, now);
    this.touchWorkspace('card-types', now);

    return { restored: true };
  }

  importCardInventory(featureKey: string, cardTypeId: number, lines: string[]) {
    if (featureKey !== 'card-delivery') {
      return null;
    }

    const now = format(new Date(), 'yyyy-MM-dd HH:mm:ss');
    const batch = this.importCardBatch(
      cardTypeId,
      lines.length > 0 ? lines : this.generateCardImportLines(cardTypeId),
      '工作台导入',
      now,
      featureKey,
    );
    if (!batch) {
      return null;
    }

    this.touchWorkspace('card-types', now);
    this.touchWorkspace('card-records', now);
    return {
      success: true,
      ...batch,
    };
  }

  toggleCardInventorySample(featureKey: string, cardTypeId: number) {
    if (!['card-delivery', 'card-types'].includes(featureKey)) {
      return null;
    }

    const row = this.db
      .prepare(
        `
          SELECT
            id,
            card_masked AS cardMasked,
            item_status AS itemStatus
          FROM card_inventory_items
          WHERE card_type_id = @cardTypeId
            AND item_status IN ('disabled', 'available')
          ORDER BY
            CASE WHEN item_status = 'disabled' THEN 0 ELSE 1 END,
            id ASC
          LIMIT 1
        `,
      )
      .get({ cardTypeId }) as
      | {
          id: number;
          cardMasked: string;
          itemStatus: CardInventoryStatus;
        }
      | undefined;

    if (!row) {
      return null;
    }

    const nextStatus: CardInventoryStatus = row.itemStatus === 'disabled' ? 'available' : 'disabled';
    const now = format(new Date(), 'yyyy-MM-dd HH:mm:ss');

    this.db
      .prepare(
        `
          UPDATE card_inventory_items
          SET
            item_status = @itemStatus,
            disabled_reason = @disabledReason,
            updated_at = @updatedAt
          WHERE id = @id
        `,
      )
      .run({
        id: row.id,
        itemStatus: nextStatus,
        disabledReason: nextStatus === 'disabled' ? '工作台手动禁用' : null,
        updatedAt: now,
      });

    const alert = this.refreshCardStockAlert(cardTypeId, now);
    const actionText = nextStatus === 'disabled' ? '禁用' : '恢复';
    this.insertWorkspaceLog(
      featureKey,
      'inventory_status',
      `样卡已${actionText}`,
      `${row.cardMasked} 已切换为${nextStatus === 'disabled' ? '禁用' : '可用'}状态。`,
    );
    this.touchWorkspace(featureKey, now);
    if (featureKey !== 'card-types') {
      this.touchWorkspace('card-types', now);
    }

    return {
      success: true,
      itemId: row.id,
      itemStatus: nextStatus,
      currentStock: alert?.availableCount ?? 0,
    };
  }

  private markCardDeliveryJobFailed(jobId: number | null, errorMessage: string, now: string) {
    if (!jobId) {
      return;
    }

    this.db
      .prepare(
        `
          UPDATE card_delivery_jobs
          SET
            job_status = 'failed',
            attempt_count = attempt_count + 1,
            error_message = @errorMessage,
            last_attempt_at = @lastAttemptAt,
            updated_at = @updatedAt
          WHERE id = @id
        `,
      )
      .run({
        id: jobId,
        errorMessage,
        lastAttemptAt: now,
        updatedAt: now,
      });
  }

  private markCardDeliveryJobSuccess(jobId: number | null, outboundRecordId: number, now: string) {
    if (!jobId) {
      return;
    }

    this.db
      .prepare(
        `
          UPDATE card_delivery_jobs
          SET
            job_status = 'success',
            latest_outbound_record_id = @outboundRecordId,
            error_message = NULL,
            last_attempt_at = @lastAttemptAt,
            updated_at = @updatedAt,
            attempt_count = CASE
              WHEN attempt_count < 1 THEN 1
              ELSE attempt_count
            END
          WHERE id = @id
        `,
      )
      .run({
        id: jobId,
        outboundRecordId,
        lastAttemptAt: now,
        updatedAt: now,
      });
  }

  private performCardOrderFulfillment(orderId: number, jobId: number | null, now: string) {
    const context = this.getCardFulfillmentContext(orderId);
    if (!context) {
      return null;
    }

    if (!context.cardTypeId || !context.cardTypeName || !context.deliveryId) {
      const errorMessage = '订单未绑定卡密发货配置。';
      this.markCardDeliveryJobFailed(jobId, errorMessage, now);
      return { success: false, errorMessage };
    }

    const cardTypeId = context.cardTypeId;
    const cardTypeName = context.cardTypeName;

    if (context.quantity !== 1) {
      const errorMessage = '当前版本仅支持单卡订单自动履约。';
      this.markCardDeliveryJobFailed(jobId, errorMessage, now);
      return { success: false, errorMessage };
    }

    if (!context.deliveryEnabled || context.deliveryItemStatus !== '销售中') {
      const errorMessage = '发货配置未启用，订单已转入人工处理。';
      this.markCardDeliveryJobFailed(jobId, errorMessage, now);
      this.db
        .prepare(
          `
            UPDATE orders
            SET
              delivery_status = 'manual_review',
              main_status = 'processing',
              updated_at = @updatedAt
            WHERE id = @id
          `,
        )
        .run({
          id: orderId,
          updatedAt: now,
        });
      return { success: false, errorMessage };
    }

    const existingOutbound = this.db
      .prepare(
        `
          SELECT
            cor.id,
            cor.outbound_no AS outboundNo,
            cor.outbound_status AS outboundStatus,
            cor.attempt_no AS attemptNo,
            cii.card_masked AS cardMasked
          FROM card_outbound_records cor
          INNER JOIN card_inventory_items cii ON cii.id = cor.inventory_item_id
          WHERE cor.order_id = ?
            AND cor.outbound_status IN ('sent', 'resent')
          ORDER BY cor.id DESC
          LIMIT 1
        `,
      )
      .get(orderId) as
      | {
          id: number;
          outboundNo: string;
          outboundStatus: CardOutboundStatus;
          attemptNo: number;
          cardMasked: string;
        }
      | undefined;

    if (existingOutbound) {
      this.markCardDeliveryJobSuccess(jobId, existingOutbound.id, now);
      return {
        success: true,
        idempotent: true,
        outboundRecord: existingOutbound,
      };
    }

    const inventory = this.db
      .prepare(
        `
          SELECT
            id,
            card_no AS cardNo,
            card_secret AS cardSecret,
            card_masked AS cardMasked
          FROM card_inventory_items
          WHERE card_type_id = @cardTypeId
            AND item_status = 'available'
          ORDER BY imported_at ASC, id ASC
          LIMIT 1
        `,
      )
        .get({
          cardTypeId,
        }) as
      | {
          id: number;
          cardNo: string;
          cardSecret: string;
          cardMasked: string;
        }
      | undefined;

    if (!inventory) {
      const errorMessage = '库存不足，无法完成自动发货。';
      this.markCardDeliveryJobFailed(jobId, errorMessage, now);
      this.db
        .prepare(
          `
            UPDATE orders
            SET
              delivery_status = 'manual_review',
              main_status = 'processing',
              updated_at = @updatedAt
            WHERE id = @id
          `,
        )
        .run({
          id: orderId,
          updatedAt: now,
        });
      this.refreshCardStockAlert(context.cardTypeId, now);
      return { success: false, errorMessage };
    }

    const template = this.selectCardTemplate();
    const outboundNo = `OUT-${format(new Date(now.replace(' ', 'T')), 'yyyyMMddHHmmss')}-${String(orderId).padStart(4, '0')}`;
    const messageContent = this.buildCardDeliveryMessage({
      orderNo: context.orderNo,
      cardTypeName: context.cardTypeName,
      cardNo: inventory.cardNo,
      cardSecret: inventory.cardSecret,
      templateContent: template?.templateContent ?? '卡密已自动发货，请注意查收。',
    });

    const result = this.db.transaction(() => {
      this.db
        .prepare(
          `
            UPDATE card_inventory_items
            SET
              item_status = 'sold',
              locked_order_id = @orderId,
              locked_at = @lockedAt,
              updated_at = @updatedAt,
              last_used_at = @lastUsedAt
            WHERE id = @id
          `,
        )
        .run({
          id: inventory.id,
          orderId,
          lockedAt: now,
          updatedAt: now,
          lastUsedAt: now,
        });

      const outboundInsert = this.db
        .prepare(
          `
            INSERT INTO card_outbound_records (
              order_id,
              card_type_id,
              inventory_item_id,
              outbound_no,
              outbound_status,
              attempt_no,
              parent_outbound_id,
              template_id,
              message_content,
              send_channel,
              created_at,
              updated_at
            ) VALUES (
              @orderId,
              @cardTypeId,
              @inventoryItemId,
              @outboundNo,
              'sent',
              1,
              NULL,
              @templateId,
              @messageContent,
              '站内消息',
              @createdAt,
              @updatedAt
            )
          `,
        )
        .run({
          orderId,
          cardTypeId,
          inventoryItemId: inventory.id,
          outboundNo,
          templateId: template?.id ?? null,
          messageContent,
          createdAt: now,
          updatedAt: now,
        });
      const outboundRecordId = Number(outboundInsert.lastInsertRowid);

      this.db
        .prepare(
          `
            UPDATE card_inventory_items
            SET outbound_record_id = @outboundRecordId
            WHERE id = @id
          `,
        )
        .run({
          id: inventory.id,
          outboundRecordId,
        });

      this.db
        .prepare(
          `
            UPDATE orders
            SET
              order_status = 'shipped',
              delivery_status = 'delivered',
              main_status = CASE
                WHEN after_sale_status = 'processing' THEN 'after_sale'
                ELSE 'fulfilled'
              END,
              shipped_at = COALESCE(shipped_at, @shippedAt),
              updated_at = @updatedAt,
              delivery_hours = CASE
                WHEN paid_at IS NULL THEN delivery_hours
                ELSE ROUND((julianday(@updatedAt) - julianday(paid_at)) * 24, 1)
              END
            WHERE id = @id
          `,
        )
        .run({
          id: orderId,
          shippedAt: now,
          updatedAt: now,
        });

      this.appendOrderEvent(
        orderId,
        'card_delivered',
        '卡密自动发货成功',
        `${cardTypeName} 已自动发货，出库单号 ${outboundNo}。`,
        '卡密发货引擎',
        now,
      );
      this.refreshCardStockAlert(cardTypeId, now);
      this.markCardDeliveryJobSuccess(jobId, outboundRecordId, now);

      return {
        id: outboundRecordId,
        outboundNo,
        outboundStatus: 'sent' as CardOutboundStatus,
        attemptNo: 1,
        cardMasked: inventory.cardMasked,
        templateName: template?.templateName ?? '默认模板',
      };
    })();

    return {
      success: true,
      idempotent: false,
      outboundRecord: result,
    };
  }

  fulfillCardOrder(featureKey: string, orderId: number) {
    if (featureKey !== 'card-delivery') {
      return null;
    }

    const now = format(new Date(), 'yyyy-MM-dd HH:mm:ss');
    const context = this.getCardFulfillmentContext(orderId);
    if (!context?.cardTypeId) {
      return null;
    }

    const jobId = this.ensureCardDeliveryJobRecord(orderId, context.cardTypeId, 'auto_fulfill', now);
    const result = this.performCardOrderFulfillment(orderId, jobId, now);
    if (!result) {
      return null;
    }

    this.insertWorkspaceLog(
      featureKey,
      result.success ? 'delivery_success' : 'delivery_failed',
      result.success ? `${context.orderNo} 已完成卡密发货` : `${context.orderNo} 卡密发货失败`,
      result.success
        ? `订单 ${context.orderNo} 已进入自动交付链路。`
        : result.errorMessage ?? '系统未返回失败原因。',
    );
    this.touchWorkspace(featureKey, now);
    this.touchWorkspace('card-records', now);

    return result;
  }

  runCardDeliveryJob(featureKey: string, jobId: number) {
    if (featureKey !== 'card-delivery') {
      return null;
    }

    const row = this.db
      .prepare(
        `
          SELECT id, order_id AS orderId
          FROM card_delivery_jobs
          WHERE id = ?
        `,
      )
      .get(jobId) as { id: number; orderId: number } | undefined;

    if (!row) {
      return null;
    }

    const now = format(new Date(), 'yyyy-MM-dd HH:mm:ss');
    const result = this.performCardOrderFulfillment(row.orderId, row.id, now);
    if (!result) {
      return null;
    }

    this.insertWorkspaceLog(
      featureKey,
      result.success ? 'delivery_job' : 'delivery_retry_failed',
      result.success ? `发货任务 #${jobId} 已执行` : `发货任务 #${jobId} 执行失败`,
      result.success ? '任务已完成自动履约。' : result.errorMessage ?? '系统未返回失败原因。',
    );
    this.touchWorkspace(featureKey, now);
    this.touchWorkspace('card-records', now);

    return result;
  }

  resendCardOutbound(featureKey: string, outboundRecordId: number) {
    if (featureKey !== 'card-records') {
      return null;
    }

    const row = this.db
      .prepare(
        `
          SELECT
            cor.id,
            cor.order_id AS orderId,
            cor.card_type_id AS cardTypeId,
            cor.inventory_item_id AS inventoryItemId,
            cor.outbound_no AS outboundNo,
            cor.outbound_status AS outboundStatus,
            cor.attempt_no AS attemptNo,
            cor.template_id AS templateId,
            cor.message_content AS messageContent,
            o.order_no AS orderNo,
            ct.type_name AS cardTypeName,
            cii.card_masked AS cardMasked
          FROM card_outbound_records cor
          INNER JOIN orders o ON o.id = cor.order_id
          INNER JOIN card_types ct ON ct.id = cor.card_type_id
          INNER JOIN card_inventory_items cii ON cii.id = cor.inventory_item_id
          WHERE cor.id = ?
        `,
      )
      .get(outboundRecordId) as
      | {
          id: number;
          orderId: number;
          cardTypeId: number;
          inventoryItemId: number;
          outboundNo: string;
          outboundStatus: CardOutboundStatus;
          attemptNo: number;
          templateId: number | null;
          messageContent: string;
          orderNo: string;
          cardTypeName: string;
          cardMasked: string;
        }
      | undefined;

    if (!row || ['recycled', 'revoked'].includes(row.outboundStatus)) {
      return null;
    }

    const nextAttempt = this.db
      .prepare(
        `
          SELECT COALESCE(MAX(attempt_no), 0) + 1 AS nextAttempt
          FROM card_outbound_records
          WHERE order_id = ?
        `,
      )
      .get(row.orderId) as { nextAttempt: number };
    const now = format(new Date(), 'yyyy-MM-dd HH:mm:ss');
    const resendNo = `${row.outboundNo}-R${nextAttempt.nextAttempt}`;

    const resendRecord = this.db.transaction(() => {
      const insertResult = this.db
        .prepare(
          `
            INSERT INTO card_outbound_records (
              order_id,
              card_type_id,
              inventory_item_id,
              outbound_no,
              outbound_status,
              attempt_no,
              parent_outbound_id,
              template_id,
              message_content,
              send_channel,
              reason,
              created_at,
              updated_at
            ) VALUES (
              @orderId,
              @cardTypeId,
              @inventoryItemId,
              @outboundNo,
              'resent',
              @attemptNo,
              @parentOutboundId,
              @templateId,
              @messageContent,
              '站内消息',
              '售后补发',
              @createdAt,
              @updatedAt
            )
          `,
        )
        .run({
          orderId: row.orderId,
          cardTypeId: row.cardTypeId,
          inventoryItemId: row.inventoryItemId,
          outboundNo: resendNo,
          attemptNo: nextAttempt.nextAttempt,
          parentOutboundId: row.id,
          templateId: row.templateId,
          messageContent: `${row.messageContent}\n补发批次：第 ${nextAttempt.nextAttempt} 次`,
          createdAt: now,
          updatedAt: now,
        });

      this.appendOrderEvent(
        row.orderId,
        'card_resent',
        '卡密补发完成',
        `补发基于原出库单 ${row.outboundNo} 生成，补发单号 ${resendNo}。`,
        '卡密发货引擎',
        now,
      );

      return {
        id: Number(insertResult.lastInsertRowid),
        outboundNo: resendNo,
        attemptNo: nextAttempt.nextAttempt,
        parentOutboundNo: row.outboundNo,
        cardMasked: row.cardMasked,
      };
    })();

    this.insertWorkspaceLog(
      featureKey,
      'delivery_resend',
      `${row.orderNo} 已完成卡密补发`,
      `补发单 ${resendNo} 已关联原出库单 ${row.outboundNo}。`,
    );
    this.touchWorkspace(featureKey, now);

    return {
      success: true,
      resendRecord,
    };
  }

  recycleCardOutbound(featureKey: string, outboundRecordId: number, action: CardRecycleAction) {
    if (featureKey !== 'card-records') {
      return null;
    }

    const row = this.db
      .prepare(
        `
          SELECT
            cor.id,
            cor.order_id AS orderId,
            cor.card_type_id AS cardTypeId,
            cor.inventory_item_id AS inventoryItemId,
            cor.outbound_no AS outboundNo,
            cor.outbound_status AS outboundStatus,
            o.order_no AS orderNo,
            ct.type_name AS cardTypeName
          FROM card_outbound_records cor
          INNER JOIN orders o ON o.id = cor.order_id
          INNER JOIN card_types ct ON ct.id = cor.card_type_id
          WHERE cor.id = ?
        `,
      )
      .get(outboundRecordId) as
      | {
          id: number;
          orderId: number;
          cardTypeId: number;
          inventoryItemId: number;
          outboundNo: string;
          outboundStatus: CardOutboundStatus;
          orderNo: string;
          cardTypeName: string;
        }
      | undefined;

    if (!row || ['recycled', 'revoked'].includes(row.outboundStatus)) {
      return null;
    }

    const now = format(new Date(), 'yyyy-MM-dd HH:mm:ss');
    const recycleReason = action === 'recycle' ? '售后回收返库' : '人工撤回并禁用原卡';
    const nextStatus: CardOutboundStatus = action === 'recycle' ? 'recycled' : 'revoked';

    const recycleRecord = this.db.transaction(() => {
      this.db
        .prepare(
          `
            UPDATE card_outbound_records
            SET
              outbound_status = @outboundStatus,
              reason = @reason,
              updated_at = @updatedAt
            WHERE id = @id
          `,
        )
        .run({
          id: row.id,
          outboundStatus: nextStatus,
          reason: recycleReason,
          updatedAt: now,
        });

      this.db
        .prepare(
          `
            UPDATE card_inventory_items
            SET
              item_status = @itemStatus,
              locked_order_id = NULL,
              locked_at = NULL,
              outbound_record_id = @outboundRecordId,
              disabled_reason = @disabledReason,
              updated_at = @updatedAt
            WHERE id = @id
          `,
        )
        .run({
          id: row.inventoryItemId,
          itemStatus: action === 'recycle' ? 'available' : 'disabled',
          outboundRecordId: action === 'recycle' ? null : row.id,
          disabledReason: action === 'revoke' ? recycleReason : null,
          updatedAt: now,
        });

      const recycleInsert = this.db
        .prepare(
          `
            INSERT INTO card_recycle_records (
              order_id,
              outbound_record_id,
              inventory_item_id,
              recycle_action,
              reason,
              created_at
            ) VALUES (
              @orderId,
              @outboundRecordId,
              @inventoryItemId,
              @recycleAction,
              @reason,
              @createdAt
            )
          `,
        )
        .run({
          orderId: row.orderId,
          outboundRecordId: row.id,
          inventoryItemId: row.inventoryItemId,
          recycleAction: action,
          reason: recycleReason,
          createdAt: now,
        });

      this.db
        .prepare(
          `
            UPDATE orders
            SET
              delivery_status = 'manual_review',
              main_status = 'processing',
              updated_at = @updatedAt
            WHERE id = @id
          `,
        )
        .run({
          id: row.orderId,
          updatedAt: now,
        });

      this.db
        .prepare(
          `
            UPDATE card_delivery_jobs
            SET
              job_status = 'recycled',
              updated_at = @updatedAt
            WHERE order_id = @orderId
              AND job_type = 'auto_fulfill'
          `,
        )
        .run({
          orderId: row.orderId,
          updatedAt: now,
        });

      this.appendOrderEvent(
        row.orderId,
        action === 'recycle' ? 'card_recycled' : 'card_revoked',
        action === 'recycle' ? '卡密已回收返库' : '卡密已撤回禁用',
        `${row.outboundNo} 已执行${action === 'recycle' ? '回收返库' : '撤回禁用'}。`,
        '卡密发货引擎',
        now,
      );
      this.refreshCardStockAlert(row.cardTypeId, now);

      return {
        id: Number(recycleInsert.lastInsertRowid),
        recycleAction: action,
        outboundNo: row.outboundNo,
      };
    })();

    this.insertWorkspaceLog(
      featureKey,
      'delivery_recycle',
      `${row.orderNo} 已执行${action === 'recycle' ? '回收' : '撤回'}`,
      `${row.outboundNo} 已写入${action === 'recycle' ? '回收' : '撤回'}记录。`,
    );
    this.touchWorkspace(featureKey, now);
    this.touchWorkspace('card-delivery', now);

    return {
      success: true,
      recycleRecord,
    };
  }

  createFundWithdrawal(input: {
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

    const account = this.db
      .prepare(
        `
          SELECT
            id,
            available_balance AS availableBalance,
            pending_withdrawal AS pendingWithdrawal
          FROM fund_accounts
          ORDER BY id
          LIMIT 1
        `,
      )
      .get() as
      | {
          id: number;
          availableBalance: number;
          pendingWithdrawal: number;
        }
      | undefined;

    if (!account || amount > Number(account.availableBalance)) {
      return null;
    }

    const nextId = this.db
      .prepare('SELECT COALESCE(MAX(id), 0) + 1 AS id FROM fund_withdrawals')
      .get() as { id: number };
    const now = format(new Date(), 'yyyy-MM-dd HH:mm:ss');
    const serial = now.replace(/[-:\s]/g, '').slice(0, 12);
    const fee = Number(Math.max(2, amount * 0.015).toFixed(2));
    const arrivalAmount = Number(Math.max(0, amount - fee).toFixed(2));
    if (arrivalAmount <= 0) {
      return null;
    }

    this.db.transaction(() => {
      this.db
        .prepare(
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
            ) VALUES (
              @id,
              @withdrawalNo,
              @tradeTime,
              @tradeNo,
              @storeId,
              @tradeType,
              @amount,
              @fee,
              @arrivalAmount,
              @availableBalance,
              'pending',
              @method,
              @receivingAccount,
              @reviewRemark
            )
          `,
        )
        .run({
          id: nextId.id,
          withdrawalNo: `TX${serial}${String(nextId.id).padStart(3, '0')}`,
          tradeTime: now,
          tradeNo: `CAP${serial}${String(nextId.id).padStart(3, '0')}`,
          storeId: input.storeId ?? null,
          tradeType: '余额提现',
          amount,
          fee,
          arrivalAmount,
          availableBalance: Number((account.availableBalance - amount).toFixed(2)),
          method: input.method,
          receivingAccount: input.receivingAccount,
          reviewRemark: '已提交提现申请，等待财务审核。',
        });

      this.db
        .prepare(
          `
            UPDATE fund_accounts
            SET
              available_balance = @availableBalance,
              pending_withdrawal = @pendingWithdrawal,
              updated_at = @updatedAt
            WHERE id = @id
          `,
        )
        .run({
          id: account.id,
          availableBalance: Number((account.availableBalance - amount).toFixed(2)),
          pendingWithdrawal: Number((account.pendingWithdrawal + amount).toFixed(2)),
          updatedAt: now,
        });

      this.insertWorkspaceLog(
        input.featureKey,
        'withdrawal',
        '新增提现申请',
        `提现 ${amount.toFixed(2)} 元已进入审核队列。`,
      );
      this.touchWorkspace(input.featureKey, now);
      this.touchWorkspace('fund-accounts', now);
    })();

    this.syncFundCenterLedger();

    return {
      success: true,
      status: 'pending' as const,
    };
  }

  updateFundWithdrawalStatus(featureKey: string, withdrawalId: number, status: 'pending' | 'paid' | 'rejected') {
    if (featureKey !== 'fund-withdrawals') {
      return null;
    }

    const row = this.db
      .prepare(
        `
        SELECT
          id,
          withdrawal_no AS withdrawalNo,
          amount,
          arrival_amount AS arrivalAmount,
          status
        FROM fund_withdrawals
        WHERE id = ?
      `,
      )
      .get(withdrawalId) as
      | {
          id: number;
          withdrawalNo: string;
          amount: number;
          arrivalAmount: number;
          status: 'pending' | 'paid' | 'rejected';
        }
      | undefined;

    if (!row) {
      return null;
    }

    if (row.status === status) {
      return { status };
    }

    const now = format(new Date(), 'yyyy-MM-dd HH:mm:ss');
    const account = this.db
      .prepare(
        `
        SELECT
          id,
          available_balance AS availableBalance,
          pending_withdrawal AS pendingWithdrawal,
          total_paid_out AS totalPaidOut
        FROM fund_accounts
        ORDER BY id
        LIMIT 1
      `,
      )
      .get() as
      | {
          id: number;
          availableBalance: number;
          pendingWithdrawal: number;
          totalPaidOut: number;
        }
      | undefined;

    this.db
      .prepare(
        `
        UPDATE fund_withdrawals
        SET status = @status, review_remark = @reviewRemark
        WHERE id = @id
      `,
      )
      .run({
        id: withdrawalId,
        status,
        reviewRemark:
          status === 'paid'
            ? '财务已放款，等待收款账户回执。'
            : status === 'rejected'
              ? '已驳回并释放冻结金额。'
              : '已重新回到待审核队列。',
      });

    if (account) {
      let nextAvailable = account.availableBalance;
      let nextPending = account.pendingWithdrawal;
      let nextTotalPaidOut = account.totalPaidOut;

      if (row.status === 'pending') {
        nextPending = Math.max(0, Number((nextPending - row.amount).toFixed(2)));
      } else if (row.status === 'rejected') {
        nextAvailable = Number((nextAvailable - row.amount).toFixed(2));
      } else if (row.status === 'paid') {
        nextTotalPaidOut = Number((nextTotalPaidOut - row.arrivalAmount).toFixed(2));
      }

      if (status === 'pending') {
        nextPending = Number((nextPending + row.amount).toFixed(2));
      } else if (status === 'rejected') {
        nextAvailable = Number((nextAvailable + row.amount).toFixed(2));
      } else if (status === 'paid') {
        nextTotalPaidOut = Number((nextTotalPaidOut + row.arrivalAmount).toFixed(2));
      }

      this.db
        .prepare(
          `
          UPDATE fund_accounts
          SET
            available_balance = @availableBalance,
            pending_withdrawal = @pendingWithdrawal,
            total_paid_out = @totalPaidOut,
            updated_at = @updatedAt
          WHERE id = @id
        `,
        )
        .run({
          id: account.id,
          availableBalance: nextAvailable,
          pendingWithdrawal: nextPending,
          totalPaidOut: nextTotalPaidOut,
          updatedAt: now,
        });
    }

    const statusLabel =
      {
        pending: '审核中',
        paid: '已完成',
        rejected: '已拒绝',
      }[status] ?? status;

    this.insertWorkspaceLog(
      featureKey,
      'withdrawal',
      `${row.withdrawalNo}状态已更新`,
      `提现状态已切换为${statusLabel}。`,
    );
    this.touchWorkspace(featureKey, now);
    this.touchWorkspace('fund-accounts', now);
    this.touchWorkspace('fund-bills', now);
    this.syncFundCenterLedger();

    return { status };
  }

  updateFundReconciliationStatus(
    featureKey: string,
    reconciliationId: number,
    status: 'matched' | 'anomaly' | 'reviewed',
    note?: string,
  ) {
    if (!['fund-accounts', 'fund-bills'].includes(featureKey)) {
      return null;
    }

    const row = this.db
      .prepare(
        `
          SELECT
            id,
            reconcile_no AS reconcileNo,
            note
          FROM fund_reconciliations
          WHERE id = ?
        `,
      )
      .get(reconciliationId) as
      | {
          id: number;
          reconcileNo: string;
          note: string;
        }
      | undefined;

    if (!row) {
      return null;
    }

    const now = format(new Date(), 'yyyy-MM-dd HH:mm:ss');
    this.db
      .prepare(
        `
          UPDATE fund_reconciliations
          SET
            reconcile_status = @status,
            manual_status = 1,
            note = @note,
            reviewed_at = @reviewedAt,
            updated_at = @updatedAt
          WHERE id = @id
        `,
      )
      .run({
        id: reconciliationId,
        status,
        note: note ?? row.note,
        reviewedAt: now,
        updatedAt: now,
      });

    this.insertWorkspaceLog(
      featureKey,
      'reconcile',
      `${row.reconcileNo} 对账状态已更新`,
      `对账状态已切换为 ${this.getFundReconcileStatusText(status)}。`,
    );
    this.touchWorkspace(featureKey, now);
    this.touchWorkspace('fund-accounts', now);
    this.touchWorkspace('fund-bills', now);

    return { status };
  }

  generateAiServiceReply(
    featureKey: string,
    conversationId: number,
    operator: { id: number; displayName: string },
  ) {
    if (featureKey !== 'ai-service') {
      return null;
    }

    const settings = this.getAiServiceSettingsRow();
    const context = this.getAiServiceConversationContext(conversationId);
    const latestCustomerMessage = this.getAiServiceLatestCustomerMessage(conversationId);
    if (!settings || !context || !latestCustomerMessage) {
      return null;
    }

    const latestOutboundMessage = this.getAiServiceLatestOutboundMessage(conversationId);
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
      context.riskLevel === 'high' ||
      sensitiveWords.some((word) => latestCustomerMessage.content.includes(word)) ||
      ['投诉', '差评', '举报', '起诉', '骗子', '赔偿', '维权'].some((word) =>
        latestCustomerMessage.content.includes(word),
      );

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
      (context.caseId !== null || /退款|售后|补发|争议|赔付/.test(latestCustomerMessage.content))
    ) {
      const suggestion = context.caseId ? this.buildAiServiceAfterSaleSuggestion(context.caseId) : null;
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
      /订单|发货|物流|到账|什么时候|状态|查询|进度/.test(latestCustomerMessage.content)
    ) {
      const reply = this.buildAiServiceOrderReply(context.orderId);
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
      {
        const knowledge = settings.faqEnabled
          ? this.findAiServiceKnowledgeMatch(latestCustomerMessage.content)
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
    }

    this.db.transaction(() => {
      const messageTime = this.appendAiServiceMessage({
        conversationId,
        senderType: replyType,
        senderName: replyType === 'ai' ? 'AI 客服' : replyType === 'suggestion' ? 'AI 建议' : '系统提示',
        scene,
        content,
        status,
        relatedKnowledgeId,
        relatedTemplateId,
        operatorUserId: operator.id,
        createdAt: now,
      });
      this.updateAiServiceConversationState(conversationId, {
        conversationStatus,
        aiStatus,
        latestUserIntent: latestCustomerMessage.content,
        boundaryLabel,
        unreadCount: 0,
        updatedAt: messageTime,
      });
    })();

    this.insertWorkspaceLog(
      featureKey,
      replyType === 'ai' ? 'ai_reply' : replyType === 'suggestion' ? 'ai_suggestion' : 'ai_blocked',
      `${context.sessionNo} 已生成${replyType === 'ai' ? '回复' : replyType === 'suggestion' ? '建议' : '人工提示'}`,
      `${operator.displayName} 触发了会话 ${context.sessionNo} 的 ${scene} 处理。`,
    );
    this.touchWorkspace(featureKey, now);

    return {
      reused: false,
      replyType,
      conversationStatus,
      aiStatus,
      content,
    };
  }

  /**
   * 获取 LLM 所需的会话上下文（会话信息、对话历史、知识库、设置等）
   */
  getAiServiceLlmContext(conversationId: number) {
    const context = this.getAiServiceConversationContext(conversationId);
    if (!context) {
      return null;
    }

    const settings = this.getAiServiceSettingsRow();
    if (!settings) {
      return null;
    }

    // 获取最近的对话消息（最多 30 条）
    const messages = this.db
      .prepare(
        `
          SELECT
            sender_type AS senderType,
            sender_name AS senderName,
            content,
            created_at AS createdAt
          FROM ai_service_messages
          WHERE conversation_id = ?
          ORDER BY id ASC
          LIMIT 30
        `,
      )
      .all(conversationId) as Array<{
      senderType: string;
      senderName: string;
      content: string;
      createdAt: string;
    }>;

    // 获取启用的知识库条目
    const knowledgeItems = this.db
      .prepare(
        `
          SELECT title, answer_text AS answerText
          FROM ai_service_knowledge_items
          WHERE enabled = 1
          ORDER BY id ASC
          LIMIT 20
        `,
      )
      .all() as Array<{ title: string; answerText: string }>;

    // 获取数据库中的 LLM API Key（解密后的原文）
    const apiKeyRow = this.db
      .prepare(
        `
          SELECT value_encrypted AS valueEncrypted
          FROM secure_settings
          WHERE key = 'openai_api_key'
          LIMIT 1
        `,
      )
      .get() as { valueEncrypted: string } | undefined;

    let dbApiKey: string | null = null;
    if (apiKeyRow?.valueEncrypted) {
      try {
        dbApiKey = decryptSecret(apiKeyRow.valueEncrypted, appConfig.secureConfigSecret);
      } catch {
        // 解密失败则忽略
      }
    }

    const sensitiveWords = this.parseAiServiceSensitiveWords(settings.sensitiveWordsText);

    return {
      conversationId,
      storeName: context.storeName ?? '未知店铺',
      customerName: context.customerName,
      topic: context.topic,
      boundaryNote: settings.boundaryNote,
      sensitiveWords,
      messages,
      knowledgeItems: knowledgeItems.map((item) => ({
        title: item.title,
        content: item.answerText,
      })),
      dbApiKey,
    };
  }

  /**
   * 将 LLM 生成的 AI 回复写入数据库，更新会话状态
   */
  writeAiServiceLlmReply(
    featureKey: string,
    conversationId: number,
    content: string,
    operator: { id: number; displayName: string },
  ) {
    if (featureKey !== 'ai-service') {
      return null;
    }

    const context = this.getAiServiceConversationContext(conversationId);
    if (!context) {
      return null;
    }

    const now = format(new Date(), 'yyyy-MM-dd HH:mm:ss');

    this.db.transaction(() => {
      const messageTime = this.appendAiServiceMessage({
        conversationId,
        senderType: 'ai',
        senderName: 'AI 客服（LLM）',
        scene: 'llm',
        content,
        status: 'pending',
        operatorUserId: operator.id,
        createdAt: now,
      });
      this.updateAiServiceConversationState(conversationId, {
        conversationStatus: 'open',
        aiStatus: 'auto_replied',
        latestUserIntent: context.latestUserIntent,
        boundaryLabel: 'LLM 智能回复',
        unreadCount: 0,
        updatedAt: messageTime,
      });
    })();

    this.insertWorkspaceLog(
      featureKey,
      'ai_reply',
      `${context.sessionNo} LLM 已生成智能回复`,
      `${operator.displayName} 触发了会话 ${context.sessionNo} 的大模型智能回复。`,
    );
    this.touchWorkspace(featureKey, now);

    return {
      reused: false,
      replyType: 'ai' as const,
      conversationStatus: 'open',
      aiStatus: 'auto_replied',
      content,
    };
  }

  updateAiServiceConversationTakeover(
    featureKey: string,
    conversationId: number,
    action: 'takeover' | 'release',
    note: string,
    operator: { id: number; displayName: string },
  ) {
    if (featureKey !== 'ai-service') {
      return null;
    }

    const context = this.getAiServiceConversationContext(conversationId);
    if (!context) {
      return null;
    }

    const now = format(new Date(), 'yyyy-MM-dd HH:mm:ss');
    const content =
      action === 'takeover'
        ? `${operator.displayName} 已接管当前会话，后续由人工继续处理。`
        : `${operator.displayName} 已释放人工接管，会话回到 AI 待处理队列。`;

    this.db.transaction(() => {
      this.appendAiServiceMessage({
        conversationId,
        senderType: 'system',
        senderName: '系统提示',
        scene: action === 'takeover' ? 'manual_takeover' : 'manual_release',
        content,
        status: 'logged',
        operatorUserId: operator.id,
        createdAt: now,
      });
      this.appendAiServiceTakeoverRecord({
        conversationId,
        actionType: action,
        operatorUserId: operator.id,
        operatorName: operator.displayName,
        note: note || content,
        createdAt: now,
      });
      this.updateAiServiceConversationState(conversationId, {
        conversationStatus: action === 'takeover' ? 'manual_active' : 'open',
        aiStatus: action === 'takeover' ? 'manual_only' : 'ready',
        assignedUserId: action === 'takeover' ? operator.id : null,
        boundaryLabel: action === 'takeover' ? '人工接管' : '恢复 AI 待处理',
        unreadCount: 0,
        updatedAt: now,
      });
    })();

    this.insertWorkspaceLog(
      featureKey,
      'takeover',
      `${context.sessionNo} ${action === 'takeover' ? '已转人工' : '已释放接管'}`,
      `${operator.displayName}${action === 'takeover' ? '接管' : '释放'}了会话 ${context.sessionNo}。`,
    );
    this.touchWorkspace(featureKey, now);

    return {
      conversationStatus: action === 'takeover' ? 'manual_active' : 'open',
      aiStatus: action === 'takeover' ? 'manual_only' : 'ready',
    };
  }

  sendAiServiceManualReply(
    featureKey: string,
    conversationId: number,
    content: string,
    closeConversation: boolean,
    operator: { id: number; displayName: string },
  ) {
    if (featureKey !== 'ai-service') {
      return null;
    }

    const context = this.getAiServiceConversationContext(conversationId);
    if (!context) {
      return null;
    }

    const now = format(new Date(), 'yyyy-MM-dd HH:mm:ss');
    const nextStatus = closeConversation ? 'resolved' : 'manual_active';

    this.db.transaction(() => {
      this.appendAiServiceMessage({
        conversationId,
        senderType: 'manual',
        senderName: operator.displayName,
        scene: 'manual_reply',
        content,
        status: 'sent',
        operatorUserId: operator.id,
        createdAt: now,
      });
      this.appendAiServiceTakeoverRecord({
        conversationId,
        actionType: 'correction',
        operatorUserId: operator.id,
        operatorName: operator.displayName,
        note: closeConversation ? '人工纠偏并关闭会话。' : '人工纠偏并继续跟进。',
        createdAt: now,
      });
      this.updateAiServiceConversationState(conversationId, {
        conversationStatus: nextStatus,
        aiStatus: 'manual_only',
        assignedUserId: operator.id,
        boundaryLabel: closeConversation ? '人工已结单' : '人工纠偏',
        unreadCount: 0,
        updatedAt: now,
      });
    })();

    this.insertWorkspaceLog(
      featureKey,
      'manual_reply',
      `${context.sessionNo} 已记录人工回复`,
      `${operator.displayName} 对会话 ${context.sessionNo} 执行了人工纠偏。`,
    );
    this.touchWorkspace(featureKey, now);

    return {
      conversationStatus: nextStatus,
      aiStatus: 'manual_only',
    };
  }

  updateAiServiceLatestOutboundMessageStatus(
    featureKey: string,
    conversationId: number,
    senderType: 'ai' | 'manual',
    status: string,
  ) {
    if (featureKey !== 'ai-service') {
      return;
    }

    this.db
      .prepare(
        `
          UPDATE ai_service_messages
          SET status = @status
          WHERE id = (
            SELECT id
            FROM ai_service_messages
            WHERE conversation_id = @conversationId
              AND sender_type = @senderType
            ORDER BY id DESC
            LIMIT 1
          )
        `,
      )
      .run({
        conversationId,
        senderType,
        status,
      });
  }

  updateAiServiceSettings(
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

    const current = this.getAiServiceSettingsRow();
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

    this.db
      .prepare(
        `
          UPDATE ai_service_settings
          SET
            ai_enabled = @aiEnabled,
            auto_reply_enabled = @autoReplyEnabled,
            faq_enabled = @faqEnabled,
            order_query_enabled = @orderQueryEnabled,
            after_sale_suggestion_enabled = @afterSaleSuggestionEnabled,
            high_risk_manual_only = @highRiskManualOnly,
            boundary_note = @boundaryNote,
            sensitive_words_text = @sensitiveWordsText,
            updated_at = @updatedAt,
            updated_by = @updatedBy
          WHERE id = 1
        `,
      )
      .run({
        aiEnabled: next.aiEnabled ? 1 : 0,
        autoReplyEnabled: next.autoReplyEnabled ? 1 : 0,
        faqEnabled: next.faqEnabled ? 1 : 0,
        orderQueryEnabled: next.orderQueryEnabled ? 1 : 0,
        afterSaleSuggestionEnabled: next.afterSaleSuggestionEnabled ? 1 : 0,
        highRiskManualOnly: next.highRiskManualOnly ? 1 : 0,
        boundaryNote: next.boundaryNote,
        sensitiveWordsText: next.sensitiveWordsText,
        updatedAt: now,
        updatedBy: operator.id,
      });

    this.insertWorkspaceLog(
      featureKey,
      'policy',
      'AI 客服策略已更新',
      `${operator.displayName} 更新了 AI 客服开关和回复边界。`,
    );
    this.touchWorkspace(featureKey, now);
    return this.getAiServiceSettingsRow();
  }

  updateAiServiceKnowledgeItemEnabled(featureKey: string, knowledgeItemId: number, enabled: boolean) {
    if (featureKey !== 'ai-service') {
      return null;
    }

    const row = this.db
      .prepare('SELECT id, title FROM ai_service_knowledge_items WHERE id = ?')
      .get(knowledgeItemId) as { id: number; title: string } | undefined;
    if (!row) {
      return null;
    }

    const now = format(new Date(), 'yyyy-MM-dd HH:mm:ss');
    this.db
      .prepare(
        `
          UPDATE ai_service_knowledge_items
          SET enabled = @enabled, updated_at = @updatedAt
          WHERE id = @id
        `,
      )
      .run({ id: knowledgeItemId, enabled: enabled ? 1 : 0, updatedAt: now });
    this.insertWorkspaceLog(
      featureKey,
      'knowledge',
      `${row.title}${enabled ? '已启用' : '已停用'}`,
      `知识库条目 ${row.title} 状态已更新。`,
    );
    this.touchWorkspace(featureKey, now);
    return { enabled };
  }

  updateAiServiceReplyTemplateEnabled(featureKey: string, templateId: number, enabled: boolean) {
    if (featureKey !== 'ai-service') {
      return null;
    }

    const row = this.db
      .prepare('SELECT id, title FROM ai_service_reply_templates WHERE id = ?')
      .get(templateId) as { id: number; title: string } | undefined;
    if (!row) {
      return null;
    }

    const now = format(new Date(), 'yyyy-MM-dd HH:mm:ss');
    this.db
      .prepare(
        `
          UPDATE ai_service_reply_templates
          SET enabled = @enabled, updated_at = @updatedAt
          WHERE id = @id
        `,
      )
      .run({ id: templateId, enabled: enabled ? 1 : 0, updatedAt: now });
    this.insertWorkspaceLog(
      featureKey,
      'template',
      `${row.title}${enabled ? '已启用' : '已停用'}`,
      `话术模板 ${row.title} 状态已更新。`,
    );
    this.touchWorkspace(featureKey, now);
    return { enabled };
  }

  private getAiBargainSessionStatusText(status: string) {
    return (
      {
        open: '待评估',
        bargaining: '议价中',
        pending_manual: '待人工接管',
        manual_active: '人工处理中',
        agreed: '已成交',
        rejected: '已拒绝',
      }[status] ?? status
    );
  }

  private getAiBargainAiStatusText(status: string) {
    return (
      {
        ready: '待议价',
        auto_countered: 'AI 已还价',
        auto_accepted: 'AI 已成交',
        auto_rejected: 'AI 已拒绝',
        manual_only: '仅人工处理',
        disabled: 'AI 已关闭',
      }[status] ?? status
    );
  }

  private getAiBargainActorTypeText(actorType: string) {
    return (
      {
        customer: '买家出价',
        ai: 'AI 议价',
        manual: '人工处理',
        system: '系统记录',
      }[actorType] ?? actorType
    );
  }

  private getAiBargainActionTypeText(actionType: string) {
    return (
      {
        buyer_offer: '买家出价',
        buyer_message: '买家消息',
        counter_offer: 'AI 还价',
        accept: '成交',
        reject: '拒绝',
        blocked: '风险拦截',
        manual_takeover: '人工接管',
        manual_release: '释放接管',
        manual_offer: '人工报价',
        manual_message: '人工回复',
      }[actionType] ?? actionType
    );
  }

  private normalizeAiBargainMessageText(text: string) {
    return text.replace(/\s+/g, ' ').trim();
  }

  private isAiBargainIntentText(text: string) {
    const normalized = this.normalizeAiBargainMessageText(text);
    if (!normalized) {
      return false;
    }

    if (
      /(最低|便宜|优惠|砍价|议价|还价|少点|少一点|再少|实价|什么价|多少|能不能|可以吗|包邮|刀|一口价)/.test(
        normalized,
      )
    ) {
      return true;
    }

    if (!/(?:¥|￥|\d)/.test(normalized)) {
      return false;
    }

    return /(卖|出|价格|报价|到手|可不可以|行不行|拍|收)/.test(normalized);
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
        /[¥￥]/.test(match[0]) ||
        /(最低|便宜|优惠|砍价|议价|还价|少点|多少|什么价|价格|报价|卖|出|刀|包邮|拍)/.test(context);
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

  private hasAiBargainLogRecord(input: {
    sessionId: number;
    actorType: string;
    actionType: string;
    offerPrice?: number | null;
    messageText: string;
    createdAt: string;
  }) {
    const row = this.db
      .prepare(
        `
          SELECT id
          FROM ai_bargain_logs
          WHERE session_id = @sessionId
            AND actor_type = @actorType
            AND action_type = @actionType
            AND message_text = @messageText
            AND created_at = @createdAt
            AND (
              (offer_price IS NULL AND @offerPrice IS NULL)
              OR offer_price = @offerPrice
            )
          LIMIT 1
        `,
      )
      .get({
        sessionId: input.sessionId,
        actorType: input.actorType,
        actionType: input.actionType,
        offerPrice: input.offerPrice ?? null,
        messageText: input.messageText,
        createdAt: input.createdAt,
      }) as { id: number } | undefined;
    return Boolean(row);
  }

  private getAiBargainSettingsRow() {
    const row = this.db
      .prepare(
        `
          SELECT
            ai_enabled AS aiEnabled,
            auto_bargain_enabled AS autoBargainEnabled,
            high_risk_manual_only AS highRiskManualOnly,
            allow_auto_accept AS allowAutoAccept,
            boundary_note AS boundaryNote,
            sensitive_words_text AS sensitiveWordsText,
            blacklist_notice AS blacklistNotice,
            updated_at AS updatedAt
          FROM ai_bargain_settings
          WHERE id = 1
        `,
      )
      .get() as
      | {
          aiEnabled: number;
          autoBargainEnabled: number;
          highRiskManualOnly: number;
          allowAutoAccept: number;
          boundaryNote: string;
          sensitiveWordsText: string;
          blacklistNotice: string;
          updatedAt: string;
        }
      | undefined;

    if (!row) {
      return null;
    }

    const secureSetting = this.db
      .prepare(
        `
          SELECT value_masked AS maskedValue
          FROM secure_settings
          WHERE key = 'openai_api_key'
        `,
      )
      .get() as { maskedValue: string } | undefined;

    return {
      aiEnabled: Boolean(row.aiEnabled),
      autoBargainEnabled: Boolean(row.autoBargainEnabled),
      highRiskManualOnly: Boolean(row.highRiskManualOnly),
      allowAutoAccept: Boolean(row.allowAutoAccept),
      boundaryNote: row.boundaryNote,
      sensitiveWordsText: row.sensitiveWordsText,
      blacklistNotice: row.blacklistNotice,
      modelKeyMasked: secureSetting?.maskedValue ?? '未配置',
      updatedAt: row.updatedAt,
    };
  }

  private getAiBargainCustomerRisk(customerId: number | null) {
    if (!customerId) {
      return {
        level: 'medium' as const,
        reason: '买家档案不完整，建议谨慎议价。',
      };
    }

    const orderSummary = this.db
      .prepare(
        `
          SELECT
            COUNT(*) AS orderCount,
            SUM(CASE WHEN after_sale_status != 'none' THEN 1 ELSE 0 END) AS afterSaleOrderCount,
            SUM(refund_amount) AS refundAmount
          FROM orders
          WHERE customer_id = ?
        `,
      )
      .get(customerId) as {
      orderCount: number | null;
      afterSaleOrderCount: number | null;
      refundAmount: number | null;
    };
    const caseSummary = this.db
      .prepare(
        `
          SELECT
            COUNT(*) AS caseCount,
            SUM(CASE WHEN case_type = 'dispute' THEN 1 ELSE 0 END) AS disputeCount
          FROM after_sale_cases ac
          INNER JOIN orders o ON o.id = ac.order_id
          WHERE o.customer_id = ?
        `,
      )
      .get(customerId) as {
      caseCount: number | null;
      disputeCount: number | null;
    };

    const orderCount = Number(orderSummary.orderCount ?? 0);
    const afterSaleOrderCount = Number(orderSummary.afterSaleOrderCount ?? 0);
    const refundAmount = Number(orderSummary.refundAmount ?? 0);
    const caseCount = Number(caseSummary.caseCount ?? 0);
    const disputeCount = Number(caseSummary.disputeCount ?? 0);

    if (disputeCount > 0 || caseCount >= 2 || refundAmount >= 50) {
      return {
        level: 'high' as const,
        reason: `近历史存在 ${caseCount} 条售后、${disputeCount} 条争议，累计退款 ${refundAmount.toFixed(2)} 元。`,
      };
    }

    if (afterSaleOrderCount > 0 || refundAmount > 0 || orderCount <= 1) {
      return {
        level: 'medium' as const,
        reason:
          orderCount <= 1
            ? '买家历史成交较少，建议保守议价。'
            : `近历史存在 ${afterSaleOrderCount} 笔售后相关订单，建议谨慎议价。`,
      };
    }

    return {
      level: 'low' as const,
      reason: '历史成交稳定，可按标准策略议价。',
    };
  }

  private getAiBargainSessionContext(sessionId: number) {
    return this.db
      .prepare(
        `
          SELECT
            bs.id,
            bs.session_no AS sessionNo,
            bs.channel,
            bs.topic,
            bs.customer_id AS customerId,
            bs.customer_name AS customerName,
            bs.store_id AS storeId,
            s.name AS storeName,
            bs.product_id AS productId,
            bs.order_id AS orderId,
            o.order_no AS orderNo,
            bs.strategy_id AS strategyId,
            bs.product_name_snapshot AS productName,
            bs.listed_price AS listedPrice,
            bs.min_price AS minPrice,
            bs.target_price AS targetPrice,
            bs.latest_buyer_offer AS latestBuyerOffer,
            bs.latest_counter_price AS latestCounterPrice,
            bs.current_round AS currentRound,
            bs.max_rounds AS maxRounds,
            bs.session_status AS sessionStatus,
            bs.ai_status AS aiStatus,
            bs.risk_level AS riskLevel,
            bs.risk_reason AS riskReason,
            bs.assigned_user_id AS assignedUserId,
            u.display_name AS assignedUserName,
            bs.boundary_label AS boundaryLabel,
            bs.tags_text AS tagsText,
            bs.last_message_at AS lastMessageAt,
            bs.created_at AS createdAt,
            bs.updated_at AS updatedAt,
            COALESCE(st.step_price, 0) AS stepPrice
          FROM ai_bargain_sessions bs
          LEFT JOIN stores s ON s.id = bs.store_id
          LEFT JOIN orders o ON o.id = bs.order_id
          LEFT JOIN users u ON u.id = bs.assigned_user_id
          LEFT JOIN ai_bargain_strategies st ON st.id = bs.strategy_id
          WHERE bs.id = ?
        `,
      )
      .get(sessionId) as
      | {
          id: number;
          sessionNo: string;
          channel: string;
          topic: string;
          customerId: number | null;
          customerName: string;
          storeId: number | null;
          storeName: string | null;
          productId: number | null;
          orderId: number | null;
          orderNo: string | null;
          strategyId: number | null;
          productName: string;
          listedPrice: number;
          minPrice: number;
          targetPrice: number;
          latestBuyerOffer: number | null;
          latestCounterPrice: number | null;
          currentRound: number;
          maxRounds: number;
          sessionStatus: string;
          aiStatus: string;
          riskLevel: string;
          riskReason: string;
          assignedUserId: number | null;
          assignedUserName: string | null;
          boundaryLabel: string;
          tagsText: string;
          lastMessageAt: string;
          createdAt: string;
          updatedAt: string;
          stepPrice: number;
        }
      | undefined;
  }

  private getAiBargainLatestBuyerLog(sessionId: number) {
    return this.db
      .prepare(
        `
          SELECT
            id,
            offer_price AS offerPrice,
            message_text AS messageText,
            created_at AS createdAt
          FROM ai_bargain_logs
          WHERE session_id = ?
            AND actor_type = 'customer'
          ORDER BY id DESC
          LIMIT 1
        `,
      )
      .get(sessionId) as
      | {
          id: number;
          offerPrice: number | null;
          messageText: string;
          createdAt: string;
        }
      | undefined;
  }

  private getAiBargainLatestOutboundLog(sessionId: number) {
    return this.db
      .prepare(
        `
          SELECT
            id,
            actor_type AS actorType,
            action_type AS actionType,
            offer_price AS offerPrice,
            message_text AS messageText,
            created_at AS createdAt
          FROM ai_bargain_logs
          WHERE session_id = ?
            AND actor_type != 'customer'
          ORDER BY id DESC
          LIMIT 1
        `,
      )
      .get(sessionId) as
      | {
          id: number;
          actorType: string;
          actionType: string;
          offerPrice: number | null;
          messageText: string;
          createdAt: string;
        }
      | undefined;
  }

  private findAiBargainTemplate(scene: string) {
    return this.db
      .prepare(
        `
          SELECT
            id,
            title,
            template_content AS templateContent
          FROM ai_bargain_templates
          WHERE enabled = 1
            AND scene = ?
          ORDER BY id ASC
          LIMIT 1
        `,
      )
      .get(scene) as
      | {
          id: number;
          title: string;
          templateContent: string;
        }
      | undefined;
  }

  private findAiBargainBlacklistHit(customerId: number | null, customerName: string) {
    return this.db
      .prepare(
        `
          SELECT
            id,
            customer_id AS customerId,
            customer_name AS customerName,
            reason
          FROM ai_bargain_blacklist
          WHERE enabled = 1
            AND (
              (customer_id IS NOT NULL AND customer_id = @customerId)
              OR customer_name = @customerName
            )
          ORDER BY id ASC
          LIMIT 1
        `,
      )
      .get({
        customerId,
        customerName,
      }) as
      | {
          id: number;
          customerId: number | null;
          customerName: string;
          reason: string;
        }
      | undefined;
  }

  private appendAiBargainLog(input: {
    sessionId: number;
    actorType: string;
    actionType: string;
    offerPrice?: number | null;
    messageText: string;
    relatedTemplateId?: number | null;
    operatorUserId?: number | null;
    createdAt?: string;
  }) {
    const createdAt = input.createdAt ?? format(new Date(), 'yyyy-MM-dd HH:mm:ss');
    this.db
      .prepare(
        `
          INSERT INTO ai_bargain_logs (
            session_id,
            actor_type,
            action_type,
            offer_price,
            message_text,
            related_template_id,
            operator_user_id,
            created_at
          ) VALUES (
            @sessionId,
            @actorType,
            @actionType,
            @offerPrice,
            @messageText,
            @relatedTemplateId,
            @operatorUserId,
            @createdAt
          )
        `,
      )
      .run({
        sessionId: input.sessionId,
        actorType: input.actorType,
        actionType: input.actionType,
        offerPrice: input.offerPrice ?? null,
        messageText: input.messageText,
        relatedTemplateId: input.relatedTemplateId ?? null,
        operatorUserId: input.operatorUserId ?? null,
        createdAt,
      });
    return createdAt;
  }

  private updateAiBargainSessionState(
    sessionId: number,
    input: {
      latestBuyerOffer?: number | null;
      latestCounterPrice?: number | null;
      currentRound?: number;
      sessionStatus: string;
      aiStatus: string;
      riskLevel?: string;
      riskReason?: string;
      assignedUserId?: number | null;
      boundaryLabel?: string;
      updatedAt?: string;
    },
  ) {
    const updatedAt = input.updatedAt ?? format(new Date(), 'yyyy-MM-dd HH:mm:ss');
    this.db
      .prepare(
        `
          UPDATE ai_bargain_sessions
          SET
            latest_buyer_offer = COALESCE(@latestBuyerOffer, latest_buyer_offer),
            latest_counter_price = @latestCounterPrice,
            current_round = COALESCE(@currentRound, current_round),
            session_status = @sessionStatus,
            ai_status = @aiStatus,
            risk_level = COALESCE(@riskLevel, risk_level),
            risk_reason = COALESCE(@riskReason, risk_reason),
            assigned_user_id = @assignedUserId,
            boundary_label = COALESCE(@boundaryLabel, boundary_label),
            last_message_at = @updatedAt,
            updated_at = @updatedAt
          WHERE id = @sessionId
        `,
      )
      .run({
        sessionId,
        latestBuyerOffer: input.latestBuyerOffer ?? null,
        latestCounterPrice: input.latestCounterPrice ?? null,
        currentRound: input.currentRound ?? null,
        sessionStatus: input.sessionStatus,
        aiStatus: input.aiStatus,
        riskLevel: input.riskLevel ?? null,
        riskReason: input.riskReason ?? null,
        assignedUserId: input.assignedUserId ?? null,
        boundaryLabel: input.boundaryLabel ?? null,
        updatedAt,
      });
    return updatedAt;
  }

  private getAiBargainDetail() {
    const settings = this.getAiBargainSettingsRow();
    const summary = this.db
      .prepare(
        `
          SELECT
            COUNT(*) AS totalSessionCount,
            SUM(CASE WHEN session_status IN ('open', 'bargaining', 'pending_manual', 'manual_active') THEN 1 ELSE 0 END) AS activeSessionCount,
            SUM(CASE WHEN session_status = 'pending_manual' THEN 1 ELSE 0 END) AS pendingManualCount,
            SUM(CASE WHEN session_status = 'agreed' THEN 1 ELSE 0 END) AS agreedCount,
            SUM(CASE WHEN risk_level = 'high' THEN 1 ELSE 0 END) AS highRiskCount
          FROM ai_bargain_sessions
        `,
      )
      .get() as Record<string, number | null>;
    const strategies = this.db
      .prepare(
        `
          SELECT
            st.id,
            st.strategy_name AS strategyName,
            st.product_id AS productId,
            st.store_id AS storeId,
            s.name AS storeName,
            st.product_name_snapshot AS productName,
            st.listed_price AS listedPrice,
            st.min_price AS minPrice,
            st.target_price AS targetPrice,
            st.step_price AS stepPrice,
            st.max_rounds AS maxRounds,
            st.enabled,
            st.risk_tags_text AS riskTagsText,
            st.updated_at AS updatedAt
          FROM ai_bargain_strategies st
          LEFT JOIN stores s ON s.id = st.store_id
          ORDER BY st.enabled DESC, st.id ASC
        `,
      )
      .all() as Array<{
      id: number;
      strategyName: string;
      productId: number | null;
      storeId: number | null;
      storeName: string | null;
      productName: string;
      listedPrice: number;
      minPrice: number;
      targetPrice: number;
      stepPrice: number;
      maxRounds: number;
      enabled: number;
      riskTagsText: string;
      updatedAt: string;
    }>;
    const sessions = this.db
      .prepare(
        `
          SELECT
            bs.id,
            bs.session_no AS sessionNo,
            bs.channel,
            bs.topic,
            bs.customer_name AS customerName,
            bs.store_id AS storeId,
            s.name AS storeName,
            bs.product_name_snapshot AS productName,
            o.order_no AS orderNo,
            bs.listed_price AS listedPrice,
            bs.min_price AS minPrice,
            bs.target_price AS targetPrice,
            bs.latest_buyer_offer AS latestBuyerOffer,
            bs.latest_counter_price AS latestCounterPrice,
            bs.current_round AS currentRound,
            bs.max_rounds AS maxRounds,
            bs.session_status AS sessionStatus,
            bs.ai_status AS aiStatus,
            bs.risk_level AS riskLevel,
            bs.risk_reason AS riskReason,
            bs.boundary_label AS boundaryLabel,
            bs.tags_text AS tagsText,
            u.display_name AS assignedUserName,
            bs.last_message_at AS lastMessageAt
          FROM ai_bargain_sessions bs
          LEFT JOIN stores s ON s.id = bs.store_id
          LEFT JOIN orders o ON o.id = bs.order_id
          LEFT JOIN users u ON u.id = bs.assigned_user_id
          ORDER BY
            CASE bs.session_status
              WHEN 'pending_manual' THEN 1
              WHEN 'manual_active' THEN 2
              WHEN 'bargaining' THEN 3
              WHEN 'open' THEN 4
              ELSE 5
            END,
            bs.last_message_at DESC,
            bs.id DESC
        `,
      )
      .all() as Array<{
      id: number;
      sessionNo: string;
      channel: string;
      topic: string;
      customerName: string;
      storeId: number | null;
      storeName: string | null;
      productName: string;
      orderNo: string | null;
      listedPrice: number;
      minPrice: number;
      targetPrice: number;
      latestBuyerOffer: number | null;
      latestCounterPrice: number | null;
      currentRound: number;
      maxRounds: number;
      sessionStatus: string;
      aiStatus: string;
      riskLevel: string;
      riskReason: string;
      boundaryLabel: string;
      tagsText: string;
      assignedUserName: string | null;
      lastMessageAt: string;
    }>;
    const logs = this.db
      .prepare(
        `
          SELECT
            l.id,
            l.session_id AS sessionId,
            s.session_no AS sessionNo,
            s.customer_name AS customerName,
            l.actor_type AS actorType,
            l.action_type AS actionType,
            l.offer_price AS offerPrice,
            l.message_text AS messageText,
            l.created_at AS createdAt
          FROM ai_bargain_logs l
          INNER JOIN ai_bargain_sessions s ON s.id = l.session_id
          ORDER BY l.created_at DESC, l.id DESC
          LIMIT 18
        `,
      )
      .all() as Array<{
      id: number;
      sessionId: number;
      sessionNo: string;
      customerName: string;
      actorType: string;
      actionType: string;
      offerPrice: number | null;
      messageText: string;
      createdAt: string;
    }>;
    const templates = this.db
      .prepare(
        `
          SELECT
            id,
            scene,
            title,
            trigger_text AS triggerText,
            template_content AS templateContent,
            enabled,
            updated_at AS updatedAt
          FROM ai_bargain_templates
          ORDER BY enabled DESC, id ASC
        `,
      )
      .all() as Array<{
      id: number;
      scene: string;
      title: string;
      triggerText: string;
      templateContent: string;
      enabled: number;
      updatedAt: string;
    }>;
    const blacklists = this.db
      .prepare(
        `
          SELECT
            id,
            customer_id AS customerId,
            customer_name AS customerName,
            reason,
            enabled,
            updated_at AS updatedAt
          FROM ai_bargain_blacklist
          ORDER BY enabled DESC, id ASC
        `,
      )
      .all() as Array<{
      id: number;
      customerId: number | null;
      customerName: string;
      reason: string;
      enabled: number;
      updatedAt: string;
    }>;

    return {
      kind: 'ai-bargain' as const,
      title: 'AI 议价工作台',
      description: '围绕底价保护、商品策略和风险识别进行受控议价，只允许在最低价红线之上自动还价。',
      metrics: [
        {
          label: '议价会话',
          value: Number(summary.totalSessionCount ?? 0),
          unit: '个',
          helper: `活跃 ${Number(summary.activeSessionCount ?? 0)} 个`,
        },
        {
          label: '待人工',
          value: Number(summary.pendingManualCount ?? 0),
          unit: '个',
          helper: '高风险和异常议价优先转人工',
        },
        {
          label: '已成交',
          value: Number(summary.agreedCount ?? 0),
          unit: '个',
          helper: '自动成交与人工成交统一留痕',
        },
        {
          label: '高风险',
          value: Number(summary.highRiskCount ?? 0),
          unit: '个',
          helper: '命中黑名单或历史风险画像',
        },
      ],
      settings,
      strategies: strategies.map((item) => ({
        ...item,
        enabled: Boolean(item.enabled),
      })),
      sessions: sessions.map((item) => ({
        ...item,
        sessionStatusText: this.getAiBargainSessionStatusText(item.sessionStatus),
        aiStatusText: this.getAiBargainAiStatusText(item.aiStatus),
        riskLevelText: this.getAiServiceRiskLevelText(item.riskLevel),
        tags: item.tagsText
          .split(/[,，]/)
          .map((tag) => tag.trim())
          .filter(Boolean),
      })),
      logs: logs.map((item) => ({
        ...item,
        actorTypeText: this.getAiBargainActorTypeText(item.actorType),
        actionTypeText: this.getAiBargainActionTypeText(item.actionType),
      })),
      templates: templates.map((item) => ({
        ...item,
        enabled: Boolean(item.enabled),
      })),
      blacklists: blacklists.map((item) => ({
        ...item,
        enabled: Boolean(item.enabled),
      })),
      notes: [
        '自动还价永远不得低于商品最低价。',
        '命中黑名单、敏感词或高风险画像的会话会直接转人工。',
        '议价日志支持回放买家出价、AI 还价、人工接管和最终结论。',
      ],
    };
  }

  syncAiServiceConversationsFromXianyuIm(input: {
    featureKey: string;
    storeId: number;
    sessions: XianyuWebBargainSession[];
    operator: { id: number; displayName: string };
    syncSource?: 'manual' | 'auto';
  }) {
    if (input.featureKey !== 'ai-service') {
      return null;
    }

    const store = this.db
      .prepare(
        `
          SELECT
            ms.id,
            ms.shop_name AS shopName,
            COALESCE(oa.owner_name, ms.nickname, ms.shop_name) AS ownerName
          FROM managed_stores ms
          LEFT JOIN store_owner_accounts oa ON oa.id = ms.owner_account_id
          WHERE ms.id = ?
        `,
      )
      .get(input.storeId) as { id: number; shopName: string; ownerName: string } | undefined;
    if (!store) {
      return null;
    }

    const settings = this.getAiServiceSettingsRow();
    const sensitiveWords = this.parseAiServiceSensitiveWords(settings?.sensitiveWordsText ?? '');
    const now = format(new Date(), 'yyyy-MM-dd HH:mm:ss');
    const result = {
      storeId: store.id,
      shopName: store.shopName,
      fetchedSessionCount: input.sessions.length,
      candidateSessionCount: 0,
      syncedConversationCount: 0,
      skippedCount: 0,
      createdConversationCount: 0,
      updatedConversationCount: 0,
      createdMessageCount: 0,
      syncedAt: now,
    };

    const upsertStore = this.db.prepare(
      `
        INSERT INTO stores (id, name, manager)
        VALUES (@id, @name, @manager)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          manager = excluded.manager
      `,
    );
    const selectProduct = this.db.prepare(
      `
        SELECT
          id,
          name
        FROM products
        WHERE id = @productId
          AND store_id = @storeId
        LIMIT 1
      `,
    );
    const selectCustomerRef = this.db.prepare(
      `
        SELECT customer_id AS customerId
        FROM customer_external_refs
        WHERE provider = 'xianyu'
          AND external_customer_id = @externalCustomerId
        LIMIT 1
      `,
    );
    const insertCustomer = this.db.prepare(
      `
        INSERT INTO customers (name, province, registered_at)
        VALUES (@name, @province, @registeredAt)
      `,
    );
    const updateCustomer = this.db.prepare(
      `
        UPDATE customers
        SET name = @name, province = @province
        WHERE id = @id
      `,
    );
    const upsertCustomerRef = this.db.prepare(
      `
        INSERT INTO customer_external_refs (provider, external_customer_id, customer_id, created_at)
        VALUES ('xianyu', @externalCustomerId, @customerId, @createdAt)
        ON CONFLICT(provider, external_customer_id) DO UPDATE SET
          customer_id = excluded.customer_id
      `,
    );
    const selectOrderByProduct = this.db.prepare(
      `
        SELECT
          id,
          order_no AS orderNo
        FROM orders
        WHERE store_id = @storeId
          AND customer_id = @customerId
          AND product_id = @productId
        ORDER BY paid_at DESC, id DESC
        LIMIT 1
      `,
    );
    const selectOrderByCustomer = this.db.prepare(
      `
        SELECT
          id,
          order_no AS orderNo
        FROM orders
        WHERE store_id = @storeId
          AND customer_id = @customerId
        ORDER BY paid_at DESC, id DESC
        LIMIT 1
      `,
    );
    const selectAfterSaleCase = this.db.prepare(
      `
        SELECT
          id,
          case_no AS caseNo
        FROM after_sale_cases
        WHERE order_id = @orderId
        ORDER BY created_at DESC, id DESC
        LIMIT 1
      `,
    );
    const selectConversation = this.db.prepare(
      `
        SELECT
          id,
          conversation_status AS conversationStatus,
          ai_status AS aiStatus,
          risk_level AS riskLevel,
          last_message_at AS lastMessageAt
        FROM ai_service_conversations
        WHERE session_no = @sessionNo
        LIMIT 1
      `,
    );
    const insertConversation = this.db.prepare(
      `
        INSERT INTO ai_service_conversations (
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
          @sessionNo,
          '闲鱼 IM',
          '真实会话同步',
          @customerId,
          @customerName,
          @storeId,
          @orderId,
          @caseId,
          @topic,
          @latestUserIntent,
          @itemMainPic,
          @conversationStatus,
          @aiStatus,
          @riskLevel,
          @priority,
          @unreadCount,
          NULL,
          @boundaryLabel,
          @tagsText,
          @lastMessageAt,
          @createdAt,
          @updatedAt
        )
      `,
    );
    const updateConversation = this.db.prepare(
      `
        UPDATE ai_service_conversations
        SET
          customer_id = @customerId,
          customer_name = @customerName,
          store_id = @storeId,
          order_id = COALESCE(@orderId, order_id),
          case_id = COALESCE(@caseId, case_id),
          topic = @topic,
          latest_user_intent = @latestUserIntent,
          item_main_pic = COALESCE(@itemMainPic, item_main_pic),
          conversation_status = @conversationStatus,
          ai_status = @aiStatus,
          risk_level = @riskLevel,
          priority = @priority,
          unread_count = @unreadCount,
          boundary_label = @boundaryLabel,
          tags_text = @tagsText,
          last_message_at = CASE
            WHEN last_message_at >= @lastMessageAt THEN last_message_at
            ELSE @lastMessageAt
          END,
          updated_at = @updatedAt
        WHERE id = @id
      `,
    );
    const selectExistingMessageByExternal = this.db.prepare(
      `
        SELECT id
        FROM ai_service_messages
        WHERE conversation_id = @conversationId
          AND external_message_id = @externalMessageId
        LIMIT 1
      `,
    );
    const selectExistingMessage = this.db.prepare(
      `
        SELECT id
        FROM ai_service_messages
        WHERE conversation_id = @conversationId
          AND sender_type = @senderType
          AND content = @content
          AND created_at = @createdAt
        LIMIT 1
      `,
    );

    this.db.transaction(() => {
      upsertStore.run({
        id: store.id,
        name: store.shopName,
        manager: store.ownerName,
      });

      for (const remoteSession of input.sessions) {
        if ((remoteSession.sessionType ?? 0) !== 1) {
          continue;
        }

        const buyerMessages = remoteSession.messages.filter(
          (message) => message.senderRole === 'buyer' && message.text.trim(),
        );
        const latestCustomerMessage = buyerMessages.at(-1)?.text.trim() || remoteSession.summaryText.trim();
        if (!latestCustomerMessage) {
          result.skippedCount += 1;
          continue;
        }

        result.candidateSessionCount += 1;

        const externalCustomerId = remoteSession.buyerUserId?.trim() || '';
        if (!externalCustomerId) {
          result.skippedCount += 1;
          continue;
        }

        const normalizedItemId = remoteSession.itemId?.trim() ?? '';
        const productId = /^\d+$/.test(normalizedItemId) ? Number(normalizedItemId) : null;
        const product =
          productId && Number.isSafeInteger(productId) && productId > 0
            ? ((selectProduct.get({
                productId,
                storeId: store.id,
              }) as { id: number; name: string } | undefined) ?? null)
            : null;

        let customerId =
          (selectCustomerRef.get({
            externalCustomerId,
          }) as { customerId: number } | undefined)?.customerId ?? null;
        const customerName =
          remoteSession.buyerName?.trim() ||
          buyerMessages.at(-1)?.senderName?.trim() ||
          externalCustomerId;
        if (!customerId) {
          const inserted = insertCustomer.run({
            name: customerName,
            province: '未知',
            registeredAt: remoteSession.summaryTimestamp || now,
          });
          customerId = Number(inserted.lastInsertRowid);
        } else {
          updateCustomer.run({
            id: customerId,
            name: customerName,
            province: '未知',
          });
        }
        upsertCustomerRef.run({
          externalCustomerId,
          customerId,
          createdAt: now,
        });

        const order =
          customerId !== null
            ? ((product?.id
                ? selectOrderByProduct.get({
                    storeId: store.id,
                    customerId,
                    productId: product.id,
                  })
                : selectOrderByCustomer.get({
                    storeId: store.id,
                    customerId,
                  })) as { id: number; orderNo: string } | undefined)
            : undefined;
        const shouldLinkAfterSale = this.isAiServiceAfterSaleMessage(latestCustomerMessage);
        const afterSaleCase =
          shouldLinkAfterSale && order?.id
            ? ((selectAfterSaleCase.get({
                orderId: order.id,
              }) as { id: number; caseNo: string } | undefined) ?? null)
            : null;

        const riskLevel = this.isAiServiceHighRiskMessage(latestCustomerMessage, sensitiveWords)
          ? 'high'
          : shouldLinkAfterSale
            ? 'medium'
            : 'low';
        const conversationStatus = riskLevel === 'high' ? 'pending_manual' : 'open';
        const aiStatus = riskLevel === 'high' ? 'manual_only' : 'ready';
        const priority = riskLevel === 'high' || afterSaleCase ? 'high' : remoteSession.unreadCount > 0 ? 'medium' : 'low';
        const topic = this.buildAiServiceRealTopic({
          latestCustomerText: latestCustomerMessage,
          productName: product?.name ?? null,
          caseNo: afterSaleCase?.caseNo ?? null,
        });
        const tags = [
          '真实IM',
          this.isAiServiceOrderQueryMessage(latestCustomerMessage) ? '订单' : '',
          shouldLinkAfterSale ? '售后' : '',
          riskLevel === 'high' ? '高风险' : '',
        ].filter(Boolean);
        const tagsText = tags.join(',');
        const boundaryLabel =
          riskLevel === 'high'
            ? '高风险转人工'
            : shouldLinkAfterSale
              ? '售后建议'
              : this.isAiServiceOrderQueryMessage(latestCustomerMessage)
                ? '订单状态答复'
                : '真实会话同步';
        const sessionNo = `XYIM-AICS-${store.id}-${remoteSession.sessionId}`;
        const lastMessageAt =
          buyerMessages.at(-1)?.sentAt ??
          remoteSession.summaryTimestamp ??
          now;
        const itemMainPic = remoteSession.itemMainPic?.trim() || null;
        const existingConversation = selectConversation.get({
          sessionNo,
        }) as
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
          const inserted = insertConversation.run({
            sessionNo,
            customerId,
            customerName,
            storeId: store.id,
            orderId: order?.id ?? null,
            caseId: afterSaleCase?.id ?? null,
            topic,
            latestUserIntent: latestCustomerMessage,
            itemMainPic,
            conversationStatus,
            aiStatus,
            riskLevel,
            priority,
            unreadCount: remoteSession.unreadCount,
            boundaryLabel,
            tagsText,
            lastMessageAt,
            createdAt: buyerMessages[0]?.sentAt ?? lastMessageAt,
            updatedAt: lastMessageAt,
          });
          conversationId = Number(inserted.lastInsertRowid);
          result.createdConversationCount += 1;
        } else {
          conversationId = existingConversation.id;
          const shouldReopen =
            existingConversation.conversationStatus === 'resolved' &&
            existingConversation.lastMessageAt < lastMessageAt;
          updateConversation.run({
            id: conversationId,
            customerId,
            customerName,
            storeId: store.id,
            orderId: order?.id ?? null,
            caseId: afterSaleCase?.id ?? null,
            topic,
            latestUserIntent: latestCustomerMessage,
            itemMainPic,
            conversationStatus: shouldReopen
              ? conversationStatus
              : existingConversation.conversationStatus === 'manual_active'
                ? 'manual_active'
                : conversationStatus,
            aiStatus: shouldReopen
              ? aiStatus
              : existingConversation.conversationStatus === 'manual_active'
                ? 'manual_only'
                : aiStatus,
            riskLevel:
              existingConversation.riskLevel === 'high' || riskLevel === 'high'
                ? 'high'
                : riskLevel,
            priority,
            unreadCount: remoteSession.unreadCount,
            boundaryLabel,
            tagsText,
            lastMessageAt,
            updatedAt: now,
          });
          result.updatedConversationCount += 1;
        }

        const remoteMessageList =
          remoteSession.messages.length > 0
            ? [...remoteSession.messages].sort(
                (left, right) =>
                  left.sentAt.localeCompare(right.sentAt) ||
                  (left.version ?? 0) - (right.version ?? 0) ||
                  left.messageId.localeCompare(right.messageId),
              )
            : [
                {
                  messageId: `${remoteSession.sessionId}:summary`,
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
          const normalizedContent = message.text.trim();
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
            message.senderName?.trim() ||
            (senderType === 'customer'
              ? customerName
              : senderType === 'seller'
                ? remoteSession.sellerName?.trim() || store.shopName
                : '系统记录');
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

          const existsByExternal = message.messageId
            ? (selectExistingMessageByExternal.get({
                conversationId,
                externalMessageId: message.messageId,
              }) as { id: number } | undefined)
            : undefined;
          if (existsByExternal) {
            continue;
          }

          const exists = selectExistingMessage.get({
            conversationId,
            senderType,
            content: normalizedContent,
            createdAt: message.sentAt,
          }) as { id: number } | undefined;
          if (exists) {
            continue;
          }

          this.appendAiServiceMessage({
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
    })();

    const hasChanges =
      result.createdConversationCount > 0 ||
      result.updatedConversationCount > 0 ||
      result.createdMessageCount > 0;
    if (input.syncSource === 'auto') {
      if (hasChanges) {
        this.insertWorkspaceLog(
          input.featureKey,
          'real_session_auto_sync',
          `${store.shopName} AI 客服新消息已同步`,
          `系统自动同步了 ${result.syncedConversationCount} 条真实会话，新增 ${result.createdMessageCount} 条消息。`,
        );
        this.touchWorkspace(input.featureKey, now);
      }
    } else {
      this.insertWorkspaceLog(
        input.featureKey,
        'real_session_sync',
        `${store.shopName} AI 客服真实会话已同步`,
        `${input.operator.displayName} 同步了 ${result.syncedConversationCount} 条真实会话。`,
      );
      this.touchWorkspace(input.featureKey, now);
    }

    return result;
  }

  listAiServicePendingAutoReplyConversationIds(
    featureKey: string,
    input?: {
      storeId?: number;
      limit?: number;
    },
  ) {
    if (featureKey !== 'ai-service') {
      return [];
    }

    const limit = Math.max(1, Math.min(50, Math.trunc(input?.limit ?? 20)));
    const params: Record<string, number> = {
      limit,
    };
    const storeClause =
      typeof input?.storeId === 'number' && Number.isSafeInteger(input.storeId) && input.storeId > 0
        ? 'AND c.store_id = @storeId'
        : '';
    if (storeClause) {
      params.storeId = input!.storeId!;
    }

    return this.db
      .prepare(
        `
          SELECT
            c.id
          FROM ai_service_conversations c
          INNER JOIN (
            SELECT
              conversation_id AS conversationId,
              MAX(created_at) AS latestCustomerAt
            FROM ai_service_messages
            WHERE sender_type = 'customer'
            GROUP BY conversation_id
          ) customer_messages ON customer_messages.conversationId = c.id
          LEFT JOIN (
            SELECT
              conversation_id AS conversationId,
              MAX(created_at) AS latestOutboundAt
            FROM ai_service_messages
            WHERE sender_type != 'customer'
            GROUP BY conversation_id
          ) outbound_messages ON outbound_messages.conversationId = c.id
          WHERE c.conversation_status IN ('open', 'pending_manual')
            ${storeClause}
            AND (
              outbound_messages.latestOutboundAt IS NULL
              OR outbound_messages.latestOutboundAt < customer_messages.latestCustomerAt
            )
          ORDER BY customer_messages.latestCustomerAt ASC, c.id ASC
          LIMIT @limit
        `,
      )
      .all(params)
      .map((row) => Number((row as { id: number }).id))
      .filter((id) => Number.isSafeInteger(id) && id > 0);
  }

  syncAiBargainSessionsFromXianyuIm(input: {
    featureKey: string;
    storeId: number;
    sessions: XianyuWebBargainSession[];
    operator: { id: number; displayName: string };
  }) {
    if (input.featureKey !== 'ai-bargain') {
      return null;
    }

    const store = this.db
      .prepare(
        `
          SELECT
            ms.id,
            ms.shop_name AS shopName,
            COALESCE(oa.owner_name, ms.nickname, ms.shop_name) AS ownerName
          FROM managed_stores ms
          LEFT JOIN store_owner_accounts oa ON oa.id = ms.owner_account_id
          WHERE ms.id = ?
        `,
      )
      .get(input.storeId) as { id: number; shopName: string; ownerName: string } | undefined;
    if (!store) {
      return null;
    }

    const now = format(new Date(), 'yyyy-MM-dd HH:mm:ss');
    const result = {
      storeId: store.id,
      shopName: store.shopName,
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

    const upsertStore = this.db.prepare(
      `
        INSERT INTO stores (id, name, manager)
        VALUES (@id, @name, @manager)
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          manager = excluded.manager
      `,
    );
    const selectProduct = this.db.prepare(
      `
        SELECT
          id,
          name,
          price,
          category,
          stock
        FROM products
        WHERE id = @productId
          AND store_id = @storeId
        LIMIT 1
      `,
    );
    const selectStrategy = this.db.prepare(
      `
        SELECT
          id,
          strategy_name AS strategyName,
          listed_price AS listedPrice,
          min_price AS minPrice,
          target_price AS targetPrice,
          step_price AS stepPrice,
          max_rounds AS maxRounds,
          enabled,
          risk_tags_text AS riskTagsText
        FROM ai_bargain_strategies
        WHERE product_id = @productId
          AND store_id = @storeId
        ORDER BY enabled DESC, id ASC
        LIMIT 1
      `,
    );
    const insertStrategy = this.db.prepare(
      `
        INSERT INTO ai_bargain_strategies (
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
          @productId,
          @storeId,
          @strategyName,
          @productName,
          @listedPrice,
          @minPrice,
          @targetPrice,
          @stepPrice,
          @maxRounds,
          1,
          @riskTagsText,
          @updatedAt
        )
      `,
    );
    const selectCustomerRef = this.db.prepare(
      `
        SELECT
          cer.customer_id AS customerId
        FROM customer_external_refs cer
        WHERE cer.provider = 'xianyu'
          AND cer.external_customer_id = @externalCustomerId
        LIMIT 1
      `,
    );
    const insertCustomer = this.db.prepare(
      `
        INSERT INTO customers (name, province, registered_at)
        VALUES (@name, @province, @registeredAt)
      `,
    );
    const updateCustomer = this.db.prepare(
      `
        UPDATE customers
        SET
          name = @name,
          province = @province
        WHERE id = @id
      `,
    );
    const upsertCustomerRef = this.db.prepare(
      `
        INSERT INTO customer_external_refs (provider, external_customer_id, customer_id, created_at)
        VALUES ('xianyu', @externalCustomerId, @customerId, @createdAt)
        ON CONFLICT(provider, external_customer_id) DO UPDATE SET
          customer_id = excluded.customer_id
      `,
    );
    const selectOrder = this.db.prepare(
      `
        SELECT
          id,
          order_no AS orderNo
        FROM orders
        WHERE store_id = @storeId
          AND product_id = @productId
          AND customer_id = @customerId
        ORDER BY paid_at DESC, id DESC
        LIMIT 1
      `,
    );
    const selectSession = this.db.prepare(
      `
        SELECT
          id,
          session_status AS sessionStatus,
          ai_status AS aiStatus,
          last_message_at AS lastMessageAt,
          risk_reason AS riskReason,
          latest_buyer_offer AS latestBuyerOffer
        FROM ai_bargain_sessions
        WHERE session_no = @sessionNo
        LIMIT 1
      `,
    );
    const insertSession = this.db.prepare(
      `
        INSERT INTO ai_bargain_sessions (
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
          @sessionNo,
          '闲鱼 IM',
          @topic,
          @customerId,
          @customerName,
          @storeId,
          @productId,
          @orderId,
          @strategyId,
          @productName,
          @listedPrice,
          @minPrice,
          @targetPrice,
          @latestBuyerOffer,
          NULL,
          0,
          @maxRounds,
          'open',
          'ready',
          @riskLevel,
          @riskReason,
          NULL,
          '真实会话同步',
          @tagsText,
          @lastMessageAt,
          @createdAt,
          @updatedAt
        )
      `,
    );
    const updateSession = this.db.prepare(
      `
        UPDATE ai_bargain_sessions
        SET
          customer_id = @customerId,
          customer_name = @customerName,
          store_id = @storeId,
          product_id = @productId,
          order_id = COALESCE(@orderId, order_id),
          strategy_id = @strategyId,
          product_name_snapshot = @productName,
          listed_price = @listedPrice,
          min_price = @minPrice,
          target_price = @targetPrice,
          latest_buyer_offer = COALESCE(@latestBuyerOffer, latest_buyer_offer),
          max_rounds = @maxRounds,
          tags_text = @tagsText,
          last_message_at = CASE
            WHEN last_message_at >= @lastMessageAt THEN last_message_at
            ELSE @lastMessageAt
          END,
          updated_at = @updatedAt
        WHERE id = @id
      `,
    );

    const evaluateSessionIds = new Set<number>();
    this.db.transaction(() => {
      upsertStore.run({
        id: store.id,
        name: store.shopName,
        manager: store.ownerName,
      });

      for (const remoteSession of input.sessions) {
        const buyerMessages = remoteSession.messages.filter(
          (message) => message.senderRole === 'buyer' && this.isAiBargainIntentText(message.text),
        );
        const isCandidate =
          buyerMessages.length > 0 ||
          (remoteSession.messages.length === 0 && this.isAiBargainIntentText(remoteSession.summaryText));
        if (!isCandidate) {
          continue;
        }
        result.candidateSessionCount += 1;

        const normalizedItemId = remoteSession.itemId?.trim() ?? '';
        if (!/^\d+$/.test(normalizedItemId)) {
          result.skippedCount += 1;
          continue;
        }

        const productId = Number(normalizedItemId);
        if (!Number.isSafeInteger(productId) || productId <= 0) {
          result.skippedCount += 1;
          continue;
        }

        const product = selectProduct.get({
          productId,
          storeId: store.id,
        }) as
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

        let strategy = selectStrategy.get({
          productId,
          storeId: store.id,
        }) as
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
          const listedPrice = Number(product.price.toFixed(2));
          const minPrice = Number((listedPrice * 0.9).toFixed(2));
          const targetPrice = Number(
            Math.max(minPrice, listedPrice - Math.max(1, listedPrice * 0.05)).toFixed(2),
          );
          const stepPrice = Number(Math.max(1, listedPrice * 0.02).toFixed(2));
          insertStrategy.run({
            productId,
            storeId: store.id,
            strategyName: `${product.name}标准策略`,
            productName: product.name,
            listedPrice,
            minPrice,
            targetPrice,
            stepPrice,
            maxRounds: 3,
            riskTagsText: '真实IM,自动议价',
            updatedAt: now,
          });
          result.createdStrategyCount += 1;
          strategy = selectStrategy.get({
            productId,
            storeId: store.id,
          }) as
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
        }
        if (!strategy) {
          result.skippedCount += 1;
          continue;
        }

        const customerName = remoteSession.buyerName?.trim() || '闲鱼买家';
        const externalCustomerId =
          remoteSession.buyerUserId?.trim() || `im-session:${store.id}:${remoteSession.sessionId}`;
        const customerRef = selectCustomerRef.get({
          externalCustomerId,
        }) as { customerId: number } | undefined;
        let customerId = customerRef?.customerId ?? null;
        if (!customerId) {
          const insertedCustomer = insertCustomer.run({
            name: customerName,
            province: '未知',
            registeredAt: remoteSession.summaryTimestamp || now,
          });
          customerId = Number(insertedCustomer.lastInsertRowid);
        } else {
          updateCustomer.run({
            id: customerId,
            name: customerName,
            province: '未知',
          });
        }
        upsertCustomerRef.run({
          externalCustomerId,
          customerId,
          createdAt: now,
        });

        const riskProfile = this.getAiBargainCustomerRisk(customerId);
        const blacklistHit = this.findAiBargainBlacklistHit(customerId, customerName);
        const riskLevel = blacklistHit ? 'high' : riskProfile.level;
        const riskReason = blacklistHit ? `命中黑名单：${blacklistHit.reason}` : riskProfile.reason;
        const linkedOrder = selectOrder.get({
          storeId: store.id,
          productId,
          customerId,
        }) as { id: number; orderNo: string } | undefined;

        const sessionNo = `XYIM-${store.id}-${remoteSession.sessionId}`;
        const existingSession = selectSession.get({
          sessionNo,
        }) as
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
            left.sentAt.localeCompare(right.sentAt) ||
            left.messageId.localeCompare(right.messageId),
        );
        const latestBuyerOffer = [...sortedMessages]
          .reverse()
          .reduce<number | null>((foundOffer, message) => {
            if (foundOffer !== null || message.senderRole !== 'buyer') {
              return foundOffer;
            }
            return this.extractAiBargainOfferPrice(message.text);
          }, null);
        const firstMessageAt = sortedMessages[0]?.sentAt || remoteSession.summaryTimestamp || now;
        const lastMessageAt =
          sortedMessages[sortedMessages.length - 1]?.sentAt || remoteSession.summaryTimestamp || now;
        const tagsText = Array.from(
          new Set(
            [strategy.riskTagsText, '真实IM']
              .join(',')
              .split(/[,，]/)
              .map((tag) => tag.trim())
              .filter(Boolean),
          ),
        ).join(',');

        let sessionId = existingSession?.id ?? null;
        if (!sessionId) {
          const insertedSession = insertSession.run({
            sessionNo,
            topic: '真实买家议价',
            customerId,
            customerName,
            storeId: store.id,
            productId,
            orderId: linkedOrder?.id ?? null,
            strategyId: strategy.id,
            productName: product.name,
            listedPrice: strategy.listedPrice,
            minPrice: strategy.minPrice,
            targetPrice: strategy.targetPrice,
            latestBuyerOffer,
            maxRounds: strategy.maxRounds,
            riskLevel,
            riskReason,
            tagsText,
            lastMessageAt,
            createdAt: firstMessageAt,
            updatedAt: lastMessageAt,
          });
          sessionId = Number(insertedSession.lastInsertRowid);
          result.createdSessionCount += 1;
        } else {
          updateSession.run({
            id: sessionId,
            customerId,
            customerName,
            storeId: store.id,
            productId,
            orderId: linkedOrder?.id ?? null,
            strategyId: strategy.id,
            productName: product.name,
            listedPrice: strategy.listedPrice,
            minPrice: strategy.minPrice,
            targetPrice: strategy.targetPrice,
            latestBuyerOffer,
            maxRounds: strategy.maxRounds,
            tagsText,
            lastMessageAt,
            updatedAt: now,
          });
          result.updatedSessionCount += 1;
        }
        result.syncedSessionCount += 1;

        for (const message of sortedMessages) {
          const normalizedText = this.normalizeAiBargainMessageText(message.text);
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
          if (
            this.hasAiBargainLogRecord({
              sessionId,
              actorType,
              actionType,
              offerPrice,
              messageText: normalizedText,
              createdAt,
            })
          ) {
            continue;
          }

          this.appendAiBargainLog({
            sessionId,
            actorType,
            actionType,
            offerPrice,
            messageText: normalizedText,
            createdAt,
          });
          result.createdLogCount += 1;
        }

        const sessionContext = this.getAiBargainSessionContext(sessionId);
        const latestBuyerLog = this.getAiBargainLatestBuyerLog(sessionId);
        const shouldSkipAutoEvaluate =
          sessionContext?.sessionStatus === 'manual_active' ||
          sessionContext?.sessionStatus === 'pending_manual' ||
          sessionContext?.aiStatus === 'manual_only';
        if (latestBuyerLog?.offerPrice !== null && latestBuyerLog?.offerPrice !== undefined && !shouldSkipAutoEvaluate) {
          evaluateSessionIds.add(sessionId);
        }
      }
    })();

    for (const sessionId of evaluateSessionIds) {
      const evaluation = this.evaluateAiBargainSession(input.featureKey, sessionId, input.operator);
      if (evaluation && !evaluation.reused) {
        result.autoEvaluatedCount += 1;
      }
    }

    this.insertWorkspaceLog(
      input.featureKey,
      'sync',
      `${store.shopName} 真实议价会话已同步`,
      `同步了 ${result.syncedSessionCount} 个候选会话，新增 ${result.createdSessionCount} 个会话、${result.createdLogCount} 条日志，自动评估 ${result.autoEvaluatedCount} 个。`,
    );
    this.touchWorkspace(input.featureKey, now);
    this.markManagedStoreBusinessSyncHealthy(store.id, {
      detail: '真实议价会话同步成功，当前凭据可用于闲鱼 IM 业务接口调用。',
      verifiedAt: now,
    });

    return result;
  }

  evaluateAiBargainSession(
    featureKey: string,
    sessionId: number,
    operator: { id: number; displayName: string },
  ) {
    if (featureKey !== 'ai-bargain') {
      return null;
    }

    const settings = this.getAiBargainSettingsRow();
    const context = this.getAiBargainSessionContext(sessionId);
    const latestBuyerLog = this.getAiBargainLatestBuyerLog(sessionId);
    if (!settings || !context || !latestBuyerLog) {
      return null;
    }

    const latestOutboundLog = this.getAiBargainLatestOutboundLog(sessionId);
    if (
      latestOutboundLog &&
      latestOutboundLog.createdAt >= latestBuyerLog.createdAt &&
      ['ai', 'manual', 'system'].includes(latestOutboundLog.actorType)
    ) {
      return {
        reused: true,
        outcome: latestOutboundLog.actionType,
        sessionStatus: context.sessionStatus,
        aiStatus: context.aiStatus,
        offerPrice: latestOutboundLog.offerPrice,
        messageText: latestOutboundLog.messageText,
      };
    }

    const now = format(new Date(), 'yyyy-MM-dd HH:mm:ss');
    const buyerOffer =
      latestBuyerLog.offerPrice ?? context.latestBuyerOffer ?? Number(context.listedPrice.toFixed(2));
    const sensitiveWordHit =
      this.parseAiServiceSensitiveWords(settings.sensitiveWordsText).find((word) =>
        latestBuyerLog.messageText.includes(word),
      ) ?? null;
    const riskProfile = this.getAiBargainCustomerRisk(context.customerId);
    const blacklistHit = this.findAiBargainBlacklistHit(context.customerId, context.customerName);
    const mergedRiskLevel =
      blacklistHit || sensitiveWordHit || riskProfile.level === 'high' || context.riskLevel === 'high'
        ? 'high'
        : riskProfile.level === 'medium' || context.riskLevel === 'medium'
          ? 'medium'
          : 'low';
    const mergedRiskReason = [
      context.riskReason,
      riskProfile.reason,
      blacklistHit ? `命中黑名单：${blacklistHit.reason}` : '',
      sensitiveWordHit ? `命中敏感词：${sensitiveWordHit}` : '',
    ]
      .filter(Boolean)
      .join('；');

    let outcome = 'counter_offer';
    let sessionStatus = context.sessionStatus;
    let aiStatus = context.aiStatus;
    let offerPrice: number | null = null;
    let messageText = '';
    let relatedTemplateId: number | null = null;
    let boundaryLabel = context.boundaryLabel || '标准议价';
    const currentRound = context.currentRound + 1;

    if (!settings.aiEnabled || !settings.autoBargainEnabled) {
      outcome = 'blocked';
      sessionStatus = 'pending_manual';
      aiStatus = 'disabled';
      boundaryLabel = 'AI 已关闭';
      messageText = 'AI 议价当前已关闭，本次议价需要人工处理。';
    } else if (settings.highRiskManualOnly && mergedRiskLevel === 'high') {
      outcome = 'blocked';
      sessionStatus = 'pending_manual';
      aiStatus = 'manual_only';
      boundaryLabel = '高风险转人工';
      messageText = blacklistHit
        ? `已命中议价黑名单，${settings.blacklistNotice || '当前会话必须转人工处理。'}`
        : '系统识别为高风险议价，建议立即转人工接管并停止自动让价。';
    } else if (
      settings.allowAutoAccept &&
      (buyerOffer >= context.targetPrice || (currentRound >= context.maxRounds && buyerOffer >= context.minPrice))
    ) {
      outcome = 'accept';
      sessionStatus = 'agreed';
      aiStatus = 'auto_accepted';
      offerPrice = Number(Math.max(buyerOffer, context.minPrice).toFixed(2));
      boundaryLabel = '目标价内自动成交';
      const template = this.findAiBargainTemplate('accept_offer');
      relatedTemplateId = template?.id ?? null;
      messageText = template
        ? this.applyAiServiceTemplate(template.templateContent, {
            productName: context.productName,
            listedPrice: context.listedPrice,
            buyerOffer: buyerOffer.toFixed(2),
            counterPrice: offerPrice.toFixed(2),
            minPrice: context.minPrice.toFixed(2),
            targetPrice: context.targetPrice.toFixed(2),
            roundText: `${currentRound}/${context.maxRounds}`,
          })
        : `可以按 ${offerPrice.toFixed(2)} 元成交，已在目标价和底价规则内。`;
    } else if (buyerOffer < context.minPrice && currentRound >= context.maxRounds) {
      outcome = 'reject';
      sessionStatus = 'rejected';
      aiStatus = 'auto_rejected';
      boundaryLabel = '底价保护';
      const template = this.findAiBargainTemplate('reject_offer');
      relatedTemplateId = template?.id ?? null;
      messageText = template
        ? this.applyAiServiceTemplate(template.templateContent, {
            productName: context.productName,
            listedPrice: context.listedPrice,
            buyerOffer: buyerOffer.toFixed(2),
            counterPrice: context.minPrice.toFixed(2),
            minPrice: context.minPrice.toFixed(2),
            targetPrice: context.targetPrice.toFixed(2),
            roundText: `${currentRound}/${context.maxRounds}`,
          })
        : `当前报价低于最低价 ${context.minPrice.toFixed(2)} 元，系统已终止自动议价。`;
    } else {
      outcome = 'counter_offer';
      sessionStatus = 'bargaining';
      aiStatus = 'auto_countered';
      offerPrice = Number(
        Math.max(
          context.minPrice,
          Math.min(
            context.targetPrice,
            buyerOffer < context.minPrice ? context.minPrice : buyerOffer + context.stepPrice,
          ),
        ).toFixed(2),
      );
      boundaryLabel = buyerOffer < context.minPrice ? '底价保护' : '梯度让价';
      const template = this.findAiBargainTemplate(
        buyerOffer < context.minPrice ? 'floor_protection' : 'counter_offer',
      );
      relatedTemplateId = template?.id ?? null;
      messageText = template
        ? this.applyAiServiceTemplate(template.templateContent, {
            productName: context.productName,
            listedPrice: context.listedPrice,
            buyerOffer: buyerOffer.toFixed(2),
            counterPrice: offerPrice.toFixed(2),
            minPrice: context.minPrice.toFixed(2),
            targetPrice: context.targetPrice.toFixed(2),
            roundText: `${currentRound}/${context.maxRounds}`,
          })
        : `当前系统建议报价 ${offerPrice.toFixed(2)} 元，未突破最低价 ${context.minPrice.toFixed(2)} 元。`;
    }

    this.db.transaction(() => {
      const messageTime = this.appendAiBargainLog({
        sessionId,
        actorType: outcome === 'blocked' ? 'system' : 'ai',
        actionType: outcome,
        offerPrice,
        messageText,
        relatedTemplateId,
        operatorUserId: operator.id,
        createdAt: now,
      });
      this.updateAiBargainSessionState(sessionId, {
        latestBuyerOffer: buyerOffer,
        latestCounterPrice: offerPrice,
        currentRound,
        sessionStatus,
        aiStatus,
        riskLevel: mergedRiskLevel,
        riskReason: mergedRiskReason,
        assignedUserId: sessionStatus === 'pending_manual' ? context.assignedUserId : null,
        boundaryLabel,
        updatedAt: messageTime,
      });
    })();

    this.insertWorkspaceLog(
      featureKey,
      outcome,
      `${context.sessionNo} 已完成 ${this.getAiBargainActionTypeText(outcome)}`,
      `${operator.displayName} 触发了会话 ${context.sessionNo} 的 AI 议价评估。`,
    );
    this.touchWorkspace(featureKey, now);

    return {
      reused: false,
      outcome,
      sessionStatus,
      aiStatus,
      offerPrice,
      messageText,
    };
  }

  updateAiBargainSessionTakeover(
    featureKey: string,
    sessionId: number,
    action: 'takeover' | 'release',
    note: string,
    operator: { id: number; displayName: string },
  ) {
    if (featureKey !== 'ai-bargain') {
      return null;
    }

    const context = this.getAiBargainSessionContext(sessionId);
    if (!context) {
      return null;
    }

    const now = format(new Date(), 'yyyy-MM-dd HH:mm:ss');
    const messageText =
      action === 'takeover'
        ? `${operator.displayName} 已接管当前议价会话，后续由人工继续报价。`
        : `${operator.displayName} 已释放人工接管，会话回到 AI 待议价队列。`;

    this.db.transaction(() => {
      this.appendAiBargainLog({
        sessionId,
        actorType: 'system',
        actionType: action === 'takeover' ? 'manual_takeover' : 'manual_release',
        messageText,
        operatorUserId: operator.id,
        createdAt: now,
      });
      this.updateAiBargainSessionState(sessionId, {
        sessionStatus: action === 'takeover' ? 'manual_active' : 'open',
        aiStatus: action === 'takeover' ? 'manual_only' : 'ready',
        assignedUserId: action === 'takeover' ? operator.id : null,
        boundaryLabel: action === 'takeover' ? '人工接管' : '恢复 AI 议价',
        updatedAt: now,
      });
    })();

    this.insertWorkspaceLog(
      featureKey,
      'manual',
      `${context.sessionNo}${action === 'takeover' ? ' 已转人工' : ' 已释放接管'}`,
      `${operator.displayName}${action === 'takeover' ? '接管' : '释放'}了议价会话 ${context.sessionNo}。`,
    );
    this.touchWorkspace(featureKey, now);

    return {
      sessionStatus: action === 'takeover' ? 'manual_active' : 'open',
      aiStatus: action === 'takeover' ? 'manual_only' : 'ready',
    };
  }

  sendAiBargainManualDecision(
    featureKey: string,
    sessionId: number,
    content: string,
    action: 'counter_offer' | 'accept' | 'reject',
    offerPrice: number | null,
    operator: { id: number; displayName: string },
  ) {
    if (featureKey !== 'ai-bargain') {
      return null;
    }

    const context = this.getAiBargainSessionContext(sessionId);
    if (!context) {
      return null;
    }

    const now = format(new Date(), 'yyyy-MM-dd HH:mm:ss');
    const normalizedOffer =
      action === 'reject'
        ? null
        : Number(
            Math.max(
              context.minPrice,
              Math.min(offerPrice ?? context.targetPrice, context.listedPrice),
            ).toFixed(2),
          );
    const nextStatus =
      action === 'accept' ? 'agreed' : action === 'reject' ? 'rejected' : 'manual_active';

    this.db.transaction(() => {
      this.appendAiBargainLog({
        sessionId,
        actorType: 'manual',
        actionType: action === 'counter_offer' ? 'manual_offer' : action,
        offerPrice: normalizedOffer,
        messageText: content,
        operatorUserId: operator.id,
        createdAt: now,
      });
      this.updateAiBargainSessionState(sessionId, {
        latestCounterPrice: normalizedOffer,
        sessionStatus: nextStatus,
        aiStatus: 'manual_only',
        assignedUserId: operator.id,
        boundaryLabel:
          action === 'accept' ? '人工成交' : action === 'reject' ? '人工拒绝' : '人工报价',
        updatedAt: now,
      });
    })();

    this.insertWorkspaceLog(
      featureKey,
      'manual',
      `${context.sessionNo} 已记录人工议价结果`,
      `${operator.displayName} 对议价会话 ${context.sessionNo} 执行了人工${action === 'accept' ? '成交' : action === 'reject' ? '拒绝' : '报价'}。`,
    );
    this.touchWorkspace(featureKey, now);

    return {
      sessionStatus: nextStatus,
      aiStatus: 'manual_only',
      offerPrice: normalizedOffer,
    };
  }

  updateAiBargainSettings(
    featureKey: string,
    input: {
      aiEnabled?: boolean;
      autoBargainEnabled?: boolean;
      highRiskManualOnly?: boolean;
      allowAutoAccept?: boolean;
      boundaryNote?: string;
      sensitiveWordsText?: string;
      blacklistNotice?: string;
    },
    operator: { id: number; displayName: string },
  ) {
    if (featureKey !== 'ai-bargain') {
      return null;
    }

    const current = this.getAiBargainSettingsRow();
    if (!current) {
      return null;
    }

    const next = {
      aiEnabled: input.aiEnabled ?? current.aiEnabled,
      autoBargainEnabled: input.autoBargainEnabled ?? current.autoBargainEnabled,
      highRiskManualOnly: input.highRiskManualOnly ?? current.highRiskManualOnly,
      allowAutoAccept: input.allowAutoAccept ?? current.allowAutoAccept,
      boundaryNote: input.boundaryNote ?? current.boundaryNote,
      sensitiveWordsText: input.sensitiveWordsText ?? current.sensitiveWordsText,
      blacklistNotice: input.blacklistNotice ?? current.blacklistNotice,
    };
    const now = format(new Date(), 'yyyy-MM-dd HH:mm:ss');

    this.db
      .prepare(
        `
          UPDATE ai_bargain_settings
          SET
            ai_enabled = @aiEnabled,
            auto_bargain_enabled = @autoBargainEnabled,
            high_risk_manual_only = @highRiskManualOnly,
            allow_auto_accept = @allowAutoAccept,
            boundary_note = @boundaryNote,
            sensitive_words_text = @sensitiveWordsText,
            blacklist_notice = @blacklistNotice,
            updated_at = @updatedAt,
            updated_by = @updatedBy
          WHERE id = 1
        `,
      )
      .run({
        aiEnabled: next.aiEnabled ? 1 : 0,
        autoBargainEnabled: next.autoBargainEnabled ? 1 : 0,
        highRiskManualOnly: next.highRiskManualOnly ? 1 : 0,
        allowAutoAccept: next.allowAutoAccept ? 1 : 0,
        boundaryNote: next.boundaryNote,
        sensitiveWordsText: next.sensitiveWordsText,
        blacklistNotice: next.blacklistNotice,
        updatedAt: now,
        updatedBy: operator.id,
      });

    this.insertWorkspaceLog(
      featureKey,
      'policy',
      'AI 议价策略已更新',
      `${operator.displayName} 更新了议价开关、风险边界和黑名单提示。`,
    );
    this.touchWorkspace(featureKey, now);
    return this.getAiBargainSettingsRow();
  }

  updateAiBargainStrategy(
    featureKey: string,
    strategyId: number,
    input: {
      minPrice: number;
      targetPrice: number;
      stepPrice: number;
      maxRounds: number;
      enabled?: boolean;
      riskTagsText?: string;
    },
  ) {
    if (featureKey !== 'ai-bargain') {
      return null;
    }

    const current = this.db
      .prepare(
        `
          SELECT
            id,
            strategy_name AS strategyName,
            listed_price AS listedPrice,
            enabled,
            risk_tags_text AS riskTagsText
          FROM ai_bargain_strategies
          WHERE id = ?
        `,
      )
      .get(strategyId) as
      | {
          id: number;
          strategyName: string;
          listedPrice: number;
          enabled: number;
          riskTagsText: string;
        }
      | undefined;
    if (!current) {
      return null;
    }

    const normalizedMin = Number(Math.min(input.minPrice, current.listedPrice).toFixed(2));
    const normalizedTarget = Number(
      Math.max(normalizedMin, Math.min(input.targetPrice, current.listedPrice)).toFixed(2),
    );
    const normalizedStep = Number(Math.max(0.5, input.stepPrice).toFixed(2));
    const normalizedRounds = Math.max(1, Math.min(input.maxRounds, 8));
    const now = format(new Date(), 'yyyy-MM-dd HH:mm:ss');

    this.db
      .prepare(
        `
          UPDATE ai_bargain_strategies
          SET
            min_price = @minPrice,
            target_price = @targetPrice,
            step_price = @stepPrice,
            max_rounds = @maxRounds,
            enabled = @enabled,
            risk_tags_text = @riskTagsText,
            updated_at = @updatedAt
          WHERE id = @id
        `,
      )
      .run({
        id: strategyId,
        minPrice: normalizedMin,
        targetPrice: normalizedTarget,
        stepPrice: normalizedStep,
        maxRounds: normalizedRounds,
        enabled: (input.enabled ?? Boolean(current.enabled)) ? 1 : 0,
        riskTagsText: input.riskTagsText ?? current.riskTagsText,
        updatedAt: now,
      });

    this.insertWorkspaceLog(
      featureKey,
      'strategy',
      `${current.strategyName} 已更新`,
      `议价策略 ${current.strategyName} 的底价、目标价和梯度已更新。`,
    );
    this.touchWorkspace(featureKey, now);
    return { success: true };
  }

  updateAiBargainTemplateEnabled(featureKey: string, templateId: number, enabled: boolean) {
    if (featureKey !== 'ai-bargain') {
      return null;
    }

    const row = this.db
      .prepare('SELECT id, title FROM ai_bargain_templates WHERE id = ?')
      .get(templateId) as { id: number; title: string } | undefined;
    if (!row) {
      return null;
    }

    const now = format(new Date(), 'yyyy-MM-dd HH:mm:ss');
    this.db
      .prepare(
        `
          UPDATE ai_bargain_templates
          SET enabled = @enabled, updated_at = @updatedAt
          WHERE id = @id
        `,
      )
      .run({ id: templateId, enabled: enabled ? 1 : 0, updatedAt: now });
    this.insertWorkspaceLog(
      featureKey,
      'template',
      `${row.title}${enabled ? '已启用' : '已停用'}`,
      `议价模板 ${row.title} 状态已更新。`,
    );
    this.touchWorkspace(featureKey, now);
    return { enabled };
  }

  updateAiBargainBlacklistEnabled(featureKey: string, blacklistId: number, enabled: boolean) {
    if (featureKey !== 'ai-bargain') {
      return null;
    }

    const row = this.db
      .prepare('SELECT id, customer_name AS customerName FROM ai_bargain_blacklist WHERE id = ?')
      .get(blacklistId) as { id: number; customerName: string } | undefined;
    if (!row) {
      return null;
    }

    const now = format(new Date(), 'yyyy-MM-dd HH:mm:ss');
    this.db
      .prepare(
        `
          UPDATE ai_bargain_blacklist
          SET enabled = @enabled, updated_at = @updatedAt
          WHERE id = @id
        `,
      )
      .run({ id: blacklistId, enabled: enabled ? 1 : 0, updatedAt: now });
    this.insertWorkspaceLog(
      featureKey,
      'blacklist',
      `${row.customerName}${enabled ? '已加入启用名单' : '已移出启用名单'}`,
      `议价黑名单买家 ${row.customerName} 状态已更新。`,
    );
    this.touchWorkspace(featureKey, now);
    return { enabled };
  }

  private createTables() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS app_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        role TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        password_hash TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        last_login_at TEXT
      );

      CREATE TABLE IF NOT EXISTS audit_logs (
        id INTEGER PRIMARY KEY,
        operator_user_id INTEGER,
        operator_username TEXT,
        operator_display_name TEXT,
        action TEXT NOT NULL,
        target_type TEXT NOT NULL,
        target_id TEXT,
        detail TEXT NOT NULL,
        result TEXT NOT NULL,
        ip_address TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY(operator_user_id) REFERENCES users(id)
      );

      CREATE TABLE IF NOT EXISTS secure_settings (
        key TEXT PRIMARY KEY,
        description TEXT NOT NULL,
        value_encrypted TEXT NOT NULL,
        value_masked TEXT NOT NULL,
        updated_by INTEGER,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(updated_by) REFERENCES users(id)
      );

      CREATE TABLE IF NOT EXISTS stores (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        manager TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS products (
        id INTEGER PRIMARY KEY,
        store_id INTEGER NOT NULL,
        sku TEXT NOT NULL,
        name TEXT NOT NULL,
        category TEXT NOT NULL,
        price REAL NOT NULL,
        cost REAL NOT NULL,
        stock INTEGER NOT NULL,
        FOREIGN KEY(store_id) REFERENCES stores(id)
      );

      CREATE TABLE IF NOT EXISTS customers (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        province TEXT NOT NULL,
        registered_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS customer_external_refs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider TEXT NOT NULL,
        external_customer_id TEXT NOT NULL,
        customer_id INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(provider, external_customer_id),
        FOREIGN KEY(customer_id) REFERENCES customers(id)
      );

      CREATE TABLE IF NOT EXISTS orders (
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
        main_status TEXT NOT NULL DEFAULT 'paid',
        payment_status TEXT NOT NULL DEFAULT 'paid',
        delivery_status TEXT NOT NULL DEFAULT 'pending',
        after_sale_status TEXT NOT NULL,
        refund_amount REAL NOT NULL DEFAULT 0,
        paid_at TEXT NOT NULL,
        shipped_at TEXT,
        completed_at TEXT,
        delivery_hours REAL NOT NULL DEFAULT 0,
        is_new_customer INTEGER NOT NULL DEFAULT 0,
        buyer_note TEXT NOT NULL DEFAULT '',
        seller_remark TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(store_id) REFERENCES stores(id),
        FOREIGN KEY(product_id) REFERENCES products(id),
        FOREIGN KEY(customer_id) REFERENCES customers(id)
      );

      CREATE TABLE IF NOT EXISTS order_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id INTEGER NOT NULL,
        line_no INTEGER NOT NULL,
        product_id INTEGER,
        product_name_snapshot TEXT NOT NULL,
        sku_snapshot TEXT NOT NULL,
        category_snapshot TEXT NOT NULL,
        quantity INTEGER NOT NULL,
        unit_price REAL NOT NULL,
        paid_amount REAL NOT NULL,
        delivery_status TEXT NOT NULL,
        after_sale_status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(order_id) REFERENCES orders(id),
        FOREIGN KEY(product_id) REFERENCES products(id)
      );

      CREATE TABLE IF NOT EXISTS order_payments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id INTEGER NOT NULL,
        payment_no TEXT NOT NULL UNIQUE,
        payment_channel TEXT NOT NULL,
        payment_status TEXT NOT NULL,
        gross_amount REAL NOT NULL,
        discount_amount REAL NOT NULL,
        paid_amount REAL NOT NULL,
        paid_at TEXT NOT NULL,
        settled_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(order_id) REFERENCES orders(id)
      );

      CREATE TABLE IF NOT EXISTS order_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        event_title TEXT NOT NULL,
        event_detail TEXT NOT NULL,
        operator_name TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY(order_id) REFERENCES orders(id)
      );

      CREATE INDEX IF NOT EXISTS idx_orders_paid_at ON orders(paid_at);
      CREATE INDEX IF NOT EXISTS idx_orders_store_paid_at ON orders(store_id, paid_at);
      CREATE INDEX IF NOT EXISTS idx_order_items_order_id ON order_items(order_id);
      CREATE INDEX IF NOT EXISTS idx_order_payments_order_id ON order_payments(order_id);
      CREATE INDEX IF NOT EXISTS idx_order_events_order_id_created_at ON order_events(order_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_customer_external_refs_customer_id ON customer_external_refs(customer_id);

      CREATE TABLE IF NOT EXISTS after_sale_cases (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        case_no TEXT NOT NULL UNIQUE,
        order_id INTEGER NOT NULL,
        case_type TEXT NOT NULL,
        case_status TEXT NOT NULL,
        priority TEXT NOT NULL DEFAULT 'normal',
        source_channel TEXT NOT NULL DEFAULT 'manual',
        reason TEXT NOT NULL,
        customer_request TEXT NOT NULL DEFAULT '',
        expectation TEXT NOT NULL DEFAULT '',
        latest_result TEXT,
        sla_deadline_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        closed_at TEXT,
        FOREIGN KEY(order_id) REFERENCES orders(id)
      );

      CREATE TABLE IF NOT EXISTS after_sale_refunds (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        case_id INTEGER NOT NULL UNIQUE,
        refund_no TEXT NOT NULL UNIQUE,
        requested_amount REAL NOT NULL,
        approved_amount REAL NOT NULL DEFAULT 0,
        refund_status TEXT NOT NULL,
        review_note TEXT NOT NULL DEFAULT '',
        reviewed_by TEXT,
        reviewed_at TEXT,
        refunded_at TEXT,
        FOREIGN KEY(case_id) REFERENCES after_sale_cases(id)
      );

      CREATE TABLE IF NOT EXISTS after_sale_resends (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        case_id INTEGER NOT NULL UNIQUE,
        resend_no TEXT NOT NULL UNIQUE,
        fulfillment_type TEXT NOT NULL,
        resend_status TEXT NOT NULL,
        request_reason TEXT NOT NULL,
        result_detail TEXT NOT NULL DEFAULT '',
        related_outbound_no TEXT,
        related_task_no TEXT,
        executed_at TEXT,
        completed_at TEXT,
        FOREIGN KEY(case_id) REFERENCES after_sale_cases(id)
      );

      CREATE TABLE IF NOT EXISTS after_sale_disputes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        case_id INTEGER NOT NULL UNIQUE,
        dispute_no TEXT NOT NULL UNIQUE,
        dispute_type TEXT NOT NULL,
        dispute_status TEXT NOT NULL,
        responsibility TEXT NOT NULL DEFAULT '',
        conclusion TEXT NOT NULL DEFAULT '',
        compensation_amount REAL NOT NULL DEFAULT 0,
        concluded_by TEXT,
        concluded_at TEXT,
        FOREIGN KEY(case_id) REFERENCES after_sale_cases(id)
      );

      CREATE TABLE IF NOT EXISTS after_sale_records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        case_id INTEGER NOT NULL,
        record_type TEXT NOT NULL,
        title TEXT NOT NULL,
        detail TEXT NOT NULL,
        operator_name TEXT,
        created_at TEXT NOT NULL,
        FOREIGN KEY(case_id) REFERENCES after_sale_cases(id)
      );

      CREATE TABLE IF NOT EXISTS after_sale_reminders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        case_id INTEGER NOT NULL,
        reminder_type TEXT NOT NULL,
        reminder_status TEXT NOT NULL,
        title TEXT NOT NULL,
        detail TEXT NOT NULL,
        remind_at TEXT NOT NULL,
        resolved_at TEXT,
        FOREIGN KEY(case_id) REFERENCES after_sale_cases(id)
      );

      CREATE INDEX IF NOT EXISTS idx_after_sale_cases_type_status ON after_sale_cases(case_type, case_status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_after_sale_cases_order_id ON after_sale_cases(order_id);
      CREATE INDEX IF NOT EXISTS idx_after_sale_records_case_id ON after_sale_records(case_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_after_sale_reminders_case_id ON after_sale_reminders(case_id, reminder_status, remind_at DESC);
      CREATE INDEX IF NOT EXISTS idx_after_sale_refunds_status ON after_sale_refunds(refund_status, reviewed_at DESC);
      CREATE INDEX IF NOT EXISTS idx_after_sale_resends_status ON after_sale_resends(resend_status, executed_at DESC);
      CREATE INDEX IF NOT EXISTS idx_after_sale_disputes_status ON after_sale_disputes(dispute_status, concluded_at DESC);

      CREATE TABLE IF NOT EXISTS traffic_daily (
        id INTEGER PRIMARY KEY,
        report_date TEXT NOT NULL,
        store_id INTEGER NOT NULL,
        visitors INTEGER NOT NULL,
        inquiries INTEGER NOT NULL,
        favorites INTEGER NOT NULL,
        paid_customers INTEGER NOT NULL,
        FOREIGN KEY(store_id) REFERENCES stores(id)
      );

      CREATE TABLE IF NOT EXISTS workspace_modules (
        feature_key TEXT PRIMARY KEY,
        feature_label TEXT NOT NULL,
        group_key TEXT NOT NULL,
        group_label TEXT NOT NULL,
        status_tag TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS workspace_actions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        feature_key TEXT NOT NULL,
        action_key TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        status TEXT NOT NULL,
        run_count INTEGER NOT NULL DEFAULT 0,
        last_run_at TEXT,
        FOREIGN KEY(feature_key) REFERENCES workspace_modules(feature_key)
      );

      CREATE TABLE IF NOT EXISTS workspace_rules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        feature_key TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        scope_text TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(feature_key) REFERENCES workspace_modules(feature_key)
      );

      CREATE TABLE IF NOT EXISTS workspace_tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        feature_key TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        owner TEXT NOT NULL,
        priority TEXT NOT NULL,
        status TEXT NOT NULL,
        due_at TEXT NOT NULL,
        FOREIGN KEY(feature_key) REFERENCES workspace_modules(feature_key)
      );

      CREATE TABLE IF NOT EXISTS workspace_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        feature_key TEXT NOT NULL,
        log_type TEXT NOT NULL,
        title TEXT NOT NULL,
        detail TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(feature_key) REFERENCES workspace_modules(feature_key)
      );

      CREATE TABLE IF NOT EXISTS card_types (
        id INTEGER PRIMARY KEY,
        type_name TEXT NOT NULL,
        unsold_count INTEGER NOT NULL,
        sold_count INTEGER NOT NULL,
        total_stock INTEGER NOT NULL,
        delivery_channel TEXT NOT NULL,
        inventory_cost REAL NOT NULL,
        average_price REAL NOT NULL,
        card_prefix TEXT NOT NULL,
        password_prefix TEXT NOT NULL,
        separator_text TEXT NOT NULL,
        template_count INTEGER NOT NULL DEFAULT 0,
        is_deleted INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT,
        deleted_by TEXT
      );

      CREATE TABLE IF NOT EXISTS card_delivery_items (
        id INTEGER PRIMARY KEY,
        card_type_id INTEGER NOT NULL,
        product_id INTEGER,
        product_title TEXT NOT NULL,
        sale_price REAL NOT NULL,
        category TEXT NOT NULL,
        store_name TEXT NOT NULL,
        content_mode TEXT NOT NULL,
        delivery_policy TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(card_type_id) REFERENCES card_types(id),
        FOREIGN KEY(product_id) REFERENCES products(id)
      );

      CREATE TABLE IF NOT EXISTS card_combos (
        id INTEGER PRIMARY KEY,
        combo_name TEXT NOT NULL,
        combo_content TEXT NOT NULL,
        combo_type TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS card_templates (
        id INTEGER PRIMARY KEY,
        template_name TEXT NOT NULL,
        template_content TEXT NOT NULL,
        template_status TEXT NOT NULL,
        random_enabled INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS card_records (
        id INTEGER PRIMARY KEY,
        record_type TEXT NOT NULL,
        order_no TEXT NOT NULL,
        order_status TEXT NOT NULL,
        store_name TEXT NOT NULL,
        buyer_name TEXT NOT NULL,
        card_type TEXT NOT NULL,
        send_status TEXT NOT NULL,
        link_url TEXT NOT NULL,
        paid_at TEXT NOT NULL,
        confirmed_at TEXT,
        rated_at TEXT,
        sent_at TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS card_batches (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        card_type_id INTEGER NOT NULL,
        batch_no TEXT NOT NULL UNIQUE,
        source_label TEXT NOT NULL,
        imported_count INTEGER NOT NULL DEFAULT 0,
        duplicate_count INTEGER NOT NULL DEFAULT 0,
        invalid_count INTEGER NOT NULL DEFAULT 0,
        disabled_count INTEGER NOT NULL DEFAULT 0,
        available_count INTEGER NOT NULL DEFAULT 0,
        imported_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(card_type_id) REFERENCES card_types(id)
      );

      CREATE TABLE IF NOT EXISTS card_inventory_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        card_type_id INTEGER NOT NULL,
        batch_id INTEGER,
        card_no TEXT NOT NULL,
        card_secret TEXT NOT NULL,
        card_masked TEXT NOT NULL,
        item_status TEXT NOT NULL,
        locked_order_id INTEGER,
        locked_at TEXT,
        outbound_record_id INTEGER,
        disabled_reason TEXT,
        imported_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_used_at TEXT,
        UNIQUE(card_type_id, card_no, card_secret),
        FOREIGN KEY(card_type_id) REFERENCES card_types(id),
        FOREIGN KEY(batch_id) REFERENCES card_batches(id),
        FOREIGN KEY(locked_order_id) REFERENCES orders(id)
      );

      CREATE TABLE IF NOT EXISTS card_outbound_records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id INTEGER NOT NULL,
        card_type_id INTEGER NOT NULL,
        inventory_item_id INTEGER NOT NULL,
        outbound_no TEXT NOT NULL UNIQUE,
        outbound_status TEXT NOT NULL,
        attempt_no INTEGER NOT NULL DEFAULT 1,
        parent_outbound_id INTEGER,
        template_id INTEGER,
        message_content TEXT NOT NULL,
        send_channel TEXT NOT NULL,
        reason TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(order_id) REFERENCES orders(id),
        FOREIGN KEY(card_type_id) REFERENCES card_types(id),
        FOREIGN KEY(inventory_item_id) REFERENCES card_inventory_items(id),
        FOREIGN KEY(parent_outbound_id) REFERENCES card_outbound_records(id),
        FOREIGN KEY(template_id) REFERENCES card_templates(id)
      );

      CREATE TABLE IF NOT EXISTS card_recycle_records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id INTEGER NOT NULL,
        outbound_record_id INTEGER NOT NULL,
        inventory_item_id INTEGER NOT NULL,
        recycle_action TEXT NOT NULL,
        reason TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(order_id) REFERENCES orders(id),
        FOREIGN KEY(outbound_record_id) REFERENCES card_outbound_records(id),
        FOREIGN KEY(inventory_item_id) REFERENCES card_inventory_items(id)
      );

      CREATE TABLE IF NOT EXISTS card_delivery_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id INTEGER NOT NULL,
        card_type_id INTEGER NOT NULL,
        job_type TEXT NOT NULL,
        job_status TEXT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        latest_outbound_record_id INTEGER,
        related_outbound_record_id INTEGER,
        error_message TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_attempt_at TEXT,
        FOREIGN KEY(order_id) REFERENCES orders(id),
        FOREIGN KEY(card_type_id) REFERENCES card_types(id),
        FOREIGN KEY(latest_outbound_record_id) REFERENCES card_outbound_records(id),
        FOREIGN KEY(related_outbound_record_id) REFERENCES card_outbound_records(id)
      );

      CREATE TABLE IF NOT EXISTS card_stock_alerts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        card_type_id INTEGER NOT NULL UNIQUE,
        alert_level TEXT NOT NULL,
        threshold_value INTEGER NOT NULL,
        current_stock INTEGER NOT NULL,
        status TEXT NOT NULL,
        detail TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(card_type_id) REFERENCES card_types(id)
      );

      CREATE INDEX IF NOT EXISTS idx_card_batches_type_imported_at ON card_batches(card_type_id, imported_at DESC);
      CREATE INDEX IF NOT EXISTS idx_card_inventory_type_status ON card_inventory_items(card_type_id, item_status);
      CREATE INDEX IF NOT EXISTS idx_card_inventory_locked_order ON card_inventory_items(locked_order_id);
      CREATE INDEX IF NOT EXISTS idx_card_outbound_order_created_at ON card_outbound_records(order_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_card_delivery_jobs_status ON card_delivery_jobs(job_status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_card_recycle_outbound_id ON card_recycle_records(outbound_record_id);

      CREATE TABLE IF NOT EXISTS direct_charge_suppliers (
        id INTEGER PRIMARY KEY,
        supplier_key TEXT NOT NULL UNIQUE,
        supplier_name TEXT NOT NULL,
        adapter_key TEXT NOT NULL,
        account_name TEXT NOT NULL,
        endpoint_url TEXT NOT NULL,
        callback_token TEXT NOT NULL,
        callback_token_masked TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        supplier_status TEXT NOT NULL,
        balance REAL NOT NULL DEFAULT 0,
        success_rate REAL NOT NULL DEFAULT 0,
        timeout_minutes INTEGER NOT NULL DEFAULT 15,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_dispatch_at TEXT,
        last_callback_at TEXT
      );

      CREATE TABLE IF NOT EXISTS direct_charge_items (
        id INTEGER PRIMARY KEY,
        supplier_id INTEGER NOT NULL,
        product_id INTEGER NOT NULL,
        product_title TEXT NOT NULL,
        category TEXT NOT NULL,
        store_name TEXT NOT NULL,
        target_type TEXT NOT NULL,
        zone_required INTEGER NOT NULL DEFAULT 0,
        face_value REAL NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(supplier_id) REFERENCES direct_charge_suppliers(id),
        FOREIGN KEY(product_id) REFERENCES products(id)
      );

      CREATE TABLE IF NOT EXISTS direct_charge_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_id INTEGER NOT NULL UNIQUE,
        supplier_id INTEGER NOT NULL,
        item_id INTEGER NOT NULL,
        task_no TEXT NOT NULL UNIQUE,
        supplier_order_no TEXT,
        adapter_key TEXT NOT NULL,
        target_account TEXT NOT NULL,
        target_zone TEXT,
        face_value REAL NOT NULL,
        task_status TEXT NOT NULL,
        supplier_status TEXT,
        callback_status TEXT NOT NULL,
        verification_status TEXT NOT NULL,
        retry_count INTEGER NOT NULL DEFAULT 0,
        max_retry INTEGER NOT NULL DEFAULT 2,
        error_message TEXT,
        result_detail TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_dispatch_at TEXT,
        last_callback_at TEXT,
        timeout_at TEXT,
        manual_reason TEXT,
        FOREIGN KEY(order_id) REFERENCES orders(id),
        FOREIGN KEY(supplier_id) REFERENCES direct_charge_suppliers(id),
        FOREIGN KEY(item_id) REFERENCES direct_charge_items(id)
      );

      CREATE TABLE IF NOT EXISTS direct_charge_callbacks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        supplier_id INTEGER NOT NULL,
        job_id INTEGER,
        order_id INTEGER,
        callback_no TEXT NOT NULL UNIQUE,
        task_no TEXT NOT NULL,
        supplier_order_no TEXT,
        supplier_status TEXT NOT NULL,
        verification_status TEXT NOT NULL,
        mapped_status TEXT,
        callback_token TEXT,
        payload_text TEXT NOT NULL,
        detail TEXT NOT NULL,
        received_at TEXT NOT NULL,
        FOREIGN KEY(supplier_id) REFERENCES direct_charge_suppliers(id),
        FOREIGN KEY(job_id) REFERENCES direct_charge_jobs(id),
        FOREIGN KEY(order_id) REFERENCES orders(id)
      );

      CREATE TABLE IF NOT EXISTS direct_charge_reconciliations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id INTEGER NOT NULL UNIQUE,
        supplier_id INTEGER NOT NULL,
        order_id INTEGER NOT NULL,
        reconcile_status TEXT NOT NULL,
        supplier_status TEXT,
        mapped_status TEXT,
        detail TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(job_id) REFERENCES direct_charge_jobs(id),
        FOREIGN KEY(supplier_id) REFERENCES direct_charge_suppliers(id),
        FOREIGN KEY(order_id) REFERENCES orders(id)
      );

      CREATE INDEX IF NOT EXISTS idx_direct_charge_items_supplier_id ON direct_charge_items(supplier_id);
      CREATE INDEX IF NOT EXISTS idx_direct_charge_jobs_status ON direct_charge_jobs(task_status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_direct_charge_callbacks_job_id ON direct_charge_callbacks(job_id, received_at DESC);
      CREATE INDEX IF NOT EXISTS idx_direct_charge_reconciliations_status ON direct_charge_reconciliations(reconcile_status, updated_at DESC);

      CREATE TABLE IF NOT EXISTS supply_source_systems (
        id INTEGER PRIMARY KEY,
        system_key TEXT NOT NULL UNIQUE,
        system_name TEXT NOT NULL,
        adapter_key TEXT NOT NULL,
        endpoint_url TEXT NOT NULL,
        callback_token TEXT NOT NULL,
        callback_token_masked TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        system_status TEXT NOT NULL,
        sync_mode TEXT NOT NULL DEFAULT 'manual',
        sync_interval_minutes INTEGER NOT NULL DEFAULT 60,
        order_push_enabled INTEGER NOT NULL DEFAULT 1,
        refund_callback_enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_product_sync_at TEXT,
        last_inventory_sync_at TEXT,
        last_price_sync_at TEXT,
        last_order_push_at TEXT,
        last_callback_at TEXT,
        last_refund_notice_at TEXT
      );

      CREATE TABLE IF NOT EXISTS supply_source_products (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        system_id INTEGER NOT NULL,
        external_product_id TEXT NOT NULL,
        external_sku TEXT NOT NULL,
        external_product_name TEXT NOT NULL,
        platform_product_id INTEGER NOT NULL UNIQUE,
        platform_product_name TEXT NOT NULL,
        store_id INTEGER NOT NULL,
        store_name TEXT NOT NULL,
        category TEXT NOT NULL,
        sale_price REAL NOT NULL,
        source_price REAL NOT NULL,
        source_stock INTEGER NOT NULL,
        sync_status TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        last_sync_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(system_id, external_product_id),
        FOREIGN KEY(system_id) REFERENCES supply_source_systems(id),
        FOREIGN KEY(platform_product_id) REFERENCES products(id)
      );

      CREATE TABLE IF NOT EXISTS supply_source_sync_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        system_id INTEGER NOT NULL,
        sync_type TEXT NOT NULL,
        run_mode TEXT NOT NULL,
        run_status TEXT NOT NULL,
        total_count INTEGER NOT NULL DEFAULT 0,
        success_count INTEGER NOT NULL DEFAULT 0,
        failure_count INTEGER NOT NULL DEFAULT 0,
        detail TEXT NOT NULL,
        created_at TEXT NOT NULL,
        finished_at TEXT NOT NULL,
        FOREIGN KEY(system_id) REFERENCES supply_source_systems(id)
      );

      CREATE TABLE IF NOT EXISTS supply_source_orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        system_id INTEGER NOT NULL,
        mapping_id INTEGER NOT NULL,
        order_id INTEGER NOT NULL UNIQUE,
        task_no TEXT NOT NULL UNIQUE,
        source_order_no TEXT,
        order_status TEXT NOT NULL,
        source_status TEXT,
        verification_status TEXT NOT NULL DEFAULT 'pending',
        retry_count INTEGER NOT NULL DEFAULT 0,
        max_retry INTEGER NOT NULL DEFAULT 2,
        failure_reason TEXT,
        result_detail TEXT,
        pushed_at TEXT,
        callback_at TEXT,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(system_id) REFERENCES supply_source_systems(id),
        FOREIGN KEY(mapping_id) REFERENCES supply_source_products(id),
        FOREIGN KEY(order_id) REFERENCES orders(id)
      );

      CREATE TABLE IF NOT EXISTS supply_source_callbacks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        system_id INTEGER NOT NULL,
        supply_order_id INTEGER,
        order_id INTEGER,
        callback_no TEXT NOT NULL UNIQUE,
        task_no TEXT NOT NULL,
        source_order_no TEXT NOT NULL,
        source_status TEXT NOT NULL,
        verification_status TEXT NOT NULL,
        mapped_status TEXT,
        detail TEXT NOT NULL,
        received_at TEXT NOT NULL,
        FOREIGN KEY(system_id) REFERENCES supply_source_systems(id),
        FOREIGN KEY(supply_order_id) REFERENCES supply_source_orders(id),
        FOREIGN KEY(order_id) REFERENCES orders(id)
      );

      CREATE TABLE IF NOT EXISTS supply_source_refund_notices (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        system_id INTEGER NOT NULL,
        order_id INTEGER NOT NULL,
        case_id INTEGER,
        notice_no TEXT NOT NULL UNIQUE,
        source_order_no TEXT NOT NULL,
        refund_status TEXT NOT NULL,
        detail TEXT NOT NULL,
        notified_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(system_id) REFERENCES supply_source_systems(id),
        FOREIGN KEY(order_id) REFERENCES orders(id),
        FOREIGN KEY(case_id) REFERENCES after_sale_cases(id)
      );

      CREATE TABLE IF NOT EXISTS supply_source_reconciliations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        system_id INTEGER NOT NULL,
        mapping_id INTEGER,
        order_id INTEGER,
        reconcile_type TEXT NOT NULL,
        reconcile_no TEXT NOT NULL UNIQUE,
        platform_ref TEXT NOT NULL,
        source_ref TEXT NOT NULL,
        platform_price REAL,
        source_price REAL,
        platform_stock INTEGER,
        source_stock INTEGER,
        platform_amount REAL,
        source_amount REAL,
        diff_amount REAL NOT NULL DEFAULT 0,
        reconcile_status TEXT NOT NULL,
        detail TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(system_id) REFERENCES supply_source_systems(id),
        FOREIGN KEY(mapping_id) REFERENCES supply_source_products(id),
        FOREIGN KEY(order_id) REFERENCES orders(id)
      );

      CREATE INDEX IF NOT EXISTS idx_supply_source_products_system_id ON supply_source_products(system_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_supply_source_sync_runs_system_id ON supply_source_sync_runs(system_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_supply_source_orders_status ON supply_source_orders(order_status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_supply_source_callbacks_system_id ON supply_source_callbacks(system_id, received_at DESC);
      CREATE INDEX IF NOT EXISTS idx_supply_source_refund_notices_system_id ON supply_source_refund_notices(system_id, notified_at DESC);
      CREATE INDEX IF NOT EXISTS idx_supply_source_reconciliations_status ON supply_source_reconciliations(reconcile_status, updated_at DESC);

      CREATE TABLE IF NOT EXISTS fund_accounts (
        id INTEGER PRIMARY KEY,
        account_name TEXT NOT NULL,
        available_balance REAL NOT NULL,
        pending_withdrawal REAL NOT NULL,
        frozen_balance REAL NOT NULL,
        deposit_balance REAL NOT NULL,
        total_recharged REAL NOT NULL,
        total_paid_out REAL NOT NULL,
        status TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS fund_bills (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        trade_time TEXT NOT NULL,
        bill_no TEXT NOT NULL,
        merchant_order_no TEXT NOT NULL,
        payment_no TEXT NOT NULL,
        store_id INTEGER,
        item_name TEXT NOT NULL,
        item_info TEXT NOT NULL,
        amount REAL NOT NULL,
        trade_type TEXT NOT NULL,
        trade_method TEXT NOT NULL,
        balance_after REAL NOT NULL,
        remark TEXT NOT NULL,
        FOREIGN KEY(store_id) REFERENCES stores(id)
      );

      CREATE TABLE IF NOT EXISTS fund_withdrawals (
        id INTEGER PRIMARY KEY,
        withdrawal_no TEXT NOT NULL,
        trade_time TEXT NOT NULL,
        trade_no TEXT NOT NULL,
        store_id INTEGER,
        trade_type TEXT NOT NULL,
        amount REAL NOT NULL,
        fee REAL NOT NULL,
        arrival_amount REAL NOT NULL,
        available_balance REAL NOT NULL,
        status TEXT NOT NULL,
        method TEXT NOT NULL,
        receiving_account TEXT NOT NULL,
        review_remark TEXT NOT NULL,
        FOREIGN KEY(store_id) REFERENCES stores(id)
      );

      CREATE TABLE IF NOT EXISTS fund_deposits (
        id INTEGER PRIMARY KEY,
        deposit_type TEXT NOT NULL,
        store_id INTEGER,
        industry TEXT NOT NULL,
        status TEXT NOT NULL,
        amount REAL NOT NULL,
        operate_time TEXT NOT NULL,
        action_label TEXT NOT NULL,
        trade_time TEXT NOT NULL,
        payment_no TEXT NOT NULL,
        trade_amount REAL NOT NULL,
        trade_type TEXT NOT NULL,
        description TEXT NOT NULL,
        FOREIGN KEY(store_id) REFERENCES stores(id)
      );

      CREATE TABLE IF NOT EXISTS fund_orders (
        id INTEGER PRIMARY KEY,
        store_id INTEGER,
        created_at TEXT NOT NULL,
        paid_at TEXT NOT NULL,
        order_item TEXT NOT NULL,
        cycle_text TEXT NOT NULL,
        order_content TEXT NOT NULL,
        paid_amount REAL NOT NULL,
        merchant_order_no TEXT NOT NULL,
        bill_no TEXT NOT NULL,
        payment_no TEXT NOT NULL,
        FOREIGN KEY(store_id) REFERENCES stores(id)
      );

      CREATE TABLE IF NOT EXISTS fund_agents (
        id INTEGER PRIMARY KEY,
        member_name TEXT NOT NULL,
        version_name TEXT NOT NULL,
        user_info TEXT NOT NULL,
        subscription_info TEXT NOT NULL,
        discount_info TEXT NOT NULL,
        commission_text TEXT NOT NULL,
        commission_status TEXT NOT NULL,
        withdrawal_time TEXT,
        withdrawal_status TEXT NOT NULL,
        withdrawal_amount REAL NOT NULL,
        joined_at TEXT NOT NULL,
        agent_level TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS fund_settlements (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        payment_id INTEGER NOT NULL UNIQUE,
        order_id INTEGER NOT NULL,
        store_id INTEGER NOT NULL,
        settlement_no TEXT NOT NULL UNIQUE,
        order_no TEXT NOT NULL,
        payment_no TEXT NOT NULL,
        gross_amount REAL NOT NULL,
        received_amount REAL NOT NULL,
        fee_amount REAL NOT NULL,
        settled_amount REAL NOT NULL,
        settlement_status TEXT NOT NULL,
        settled_at TEXT NOT NULL,
        note TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL,
        FOREIGN KEY(payment_id) REFERENCES order_payments(id),
        FOREIGN KEY(order_id) REFERENCES orders(id),
        FOREIGN KEY(store_id) REFERENCES stores(id)
      );

      CREATE TABLE IF NOT EXISTS fund_refunds (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        case_id INTEGER NOT NULL UNIQUE,
        order_id INTEGER NOT NULL,
        store_id INTEGER NOT NULL,
        refund_no TEXT NOT NULL UNIQUE,
        case_no TEXT NOT NULL,
        order_no TEXT NOT NULL,
        requested_amount REAL NOT NULL,
        approved_amount REAL NOT NULL,
        refunded_amount REAL NOT NULL DEFAULT 0,
        refund_status TEXT NOT NULL,
        refund_channel TEXT NOT NULL DEFAULT '原路退回',
        reviewed_at TEXT,
        refunded_at TEXT,
        note TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL,
        FOREIGN KEY(case_id) REFERENCES after_sale_cases(id),
        FOREIGN KEY(order_id) REFERENCES orders(id),
        FOREIGN KEY(store_id) REFERENCES stores(id)
      );

      CREATE TABLE IF NOT EXISTS fund_reconciliations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ref_type TEXT NOT NULL,
        ref_id INTEGER NOT NULL,
        store_id INTEGER,
        reconcile_no TEXT NOT NULL UNIQUE,
        bill_category TEXT NOT NULL,
        platform_amount REAL NOT NULL,
        ledger_amount REAL NOT NULL,
        diff_amount REAL NOT NULL,
        reconcile_status TEXT NOT NULL,
        manual_status INTEGER NOT NULL DEFAULT 0,
        note TEXT NOT NULL DEFAULT '',
        reviewed_by TEXT,
        reviewed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(ref_type, ref_id),
        FOREIGN KEY(store_id) REFERENCES stores(id)
      );

      CREATE INDEX IF NOT EXISTS idx_fund_settlements_store_time ON fund_settlements(store_id, settled_at DESC);
      CREATE INDEX IF NOT EXISTS idx_fund_refunds_store_time ON fund_refunds(store_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_fund_reconciliations_store_time ON fund_reconciliations(store_id, updated_at DESC);

      CREATE TABLE IF NOT EXISTS ai_service_settings (
        id INTEGER PRIMARY KEY CHECK(id = 1),
        ai_enabled INTEGER NOT NULL DEFAULT 1,
        auto_reply_enabled INTEGER NOT NULL DEFAULT 1,
        faq_enabled INTEGER NOT NULL DEFAULT 1,
        order_query_enabled INTEGER NOT NULL DEFAULT 1,
        after_sale_suggestion_enabled INTEGER NOT NULL DEFAULT 1,
        high_risk_manual_only INTEGER NOT NULL DEFAULT 1,
        boundary_note TEXT NOT NULL,
        sensitive_words_text TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL,
        updated_by INTEGER,
        FOREIGN KEY(updated_by) REFERENCES users(id)
      );

      CREATE TABLE IF NOT EXISTS ai_service_conversations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_no TEXT NOT NULL UNIQUE,
        channel TEXT NOT NULL,
        source TEXT NOT NULL,
        customer_id INTEGER,
        customer_name TEXT NOT NULL,
        store_id INTEGER,
        order_id INTEGER,
        case_id INTEGER,
        topic TEXT NOT NULL,
        latest_user_intent TEXT NOT NULL DEFAULT '',
        item_main_pic TEXT,
        conversation_status TEXT NOT NULL,
        ai_status TEXT NOT NULL,
        risk_level TEXT NOT NULL,
        priority TEXT NOT NULL,
        unread_count INTEGER NOT NULL DEFAULT 0,
        assigned_user_id INTEGER,
        boundary_label TEXT NOT NULL DEFAULT '',
        tags_text TEXT NOT NULL DEFAULT '',
        last_message_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(customer_id) REFERENCES customers(id),
        FOREIGN KEY(store_id) REFERENCES stores(id),
        FOREIGN KEY(order_id) REFERENCES orders(id),
        FOREIGN KEY(case_id) REFERENCES after_sale_cases(id),
        FOREIGN KEY(assigned_user_id) REFERENCES users(id)
      );

      CREATE TABLE IF NOT EXISTS ai_service_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id INTEGER NOT NULL,
        external_message_id TEXT,
        sender_type TEXT NOT NULL,
        sender_name TEXT NOT NULL DEFAULT '',
        sender_user_id TEXT,
        scene TEXT NOT NULL,
        content TEXT NOT NULL,
        status TEXT NOT NULL,
        related_knowledge_id INTEGER,
        related_template_id INTEGER,
        operator_user_id INTEGER,
        created_at TEXT NOT NULL,
        FOREIGN KEY(conversation_id) REFERENCES ai_service_conversations(id),
        FOREIGN KEY(related_knowledge_id) REFERENCES ai_service_knowledge_items(id),
        FOREIGN KEY(related_template_id) REFERENCES ai_service_reply_templates(id),
        FOREIGN KEY(operator_user_id) REFERENCES users(id)
      );

      CREATE TABLE IF NOT EXISTS ai_service_takeovers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        conversation_id INTEGER NOT NULL,
        action_type TEXT NOT NULL,
        operator_user_id INTEGER,
        operator_name TEXT NOT NULL,
        note TEXT NOT NULL,
        created_at TEXT NOT NULL,
        FOREIGN KEY(conversation_id) REFERENCES ai_service_conversations(id),
        FOREIGN KEY(operator_user_id) REFERENCES users(id)
      );

      CREATE TABLE IF NOT EXISTS ai_service_knowledge_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        category TEXT NOT NULL,
        title TEXT NOT NULL,
        keywords_text TEXT NOT NULL,
        question_text TEXT NOT NULL,
        answer_text TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        risk_level TEXT NOT NULL DEFAULT 'low',
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS ai_service_reply_templates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        scene TEXT NOT NULL,
        title TEXT NOT NULL,
        trigger_text TEXT NOT NULL,
        template_content TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_ai_service_conversations_status ON ai_service_conversations(conversation_status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_ai_service_messages_conversation ON ai_service_messages(conversation_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_ai_service_takeovers_conversation ON ai_service_takeovers(conversation_id, created_at DESC);

      CREATE TABLE IF NOT EXISTS ai_bargain_settings (
        id INTEGER PRIMARY KEY CHECK(id = 1),
        ai_enabled INTEGER NOT NULL DEFAULT 1,
        auto_bargain_enabled INTEGER NOT NULL DEFAULT 1,
        high_risk_manual_only INTEGER NOT NULL DEFAULT 1,
        allow_auto_accept INTEGER NOT NULL DEFAULT 1,
        boundary_note TEXT NOT NULL,
        sensitive_words_text TEXT NOT NULL DEFAULT '',
        blacklist_notice TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL,
        updated_by INTEGER,
        FOREIGN KEY(updated_by) REFERENCES users(id)
      );

      CREATE TABLE IF NOT EXISTS ai_bargain_strategies (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        product_id INTEGER,
        store_id INTEGER,
        strategy_name TEXT NOT NULL,
        product_name_snapshot TEXT NOT NULL,
        listed_price REAL NOT NULL,
        min_price REAL NOT NULL,
        target_price REAL NOT NULL,
        step_price REAL NOT NULL,
        max_rounds INTEGER NOT NULL DEFAULT 3,
        enabled INTEGER NOT NULL DEFAULT 1,
        risk_tags_text TEXT NOT NULL DEFAULT '',
        updated_at TEXT NOT NULL,
        FOREIGN KEY(product_id) REFERENCES products(id),
        FOREIGN KEY(store_id) REFERENCES stores(id)
      );

      CREATE TABLE IF NOT EXISTS ai_bargain_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_no TEXT NOT NULL UNIQUE,
        channel TEXT NOT NULL,
        topic TEXT NOT NULL,
        customer_id INTEGER,
        customer_name TEXT NOT NULL,
        store_id INTEGER,
        product_id INTEGER,
        order_id INTEGER,
        strategy_id INTEGER,
        product_name_snapshot TEXT NOT NULL,
        listed_price REAL NOT NULL,
        min_price REAL NOT NULL,
        target_price REAL NOT NULL,
        latest_buyer_offer REAL,
        latest_counter_price REAL,
        current_round INTEGER NOT NULL DEFAULT 0,
        max_rounds INTEGER NOT NULL DEFAULT 3,
        session_status TEXT NOT NULL,
        ai_status TEXT NOT NULL,
        risk_level TEXT NOT NULL,
        risk_reason TEXT NOT NULL DEFAULT '',
        assigned_user_id INTEGER,
        boundary_label TEXT NOT NULL DEFAULT '',
        tags_text TEXT NOT NULL DEFAULT '',
        last_message_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(customer_id) REFERENCES customers(id),
        FOREIGN KEY(store_id) REFERENCES stores(id),
        FOREIGN KEY(product_id) REFERENCES products(id),
        FOREIGN KEY(order_id) REFERENCES orders(id),
        FOREIGN KEY(strategy_id) REFERENCES ai_bargain_strategies(id),
        FOREIGN KEY(assigned_user_id) REFERENCES users(id)
      );

      CREATE TABLE IF NOT EXISTS ai_bargain_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id INTEGER NOT NULL,
        actor_type TEXT NOT NULL,
        action_type TEXT NOT NULL,
        offer_price REAL,
        message_text TEXT NOT NULL,
        related_template_id INTEGER,
        operator_user_id INTEGER,
        created_at TEXT NOT NULL,
        FOREIGN KEY(session_id) REFERENCES ai_bargain_sessions(id),
        FOREIGN KEY(related_template_id) REFERENCES ai_bargain_templates(id),
        FOREIGN KEY(operator_user_id) REFERENCES users(id)
      );

      CREATE TABLE IF NOT EXISTS ai_bargain_templates (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        scene TEXT NOT NULL,
        title TEXT NOT NULL,
        trigger_text TEXT NOT NULL,
        template_content TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS ai_bargain_blacklist (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        customer_id INTEGER,
        customer_name TEXT NOT NULL,
        reason TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(customer_id) REFERENCES customers(id)
      );

      CREATE INDEX IF NOT EXISTS idx_ai_bargain_sessions_status ON ai_bargain_sessions(session_status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_ai_bargain_logs_session ON ai_bargain_logs(session_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_ai_bargain_strategies_product ON ai_bargain_strategies(product_id, enabled);
      CREATE INDEX IF NOT EXISTS idx_ai_bargain_blacklist_customer ON ai_bargain_blacklist(customer_id, enabled);

      CREATE TABLE IF NOT EXISTS store_operator_profile (
        id INTEGER PRIMARY KEY,
        display_name TEXT NOT NULL,
        mobile TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS managed_stores (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        platform TEXT NOT NULL,
        shop_type_label TEXT NOT NULL,
        shop_name TEXT NOT NULL,
        seller_no TEXT NOT NULL UNIQUE,
        nickname TEXT NOT NULL,
        status_text TEXT NOT NULL,
        activation_status TEXT NOT NULL,
        package_text TEXT NOT NULL,
        publish_limit_text TEXT NOT NULL,
        owner_account_id INTEGER,
        created_by_user_id INTEGER,
        group_name TEXT NOT NULL DEFAULT '未分组',
        tags_text TEXT NOT NULL DEFAULT '',
        remark TEXT NOT NULL DEFAULT '',
        enabled INTEGER NOT NULL DEFAULT 1,
        connection_status TEXT NOT NULL DEFAULT 'pending_activation',
        auth_status TEXT NOT NULL DEFAULT 'authorized',
        auth_expires_at TEXT,
        last_sync_at TEXT,
        health_status TEXT NOT NULL DEFAULT 'warning',
        last_health_check_at TEXT,
        last_health_check_detail TEXT NOT NULL DEFAULT '',
        last_session_id TEXT,
        last_reauthorize_at TEXT,
        provider_store_id TEXT,
        provider_user_id TEXT,
        credential_id INTEGER,
        profile_sync_status TEXT NOT NULL DEFAULT 'pending',
        profile_sync_error TEXT,
        last_profile_sync_at TEXT,
        last_verified_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS store_auth_sessions (
        session_id TEXT PRIMARY KEY,
        platform TEXT NOT NULL,
        source TEXT NOT NULL,
        auth_type INTEGER NOT NULL,
        status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT,
        completed_at TEXT,
        invalid_reason TEXT,
        store_id INTEGER,
        owner_account_id INTEGER,
        created_by_user_id INTEGER,
        reauthorize INTEGER NOT NULL DEFAULT 0,
        integration_mode TEXT NOT NULL DEFAULT 'simulated',
        provider_key TEXT,
        provider_label TEXT,
        provider_state TEXT,
        provider_auth_url TEXT,
        callback_url TEXT,
        provider_access_token_masked TEXT,
        provider_access_token_received_at TEXT,
        provider_payload_text TEXT,
        next_step TEXT NOT NULL DEFAULT 'manual_complete',
        callback_received_at TEXT,
        profile_sync_status TEXT NOT NULL DEFAULT 'pending',
        profile_sync_error TEXT,
        profile_synced_at TEXT,
        provider_error_code TEXT,
        provider_error_message TEXT,
        mobile TEXT,
        nickname TEXT
      );

      CREATE TABLE IF NOT EXISTS store_owner_accounts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        platform TEXT NOT NULL,
        owner_name TEXT NOT NULL,
        mobile TEXT NOT NULL,
        login_mode TEXT,
        account_status TEXT NOT NULL,
        last_authorized_at TEXT,
        last_authorized_by INTEGER,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS store_platform_credentials (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT,
        platform TEXT NOT NULL,
        store_id INTEGER,
        owner_account_id INTEGER,
        provider_key TEXT NOT NULL,
        credential_type TEXT NOT NULL,
        access_token_encrypted TEXT NOT NULL,
        access_token_masked TEXT NOT NULL,
        refresh_token_encrypted TEXT,
        scope_text TEXT NOT NULL DEFAULT '',
        expires_at TEXT,
        provider_user_id TEXT,
        provider_shop_id TEXT,
        provider_shop_name TEXT,
        last_verified_at TEXT,
        last_sync_status TEXT NOT NULL DEFAULT 'pending_profile_sync',
        credential_source TEXT NOT NULL DEFAULT 'manual',
        risk_level TEXT NOT NULL DEFAULT 'pending',
        risk_reason TEXT NOT NULL DEFAULT '',
        verification_url TEXT,
        last_renewed_at TEXT,
        last_renew_status TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS xianyu_im_session_auth_cache (
        store_id INTEGER PRIMARY KEY,
        auth_snapshot_encrypted TEXT NOT NULL,
        source TEXT NOT NULL,
        captured_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(store_id) REFERENCES managed_stores(id)
      );

      CREATE TABLE IF NOT EXISTS store_health_checks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        store_id INTEGER NOT NULL,
        status TEXT NOT NULL,
        detail TEXT NOT NULL,
        checked_at TEXT NOT NULL,
        triggered_by_user_id INTEGER,
        trigger_mode TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS store_credential_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        store_id INTEGER,
        session_id TEXT,
        credential_id INTEGER,
        event_type TEXT NOT NULL,
        status TEXT NOT NULL,
        detail TEXT NOT NULL,
        source TEXT,
        risk_level TEXT,
        verification_url TEXT,
        operator_user_id INTEGER,
        created_at TEXT NOT NULL,
        FOREIGN KEY(store_id) REFERENCES managed_stores(id),
        FOREIGN KEY(session_id) REFERENCES store_auth_sessions(session_id),
        FOREIGN KEY(credential_id) REFERENCES store_platform_credentials(id),
        FOREIGN KEY(operator_user_id) REFERENCES users(id)
      );

      CREATE INDEX IF NOT EXISTS idx_store_credential_events_store_time
        ON store_credential_events(store_id, created_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS idx_store_credential_events_session_time
        ON store_credential_events(session_id, created_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS idx_xianyu_im_session_auth_cache_expires
        ON xianyu_im_session_auth_cache(expires_at DESC);

      CREATE TABLE IF NOT EXISTS system_alerts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        alert_key TEXT NOT NULL UNIQUE,
        alert_type TEXT NOT NULL,
        severity TEXT NOT NULL,
        status TEXT NOT NULL,
        source_count INTEGER NOT NULL DEFAULT 0,
        title TEXT NOT NULL,
        detail TEXT NOT NULL,
        first_triggered_at TEXT NOT NULL,
        last_triggered_at TEXT NOT NULL,
        acknowledged_at TEXT,
        resolved_at TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS system_backup_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        backup_no TEXT NOT NULL UNIQUE,
        backup_type TEXT NOT NULL,
        run_status TEXT NOT NULL,
        file_name TEXT NOT NULL,
        file_path TEXT NOT NULL,
        file_size INTEGER NOT NULL DEFAULT 0,
        detail TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        triggered_by_name TEXT
      );

      CREATE TABLE IF NOT EXISTS system_log_archives (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        archive_no TEXT NOT NULL UNIQUE,
        period_start TEXT NOT NULL,
        period_end TEXT NOT NULL,
        log_count INTEGER NOT NULL DEFAULT 0,
        file_name TEXT NOT NULL,
        file_path TEXT NOT NULL,
        archive_status TEXT NOT NULL,
        detail TEXT NOT NULL,
        created_at TEXT NOT NULL,
        triggered_by_name TEXT
      );

      CREATE TABLE IF NOT EXISTS system_recovery_drills (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        drill_no TEXT NOT NULL UNIQUE,
        backup_run_id INTEGER,
        backup_no_snapshot TEXT,
        drill_status TEXT NOT NULL,
        target_path TEXT NOT NULL,
        duration_seconds INTEGER NOT NULL DEFAULT 0,
        detail TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        triggered_by_name TEXT,
        FOREIGN KEY(backup_run_id) REFERENCES system_backup_runs(id)
      );
    `);
  }

  private ensureWorkspaceData(includeSampleData: boolean) {
    const insertModule = this.db.prepare(
      `
      INSERT OR IGNORE INTO workspace_modules (
        feature_key,
        feature_label,
        group_key,
        group_label,
        status_tag,
        updated_at
      ) VALUES (
        @featureKey,
        @featureLabel,
        @groupKey,
        @groupLabel,
        @statusTag,
        @updatedAt
      )
    `,
    );

    const insertAction = this.db.prepare(
      `
      INSERT INTO workspace_actions (
        feature_key,
        action_key,
        title,
        description,
        status,
        run_count,
        last_run_at
      ) VALUES (
        @featureKey,
        @actionKey,
        @title,
        @description,
        @status,
        @runCount,
        @lastRunAt
      )
    `,
    );

    const insertRule = this.db.prepare(
      `
      INSERT INTO workspace_rules (
        feature_key,
        name,
        description,
        enabled,
        scope_text,
        updated_at
      ) VALUES (
        @featureKey,
        @name,
        @description,
        @enabled,
        @scopeText,
        @updatedAt
      )
    `,
    );

    const insertTask = this.db.prepare(
      `
      INSERT INTO workspace_tasks (
        feature_key,
        title,
        description,
        owner,
        priority,
        status,
        due_at
      ) VALUES (
        @featureKey,
        @title,
        @description,
        @owner,
        @priority,
        @status,
        @dueAt
      )
    `,
    );

    const insertLog = this.db.prepare(
      `
      INSERT INTO workspace_logs (
        feature_key,
        log_type,
        title,
        detail,
        created_at
      ) VALUES (
        @featureKey,
        @logType,
        @title,
        @detail,
        @createdAt
      )
    `,
    );

    workspaceDefinitions.forEach((definition, index) => {
      const baseDate = new Date();
      const updatedAt = format(addDays(baseDate, -(index % 3)), 'yyyy-MM-dd HH:mm:ss');

      insertModule.run({
        featureKey: definition.featureKey,
        featureLabel: definition.featureLabel,
        groupKey: definition.groupKey,
        groupLabel: definition.groupLabel,
        statusTag: definition.statusTag,
        updatedAt,
      });

      if (!includeSampleData) {
        return;
      }

      const actionCount = this.db
        .prepare('SELECT COUNT(*) AS count FROM workspace_actions WHERE feature_key = ?')
        .get(definition.featureKey) as { count: number };
      if (actionCount.count === 0) {
        definition.actionTitles.forEach((title, actionIndex) => {
          insertAction.run({
            featureKey: definition.featureKey,
            actionKey: `${definition.featureKey}-action-${actionIndex + 1}`,
            title,
            description: `围绕${definition.featureLabel}整理入口、规则执行和结果回查。`,
            status: actionIndex === 0 ? '待执行' : '就绪',
            runCount: index + actionIndex + 1,
            lastRunAt: format(addDays(baseDate, -(actionIndex + 1)), 'yyyy-MM-dd HH:mm:ss'),
          });
        });
      }

      const ruleCount = this.db
        .prepare('SELECT COUNT(*) AS count FROM workspace_rules WHERE feature_key = ?')
        .get(definition.featureKey) as { count: number };
      if (ruleCount.count === 0) {
        definition.ruleTitles.forEach((title, ruleIndex) => {
          insertRule.run({
            featureKey: definition.featureKey,
            name: title,
            description: `${definition.featureLabel}逻辑已按当前模块拆分为可控规则项。`,
            enabled: ruleIndex !== 2 ? 1 : 0,
            scopeText: ruleIndex === 0 ? '全部店铺' : ruleIndex === 1 ? '重点店铺' : '异常场景',
            updatedAt: format(addDays(baseDate, -ruleIndex), 'yyyy-MM-dd HH:mm:ss'),
          });
        });
      }

      const taskCount = this.db
        .prepare('SELECT COUNT(*) AS count FROM workspace_tasks WHERE feature_key = ?')
        .get(definition.featureKey) as { count: number };
      if (taskCount.count === 0) {
        [
          {
            title: `${definition.featureLabel}基础配置复核`,
            description: `确认${definition.featureLabel}当前配置与店铺范围一致。`,
            owner: '系统管理员',
            priority: 'high',
            status: 'todo',
            dueAt: format(addDays(baseDate, 1), 'yyyy-MM-dd HH:mm:ss'),
          },
          {
            title: `${definition.featureLabel}规则执行检查`,
            description: `检查${definition.featureLabel}最近一次规则执行结果。`,
            owner: '运营分析师',
            priority: 'medium',
            status: 'in_progress',
            dueAt: format(addDays(baseDate, 2), 'yyyy-MM-dd HH:mm:ss'),
          },
          {
            title: `${definition.featureLabel}异常日志归档`,
            description: `整理${definition.featureLabel}最近的异常与处理记录。`,
            owner: '系统管理员',
            priority: 'low',
            status: 'done',
            dueAt: format(addDays(baseDate, -1), 'yyyy-MM-dd HH:mm:ss'),
          },
        ].forEach((task) =>
          insertTask.run({
            featureKey: definition.featureKey,
            ...task,
          }),
        );
      }

      const logCount = this.db
        .prepare('SELECT COUNT(*) AS count FROM workspace_logs WHERE feature_key = ?')
        .get(definition.featureKey) as { count: number };
      if (logCount.count === 0) {
        [
          {
            logType: 'system',
            title: `${definition.featureLabel}工作台已初始化`,
            detail: '已完成默认动作、规则和任务的初始化。',
            createdAt: format(addDays(baseDate, -2), 'yyyy-MM-dd HH:mm:ss'),
          },
          {
            logType: 'rule',
            title: `${definition.featureLabel}规则已同步`,
            detail: '系统已同步当前模块的默认规则配置。',
            createdAt: format(addDays(baseDate, -1), 'yyyy-MM-dd HH:mm:ss'),
          },
          {
            logType: 'task',
            title: `${definition.featureLabel}任务已生成`,
            detail: '已按当前模块逻辑生成首批待办任务。',
            createdAt: format(baseDate, 'yyyy-MM-dd HH:mm:ss'),
          },
        ].forEach((log) =>
          insertLog.run({
            featureKey: definition.featureKey,
            ...log,
          }),
        );
      }
    });
  }

  private ensureWorkspaceBusinessData() {
    const baseDate = new Date();
    this.ensureCardWarehouseData(baseDate);
    this.ensureFundCenterData(baseDate);
  }

  private ensureCardWarehouseData(baseDate: Date) {
    const cardTypeCount = this.db.prepare('SELECT COUNT(*) AS count FROM card_types').get() as {
      count: number;
    };
    if (cardTypeCount.count === 0) {
      const insertCardType = this.db.prepare(
        `
        INSERT INTO card_types (
          id,
          type_name,
          unsold_count,
          sold_count,
          total_stock,
          delivery_channel,
          inventory_cost,
          average_price,
          card_prefix,
          password_prefix,
          separator_text,
          template_count,
          is_deleted,
          created_at,
          updated_at,
          deleted_at,
          deleted_by
        ) VALUES (
          @id,
          @typeName,
          @unsoldCount,
          @soldCount,
          @totalStock,
          @deliveryChannel,
          @inventoryCost,
          @averagePrice,
          @cardPrefix,
          @passwordPrefix,
          @separatorText,
          @templateCount,
          @isDeleted,
          @createdAt,
          @updatedAt,
          @deletedAt,
          @deletedBy
        )
      `,
      );

      cardTypeSeeds.forEach((seed) =>
        insertCardType.run({
          ...seed,
          createdAt: formatShiftedDateTime(
            baseDate,
            seed.createdOffsetDays,
            seed.createdHour,
            seed.createdMinute,
          ),
          updatedAt: formatShiftedDateTime(
            baseDate,
            seed.updatedOffsetDays,
            seed.updatedHour,
            seed.updatedMinute,
          ),
          deletedAt: formatNullableShiftedDateTime(
            baseDate,
            seed.deletedOffsetDays,
            seed.deletedHour,
            seed.deletedMinute,
          ),
        }),
      );
    }

    const deliveryCount = this.db
      .prepare('SELECT COUNT(*) AS count FROM card_delivery_items')
      .get() as { count: number };
    if (deliveryCount.count === 0) {
      const insertDelivery = this.db.prepare(
        `
        INSERT INTO card_delivery_items (
          id,
          card_type_id,
          product_title,
          sale_price,
          category,
          store_name,
          content_mode,
          delivery_policy,
          enabled,
          status,
          updated_at
        ) VALUES (
          @id,
          @cardTypeId,
          @productTitle,
          @salePrice,
          @category,
          @storeName,
          @contentMode,
          @deliveryPolicy,
          @enabled,
          @status,
          @updatedAt
        )
      `,
      );

      cardDeliverySeeds.forEach((seed) =>
        insertDelivery.run({
          ...seed,
          updatedAt: formatShiftedDateTime(
            baseDate,
            seed.updatedOffsetDays,
            seed.updatedHour,
            seed.updatedMinute,
          ),
        }),
      );
    }

    const comboCount = this.db.prepare('SELECT COUNT(*) AS count FROM card_combos').get() as {
      count: number;
    };
    if (comboCount.count === 0) {
      const insertCombo = this.db.prepare(
        `
        INSERT INTO card_combos (
          id,
          combo_name,
          combo_content,
          combo_type,
          status,
          created_at,
          updated_at
        ) VALUES (
          @id,
          @comboName,
          @comboContent,
          @comboType,
          @status,
          @createdAt,
          @updatedAt
        )
      `,
      );

      cardComboSeeds.forEach((seed) =>
        insertCombo.run({
          ...seed,
          createdAt: formatShiftedDateTime(
            baseDate,
            seed.createdOffsetDays,
            seed.createdHour,
            seed.createdMinute,
          ),
          updatedAt: formatShiftedDateTime(
            baseDate,
            seed.updatedOffsetDays,
            seed.updatedHour,
            seed.updatedMinute,
          ),
        }),
      );
    }

    const templateCount = this.db
      .prepare('SELECT COUNT(*) AS count FROM card_templates')
      .get() as { count: number };
    if (templateCount.count === 0) {
      const insertTemplate = this.db.prepare(
        `
        INSERT INTO card_templates (
          id,
          template_name,
          template_content,
          template_status,
          random_enabled,
          created_at,
          updated_at
        ) VALUES (
          @id,
          @templateName,
          @templateContent,
          @templateStatus,
          @randomEnabled,
          @createdAt,
          @updatedAt
        )
      `,
      );

      cardTemplateSeeds.forEach((seed) =>
        insertTemplate.run({
          ...seed,
          createdAt: formatShiftedDateTime(
            baseDate,
            seed.createdOffsetDays,
            seed.createdHour,
            seed.createdMinute,
          ),
          updatedAt: formatShiftedDateTime(
            baseDate,
            seed.updatedOffsetDays,
            seed.updatedHour,
            seed.updatedMinute,
          ),
        }),
      );
    }

    const recordCount = this.db.prepare('SELECT COUNT(*) AS count FROM card_records').get() as {
      count: number;
    };
    if (recordCount.count === 0) {
      const insertRecord = this.db.prepare(
        `
        INSERT INTO card_records (
          id,
          record_type,
          order_no,
          order_status,
          store_name,
          buyer_name,
          card_type,
          send_status,
          link_url,
          paid_at,
          confirmed_at,
          rated_at,
          sent_at,
          created_at
        ) VALUES (
          @id,
          @recordType,
          @orderNo,
          @orderStatus,
          @storeName,
          @buyerName,
          @cardType,
          @sendStatus,
          @linkUrl,
          @paidAt,
          @confirmedAt,
          @ratedAt,
          @sentAt,
          @createdAt
        )
      `,
      );

      cardRecordSeeds.forEach((seed) => {
        const sentAt = formatNullableShiftedDateTime(
          baseDate,
          seed.sentOffsetDays,
          seed.sentHour,
          seed.sentMinute,
        );
        insertRecord.run({
          ...seed,
          paidAt: formatShiftedDateTime(baseDate, seed.paidOffsetDays, seed.paidHour, seed.paidMinute),
          confirmedAt: formatNullableShiftedDateTime(
            baseDate,
            seed.confirmedOffsetDays,
            seed.confirmedHour,
            seed.confirmedMinute,
          ),
          ratedAt: formatNullableShiftedDateTime(
            baseDate,
            seed.ratedOffsetDays,
            seed.ratedHour,
            seed.ratedMinute,
          ),
          sentAt,
          createdAt: sentAt ?? formatShiftedDateTime(baseDate, seed.paidOffsetDays, seed.paidHour, seed.paidMinute),
        });
      });
    }
  }

  private ensureCardDeliveryEngineData(includeSampleData: boolean) {
    const now = format(new Date(), 'yyyy-MM-dd HH:mm:ss');
    const activeCardTypes = this.db
      .prepare(
        `
          SELECT id, unsold_count AS unsoldCount
          FROM card_types
          WHERE is_deleted = 0
          ORDER BY id ASC
        `,
      )
      .all() as Array<{ id: number; unsoldCount: number }>;

    if (!includeSampleData) {
      activeCardTypes.forEach((cardType) => this.refreshCardStockAlert(cardType.id, now));
      return;
    }

    const insertProduct = this.db.prepare(
      `
        INSERT OR IGNORE INTO products (id, store_id, sku, name, category, price, cost, stock)
        VALUES (@productId, @storeId, @sku, @name, @category, @price, @cost, @stock)
      `,
    );
    const updateDeliveryProduct = this.db.prepare(
      `
        UPDATE card_delivery_items
        SET
          product_id = @productId,
          updated_at = @updatedAt
        WHERE id = @deliveryId
          AND (product_id IS NULL OR product_id != @productId)
      `,
    );

    CARD_VIRTUAL_PRODUCTS.forEach((product) => {
      insertProduct.run(product);
      updateDeliveryProduct.run({
        deliveryId: product.deliveryId,
        productId: product.productId,
        updatedAt: now,
      });
    });

    const inventoryCounts = new Map(
      (
        this.db
          .prepare(
            `
              SELECT card_type_id AS cardTypeId, COUNT(*) AS count
              FROM card_inventory_items
              GROUP BY card_type_id
            `,
          )
          .all() as Array<{ cardTypeId: number; count: number }>
      ).map((row) => [row.cardTypeId, row.count]),
    );

    activeCardTypes.forEach((cardType) => {
      if ((inventoryCounts.get(cardType.id) ?? 0) === 0) {
        this.importCardBatch(
          cardType.id,
          this.generateCardImportLines(cardType.id, Math.max(1, cardType.unsoldCount), false),
          '演示库存初始化',
          now,
          null,
        );
      }
      this.refreshCardStockAlert(cardType.id, now);
    });

    const insertDemoOrder = this.db.prepare(
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
          @orderNo,
          @storeId,
          @productId,
          @customerId,
          @source,
          @quantity,
          @paidAmount,
          @discountAmount,
          @orderStatus,
          'paid',
          'paid',
          'pending',
          @afterSaleStatus,
          @refundAmount,
          @paidAt,
          NULL,
          NULL,
          0,
          0,
          '卡密自动履约测试单',
          '第5轮卡密引擎演示订单',
          @createdAt,
          @updatedAt
        )
      `,
    );

    CARD_DEMO_ORDER_SEEDS.forEach((seed) => {
      const orderDate = addDays(new Date(), seed.dayShift);
      const orderNo = `GF${format(orderDate, 'yyyyMMdd')}${seed.orderNoSuffix}`;
      const exists = this.db
        .prepare('SELECT id FROM orders WHERE order_no = ?')
        .get(orderNo) as { id: number } | undefined;
      if (exists) {
        return;
      }

      const product = CARD_VIRTUAL_PRODUCTS.find((item) => item.productId === seed.productId);
      if (!product) {
        return;
      }

      const paidAt = formatDateTime(new Date(), seed.hour, seed.minute, seed.dayShift);
      insertDemoOrder.run({
        orderNo,
        storeId: product.storeId,
        productId: seed.productId,
        customerId: seed.customerId,
        source: seed.source,
        quantity: seed.quantity,
        paidAmount: seed.paidAmount,
        discountAmount: seed.discountAmount,
        orderStatus: seed.orderStatus,
        afterSaleStatus: seed.afterSaleStatus,
        refundAmount: seed.refundAmount,
        paidAt,
        createdAt: paidAt,
        updatedAt: paidAt,
      });
    });

    const demoOrderRows = CARD_DEMO_ORDER_SEEDS.map((seed) => {
      const orderDate = addDays(new Date(), seed.dayShift);
      const orderNo = `GF${format(orderDate, 'yyyyMMdd')}${seed.orderNoSuffix}`;
      return this.db
        .prepare('SELECT id FROM orders WHERE order_no = ?')
        .get(orderNo) as { id: number } | undefined;
    }).filter((item): item is { id: number } => Boolean(item));

    demoOrderRows.forEach((order) => {
      const context = this.getCardFulfillmentContext(order.id);
      if (!context?.cardTypeId) {
        return;
      }
      this.ensureCardDeliveryJobRecord(order.id, context.cardTypeId, 'auto_fulfill', now);
    });

    const successSeed = CARD_DEMO_ORDER_SEEDS[1];
    const successOrderNo = `GF${format(addDays(new Date(), successSeed.dayShift), 'yyyyMMdd')}${successSeed.orderNoSuffix}`;
    const successOrder = this.db
      .prepare('SELECT id FROM orders WHERE order_no = ?')
      .get(successOrderNo) as { id: number } | undefined;
    if (successOrder) {
      const outboundCount = this.db
        .prepare('SELECT COUNT(*) AS count FROM card_outbound_records WHERE order_id = ?')
        .get(successOrder.id) as { count: number };
      if (outboundCount.count === 0) {
        const context = this.getCardFulfillmentContext(successOrder.id);
        if (context?.cardTypeId) {
          const jobId = this.ensureCardDeliveryJobRecord(successOrder.id, context.cardTypeId, 'auto_fulfill', now);
          this.performCardOrderFulfillment(successOrder.id, jobId, now);
        }
      }
    }

    const failedSeed = CARD_DEMO_ORDER_SEEDS[2];
    const failedOrderNo = `GF${format(addDays(new Date(), failedSeed.dayShift), 'yyyyMMdd')}${failedSeed.orderNoSuffix}`;
    const failedOrder = this.db
      .prepare('SELECT id FROM orders WHERE order_no = ?')
      .get(failedOrderNo) as { id: number } | undefined;
    if (failedOrder) {
      const failedJob = this.db
        .prepare(
          `
            SELECT id, job_status AS jobStatus
            FROM card_delivery_jobs
            WHERE order_id = ?
              AND job_type = 'auto_fulfill'
            ORDER BY id DESC
            LIMIT 1
          `,
        )
        .get(failedOrder.id) as { id: number; jobStatus: CardDeliveryJobStatus } | undefined;
      if (failedJob && failedJob.jobStatus === 'pending') {
        this.performCardOrderFulfillment(failedOrder.id, failedJob.id, now);
      }
    }
  }

  private ensureFundCenterData(baseDate: Date) {
    const fundAccountCount = this.db
      .prepare('SELECT COUNT(*) AS count FROM fund_accounts')
      .get() as { count: number };
    if (fundAccountCount.count === 0) {
      this.db
        .prepare(
          `
          INSERT INTO fund_accounts (
            id,
            account_name,
            available_balance,
            pending_withdrawal,
            frozen_balance,
            deposit_balance,
            total_recharged,
            total_paid_out,
            status,
            updated_at
          ) VALUES (
            @id,
            @accountName,
            @availableBalance,
            @pendingWithdrawal,
            @frozenBalance,
            @depositBalance,
            @totalRecharged,
            @totalPaidOut,
            @status,
            @updatedAt
          )
        `,
        )
        .run({
          ...fundAccountSeed,
          updatedAt: formatShiftedDateTime(
            baseDate,
            fundAccountSeed.updatedOffsetDays,
            fundAccountSeed.updatedHour,
            fundAccountSeed.updatedMinute,
          ),
        });
    }

    const fundBillCount = this.db.prepare('SELECT COUNT(*) AS count FROM fund_bills').get() as {
      count: number;
    };
    if (fundBillCount.count === 0) {
      fundBillSeeds.forEach((seed) =>
        this.appendFundBill({
          ...seed,
          tradeTime: formatShiftedDateTime(
            baseDate,
            seed.tradeOffsetDays,
            seed.tradeHour,
            seed.tradeMinute,
          ),
        }),
      );
    }

    const withdrawalCount = this.db
      .prepare('SELECT COUNT(*) AS count FROM fund_withdrawals')
      .get() as { count: number };
    if (withdrawalCount.count === 0) {
      const insertWithdrawal = this.db.prepare(
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
        ) VALUES (
          @id,
          @withdrawalNo,
          @tradeTime,
          @tradeNo,
          @storeId,
          @tradeType,
          @amount,
          @fee,
          @arrivalAmount,
          @availableBalance,
          @status,
          @method,
          @receivingAccount,
          @reviewRemark
        )
      `,
      );

      fundWithdrawalSeeds.forEach((seed) =>
        insertWithdrawal.run({
          ...seed,
          tradeTime: formatShiftedDateTime(
            baseDate,
            seed.tradeOffsetDays,
            seed.tradeHour,
            seed.tradeMinute,
          ),
        }),
      );
    }

    const depositCount = this.db
      .prepare('SELECT COUNT(*) AS count FROM fund_deposits')
      .get() as { count: number };
    if (depositCount.count === 0) {
      const insertDeposit = this.db.prepare(
        `
        INSERT INTO fund_deposits (
          id,
          deposit_type,
          store_id,
          industry,
          status,
          amount,
          operate_time,
          action_label,
          trade_time,
          payment_no,
          trade_amount,
          trade_type,
          description
        ) VALUES (
          @id,
          @depositType,
          @storeId,
          @industry,
          @status,
          @amount,
          @operateTime,
          @actionLabel,
          @tradeTime,
          @paymentNo,
          @tradeAmount,
          @tradeType,
          @description
        )
      `,
      );

      fundDepositSeeds.forEach((seed) =>
        insertDeposit.run({
          ...seed,
          operateTime: formatShiftedDateTime(
            baseDate,
            seed.operateOffsetDays,
            seed.operateHour,
            seed.operateMinute,
          ),
          tradeTime: formatShiftedDateTime(
            baseDate,
            seed.tradeOffsetDays,
            seed.tradeHour,
            seed.tradeMinute,
          ),
        }),
      );
    }

    const fundOrderCount = this.db.prepare('SELECT COUNT(*) AS count FROM fund_orders').get() as {
      count: number;
    };
    if (fundOrderCount.count === 0) {
      const insertOrder = this.db.prepare(
        `
        INSERT INTO fund_orders (
          id,
          store_id,
          created_at,
          paid_at,
          order_item,
          cycle_text,
          order_content,
          paid_amount,
          merchant_order_no,
          bill_no,
          payment_no
        ) VALUES (
          @id,
          @storeId,
          @createdAt,
          @paidAt,
          @orderItem,
          @cycleText,
          @orderContent,
          @paidAmount,
          @merchantOrderNo,
          @billNo,
          @paymentNo
        )
      `,
      );

      fundOrderSeeds.forEach((seed) =>
        insertOrder.run({
          ...seed,
          createdAt: formatShiftedDateTime(
            baseDate,
            seed.createdOffsetDays,
            seed.createdHour,
            seed.createdMinute,
          ),
          paidAt: formatShiftedDateTime(
            baseDate,
            seed.paidOffsetDays,
            seed.paidHour,
            seed.paidMinute,
          ),
        }),
      );
    }

    const agentCount = this.db.prepare('SELECT COUNT(*) AS count FROM fund_agents').get() as {
      count: number;
    };
    if (agentCount.count === 0) {
      const insertAgent = this.db.prepare(
        `
        INSERT INTO fund_agents (
          id,
          member_name,
          version_name,
          user_info,
          subscription_info,
          discount_info,
          commission_text,
          commission_status,
          withdrawal_time,
          withdrawal_status,
          withdrawal_amount,
          joined_at,
          agent_level
        ) VALUES (
          @id,
          @memberName,
          @versionName,
          @userInfo,
          @subscriptionInfo,
          @discountInfo,
          @commissionText,
          @commissionStatus,
          @withdrawalTime,
          @withdrawalStatus,
          @withdrawalAmount,
          @joinedAt,
          @agentLevel
        )
      `,
      );

      fundAgentSeeds.forEach((seed) =>
        insertAgent.run({
          ...seed,
          withdrawalTime: formatNullableShiftedDateTime(
            baseDate,
            seed.withdrawalOffsetDays,
            seed.withdrawalHour,
            seed.withdrawalMinute,
          ),
          joinedAt: formatShiftedDateTime(
            baseDate,
            seed.joinedOffsetDays,
            seed.joinedHour,
            seed.joinedMinute,
          ),
        }),
        );
    }

    this.syncFundCenterLedger();
  }

  private ensureSystemMonitoringData(baseDate: Date, includeSampleData: boolean) {
    fs.mkdirSync(this.getBackupRootDir(), { recursive: true });
    fs.mkdirSync(this.getLogArchiveRootDir(), { recursive: true });
    fs.mkdirSync(this.getRecoveryDrillRootDir(), { recursive: true });

    const now = format(baseDate, 'yyyy-MM-dd HH:mm:ss');
    this.syncSystemMonitoringAlerts(now);

    if (!includeSampleData) {
      return;
    }

    const backupCount = this.db
      .prepare('SELECT COUNT(*) AS count FROM system_backup_runs')
      .get() as { count: number };
    if (backupCount.count === 0) {
      this.runSystemBackup('system-monitoring', '系统初始化');
    }

    const archiveCount = this.db
      .prepare('SELECT COUNT(*) AS count FROM system_log_archives')
      .get() as { count: number };
    if (archiveCount.count === 0) {
      this.runSystemLogArchive('system-monitoring', '系统初始化');
    }

    const drillCount = this.db
      .prepare('SELECT COUNT(*) AS count FROM system_recovery_drills')
      .get() as { count: number };
    if (drillCount.count === 0) {
      this.runSystemRecoveryDrill('system-monitoring', '系统初始化');
    }
  }

  private ensureStoreManagementData(includeSampleData: boolean) {
    const baseDate = new Date();
    const adminUserId = this.getAdminUserId();

    const profileCount = this.db
      .prepare('SELECT COUNT(*) AS count FROM store_operator_profile')
      .get() as { count: number };
    if (profileCount.count === 0 && includeSampleData) {
      this.db
        .prepare(
          `
          INSERT INTO store_operator_profile (id, display_name, mobile, updated_at)
          VALUES (1, @displayName, @mobile, @updatedAt)
        `,
        )
        .run({
          displayName: '小布',
          mobile: '19577327716',
          updatedAt: format(baseDate, 'yyyy-MM-dd HH:mm:ss'),
        });
    }

    const ownerAccountCount = this.db
      .prepare('SELECT COUNT(*) AS count FROM store_owner_accounts')
      .get() as { count: number };
    const ownerAccountIds = new Map<string, number>();
    if (includeSampleData && ownerAccountCount.count === 0) {
      const insertOwner = this.db.prepare(
        `
          INSERT INTO store_owner_accounts (
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
            @platform,
            @ownerName,
            @mobile,
            @loginMode,
            @accountStatus,
            @lastAuthorizedAt,
            @lastAuthorizedBy,
            @createdAt,
            @updatedAt
          )
        `,
      );

      [
        {
          key: 'xy-xiaobu',
          platform: 'xianyu',
          ownerName: '小布',
          mobile: '13800138001',
          loginMode: 'sms',
          accountStatus: 'active',
          lastAuthorizedAt: formatDateTime(baseDate, 11, 10, -18),
        },
        {
          key: 'xy-fashion',
          platform: 'xianyu',
          ownerName: '潮玩一号',
          mobile: '13800138002',
          loginMode: 'sms',
          accountStatus: 'active',
          lastAuthorizedAt: formatDateTime(baseDate, 9, 25, -4),
        },
        {
          key: 'xy-digital',
          platform: 'xianyu',
          ownerName: '数码寄卖',
          mobile: '13800138003',
          loginMode: 'password',
          accountStatus: 'expired',
          lastAuthorizedAt: formatDateTime(baseDate, 14, 10, -35),
        },
        {
          key: 'xy-house',
          platform: 'xianyu',
          ownerName: '家居清仓',
          mobile: '13800138004',
          loginMode: 'sms',
          accountStatus: 'invalidated',
          lastAuthorizedAt: formatDateTime(baseDate, 15, 22, -12),
        },
        {
          key: 'xy-books',
          platform: 'xianyu',
          ownerName: '图书副店',
          mobile: '13800138005',
          loginMode: 'sms',
          accountStatus: 'active',
          lastAuthorizedAt: formatDateTime(baseDate, 10, 18, -7),
        },
        {
          key: 'tb-move-a',
          platform: 'taobao',
          ownerName: '搬家淘宝号-A',
          mobile: '13800138006',
          loginMode: 'password',
          accountStatus: 'active',
          lastAuthorizedAt: formatDateTime(baseDate, 16, 40, -2),
        },
        {
          key: 'tb-move-b',
          platform: 'taobao',
          ownerName: '搬家淘宝号-B',
          mobile: '13800138007',
          loginMode: 'password',
          accountStatus: 'active',
          lastAuthorizedAt: formatDateTime(baseDate, 13, 36, -6),
        },
      ].forEach((row) => {
        const result = insertOwner.run({
          ...row,
          lastAuthorizedBy: adminUserId,
          createdAt: row.lastAuthorizedAt,
          updatedAt: row.lastAuthorizedAt,
        });
        ownerAccountIds.set(row.key, Number(result.lastInsertRowid));
      });
    } else {
      const rows = this.db
        .prepare(
          `
            SELECT id, owner_name AS ownerName, mobile
            FROM store_owner_accounts
          `,
        )
        .all() as Array<{ id: number; ownerName: string; mobile: string }>;
      rows.forEach((row) => ownerAccountIds.set(`${row.ownerName}:${row.mobile}`, row.id));
    }

    const storeCount = this.db.prepare('SELECT COUNT(*) AS count FROM managed_stores').get() as {
      count: number;
    };
    if (includeSampleData && storeCount.count === 0) {
      const insertStore = this.db.prepare(
        `
        INSERT INTO managed_stores (
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
          @platform,
          @shopTypeLabel,
          @shopName,
          @sellerNo,
          @nickname,
          @statusText,
          @activationStatus,
          @packageText,
          @publishLimitText,
          @ownerAccountId,
          @createdByUserId,
          @groupName,
          @tagsText,
          @remark,
          @enabled,
          @connectionStatus,
          @authStatus,
          @authExpiresAt,
          @lastSyncAt,
          @healthStatus,
          @lastHealthCheckAt,
          @lastHealthCheckDetail,
          @lastSessionId,
          @lastReauthorizeAt,
          @createdAt,
          @updatedAt
        )
      `,
      );

      const seededStores = [
        {
          seedKey: 'xy-xiaobu',
          platform: 'xianyu',
          shopTypeLabel: '闲鱼店铺',
          shopName: 'XiaoBu',
          sellerNo: 'xy560104526732',
          nickname: 'XiaoBu',
          statusText: '未激活',
          activationStatus: 'pending_activation',
          packageText: '开通提效包',
          publishLimitText: '发布数提至3000!',
          groupName: '闲鱼主店',
          tagsText: this.normalizeStoreTags(['闲鱼', '待激活']),
          remark: '新接入待激活店铺',
          enabled: 1,
          connectionStatus: 'pending_activation',
          authStatus: 'authorized',
          authExpiresAt: formatDateTime(baseDate, 11, 10, 20),
          lastSyncAt: null,
          healthStatus: 'warning',
          lastHealthCheckAt: formatDateTime(baseDate, 11, 10, -18),
          lastHealthCheckDetail: '授权已完成，等待激活。',
          lastSessionId: 'seed-session-xy-xiaobu',
          lastReauthorizeAt: formatDateTime(baseDate, 11, 10, -18),
          createdAt: formatDateTime(baseDate, 11, 10, -18),
          updatedAt: formatDateTime(baseDate, 11, 10, -18),
        },
        {
          seedKey: 'xy-fashion',
          platform: 'xianyu',
          shopTypeLabel: '闲鱼店铺',
          shopName: '潮玩副店',
          sellerNo: 'xy584601422766',
          nickname: '潮玩副店',
          statusText: '基础',
          activationStatus: 'active',
          packageText: '开通提效包',
          publishLimitText: '发布数提至3000!',
          groupName: '潮玩分组',
          tagsText: this.normalizeStoreTags(['闲鱼', '潮玩', '主推']),
          remark: '当前主力经营店铺',
          enabled: 1,
          connectionStatus: 'active',
          authStatus: 'authorized',
          authExpiresAt: formatDateTime(baseDate, 9, 25, 25),
          lastSyncAt: formatDateTime(baseDate, 9, 25, -1),
          healthStatus: 'healthy',
          lastHealthCheckAt: formatDateTime(baseDate, 9, 25, -1),
          lastHealthCheckDetail: '最近同步成功。',
          lastSessionId: 'seed-session-xy-fashion',
          lastReauthorizeAt: formatDateTime(baseDate, 9, 25, -4),
          createdAt: formatDateTime(baseDate, 9, 25, -32),
          updatedAt: formatDateTime(baseDate, 9, 25, -1),
        },
        {
          seedKey: 'xy-digital',
          platform: 'xianyu',
          shopTypeLabel: '闲鱼店铺',
          shopName: '数码寄卖',
          sellerNo: 'xy601244118901',
          nickname: '数码寄卖',
          statusText: '掉线',
          activationStatus: 'offline',
          packageText: '开通提效包',
          publishLimitText: '发布数提至3000!',
          groupName: '数码分组',
          tagsText: this.normalizeStoreTags(['闲鱼', '掉线']),
          remark: '等待重新授权恢复同步',
          enabled: 1,
          connectionStatus: 'offline',
          authStatus: 'expired',
          authExpiresAt: formatDateTime(baseDate, 8, 40, -1),
          lastSyncAt: formatDateTime(baseDate, 20, 15, -5),
          healthStatus: 'offline',
          lastHealthCheckAt: formatDateTime(baseDate, 8, 40, -1),
          lastHealthCheckDetail: '授权已过期，需要重新授权。',
          lastSessionId: 'seed-session-xy-digital-expired',
          lastReauthorizeAt: formatDateTime(baseDate, 14, 10, -35),
          createdAt: formatDateTime(baseDate, 14, 10, -35),
          updatedAt: formatDateTime(baseDate, 8, 40, -1),
        },
        {
          seedKey: 'xy-house',
          platform: 'xianyu',
          shopTypeLabel: '闲鱼店铺',
          shopName: '家居清仓',
          sellerNo: 'xy639880112340',
          nickname: '家居清仓',
          statusText: '异常',
          activationStatus: 'abnormal',
          packageText: '开通提效包',
          publishLimitText: '发布数提至3000!',
          groupName: '家居清仓',
          tagsText: this.normalizeStoreTags(['闲鱼', '异常', '人工复核']),
          remark: '接口返回异常，需人工复核',
          enabled: 1,
          connectionStatus: 'abnormal',
          authStatus: 'invalidated',
          authExpiresAt: formatDateTime(baseDate, 12, 0, 18),
          lastSyncAt: formatDateTime(baseDate, 16, 20, -3),
          healthStatus: 'abnormal',
          lastHealthCheckAt: formatDateTime(baseDate, 16, 55, -1),
          lastHealthCheckDetail: '检测到授权失效或异常返回。',
          lastSessionId: 'seed-session-xy-house-invalidated',
          lastReauthorizeAt: formatDateTime(baseDate, 15, 22, -12),
          createdAt: formatDateTime(baseDate, 15, 22, -12),
          updatedAt: formatDateTime(baseDate, 16, 55, -1),
        },
        {
          seedKey: 'xy-books',
          platform: 'xianyu',
          shopTypeLabel: '闲鱼店铺',
          shopName: '图书副店',
          sellerNo: 'xy662004785512',
          nickname: '图书副店',
          statusText: '已停用',
          activationStatus: 'active',
          packageText: '开通提效包',
          publishLimitText: '发布数提至3000!',
          groupName: '图书清仓',
          tagsText: this.normalizeStoreTags(['闲鱼', '停用']),
          remark: '已停用，不参与调度',
          enabled: 0,
          connectionStatus: 'active',
          authStatus: 'authorized',
          authExpiresAt: formatDateTime(baseDate, 10, 18, 15),
          lastSyncAt: formatDateTime(baseDate, 19, 30, -2),
          healthStatus: 'skipped',
          lastHealthCheckAt: formatDateTime(baseDate, 11, 45, -1),
          lastHealthCheckDetail: '店铺已停用，跳过调度。',
          lastSessionId: 'seed-session-xy-books',
          lastReauthorizeAt: formatDateTime(baseDate, 10, 18, -7),
          createdAt: formatDateTime(baseDate, 10, 18, -7),
          updatedAt: formatDateTime(baseDate, 11, 45, -1),
        },
        {
          seedKey: 'tb-move-a',
          platform: 'taobao',
          shopTypeLabel: '淘宝店铺',
          shopName: '搬家淘宝号-A',
          sellerNo: 'tb839104223301',
          nickname: '搬家淘宝号-A',
          statusText: '已接入',
          activationStatus: 'active',
          packageText: '极速搬家',
          publishLimitText: '已同步 248 件商品',
          groupName: '淘宝搬家',
          tagsText: this.normalizeStoreTags(['淘宝', '搬家', '稳定']),
          remark: '主搬家淘宝店',
          enabled: 1,
          connectionStatus: 'active',
          authStatus: 'authorized',
          authExpiresAt: formatDateTime(baseDate, 16, 40, 22),
          lastSyncAt: formatDateTime(baseDate, 16, 40, -2),
          healthStatus: 'healthy',
          lastHealthCheckAt: formatDateTime(baseDate, 16, 40, -2),
          lastHealthCheckDetail: '同步状态正常。',
          lastSessionId: 'seed-session-tb-move-a',
          lastReauthorizeAt: formatDateTime(baseDate, 16, 40, -2),
          createdAt: formatDateTime(baseDate, 14, 5, -40),
          updatedAt: formatDateTime(baseDate, 16, 40, -2),
        },
        {
          seedKey: 'tb-move-b',
          platform: 'taobao',
          shopTypeLabel: '淘宝店铺',
          shopName: '搬家淘宝号-B',
          sellerNo: 'tb839104331545',
          nickname: '搬家淘宝号-B',
          statusText: '已接入',
          activationStatus: 'active',
          packageText: '极速搬家',
          publishLimitText: '已同步 166 件商品',
          groupName: '淘宝搬家',
          tagsText: this.normalizeStoreTags(['淘宝', '搬家']),
          remark: '备用搬家淘宝店',
          enabled: 1,
          connectionStatus: 'active',
          authStatus: 'authorized',
          authExpiresAt: formatDateTime(baseDate, 13, 36, 18),
          lastSyncAt: formatDateTime(baseDate, 13, 36, -1),
          healthStatus: 'healthy',
          lastHealthCheckAt: formatDateTime(baseDate, 13, 36, -1),
          lastHealthCheckDetail: '同步状态正常。',
          lastSessionId: 'seed-session-tb-move-b',
          lastReauthorizeAt: formatDateTime(baseDate, 13, 36, -6),
          createdAt: formatDateTime(baseDate, 13, 36, -22),
          updatedAt: formatDateTime(baseDate, 13, 36, -1),
        },
      ] as const;

      const storeIds = new Map<string, number>();
      seededStores.forEach((row) => {
        const result = insertStore.run({
          ...row,
          ownerAccountId: ownerAccountIds.get(row.seedKey) ?? null,
          createdByUserId: adminUserId,
        });
        storeIds.set(row.seedKey, Number(result.lastInsertRowid));
      });

      const sessionCount = this.db
        .prepare('SELECT COUNT(*) AS count FROM store_auth_sessions')
        .get() as { count: number };
      if (sessionCount.count === 0) {
        const insertSession = this.db.prepare(
          `
            INSERT INTO store_auth_sessions (
              session_id,
              platform,
              source,
              auth_type,
              status,
              created_at,
              expires_at,
              completed_at,
              invalid_reason,
              store_id,
              owner_account_id,
              created_by_user_id,
              reauthorize,
              mobile,
              nickname
            ) VALUES (
              @sessionId,
              @platform,
              @source,
              @authType,
              @status,
              @createdAt,
              @expiresAt,
              @completedAt,
              @invalidReason,
              @storeId,
              @ownerAccountId,
              @createdByUserId,
              @reauthorize,
              @mobile,
              @nickname
            )
          `,
        );

        [
          {
            sessionId: 'seed-session-xy-xiaobu',
            platform: 'xianyu',
            source: 'shop',
            authType: 11,
            status: 'completed',
            createdAt: formatDateTime(baseDate, 10, 55, -18),
            expiresAt: formatDateTime(baseDate, 11, 10, -18),
            completedAt: formatDateTime(baseDate, 11, 10, -18),
            invalidReason: null,
            storeId: storeIds.get('xy-xiaobu') ?? null,
            ownerAccountId: ownerAccountIds.get('xy-xiaobu') ?? null,
            createdByUserId: adminUserId,
            reauthorize: 0,
            mobile: '13800138001',
            nickname: 'XiaoBu',
          },
          {
            sessionId: 'seed-session-xy-digital-expired',
            platform: 'xianyu',
            source: 'shop',
            authType: 11,
            status: 'expired',
            createdAt: formatDateTime(baseDate, 14, 0, -1),
            expiresAt: formatDateTime(baseDate, 14, 15, -1),
            completedAt: null,
            invalidReason: '授权会话已过期',
            storeId: storeIds.get('xy-digital') ?? null,
            ownerAccountId: ownerAccountIds.get('xy-digital') ?? null,
            createdByUserId: adminUserId,
            reauthorize: 1,
            mobile: '13800138003',
            nickname: '数码寄卖',
          },
          {
            sessionId: 'seed-session-xy-house-invalidated',
            platform: 'xianyu',
            source: 'shop',
            authType: 11,
            status: 'invalidated',
            createdAt: formatDateTime(baseDate, 16, 10, -1),
            expiresAt: formatDateTime(baseDate, 16, 25, -1),
            completedAt: null,
            invalidReason: '回调签名异常，原会话已失效',
            storeId: storeIds.get('xy-house') ?? null,
            ownerAccountId: ownerAccountIds.get('xy-house') ?? null,
            createdByUserId: adminUserId,
            reauthorize: 1,
            mobile: '13800138004',
            nickname: '家居清仓',
          },
          {
            sessionId: 'seed-session-tb-move-a',
            platform: 'taobao',
            source: 'shop',
            authType: 21,
            status: 'completed',
            createdAt: formatDateTime(baseDate, 16, 10, -2),
            expiresAt: formatDateTime(baseDate, 16, 25, -2),
            completedAt: formatDateTime(baseDate, 16, 40, -2),
            invalidReason: null,
            storeId: storeIds.get('tb-move-a') ?? null,
            ownerAccountId: ownerAccountIds.get('tb-move-a') ?? null,
            createdByUserId: adminUserId,
            reauthorize: 0,
            mobile: '13800138006',
            nickname: '搬家淘宝号-A',
          },
        ].forEach((row) => insertSession.run(row));
      }

      const healthCheckCount = this.db
        .prepare('SELECT COUNT(*) AS count FROM store_health_checks')
        .get() as { count: number };
      if (healthCheckCount.count === 0) {
        const insertHealthCheck = this.db.prepare(
          `
            INSERT INTO store_health_checks (
              store_id,
              status,
              detail,
              checked_at,
              triggered_by_user_id,
              trigger_mode
            ) VALUES (
              @storeId,
              @status,
              @detail,
              @checkedAt,
              @triggeredByUserId,
              @triggerMode
            )
          `,
        );

        [
          {
            storeId: storeIds.get('xy-fashion') ?? null,
            status: 'healthy',
            detail: '最近同步成功，可继续参与调度。',
            checkedAt: formatDateTime(baseDate, 9, 25, -1),
            triggeredByUserId: adminUserId,
            triggerMode: 'manual',
          },
          {
            storeId: storeIds.get('xy-digital') ?? null,
            status: 'offline',
            detail: '检测到授权过期或最近同步失败。',
            checkedAt: formatDateTime(baseDate, 8, 40, -1),
            triggeredByUserId: adminUserId,
            triggerMode: 'manual',
          },
          {
            storeId: storeIds.get('xy-house') ?? null,
            status: 'abnormal',
            detail: '检测到接口异常，需要人工复核。',
            checkedAt: formatDateTime(baseDate, 16, 55, -1),
            triggeredByUserId: adminUserId,
            triggerMode: 'manual',
          },
          {
            storeId: storeIds.get('xy-books') ?? null,
            status: 'skipped',
            detail: '店铺已停用，跳过健康检查与任务调度。',
            checkedAt: formatDateTime(baseDate, 11, 45, -1),
            triggeredByUserId: adminUserId,
            triggerMode: 'batch',
          },
        ].forEach((row) => {
          if (row.storeId) {
            insertHealthCheck.run(row);
          }
        });
      }
    }

    const legacyStores = this.db
      .prepare(
        `
          SELECT
            id,
            platform,
            nickname,
            seller_no AS sellerNo,
            owner_account_id AS ownerAccountId,
            created_by_user_id AS createdByUserId,
            activation_status AS activationStatus,
            enabled
          FROM managed_stores
        `,
      )
      .all() as Array<{
      id: number;
      platform: StorePlatform;
      nickname: string;
      sellerNo: string;
      ownerAccountId: number | null;
      createdByUserId: number | null;
      activationStatus: string;
      enabled: number;
    }>;

    legacyStores.forEach((store, index) => {
      const ownerAccountId =
        store.ownerAccountId ??
        this.upsertStoreOwnerAccount({
          platform: store.platform,
          ownerName: store.nickname,
          mobile: `1390000${String(1000 + index).padStart(4, '0')}`,
          loginMode: 'sms',
          authorizedByUserId: adminUserId,
        });

      const connectionStatus =
        store.activationStatus === 'pending_activation'
          ? 'pending_activation'
          : (['active', 'offline', 'abnormal'].includes(store.activationStatus)
              ? store.activationStatus
              : 'active') as StoreConnectionStatus;
      const enabled = typeof store.enabled === 'number' ? store.enabled : 1;

      this.db
        .prepare(
          `
            UPDATE managed_stores
            SET
              owner_account_id = COALESCE(owner_account_id, @ownerAccountId),
              created_by_user_id = COALESCE(created_by_user_id, @createdByUserId),
              group_name = COALESCE(NULLIF(group_name, ''), @groupName),
              tags_text = COALESCE(tags_text, @tagsText),
              remark = COALESCE(remark, ''),
              enabled = COALESCE(enabled, @enabled),
              connection_status = COALESCE(connection_status, @connectionStatus),
              auth_status = COALESCE(auth_status, 'authorized'),
              auth_expires_at = COALESCE(auth_expires_at, @authExpiresAt),
              health_status = COALESCE(
                health_status,
                CASE
                  WHEN @connectionStatus = 'pending_activation' THEN 'warning'
                  ELSE 'healthy'
                END
              ),
              status_text = @statusText
            WHERE id = @id
          `,
        )
        .run({
          id: store.id,
          ownerAccountId,
          createdByUserId: store.createdByUserId ?? adminUserId,
          groupName: store.platform === 'xianyu' ? '闲鱼主店' : '淘宝搬家',
          tagsText:
            store.platform === 'xianyu'
              ? this.normalizeStoreTags(['闲鱼'])
              : this.normalizeStoreTags(['淘宝']),
          enabled,
          connectionStatus,
          authExpiresAt: formatDateTime(baseDate, 12, 0, 20),
          statusText: this.getManagedStoreStatusText(connectionStatus, Boolean(enabled)),
      });
    });
  }

  private ensureOrderCenterData(_includeSampleData: boolean) {
    const now = format(new Date(), 'yyyy-MM-dd HH:mm:ss');

    this.db
      .prepare(
        `
          UPDATE orders
          SET
            created_at = COALESCE(paid_at, created_at, @now),
            updated_at = COALESCE(completed_at, shipped_at, paid_at, updated_at, @now),
            delivery_status = CASE
              WHEN order_status = 'pending_shipment' THEN 'pending'
              WHEN order_status = 'shipped' THEN 'shipped'
              WHEN order_status = 'completed' THEN 'delivered'
              ELSE COALESCE(delivery_status, 'manual_review')
            END,
            payment_status = CASE
              WHEN refund_amount >= paid_amount AND paid_amount > 0 THEN 'refunded_full'
              WHEN refund_amount > 0 THEN 'refunded_partial'
              ELSE 'paid'
            END,
            main_status = CASE
              WHEN after_sale_status = 'processing' THEN 'after_sale'
              WHEN order_status = 'pending_shipment' THEN 'paid'
              WHEN order_status = 'shipped' THEN 'fulfilled'
              WHEN order_status = 'completed' THEN 'completed'
              ELSE COALESCE(main_status, 'processing')
            END
        `,
      )
      .run({ now });

    const orders = this.db
      .prepare(
        `
          SELECT
            o.id,
            o.order_no AS orderNo,
            o.product_id AS productId,
            p.name AS productName,
            p.sku AS productSku,
            p.category AS category,
            p.price AS unitPrice,
            s.name AS storeName,
            c.name AS customerName,
            o.quantity,
            o.paid_amount AS paidAmount,
            o.discount_amount AS discountAmount,
            o.refund_amount AS refundAmount,
            o.main_status AS mainStatus,
            o.payment_status AS paymentStatus,
            o.delivery_status AS deliveryStatus,
            o.after_sale_status AS afterSaleStatus,
            o.paid_at AS paidAt,
            o.shipped_at AS shippedAt,
            o.completed_at AS completedAt,
            o.updated_at AS updatedAt
          FROM orders o
          LEFT JOIN products p ON p.id = o.product_id
          LEFT JOIN stores s ON s.id = o.store_id
          LEFT JOIN customers c ON c.id = o.customer_id
          ORDER BY o.id ASC
        `,
      )
      .all() as Array<{
      id: number;
      orderNo: string;
      productId: number;
      productName: string;
      productSku: string;
      category: string;
      unitPrice: number;
      storeName: string;
      customerName: string;
      quantity: number;
      paidAmount: number;
      discountAmount: number;
      refundAmount: number;
      mainStatus: OrderMainStatus;
      paymentStatus: OrderPaymentStatus;
      deliveryStatus: OrderDeliveryStatus;
      afterSaleStatus: string;
      paidAt: string;
      shippedAt: string | null;
      completedAt: string | null;
      updatedAt: string;
    }>;

    if (orders.length === 0) {
      return;
    }

    const orderIdsWithItems = new Set(
      (
        this.db.prepare('SELECT DISTINCT order_id AS orderId FROM order_items').all() as Array<{
          orderId: number;
        }>
      ).map((row) => row.orderId),
    );
    const orderIdsWithPayments = new Set(
      (
        this.db.prepare('SELECT DISTINCT order_id AS orderId FROM order_payments').all() as Array<{
          orderId: number;
        }>
      ).map((row) => row.orderId),
    );
    const orderIdsWithEvents = new Set(
      (
        this.db.prepare('SELECT DISTINCT order_id AS orderId FROM order_events').all() as Array<{
          orderId: number;
        }>
      ).map((row) => row.orderId),
    );

    const insertItem = this.db.prepare(
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
          @orderId,
          1,
          @productId,
          @productName,
          @productSku,
          @category,
          @quantity,
          @unitPrice,
          @paidAmount,
          @deliveryStatus,
          @afterSaleStatus,
          @createdAt,
          @updatedAt
        )
      `,
    );

    const insertPayment = this.db.prepare(
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
          @orderId,
          @paymentNo,
          '支付宝',
          @paymentStatus,
          @grossAmount,
          @discountAmount,
          @paidAmount,
          @paidAt,
          @settledAt,
          @createdAt,
          @updatedAt
        )
      `,
    );

    const insertEvent = this.db.prepare(
      `
        INSERT INTO order_events (
          order_id,
          event_type,
          event_title,
          event_detail,
          operator_name,
          created_at
        ) VALUES (
          @orderId,
          @eventType,
          @eventTitle,
          @eventDetail,
          @operatorName,
          @createdAt
        )
      `,
    );

    this.db.transaction(() => {
      orders.forEach((order) => {
        if (!orderIdsWithItems.has(order.id)) {
          insertItem.run({
            orderId: order.id,
            productId: order.productId,
            productName: order.productName,
            productSku: order.productSku,
            category: order.category,
            quantity: order.quantity,
            unitPrice: order.unitPrice,
            paidAmount: order.paidAmount,
            deliveryStatus: order.deliveryStatus,
            afterSaleStatus: order.afterSaleStatus,
            createdAt: order.paidAt,
            updatedAt: order.updatedAt,
          });
        }

        if (!orderIdsWithPayments.has(order.id)) {
          insertPayment.run({
            orderId: order.id,
            paymentNo: `PAY${order.orderNo}`,
            paymentStatus: order.paymentStatus,
            grossAmount: Number((order.paidAmount + order.discountAmount).toFixed(2)),
            discountAmount: order.discountAmount,
            paidAmount: order.paidAmount,
            paidAt: order.paidAt,
            settledAt: order.shippedAt ?? order.paidAt,
            createdAt: order.paidAt,
            updatedAt: order.updatedAt,
          });
        }

        if (!orderIdsWithEvents.has(order.id)) {
          insertEvent.run({
            orderId: order.id,
            eventType: 'order_created',
            eventTitle: '订单创建',
            eventDetail: `${order.customerName} 在 ${order.storeName} 创建了订单，商品为 ${order.productName}。`,
            operatorName: '系统',
            createdAt: order.paidAt,
          });

          insertEvent.run({
            orderId: order.id,
            eventType: 'payment_paid',
            eventTitle: '支付成功',
            eventDetail: `支付金额 ${order.paidAmount} 元，支付渠道为支付宝。`,
            operatorName: '系统',
            createdAt: order.paidAt,
          });

          if (order.shippedAt) {
            insertEvent.run({
              orderId: order.id,
              eventType: 'delivery_updated',
              eventTitle: order.deliveryStatus === 'delivered' ? '订单已交付' : '订单已发货',
              eventDetail:
                order.deliveryStatus === 'delivered'
                  ? '订单已进入已交付状态，可继续流转为已完成。'
                  : '订单已从待发货进入已发货状态。',
              operatorName: '履约系统',
              createdAt: order.shippedAt,
            });
          }

          if (order.afterSaleStatus !== 'none') {
            insertEvent.run({
              orderId: order.id,
              eventType: 'after_sale_updated',
              eventTitle: order.afterSaleStatus === 'processing' ? '发起售后' : '售后已完结',
              eventDetail:
                order.afterSaleStatus === 'processing'
                  ? '订单进入售后处理中状态，等待人工处理。'
                  : `售后已完结，退款金额 ${order.refundAmount} 元。`,
              operatorName: '售后中心',
              createdAt: order.updatedAt,
            });
          }

          if (order.completedAt) {
            insertEvent.run({
              orderId: order.id,
              eventType: 'order_completed',
              eventTitle: '订单完成',
              eventDetail: '订单完成归档，可作为后续履约、售后、资金联动主线。',
              operatorName: '系统',
              createdAt: order.completedAt,
            });
          }
        }
      });
    })();
  }

  private ensureAfterSaleCenterData(includeSampleData: boolean) {
    const now = format(new Date(), 'yyyy-MM-dd HH:mm:ss');
    const existingCaseIds = this.db
      .prepare('SELECT id FROM after_sale_cases ORDER BY id')
      .all() as Array<{ id: number }>;

    if (existingCaseIds.length > 0) {
      existingCaseIds.forEach((row) => this.refreshAfterSaleReminders(row.id, now));
      return;
    }

    if (!includeSampleData) {
      return;
    }

    const refundOrder = this.db
      .prepare(
        `
          SELECT o.id, o.order_no AS orderNo, o.paid_amount AS paidAmount
          FROM orders o
          LEFT JOIN card_delivery_items cdi ON cdi.product_id = o.product_id
          LEFT JOIN direct_charge_items dci ON dci.product_id = o.product_id
          WHERE cdi.id IS NULL
            AND dci.id IS NULL
          ORDER BY o.id ASC
          LIMIT 1
        `,
      )
      .get() as { id: number; orderNo: string; paidAmount: number } | undefined;

    const resendOrder = this.db
      .prepare(
        `
          SELECT o.id, o.order_no AS orderNo
          FROM orders o
          INNER JOIN card_outbound_records cor ON cor.order_id = o.id
          GROUP BY o.id
          ORDER BY MAX(cor.id) DESC
          LIMIT 1
        `,
      )
      .get() as { id: number; orderNo: string } | undefined;

    const disputeOrder = this.db
      .prepare(
        `
          SELECT o.id, o.order_no AS orderNo
          FROM orders o
          INNER JOIN direct_charge_jobs dcj ON dcj.order_id = o.id
          GROUP BY o.id
          ORDER BY MAX(dcj.id) DESC
          LIMIT 1
        `,
      )
      .get() as { id: number; orderNo: string } | undefined;

    if (!refundOrder || !resendOrder || !disputeOrder) {
      return;
    }

    const insertCase = this.db.prepare(
      `
        INSERT INTO after_sale_cases (
          case_no,
          order_id,
          case_type,
          case_status,
          priority,
          source_channel,
          reason,
          customer_request,
          expectation,
          latest_result,
          sla_deadline_at,
          created_at,
          updated_at,
          closed_at
        ) VALUES (
          @caseNo,
          @orderId,
          @caseType,
          @caseStatus,
          @priority,
          'manual',
          @reason,
          @customerRequest,
          @expectation,
          @latestResult,
          @deadlineAt,
          @createdAt,
          @updatedAt,
          @closedAt
        )
      `,
    );
    const insertRefund = this.db.prepare(
      `
        INSERT INTO after_sale_refunds (
          case_id,
          refund_no,
          requested_amount,
          approved_amount,
          refund_status,
          review_note
        ) VALUES (
          @caseId,
          @refundNo,
          @requestedAmount,
          @approvedAmount,
          @refundStatus,
          @reviewNote
        )
      `,
    );
    const insertResend = this.db.prepare(
      `
        INSERT INTO after_sale_resends (
          case_id,
          resend_no,
          fulfillment_type,
          resend_status,
          request_reason,
          result_detail
        ) VALUES (
          @caseId,
          @resendNo,
          @fulfillmentType,
          @resendStatus,
          @requestReason,
          @resultDetail
        )
      `,
    );
    const insertDispute = this.db.prepare(
      `
        INSERT INTO after_sale_disputes (
          case_id,
          dispute_no,
          dispute_type,
          dispute_status,
          responsibility,
          conclusion,
          compensation_amount
        ) VALUES (
          @caseId,
          @disputeNo,
          @disputeType,
          @disputeStatus,
          @responsibility,
          @conclusion,
          @compensationAmount
        )
      `,
    );

    const baseCaseNo = format(new Date(), 'yyyyMMdd');

    this.db.transaction(() => {
      const refundCreatedAt = format(subDays(new Date(), 2), 'yyyy-MM-dd 10:00:00');
      const refundDeadlineAt = format(subDays(new Date(), 1), 'yyyy-MM-dd 12:00:00');
      const refundCase = insertCase.run({
        caseNo: `AS${baseCaseNo}001`,
        orderId: refundOrder.id,
        caseType: 'refund',
        caseStatus: 'pending_review',
        priority: 'high',
        reason: '买家反馈商品与描述不符，申请退款',
        customerRequest: '全额退款',
        expectation: '当天完成退款审核',
        latestResult: '等待客服审核退款申请。',
        deadlineAt: refundDeadlineAt,
        createdAt: refundCreatedAt,
        updatedAt: refundCreatedAt,
        closedAt: null,
      });
      const refundCaseId = Number(refundCase.lastInsertRowid);
      insertRefund.run({
        caseId: refundCaseId,
        refundNo: `RF${baseCaseNo}001`,
        requestedAmount: Number(Math.min(refundOrder.paidAmount, 36.8).toFixed(2)),
        approvedAmount: 0,
        refundStatus: 'pending_review',
        reviewNote: '',
      });
      this.appendAfterSaleRecord(
        refundCaseId,
        'created',
        '退款单已创建',
        `已为订单 ${refundOrder.orderNo} 创建退款单，等待审核。`,
        '售后中心',
        refundCreatedAt,
      );
      this.appendOrderEvent(
        refundOrder.id,
        'after_sale_case_created',
        '售后单已创建',
        '已创建退款售后单，等待客服审核。',
        '售后中心',
        refundCreatedAt,
      );
      this.syncOrderAfterSaleState(refundOrder.id, refundCreatedAt);

      const resendCreatedAt = format(subDays(new Date(), 1), 'yyyy-MM-dd 16:30:00');
      const resendDeadlineAt = format(addMinutes(new Date(), 180), 'yyyy-MM-dd HH:mm:ss');
      const resendCase = insertCase.run({
        caseNo: `AS${baseCaseNo}002`,
        orderId: resendOrder.id,
        caseType: 'resend',
        caseStatus: 'waiting_execute',
        priority: 'urgent',
        reason: '买家反馈卡密已失效，申请补发',
        customerRequest: '重新补发有效卡密',
        expectation: '尽快完成补发',
        latestResult: '补发申请已登记，等待执行。',
        deadlineAt: resendDeadlineAt,
        createdAt: resendCreatedAt,
        updatedAt: resendCreatedAt,
        closedAt: null,
      });
      const resendCaseId = Number(resendCase.lastInsertRowid);
      insertResend.run({
        caseId: resendCaseId,
        resendNo: `RS${baseCaseNo}001`,
        fulfillmentType: 'card',
        resendStatus: 'approved',
        requestReason: '卡密失效',
        resultDetail: '补发审核已通过，待执行。',
      });
      this.appendAfterSaleRecord(
        resendCaseId,
        'created',
        '补发单已创建',
        `已为订单 ${resendOrder.orderNo} 创建补发单。`,
        '售后中心',
        resendCreatedAt,
      );
      this.appendOrderEvent(
        resendOrder.id,
        'after_sale_case_created',
        '售后单已创建',
        '已创建补发售后单，等待执行。',
        '售后中心',
        resendCreatedAt,
      );
      this.syncOrderAfterSaleState(resendOrder.id, resendCreatedAt);

      const disputeCreatedAt = format(subDays(new Date(), 3), 'yyyy-MM-dd 09:20:00');
      const disputeDeadlineAt = format(subDays(new Date(), 1), 'yyyy-MM-dd 18:00:00');
      const disputeCase = insertCase.run({
        caseNo: `AS${baseCaseNo}003`,
        orderId: disputeOrder.id,
        caseType: 'dispute',
        caseStatus: 'processing',
        priority: 'high',
        reason: '买家就到账时效发起争议',
        customerRequest: '要求平台介入说明处理结果',
        expectation: '24 小时内给出结论',
        latestResult: '争议处理中，等待补充履约凭证。',
        deadlineAt: disputeDeadlineAt,
        createdAt: disputeCreatedAt,
        updatedAt: disputeCreatedAt,
        closedAt: null,
      });
      const disputeCaseId = Number(disputeCase.lastInsertRowid);
      insertDispute.run({
        caseId: disputeCaseId,
        disputeNo: `DP${baseCaseNo}001`,
        disputeType: '到账争议',
        disputeStatus: 'processing',
        responsibility: 'pending',
        conclusion: '',
        compensationAmount: 0,
      });
      this.appendAfterSaleRecord(
        disputeCaseId,
        'created',
        '争议单已创建',
        `已为订单 ${disputeOrder.orderNo} 创建争议单，等待登记结论。`,
        '售后中心',
        disputeCreatedAt,
      );
      this.appendOrderEvent(
        disputeOrder.id,
        'after_sale_case_created',
        '售后单已创建',
        '已创建争议售后单，等待进一步处理。',
        '售后中心',
        disputeCreatedAt,
      );
      this.syncOrderAfterSaleState(disputeOrder.id, disputeCreatedAt);

      [refundCaseId, resendCaseId, disputeCaseId].forEach((caseId) =>
        this.refreshAfterSaleReminders(caseId, now),
      );
    })();
  }

  private ensureAiServiceData(includeSampleData: boolean) {
    const now = format(new Date(), 'yyyy-MM-dd HH:mm:ss');
    const settingsCount = this.db
      .prepare('SELECT COUNT(*) AS count FROM ai_service_settings')
      .get() as { count: number };
    if (settingsCount.count === 0) {
      this.db
        .prepare(
          `
            INSERT INTO ai_service_settings (
              id,
              ai_enabled,
              auto_reply_enabled,
              faq_enabled,
              order_query_enabled,
              after_sale_suggestion_enabled,
              high_risk_manual_only,
              boundary_note,
              sensitive_words_text,
              updated_at
            ) VALUES (
              1,
              1,
              1,
              1,
              1,
              1,
              1,
              @boundaryNote,
              @sensitiveWordsText,
              @updatedAt
            )
          `,
        )
        .run({
          boundaryNote:
            'AI 仅可处理 FAQ 和订单状态查询；退款、赔偿、争议、投诉等高风险话题必须转人工。',
          sensitiveWordsText: '投诉,差评,举报,起诉,骗子,赔偿,维权',
          updatedAt: now,
        });
    }

    const knowledgeCount = this.db
      .prepare('SELECT COUNT(*) AS count FROM ai_service_knowledge_items')
      .get() as { count: number };
    if (knowledgeCount.count === 0) {
      const insertKnowledge = this.db.prepare(
        `
          INSERT INTO ai_service_knowledge_items (
            category,
            title,
            keywords_text,
            question_text,
            answer_text,
            enabled,
            risk_level,
            updated_at
          ) VALUES (
            @category,
            @title,
            @keywordsText,
            @questionText,
            @answerText,
            @enabled,
            @riskLevel,
            @updatedAt
          )
        `,
      );

      [
        {
          category: 'faq',
          title: '到账时效',
          keywordsText: '到账,多久,什么时候,发货',
          questionText: '付款后多久可以收到商品或权益？',
          answerText:
            '正常情况下，订单付款后会在系统校验完成后尽快处理。若遇到库存、平台回执或实名校验异常，系统会转人工跟进，请耐心等待消息通知。',
          enabled: 1,
          riskLevel: 'low',
          updatedAt: format(subDays(new Date(), 2), 'yyyy-MM-dd 09:00:00'),
        },
        {
          category: 'faq',
          title: '提现与退款说明',
          keywordsText: '提现,退款,退回,原路',
          questionText: '退款或提现一般如何处理？',
          answerText:
            '退款会按照售后审核结果走原路退回，具体到账时间以支付渠道回执为准；提现类问题需由人工核对信息后处理。',
          enabled: 1,
          riskLevel: 'medium',
          updatedAt: format(subDays(new Date(), 2), 'yyyy-MM-dd 10:00:00'),
        },
        {
          category: 'faq',
          title: '订单查询',
          keywordsText: '订单,状态,物流,查询,进度',
          questionText: '如何查询订单当前处理进度？',
          answerText: '可以直接提供订单号，系统会返回当前订单状态、发货状态和最近更新时间。',
          enabled: 1,
          riskLevel: 'low',
          updatedAt: format(subDays(new Date(), 1), 'yyyy-MM-dd 11:20:00'),
        },
      ].forEach((item) => insertKnowledge.run(item));
    }

    const templateCount = this.db
      .prepare('SELECT COUNT(*) AS count FROM ai_service_reply_templates')
      .get() as { count: number };
    if (templateCount.count === 0) {
      const insertTemplate = this.db.prepare(
        `
          INSERT INTO ai_service_reply_templates (
            scene,
            title,
            trigger_text,
            template_content,
            enabled,
            updated_at
          ) VALUES (
            @scene,
            @title,
            @triggerText,
            @templateContent,
            @enabled,
            @updatedAt
          )
        `,
      );

      [
        {
          scene: 'order_query',
          title: '订单状态自动答复',
          triggerText: '订单,发货,物流,状态',
          templateContent:
            '您好，订单 {orderNo} 当前为 {mainStatusText}，发货状态 {deliveryStatusText}。订单支付时间 {paidAt}，最近一次状态更新于 {latestEventAt}。',
          enabled: 1,
          updatedAt: format(subDays(new Date(), 2), 'yyyy-MM-dd 13:00:00'),
        },
        {
          scene: 'after_sale',
          title: '售后建议回复',
          triggerText: '退款,售后,补发,争议',
          templateContent:
            '建议回复：当前售后单 {caseNo} 为 {caseTypeText}，主状态 {caseStatusText}，{sceneLabel}。最近处理结论：{latestResult}。请人工确认最终口径后发送给买家。',
          enabled: 1,
          updatedAt: format(subDays(new Date(), 2), 'yyyy-MM-dd 14:30:00'),
        },
        {
          scene: 'manual_transfer',
          title: '高风险转人工话术',
          triggerText: '投诉,差评,举报,赔偿',
          templateContent: '当前问题已转人工客服优先处理，稍后会由专员继续跟进。',
          enabled: 1,
          updatedAt: format(subDays(new Date(), 1), 'yyyy-MM-dd 09:40:00'),
        },
      ].forEach((item) => insertTemplate.run(item));
    }

    if (!includeSampleData) {
      return;
    }

    const conversationCount = this.db
      .prepare('SELECT COUNT(*) AS count FROM ai_service_conversations')
      .get() as { count: number };
    if (conversationCount.count > 0) {
      return;
    }

    const faqCustomer = this.db
      .prepare('SELECT id, name FROM customers ORDER BY id ASC LIMIT 1')
      .get() as { id: number; name: string } | undefined;
    const orderConversation = this.db
      .prepare(
        `
          SELECT
            o.id AS orderId,
            o.order_no AS orderNo,
            o.store_id AS storeId,
            s.name AS storeName,
            c.name AS customerName
          FROM orders o
          INNER JOIN stores s ON s.id = o.store_id
          INNER JOIN customers c ON c.id = o.customer_id
          WHERE o.order_status IN ('pending_shipment', 'shipped')
          ORDER BY o.paid_at DESC, o.id DESC
          LIMIT 1
        `,
      )
      .get() as
      | {
          orderId: number;
          orderNo: string;
          storeId: number;
          storeName: string;
          customerName: string;
        }
      | undefined;
    const afterSaleConversation = this.db
      .prepare(
        `
          SELECT
            ac.id AS caseId,
            ac.case_no AS caseNo,
            o.id AS orderId,
            o.order_no AS orderNo,
            o.store_id AS storeId,
            s.name AS storeName,
            c.name AS customerName
          FROM after_sale_cases ac
          INNER JOIN orders o ON o.id = ac.order_id
          INNER JOIN stores s ON s.id = o.store_id
          INNER JOIN customers c ON c.id = o.customer_id
          WHERE ac.case_status IN ('pending_review', 'processing', 'waiting_execute')
          ORDER BY ac.created_at DESC, ac.id DESC
          LIMIT 1
        `,
      )
      .get() as
      | {
          caseId: number;
          caseNo: string;
          orderId: number;
          orderNo: string;
          storeId: number;
          storeName: string;
          customerName: string;
        }
      | undefined;
    const disputeConversation = this.db
      .prepare(
        `
          SELECT
            ac.id AS caseId,
            ac.case_no AS caseNo,
            o.id AS orderId,
            o.order_no AS orderNo,
            o.store_id AS storeId,
            s.name AS storeName,
            c.name AS customerName
          FROM after_sale_cases ac
          INNER JOIN orders o ON o.id = ac.order_id
          INNER JOIN stores s ON s.id = o.store_id
          INNER JOIN customers c ON c.id = o.customer_id
          WHERE ac.case_type = 'dispute'
          ORDER BY ac.created_at DESC, ac.id DESC
          LIMIT 1
        `,
      )
      .get() as
      | {
          caseId: number;
          caseNo: string;
          orderId: number;
          orderNo: string;
          storeId: number;
          storeName: string;
          customerName: string;
        }
      | undefined;

    if (!faqCustomer || !orderConversation || !afterSaleConversation || !disputeConversation) {
      return;
    }

    const insertConversation = this.db.prepare(
      `
        INSERT INTO ai_service_conversations (
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
          @sessionNo,
          @channel,
          @source,
          @customerId,
          @customerName,
          @storeId,
          @orderId,
          @caseId,
          @topic,
          @latestUserIntent,
          @conversationStatus,
          @aiStatus,
          @riskLevel,
          @priority,
          @unreadCount,
          @assignedUserId,
          @boundaryLabel,
          @tagsText,
          @lastMessageAt,
          @createdAt,
          @updatedAt
        )
      `,
    );
    const supportUser = this.db
      .prepare("SELECT id, display_name AS displayName FROM users WHERE username = 'support'")
      .get() as { id: number; displayName: string } | undefined;

    this.db.transaction(() => {
      const faqCreatedAt = format(subDays(new Date(), 1), 'yyyy-MM-dd 09:10:00');
      const faqReplyAt = format(subDays(new Date(), 1), 'yyyy-MM-dd 09:11:00');
      const faqConversation = insertConversation.run({
        sessionNo: `AICS${format(new Date(), 'yyyyMMdd')}001`,
        channel: '闲鱼 IM',
        source: 'FAQ',
        customerId: faqCustomer.id,
        customerName: faqCustomer.name,
        storeId: null,
        orderId: null,
        caseId: null,
        topic: '到账时效咨询',
        latestUserIntent: '付款后多久到账？',
        conversationStatus: 'open',
        aiStatus: 'auto_replied',
        riskLevel: 'low',
        priority: 'medium',
        unreadCount: 0,
        assignedUserId: null,
        boundaryLabel: 'FAQ / 到账时效',
        tagsText: 'FAQ,到账',
        lastMessageAt: faqReplyAt,
        createdAt: faqCreatedAt,
        updatedAt: faqReplyAt,
      });
      const faqConversationId = Number(faqConversation.lastInsertRowid);
      this.appendAiServiceMessage({
        conversationId: faqConversationId,
        senderType: 'customer',
        scene: 'faq',
        content: '请问付款后多久可以到账？',
        status: 'received',
        createdAt: faqCreatedAt,
      });
      this.appendAiServiceMessage({
        conversationId: faqConversationId,
        senderType: 'ai',
        scene: 'faq',
        content: '正常情况下，订单付款后会在系统校验完成后尽快处理。若遇到库存、平台回执或实名校验异常，系统会转人工跟进，请耐心等待消息通知。',
        status: 'sent',
        createdAt: faqReplyAt,
      });

      const orderCreatedAt = format(subDays(new Date(), 1), 'yyyy-MM-dd 11:20:00');
      const orderConversationRow = insertConversation.run({
        sessionNo: `AICS${format(new Date(), 'yyyyMMdd')}002`,
        channel: '闲鱼 IM',
        source: '订单查询',
        customerId: null,
        customerName: orderConversation.customerName,
        storeId: orderConversation.storeId,
        orderId: orderConversation.orderId,
        caseId: null,
        topic: '订单状态查询',
        latestUserIntent: '订单现在到哪一步了？',
        conversationStatus: 'open',
        aiStatus: 'ready',
        riskLevel: 'low',
        priority: 'medium',
        unreadCount: 1,
        assignedUserId: null,
        boundaryLabel: '订单状态答复',
        tagsText: '订单,状态',
        lastMessageAt: orderCreatedAt,
        createdAt: orderCreatedAt,
        updatedAt: orderCreatedAt,
      });
      this.appendAiServiceMessage({
        conversationId: Number(orderConversationRow.lastInsertRowid),
        senderType: 'customer',
        scene: 'order_query',
        content: `订单 ${orderConversation.orderNo} 现在发到哪一步了？`,
        status: 'received',
        createdAt: orderCreatedAt,
      });

      const afterSaleCreatedAt = format(subDays(new Date(), 1), 'yyyy-MM-dd 15:35:00');
      const afterSaleConversationRow = insertConversation.run({
        sessionNo: `AICS${format(new Date(), 'yyyyMMdd')}003`,
        channel: '闲鱼 IM',
        source: '售后咨询',
        customerId: null,
        customerName: afterSaleConversation.customerName,
        storeId: afterSaleConversation.storeId,
        orderId: afterSaleConversation.orderId,
        caseId: afterSaleConversation.caseId,
        topic: '售后处理进度',
        latestUserIntent: '退款进度到哪了？',
        conversationStatus: 'open',
        aiStatus: 'ready',
        riskLevel: 'medium',
        priority: 'high',
        unreadCount: 1,
        assignedUserId: null,
        boundaryLabel: '售后建议',
        tagsText: '售后,退款',
        lastMessageAt: afterSaleCreatedAt,
        createdAt: afterSaleCreatedAt,
        updatedAt: afterSaleCreatedAt,
      });
      this.appendAiServiceMessage({
        conversationId: Number(afterSaleConversationRow.lastInsertRowid),
        senderType: 'customer',
        scene: 'after_sale',
        content: `售后单 ${afterSaleConversation.caseNo} 什么时候能处理好？`,
        status: 'received',
        createdAt: afterSaleCreatedAt,
      });

      const riskCreatedAt = format(subDays(new Date(), 1), 'yyyy-MM-dd 17:50:00');
      const riskConversationRow = insertConversation.run({
        sessionNo: `AICS${format(new Date(), 'yyyyMMdd')}004`,
        channel: '闲鱼 IM',
        source: '高风险投诉',
        customerId: null,
        customerName: disputeConversation.customerName,
        storeId: disputeConversation.storeId,
        orderId: disputeConversation.orderId,
        caseId: disputeConversation.caseId,
        topic: '投诉与赔偿',
        latestUserIntent: '我要投诉并要求赔偿',
        conversationStatus: 'pending_manual',
        aiStatus: 'manual_only',
        riskLevel: 'high',
        priority: 'high',
        unreadCount: 1,
        assignedUserId: null,
        boundaryLabel: '高风险转人工',
        tagsText: '投诉,赔偿,高风险',
        lastMessageAt: riskCreatedAt,
        createdAt: riskCreatedAt,
        updatedAt: riskCreatedAt,
      });
      const riskConversationId = Number(riskConversationRow.lastInsertRowid);
      this.appendAiServiceMessage({
        conversationId: riskConversationId,
        senderType: 'customer',
        scene: 'risk',
        content: '你们是不是骗子？我要投诉并要求赔偿。',
        status: 'received',
        createdAt: riskCreatedAt,
      });
      this.appendAiServiceMessage({
        conversationId: riskConversationId,
        senderType: 'system',
        scene: 'risk',
        content: '系统已识别为高风险会话，等待人工接管。',
        status: 'blocked',
        createdAt: format(subDays(new Date(), 1), 'yyyy-MM-dd 17:51:00'),
      });

      const manualCreatedAt = format(subDays(new Date(), 1), 'yyyy-MM-dd 20:10:00');
      const manualConversationRow = insertConversation.run({
        sessionNo: `AICS${format(new Date(), 'yyyyMMdd')}005`,
        channel: '闲鱼 IM',
        source: '人工纠偏',
        customerId: null,
        customerName: disputeConversation.customerName,
        storeId: disputeConversation.storeId,
        orderId: disputeConversation.orderId,
        caseId: disputeConversation.caseId,
        topic: '人工接管纠偏',
        latestUserIntent: '我需要一个明确处理结果',
        conversationStatus: 'manual_active',
        aiStatus: 'manual_only',
        riskLevel: 'medium',
        priority: 'high',
        unreadCount: 0,
        assignedUserId: supportUser?.id ?? null,
        boundaryLabel: '人工接管',
        tagsText: '人工,纠偏',
        lastMessageAt: format(subDays(new Date(), 1), 'yyyy-MM-dd 20:16:00'),
        createdAt: manualCreatedAt,
        updatedAt: format(subDays(new Date(), 1), 'yyyy-MM-dd 20:16:00'),
      });
      const manualConversationId = Number(manualConversationRow.lastInsertRowid);
      this.appendAiServiceMessage({
        conversationId: manualConversationId,
        senderType: 'customer',
        scene: 'manual_reply',
        content: '这个问题我现在就要明确结果。',
        status: 'received',
        createdAt: manualCreatedAt,
      });
      this.appendAiServiceMessage({
        conversationId: manualConversationId,
        senderType: 'system',
        scene: 'manual_takeover',
        content: `${supportUser?.displayName ?? '客服专员'} 已接管当前会话。`,
        status: 'logged',
        operatorUserId: supportUser?.id ?? null,
        createdAt: format(subDays(new Date(), 1), 'yyyy-MM-dd 20:12:00'),
      });
      this.appendAiServiceMessage({
        conversationId: manualConversationId,
        senderType: 'manual',
        scene: 'manual_reply',
        content: '已经为您转人工核对处理，稍后会按订单与售后记录给出最终结论。',
        status: 'sent',
        operatorUserId: supportUser?.id ?? null,
        createdAt: format(subDays(new Date(), 1), 'yyyy-MM-dd 20:16:00'),
      });
      this.appendAiServiceTakeoverRecord({
        conversationId: manualConversationId,
        actionType: 'takeover',
        operatorUserId: supportUser?.id ?? null,
        operatorName: supportUser?.displayName ?? '客服专员',
        note: '高风险售后会话已人工接管。',
        createdAt: format(subDays(new Date(), 1), 'yyyy-MM-dd 20:12:00'),
      });
    })();
  }

  private ensureAiBargainData(includeSampleData: boolean) {
    const now = format(new Date(), 'yyyy-MM-dd HH:mm:ss');
    const settingsCount = this.db
      .prepare('SELECT COUNT(*) AS count FROM ai_bargain_settings')
      .get() as { count: number };
    if (settingsCount.count === 0) {
      this.db
        .prepare(
          `
            INSERT INTO ai_bargain_settings (
              id,
              ai_enabled,
              auto_bargain_enabled,
              high_risk_manual_only,
              allow_auto_accept,
              boundary_note,
              sensitive_words_text,
              blacklist_notice,
              updated_at
            ) VALUES (
              1,
              1,
              1,
              1,
              1,
              @boundaryNote,
              @sensitiveWordsText,
              @blacklistNotice,
              @updatedAt
            )
          `,
        )
        .run({
          boundaryNote: 'AI 议价只能在最低价与目标价之间自动让价；黑名单、敏感词和高风险买家必须转人工。',
          sensitiveWordsText: '投诉,差评,举报,骗子,赔偿,维权,退款',
          blacklistNotice: '命中黑名单后必须停止自动议价，并由人工决定是否继续沟通。',
          updatedAt: now,
        });
    }

    const templateCount = this.db
      .prepare('SELECT COUNT(*) AS count FROM ai_bargain_templates')
      .get() as { count: number };
    if (templateCount.count === 0) {
      const insertTemplate = this.db.prepare(
        `
          INSERT INTO ai_bargain_templates (
            scene,
            title,
            trigger_text,
            template_content,
            enabled,
            updated_at
          ) VALUES (
            @scene,
            @title,
            @triggerText,
            @templateContent,
            @enabled,
            @updatedAt
          )
        `,
      );

      [
        {
          scene: 'counter_offer',
          title: '标准还价话术',
          triggerText: '正常让价,梯度让价',
          templateContent:
            '这款 {productName} 当前挂牌 {listedPrice} 元。您这次出价 {buyerOffer} 元，系统可给到的当前报价是 {counterPrice} 元，仍在规则允许范围内。',
          enabled: 1,
          updatedAt: format(subDays(new Date(), 2), 'yyyy-MM-dd 10:10:00'),
        },
        {
          scene: 'floor_protection',
          title: '底价保护话术',
          triggerText: '底价保护,最低价',
          templateContent:
            '当前商品最低可成交价为 {minPrice} 元。您这次出价 {buyerOffer} 元，系统只能按 {counterPrice} 元继续沟通，不会突破底价。',
          enabled: 1,
          updatedAt: format(subDays(new Date(), 2), 'yyyy-MM-dd 10:30:00'),
        },
        {
          scene: 'accept_offer',
          title: '自动成交话术',
          triggerText: '目标价内,自动成交',
          templateContent:
            '您的报价 {buyerOffer} 元已达到当前策略目标，可以按 {counterPrice} 元直接成交，我这边为您保留当前价格。',
          enabled: 1,
          updatedAt: format(subDays(new Date(), 2), 'yyyy-MM-dd 11:10:00'),
        },
        {
          scene: 'reject_offer',
          title: '拒绝报价话术',
          triggerText: '低于底价,拒绝',
          templateContent:
            '当前报价低于最低成交价 {minPrice} 元，系统不能继续自动让价。如需继续沟通，请转人工确认。',
          enabled: 1,
          updatedAt: format(subDays(new Date(), 1), 'yyyy-MM-dd 09:15:00'),
        },
      ].forEach((item) => insertTemplate.run(item));
    }

    const strategyCount = this.db
      .prepare('SELECT COUNT(*) AS count FROM ai_bargain_strategies')
      .get() as { count: number };
    if (strategyCount.count === 0) {
      const products = this.db
        .prepare(
          `
            SELECT
              p.id,
              p.store_id AS storeId,
              s.name AS storeName,
              p.name,
              p.price
            FROM products p
            INNER JOIN stores s ON s.id = p.store_id
            ORDER BY p.id ASC
            LIMIT 3
          `,
        )
        .all() as Array<{
        id: number;
        storeId: number;
        storeName: string;
        name: string;
        price: number;
      }>;
      const insertStrategy = this.db.prepare(
        `
          INSERT INTO ai_bargain_strategies (
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
            @productId,
            @storeId,
            @strategyName,
            @productName,
            @listedPrice,
            @minPrice,
            @targetPrice,
            @stepPrice,
            @maxRounds,
            @enabled,
            @riskTagsText,
            @updatedAt
          )
        `,
      );

      products.forEach((product, index) => {
        const listedPrice = Number(product.price.toFixed(2));
        const minPrice = Number((listedPrice * 0.9).toFixed(2));
        const targetPrice = Number((listedPrice - Math.max(1, listedPrice * 0.05)).toFixed(2));
        const stepPrice = Number(Math.max(1, listedPrice * 0.02).toFixed(2));
        insertStrategy.run({
          productId: product.id,
          storeId: product.storeId,
          strategyName: `${product.name}标准策略`,
          productName: product.name,
          listedPrice,
          minPrice,
          targetPrice: Math.max(minPrice, targetPrice),
          stepPrice,
          maxRounds: index === 0 ? 3 : index === 1 ? 2 : 4,
          enabled: 1,
          riskTagsText: index === 0 ? '标准,自动成交' : index === 1 ? '底价保护,重点' : '保守,观察',
          updatedAt: format(subDays(new Date(), 1), `yyyy-MM-dd ${String(index + 9).padStart(2, '0')}:20:00`),
        });
      });
    }

    const blacklistCount = this.db
      .prepare('SELECT COUNT(*) AS count FROM ai_bargain_blacklist')
      .get() as { count: number };
    if (blacklistCount.count === 0) {
      const customers = this.db
        .prepare('SELECT id, name FROM customers ORDER BY id ASC LIMIT 4')
        .all() as Array<{ id: number; name: string }>;
      const insertBlacklist = this.db.prepare(
        `
          INSERT INTO ai_bargain_blacklist (
            customer_id,
            customer_name,
            reason,
            enabled,
            updated_at
          ) VALUES (
            @customerId,
            @customerName,
            @reason,
            @enabled,
            @updatedAt
          )
        `,
      );

      if (customers[2]) {
        insertBlacklist.run({
          customerId: customers[2].id,
          customerName: customers[2].name,
          reason: '历史争议和退款偏多，默认禁止自动议价。',
          enabled: 1,
          updatedAt: format(subDays(new Date(), 1), 'yyyy-MM-dd 13:40:00'),
        });
      }
      if (customers[3]) {
        insertBlacklist.run({
          customerId: customers[3].id,
          customerName: customers[3].name,
          reason: '观察名单样例，当前未启用。',
          enabled: 0,
          updatedAt: format(subDays(new Date(), 1), 'yyyy-MM-dd 13:50:00'),
        });
      }
    }

    if (!includeSampleData) {
      return;
    }

    const sessionCount = this.db
      .prepare('SELECT COUNT(*) AS count FROM ai_bargain_sessions')
      .get() as { count: number };
    if (sessionCount.count > 0) {
      return;
    }

    const strategies = this.db
      .prepare(
        `
          SELECT
            st.id,
            st.product_id AS productId,
            st.store_id AS storeId,
            st.strategy_name AS strategyName,
            st.product_name_snapshot AS productName,
            st.listed_price AS listedPrice,
            st.min_price AS minPrice,
            st.target_price AS targetPrice,
            st.step_price AS stepPrice,
            st.max_rounds AS maxRounds
          FROM ai_bargain_strategies st
          ORDER BY st.id ASC
          LIMIT 3
        `,
      )
      .all() as Array<{
      id: number;
      productId: number | null;
      storeId: number | null;
      strategyName: string;
      productName: string;
      listedPrice: number;
      minPrice: number;
      targetPrice: number;
      stepPrice: number;
      maxRounds: number;
    }>;
    const customers = this.db
      .prepare('SELECT id, name FROM customers ORDER BY id ASC LIMIT 4')
      .all() as Array<{ id: number; name: string }>;
    const supportUser = this.db
      .prepare("SELECT id, display_name AS displayName FROM users WHERE username = 'support'")
      .get() as { id: number; displayName: string } | undefined;

    if (strategies.length < 3 || customers.length < 3) {
      return;
    }

    const orderMap = new Map(
      (
        this.db
          .prepare(
            `
              SELECT
                id,
                product_id AS productId,
                order_no AS orderNo
              FROM orders
              ORDER BY paid_at DESC, id DESC
            `,
          )
          .all() as Array<{ id: number; productId: number; orderNo: string }>
      ).map((item) => [item.productId, item]),
    );
    const blacklistCustomer = this.db
      .prepare(
        `
          SELECT
            customer_id AS customerId,
            customer_name AS customerName
          FROM ai_bargain_blacklist
          WHERE enabled = 1
          ORDER BY id ASC
          LIMIT 1
        `,
      )
      .get() as { customerId: number | null; customerName: string } | undefined;

    const insertSession = this.db.prepare(
      `
        INSERT INTO ai_bargain_sessions (
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
          @sessionNo,
          @channel,
          @topic,
          @customerId,
          @customerName,
          @storeId,
          @productId,
          @orderId,
          @strategyId,
          @productName,
          @listedPrice,
          @minPrice,
          @targetPrice,
          @latestBuyerOffer,
          @latestCounterPrice,
          @currentRound,
          @maxRounds,
          @sessionStatus,
          @aiStatus,
          @riskLevel,
          @riskReason,
          @assignedUserId,
          @boundaryLabel,
          @tagsText,
          @lastMessageAt,
          @createdAt,
          @updatedAt
        )
      `,
    );

    this.db.transaction(() => {
      const standardStrategy = strategies[0];
      const acceptStrategy = strategies[1] ?? strategies[0];
      const floorStrategy = strategies[2] ?? strategies[0];
      const standardOrder = orderMap.get(Number(standardStrategy.productId)) ?? null;
      const acceptOrder = orderMap.get(Number(acceptStrategy.productId)) ?? null;
      const floorOrder = orderMap.get(Number(floorStrategy.productId)) ?? null;

      const standardCreatedAt = format(subDays(new Date(), 1), 'yyyy-MM-dd 10:10:00');
      const standardSession = insertSession.run({
        sessionNo: `AIBG${format(new Date(), 'yyyyMMdd')}001`,
        channel: '闲鱼 IM',
        topic: '标准还价',
        customerId: null,
        customerName: '新买家样例',
        storeId: standardStrategy.storeId,
        productId: standardStrategy.productId,
        orderId: standardOrder?.id ?? null,
        strategyId: standardStrategy.id,
        productName: standardStrategy.productName,
        listedPrice: standardStrategy.listedPrice,
        minPrice: standardStrategy.minPrice,
        targetPrice: standardStrategy.targetPrice,
        latestBuyerOffer: Number((standardStrategy.targetPrice - standardStrategy.stepPrice).toFixed(2)),
        latestCounterPrice: null,
        currentRound: 0,
        maxRounds: standardStrategy.maxRounds,
        sessionStatus: 'open',
        aiStatus: 'ready',
        riskLevel: 'low',
        riskReason: '标准买家，可按自动议价策略处理。',
        assignedUserId: null,
        boundaryLabel: '标准议价',
        tagsText: '标准,自动',
        lastMessageAt: standardCreatedAt,
        createdAt: standardCreatedAt,
        updatedAt: standardCreatedAt,
      });
      this.appendAiBargainLog({
        sessionId: Number(standardSession.lastInsertRowid),
        actorType: 'customer',
        actionType: 'buyer_offer',
        offerPrice: Number((standardStrategy.targetPrice - standardStrategy.stepPrice).toFixed(2)),
        messageText: '这个价格还能再便宜一点吗？',
        createdAt: standardCreatedAt,
      });

      const acceptCreatedAt = format(subDays(new Date(), 1), 'yyyy-MM-dd 11:25:00');
      const acceptSession = insertSession.run({
        sessionNo: `AIBG${format(new Date(), 'yyyyMMdd')}002`,
        channel: '闲鱼 IM',
        topic: '自动成交',
        customerId: null,
        customerName: '新买家成交样例',
        storeId: acceptStrategy.storeId,
        productId: acceptStrategy.productId,
        orderId: acceptOrder?.id ?? null,
        strategyId: acceptStrategy.id,
        productName: acceptStrategy.productName,
        listedPrice: acceptStrategy.listedPrice,
        minPrice: acceptStrategy.minPrice,
        targetPrice: acceptStrategy.targetPrice,
        latestBuyerOffer: acceptStrategy.targetPrice,
        latestCounterPrice: null,
        currentRound: 0,
        maxRounds: acceptStrategy.maxRounds,
        sessionStatus: 'open',
        aiStatus: 'ready',
        riskLevel: 'low',
        riskReason: '目标价内买家，可自动成交。',
        assignedUserId: null,
        boundaryLabel: '目标价成交',
        tagsText: '成交,自动',
        lastMessageAt: acceptCreatedAt,
        createdAt: acceptCreatedAt,
        updatedAt: acceptCreatedAt,
      });
      this.appendAiBargainLog({
        sessionId: Number(acceptSession.lastInsertRowid),
        actorType: 'customer',
        actionType: 'buyer_offer',
        offerPrice: acceptStrategy.targetPrice,
        messageText: '按这个价格我现在就拍。',
        createdAt: acceptCreatedAt,
      });

      const floorCreatedAt = format(subDays(new Date(), 1), 'yyyy-MM-dd 14:20:00');
      const floorSession = insertSession.run({
        sessionNo: `AIBG${format(new Date(), 'yyyyMMdd')}003`,
        channel: '闲鱼 IM',
        topic: '底价保护',
        customerId: null,
        customerName: '新买家底价样例',
        storeId: floorStrategy.storeId,
        productId: floorStrategy.productId,
        orderId: floorOrder?.id ?? null,
        strategyId: floorStrategy.id,
        productName: floorStrategy.productName,
        listedPrice: floorStrategy.listedPrice,
        minPrice: floorStrategy.minPrice,
        targetPrice: floorStrategy.targetPrice,
        latestBuyerOffer: Number((floorStrategy.minPrice - floorStrategy.stepPrice * 2).toFixed(2)),
        latestCounterPrice: null,
        currentRound: 1,
        maxRounds: floorStrategy.maxRounds,
        sessionStatus: 'open',
        aiStatus: 'ready',
        riskLevel: 'low',
        riskReason: '当前出价低于最低价，需要底价保护。',
        assignedUserId: null,
        boundaryLabel: '底价保护',
        tagsText: '底价,保护',
        lastMessageAt: floorCreatedAt,
        createdAt: floorCreatedAt,
        updatedAt: floorCreatedAt,
      });
      this.appendAiBargainLog({
        sessionId: Number(floorSession.lastInsertRowid),
        actorType: 'customer',
        actionType: 'buyer_offer',
        offerPrice: Number((floorStrategy.minPrice - floorStrategy.stepPrice * 2).toFixed(2)),
        messageText: '这个价格如果还能再低一点我就下单。',
        createdAt: floorCreatedAt,
      });

      if (blacklistCustomer) {
        const riskCreatedAt = format(subDays(new Date(), 1), 'yyyy-MM-dd 17:05:00');
        const riskSession = insertSession.run({
          sessionNo: `AIBG${format(new Date(), 'yyyyMMdd')}004`,
          channel: '闲鱼 IM',
          topic: '高风险黑名单',
          customerId: blacklistCustomer.customerId,
          customerName: blacklistCustomer.customerName,
          storeId: standardStrategy.storeId,
          productId: standardStrategy.productId,
          orderId: standardOrder?.id ?? null,
          strategyId: standardStrategy.id,
          productName: standardStrategy.productName,
          listedPrice: standardStrategy.listedPrice,
          minPrice: standardStrategy.minPrice,
          targetPrice: standardStrategy.targetPrice,
          latestBuyerOffer: Number((standardStrategy.minPrice - standardStrategy.stepPrice).toFixed(2)),
          latestCounterPrice: null,
          currentRound: 0,
          maxRounds: standardStrategy.maxRounds,
          sessionStatus: 'open',
          aiStatus: 'ready',
          riskLevel: 'high',
          riskReason: '命中议价黑名单，需要人工复核。',
          assignedUserId: null,
          boundaryLabel: '高风险转人工',
          tagsText: '黑名单,高风险',
          lastMessageAt: riskCreatedAt,
          createdAt: riskCreatedAt,
          updatedAt: riskCreatedAt,
        });
        this.appendAiBargainLog({
          sessionId: Number(riskSession.lastInsertRowid),
          actorType: 'customer',
          actionType: 'buyer_offer',
          offerPrice: Number((standardStrategy.minPrice - standardStrategy.stepPrice).toFixed(2)),
          messageText: '不给这个价我就投诉你们。',
          createdAt: riskCreatedAt,
        });
      }

      const manualCreatedAt = format(subDays(new Date(), 1), 'yyyy-MM-dd 20:20:00');
      const manualSession = insertSession.run({
        sessionNo: `AIBG${format(new Date(), 'yyyyMMdd')}005`,
        channel: '闲鱼 IM',
        topic: '人工纠偏样例',
        customerId: customers[0].id,
        customerName: customers[0].name,
        storeId: standardStrategy.storeId,
        productId: standardStrategy.productId,
        orderId: standardOrder?.id ?? null,
        strategyId: standardStrategy.id,
        productName: standardStrategy.productName,
        listedPrice: standardStrategy.listedPrice,
        minPrice: standardStrategy.minPrice,
        targetPrice: standardStrategy.targetPrice,
        latestBuyerOffer: Number((standardStrategy.minPrice + standardStrategy.stepPrice).toFixed(2)),
        latestCounterPrice: standardStrategy.targetPrice,
        currentRound: 1,
        maxRounds: standardStrategy.maxRounds,
        sessionStatus: 'manual_active',
        aiStatus: 'manual_only',
        riskLevel: 'medium',
        riskReason: '买家多次重复压价，已转人工处理。',
        assignedUserId: supportUser?.id ?? null,
        boundaryLabel: '人工接管',
        tagsText: '人工,纠偏',
        lastMessageAt: format(subDays(new Date(), 1), 'yyyy-MM-dd 20:28:00'),
        createdAt: manualCreatedAt,
        updatedAt: format(subDays(new Date(), 1), 'yyyy-MM-dd 20:28:00'),
      });
      const manualSessionId = Number(manualSession.lastInsertRowid);
      this.appendAiBargainLog({
        sessionId: manualSessionId,
        actorType: 'customer',
        actionType: 'buyer_offer',
        offerPrice: Number((standardStrategy.minPrice + standardStrategy.stepPrice).toFixed(2)),
        messageText: '如果今天能便宜一点，我就直接拍。',
        createdAt: manualCreatedAt,
      });
      this.appendAiBargainLog({
        sessionId: manualSessionId,
        actorType: 'system',
        actionType: 'manual_takeover',
        messageText: `${supportUser?.displayName ?? '客服专员'} 已接管当前议价会话。`,
        operatorUserId: supportUser?.id ?? null,
        createdAt: format(subDays(new Date(), 1), 'yyyy-MM-dd 20:24:00'),
      });
      this.appendAiBargainLog({
        sessionId: manualSessionId,
        actorType: 'manual',
        actionType: 'manual_offer',
        offerPrice: Number((standardStrategy.minPrice + standardStrategy.stepPrice).toFixed(2)),
        messageText: '当前可以给您保留人工特批价，确认后我这边帮您锁单。',
        operatorUserId: supportUser?.id ?? null,
        createdAt: format(subDays(new Date(), 1), 'yyyy-MM-dd 20:28:00'),
      });
    })();
  }

  private insertWorkspaceLog(featureKey: string, logType: string, title: string, detail: string) {
    this.db
      .prepare(
        `
        INSERT INTO workspace_logs (feature_key, log_type, title, detail, created_at)
        VALUES (@featureKey, @logType, @title, @detail, @createdAt)
      `,
      )
      .run({
        featureKey,
        logType,
        title,
        detail,
        createdAt: format(new Date(), 'yyyy-MM-dd HH:mm:ss'),
      });
  }

  private touchWorkspace(featureKey: string, updatedAt: string) {
    this.db
      .prepare(
        `
        UPDATE workspace_modules
        SET updated_at = @updatedAt
        WHERE feature_key = @featureKey
      `,
      )
      .run({
        featureKey,
        updatedAt,
      });
  }

  private buildSellerNo(platform: 'xianyu' | 'taobao') {
    const prefix = platform === 'xianyu' ? 'xy' : 'tb';
    const latest = this.db
      .prepare(
        `
        SELECT seller_no AS sellerNo
        FROM managed_stores
        WHERE platform = ?
        ORDER BY id DESC
        LIMIT 1
      `,
      )
      .get(platform) as { sellerNo: string } | undefined;

    const baseNumber = latest
      ? Number(latest.sellerNo.replace(/\D/g, '').slice(-12))
      : platform === 'xianyu'
        ? 560104526732
        : 839104223301;

    return `${prefix}${String(baseNumber + 108244).padStart(12, '0')}`;
  }

  private appendFundBill(row: {
    tradeTime: string;
    billNo: string;
    merchantOrderNo: string;
    paymentNo: string;
    storeId?: number | null;
    itemName: string;
    itemInfo: string;
    amount: number;
    tradeType: string;
    tradeMethod: string;
    balanceAfter: number;
    remark: string;
  }) {
    this.db
      .prepare(
        `
        INSERT INTO fund_bills (
          trade_time,
          bill_no,
          merchant_order_no,
          payment_no,
          store_id,
          item_name,
          item_info,
          amount,
          trade_type,
          trade_method,
          balance_after,
          remark
        ) VALUES (
          @tradeTime,
          @billNo,
          @merchantOrderNo,
          @paymentNo,
          @storeId,
          @itemName,
          @itemInfo,
          @amount,
          @tradeType,
          @tradeMethod,
          @balanceAfter,
          @remark
        )
      `,
      )
      .run(row);
  }

  private seedDemoData() {
    const random = createRandom(20260307);
    const insertUser = this.db.prepare(
      `
        INSERT INTO users (
          username,
          display_name,
          role,
          status,
          password_hash,
          created_at,
          updated_at
        )
        VALUES (?, ?, ?, 'active', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      `,
    );
    insertUser.run('admin', '系统管理员', 'admin', hashPassword('Admin@123456'));
    insertUser.run('operator', '运营专员', 'operator', hashPassword('Operator@123456'));
    insertUser.run('support', '客服专员', 'support', hashPassword('Support@123456'));
    insertUser.run('finance', '财务专员', 'finance', hashPassword('Finance@123456'));

    const insertStore = this.db.prepare(
      'INSERT INTO stores (id, name, manager) VALUES (@id, @name, @manager)',
    );
    STORE_SEEDS.forEach((store) => insertStore.run(store));

    const insertProduct = this.db.prepare(
      'INSERT INTO products (id, store_id, sku, name, category, price, cost, stock) VALUES (@id, @storeId, @sku, @name, @category, @price, @cost, @stock)',
    );
    PRODUCT_SEEDS.forEach((product) => insertProduct.run(product));

    const insertCustomer = this.db.prepare(
      'INSERT INTO customers (id, name, province, registered_at) VALUES (@id, @name, @province, @registeredAt)',
    );

    const customers: Array<{ id: number; name: string; province: string; registeredAt: string }> =
      [];
    for (let index = 1; index <= 220; index += 1) {
      const name = `${chooseRandom(CUSTOMER_PREFIXES, random)}${chooseRandom(CUSTOMER_SUFFIXES, random)}${index}`;
      const province = chooseRandom(PROVINCES, random);
      const registeredAt = format(
        subDays(new Date(), Math.floor(random() * 180) + 10),
        'yyyy-MM-dd',
      );
      const customer = { id: index, name, province, registeredAt };
      customers.push(customer);
      insertCustomer.run(customer);
    }

    const insertOrder = this.db.prepare(`
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
        after_sale_status,
        refund_amount,
        paid_at,
        shipped_at,
        completed_at,
        delivery_hours,
        is_new_customer
      ) VALUES (
        @orderNo,
        @storeId,
        @productId,
        @customerId,
        @source,
        @quantity,
        @paidAmount,
        @discountAmount,
        @orderStatus,
        @afterSaleStatus,
        @refundAmount,
        @paidAt,
        @shippedAt,
        @completedAt,
        @deliveryHours,
        @isNewCustomer
      )
    `);

    const insertTraffic = this.db.prepare(
      'INSERT INTO traffic_daily (report_date, store_id, visitors, inquiries, favorites, paid_customers) VALUES (?, ?, ?, ?, ?, ?)',
    );

    const customerHistory = new Map<number, number>();
    const productSales = new Map<number, number>();
    let sequence = 1;

    for (let dayOffset = 119; dayOffset >= 0; dayOffset -= 1) {
      const currentDate = subDays(new Date(), dayOffset);
      const currentDateText = format(currentDate, 'yyyy-MM-dd');

      STORE_SEEDS.forEach((store) => {
        const visitors = 110 + Math.floor(random() * 180);
        const inquiries = 18 + Math.floor(random() * 28);
        const favorites = 12 + Math.floor(random() * 30);
        const paidCustomers = 6 + Math.floor(random() * 18);
        insertTraffic.run(currentDateText, store.id, visitors, inquiries, favorites, paidCustomers);
      });

      const dailyOrderCount = 20 + Math.floor(random() * 18);
      for (let index = 0; index < dailyOrderCount; index += 1) {
        const store = chooseRandom(STORE_SEEDS, random);
        const products = PRODUCT_SEEDS.filter((item) => item.storeId === store.id);
        const product = chooseRandom(products, random);
        const customer = chooseRandom(customers, random);
        const quantity = random() > 0.8 ? 2 : 1;
        const grossAmount = product.price * quantity;
        const discountAmount = Math.round(grossAmount * (0.02 + random() * 0.16));
        const paidAmount = Number((grossAmount - discountAmount).toFixed(2));
        const ageDays = dayOffset;
        let orderStatus = ORDER_STATUSES[2];
        if (ageDays <= 1) {
          orderStatus = random() > 0.55 ? 'pending_shipment' : 'shipped';
        } else if (ageDays <= 4) {
          orderStatus = random() > 0.35 ? 'shipped' : 'completed';
        }

        let afterSaleStatus = 'none';
        let refundAmount = 0;
        if (random() > 0.91) {
          afterSaleStatus = ageDays <= 7 ? 'processing' : 'resolved';
          refundAmount = Number((paidAmount * (0.3 + random() * 0.7)).toFixed(2));
        }

        const orderHour = 8 + Math.floor(random() * 12);
        const orderMinute = Math.floor(random() * 60);
        const paidAt = formatDateTime(currentDate, orderHour, orderMinute);
        const deliveryHours =
          orderStatus === 'pending_shipment' ? 0 : Number((8 + random() * 36).toFixed(1));
        const shippedAt =
          orderStatus === 'pending_shipment'
            ? null
            : formatDateTime(currentDate, (orderHour + 2) % 24, orderMinute);
        const completedAt =
          orderStatus === 'completed'
            ? formatDateTime(currentDate, (orderHour + 4) % 24, orderMinute, 2)
            : null;

        const previousOrders = customerHistory.get(customer.id) ?? 0;
        customerHistory.set(customer.id, previousOrders + 1);
        productSales.set(product.id, (productSales.get(product.id) ?? 0) + quantity);

        insertOrder.run({
          orderNo: `GF${format(currentDate, 'yyyyMMdd')}${String(sequence).padStart(5, '0')}`,
          storeId: store.id,
          productId: product.id,
          customerId: customer.id,
          source: chooseRandom(SOURCES, random),
          quantity,
          paidAmount,
          discountAmount,
          orderStatus,
          afterSaleStatus,
          refundAmount,
          paidAt,
          shippedAt,
          completedAt,
          deliveryHours,
          isNewCustomer: previousOrders === 0 ? 1 : 0,
        });
        sequence += 1;
      }
    }

    const updateStock = this.db.prepare('UPDATE products SET stock = @stock WHERE id = @id');
    PRODUCT_SEEDS.forEach((product) => {
      const soldQuantity = productSales.get(product.id) ?? 0;
      const restock = Math.floor(random() * 40);
      const stock = Math.max(8, product.stock - soldQuantity + restock);
      updateStock.run({ id: product.id, stock });
    });

    this.setMeta('datasetType', 'demo');
  }

  private refreshDemoTimelineIfNeeded() {
    if (!this.isDemoDataset()) {
      return;
    }

    const latestOrder = this.db
      .prepare('SELECT MAX(substr(paid_at, 1, 10)) AS maxPaidDate FROM orders')
      .get() as { maxPaidDate: string | null };

    if (!latestOrder.maxPaidDate) {
      return;
    }

    const latestDate = parseISO(latestOrder.maxPaidDate);
    if (!isValid(latestDate)) {
      return;
    }

    const deltaDays = differenceInCalendarDays(startOfDay(new Date()), startOfDay(latestDate));
    if (deltaDays <= 0) {
      return;
    }

    const modifier = `${deltaDays} day${deltaDays > 1 ? 's' : ''}`;
    const shiftTimeline = this.db.transaction(() => {
      this.db.prepare(
        `
          UPDATE orders
          SET
            order_no = 'GF' || replace(substr(datetime(paid_at, @modifier), 1, 10), '-', '') || substr(order_no, 11),
            paid_at = datetime(paid_at, @modifier),
            shipped_at = CASE
              WHEN shipped_at IS NULL THEN NULL
              ELSE datetime(shipped_at, @modifier)
            END,
            completed_at = CASE
              WHEN completed_at IS NULL THEN NULL
              ELSE datetime(completed_at, @modifier)
            END,
            created_at = CASE
              WHEN created_at IS NULL THEN NULL
              ELSE datetime(created_at, @modifier)
            END,
            updated_at = CASE
              WHEN updated_at IS NULL THEN NULL
              ELSE datetime(updated_at, @modifier)
            END
        `,
      ).run({ modifier });

      this.db
        .prepare(
          `UPDATE order_items
           SET
             created_at = datetime(created_at, @modifier),
             updated_at = datetime(updated_at, @modifier)`,
        )
        .run({ modifier });

      this.db
        .prepare(
          `UPDATE order_payments
           SET
             paid_at = datetime(paid_at, @modifier),
             settled_at = CASE WHEN settled_at IS NULL THEN NULL ELSE datetime(settled_at, @modifier) END,
             created_at = datetime(created_at, @modifier),
             updated_at = datetime(updated_at, @modifier)`,
        )
        .run({ modifier });

      this.db
        .prepare('UPDATE order_events SET created_at = datetime(created_at, @modifier)')
        .run({ modifier });

      this.db
        .prepare('UPDATE traffic_daily SET report_date = date(report_date, @modifier)')
        .run({ modifier });

      this.db
        .prepare('UPDATE customers SET registered_at = date(registered_at, @modifier)')
        .run({ modifier });

      this.db
        .prepare('UPDATE workspace_modules SET updated_at = datetime(updated_at, @modifier)')
        .run({ modifier });

      this.db
        .prepare('UPDATE workspace_actions SET last_run_at = CASE WHEN last_run_at IS NULL THEN NULL ELSE datetime(last_run_at, @modifier) END')
        .run({ modifier });

      this.db
        .prepare('UPDATE workspace_rules SET updated_at = datetime(updated_at, @modifier)')
        .run({ modifier });

      this.db
        .prepare('UPDATE workspace_tasks SET due_at = datetime(due_at, @modifier)')
        .run({ modifier });

      this.db
        .prepare('UPDATE workspace_logs SET created_at = datetime(created_at, @modifier)')
        .run({ modifier });

      this.db
        .prepare(
          `
          UPDATE card_types
          SET
            created_at = datetime(created_at, @modifier),
            updated_at = datetime(updated_at, @modifier),
            deleted_at = CASE
              WHEN deleted_at IS NULL THEN NULL
              ELSE datetime(deleted_at, @modifier)
            END
        `,
        )
        .run({ modifier });

      this.db
        .prepare('UPDATE card_delivery_items SET updated_at = datetime(updated_at, @modifier)')
        .run({ modifier });

      this.db
        .prepare(
          'UPDATE card_combos SET created_at = datetime(created_at, @modifier), updated_at = datetime(updated_at, @modifier)',
        )
        .run({ modifier });

      this.db
        .prepare(
          'UPDATE card_templates SET created_at = datetime(created_at, @modifier), updated_at = datetime(updated_at, @modifier)',
        )
        .run({ modifier });

      this.db
        .prepare(
          `
          UPDATE card_records
          SET
            paid_at = datetime(paid_at, @modifier),
            confirmed_at = CASE WHEN confirmed_at IS NULL THEN NULL ELSE datetime(confirmed_at, @modifier) END,
            rated_at = CASE WHEN rated_at IS NULL THEN NULL ELSE datetime(rated_at, @modifier) END,
            sent_at = CASE WHEN sent_at IS NULL THEN NULL ELSE datetime(sent_at, @modifier) END,
            created_at = datetime(created_at, @modifier)
        `,
        )
        .run({ modifier });

      this.db
        .prepare(
          `
            UPDATE card_batches
            SET
              imported_at = datetime(imported_at, @modifier),
              created_at = datetime(created_at, @modifier),
              updated_at = datetime(updated_at, @modifier)
          `,
        )
        .run({ modifier });

      this.db
        .prepare(
          `
            UPDATE card_inventory_items
            SET
              locked_at = CASE WHEN locked_at IS NULL THEN NULL ELSE datetime(locked_at, @modifier) END,
              imported_at = datetime(imported_at, @modifier),
              updated_at = datetime(updated_at, @modifier),
              last_used_at = CASE WHEN last_used_at IS NULL THEN NULL ELSE datetime(last_used_at, @modifier) END
          `,
        )
        .run({ modifier });

      this.db
        .prepare(
          `
            UPDATE card_outbound_records
            SET
              created_at = datetime(created_at, @modifier),
              updated_at = datetime(updated_at, @modifier)
          `,
        )
        .run({ modifier });

      this.db
        .prepare('UPDATE card_recycle_records SET created_at = datetime(created_at, @modifier)')
        .run({ modifier });

      this.db
        .prepare(
          `
            UPDATE card_delivery_jobs
            SET
              created_at = datetime(created_at, @modifier),
              updated_at = datetime(updated_at, @modifier),
              last_attempt_at = CASE
                WHEN last_attempt_at IS NULL THEN NULL
                ELSE datetime(last_attempt_at, @modifier)
              END
          `,
        )
        .run({ modifier });

      this.db
        .prepare(
          `
            UPDATE card_stock_alerts
            SET
              created_at = datetime(created_at, @modifier),
              updated_at = datetime(updated_at, @modifier)
          `,
        )
        .run({ modifier });

      this.db
        .prepare(
          `
            UPDATE direct_charge_suppliers
            SET
              created_at = datetime(created_at, @modifier),
              updated_at = datetime(updated_at, @modifier),
              last_dispatch_at = CASE
                WHEN last_dispatch_at IS NULL THEN NULL
                ELSE datetime(last_dispatch_at, @modifier)
              END,
              last_callback_at = CASE
                WHEN last_callback_at IS NULL THEN NULL
                ELSE datetime(last_callback_at, @modifier)
              END
          `,
        )
        .run({ modifier });

      this.db
        .prepare('UPDATE direct_charge_items SET updated_at = datetime(updated_at, @modifier)')
        .run({ modifier });

      this.db
        .prepare(
          `
            UPDATE direct_charge_jobs
            SET
              created_at = datetime(created_at, @modifier),
              updated_at = datetime(updated_at, @modifier),
              last_dispatch_at = CASE
                WHEN last_dispatch_at IS NULL THEN NULL
                ELSE datetime(last_dispatch_at, @modifier)
              END,
              last_callback_at = CASE
                WHEN last_callback_at IS NULL THEN NULL
                ELSE datetime(last_callback_at, @modifier)
              END,
              timeout_at = CASE
                WHEN timeout_at IS NULL THEN NULL
                ELSE datetime(timeout_at, @modifier)
              END
          `,
        )
        .run({ modifier });

      this.db
        .prepare('UPDATE direct_charge_callbacks SET received_at = datetime(received_at, @modifier)')
        .run({ modifier });

      this.db
        .prepare(
          `
            UPDATE direct_charge_reconciliations
            SET
              created_at = datetime(created_at, @modifier),
              updated_at = datetime(updated_at, @modifier)
          `,
        )
        .run({ modifier });

      this.db
        .prepare(
          `
            UPDATE supply_source_systems
            SET
              created_at = datetime(created_at, @modifier),
              updated_at = datetime(updated_at, @modifier),
              last_product_sync_at = CASE
                WHEN last_product_sync_at IS NULL THEN NULL
                ELSE datetime(last_product_sync_at, @modifier)
              END,
              last_inventory_sync_at = CASE
                WHEN last_inventory_sync_at IS NULL THEN NULL
                ELSE datetime(last_inventory_sync_at, @modifier)
              END,
              last_price_sync_at = CASE
                WHEN last_price_sync_at IS NULL THEN NULL
                ELSE datetime(last_price_sync_at, @modifier)
              END,
              last_order_push_at = CASE
                WHEN last_order_push_at IS NULL THEN NULL
                ELSE datetime(last_order_push_at, @modifier)
              END,
              last_callback_at = CASE
                WHEN last_callback_at IS NULL THEN NULL
                ELSE datetime(last_callback_at, @modifier)
              END,
              last_refund_notice_at = CASE
                WHEN last_refund_notice_at IS NULL THEN NULL
                ELSE datetime(last_refund_notice_at, @modifier)
              END
          `,
        )
        .run({ modifier });

      this.db
        .prepare(
          `
            UPDATE supply_source_products
            SET
              last_sync_at = datetime(last_sync_at, @modifier),
              updated_at = datetime(updated_at, @modifier)
          `,
        )
        .run({ modifier });

      this.db
        .prepare(
          `
            UPDATE supply_source_sync_runs
            SET
              created_at = datetime(created_at, @modifier),
              finished_at = datetime(finished_at, @modifier)
          `,
        )
        .run({ modifier });

      this.db
        .prepare(
          `
            UPDATE supply_source_orders
            SET
              pushed_at = CASE
                WHEN pushed_at IS NULL THEN NULL
                ELSE datetime(pushed_at, @modifier)
              END,
              callback_at = CASE
                WHEN callback_at IS NULL THEN NULL
                ELSE datetime(callback_at, @modifier)
              END,
              updated_at = datetime(updated_at, @modifier)
          `,
        )
        .run({ modifier });

      this.db
        .prepare('UPDATE supply_source_callbacks SET received_at = datetime(received_at, @modifier)')
        .run({ modifier });

      this.db
        .prepare(
          `
            UPDATE supply_source_refund_notices
            SET
              notified_at = datetime(notified_at, @modifier),
              updated_at = datetime(updated_at, @modifier)
          `,
        )
        .run({ modifier });

      this.db
        .prepare(
          `
            UPDATE supply_source_reconciliations
            SET
              created_at = datetime(created_at, @modifier),
              updated_at = datetime(updated_at, @modifier)
          `,
        )
        .run({ modifier });

      this.db
        .prepare('UPDATE fund_accounts SET updated_at = datetime(updated_at, @modifier)')
        .run({ modifier });

      this.db
        .prepare('UPDATE fund_bills SET trade_time = datetime(trade_time, @modifier)')
        .run({ modifier });

      this.db
        .prepare('UPDATE fund_withdrawals SET trade_time = datetime(trade_time, @modifier)')
        .run({ modifier });

      this.db
        .prepare(
          'UPDATE fund_deposits SET operate_time = datetime(operate_time, @modifier), trade_time = datetime(trade_time, @modifier)',
        )
        .run({ modifier });

      this.db
        .prepare(
          'UPDATE fund_orders SET created_at = datetime(created_at, @modifier), paid_at = datetime(paid_at, @modifier)',
        )
        .run({ modifier });

      this.db
        .prepare(
          `
          UPDATE fund_agents
          SET
            withdrawal_time = CASE WHEN withdrawal_time IS NULL THEN NULL ELSE datetime(withdrawal_time, @modifier) END,
            joined_at = datetime(joined_at, @modifier)
        `,
        )
        .run({ modifier });

      this.db
        .prepare('UPDATE store_operator_profile SET updated_at = datetime(updated_at, @modifier)')
        .run({ modifier });

      this.db
        .prepare(
          'UPDATE managed_stores SET created_at = datetime(created_at, @modifier), updated_at = datetime(updated_at, @modifier)',
        )
        .run({ modifier });

      this.db
        .prepare(
          `
          UPDATE store_auth_sessions
          SET
            created_at = datetime(created_at, @modifier),
            completed_at = CASE
              WHEN completed_at IS NULL THEN NULL
              ELSE datetime(completed_at, @modifier)
            END
        `,
        )
        .run({ modifier });

      this.db
        .prepare(
          `
            UPDATE ai_service_settings
            SET updated_at = datetime(updated_at, @modifier)
          `,
        )
        .run({ modifier });

      this.db
        .prepare(
          `
            UPDATE ai_service_conversations
            SET
              last_message_at = datetime(last_message_at, @modifier),
              created_at = datetime(created_at, @modifier),
              updated_at = datetime(updated_at, @modifier)
          `,
        )
        .run({ modifier });

      this.db
        .prepare('UPDATE ai_service_messages SET created_at = datetime(created_at, @modifier)')
        .run({ modifier });

      this.db
        .prepare('UPDATE ai_service_takeovers SET created_at = datetime(created_at, @modifier)')
        .run({ modifier });

      this.db
        .prepare('UPDATE ai_service_knowledge_items SET updated_at = datetime(updated_at, @modifier)')
        .run({ modifier });

      this.db
        .prepare('UPDATE ai_service_reply_templates SET updated_at = datetime(updated_at, @modifier)')
        .run({ modifier });

      this.db
        .prepare('UPDATE ai_bargain_settings SET updated_at = datetime(updated_at, @modifier)')
        .run({ modifier });

      this.db
        .prepare(
          `
            UPDATE ai_bargain_strategies
            SET updated_at = datetime(updated_at, @modifier)
          `,
        )
        .run({ modifier });

      this.db
        .prepare(
          `
            UPDATE ai_bargain_sessions
            SET
              last_message_at = datetime(last_message_at, @modifier),
              created_at = datetime(created_at, @modifier),
              updated_at = datetime(updated_at, @modifier)
          `,
        )
        .run({ modifier });

      this.db
        .prepare('UPDATE ai_bargain_logs SET created_at = datetime(created_at, @modifier)')
        .run({ modifier });

      this.db
        .prepare('UPDATE ai_bargain_templates SET updated_at = datetime(updated_at, @modifier)')
        .run({ modifier });

      this.db
        .prepare('UPDATE ai_bargain_blacklist SET updated_at = datetime(updated_at, @modifier)')
        .run({ modifier });
    });

    shiftTimeline();
  }

  private isDemoDataset() {
    const datasetType = this.getMeta('datasetType');
    if (datasetType === 'demo') {
      return true;
    }

    if (datasetType) {
      return false;
    }

    const snapshot = this.db
      .prepare(
        `
          SELECT
            (SELECT COUNT(*) FROM stores) AS storeCount,
            (SELECT COUNT(*) FROM products) AS productCount,
            (
              SELECT COUNT(*)
              FROM users
              WHERE username IN ('admin', 'operator', 'support', 'finance')
            ) AS demoUserCount
        `,
      )
      .get() as {
      storeCount: number;
      productCount: number;
      demoUserCount: number;
    };

    const looksLikeDemo =
      snapshot.storeCount === STORE_SEEDS.length &&
      snapshot.productCount === PRODUCT_SEEDS.length &&
      snapshot.demoUserCount >= 4;

    if (looksLikeDemo) {
      this.setMeta('datasetType', 'demo');
    }

    return looksLikeDemo;
  }

  private getMeta(key: string) {
    const row = this.db.prepare('SELECT value FROM app_meta WHERE key = ?').get(key) as
      | { value: string }
      | undefined;
    return row?.value;
  }

  private setMeta(key: string, value: string) {
    this.db
      .prepare(
        `
          INSERT INTO app_meta (key, value)
          VALUES (@key, @value)
          ON CONFLICT(key) DO UPDATE SET value = excluded.value
        `,
      )
      .run({ key, value });
  }

  private getMetricSummary(filters: QueryFilters): MetricSummary {
    const range = this.resolveDateRange(filters);
    const { whereSql, params } = this.buildOrderWhere(filters, range);
    const afterSaleFilters = this.buildAfterSaleWhere(filters, range);
    const orderSummary = this.db
      .prepare(
        `
        SELECT
          SUM(o.paid_amount) AS salesAmount,
          COUNT(*) AS orderCount,
          AVG(o.paid_amount) AS averageOrderValue,
          SUM(o.refund_amount) AS refundAmount,
          SUM(CASE WHEN o.is_new_customer = 1 THEN 1 ELSE 0 END) AS newCustomerCount,
          SUM(p.cost * o.quantity) AS costAmount,
          AVG(CASE WHEN o.delivery_hours > 0 THEN o.delivery_hours END) AS averageDeliveryHours
        FROM orders o
        LEFT JOIN products p ON p.id = o.product_id
        LEFT JOIN customers c ON c.id = o.customer_id
        ${whereSql}
      `,
      )
      .get(params) as Record<string, number | null>;

    const paymentSummary = this.db
      .prepare(
        `
        SELECT
          SUM(op.gross_amount) AS grossAmount,
          SUM(op.discount_amount) AS discountAmount,
          SUM(op.paid_amount) AS receivedAmount,
          COUNT(op.id) AS paymentCount
        FROM order_payments op
        INNER JOIN orders o ON o.id = op.order_id
        LEFT JOIN products p ON p.id = o.product_id
        LEFT JOIN customers c ON c.id = o.customer_id
        ${whereSql}
      `,
      )
      .get(params) as Record<string, number | null>;
    const afterSaleSummary = this.db
      .prepare(
        `
        SELECT
          SUM(COALESCE(ad.compensation_amount, 0)) AS compensationAmount
        FROM after_sale_cases ac
        INNER JOIN orders o ON o.id = ac.order_id
        LEFT JOIN products p ON p.id = o.product_id
        LEFT JOIN customers c ON c.id = o.customer_id
        LEFT JOIN after_sale_disputes ad ON ad.case_id = ac.id
        ${afterSaleFilters.whereSql}
      `,
      )
      .get(afterSaleFilters.params) as Record<string, number | null>;

    const receivedAmount = Number(paymentSummary.receivedAmount ?? orderSummary.salesAmount ?? 0);
    const refundAmount = Number(orderSummary.refundAmount ?? 0);
    const costAmount = Number(orderSummary.costAmount ?? 0);
    const compensationAmount = Number(afterSaleSummary.compensationAmount ?? 0);
    const grossProfit = receivedAmount - refundAmount - costAmount;

    return {
      grossAmount: Number((paymentSummary.grossAmount ?? receivedAmount).toFixed(2)),
      receivedAmount: Number(receivedAmount.toFixed(2)),
      discountAmount: Number((paymentSummary.discountAmount ?? 0).toFixed(2)),
      salesAmount: Number((orderSummary.salesAmount ?? 0).toFixed(2)),
      orderCount: Number(orderSummary.orderCount ?? 0),
      averageOrderValue: Number((orderSummary.averageOrderValue ?? 0).toFixed(2)),
      averageDeliveryHours: Number((orderSummary.averageDeliveryHours ?? 0).toFixed(2)),
      refundAmount: Number(refundAmount.toFixed(2)),
      newCustomerCount: Number(orderSummary.newCustomerCount ?? 0),
      costAmount: Number(costAmount.toFixed(2)),
      compensationAmount: Number(compensationAmount.toFixed(2)),
      grossProfit: Number(grossProfit.toFixed(2)),
      grossMargin:
        receivedAmount - refundAmount === 0
          ? 0
          : toPercentage((grossProfit / (receivedAmount - refundAmount)) * 100),
      netProfit: Number((grossProfit - compensationAmount).toFixed(2)),
      paymentCount: Number(paymentSummary.paymentCount ?? 0),
    };
  }

  private queryTrendRows(filters: QueryFilters, range: DateRange) {
    const { whereSql, params } = this.buildOrderWhere(filters, range);
    const rows = this.db
      .prepare(
        `
        SELECT
          substr(o.paid_at, 1, 10) AS reportDate,
          SUM(o.paid_amount) AS salesAmount,
          COUNT(*) AS orderCount,
          SUM(o.refund_amount) AS refundAmount
        FROM orders o
        LEFT JOIN products p ON p.id = o.product_id
        LEFT JOIN customers c ON c.id = o.customer_id
        ${whereSql}
        GROUP BY reportDate
        ORDER BY reportDate ASC
      `,
      )
      .all(params) as Array<{
      reportDate: string;
      salesAmount: number;
      orderCount: number;
      refundAmount: number;
    }>;

    const rowMap = new Map(rows.map((row) => [row.reportDate, row]));
    const trend = [];
    for (let cursor = range.start; cursor <= range.end; cursor = addDays(cursor, 1)) {
      const reportDate = format(cursor, 'yyyy-MM-dd');
      const row = rowMap.get(reportDate);
      trend.push({
        reportDate,
        salesAmount: Number((row?.salesAmount ?? 0).toFixed(2)),
        orderCount: Number(row?.orderCount ?? 0),
        refundAmount: Number((row?.refundAmount ?? 0).toFixed(2)),
      });
    }

    return trend;
  }

  private queryGroupBySource(filters: QueryFilters, range: DateRange) {
    const { whereSql, params } = this.buildOrderWhere(filters, range);
    return this.db
      .prepare(
        `
        SELECT
          o.source,
          COUNT(*) AS orderCount,
          SUM(o.paid_amount) AS salesAmount
        FROM orders o
        LEFT JOIN products p ON p.id = o.product_id
        LEFT JOIN customers c ON c.id = o.customer_id
        ${whereSql}
        GROUP BY o.source
        ORDER BY salesAmount DESC
      `,
      )
      .all(params);
  }

  private queryOrderStatusDistribution(filters: QueryFilters, range: DateRange) {
    const { whereSql, params } = this.buildOrderWhere(filters, range);
    return this.db
      .prepare(
        `
        SELECT
          o.order_status AS status,
          COUNT(*) AS orderCount
        FROM orders o
        LEFT JOIN products p ON p.id = o.product_id
        LEFT JOIN customers c ON c.id = o.customer_id
        ${whereSql}
        GROUP BY o.order_status
      `,
      )
      .all(params);
  }

  private queryTopProducts(filters: QueryFilters, range: DateRange, limit: number) {
    const { whereSql, params } = this.buildOrderWhere(filters, range);
    return this.db
      .prepare(
        `
        SELECT
          p.name,
          s.name AS storeName,
          p.category,
          SUM(o.quantity) AS soldQuantity,
          SUM(o.paid_amount) AS salesAmount,
          SUM(o.refund_amount) AS refundAmount
        FROM orders o
        LEFT JOIN products p ON p.id = o.product_id
        LEFT JOIN stores s ON s.id = p.store_id
        LEFT JOIN customers c ON c.id = o.customer_id
        ${whereSql}
        GROUP BY p.id
        ORDER BY salesAmount DESC
        LIMIT @limit
      `,
      )
      .all({ ...params, limit });
  }

  private queryTodayCards() {
    const range = this.resolveDateRange({ preset: 'today' });
    const filters = {
      startDate: range.startIso,
      endDate: range.endIso,
    };
    const summary = this.getMetricSummary(filters);
    const businessCards = this.queryBusinessCards(filters, range);
    const orderStats = new Map(businessCards.orderStats.map((item) => [item.label, item.value]));
    const afterSaleStats = new Map(
      businessCards.afterSaleStats.map((item) => [item.label, item.value]),
    );
    const productStats = new Map(
      businessCards.productStats.map((item) => [item.label, item.value]),
    );

    return [
      { label: '支付金额', value: summary.receivedAmount, unit: 'CNY' },
      { label: '支付订单数', value: summary.orderCount, unit: '单' },
      { label: '支付客单价', value: summary.averageOrderValue, unit: 'CNY' },
      { label: '活跃商品', value: Number(productStats.get('动销商品') ?? 0), unit: '款' },
      { label: '待发货', value: Number(orderStats.get('待发货') ?? 0), unit: '单' },
      { label: '已发货', value: Number(orderStats.get('已发货') ?? 0), unit: '单' },
      { label: '待售后', value: Number(afterSaleStats.get('进行中售后') ?? 0), unit: '单' },
      { label: '退款金额', value: summary.refundAmount, unit: 'CNY' },
    ];
  }

  private queryBusinessCards(filters: QueryFilters, range: DateRange) {
    const { whereSql, params } = this.buildOrderWhere(filters, range);
    const { whereSql: productWhereSql, params: productParams } = this.buildProductWhere(filters);
    const orderRow = this.db
      .prepare(
        `
        SELECT
          SUM(CASE WHEN o.order_status = 'pending_shipment' THEN 1 ELSE 0 END) AS pendingShipment,
          SUM(CASE WHEN o.order_status = 'shipped' THEN 1 ELSE 0 END) AS shippedOrders,
          SUM(CASE WHEN o.order_status = 'completed' THEN 1 ELSE 0 END) AS completedOrders,
          AVG(CASE WHEN o.delivery_hours > 0 THEN o.delivery_hours END) AS averageDeliveryHours,
          SUM(CASE WHEN o.after_sale_status = 'processing' THEN 1 ELSE 0 END) AS processingAfterSales,
          SUM(CASE WHEN o.after_sale_status = 'resolved' THEN 1 ELSE 0 END) AS resolvedAfterSales,
          SUM(o.refund_amount) AS refundAmount
        FROM orders o
        LEFT JOIN products p ON p.id = o.product_id
        LEFT JOIN customers c ON c.id = o.customer_id
        ${whereSql}
      `,
      )
      .get(params) as Record<string, number | null>;

    const productRow = this.db
      .prepare(
        `
        SELECT
          COUNT(*) AS productCount,
          SUM(CASE WHEN stock <= 30 THEN 1 ELSE 0 END) AS lowStockProducts,
          COUNT(DISTINCT category) AS categoryCount
        FROM products p
        ${productWhereSql}
      `,
      )
      .get(productParams) as Record<string, number | null>;

    const activeProductRow = this.db
      .prepare(
        `
        SELECT COUNT(DISTINCT p.id) AS activeProducts
        FROM orders o
        LEFT JOIN products p ON p.id = o.product_id
        LEFT JOIN customers c ON c.id = o.customer_id
        ${whereSql}
      `,
      )
      .get(params) as Record<string, number | null>;

    const totalAfterSales =
      Number(orderRow.processingAfterSales ?? 0) + Number(orderRow.resolvedAfterSales ?? 0);
    const resolvedRate =
      totalAfterSales === 0
        ? 0
        : toPercentage((Number(orderRow.resolvedAfterSales ?? 0) / totalAfterSales) * 100);

    return {
      productStats: [
        { label: '在售商品', value: Number(productRow.productCount ?? 0), unit: '款' },
        { label: '动销商品', value: Number(activeProductRow.activeProducts ?? 0), unit: '款' },
        { label: '低库存商品', value: Number(productRow.lowStockProducts ?? 0), unit: '款' },
        { label: '商品分类数', value: Number(productRow.categoryCount ?? 0), unit: '类' },
      ],
      orderStats: [
        { label: '待发货', value: Number(orderRow.pendingShipment ?? 0), unit: '单' },
        { label: '已发货', value: Number(orderRow.shippedOrders ?? 0), unit: '单' },
        { label: '已完成', value: Number(orderRow.completedOrders ?? 0), unit: '单' },
        {
          label: '平均发货时长',
          value: Number((orderRow.averageDeliveryHours ?? 0).toFixed(1)),
          unit: '小时',
        },
      ],
      afterSaleStats: [
        { label: '进行中售后', value: Number(orderRow.processingAfterSales ?? 0), unit: '单' },
        { label: '已完结售后', value: Number(orderRow.resolvedAfterSales ?? 0), unit: '单' },
        { label: '退款金额', value: Number((orderRow.refundAmount ?? 0).toFixed(2)), unit: 'CNY' },
        { label: '售后完结率', value: resolvedRate, unit: '%' },
      ],
    };
  }

  private normalizeStoreIds(filters: QueryFilters) {
    const storeIds = filters.storeIds?.filter((storeId) => Number.isInteger(storeId) && storeId > 0) ?? [];
    if (storeIds.length > 0) {
      return Array.from(new Set(storeIds));
    }
    if (filters.storeId && Number.isInteger(filters.storeId) && filters.storeId > 0) {
      return [filters.storeId];
    }
    return [];
  }

  private appendStoreScopeClause(
    clauses: string[],
    params: SqlParams,
    column: string,
    filters: QueryFilters,
    prefix: string,
  ) {
    const storeIds = this.normalizeStoreIds(filters);
    if (storeIds.length === 0) {
      return;
    }

    if (storeIds.length === 1) {
      clauses.push(`${column} = @${prefix}StoreId`);
      params[`${prefix}StoreId`] = storeIds[0];
      return;
    }

    const placeholders = storeIds.map((storeId, index) => {
      const key = `${prefix}StoreId${index}`;
      params[key] = storeId;
      return `@${key}`;
    });
    clauses.push(`${column} IN (${placeholders.join(', ')})`);
  }

  private buildOrderWhere(filters: QueryFilters, range: DateRange) {
    const clauses = ['o.paid_at >= @startDate', 'o.paid_at <= @endDate'];
    const params: SqlParams = {
      startDate: `${range.startIso} 00:00:00`,
      endDate: `${range.endIso} 23:59:59`,
    };

    this.appendStoreScopeClause(clauses, params, 'o.store_id', filters, 'order');

    if (filters.productId) {
      clauses.push('o.product_id = @productId');
      params.productId = filters.productId;
    }

    if (filters.category) {
      clauses.push('p.category = @category');
      params.category = filters.category;
    }

    if (filters.source) {
      clauses.push('o.source = @source');
      params.source = filters.source;
    }

    if (filters.mainStatus) {
      clauses.push('o.main_status = @mainStatus');
      params.mainStatus = filters.mainStatus;
    }

    if (filters.deliveryStatus) {
      clauses.push('o.delivery_status = @deliveryStatus');
      params.deliveryStatus = filters.deliveryStatus;
    }

    if (filters.orderStatus) {
      clauses.push('o.order_status = @orderStatus');
      params.orderStatus = filters.orderStatus;
    }

    if (filters.afterSaleStatus) {
      clauses.push('o.after_sale_status = @afterSaleStatus');
      params.afterSaleStatus = filters.afterSaleStatus;
    }

    if (filters.keyword) {
      clauses.push(
        '(o.order_no LIKE @keyword OR p.name LIKE @keyword OR p.sku LIKE @keyword OR c.name LIKE @keyword)',
      );
      params.keyword = `%${filters.keyword}%`;
    }

    return {
      whereSql: `WHERE ${clauses.join(' AND ')}`,
      params,
    };
  }

  private buildAfterSaleWhere(filters: QueryFilters, range: DateRange) {
    const clauses = ['ac.created_at >= @startDate', 'ac.created_at <= @endDate'];
    const params: SqlParams = {
      startDate: `${range.startIso} 00:00:00`,
      endDate: `${range.endIso} 23:59:59`,
    };

    this.appendStoreScopeClause(clauses, params, 'o.store_id', filters, 'afterSale');

    if (filters.productId) {
      clauses.push('o.product_id = @productId');
      params.productId = filters.productId;
    }

    if (filters.category) {
      clauses.push('p.category = @category');
      params.category = filters.category;
    }

    if (filters.source) {
      clauses.push('o.source = @source');
      params.source = filters.source;
    }

    if (filters.afterSaleStatus) {
      clauses.push('o.after_sale_status = @afterSaleStatus');
      params.afterSaleStatus = filters.afterSaleStatus;
    }

    if (filters.caseType) {
      clauses.push('ac.case_type = @caseType');
      params.caseType = filters.caseType;
    }

    if (filters.caseStatus) {
      clauses.push('ac.case_status = @caseStatus');
      params.caseStatus = filters.caseStatus;
    }

    if (filters.keyword) {
      clauses.push(
        '(ac.case_no LIKE @keyword OR o.order_no LIKE @keyword OR p.name LIKE @keyword OR c.name LIKE @keyword)',
      );
      params.keyword = `%${filters.keyword}%`;
    }

    return {
      whereSql: `WHERE ${clauses.join(' AND ')}`,
      params,
    };
  }

  private buildTrafficWhere(filters: QueryFilters, range: DateRange) {
    const clauses = ['td.report_date >= @startDate', 'td.report_date <= @endDate'];
    const params: SqlParams = {
      startDate: range.startIso,
      endDate: range.endIso,
    };

    this.appendStoreScopeClause(clauses, params, 'td.store_id', filters, 'traffic');

    return {
      whereSql: `WHERE ${clauses.join(' AND ')}`,
      params,
    };
  }

  private buildProductWhere(filters: QueryFilters, alias = 'p') {
    const clauses: string[] = [];
    const params: SqlParams = {};

    this.appendStoreScopeClause(clauses, params, `${alias}.store_id`, filters, 'product');

    if (filters.category) {
      clauses.push(`${alias}.category = @productCategory`);
      params.productCategory = filters.category;
    }

    if (filters.keyword) {
      clauses.push(`(${alias}.name LIKE @productKeyword OR ${alias}.sku LIKE @productKeyword)`);
      params.productKeyword = `%${filters.keyword}%`;
    }

    return {
      whereSql: clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '',
      params,
    };
  }

  private resolveDateRange(filters: QueryFilters): DateRange {
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
      start,
      end,
      startIso: format(start, 'yyyy-MM-dd'),
      endIso: format(end, 'yyyy-MM-dd'),
      previousStartIso: format(previousStart, 'yyyy-MM-dd'),
      previousEndIso: format(previousEnd, 'yyyy-MM-dd'),
      dayCount,
    };
  }
}
