// 订单相关类型定义

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
