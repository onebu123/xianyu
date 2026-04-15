// 仪表盘与报表相关类型定义

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
