// 售后相关类型定义

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
