import {
  Alert,
  Button,
  Card,
  Col,
  Descriptions,
  Drawer,
  Empty,
  Row,
  Select,
  Space,
  Table,
  Tag,
  Timeline,
  Typography,
} from 'antd';
import { PageContainer } from '@ant-design/pro-components';
import { useCallback, useMemo, useState } from 'react';

import {
  type AfterSaleDetailResponse,
  type AfterSaleListResponse,
  type AfterSaleWorkbenchResponse,
  type DashboardResponse,
  type FilterQuery,
  apiRequest,
  buildQuery,
} from '../api';
import { canManageAfterSale } from '../access';
import { useAuth } from '../auth';
import { FilterBar } from '../components/FilterBar';
import { SummaryCards } from '../components/SummaryCards';
import { useRemoteData } from '../hooks/useRemoteData';
import { formatCurrency } from '../utils';

interface AfterSalePageData {
  options: DashboardResponse['filters'];
  workbench: AfterSaleWorkbenchResponse;
  table: AfterSaleListResponse;
}

function caseTypeColor(type: string) {
  return (
    {
      refund: 'gold',
      resend: 'cyan',
      dispute: 'volcano',
    }[type] ?? 'default'
  );
}

function caseStatusColor(status: string) {
  return (
    {
      pending_review: 'warning',
      processing: 'processing',
      waiting_execute: 'cyan',
      resolved: 'success',
      rejected: 'default',
    }[status] ?? 'default'
  );
}

function reminderColor(type: string) {
  return type === 'timeout' ? 'error' : 'processing';
}

function priorityColor(priority: string) {
  return (
    {
      low: 'default',
      normal: 'processing',
      high: 'warning',
      urgent: 'error',
    }[priority] ?? 'default'
  );
}

