import Database from 'better-sqlite3';

import type { PaginationParams, QueryFilters } from './types.js';

type SqlParams = Record<string, string | number>;
type OrderMainStatus = 'paid' | 'processing' | 'fulfilled' | 'completed' | 'after_sale' | 'closed';
type OrderPaymentStatus = 'paid' | 'refunded_partial' | 'refunded_full';
type OrderDeliveryStatus = 'pending' | 'shipped' | 'delivered' | 'manual_review';
type OrderFulfillmentType = 'standard' | 'card' | 'direct_charge';
type OrderFulfillmentQueue = 'pending' | 'processing' | 'success' | 'failed' | 'manual_review';

interface DateRange {
  start: Date;
  end: Date;
  startIso: string;
  endIso: string;
  previousStartIso: string;
  previousEndIso: string;
  dayCount: number;
}

interface OrderListRow {
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
  mainStatus: OrderMainStatus;
  deliveryStatus: OrderDeliveryStatus;
  paymentStatus: OrderPaymentStatus;
  orderStatus: string;
  afterSaleStatus: string;
  source: string;
  paidAt: string;
  shippedAt: string | null;
  completedAt: string | null;
  updatedAt: string;
  latestEventAt: string | null;
}

interface OrderListItem extends OrderListRow {
  mainStatusText: string;
  deliveryStatusText: string;
  paymentStatusText: string;
  fulfillmentType: OrderFulfillmentType;
  fulfillmentTypeText: string;
  fulfillmentQueue: OrderFulfillmentQueue;
  fulfillmentQueueText: string;
  fulfillmentStage: string;
  fulfillmentStageDetail: string;
}

interface OrderDetailRow extends Omit<OrderListRow, 'latestEventAt'> {
  customerProvince: string;
  deliveryHours: number;
  isNewCustomer: number;
  buyerNote: string | null;
  sellerRemark: string | null;
  createdAt: string;
}

interface OrderItemRow {
  id: number;
  lineNo: number;
  productId: number;
  productName: string;
  productSku: string;
  category: string;
  quantity: number;
  unitPrice: number;
  paidAmount: number;
  deliveryStatus: OrderDeliveryStatus;
  afterSaleStatus: string;
  createdAt: string;
  updatedAt: string;
}

interface OrderPaymentRow {
  id: number;
  paymentNo: string;
  paymentChannel: string;
  paymentStatus: OrderPaymentStatus;
  grossAmount: number;
  discountAmount: number;
  paidAmount: number;
  paidAt: string;
  settledAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface OrderEventRow {
  id: number;
  eventType: string;
  eventTitle: string;
  eventDetail: string;
  operatorName: string | null;
  createdAt: string;
}

interface OrderFulfillmentMeta {
  fulfillmentType: OrderFulfillmentType;
  fulfillmentTypeText: string;
  fulfillmentQueue: OrderFulfillmentQueue;
  fulfillmentQueueText: string;
  fulfillmentStage: string;
  fulfillmentStageDetail: string;
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
}

interface OrderReadRepositoryHelpers {
  resolveDateRange: (filters: QueryFilters) => DateRange;
  buildOrderWhere: (
    filters: QueryFilters,
    range: DateRange,
  ) => { whereSql: string; params: SqlParams };
  resolveOrderSort: (sortBy?: string, sortOrder?: string) => string;
  loadOrderFulfillmentMeta: (orderIds: number[]) => Map<number, OrderFulfillmentMeta>;
  getOrderMainStatusText: (status: OrderMainStatus) => string;
  getOrderDeliveryStatusText: (status: OrderDeliveryStatus) => string;
  getOrderPaymentStatusText: (status: OrderPaymentStatus) => string;
  getOrderFulfillmentTypeText: (type: OrderFulfillmentType) => string;
  getOrderFulfillmentQueueText: (queue: OrderFulfillmentQueue) => string;
}

interface OrderDetailResult {
  order: Omit<OrderDetailRow, 'isNewCustomer'> & {
    isNewCustomer: boolean;
    mainStatusText: string;
    deliveryStatusText: string;
    paymentStatusText: string;
    fulfillmentType: OrderFulfillmentType;
    fulfillmentTypeText: string;
    fulfillmentQueue: OrderFulfillmentQueue;
    fulfillmentQueueText: string;
    fulfillmentStage: string;
    fulfillmentStageDetail: string;
  };
  items: Array<OrderItemRow & { deliveryStatusText: string }>;
  payments: Array<OrderPaymentRow & { paymentStatusText: string }>;
  events: OrderEventRow[];
  fulfillment: {
    type: OrderFulfillmentType;
    typeText: string;
    queue: OrderFulfillmentQueue;
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
  fulfillmentLogs: OrderEventRow[];
}

const DEFAULT_FULFILLMENT_STAGE = '待履约';
const DEFAULT_FULFILLMENT_STAGE_DETAIL = '等待进入统一履约处理链路。';

export class OrderReadRepository {
  constructor(
    private readonly getDbConnection: () => Database.Database,
    private readonly helpers: OrderReadRepositoryHelpers,
  ) {}

