import { format } from 'date-fns';

export type SupplySourceSyncType = 'product' | 'inventory' | 'price';
export type SupplySourceMappedStatus = 'processing' | 'success' | 'failed';
export type SupplySourceRefundMappedStatus = 'processing' | 'resolved' | 'failed';

export interface SupplySourceSyncItemPayload {
  externalProductId: string;
  externalSku: string;
  externalProductName: string;
  category: string;
  mappedProductName: string;
  salePrice: number;
  platformStock: number;
}

export interface SupplySourceSyncItemResult {
  externalProductId: string;
  externalSku: string;
  externalProductName: string;
  category: string;
  salePrice: number;
  sourcePrice: number;
  sourceStock: number;
  syncStatus: 'synced' | 'warning' | 'anomaly';
  detail: string;
}

export interface SupplySourceSyncResult {
  syncedAt: string;
  detail: string;
  items: SupplySourceSyncItemResult[];
}

export interface SupplySourceOrderDispatchPayload {
  taskNo: string;
  orderNo: string;
  productTitle: string;
  quantity: number;
  paidAmount: number;
  targetStoreName: string;
}

export interface SupplySourceOrderDispatchResult {
  sourceOrderNo: string;
  sourceStatus: string;
  acceptedAt: string;
  detail: string;
}

export interface SupplySourceCallbackPayload {
  taskNo: string;
  sourceOrderNo: string;
  sourceStatus: string;
  detail?: string;
  token: string;
}

export interface SupplySourceRefundPayload {
  noticeNo: string;
  sourceOrderNo: string;
  refundStatus: string;
  detail?: string;
  token: string;
}

export interface SupplySourceNormalizedResult {
  mappedStatus: SupplySourceMappedStatus;
  detail: string;
}

export interface SupplySourceNormalizedRefundResult {
  mappedStatus: SupplySourceRefundMappedStatus;
  detail: string;
}

export interface SupplySourceAdapter {
  key: string;
  label: string;
  syncProducts(
    syncType: SupplySourceSyncType,
    items: SupplySourceSyncItemPayload[],
  ): SupplySourceSyncResult;
  dispatchOrder(payload: SupplySourceOrderDispatchPayload): SupplySourceOrderDispatchResult;
  normalizeCallback(payload: SupplySourceCallbackPayload): SupplySourceNormalizedResult;
  normalizeRefundNotice(payload: SupplySourceRefundPayload): SupplySourceNormalizedRefundResult;
  verifyCallbackToken(token: string, expectedToken: string): boolean;
}

function buildSourceOrderNo(taskNo: string) {
  return `SRC-${format(new Date(), 'yyyyMMddHHmmss')}-${taskNo.slice(-4)}`;
}

const simulatedSupplyAdapter: SupplySourceAdapter = {
  key: 'sim-own-supply',
  label: '标准模拟自有货源系统',
  syncProducts(syncType, items) {
    const results = items.map((item, index) => {
      const priceFactor = syncType === 'price' ? 0.91 : syncType === 'product' ? 0.93 : 0.92;
      const stockOffset = syncType === 'inventory' ? index + 3 : index + 1;
      const sourcePrice = Number((item.salePrice * priceFactor).toFixed(2));
      const sourceStock = Math.max(0, item.platformStock + (syncType === 'inventory' ? -stockOffset : 4 - stockOffset));
      const priceDiff = Math.abs(item.salePrice - sourcePrice);
      const stockDiff = Math.abs(item.platformStock - sourceStock);
      const syncStatus =
        priceDiff > item.salePrice * 0.18 || stockDiff > 40
          ? 'warning'
          : 'synced';

      return {
        externalProductId: item.externalProductId,
        externalSku: item.externalSku,
        externalProductName: item.externalProductName,
        category: item.category,
        salePrice: item.salePrice,
        sourcePrice,
        sourceStock,
        syncStatus,
        detail:
          syncType === 'product'
            ? `${item.mappedProductName} 商品信息已和货源主站完成基线同步。`
            : syncType === 'inventory'
              ? `${item.mappedProductName} 库存已刷新为 ${sourceStock}。`
              : `${item.mappedProductName} 供货价已刷新为 ${sourcePrice.toFixed(2)}。`,
      } satisfies SupplySourceSyncItemResult;
    });

    return {
      syncedAt: format(new Date(), 'yyyy-MM-dd HH:mm:ss'),
      detail:
        syncType === 'product'
          ? '商品主数据同步完成。'
          : syncType === 'inventory'
            ? '库存同步完成。'
            : '价格同步完成。',
      items: results,
    };
  },
  dispatchOrder(payload) {
    return {
      sourceOrderNo: buildSourceOrderNo(payload.taskNo),
      sourceStatus: 'ACCEPTED',
      acceptedAt: format(new Date(), 'yyyy-MM-dd HH:mm:ss'),
      detail: `${payload.productTitle} 已下发至自有货源系统，数量 ${payload.quantity}，订单 ${payload.orderNo}。`,
    };
  },
  normalizeCallback(payload) {
    const normalized = payload.sourceStatus.trim().toUpperCase();

    if (['SUCCESS', 'DONE', 'DELIVERED', 'SHIPPED'].includes(normalized)) {
      return {
        mappedStatus: 'success',
        detail: payload.detail?.trim() || '货源系统已确认发货完成。',
      };
    }

    if (['PROCESSING', 'ACCEPTED', 'PENDING', 'PICKING'].includes(normalized)) {
      return {
        mappedStatus: 'processing',
        detail: payload.detail?.trim() || '货源系统仍在处理中。',
      };
    }

    return {
      mappedStatus: 'failed',
      detail: payload.detail?.trim() || '货源系统返回失败结果。',
    };
  },
  normalizeRefundNotice(payload) {
    const normalized = payload.refundStatus.trim().toUpperCase();

    if (['SUCCESS', 'DONE', 'REFUNDED'].includes(normalized)) {
      return {
        mappedStatus: 'resolved',
        detail: payload.detail?.trim() || '货源系统已完成退款通知。',
      };
    }

    if (['PROCESSING', 'PENDING', 'ACCEPTED'].includes(normalized)) {
      return {
        mappedStatus: 'processing',
        detail: payload.detail?.trim() || '货源系统已接收退款通知，等待处理完成。',
      };
    }

    return {
      mappedStatus: 'failed',
      detail: payload.detail?.trim() || '货源系统退款通知失败。',
    };
  },
  verifyCallbackToken(token, expectedToken) {
    return token === expectedToken;
  },
};

const adapters: Record<string, SupplySourceAdapter> = {
  [simulatedSupplyAdapter.key]: simulatedSupplyAdapter,
};

export function getSupplySourceAdapter(adapterKey: string) {
  return adapters[adapterKey];
}
