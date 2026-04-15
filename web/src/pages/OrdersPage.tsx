import {
  Alert,
  Button,
  Card,
  Col,
  Descriptions,
  Drawer,
  Row,
  Select,
  Space,
  Table,
  Tag,
  Timeline,
  Typography,
  message,
} from 'antd';
import type { TableProps } from 'antd';
import { DownloadOutlined } from '@ant-design/icons';
import { PageContainer } from '@ant-design/pro-components';
import { useCallback, useMemo, useState } from 'react';

import {
  type DashboardResponse,
  type FilterQuery,
  type OrderDetailResponse,
  type OrderFulfillmentWorkbenchResponse,
  type OrdersListResponse,
  type OrdersOverview,
  type XianyuOrderSyncResponse,
  apiRequest,
  buildQuery,
} from '../api';
import { canExportOrders, canManageFulfillment, canSyncOrderData } from '../access';
import { useAuth } from '../auth';
import { FilterBar } from '../components/FilterBar';
import { SummaryCards } from '../components/SummaryCards';
import { useRemoteData } from '../hooks/useRemoteData';
import {
  afterSaleStatusLabel,
  deliveryStatusLabel,
  formatCurrency,
  formatNumber,
  orderMainStatusLabel,
  paymentStatusLabel,
} from '../utils';

interface OrdersPageData {
  options: DashboardResponse['filters'];
  overview: OrdersOverview;
  workbench: OrderFulfillmentWorkbenchResponse;
  table: OrdersListResponse;
}

function mainStatusColor(status: string) {
  return (
    {
      paid: 'warning',
      processing: 'processing',
      fulfilled: 'blue',
      completed: 'success',
      after_sale: 'error',
      closed: 'default',
    }[status] ?? 'default'
  );
}

function deliveryColor(status: string) {
  return (
    {
      pending: 'warning',
      shipped: 'processing',
      delivered: 'success',
      manual_review: 'error',
    }[status] ?? 'default'
  );
}

function paymentColor(status: string) {
  return (
    {
      paid: 'success',
      refunded_partial: 'warning',
      refunded_full: 'error',
    }[status] ?? 'default'
  );
}

function afterSaleColor(status: string) {
  return (
    {
      none: 'default',
      processing: 'warning',
      resolved: 'success',
    }[status] ?? 'default'
  );
}

function fulfillmentQueueColor(status: string) {
  return (
    {
      pending: 'warning',
      processing: 'processing',
      success: 'success',
      failed: 'error',
      manual_review: 'magenta',
    }[status] ?? 'default'
  );
}

function fulfillmentTypeColor(type: string) {
  return (
    {
      standard: 'default',
      card: 'blue',
      direct_charge: 'gold',
    }[type] ?? 'default'
  );
}

