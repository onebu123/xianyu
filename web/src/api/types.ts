// 所有 API 类型定义

export type SystemUserRole = 'admin' | 'operator' | 'support' | 'finance';
export type SystemUserStatus = 'active' | 'disabled';

export interface AuthUser {
  id: number;
  username: string;
  displayName: string;
  role: SystemUserRole;
  status: SystemUserStatus;
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string | null;
}

export interface LoginResponse {
  expiresAt: string;
  user: AuthUser;
}

export interface AuthProfileResponse {
  user: AuthUser;
}

export interface DashboardResponse {
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
  channelEfficiency: Array<{
    channelKey: 'card' | 'direct_charge' | 'source_system';
    channelLabel: string;
    orderCount: number;
    successCount: number;
    failedCount: number;
    pendingCount: number;
    manualReviewCount: number;
    successRate: number;
    failureRate: number;
    manualReviewRate: number;
    averageDeliveryHours: number;
    grossProfit: number;
    grossMargin: number;
    netSalesAmount: number;
  }>;
  bargainFunnel: {
    totalSessions: number;
    aiHandledCount: number;
    manualInterventionCount: number;
    agreedCount: number;
    aiHandleRate: number;
    manualInterventionRate: number;
    dealRate: number;
    aiDealRate: number;
  };
  alerts: Array<{
    key: string;
    severity: 'warning' | 'error';
    title: string;
    detail: string;
    metricLabel: string;
    currentValue: number;
    thresholdValue: number;
    unit: '%';
    channelKey: string;
  }>;
  topProducts: Array<{
    name: string;
    storeName: string;
    category: string;
    soldQuantity: number;
    salesAmount: number;
    refundAmount: number;
  }>;
  filters: {
    stores: Array<{ label: string; value: number }>;
    products: Array<{ label: string; value: number }>;
    categories: Array<{ label: string; value: string }>;
    sources: Array<{ label: string; value: string }>;
  };
}

