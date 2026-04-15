// 筛选查询相关类型定义

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
  caseType?: 'refund' | 'resend' | 'dispute';
  caseStatus?: 'pending_review' | 'processing' | 'waiting_execute' | 'resolved' | 'rejected';
  sortBy?: 'paidAt' | 'paidAmount' | 'completedAt' | 'updatedAt';
  sortOrder?: 'asc' | 'desc';
  page?: number;
  pageSize?: number;
}
