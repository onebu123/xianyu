import { format } from 'date-fns';

export type DirectChargeSupplierMappedStatus = 'processing' | 'success' | 'failed';

export interface DirectChargeDispatchPayload {
  taskNo: string;
  orderNo: string;
  productTitle: string;
  targetAccount: string;
  targetZone: string | null;
  amount: number;
  retryCount: number;
}

export interface DirectChargeDispatchResult {
  supplierOrderNo: string;
  supplierStatus: string;
  acceptedAt: string;
  detail: string;
}

export interface DirectChargeCallbackPayload {
  taskNo: string;
  supplierOrderNo: string;
  supplierStatus: string;
  resultCode?: string;
  detail?: string;
  token: string;
}

export interface DirectChargeNormalizedResult {
  mappedStatus: DirectChargeSupplierMappedStatus;
  detail: string;
}

export interface DirectChargeAdapter {
  key: string;
  label: string;
  dispatch(payload: DirectChargeDispatchPayload): DirectChargeDispatchResult;
  normalizeCallback(payload: DirectChargeCallbackPayload): DirectChargeNormalizedResult;
  verifyCallbackToken(payload: DirectChargeCallbackPayload, expectedToken: string): boolean;
}

function buildSimulatedSupplierOrderNo(taskNo: string) {
  return `SIM-${format(new Date(), 'yyyyMMddHHmmss')}-${taskNo.slice(-4)}`;
}

const simulatedSupplierAdapter: DirectChargeAdapter = {
  key: 'sim-topup',
  label: '标准模拟直充供应商',
  dispatch(payload) {
    return {
      supplierOrderNo: buildSimulatedSupplierOrderNo(payload.taskNo),
      supplierStatus: 'PROCESSING',
      acceptedAt: format(new Date(), 'yyyy-MM-dd HH:mm:ss'),
      detail: `${payload.productTitle} 已提交至模拟供应商，目标账号 ${payload.targetAccount}。`,
    };
  },
  normalizeCallback(payload) {
    const normalizedStatus = payload.supplierStatus.trim().toUpperCase();

    if (['SUCCESS', 'DONE', 'DELIVERED'].includes(normalizedStatus)) {
      return {
        mappedStatus: 'success',
        detail: payload.detail?.trim() || '供应商返回充值成功。',
      };
    }

    if (['PROCESSING', 'PENDING', 'ACCEPTED'].includes(normalizedStatus)) {
      return {
        mappedStatus: 'processing',
        detail: payload.detail?.trim() || '供应商返回处理中。',
      };
    }

    return {
      mappedStatus: 'failed',
      detail: payload.detail?.trim() || payload.resultCode?.trim() || '供应商返回失败。',
    };
  },
  verifyCallbackToken(payload, expectedToken) {
    return payload.token === expectedToken;
  },
};

const adapters: Record<string, DirectChargeAdapter> = {
  [simulatedSupplierAdapter.key]: simulatedSupplierAdapter,
};

export function getDirectChargeAdapter(adapterKey: string) {
  return adapters[adapterKey];
}