  private get db() {
    return this.getDbConnection();
  }

  getOrdersOverview(filters: QueryFilters) {
    const range = this.helpers.resolveDateRange(filters);
    const { whereSql, params } = this.helpers.buildOrderWhere(filters, range);
    const summary = this.db
      .prepare(
        `
          SELECT
            COUNT(*) AS totalOrders,
            SUM(CASE WHEN o.main_status = 'paid' THEN 1 ELSE 0 END) AS paidOrders,
            SUM(CASE WHEN o.main_status = 'processing' THEN 1 ELSE 0 END) AS processingOrders,
            SUM(CASE WHEN o.main_status = 'fulfilled' THEN 1 ELSE 0 END) AS fulfilledOrders,
            SUM(CASE WHEN o.main_status = 'completed' THEN 1 ELSE 0 END) AS mainCompletedOrders,
            SUM(CASE WHEN o.main_status = 'after_sale' THEN 1 ELSE 0 END) AS mainAfterSaleOrders,
            SUM(CASE WHEN o.order_status = 'pending_shipment' THEN 1 ELSE 0 END) AS pendingShipment,
            SUM(CASE WHEN o.order_status = 'shipped' THEN 1 ELSE 0 END) AS shippedOrders,
            SUM(CASE WHEN o.order_status = 'completed' THEN 1 ELSE 0 END) AS completedOrders,
            SUM(CASE WHEN o.after_sale_status != 'none' THEN 1 ELSE 0 END) AS afterSaleOrders,
            AVG(o.delivery_hours) AS averageDeliveryHours,
            SUM(o.paid_amount) AS salesAmount
          FROM orders o
          LEFT JOIN products p ON p.id = o.product_id
          LEFT JOIN customers c ON c.id = o.customer_id
          ${whereSql}
        `,
      )
      .get(params) as Record<string, number | null>;

    return {
      totalOrders: Number(summary.totalOrders ?? 0),
      paidOrders: Number(summary.paidOrders ?? 0),
      processingOrders: Number(summary.processingOrders ?? 0),
      fulfilledOrders: Number(summary.fulfilledOrders ?? 0),
      mainCompletedOrders: Number(summary.mainCompletedOrders ?? 0),
      mainAfterSaleOrders: Number(summary.mainAfterSaleOrders ?? 0),
      pendingShipment: Number(summary.pendingShipment ?? 0),
      shippedOrders: Number(summary.shippedOrders ?? 0),
      completedOrders: Number(summary.completedOrders ?? 0),
      afterSaleOrders: Number(summary.afterSaleOrders ?? 0),
      averageDeliveryHours: Number((summary.averageDeliveryHours ?? 0).toFixed(1)),
      salesAmount: Number((summary.salesAmount ?? 0).toFixed(2)),
    };
  }

