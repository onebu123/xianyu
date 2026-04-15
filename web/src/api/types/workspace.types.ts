// 工作台相关类型定义

import type { AuthUser } from './auth.types';

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