export function OrdersPage() {
  const { user } = useAuth();
  const [filters, setFilters] = useState<FilterQuery>({
    preset: 'last30Days',
    page: 1,
    pageSize: 12,
    sortBy: 'paidAt',
    sortOrder: 'desc',
  });
  const [messageApi, contextHolder] = message.useMessage();
  const [detailOpen, setDetailOpen] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detail, setDetail] = useState<OrderDetailResponse | null>(null);
  const queryString = useMemo(() => buildQuery(filters), [filters]);
  const canManageCurrentFulfillment = canManageFulfillment(user?.role);

  const loader = useCallback(async () => {
    const [options, overview, workbench, table] = await Promise.all([
      apiRequest<DashboardResponse['filters']>('/api/options', undefined),
      apiRequest<OrdersOverview>(`/api/orders/overview?${queryString}`, undefined),
      apiRequest<OrderFulfillmentWorkbenchResponse>(
        `/api/orders/workbench/fulfillment?${queryString}`,
        undefined,
      ),
      apiRequest<OrdersListResponse>(`/api/orders?${queryString}`, undefined),
    ]);
    return { options, overview, workbench, table };
  }, [queryString]);
  const { data, loading, error, reload } = useRemoteData<OrdersPageData>(loader);

  const summary = useMemo(
    () =>
      data
        ? [
            { key: 'totalOrders', label: '订单总量', value: data.overview.totalOrders, unit: '单' },
            { key: 'paidOrders', label: '待履约', value: data.overview.paidOrders, unit: '单' },
            {
              key: 'fulfilledOrders',
              label: '已履约',
              value: data.overview.fulfilledOrders + data.overview.mainCompletedOrders,
              unit: '单',
            },
            {
              key: 'afterSaleOrders',
              label: '售后中',
              value: data.overview.mainAfterSaleOrders,
              unit: '单',
            },
            { key: 'salesAmount', label: '支付金额', value: data.overview.salesAmount, unit: 'CNY' },
            {
              key: 'deliveryHours',
              label: '平均发货时长',
              value: data.overview.averageDeliveryHours,
              unit: '小时',
            },
          ]
        : [],
    [data],
  );

  const fulfillmentSummary = useMemo(
    () =>
      data
        ? [
            {
              key: 'fulfillmentPending',
              label: '待处理队列',
              value: data.workbench.queueSummary.pending,
              unit: '单',
            },
            {
              key: 'fulfillmentProcessing',
              label: '处理中队列',
              value: data.workbench.queueSummary.processing,
              unit: '单',
            },
            {
              key: 'fulfillmentSuccess',
              label: '成功队列',
              value: data.workbench.queueSummary.success,
              unit: '单',
            },
            {
              key: 'fulfillmentFailed',
              label: '失败队列',
              value: data.workbench.queueSummary.failed,
              unit: '单',
            },
            {
              key: 'fulfillmentManual',
              label: '待人工队列',
              value: data.workbench.queueSummary.manual_review,
              unit: '单',
            },
          ]
        : [],
    [data],
  );

  const openDetail = useCallback(
    async (orderId: number) => {
      setDetailOpen(true);
      setDetailLoading(true);
      setDetailError(null);
      setDetail(null);
      try {
        const payload = await apiRequest<OrderDetailResponse>(
          `/api/orders/${orderId}`,
          undefined,
        );
        setDetail(payload);
      } catch (requestError) {
        setDetail(null);
        setDetailError(requestError instanceof Error ? requestError.message : '加载订单详情失败');
      } finally {
        setDetailLoading(false);
      }
    },
    [],
  );

  const runFulfillmentAction = useCallback(
    async (orderId: number, action: 'retry' | 'resend' | 'terminate' | 'note') => {
      try {
        if (action === 'terminate') {
          const reason = window.prompt('请输入终止原因', '人工终止当前履约任务');
          if (!reason) {
            return;
          }
          await apiRequest(
            `/api/orders/${orderId}/fulfillment/terminate`,
            { method: 'POST', body: JSON.stringify({ reason }) },
          );
          messageApi.success('履约已终止');
        } else if (action === 'note') {
          const note = window.prompt('请输入履约备注', '已联系供应商等待补回执');
          if (!note) {
            return;
          }
          await apiRequest(
            `/api/orders/${orderId}/fulfillment/note`,
            { method: 'POST', body: JSON.stringify({ note }) },
          );
          messageApi.success('履约备注已记录');
        } else {
          await apiRequest(
            `/api/orders/${orderId}/fulfillment/${action}`,
            { method: 'POST', body: '{}' },
          );
          messageApi.success(action === 'retry' ? '履约已重试' : '履约已补发');
        }

        await reload();
        if (detailOpen) {
          await openDetail(orderId);
        }
      } catch (requestError) {
        messageApi.error(requestError instanceof Error ? requestError.message : '履约操作失败');
      }
    },
    [detailOpen, messageApi, openDetail, reload],
  );

  const handleSyncOrders = useCallback(async () => {
    try {
      const payload = await apiRequest<XianyuOrderSyncResponse>(
        '/api/orders/xianyu-web-sync',
        {
          method: 'POST',
          body: JSON.stringify({
            storeIds: filters.storeId ? [filters.storeId] : undefined,
          }),
        },
      );
      const successStores = payload.results.filter((item) => item.success);
      const syncedOrders = successStores.reduce((sum, item) => sum + (item.syncedCount ?? 0), 0);
      await reload();
      messageApi.success(
        successStores.length > 0
          ? `已完成 ${successStores.length} 家店铺的真实成交单同步，共写入 ${syncedOrders} 笔订单。`
          : '同步任务已执行，但没有成功店铺。',
      );
    } catch (requestError) {
      messageApi.error(requestError instanceof Error ? requestError.message : '同步闲鱼真实成交单失败');
    }
  }, [filters.storeId, messageApi, reload]);

  const columns = useMemo<TableProps<OrdersListResponse['list'][number]>['columns']>(
    () => [
      {
        title: '订单号',
        dataIndex: 'orderNo',
        width: 200,
        render: (value: string, record) => (
          <div className="order-cell-stack">
            <Typography.Text strong>{value}</Typography.Text>
            <div className="order-cell-meta">
              下单时间：{record.paidAt}
              {record.latestEventAt ? ` · 最近事件：${record.latestEventAt}` : ''}
            </div>
          </div>
        ),
      },
      {
        title: '商品 / 店铺',
        dataIndex: 'productName',
        width: 240,
        render: (value: string, record) => (
          <div className="order-cell-stack">
            <Typography.Text>{value}</Typography.Text>
            <div className="order-cell-meta">
              {record.productSku} · {record.category}
            </div>
            <div className="order-cell-meta">{record.storeName}</div>
          </div>
        ),
      },
      {
        title: '客户',
        dataIndex: 'customerName',
        width: 130,
      },
      {
        title: '履约',
        dataIndex: 'fulfillmentQueue',
        width: 200,
        render: (_value, record) => (
          <div className="order-cell-stack">
            <Space wrap size={[4, 4]}>
              <Tag color={fulfillmentTypeColor(record.fulfillmentType)}>{record.fulfillmentTypeText}</Tag>
              <Tag color={fulfillmentQueueColor(record.fulfillmentQueue)}>{record.fulfillmentQueueText}</Tag>
            </Space>
            <div className="order-cell-meta">{record.fulfillmentStage}</div>
          </div>
        ),
      },
      {
        title: '金额',
        dataIndex: 'paidAmount',
        width: 160,
        sorter: true,
        render: (_value, record) => (
          <div className="order-cell-stack">
            <Typography.Text strong>{formatCurrency(record.paidAmount)}</Typography.Text>
            <div className="order-cell-meta">
              优惠 {formatCurrency(record.discountAmount)} · 退款 {formatCurrency(record.refundAmount)}
            </div>
          </div>
        ),
      },
      {
        title: '主状态',
        dataIndex: 'mainStatus',
        width: 130,
        render: (value: string) => <Tag color={mainStatusColor(value)}>{orderMainStatusLabel(value)}</Tag>,
      },
      {
        title: '发货状态',
        dataIndex: 'deliveryStatus',
        width: 130,
        render: (value: string) => <Tag color={deliveryColor(value)}>{deliveryStatusLabel(value)}</Tag>,
      },
      {
        title: '支付状态',
        dataIndex: 'paymentStatus',
        width: 130,
        render: (value: string) => <Tag color={paymentColor(value)}>{paymentStatusLabel(value)}</Tag>,
      },
      {
        title: '售后',
        dataIndex: 'afterSaleStatus',
        width: 120,
        render: (value: string) => <Tag color={afterSaleColor(value)}>{afterSaleStatusLabel(value)}</Tag>,
      },
      {
        title: '更新时间',
        dataIndex: 'updatedAt',
        width: 180,
        sorter: true,
      },
      {
        title: '操作',
        key: 'action',
        width: 100,
        fixed: 'right',
        render: (_value, record) => (
          <Button size="small" type="link" onClick={() => void openDetail(record.id)}>
            详情
          </Button>
        ),
      },
    ],
    [openDetail],
  );

  return (
    <PageContainer
      title="订单中心"
      subTitle="围绕统一订单主线查看主状态、发货状态、支付记录、订单事件和导出结果。"
      style={{ paddingInline: 0 }}
      extra={[
        <Button
          key="sync"
          disabled={!canSyncOrderData(user?.role)}
          onClick={() => void handleSyncOrders()}
        >
          同步真实成交单
        </Button>,
        <Button
          key="export"
          type="primary"
          icon={<DownloadOutlined />}
          disabled={!canExportOrders(user?.role)}
          onClick={async () => {
            try {
              const csv = await apiRequest<string>(
                `/api/orders/export?${queryString}`,
                undefined,
              );
              const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
              const url = window.URL.createObjectURL(blob);
              const link = document.createElement('a');
              link.href = url;
              link.download = 'orders-report.csv';
              link.click();
              window.URL.revokeObjectURL(url);
            } catch (err) {
              messageApi.error(err instanceof Error ? err.message : '导出失败');
            }
          }}
        >
          导出 CSV
        </Button>,
      ]}
    >
      {contextHolder}
      <div className="page-grid">
        <Alert
          type="info"
          showIcon
          message={'点击右上角"同步真实成交单"按钮，系统将通过已绑定的闲鱼登录态拉取平台真实成交订单并写入本地库，支持增量同步。'}
        />

        <FilterBar
          filters={filters}
          onChange={(next) => setFilters({ ...next, page: 1, pageSize: filters.pageSize })}
          stores={data?.options.stores ?? []}
          products={data?.options.products ?? []}
          categories={data?.options.categories ?? []}
          sources={data?.options.sources ?? []}
          showKeyword
        />

        <Card className="glass-panel" styles={{ body: { padding: 16 } }}>
          <Space wrap size={[12, 12]}>
            <Select
              allowClear
              placeholder="主状态"
              style={{ width: 160 }}
              value={filters.mainStatus}
              onChange={(value) => setFilters((prev) => ({ ...prev, mainStatus: value, page: 1 }))}
              options={[
                { label: '待履约', value: 'paid' },
                { label: '处理中', value: 'processing' },
                { label: '已履约', value: 'fulfilled' },
                { label: '已完成', value: 'completed' },
                { label: '售后中', value: 'after_sale' },
                { label: '已关闭', value: 'closed' },
              ]}
            />
            <Select
              allowClear
              placeholder="发货状态"
              style={{ width: 160 }}
              value={filters.deliveryStatus}
              onChange={(value) =>
                setFilters((prev) => ({ ...prev, deliveryStatus: value, page: 1 }))
              }
              options={[
                { label: '待发货', value: 'pending' },
                { label: '已发货', value: 'shipped' },
                { label: '已交付', value: 'delivered' },
                { label: '人工处理', value: 'manual_review' },
              ]}
            />
            <Select
              allowClear
              placeholder="售后状态"
              style={{ width: 160 }}
              value={filters.afterSaleStatus}
              onChange={(value) => setFilters((prev) => ({ ...prev, afterSaleStatus: value, page: 1 }))}
              options={[
                { label: '无售后', value: 'none' },
                { label: '处理中', value: 'processing' },
                { label: '已完结', value: 'resolved' },
              ]}
            />
            <Select
              value={`${filters.sortBy ?? 'paidAt'}:${filters.sortOrder ?? 'desc'}`}
              style={{ width: 190 }}
              onChange={(value) => {
                const [sortBy, sortOrder] = value.split(':') as [FilterQuery['sortBy'], FilterQuery['sortOrder']];
                setFilters((prev) => ({ ...prev, sortBy, sortOrder }));
              }}
              options={[
                { label: '下单时间倒序', value: 'paidAt:desc' },
                { label: '下单时间正序', value: 'paidAt:asc' },
                { label: '支付金额从高到低', value: 'paidAmount:desc' },
                { label: '支付金额从低到高', value: 'paidAmount:asc' },
                { label: '更新时间倒序', value: 'updatedAt:desc' },
                { label: '完成时间倒序', value: 'completedAt:desc' },
              ]}
            />
          </Space>
        </Card>

        {error ? <Alert type="error" showIcon message={error} /> : null}
        {data ? <SummaryCards items={summary} /> : null}
        {data ? <SummaryCards items={fulfillmentSummary} /> : null}

        {data ? (
          <Row gutter={[16, 16]}>
            <Col xs={24} xl={14}>
              <Card className="glass-panel" title="异常订单工作台" bordered={false}>
                <Table
                  rowKey="id"
                  size="small"
                  pagination={false}
                  dataSource={data.workbench.exceptionOrders}
                  scroll={{ x: 1080 }}
                  columns={[
                    { title: '订单号', dataIndex: 'orderNo', width: 180 },
                    { title: '店铺', dataIndex: 'storeName', width: 140 },
                    { title: '商品', dataIndex: 'productName', width: 200 },
                    {
                      title: '履约',
                      dataIndex: 'fulfillmentQueue',
                      width: 220,
                      render: (_value, record) => (
                        <div className="order-cell-stack">
                          <Space wrap size={[4, 4]}>
                            <Tag color={fulfillmentTypeColor(record.fulfillmentType)}>
                              {record.fulfillmentTypeText}
                            </Tag>
                            <Tag color={fulfillmentQueueColor(record.fulfillmentQueue)}>
                              {record.fulfillmentQueueText}
                            </Tag>
                          </Space>
                          <div className="order-cell-meta">{record.fulfillmentStage}</div>
                        </div>
                      ),
                    },
                    { title: '原因', dataIndex: 'fulfillmentStageDetail' },
                    { title: '更新时间', dataIndex: 'updatedAt', width: 170 },
                    {
                      title: '操作',
                      key: 'action',
                      width: 220,
                      render: (_value, record) => (
                        <Space wrap size={4}>
                          <Button size="small" type="link" onClick={() => void openDetail(record.id)}>
                            详情
                          </Button>
                          {canManageCurrentFulfillment ? (
                            <Button size="small" type="link" onClick={() => void runFulfillmentAction(record.id, 'retry')}>
                              重试
                            </Button>
                          ) : null}
                          {canManageCurrentFulfillment && record.fulfillmentType === 'card' ? (
                            <Button size="small" type="link" onClick={() => void runFulfillmentAction(record.id, 'resend')}>
                              补发
                            </Button>
                          ) : null}
                        </Space>
                      ),
                    },
                  ]}
                />
              </Card>
            </Col>
            <Col xs={24} xl={10}>
              <Card className="glass-panel" title="店铺履约表现" bordered={false}>
                <Table
                  rowKey="storeId"
                  size="small"
                  pagination={false}
                  dataSource={data.workbench.storeStats}
                  scroll={{ x: 760 }}
                  columns={[
                    { title: '店铺', dataIndex: 'storeName', width: 140 },
                    { title: '订单数', dataIndex: 'totalOrders', width: 90 },
                    { title: '成功', dataIndex: 'successCount', width: 80 },
                    { title: '失败', dataIndex: 'failedCount', width: 80 },
                    { title: '人工', dataIndex: 'manualCount', width: 80 },
                    { title: '处理中', dataIndex: 'processingCount', width: 90 },
                    { title: '成功率', dataIndex: 'successRate', render: (value: number) => `${value.toFixed(1)}%` },
                    { title: '失败率', dataIndex: 'failedRate', render: (value: number) => `${value.toFixed(1)}%` },
                    { title: '人工率', dataIndex: 'manualRate', render: (value: number) => `${value.toFixed(1)}%` },
                  ]}
                />
              </Card>
            </Col>
          </Row>
        ) : null}

        {data ? (
          <Card className="glass-panel" title="履约任务日志" bordered={false}>
            <Table
              rowKey="id"
              size="small"
              pagination={false}
              dataSource={data.workbench.logs}
              scroll={{ x: 1220 }}
              columns={[
                { title: '时间', dataIndex: 'createdAt', width: 170 },
                { title: '订单号', dataIndex: 'orderNo', width: 180 },
                { title: '店铺', dataIndex: 'storeName', width: 140 },
                { title: '商品', dataIndex: 'productName', width: 180 },
                { title: '事件', dataIndex: 'eventTitle', width: 180 },
                { title: '详情', dataIndex: 'eventDetail' },
                { title: '操作人', dataIndex: 'operatorName', width: 120, render: (value: string | null) => value ?? '系统' },
                {
                  title: '操作',
                  key: 'action',
                  width: 90,
                  render: (_value, record) => (
                    <Button size="small" type="link" onClick={() => void openDetail(record.orderId)}>
                      查看
                    </Button>
                  ),
                },
              ]}
            />
          </Card>
        ) : null}

        <div className="glass-panel order-center-shell">
          <div className="order-center-header">
            <div>
              <Typography.Title level={4} style={{ marginBottom: 8 }}>
                订单列表
              </Typography.Title>
              <Typography.Text type="secondary">
                支持按店铺、时间、状态、商品筛选，并可按下单时间、支付金额、更新时间排序。
              </Typography.Text>
            </div>
            <Typography.Text type="secondary">
              当前结果：{data?.table.total ?? 0} 单
            </Typography.Text>
          </div>

          <Table
            rowKey="id"
            loading={loading}
            columns={columns}
            dataSource={data?.table.list ?? []}
            scroll={{ x: 1500 }}
            pagination={{
              current: data?.table.page,
              pageSize: data?.table.pageSize,
              total: data?.table.total,
              onChange: (page, pageSize) => setFilters((prev) => ({ ...prev, page, pageSize })),
            }}
            onChange={(_pagination, _tableFilters, sorter) => {
              if (Array.isArray(sorter) || !sorter.field) {
                return;
              }
              const field = String(sorter.field);
              if (!['paidAmount', 'paidAt', 'updatedAt', 'completedAt'].includes(field)) {
                return;
              }
              setFilters((prev) => ({
                ...prev,
                sortBy: field as FilterQuery['sortBy'],
                sortOrder: sorter.order === 'ascend' ? 'asc' : 'desc',
              }));
            }}
          />
        </div>
      </div>

      <Drawer
        title={detail?.order.orderNo ? `订单详情：${detail.order.orderNo}` : '订单详情'}
        open={detailOpen}
        width={880}
        onClose={() => setDetailOpen(false)}
      >
        {detailError ? <Alert type="error" showIcon message={detailError} /> : null}
        {detail && !detailError ? (
          <div className="order-detail-layout">
            <Row gutter={[16, 16]}>
              <Col xs={24}>
                <Card className="order-detail-card" bordered={false}>
                  <Space wrap style={{ marginBottom: 16 }}>
                    <Tag color={fulfillmentTypeColor(detail.order.fulfillmentType)}>
                      {detail.order.fulfillmentTypeText}
                    </Tag>
                    <Tag color={fulfillmentQueueColor(detail.order.fulfillmentQueue)}>
                      {detail.order.fulfillmentQueueText}
                    </Tag>
                    <Tag color={mainStatusColor(detail.order.mainStatus)}>
                      {orderMainStatusLabel(detail.order.mainStatus)}
                    </Tag>
                    <Tag color={deliveryColor(detail.order.deliveryStatus)}>
                      {deliveryStatusLabel(detail.order.deliveryStatus)}
                    </Tag>
                    <Tag color={paymentColor(detail.order.paymentStatus)}>
                      {paymentStatusLabel(detail.order.paymentStatus)}
                    </Tag>
                    <Tag color={afterSaleColor(detail.order.afterSaleStatus)}>
                      {afterSaleStatusLabel(detail.order.afterSaleStatus)}
                    </Tag>
                    {detail.order.isNewCustomer ? <Tag color="gold">新客首单</Tag> : null}
                  </Space>

                  <Alert
                    type={
                      detail.fulfillment.queue === 'success'
                        ? 'success'
                        : detail.fulfillment.queue === 'failed'
                          ? 'error'
                          : detail.fulfillment.queue === 'manual_review'
                            ? 'warning'
                            : 'info'
                    }
                    showIcon
                    message={detail.fulfillment.stage}
                    description={detail.fulfillment.stageDetail}
                    style={{ marginBottom: 16 }}
                  />

                  <Descriptions column={2} size="small" className="order-descriptions">
                    <Descriptions.Item label="店铺">{detail.order.storeName}</Descriptions.Item>
                    <Descriptions.Item label="商品">
                      {detail.order.productName} / {detail.order.productSku}
                    </Descriptions.Item>
                    <Descriptions.Item label="客户">
                      {detail.order.customerName} / {detail.order.customerProvince}
                    </Descriptions.Item>
                    <Descriptions.Item label="来源">{detail.order.source}</Descriptions.Item>
                    <Descriptions.Item label="支付金额">
                      {formatCurrency(detail.order.paidAmount)}
                    </Descriptions.Item>
                    <Descriptions.Item label="优惠金额">
                      {formatCurrency(detail.order.discountAmount)}
                    </Descriptions.Item>
                    <Descriptions.Item label="退款金额">
                      {formatCurrency(detail.order.refundAmount)}
                    </Descriptions.Item>
                    <Descriptions.Item label="发货时长">
                      {formatNumber(detail.order.deliveryHours, ' 小时')}
                    </Descriptions.Item>
                    <Descriptions.Item label="下单时间">{detail.order.paidAt}</Descriptions.Item>
                    <Descriptions.Item label="更新时间">{detail.order.updatedAt}</Descriptions.Item>
                    <Descriptions.Item label="买家备注">
                      {detail.order.buyerNote || '无'}
                    </Descriptions.Item>
                    <Descriptions.Item label="卖家备注">
                      {detail.order.sellerRemark || '无'}
                    </Descriptions.Item>
                  </Descriptions>
                </Card>
              </Col>

              <Col xs={24}>
                <Card title="履约控制" className="order-detail-card" bordered={false}>
                  <Descriptions column={2} size="small" className="order-descriptions" style={{ marginBottom: 16 }}>
                    <Descriptions.Item label="履约类型">{detail.fulfillment.typeText}</Descriptions.Item>
                    <Descriptions.Item label="履约队列">{detail.fulfillment.queueText}</Descriptions.Item>
                    <Descriptions.Item label="任务号">
                      {detail.fulfillment.latestTaskNo ?? detail.fulfillment.latestOutboundNo ?? '-'}
                    </Descriptions.Item>
                    <Descriptions.Item label="供应商单号">
                      {detail.fulfillment.latestSupplierOrderNo ?? '-'}
                    </Descriptions.Item>
                    <Descriptions.Item label="重试次数">
                      {detail.fulfillment.maxRetry > 0
                        ? `${detail.fulfillment.retryCount}/${detail.fulfillment.maxRetry}`
                        : detail.fulfillment.retryCount}
                    </Descriptions.Item>
                    <Descriptions.Item label="人工原因">
                      {detail.fulfillment.manualReason ?? '-'}
                    </Descriptions.Item>
                    <Descriptions.Item label="最近履约日志">
                      {detail.fulfillment.latestLogTitle ?? '-'}
                    </Descriptions.Item>
                    <Descriptions.Item label="最近履约时间">
                      {detail.fulfillment.latestLogAt ?? '-'}
                    </Descriptions.Item>
                  </Descriptions>
                  <Space wrap>
                    <Button
                      type="primary"
                      disabled={!canManageCurrentFulfillment || !detail.fulfillment.canRetry}
                      onClick={() => void runFulfillmentAction(detail.order.id, 'retry')}
                    >
                      重试
                    </Button>
                    <Button
                      disabled={!canManageCurrentFulfillment || !detail.fulfillment.canResend}
                      onClick={() => void runFulfillmentAction(detail.order.id, 'resend')}
                    >
                      补发
                    </Button>
                    <Button
                      danger
                      disabled={!canManageCurrentFulfillment || !detail.fulfillment.canTerminate}
                      onClick={() => void runFulfillmentAction(detail.order.id, 'terminate')}
                    >
                      终止
                    </Button>
                    <Button
                      disabled={!canManageCurrentFulfillment || !detail.fulfillment.canNote}
                      onClick={() => void runFulfillmentAction(detail.order.id, 'note')}
                    >
                      备注
                    </Button>
                  </Space>
                </Card>
              </Col>

              <Col xs={24}>
                <Card title="订单项" className="order-detail-card" bordered={false}>
                  <Table
                    rowKey="id"
                    pagination={false}
                    dataSource={detail.items}
                    columns={[
                      { title: '行号', dataIndex: 'lineNo', width: 80 },
                      {
                        title: '商品',
                        dataIndex: 'productName',
                        render: (value: string, record) => (
                          <div className="order-cell-stack">
                            <Typography.Text>{value}</Typography.Text>
                            <div className="order-cell-meta">
                              {record.productSku} · {record.category}
                            </div>
                          </div>
                        ),
                      },
                      {
                        title: '数量 / 单价',
                        dataIndex: 'quantity',
                        render: (_value, record) => (
                          <div className="order-cell-stack">
                            <div>{formatNumber(record.quantity, ' 件')}</div>
                            <div className="order-cell-meta">{formatCurrency(record.unitPrice)}</div>
                          </div>
                        ),
                      },
                      {
                        title: '状态',
                        dataIndex: 'deliveryStatus',
                        render: (_value, record) => (
                          <Space wrap>
                            <Tag color={deliveryColor(record.deliveryStatus)}>
                              {deliveryStatusLabel(record.deliveryStatus)}
                            </Tag>
                            <Tag color={afterSaleColor(record.afterSaleStatus)}>
                              {afterSaleStatusLabel(record.afterSaleStatus)}
                            </Tag>
                          </Space>
                        ),
                      },
                      {
                        title: '实付',
                        dataIndex: 'paidAmount',
                        width: 120,
                        render: (value: number) => formatCurrency(value),
                      },
                    ]}
                  />
                </Card>
              </Col>

              <Col xs={24}>
                <Card title="支付记录" className="order-detail-card" bordered={false}>
                  <Table
                    rowKey="id"
                    pagination={false}
                    dataSource={detail.payments}
                    columns={[
                      { title: '支付单号', dataIndex: 'paymentNo' },
                      { title: '支付渠道', dataIndex: 'paymentChannel', width: 120 },
                      {
                        title: '支付状态',
                        dataIndex: 'paymentStatus',
                        width: 120,
                        render: (value: string) => (
                          <Tag color={paymentColor(value)}>{paymentStatusLabel(value)}</Tag>
                        ),
                      },
                      {
                        title: '金额',
                        dataIndex: 'paidAmount',
                        render: (_value, record) => (
                          <div className="order-cell-stack">
                            <div>实付：{formatCurrency(record.paidAmount)}</div>
                            <div className="order-cell-meta">
                              原价 {formatCurrency(record.grossAmount)} · 优惠{' '}
                              {formatCurrency(record.discountAmount)}
                            </div>
                          </div>
                        ),
                      },
                      { title: '支付时间', dataIndex: 'paidAt', width: 180 },
                    ]}
                  />
                </Card>
              </Col>

              <Col xs={24}>
                <Card title="履约日志" className="order-detail-card" bordered={false}>
                  <Timeline
                    items={detail.fulfillmentLogs.map((event) => ({
                      children: (
                        <div className="order-timeline-item">
                          <div className="order-timeline-title">{event.eventTitle}</div>
                          <div className="order-cell-meta">
                            {event.createdAt}
                            {event.operatorName ? ` · ${event.operatorName}` : ''}
                          </div>
                          <div className="order-timeline-detail">{event.eventDetail}</div>
                        </div>
                      ),
                    }))}
                  />
                </Card>
              </Col>

              <Col xs={24}>
                <Card title="订单时间线" className="order-detail-card" bordered={false}>
                  <Timeline
                    items={detail.events.map((event) => ({
                      children: (
                        <div className="order-timeline-item">
                          <div className="order-timeline-title">{event.eventTitle}</div>
                          <div className="order-cell-meta">
                            {event.createdAt}
                            {event.operatorName ? ` · ${event.operatorName}` : ''}
                          </div>
                          <div className="order-timeline-detail">{event.eventDetail}</div>
                        </div>
                      ),
                    }))}
                  />
                </Card>
              </Col>
            </Row>
          </div>
        ) : null}

        {!detail && !detailError && detailLoading ? (
          <Typography.Text type="secondary">订单详情加载中...</Typography.Text>
        ) : null}
      </Drawer>
    </PageContainer>
  );
}