  getOrdersList(filters: QueryFilters, pagination: PaginationParams) {
    const range = this.helpers.resolveDateRange(filters);
    const { whereSql, params } = this.helpers.buildOrderWhere(filters, range);
    const orderBy = this.helpers.resolveOrderSort(filters.sortBy, filters.sortOrder);
    const countRow = this.db
      .prepare(
        `
          SELECT COUNT(*) AS total
          FROM orders o
          LEFT JOIN products p ON p.id = o.product_id
          LEFT JOIN customers c ON c.id = o.customer_id
          ${whereSql}
        `,
      )
      .get(params) as { total: number };

    const page = Math.max(pagination.page, 1);
    const pageSize = Math.max(Math.min(pagination.pageSize, 100), 1);
    const rows = this.db
      .prepare(
        `
          SELECT
            o.id,
            o.order_no AS orderNo,
            o.store_id AS storeId,
            s.name AS storeName,
            o.product_id AS productId,
            p.name AS productName,
            p.sku AS productSku,
            p.category AS category,
            o.customer_id AS customerId,
            c.name AS customerName,
            o.quantity,
            o.paid_amount AS paidAmount,
            o.discount_amount AS discountAmount,
            o.refund_amount AS refundAmount,
            o.main_status AS mainStatus,
            o.delivery_status AS deliveryStatus,
            o.payment_status AS paymentStatus,
            o.order_status AS orderStatus,
            o.after_sale_status AS afterSaleStatus,
            o.source,
            o.paid_at AS paidAt,
            o.shipped_at AS shippedAt,
            o.completed_at AS completedAt,
            o.updated_at AS updatedAt,
            (
              SELECT MAX(created_at)
              FROM order_events oe
              WHERE oe.order_id = o.id
            ) AS latestEventAt
          FROM orders o
          LEFT JOIN products p ON p.id = o.product_id
          LEFT JOIN stores s ON s.id = o.store_id
          LEFT JOIN customers c ON c.id = o.customer_id
          ${whereSql}
          ORDER BY ${orderBy}
          LIMIT @limit OFFSET @offset
        `,
      )
      .all({
        ...params,
        limit: pageSize,
        offset: (page - 1) * pageSize,
      }) as OrderListRow[];

    const fulfillmentMetaMap = this.helpers.loadOrderFulfillmentMeta(rows.map((row) => row.id));

    return {
      total: countRow.total,
      page,
      pageSize,
      list: rows.map((row): OrderListItem => {
        const fulfillmentMeta = fulfillmentMetaMap.get(row.id);
        return {
          ...row,
          mainStatusText: this.helpers.getOrderMainStatusText(row.mainStatus),
          deliveryStatusText: this.helpers.getOrderDeliveryStatusText(row.deliveryStatus),
          paymentStatusText: this.helpers.getOrderPaymentStatusText(row.paymentStatus),
          fulfillmentType: fulfillmentMeta?.fulfillmentType ?? 'standard',
          fulfillmentTypeText:
            fulfillmentMeta?.fulfillmentTypeText ??
            this.helpers.getOrderFulfillmentTypeText('standard'),
          fulfillmentQueue: fulfillmentMeta?.fulfillmentQueue ?? 'pending',
          fulfillmentQueueText:
            fulfillmentMeta?.fulfillmentQueueText ??
            this.helpers.getOrderFulfillmentQueueText('pending'),
          fulfillmentStage: fulfillmentMeta?.fulfillmentStage ?? DEFAULT_FULFILLMENT_STAGE,
          fulfillmentStageDetail:
            fulfillmentMeta?.fulfillmentStageDetail ?? DEFAULT_FULFILLMENT_STAGE_DETAIL,
        };
      }),
    };
  }

