// 商品与客户相关类型定义

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
