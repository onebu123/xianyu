export function formatCurrency(value: number) {
  return `¥${Number(value ?? 0).toLocaleString('zh-CN', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  })}`;
}

export function formatNumber(value: number, suffix = '') {
  return `${Number(value ?? 0).toLocaleString('zh-CN')}${suffix}`;
}

export function orderStatusLabel(status: string) {
  return (
    {
      pending_shipment: '待发货',
      shipped: '已发货',
      completed: '已完成',
    }[status] ?? status
  );
}

export function orderMainStatusLabel(status: string) {
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

export function deliveryStatusLabel(status: string) {
  return (
    {
      pending: '待发货',
      shipped: '已发货',
      delivered: '已交付',
      manual_review: '人工处理',
    }[status] ?? status
  );
}

export function paymentStatusLabel(status: string) {
  return (
    {
      paid: '已支付',
      refunded_partial: '部分退款',
      refunded_full: '全额退款',
    }[status] ?? status
  );
}

export function afterSaleStatusLabel(status: string) {
  return (
    {
      none: '无售后',
      processing: '售后处理中',
      resolved: '售后完结',
    }[status] ?? status
  );
}