  getOrderDetail(orderId: number): OrderDetailResult | null {
    const order = this.db
      .prepare(
        `
          SELECT
            o.id,
            o.order_no AS orderNo,
            o.store_id AS storeId,
            s.name AS storeName,
            o.product_id AS productId,
            p.name AS productName,
            p.sku AS productSku,
            p.category AS category,
            o.customer_id AS customerId,
            c.name AS customerName,
            c.province AS customerProvince,
            o.source,
            o.quantity,
            o.paid_amount AS paidAmount,
            o.discount_amount AS discountAmount,
            o.refund_amount AS refundAmount,
            o.main_status AS mainStatus,
            o.payment_status AS paymentStatus,
            o.delivery_status AS deliveryStatus,
            o.order_status AS orderStatus,
            o.after_sale_status AS afterSaleStatus,
            o.paid_at AS paidAt,
            o.shipped_at AS shippedAt,
            o.completed_at AS completedAt,
            o.delivery_hours AS deliveryHours,
            o.is_new_customer AS isNewCustomer,
            o.buyer_note AS buyerNote,
            o.seller_remark AS sellerRemark,
            o.created_at AS createdAt,
            o.updated_at AS updatedAt
          FROM orders o
          LEFT JOIN stores s ON s.id = o.store_id
          LEFT JOIN products p ON p.id = o.product_id
          LEFT JOIN customers c ON c.id = o.customer_id
          WHERE o.id = ?
        `,
      )
      .get(orderId) as OrderDetailRow | undefined;

    if (!order) {
      return null;
    }

    const items = this.db
      .prepare(
        `
          SELECT
            id,
            line_no AS lineNo,
            product_id AS productId,
            product_name_snapshot AS productName,
            sku_snapshot AS productSku,
            category_snapshot AS category,
            quantity,
            unit_price AS unitPrice,
            paid_amount AS paidAmount,
            delivery_status AS deliveryStatus,
            after_sale_status AS afterSaleStatus,
            created_at AS createdAt,
            updated_at AS updatedAt
          FROM order_items
          WHERE order_id = ?
          ORDER BY line_no ASC, id ASC
        `,
      )
      .all(orderId) as OrderItemRow[];

    const payments = this.db
      .prepare(
        `
          SELECT
            id,
            payment_no AS paymentNo,
            payment_channel AS paymentChannel,
            payment_status AS paymentStatus,
            gross_amount AS grossAmount,
            discount_amount AS discountAmount,
            paid_amount AS paidAmount,
            paid_at AS paidAt,
            settled_at AS settledAt,
            created_at AS createdAt,
            updated_at AS updatedAt
          FROM order_payments
          WHERE order_id = ?
          ORDER BY paid_at ASC, id ASC
        `,
      )
      .all(orderId) as OrderPaymentRow[];

    const events = this.db
      .prepare(
        `
          SELECT
            id,
            event_type AS eventType,
            event_title AS eventTitle,
            event_detail AS eventDetail,
            operator_name AS operatorName,
            created_at AS createdAt
          FROM order_events
          WHERE order_id = ?
          ORDER BY created_at ASC, id ASC
        `,
      )
      .all(orderId) as OrderEventRow[];

    const fulfillmentMeta = this.helpers.loadOrderFulfillmentMeta([orderId]).get(orderId);
    const fulfillmentLogs = events.filter((event) =>
      /^card_|^direct_charge_|^fulfillment_/.test(event.eventType),
    );

    return {
      order: {
        ...order,
        isNewCustomer: Boolean(order.isNewCustomer),
        mainStatusText: this.helpers.getOrderMainStatusText(order.mainStatus),
        deliveryStatusText: this.helpers.getOrderDeliveryStatusText(order.deliveryStatus),
        paymentStatusText: this.helpers.getOrderPaymentStatusText(order.paymentStatus),
        fulfillmentType: fulfillmentMeta?.fulfillmentType ?? 'standard',
        fulfillmentTypeText:
          fulfillmentMeta?.fulfillmentTypeText ??
          this.helpers.getOrderFulfillmentTypeText('standard'),
        fulfillmentQueue: fulfillmentMeta?.fulfillmentQueue ?? 'pending',
        fulfillmentQueueText:
          fulfillmentMeta?.fulfillmentQueueText ??
          this.helpers.getOrderFulfillmentQueueText('pending'),
        fulfillmentStage: fulfillmentMeta?.fulfillmentStage ?? DEFAULT_FULFILLMENT_STAGE,
        fulfillmentStageDetail:
          fulfillmentMeta?.fulfillmentStageDetail ?? DEFAULT_FULFILLMENT_STAGE_DETAIL,
      },
      items: items.map((item) => ({
        ...item,
        deliveryStatusText: this.helpers.getOrderDeliveryStatusText(item.deliveryStatus),
      })),
      payments: payments.map((payment) => ({
        ...payment,
        paymentStatusText: this.helpers.getOrderPaymentStatusText(payment.paymentStatus),
      })),
      events,
      fulfillment: {
        type: fulfillmentMeta?.fulfillmentType ?? 'standard',
        typeText:
          fulfillmentMeta?.fulfillmentTypeText ??
          this.helpers.getOrderFulfillmentTypeText('standard'),
        queue: fulfillmentMeta?.fulfillmentQueue ?? 'pending',
        queueText:
          fulfillmentMeta?.fulfillmentQueueText ??
          this.helpers.getOrderFulfillmentQueueText('pending'),
        stage: fulfillmentMeta?.fulfillmentStage ?? DEFAULT_FULFILLMENT_STAGE,
        stageDetail: fulfillmentMeta?.fulfillmentStageDetail ?? DEFAULT_FULFILLMENT_STAGE_DETAIL,
        latestTaskNo: fulfillmentMeta?.latestTaskNo ?? null,
        latestSupplierOrderNo: fulfillmentMeta?.latestSupplierOrderNo ?? null,
        latestOutboundNo: fulfillmentMeta?.latestOutboundNo ?? null,
        retryCount: fulfillmentMeta?.retryCount ?? 0,
        maxRetry: fulfillmentMeta?.maxRetry ?? 0,
        manualReason: fulfillmentMeta?.manualReason ?? null,
        latestLogTitle: fulfillmentMeta?.latestLogTitle ?? null,
        latestLogDetail: fulfillmentMeta?.latestLogDetail ?? null,
        latestLogAt: fulfillmentMeta?.latestLogAt ?? null,
        canRetry: fulfillmentMeta?.canRetry ?? false,
        canResend: fulfillmentMeta?.canResend ?? false,
        canTerminate: fulfillmentMeta?.canTerminate ?? false,
        canNote: fulfillmentMeta?.canNote ?? true,
      },
      fulfillmentLogs,
    };
  }

  exportOrdersCsv(filters: QueryFilters) {
    const rows = this.getOrdersList(filters, { page: 1, pageSize: 5000 }).list;
    const headers = [
      '订单号',
      '店铺',
      '商品',
      'SKU',
      '分类',
      '客户',
      '数量',
      '支付金额',
      '主状态',
      '发货状态',
      '支付状态',
      '售后状态',
      '来源',
      '支付时间',
      '完成时间',
    ];
    const lines = [
      headers.join(','),
      ...rows.map((row) =>
        [
          row.orderNo,
          row.storeName,
          row.productName,
          row.productSku,
          row.category,
          row.customerName,
          row.quantity,
          row.paidAmount,
          row.mainStatusText,
          row.deliveryStatusText,
          row.paymentStatusText,
          row.afterSaleStatus,
          row.source,
          row.paidAt,
          row.completedAt,
        ]
          .map((cell) => `"${String(cell ?? '').replaceAll('"', '""')}"`)
          .join(','),
      ),
    ];

    return lines.join('\n');
  }
}