export interface BusinessReportsResponse {
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
  formulas: Array<{
    key: string;
    label: string;
    value: number;
    unit: string;
    formula: string;
    description: string;
  }>;
  paymentSummary: {
    grossAmount: number;
    discountAmount: number;
    receivedAmount: number;
    refundAmount: number;
    netSalesAmount: number;
    paymentCount: number;
  };
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
    overview: Array<{
      key: string;
      label: string;
      value: number;
      unit: string;
      description: string;
    }>;
    statusDistribution: Array<{ status: string; label: string; orderCount: number }>;
    sourceDistribution: Array<{ source: string; orderCount: number; salesAmount: number }>;
    fulfillmentDistribution: Array<{ queue: string; label: string; orderCount: number }>;
  };
  afterSaleStats: {
    overview: Array<{
      key: string;
      label: string;
      value: number;
      unit: string;
      description: string;
    }>;
    typeDistribution: Array<{
      caseType: 'refund' | 'resend' | 'dispute';
      caseTypeText: string;
      caseCount: number;
      resolvedCount: number;
      timeoutCount: number;
      refundAmount: number;
      compensationAmount: number;
    }>;
    statusDistribution: Array<{
      caseStatus: 'pending_review' | 'processing' | 'waiting_execute' | 'resolved' | 'rejected';
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
  filters: DashboardResponse['filters'];
}

export interface OrdersOverview {
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
}

export interface OrdersListResponse {
  total: number;
  page: number;
  pageSize: number;
  list: Array<{
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
    mainStatus: string;
    mainStatusText: string;
    deliveryStatus: string;
    deliveryStatusText: string;
    paymentStatus: string;
    paymentStatusText: string;
    orderStatus: string;
    afterSaleStatus: string;
    fulfillmentType: 'standard' | 'card' | 'direct_charge';
    fulfillmentTypeText: string;
    fulfillmentQueue: 'pending' | 'processing' | 'success' | 'failed' | 'manual_review';
    fulfillmentQueueText: string;
    fulfillmentStage: string;
    fulfillmentStageDetail: string;
    source: string;
    paidAt: string;
    shippedAt: string | null;
    completedAt: string | null;
    updatedAt: string;
    latestEventAt: string | null;
  }>;
}

export interface OrderDetailResponse {
  order: {
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
    customerProvince: string;
    source: string;
    quantity: number;
    paidAmount: number;
    discountAmount: number;
    refundAmount: number;
    mainStatus: string;
    mainStatusText: string;
    paymentStatus: string;
    paymentStatusText: string;
    deliveryStatus: string;
    deliveryStatusText: string;
    orderStatus: string;
    afterSaleStatus: string;
    fulfillmentType: 'standard' | 'card' | 'direct_charge';
    fulfillmentTypeText: string;
    fulfillmentQueue: 'pending' | 'processing' | 'success' | 'failed' | 'manual_review';
    fulfillmentQueueText: string;
    fulfillmentStage: string;
    fulfillmentStageDetail: string;
    paidAt: string;
    shippedAt: string | null;
    completedAt: string | null;
    deliveryHours: number;
    isNewCustomer: boolean;
    buyerNote: string;
    sellerRemark: string;
    createdAt: string;
    updatedAt: string;
  };
  items: Array<{
    id: number;
    lineNo: number;
    productId: number | null;
    productName: string;
    productSku: string;
    category: string;
    quantity: number;
    unitPrice: number;
    paidAmount: number;
    deliveryStatus: string;
    deliveryStatusText: string;
    afterSaleStatus: string;
    createdAt: string;
    updatedAt: string;
  }>;
  payments: Array<{
    id: number;
    paymentNo: string;
    paymentChannel: string;
    paymentStatus: string;
    paymentStatusText: string;
    grossAmount: number;
    discountAmount: number;
    paidAmount: number;
    paidAt: string;
    settledAt: string | null;
    createdAt: string;
    updatedAt: string;
  }>;
  events: Array<{
    id: number;
    eventType: string;
    eventTitle: string;
    eventDetail: string;
    operatorName: string | null;
    createdAt: string;
  }>;
  fulfillment: {
    type: 'standard' | 'card' | 'direct_charge';
    typeText: string;
    queue: 'pending' | 'processing' | 'success' | 'failed' | 'manual_review';
    queueText: string;
    stage: string;
    stageDetail: string;
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
  };
  fulfillmentLogs: Array<{
    id: number;
    eventType: string;
    eventTitle: string;
    eventDetail: string;
    operatorName: string | null;
    createdAt: string;
  }>;
}

export interface OrderFulfillmentWorkbenchResponse {
  queueSummary: {
    total: number;
    pending: number;
    processing: number;
    success: number;
    failed: number;
    manual_review: number;
  };
  exceptionOrders: Array<{
    id: number;
    orderNo: string;
    storeId: number;
    storeName: string;
    productName: string;
    paidAmount: number;
    mainStatus: string;
    deliveryStatus: string;
    updatedAt: string;
    fulfillmentType: 'standard' | 'card' | 'direct_charge';
    fulfillmentTypeText: string;
    fulfillmentQueue: 'pending' | 'processing' | 'success' | 'failed' | 'manual_review';
    fulfillmentQueueText: string;
    fulfillmentStage: string;
    fulfillmentStageDetail: string;
  }>;
  logs: Array<{
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
  storeStats: Array<{
    storeId: number;
    storeName: string;
    totalOrders: number;
    successCount: number;
    failedCount: number;
    manualCount: number;
    processingCount: number;
    successRate: number;
    failedRate: number;
    manualRate: number;
  }>;
}

export interface AfterSaleWorkbenchResponse {
  summary: {
    totalCases: number;
    pendingCases: number;
    processingCases: number;
    resolvedCases: number;
    timeoutCases: number;
    refundCases: number;
    resendCases: number;
    disputeCases: number;
    pendingRefundAmount: number;
  };
  reminders: Array<{
    id: number;
    caseId: number;
    caseNo: string;
    caseType: 'refund' | 'resend' | 'dispute';
    caseTypeText: string;
    caseStatus: string;
    caseStatusText: string;
    orderNo: string;
    storeName: string;
    productName: string;
    reminderType: 'pending' | 'timeout';
    reminderTypeText: string;
    title: string;
    detail: string;
    remindAt: string;
    deadlineAt: string;
  }>;
  pendingCases: Array<{
    id: number;
    caseNo: string;
    orderId: number;
    caseType: 'refund' | 'resend' | 'dispute';
    caseTypeText: string;
    caseStatus: string;
    caseStatusText: string;
    reason: string;
    latestResult: string | null;
    priority: string;
    priorityText: string;
    deadlineAt: string;
    updatedAt: string;
    orderNo: string;
    storeName: string;
    productName: string;
    customerName: string;
    refundStatus: string | null;
    refundStatusText: string | null;
    requestedAmount: number | null;
    resendStatus: string | null;
    resendStatusText: string | null;
    disputeStatus: string | null;
    disputeStatusText: string | null;
    hasTimeoutReminder: number;
  }>;
  timeoutCases: Array<{
    id: number;
    caseNo: string;
    orderId: number;
    caseType: 'refund' | 'resend' | 'dispute';
    caseTypeText: string;
    caseStatus: string;
    caseStatusText: string;
    reason: string;
    latestResult: string | null;
    priority: string;
    priorityText: string;
    deadlineAt: string;
    updatedAt: string;
    orderNo: string;
    storeName: string;
    productName: string;
    customerName: string;
    refundStatus: string | null;
    refundStatusText: string | null;
    requestedAmount: number | null;
    resendStatus: string | null;
    resendStatusText: string | null;
    disputeStatus: string | null;
    disputeStatusText: string | null;
    hasTimeoutReminder: number;
  }>;
}

export interface AfterSaleAutoRefundSettingsResponse {
  enabled: boolean;
  maxAmount: number;
  allowFailedFulfillment: boolean;
  allowDuplicatePurchase: boolean;
  autoComplete: boolean;
  note: string;
  updatedBy: string | null;
  updatedAt: string;
  preview: {
    eligibleCaseCount: number;
    eligibleRefundAmount: number;
    samples: Array<{
      caseId: number;
      caseNo: string;
      orderNo: string;
      requestedAmount: number;
      reasonLabels: string[];
    }>;
  };
}

export interface AfterSaleListResponse {
  total: number;
  page: number;
  pageSize: number;
  list: Array<{
    id: number;
    caseNo: string;
    orderId: number;
    orderNo: string;
    storeName: string;
    productName: string;
    customerName: string;
    caseType: 'refund' | 'resend' | 'dispute';
    caseTypeText: string;
    caseStatus: 'pending_review' | 'processing' | 'waiting_execute' | 'resolved' | 'rejected';
    caseStatusText: string;
    reason: string;
    priority: string;
    priorityText: string;
    latestResult: string | null;
    deadlineAt: string;
    createdAt: string;
    updatedAt: string;
    requestedAmount: number | null;
    approvedAmount: number | null;
    refundStatus: 'pending_review' | 'approved' | 'rejected' | 'refunded' | null;
    refundStatusText: string | null;
    resendStatus: 'requested' | 'approved' | 'processing' | 'succeeded' | 'failed' | 'rejected' | null;
    resendStatusText: string | null;
    disputeStatus: 'open' | 'processing' | 'buyer_win' | 'seller_win' | 'refunded' | 'resent' | null;
    disputeStatusText: string | null;
    compensationAmount: number | null;
    reminderTypes: Array<'pending' | 'timeout'>;
    hasTimeoutReminder: number;
    canReviewRefund: boolean;
    canExecuteResend: boolean;
    canConcludeDispute: boolean;
    canNote: boolean;
  }>;
}

export interface AfterSaleDetailResponse {
  caseInfo: {
    id: number;
    caseNo: string;
    orderId: number;
    orderNo: string;
    caseType: 'refund' | 'resend' | 'dispute';
    caseTypeText: string;
    caseStatus: 'pending_review' | 'processing' | 'waiting_execute' | 'resolved' | 'rejected';
    caseStatusText: string;
    reason: string;
    priority: string;
    priorityText: string;
    latestResult: string | null;
    deadlineAt: string;
    createdAt: string;
    updatedAt: string;
  };
  refund: {
    requestedAmount: number;
    approvedAmount: number;
    refundStatus: 'pending_review' | 'approved' | 'rejected' | 'refunded';
    refundStatusText: string;
  } | null;
  resend: {
    resendStatus: 'requested' | 'approved' | 'processing' | 'succeeded' | 'failed' | 'rejected';
    resendStatusText: string;
    fulfillmentType: 'standard' | 'card' | 'direct_charge' | null;
    relatedOutboundNo: string | null;
    relatedTaskNo: string | null;
  } | null;
  dispute: {
    disputeStatus: 'open' | 'processing' | 'buyer_win' | 'seller_win' | 'refunded' | 'resent';
    disputeStatusText: string;
    compensationAmount: number;
  } | null;
  order: {
    id: number;
    orderNo: string;
    storeName: string;
    productName: string;
    customerName: string;
    paidAmount: number;
    refundAmount: number;
    mainStatus: string;
    mainStatusText: string;
    deliveryStatus: string;
    deliveryStatusText: string;
    afterSaleStatus: string;
    paidAt: string;
    updatedAt: string;
  };
  fulfillment: {
    type: 'standard' | 'card' | 'direct_charge';
    typeText: string;
    queue: 'pending' | 'processing' | 'success' | 'failed' | 'manual_review';
    queueText: string;
    stage: string;
    stageDetail: string;
    latestTaskNo: string | null;
    latestSupplierOrderNo: string | null;
    latestOutboundNo: string | null;
  } | null;
  artifacts: {
    cardOutbounds: Array<{
      outboundNo: string;
      outboundStatus: string;
      reason: string | null;
      createdAt: string;
    }>;
    directJobs: Array<{
      taskNo: string;
      supplierOrderNo: string | null;
      taskStatus: string;
      resultDetail: string | null;
      updatedAt: string;
    }>;
  };
  refundTimeline: Array<{
    key: string;
    label: string;
    status: 'finished' | 'current' | 'pending' | 'rejected';
    at: string | null;
    detail: string;
  }>;
  disputeEvidences: Array<{
    id: number;
    title: string;
    evidenceType: 'image' | 'chat_log' | 'logistics' | 'supplier' | 'other';
    evidenceTypeText: string;
    evidenceUrl: string;
    detail: string;
    operatorName: string | null;
    createdAt: string;
  }>;
  records: Array<{
    id: number;
    recordType: string;
    title: string;
    detail: string;
    operatorName: string | null;
    createdAt: string;
  }>;
  reminders: Array<{
    id: number;
    reminderType: 'pending' | 'timeout';
    reminderTypeText: string;
    reminderStatus: 'active' | 'resolved';
    title: string;
    detail: string;
    remindAt: string;
    resolvedAt: string | null;
  }>;
}

export interface ProductsResponse {
  summary: {
    totalProducts: number;
    totalStock: number;
    activeProducts: number;
    soldQuantity: number;
    salesAmount: number;
    lowStockProducts: number;
    categoryCount: number;
  };
  categorySales: Array<{ category: string; salesAmount: number; soldQuantity: number }>;
  ranking: Array<{
    id: number;
    sku: string;
    name: string;
    category: string;
    price: number;
    storeName: string;
    stock: number;
    soldQuantity: number;
    salesAmount: number;
    orderCount: number;
    afterSaleCount: number;
    firstSaleAt: string | null;
    latestSaleAt: string | null;
  }>;
}

export interface XianyuProductSyncResponse {
  successCount: number;
  totalCount: number;
  results: Array<{
    storeId: number;
    shopName: string;
    providerUserId: string;
    success: boolean;
    fetchedCount?: number;
    syncedCount?: number;
    skippedCount?: number;
    syncedAt?: string;
    message?: string;
  }>;
}

export interface XianyuOrderSyncResponse {
  successCount: number;
  totalCount: number;
  results: Array<{
    storeId: number;
    shopName: string;
    providerUserId: string;
    success: boolean;
    fetchedCount?: number;
    syncedCount?: number;
    skippedCount?: number;
    failedTradeCount?: number;
    syncedAt?: string;
    message?: string;
  }>;
}

export interface CustomersResponse {
  summary: {
    customerCount: number;
    newCustomers: number;
    repeatCustomers: number;
    averageSpend: number;
    repeatRate: number;
  };
  provinceRows: Array<{ province: string; customerCount: number; salesAmount: number }>;
  customerList: Array<{
    id: number;
    name: string;
    province: string;
    orderCount: number;
    totalSpend: number;
    latestOrderAt: string;
  }>;
}

export type StorePlatform = 'xianyu' | 'taobao';
export type StoreConnectionStatus = 'pending_activation' | 'active' | 'offline' | 'abnormal';
export type StoreAuthStatus = 'authorized' | 'expired' | 'invalidated' | 'pending';
export type StoreAuthSessionStatus = 'pending' | 'completed' | 'expired' | 'invalidated';
export type StoreHealthStatus = 'healthy' | 'warning' | 'offline' | 'abnormal' | 'skipped';
export type StoreCredentialRiskLevel = 'pending' | 'healthy' | 'warning' | 'offline' | 'abnormal';
export type StoreAuthIntegrationMode =
  | 'simulated'
  | 'xianyu_browser_oauth'
  | 'xianyu_web_session';
export type StoreProfileSyncStatus = 'pending' | 'syncing' | 'success' | 'failed';
export type StoreAuthSessionNextStep =
  | 'manual_complete'
  | 'wait_provider_callback'
  | 'sync_profile'
  | 'done'
  | 'expired'
  | 'invalidated';

export interface StoreManagementStore {
  id: number;
  platform: StorePlatform;
  shopTypeLabel: string;
  shopName: string;
  sellerNo: string;
  nickname: string;
  statusText: string;
  activationStatus: StoreConnectionStatus;
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
  tagsText?: string | null;
  tags: string[];
  remark: string;
  enabled: boolean;
  scheduleStatus: 'running' | 'paused';
  connectionStatus: StoreConnectionStatus;
  connectionStatusText: string;
  authStatus: StoreAuthStatus;
  authStatusText: string;
  authExpiresAt: string | null;
  lastSyncAt: string | null;
  healthStatus: StoreHealthStatus;
  healthStatusText: string;
  profileSyncStatus: StoreProfileSyncStatus;
  profileSyncStatusText: string;
  profileSyncError: string | null;
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
  lastProfileSyncAt: string | null;
  lastVerifiedAt: string | null;
  lastHealthCheckAt: string | null;
  lastHealthCheckDetail: string | null;
  lastSessionId: string | null;
  lastReauthorizeAt: string | null;
  activationHint: string | null;
}

export interface StoreAuthSessionRecord {
  sessionId: string;
  platform: StorePlatform;
  source: string;
  authType: number;
  status: StoreAuthSessionStatus;
  statusText: string;
  integrationMode: StoreAuthIntegrationMode;
  providerLabel: string | null;
  createdAt: string;
  expiresAt: string | null;
  completedAt: string | null;
  invalidReason: string | null;
  providerAccessTokenReceivedAt: string | null;
  tokenReceived: boolean;
  nextStepKey: StoreAuthSessionNextStep;
  nextStepText: string;
  storeId: number | null;
  ownerAccountId: number | null;
  mobile: string | null;
  nickname: string | null;
  reauthorize: boolean;
  storeName: string | null;
  ownerAccountName: string | null;
  createdByName: string | null;
}

export interface StoreHealthCheckRecord {
  id: number;
  storeId: number;
  storeName: string | null;
  status: StoreHealthStatus;
  statusText: string;
  detail: string;
  checkedAt: string;
  triggerMode: 'manual' | 'batch';
  triggeredByName: string | null;
}

export type StoreCredentialEventType =
  | 'qr_login_started'
  | 'credential_captured'
  | 'profile_synced'
  | 'credential_verified'
  | 'browser_renewed'
  | 'manual_takeover_required';
export type StoreCredentialEventStatus = 'info' | 'success' | 'warning' | 'error';

export interface StoreCredentialEventRecord {
  id: number;
  storeId: number | null;
  sessionId: string | null;
  credentialId: number | null;
  eventType: StoreCredentialEventType;
  eventTypeText: string;
  status: StoreCredentialEventStatus;
  statusText: string;
  detail: string;
  source: string | null;
  riskLevel: StoreCredentialRiskLevel | null;
  verificationUrl: string | null;
  createdAt: string;
  operatorName: string | null;
}

export interface StoreCredentialEventsResponse {
  storeId: number;
  shopName: string;
  events: StoreCredentialEventRecord[];
}

export interface StoreSessionCredentialEventsResponse {
  sessionId: string;
  storeId: number | null;
  storeName: string | null;
  events: StoreCredentialEventRecord[];
}

export interface StoreAuthSessionLiveStreamTokenResponse {
  streamToken: string;
  expiresAt: string;
}

export interface StoreAuthSessionLiveSnapshotResponse {
  sessionId: string;
  sessionDetail: StoreAuthSessionDetailResponse;
  qrSession: StoreQrLoginSessionResponse | null;
  credentialEvents: StoreCredentialEventRecord[];
}

export interface StoreManagementOverviewResponse {
  profile: {
    displayName: string;
    mobile: string;
    updatedAt: string;
  };
  actions: Array<{
    key: string;
    label: string;
    description: string;
  }>;
  stores: StoreManagementStore[];
  xianyuStores: StoreManagementStore[];
  taobaoStores: StoreManagementStore[];
  authSessions: StoreAuthSessionRecord[];
  healthChecks: StoreHealthCheckRecord[];
  groups: Array<{
    name: string;
    count: number;
  }>;
  summaries: {
    totalStoreCount: number;
    xianyuStoreCount: number;
    taobaoStoreCount: number;
    enabledStoreCount: number;
    disabledStoreCount: number;
    pendingActivationCount: number;
    activeStoreCount: number;
    offlineStoreCount: number;
    abnormalStoreCount: number;
    pendingSessionCount: number;
    expiredSessionCount: number;
    invalidatedSessionCount: number;
  };
  serviceCards: Array<{
    key: string;
    title: string;
    actionLabel: string;
    description: string;
  }>;
}

export interface StoreAuthSessionResponse {
  sessionId: string;
  platform: StorePlatform;
  source: string;
  authType: number;
  createdAt: string;
  expiresAt: string;
  reauthorize: boolean;
  storeId: number | null;
  storeName: string | null;
  integrationMode: StoreAuthIntegrationMode;
  providerKey: string | null;
  providerLabel: string | null;
  providerConfigured: boolean;
  authorizeUrl: string | null;
  callbackPath: string | null;
  callbackUrl: string | null;
  requiresBrowserCallback: boolean;
  instructions: string[];
  permissions: string[];
}

export interface StoreAuthSessionDetailResponse {
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
  reauthorize: boolean;
  integrationMode: StoreAuthIntegrationMode;
  providerKey: string | null;
  providerLabel: string | null;
  providerState: string | null;
  providerConfigured: boolean;
  authorizeUrl: string | null;
  callbackPath: string | null;
  callbackUrl: string | null;
  requiresBrowserCallback: boolean;
  instructions: string[];
  providerAccessTokenMasked: string | null;
  providerAccessTokenReceivedAt: string | null;
  callbackReceivedAt: string | null;
  profileSyncStatus: StoreProfileSyncStatus;
  profileSyncStatusText: string;
  profileSyncError: string | null;
  profileSyncedAt: string | null;
  providerUserId: string | null;
  providerShopId: string | null;
  providerShopName: string | null;
  scopeText: string | null;
  mobile: string | null;
  nickname: string | null;
  tokenReceived: boolean;
  nextStepKey: StoreAuthSessionNextStep;
  nextStepText: string;
}

export interface StoreAuthCompleteResponse {
  storeId: number;
  platform: StorePlatform;
  activationStatus: StoreConnectionStatus;
  statusText: string;
  shopName: string;
  sellerNo: string;
  source: string;
  loginMode: 'sms' | 'password';
  reauthorized: boolean;
}

export interface StoreAuthProviderCallbackResponse {
  accepted: boolean;
  statusCode: number;
  sessionId: string;
  integrationMode: StoreAuthIntegrationMode;
  providerKey: string;
  accessTokenMasked: string;
  accessTokenReceivedAt: string;
  nextStep: StoreAuthSessionNextStep;
  nextStepText: string;
  message: string;
}

export interface StoreAuthProfileSyncResponse {
  storeId: number;
  platform: StorePlatform;
  activationStatus: StoreConnectionStatus;
  statusText: string;
  shopName: string;
  sellerNo: string;
  source: string;
  reauthorized: boolean;
  providerUserId: string;
  providerShopId: string;
  providerShopName: string;
  profileSyncedAt: string;
}

export interface StoreWebSessionProfileDetectResponse {
  detected: boolean;
  currentUrl: string | null;
  pageTitle: string | null;
  verificationUrl: string | null;
  detail: string;
  providerUserId: string | null;
  providerShopId: string | null;
  providerShopName: string | null;
  nickname: string | null;
  mobile: string | null;
  credentialUpdated: boolean;
  riskLevel: StoreCredentialRiskLevel | null;
  rawRet: string[];
}

export interface StoreQrLoginSessionResponse {
  qrLoginId: string;
  authSessionId: string;
  status: 'waiting' | 'scanned' | 'success' | 'expired' | 'cancelled' | 'verification_required' | 'failed';
  qrCodeUrl: string;
  createdAt: string;
  expiresAt: string;
  lastPolledAt: string | null;
  verificationUrl: string | null;
  hasCookies: boolean;
  cookieMasked: string | null;
  failureReason: string | null;
}

export interface StoreCredentialVerifyResponse {
  storeId: number;
  shopName: string;
  riskLevel: Exclude<StoreCredentialRiskLevel, 'pending'>;
  connectionStatus: StoreConnectionStatus;
  authStatus: StoreAuthStatus;
  healthStatus: StoreHealthStatus;
  checkedAt: string;
  detail: string;
  verificationUrl: string | null;
  refreshed: boolean;
  rawRet: string[];
}

export interface StoreBrowserRenewResponse extends StoreCredentialVerifyResponse {
  renewed: boolean;
  renewDetail: string;
  currentUrl: string | null;
  pageTitle: string | null;
}

export interface WorkspaceOverviewResponse {
  featureKey: string;
  featureLabel: string;
  groupKey: string;
  groupLabel: string;
  statusTag: string;
  updatedAt: string;
  summary: Array<{
    label: string;
    value: number;
    unit: string;
    meta: string;
  }>;
  actions: Array<{
    id: number;
    title: string;
    description: string;
    status: string;
    runCount: number;
    lastRunAt: string | null;
  }>;
  rules: Array<{
    id: number;
    name: string;
    description: string;
    enabled: boolean;
    scope: string;
    updatedAt: string;
  }>;
  tasks: Array<{
    id: number;
    title: string;
    description: string;
    owner: string;
    priority: string;
    status: 'todo' | 'in_progress' | 'done';
    dueAt: string;
  }>;
  logs: Array<{
    id: number;
    type: string;
    title: string;
    detail: string;
    createdAt: string;
  }>;
  insights: Array<{
    title: string;
    content: string;
  }>;
}

export interface WorkspaceBusinessMetric {
  label: string;
  value: number | string;
  unit: string;
  helper: string;
}

export interface WorkspaceBusinessNoneResponse {
  kind: 'none';
}

export interface DistributionSourceDetailResponse {
  kind: 'distribution-source';
  title: string;
  description: string;
  metrics: WorkspaceBusinessMetric[];
  suppliers: Array<{
    id: number;
    supplierKey: string;
    supplierName: string;
    adapterKey: string;
    accountName: string;
    endpointUrl: string;
    callbackTokenMasked: string;
    enabled: boolean;
    supplierStatus: 'online' | 'warning' | 'offline';
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
  items: Array<{
    id: number;
    supplierId: number;
    supplierName: string;
    productId: number;
    productTitle: string;
    category: string;
    storeName: string;
    targetType: string;
    zoneRequired: boolean;
    faceValue: number;
    enabled: boolean;
    status: string;
    updatedAt: string;
  }>;
  sourceSystems: Array<{
    id: number;
    systemKey: string;
    systemName: string;
    adapterKey: string;
    endpointUrl: string;
    callbackTokenMasked: string;
    enabled: boolean;
    systemStatus: 'online' | 'warning' | 'offline';
    syncMode: 'scheduled' | 'manual';
    syncIntervalMinutes: number;
    orderPushEnabled: boolean;
    refundCallbackEnabled: boolean;
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
  sourceProducts: Array<{
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
    syncStatus: 'synced' | 'warning' | 'anomaly';
    enabled: boolean;
    lastSyncAt: string;
    updatedAt: string;
  }>;
  sourceSyncRuns: Array<{
    id: number;
    systemId: number;
    systemName: string;
    syncType: 'product' | 'inventory' | 'price';
    runMode: 'scheduled' | 'manual';
    runStatus: 'success' | 'failed' | 'partial';
    totalCount: number;
    successCount: number;
    failureCount: number;
    detail: string;
    createdAt: string;
    finishedAt: string;
  }>;
}

export interface DistributionSupplyDetailResponse {
  kind: 'distribution-supply';
  title: string;
  description: string;
  metrics: WorkspaceBusinessMetric[];
  statuses: Array<{ label: string; count: number }>;
  jobs: Array<{
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
    taskStatus: 'pending_dispatch' | 'processing' | 'success' | 'failed' | 'manual_review';
    supplierStatus: string | null;
    callbackStatus: 'pending' | 'verified' | 'rejected' | 'timeout';
    verificationStatus: 'pending' | 'passed' | 'failed';
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
  callbacks: Array<{
    id: number;
    callbackNo: string;
    supplierName: string;
    orderNo: string | null;
    taskNo: string;
    supplierOrderNo: string | null;
    supplierStatus: string;
    verificationStatus: 'pending' | 'passed' | 'failed';
    mappedStatus: string | null;
    detail: string;
    receivedAt: string;
  }>;
  reconciliations: Array<{
    id: number;
    orderNo: string;
    supplierName: string;
    reconcileStatus: 'pending' | 'matched' | 'anomaly';
    supplierStatus: string | null;
    mappedStatus: string | null;
    detail: string;
    updatedAt: string;
  }>;
  sourceOrders: Array<{
    id: number;
    systemId: number;
    systemName: string;
    orderId: number;
    orderNo: string;
    productName: string | null;
    taskNo: string;
    sourceOrderNo: string | null;
    orderStatus: 'pending_push' | 'processing' | 'success' | 'failed' | 'manual_review';
    sourceStatus: string | null;
    verificationStatus: 'pending' | 'passed' | 'failed';
    retryCount: number;
    maxRetry: number;
    failureReason: string | null;
    resultDetail: string | null;
    pushedAt: string | null;
    callbackAt: string | null;
    updatedAt: string;
  }>;
  sourceCallbacks: Array<{
    id: number;
    systemName: string;
    orderNo: string | null;
    callbackNo: string;
    taskNo: string;
    sourceOrderNo: string;
    sourceStatus: string;
    verificationStatus: 'pending' | 'passed' | 'failed';
    mappedStatus: string | null;
    detail: string;
    receivedAt: string;
  }>;
  sourceRefundNotices: Array<{
    id: number;
    systemName: string;
    orderNo: string;
    caseNo: string | null;
    noticeNo: string;
    sourceOrderNo: string;
    refundStatus: 'processing' | 'resolved' | 'failed';
    detail: string;
    notifiedAt: string;
    updatedAt: string;
  }>;
  sourceReconciliations: Array<{
    id: number;
    systemName: string;
    reconcileType: string;
    reconcileNo: string;
    platformRef: string;
    sourceRef: string;
    diffAmount: number;
    reconcileStatus: 'pending' | 'matched' | 'anomaly';
    detail: string;
    updatedAt: string;
  }>;
}

export interface CardTypesDetailResponse {
  kind: 'card-types';
  title: string;
  description: string;
  metrics: WorkspaceBusinessMetric[];
  rows: Array<{
    id: number;
    typeName: string;
    availableCount: number;
    lockedCount: number;
    soldCount: number;
    disabledCount: number;
    deliveryChannel: string;
    inventoryCost: number;
    averagePrice: number;
    templateCount: number;
    cardPrefix: string;
    passwordPrefix: string;
    separatorText: string;
    lastImportedAt: string;
    lastOutboundAt: string | null;
    updatedAt: string;
  }>;
}

export interface CardDeliveryDetailResponse {
  kind: 'card-delivery';
  title: string;
  description: string;
  metrics: WorkspaceBusinessMetric[];
  filters: Array<{ label: string; count: number }>;
  statuses: Array<{ label: string; count: number }>;
  rows: Array<{
    id: number;
    cardTypeId: number;
    productId: number | null;
    productTitle: string;
    salePrice: number;
    category: string;
    storeName: string;
    contentMode: string;
    deliveryPolicy: string;
    cardTypeName: string;
    enabled: boolean;
    status: string;
    availableCount: number;
    lockedCount: number;
    soldCount: number;
    disabledCount: number;
    templateName: string | null;
    lastOutboundAt: string | null;
    lowStock: boolean;
    updatedAt: string;
  }>;
  jobs: Array<{
    id: number;
    orderId: number;
    orderNo: string;
    productTitle: string;
    cardTypeName: string;
    jobType: string;
    jobStatus: 'pending' | 'success' | 'failed' | 'recycled';
    attemptCount: number;
    errorMessage: string | null;
    latestOutboundNo: string | null;
    updatedAt: string;
  }>;
  alerts: Array<{
    id: number;
    cardTypeName: string;
    currentStock: number;
    thresholdValue: number;
    status: string;
    detail: string;
    updatedAt: string;
  }>;
}

export interface CardCombosDetailResponse {
  kind: 'card-combos';
  title: string;
  description: string;
  metrics: WorkspaceBusinessMetric[];
  rows: Array<{
    id: number;
    comboName: string;
    comboContent: string;
    comboType: string;
    status: string;
    createdAt: string;
    updatedAt: string;
  }>;
}

export interface CardTemplatesDetailResponse {
  kind: 'card-templates';
  title: string;
  description: string;
  metrics: WorkspaceBusinessMetric[];
  rows: Array<{
    id: number;
    templateName: string;
    templateContent: string;
    templateStatus: string;
    randomEnabled: boolean;
    createdAt: string;
    updatedAt: string;
  }>;
}

export interface CardRecordsDetailResponse {
  kind: 'card-records';
  title: string;
  description: string;
  metrics: WorkspaceBusinessMetric[];
  tabs: Array<{ key: string; label: string; count: number }>;
  outboundRows: Array<{
    id: number;
    orderId: number;
    orderNo: string;
    outboundNo: string;
    outboundStatus: 'sent' | 'resent' | 'recycled' | 'revoked';
    cardTypeName: string;
    cardMasked: string;
    templateName: string | null;
    parentOutboundNo: string | null;
    attemptNo: number;
    createdAt: string;
  }>;
  recycleRows: Array<{
    id: number;
    recycleAction: 'recycle' | 'revoke';
    orderNo: string;
    outboundNo: string;
    cardTypeName: string;
    cardMasked: string;
    reason: string;
    createdAt: string;
  }>;
  batchRows: Array<{
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
}

export interface CardTrashDetailResponse {
  kind: 'card-trash';
  title: string;
  description: string;
  metrics: WorkspaceBusinessMetric[];
  rows: Array<{
    id: number;
    typeName: string;
    unsoldCount: number;
    soldCount: number;
    totalStock: number;
    deletedAt: string;
    deletedBy: string;
  }>;
}

export interface FundAccountsDetailResponse {
  kind: 'fund-accounts';
  title: string;
  description: string;
  metrics: WorkspaceBusinessMetric[];
  account?: {
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
  };
  settlements: Array<{
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
    settlementStatusText: string;
    settledAt: string;
  }>;
  refunds: Array<{
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
    refundStatusText: string;
    updatedAt: string;
  }>;
  reconciliations: Array<{
    id: number;
    reconcileNo: string;
    billCategory: string;
    billCategoryText: string;
    storeId: number | null;
    storeName: string | null;
    platformAmount: number;
    ledgerAmount: number;
    diffAmount: number;
    reconcileStatus: string;
    reconcileStatusText: string;
    note: string;
    updatedAt: string;
  }>;
  notes: string[];
}

export interface FundBillsDetailResponse {
  kind: 'fund-bills';
  title: string;
  description: string;
  metrics: WorkspaceBusinessMetric[];
  rows: Array<{
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
  }>;
}

export interface FundWithdrawalsDetailResponse {
  kind: 'fund-withdrawals';
  title: string;
  description: string;
  metrics: WorkspaceBusinessMetric[];
  rows: Array<{
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
}

export interface FundDepositDetailResponse {
  kind: 'fund-deposit';
  title: string;
  description: string;
  metrics: WorkspaceBusinessMetric[];
  overview: Array<{
    label: string;
    value: string;
    helper: string;
  }>;
  rows: Array<{
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
}

export interface FundOrdersDetailResponse {
  kind: 'fund-orders';
  title: string;
  description: string;
  metrics: WorkspaceBusinessMetric[];
  rows: Array<{
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
}

export interface FundAgentsDetailResponse {
  kind: 'fund-agents';
  title: string;
  description: string;
  metrics: WorkspaceBusinessMetric[];
  tiers: Array<{
    name: string;
    unlocked: boolean;
    description: string;
  }>;
  rows: Array<{
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
}

export interface AiServiceDetailResponse {
  kind: 'ai-service';
  title: string;
  description: string;
  metrics: WorkspaceBusinessMetric[];
  settings: {
    aiEnabled: boolean;
    autoReplyEnabled: boolean;
    faqEnabled: boolean;
    orderQueryEnabled: boolean;
    afterSaleSuggestionEnabled: boolean;
    highRiskManualOnly: boolean;
    boundaryNote: string;
    sensitiveWordsText: string;
    modelKeyMasked: string;
    updatedAt: string;
  } | null;
  conversations: Array<{
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
    conversationStatusText: string;
    aiStatus: string;
    aiStatusText: string;
    riskLevel: string;
    riskLevelText: string;
    priority: string;
    unreadCount: number;
    boundaryLabel: string;
    tags: string[];
    lastMessageAt: string;
    assignedUserName: string | null;
  }>;
  recentMessages: Array<{
    id: number;
    conversationId: number;
    sessionNo: string;
    customerName: string;
    senderName: string;
    senderType: string;
    senderTypeText: string;
    scene: string;
    content: string;
    status: string;
    createdAt: string;
  }>;
  takeovers: Array<{
    id: number;
    conversationId: number;
    sessionNo: string;
    customerName: string;
    actionType: string;
    operatorName: string;
    note: string;
    createdAt: string;
  }>;
  knowledgeItems: Array<{
    id: number;
    category: string;
    title: string;
    keywordsText: string;
    questionText: string;
    answerText: string;
    enabled: boolean;
    riskLevel: string;
    riskLevelText: string;
    updatedAt: string;
  }>;
  replyTemplates: Array<{
    id: number;
    scene: string;
    title: string;
    triggerText: string;
    templateContent: string;
    enabled: boolean;
    updatedAt: string;
  }>;
  syncNotices: Array<{
    storeId: number;
    storeName: string;
    riskLevel: string;
    detail: string;
    verificationUrl: string | null;
    updatedAt: string;
  }>;
  notes: string[];
}

export interface AiBargainDetailResponse {
  kind: 'ai-bargain';
  title: string;
  description: string;
  metrics: WorkspaceBusinessMetric[];
  settings: {
    aiEnabled: boolean;
    autoBargainEnabled: boolean;
    highRiskManualOnly: boolean;
    allowAutoAccept: boolean;
    boundaryNote: string;
    sensitiveWordsText: string;
    blacklistNotice: string;
    modelKeyMasked: string;
    updatedAt: string;
  } | null;
  strategies: Array<{
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
    enabled: boolean;
    riskTagsText: string;
    updatedAt: string;
  }>;
  sessions: Array<{
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
    sessionStatusText: string;
    aiStatus: string;
    aiStatusText: string;
    riskLevel: string;
    riskLevelText: string;
    riskReason: string;
    boundaryLabel: string;
    tags: string[];
    assignedUserName: string | null;
    lastMessageAt: string;
  }>;
  logs: Array<{
    id: number;
    sessionId: number;
    sessionNo: string;
    customerName: string;
    actorType: string;
    actorTypeText: string;
    actionType: string;
    actionTypeText: string;
    offerPrice: number | null;
    messageText: string;
    createdAt: string;
  }>;
  templates: Array<{
    id: number;
    scene: string;
    title: string;
    triggerText: string;
    templateContent: string;
    enabled: boolean;
    updatedAt: string;
  }>;
  blacklists: Array<{
    id: number;
    customerId: number | null;
    customerName: string;
    reason: string;
    enabled: boolean;
    updatedAt: string;
  }>;
  notes: string[];
}

export interface SystemAccountsDetailResponse {
  kind: 'system-accounts';
  title: string;
  description: string;
  metrics: WorkspaceBusinessMetric[];
  rows: AuthUser[];
}

export interface OpenLogsDetailResponse {
  kind: 'open-logs';
  title: string;
  description: string;
  metrics: WorkspaceBusinessMetric[];
  rows: Array<{
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

export interface SystemConfigsDetailResponse {
  kind: 'system-configs';
  title: string;
  description: string;
  metrics: WorkspaceBusinessMetric[];
  rows: Array<{
    key: string;
    description: string;
    maskedValue: string;
    updatedAt: string;
    updatedByName: string | null;
  }>;
}

export interface SystemMonitoringDetailResponse {
  kind: 'system-monitoring';
  title: string;
  description: string;
  metrics: WorkspaceBusinessMetric[];
  health: {
    apiStatus: 'healthy' | 'warning';
    databasePath: string;
    databaseSizeBytes: number;
    backupRootDir: string;
    logArchiveRootDir: string;
    recoveryRootDir: string;
    latestBackupAt: string | null;
    latestRecoveryAt: string | null;
  };
  alerts: Array<{
    id: number;
    alertType: 'api_failure' | 'delivery_failure' | 'inventory_abnormal' | 'store_offline';
    alertTypeText: string;
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
  jobMonitors: Array<{
    groupKey: string;
    groupLabel: string;
    pendingCount: number;
    failedCount: number;
    manualCount: number;
    latestUpdatedAt: string | null;
    note: string;
  }>;
  backups: Array<{
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
  logArchives: Array<{
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
  recoveryDrills: Array<{
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
  notes: string[];
}

export type WorkspaceBusinessDetailResponse =
  | WorkspaceBusinessNoneResponse
  | AiServiceDetailResponse
  | AiBargainDetailResponse
  | DistributionSourceDetailResponse
  | DistributionSupplyDetailResponse
  | CardTypesDetailResponse
  | CardDeliveryDetailResponse
  | CardCombosDetailResponse
  | CardTemplatesDetailResponse
  | CardRecordsDetailResponse
  | CardTrashDetailResponse
  | FundAccountsDetailResponse
  | FundBillsDetailResponse
  | FundWithdrawalsDetailResponse
  | FundDepositDetailResponse
  | FundOrdersDetailResponse
  | FundAgentsDetailResponse
  | SystemMonitoringDetailResponse
  | SystemAccountsDetailResponse
  | OpenLogsDetailResponse
  | SystemConfigsDetailResponse;

export interface FilterQuery {
  preset?: string;
  startDate?: string;
  endDate?: string;
  storeId?: number;
  storeIds?: number[];
  productId?: number;
  category?: string;
  source?: string;
  keyword?: string;
  mainStatus?: string;
  deliveryStatus?: string;
  orderStatus?: string;
  afterSaleStatus?: string;
  fulfillmentQueue?: 'pending' | 'processing' | 'success' | 'failed' | 'manual_review';
  caseType?: 'refund' | 'resend' | 'dispute';
  caseStatus?: 'pending_review' | 'processing' | 'waiting_execute' | 'resolved' | 'rejected';
  sortBy?: 'paidAt' | 'paidAmount' | 'completedAt' | 'updatedAt';
  sortOrder?: 'asc' | 'desc';
  page?: number;
  pageSize?: number;
}