export function AfterSalePage() {
  const { user } = useAuth();
  const [filters, setFilters] = useState<FilterQuery>({
    preset: 'last30Days',
    page: 1,
    pageSize: 10,
  });
  const [detail, setDetail] = useState<AfterSaleDetailResponse | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailVisible, setDetailVisible] = useState(false);
  const queryString = useMemo(() => buildQuery(filters), [filters]);
  const canManageCurrentAfterSale = canManageAfterSale(user?.role);

  const loader = useCallback(async () => {
    const [options, workbench, table] = await Promise.all([
      apiRequest<DashboardResponse['filters']>('/api/options', undefined),
      apiRequest<AfterSaleWorkbenchResponse>(
        `/api/after-sales/workbench?${queryString}`,
        undefined,
      ),
      apiRequest<AfterSaleListResponse>(
        `/api/after-sales?${queryString}`,
        undefined,
      ),
    ]);

    return { options, workbench, table };
  }, [queryString]);

  const { data, loading, error, reload } = useRemoteData<AfterSalePageData>(loader);

  const summary = useMemo(
    () =>
      data
        ? [
            { key: 'totalCases', label: '售后总单量', value: data.workbench.summary.totalCases, unit: '单' },
            { key: 'pendingCases', label: '待处理', value: data.workbench.summary.pendingCases, unit: '单' },
            { key: 'timeoutCases', label: '超时提醒', value: data.workbench.summary.timeoutCases, unit: '单' },
            {
              key: 'pendingRefundAmount',
              label: '待退款金额',
              value: data.workbench.summary.pendingRefundAmount,
              unit: '元',
            },
          ]
        : [],
    [data],
  );

  const openDetail = useCallback(
    async (caseId: number) => {
      setDetailVisible(true);
      setDetailLoading(true);
      try {
        const payload = await apiRequest<AfterSaleDetailResponse>(
          `/api/after-sales/${caseId}`,
          undefined,
        );
        setDetail(payload);
      } finally {
        setDetailLoading(false);
      }
    },
    [],
  );

  const runAfterSaleAction = useCallback(
    async (
      caseId: number,
      action:
        | 'refundApprove'
        | 'refundReject'
        | 'refundComplete'
        | 'resendApprove'
        | 'resendReject'
        | 'resendExecute'
        | 'resendFail'
        | 'disputeBuyer'
        | 'disputeSeller'
        | 'disputeRefund'
        | 'disputeResend'
        | 'note',
    ) => {
      if (!canManageCurrentAfterSale) {
        return;
      }

      let path = '';
      let payload: Record<string, unknown> = {};

      if (action === 'refundApprove') {
        const amountText = window.prompt('请输入通过退款金额', String(detail?.refund?.requestedAmount ?? 0));
        if (!amountText) {
          return;
        }
        const approvedAmount = Number(amountText);
        if (!Number.isFinite(approvedAmount) || approvedAmount <= 0) {
          return;
        }
        const note = window.prompt('请输入审核备注，可留空', '') ?? '';
        path = `/api/after-sales/${caseId}/refund/review`;
        payload = { decision: 'approve', approvedAmount, note };
      }

      if (action === 'refundReject') {
        path = `/api/after-sales/${caseId}/refund/review`;
        payload = { decision: 'reject', note: window.prompt('请输入驳回原因', '') ?? '' };
      }

      if (action === 'refundComplete') {
        path = `/api/after-sales/${caseId}/refund/review`;
        payload = { decision: 'refund', note: window.prompt('请输入退款说明，可留空', '') ?? '' };
      }

      if (action === 'resendApprove') {
        path = `/api/after-sales/${caseId}/resend/execute`;
        payload = { decision: 'approve', note: window.prompt('请输入补发审核说明，可留空', '') ?? '' };
      }

      if (action === 'resendReject') {
        path = `/api/after-sales/${caseId}/resend/execute`;
        payload = { decision: 'reject', note: window.prompt('请输入补发驳回原因', '') ?? '' };
      }

      if (action === 'resendExecute') {
        path = `/api/after-sales/${caseId}/resend/execute`;
        payload = { decision: 'success', note: window.prompt('请输入补发执行说明，可留空', '') ?? '' };
      }

      if (action === 'resendFail') {
        path = `/api/after-sales/${caseId}/resend/execute`;
        payload = { decision: 'failed', note: window.prompt('请输入补发失败原因', '') ?? '' };
      }

      if (['disputeBuyer', 'disputeSeller', 'disputeRefund', 'disputeResend'].includes(action)) {
        const compensationText =
          action === 'disputeBuyer' || action === 'disputeRefund'
            ? window.prompt('请输入补偿金额，可留空', '0') ?? '0'
            : '0';
        path = `/api/after-sales/${caseId}/dispute/conclude`;
        payload = {
          decision:
            action === 'disputeBuyer'
              ? 'buyer_win'
              : action === 'disputeSeller'
                ? 'seller_win'
                : action === 'disputeRefund'
                  ? 'refund'
                  : 'resend',
          note: window.prompt('请输入争议结论说明', '') ?? '',
          compensationAmount: Number(compensationText) || 0,
        };
      }

      if (action === 'note') {
        const note = window.prompt('请输入售后备注', '') ?? '';
        if (!note) {
          return;
        }
        path = `/api/after-sales/${caseId}/note`;
        payload = { note };
      }

      if (!path) {
        return;
      }

      await apiRequest(
        path,
        {
          method: 'POST',
          body: JSON.stringify(payload),
        },
      );
      await reload();
      if (detailVisible) {
        await openDetail(caseId);
      }
    },
    [canManageCurrentAfterSale, detail?.refund?.requestedAmount, detailVisible, openDetail, reload],
  );

  return (
    <PageContainer
      title="售后中心"
      subTitle="集中处理退款、补发、争议和超时提醒，统一关联订单与履约记录。"
      style={{ paddingInline: 0 }}
    >
      <div className="page-grid">
        <FilterBar
          filters={filters}
          onChange={(next) =>
            setFilters({
              ...next,
              caseType: filters.caseType,
              caseStatus: filters.caseStatus,
              page: 1,
              pageSize: filters.pageSize,
            })
          }
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
              placeholder="售后类型"
              style={{ width: 160 }}
              value={filters.caseType}
              options={[
                { label: '退款单', value: 'refund' },
                { label: '补发单', value: 'resend' },
                { label: '争议单', value: 'dispute' },
              ]}
              onChange={(value) => setFilters((prev) => ({ ...prev, caseType: value, page: 1 }))}
            />
            <Select
              allowClear
              placeholder="处理状态"
              style={{ width: 180 }}
              value={filters.caseStatus}
              options={[
                { label: '待审核', value: 'pending_review' },
                { label: '处理中', value: 'processing' },
                { label: '待执行', value: 'waiting_execute' },
                { label: '已完结', value: 'resolved' },
                { label: '已驳回', value: 'rejected' },
              ]}
              onChange={(value) => setFilters((prev) => ({ ...prev, caseStatus: value, page: 1 }))}
            />
          </Space>
        </Card>

        {error ? <Alert type="error" showIcon message={error} /> : null}
        {data ? <SummaryCards items={summary} /> : null}

        <Row gutter={[16, 16]}>
          <Col xs={24} xl={12}>
            <Card className="glass-panel" title="提醒队列" bordered={false}>
              <Table
                rowKey="id"
                loading={loading}
                pagination={false}
                size="small"
                columns={[
                  {
                    title: '提醒',
                    dataIndex: 'title',
                    render: (_value: string, record: AfterSaleWorkbenchResponse['reminders'][number]) => (
                      <Space direction="vertical" size={0}>
                        <Space wrap>
                          <Tag color={reminderColor(record.reminderType)}>{record.reminderTypeText}</Tag>
                          <Tag color={caseTypeColor(record.caseType)}>{record.caseTypeText}</Tag>
                        </Space>
                        <Typography.Text strong>{record.caseNo}</Typography.Text>
                        <Typography.Text type="secondary">{record.detail}</Typography.Text>
                      </Space>
                    ),
                  },
                  {
                    title: '订单 / 商品',
                    dataIndex: 'orderNo',
                    render: (_value: string, record: AfterSaleWorkbenchResponse['reminders'][number]) => (
                      <Space direction="vertical" size={0}>
                        <Typography.Text>{record.orderNo}</Typography.Text>
                        <Typography.Text type="secondary">{record.productName}</Typography.Text>
                      </Space>
                    ),
                  },
                  {
                    title: '动作',
                    dataIndex: 'caseId',
                    width: 90,
                    render: (value: number) => (
                      <Button size="small" type="link" onClick={() => void openDetail(value)}>
                        查看
                      </Button>
                    ),
                  },
                ]}
                dataSource={data?.workbench.reminders ?? []}
                locale={{ emptyText: <Empty description="暂无提醒" image={Empty.PRESENTED_IMAGE_SIMPLE} /> }}
              />
            </Card>
          </Col>
          <Col xs={24} xl={12}>
            <Card className="glass-panel" title="超时售后单" bordered={false}>
              <Table
                rowKey="id"
                loading={loading}
                pagination={false}
                size="small"
                columns={[
                  {
                    title: '售后单',
                    dataIndex: 'caseNo',
                    render: (_value: string, record: AfterSaleWorkbenchResponse['timeoutCases'][number]) => (
                      <Space direction="vertical" size={0}>
                        <Space wrap>
                          <Tag color={caseTypeColor(record.caseType)}>{record.caseTypeText}</Tag>
                          <Tag color={caseStatusColor(record.caseStatus)}>{record.caseStatusText}</Tag>
                          <Tag color={priorityColor(record.priority)}>{record.priorityText}</Tag>
                        </Space>
                        <Typography.Text strong>{record.caseNo}</Typography.Text>
                        <Typography.Text type="secondary">{record.latestResult ?? record.reason}</Typography.Text>
                      </Space>
                    ),
                  },
                  {
                    title: '订单 / 截止',
                    dataIndex: 'deadlineAt',
                    render: (_value: string, record: AfterSaleWorkbenchResponse['timeoutCases'][number]) => (
                      <Space direction="vertical" size={0}>
                        <Typography.Text>{record.orderNo}</Typography.Text>
                        <Typography.Text type="secondary">{record.deadlineAt}</Typography.Text>
                      </Space>
                    ),
                  },
                  {
                    title: '动作',
                    dataIndex: 'id',
                    width: 90,
                    render: (value: number) => (
                      <Button size="small" type="link" onClick={() => void openDetail(value)}>
                        查看
                      </Button>
                    ),
                  },
                ]}
                dataSource={data?.workbench.timeoutCases ?? []}
                locale={{ emptyText: <Empty description="暂无超时单" image={Empty.PRESENTED_IMAGE_SIMPLE} /> }}
              />
            </Card>
          </Col>
        </Row>

        <Card className="glass-panel" title="售后工作台" bordered={false}>
          <Table
            rowKey="id"
            loading={loading}
            pagination={{
              current: data?.table.page,
              pageSize: data?.table.pageSize,
              total: data?.table.total,
              onChange: (page, pageSize) => setFilters((prev) => ({ ...prev, page, pageSize })),
            }}
            columns={[
              {
                title: '售后单',
                dataIndex: 'caseNo',
                width: 220,
                render: (_value: string, record: AfterSaleListResponse['list'][number]) => (
                  <Space direction="vertical" size={0}>
                    <Space wrap>
                      <Tag color={caseTypeColor(record.caseType)}>{record.caseTypeText}</Tag>
                      <Tag color={caseStatusColor(record.caseStatus)}>{record.caseStatusText}</Tag>
                      <Tag color={priorityColor(record.priority)}>{record.priorityText}</Tag>
                      {record.reminderTypes.map((type) => (
                        <Tag key={type} color={reminderColor(type)}>
                          {type === 'timeout' ? '超时' : '待处理'}
                        </Tag>
                      ))}
                    </Space>
                    <Typography.Text strong>{record.caseNo}</Typography.Text>
                    <Typography.Text type="secondary">{record.reason}</Typography.Text>
                  </Space>
                ),
              },
              {
                title: '订单 / 商品',
                dataIndex: 'orderNo',
                render: (_value: string, record: AfterSaleListResponse['list'][number]) => (
                  <Space direction="vertical" size={0}>
                    <Typography.Text>{record.orderNo}</Typography.Text>
                    <Typography.Text type="secondary">{record.productName}</Typography.Text>
                    <Typography.Text type="secondary">{record.customerName}</Typography.Text>
                  </Space>
                ),
              },
              {
                title: '处理进度',
                dataIndex: 'latestResult',
                render: (_value: string, record: AfterSaleListResponse['list'][number]) => (
                  <Space direction="vertical" size={0}>
                    <Typography.Text>{record.latestResult ?? '等待处理'}</Typography.Text>
                    <Typography.Text type="secondary">截止：{record.deadlineAt}</Typography.Text>
                    {record.refundStatusText ? <Typography.Text type="secondary">退款：{record.refundStatusText}</Typography.Text> : null}
                    {record.resendStatusText ? <Typography.Text type="secondary">补发：{record.resendStatusText}</Typography.Text> : null}
                    {record.disputeStatusText ? <Typography.Text type="secondary">争议：{record.disputeStatusText}</Typography.Text> : null}
                  </Space>
                ),
              },
              {
                title: '金额',
                dataIndex: 'requestedAmount',
                width: 140,
                render: (_value: number | null, record: AfterSaleListResponse['list'][number]) => (
                  <Space direction="vertical" size={0}>
                    {record.requestedAmount ? <Typography.Text>{formatCurrency(record.requestedAmount)}</Typography.Text> : <Typography.Text type="secondary">-</Typography.Text>}
                    {record.approvedAmount ? <Typography.Text type="secondary">通过 {formatCurrency(record.approvedAmount)}</Typography.Text> : null}
                    {record.compensationAmount ? <Typography.Text type="secondary">补偿 {formatCurrency(record.compensationAmount)}</Typography.Text> : null}
                  </Space>
                ),
              },
              {
                title: '动作',
                dataIndex: 'id',
                width: 180,
                render: (_value: number, record: AfterSaleListResponse['list'][number]) => (
                  <Space wrap>
                    <Button size="small" type="link" onClick={() => void openDetail(record.id)}>
                      详情
                    </Button>
                    {record.caseType === 'refund' && record.refundStatus === 'pending_review' && canManageCurrentAfterSale ? (
                      <Button size="small" type="link" onClick={() => void runAfterSaleAction(record.id, 'refundApprove')}>
                        通过退款
                      </Button>
                    ) : null}
                    {record.caseType === 'resend' && record.canExecuteResend && canManageCurrentAfterSale ? (
                      <Button size="small" type="link" onClick={() => void runAfterSaleAction(record.id, 'resendExecute')}>
                        执行补发
                      </Button>
                    ) : null}
                    {record.caseType === 'dispute' && record.canConcludeDispute && canManageCurrentAfterSale ? (
                      <Button size="small" type="link" onClick={() => void runAfterSaleAction(record.id, 'disputeBuyer')}>
                        支持买家
                      </Button>
                    ) : null}
                  </Space>
                ),
              },
            ]}
            dataSource={data?.table.list ?? []}
          />
        </Card>

        <Drawer
          title={detail ? `售后详情 ${detail.caseInfo.caseNo}` : '售后详情'}
          width={920}
          open={detailVisible}
          onClose={() => setDetailVisible(false)}
          destroyOnClose
        >
          {detailLoading ? null : detail ? (
            <Space direction="vertical" size={16} style={{ width: '100%' }}>
              <Alert
                type={
                  detail.reminders.some(
                    (item) => item.reminderType === 'timeout' && item.reminderStatus === 'active',
                  )
                    ? 'warning'
                    : 'info'
                }
                showIcon
                message={`${detail.caseInfo.caseTypeText} / ${detail.caseInfo.caseStatusText}`}
                description={detail.caseInfo.latestResult ?? detail.caseInfo.reason}
              />

              <Card title="基础信息" bordered={false}>
                <Descriptions column={2} size="small">
                  <Descriptions.Item label="售后单号">{detail.caseInfo.caseNo}</Descriptions.Item>
                  <Descriptions.Item label="订单号">{detail.caseInfo.orderNo}</Descriptions.Item>
                  <Descriptions.Item label="类型">
                    <Tag color={caseTypeColor(detail.caseInfo.caseType)}>{detail.caseInfo.caseTypeText}</Tag>
                  </Descriptions.Item>
                  <Descriptions.Item label="状态">
                    <Tag color={caseStatusColor(detail.caseInfo.caseStatus)}>{detail.caseInfo.caseStatusText}</Tag>
                  </Descriptions.Item>
                  <Descriptions.Item label="优先级">
                    <Tag color={priorityColor(detail.caseInfo.priority)}>{detail.caseInfo.priorityText}</Tag>
                  </Descriptions.Item>
                  <Descriptions.Item label="截止时间">{detail.caseInfo.deadlineAt}</Descriptions.Item>
                  <Descriptions.Item label="原因" span={2}>
                    {detail.caseInfo.reason}
                  </Descriptions.Item>
                </Descriptions>
              </Card>

              <Card title="订单与履约" bordered={false}>
                <Descriptions column={2} size="small">
                  <Descriptions.Item label="商品">{detail.order.productName}</Descriptions.Item>
                  <Descriptions.Item label="客户">{detail.order.customerName}</Descriptions.Item>
                  <Descriptions.Item label="店铺">{detail.order.storeName}</Descriptions.Item>
                  <Descriptions.Item label="支付金额">{formatCurrency(detail.order.paidAmount)}</Descriptions.Item>
                  <Descriptions.Item label="订单主状态">{detail.order.mainStatusText}</Descriptions.Item>
                  <Descriptions.Item label="发货状态">{detail.order.deliveryStatusText}</Descriptions.Item>
                  <Descriptions.Item label="当前退款金额">{formatCurrency(detail.order.refundAmount)}</Descriptions.Item>
                  <Descriptions.Item label="售后状态">{detail.order.afterSaleStatus}</Descriptions.Item>
                  {detail.fulfillment ? (
                    <>
                      <Descriptions.Item label="履约类型">{detail.fulfillment.typeText}</Descriptions.Item>
                      <Descriptions.Item label="履约队列">{detail.fulfillment.queueText}</Descriptions.Item>
                      <Descriptions.Item label="履约阶段" span={2}>
                        {detail.fulfillment.stage}，{detail.fulfillment.stageDetail}
                      </Descriptions.Item>
                      <Descriptions.Item label="最新出库单">{detail.fulfillment.latestOutboundNo ?? '-'}</Descriptions.Item>
                      <Descriptions.Item label="最新任务号">{detail.fulfillment.latestTaskNo ?? '-'}</Descriptions.Item>
                    </>
                  ) : null}
                </Descriptions>
              </Card>

              {detail.refund ? (
                <Card
                  title="退款处理"
                  bordered={false}
                  extra={
                    canManageCurrentAfterSale ? (
                      <Space wrap>
                        {detail.refund.refundStatus === 'pending_review' ? (
                          <>
                            <Button size="small" onClick={() => void runAfterSaleAction(detail.caseInfo.id, 'refundApprove')}>
                              通过退款
                            </Button>
                            <Button size="small" onClick={() => void runAfterSaleAction(detail.caseInfo.id, 'refundReject')}>
                              驳回退款
                            </Button>
                          </>
                        ) : null}
                        {detail.refund.refundStatus === 'approved' ? (
                          <Button size="small" type="primary" onClick={() => void runAfterSaleAction(detail.caseInfo.id, 'refundComplete')}>
                            确认退款
                          </Button>
                        ) : null}
                        <Button size="small" onClick={() => void runAfterSaleAction(detail.caseInfo.id, 'note')}>
                          备注
                        </Button>
                      </Space>
                    ) : null
                  }
                >
                  <Descriptions column={2} size="small">
                    <Descriptions.Item label="申请金额">{formatCurrency(detail.refund.requestedAmount)}</Descriptions.Item>
                    <Descriptions.Item label="退款状态">{detail.refund.refundStatusText}</Descriptions.Item>
                    <Descriptions.Item label="通过金额">{formatCurrency(detail.refund.approvedAmount)}</Descriptions.Item>
                  </Descriptions>
                </Card>
              ) : null}

              {detail.resend ? (
                <Card
                  title="补发处理"
                  bordered={false}
                  extra={
                    canManageCurrentAfterSale ? (
                      <Space wrap>
                        {detail.resend.resendStatus === 'requested' ? (
                          <>
                            <Button size="small" onClick={() => void runAfterSaleAction(detail.caseInfo.id, 'resendApprove')}>
                              通过补发
                            </Button>
                            <Button size="small" onClick={() => void runAfterSaleAction(detail.caseInfo.id, 'resendReject')}>
                              驳回补发
                            </Button>
                          </>
                        ) : null}
                        {['approved', 'failed'].includes(detail.resend.resendStatus) ? (
                          <>
                            <Button size="small" type="primary" onClick={() => void runAfterSaleAction(detail.caseInfo.id, 'resendExecute')}>
                              执行补发
                            </Button>
                            <Button size="small" onClick={() => void runAfterSaleAction(detail.caseInfo.id, 'resendFail')}>
                              标记失败
                            </Button>
                          </>
                        ) : null}
                        <Button size="small" onClick={() => void runAfterSaleAction(detail.caseInfo.id, 'note')}>
                          备注
                        </Button>
                      </Space>
                    ) : null
                  }
                >
                  <Descriptions column={2} size="small">
                    <Descriptions.Item label="补发状态">{detail.resend.resendStatusText}</Descriptions.Item>
                    <Descriptions.Item label="履约类型">{detail.resend.fulfillmentType ?? '-'}</Descriptions.Item>
                    <Descriptions.Item label="关联出库单">{detail.resend.relatedOutboundNo ?? '-'}</Descriptions.Item>
                    <Descriptions.Item label="关联任务号">{detail.resend.relatedTaskNo ?? '-'}</Descriptions.Item>
                  </Descriptions>
                </Card>
              ) : null}

              {detail.dispute ? (
                <Card
                  title="争议处理"
                  bordered={false}
                  extra={
                    canManageCurrentAfterSale ? (
                      <Space wrap>
                        {['open', 'processing'].includes(detail.dispute.disputeStatus) ? (
                          <>
                            <Button size="small" onClick={() => void runAfterSaleAction(detail.caseInfo.id, 'disputeBuyer')}>
                              支持买家
                            </Button>
                            <Button size="small" onClick={() => void runAfterSaleAction(detail.caseInfo.id, 'disputeSeller')}>
                              支持卖家
                            </Button>
                            <Button size="small" onClick={() => void runAfterSaleAction(detail.caseInfo.id, 'disputeRefund')}>
                              转退款
                            </Button>
                            <Button size="small" onClick={() => void runAfterSaleAction(detail.caseInfo.id, 'disputeResend')}>
                              转补发
                            </Button>
                          </>
                        ) : null}
                        <Button size="small" onClick={() => void runAfterSaleAction(detail.caseInfo.id, 'note')}>
                          备注
                        </Button>
                      </Space>
                    ) : null
                  }
                >
                  <Descriptions column={2} size="small">
                    <Descriptions.Item label="争议状态">{detail.dispute.disputeStatusText}</Descriptions.Item>
                    <Descriptions.Item label="补偿金额">{formatCurrency(detail.dispute.compensationAmount)}</Descriptions.Item>
                  </Descriptions>
                </Card>
              ) : null}

              <Row gutter={[16, 16]}>
                <Col xs={24} xl={12}>
                  <Card title="提醒记录" bordered={false}>
                    <Table
                      rowKey="id"
                      pagination={false}
                      size="small"
                      columns={[
                        {
                          title: '类型',
                          dataIndex: 'reminderTypeText',
                          width: 110,
                          render: (value: string, record: AfterSaleDetailResponse['reminders'][number]) => (
                            <Tag color={reminderColor(record.reminderType)}>{value}</Tag>
                          ),
                        },
                        {
                          title: '内容',
                          dataIndex: 'detail',
                          render: (_value: string, record: AfterSaleDetailResponse['reminders'][number]) => (
                            <Space direction="vertical" size={0}>
                              <Typography.Text>{record.title}</Typography.Text>
                              <Typography.Text type="secondary">{record.detail}</Typography.Text>
                            </Space>
                          ),
                        },
                      ]}
                      dataSource={detail.reminders}
                      locale={{ emptyText: <Empty description="暂无提醒" image={Empty.PRESENTED_IMAGE_SIMPLE} /> }}
                    />
                  </Card>
                </Col>
                <Col xs={24} xl={12}>
                  <Card title="履约记录" bordered={false}>
                    <Space direction="vertical" size={12} style={{ width: '100%' }}>
                      {detail.artifacts.cardOutbounds.length > 0 ? (
                        <Descriptions column={1} size="small" title="卡密出库">
                          {detail.artifacts.cardOutbounds.map((item) => (
                            <Descriptions.Item key={item.outboundNo} label={item.outboundNo}>
                              {item.outboundStatus} / {item.createdAt}
                            </Descriptions.Item>
                          ))}
                        </Descriptions>
                      ) : null}
                      {detail.artifacts.directJobs.length > 0 ? (
                        <Descriptions column={1} size="small" title="直充任务">
                          {detail.artifacts.directJobs.map((item) => (
                            <Descriptions.Item key={item.taskNo} label={item.taskNo}>
                              {item.taskStatus}
                              {item.supplierOrderNo ? ` / ${item.supplierOrderNo}` : ''}
                            </Descriptions.Item>
                          ))}
                        </Descriptions>
                      ) : null}
                      {detail.artifacts.cardOutbounds.length === 0 &&
                      detail.artifacts.directJobs.length === 0 ? (
                        <Empty description="暂无履约记录" image={Empty.PRESENTED_IMAGE_SIMPLE} />
                      ) : null}
                    </Space>
                  </Card>
                </Col>
              </Row>

              <Card title="处理记录" bordered={false}>
                <Timeline
                  items={detail.records.map((item) => ({
                    color: 'blue',
                    children: (
                      <Space direction="vertical" size={0}>
                        <Space wrap>
                          <Typography.Text strong>{item.title}</Typography.Text>
                          <Typography.Text type="secondary">{item.createdAt}</Typography.Text>
                        </Space>
                        <Typography.Text>{item.detail}</Typography.Text>
                        {item.operatorName ? (
                          <Typography.Text type="secondary">操作人：{item.operatorName}</Typography.Text>
                        ) : null}
                      </Space>
                    ),
                  }))}
                />
              </Card>
            </Space>
          ) : (
            <Empty description="未选择售后单" image={Empty.PRESENTED_IMAGE_SIMPLE} />
          )}
        </Drawer>
      </div>
    </PageContainer>
  );
}
