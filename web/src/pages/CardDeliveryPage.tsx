import { ReloadOutlined } from '@ant-design/icons';
import { PageContainer } from '@ant-design/pro-components';
import { Alert, Button, Card, Skeleton, Table, Tag, Typography, message } from 'antd';
import type { TableProps } from 'antd';
import { useCallback, useMemo, useState } from 'react';

import { apiRequest } from '../api';
import type { CardDeliveryDetailResponse, WorkspaceOverviewResponse } from '../api';
import { useRemoteData } from '../hooks/useRemoteData';
import { formatNumber, formatCurrency } from '../utils';
import { SummaryCards } from '../components/SummaryCards';

interface PageData {
  overview: WorkspaceOverviewResponse;
  detail: CardDeliveryDetailResponse;
}

const jobStatusMap: Record<string, { color: string; text: string }> = {
  pending: { color: 'default', text: '待执行' },
  success: { color: 'success', text: '成功' },
  failed: { color: 'error', text: '失败' },
  recycled: { color: 'warning', text: '已回收' },
};

export function CardDeliveryPage() {
  const [messageApi, contextHolder] = message.useMessage();
  const [activeTab, setActiveTab] = useState<'delivery' | 'jobs' | 'alerts'>('delivery');

  const loader = useCallback(async () => {
    const [overview, detail] = await Promise.all([
      apiRequest<WorkspaceOverviewResponse>('/api/workspaces/card-delivery', undefined),
      apiRequest<CardDeliveryDetailResponse>('/api/workspaces/card-delivery/detail', undefined),
    ]);
    return { overview, detail } as PageData;
  }, []);

  const { data, loading, error, reload } = useRemoteData<PageData>(loader);

  const summary = useMemo(() => {
    if (!data?.detail?.metrics) return [];
    return data.detail.metrics.map((m, i) => ({
      key: `metric-${i}`,
      label: m.label,
      value: typeof m.value === 'string' ? parseFloat(m.value) || 0 : m.value,
      unit: m.unit,
    }));
  }, [data]);

  const handleToggleDelivery = useCallback(
    async (id: number) => {
      try {
        await apiRequest(
          `/api/workspaces/card-delivery/delivery-items/${id}/toggle`,
          { method: 'POST', body: '{}' },
        );
        messageApi.success('发货设置已更新');
        await reload();
      } catch (err) {
        messageApi.error(err instanceof Error ? err.message : '操作失败');
      }
    },
    [messageApi, reload],
  );

  const handleRunJob = useCallback(
    async (jobId: number) => {
      try {
        await apiRequest(
          `/api/workspaces/card-delivery/jobs/${jobId}/run`,
          { method: 'POST', body: '{}' },
        );
        messageApi.success('发货任务已执行');
        await reload();
      } catch (err) {
        messageApi.error(err instanceof Error ? err.message : '操作失败');
      }
    },
    [messageApi, reload],
  );

  // 发货绑定表
  const deliveryColumns = useMemo<TableProps<CardDeliveryDetailResponse['rows'][number]>['columns']>(
    () => [
      {
        title: '商品',
        dataIndex: 'productTitle',
        width: 200,
        ellipsis: true,
      },
      {
        title: '店铺',
        dataIndex: 'storeName',
        width: 120,
      },
      {
        title: '卡种',
        dataIndex: 'cardTypeName',
        width: 120,
      },
      {
        title: '发货策略',
        dataIndex: 'deliveryPolicy',
        width: 110,
        render: (val: string) => <Tag color="blue">{val}</Tag>,
      },
      {
        title: '可用',
        dataIndex: 'availableCount',
        width: 80,
        render: (val: number, row) => (
          <Tag color={row.lowStock ? 'error' : val > 0 ? 'success' : 'default'}>
            {formatNumber(val, '')}
          </Tag>
        ),
      },
      {
        title: '已售',
        dataIndex: 'soldCount',
        width: 80,
        render: (val: number) => formatNumber(val, ''),
      },
      {
        title: '售价',
        dataIndex: 'salePrice',
        width: 90,
        render: (val: number) => formatCurrency(val),
      },
      {
        title: '状态',
        dataIndex: 'enabled',
        width: 80,
        render: (val: boolean) => <Tag color={val ? 'processing' : 'default'}>{val ? '启用' : '停用'}</Tag>,
      },
      {
        title: '操作',
        key: 'action',
        fixed: 'right',
        width: 100,
        render: (_val: unknown, row) => (
          <Button size="small" type="link" onClick={() => void handleToggleDelivery(row.id)}>
            {row.enabled ? '停用' : '启用'}
          </Button>
        ),
      },
    ],
    [handleToggleDelivery],
  );

  // 发货任务表
  const jobColumns = useMemo<TableProps<CardDeliveryDetailResponse['jobs'][number]>['columns']>(
    () => [
      {
        title: '订单号',
        dataIndex: 'orderNo',
        width: 160,
      },
      {
        title: '商品',
        dataIndex: 'productTitle',
        width: 180,
        ellipsis: true,
      },
      {
        title: '卡种',
        dataIndex: 'cardTypeName',
        width: 120,
      },
      {
        title: '类型',
        dataIndex: 'jobType',
        width: 100,
      },
      {
        title: '状态',
        dataIndex: 'jobStatus',
        width: 100,
        render: (val: string) => {
          const s = jobStatusMap[val] ?? { color: 'default', text: val };
          return <Tag color={s.color}>{s.text}</Tag>;
        },
      },
      {
        title: '重试',
        dataIndex: 'attemptCount',
        width: 60,
      },
      {
        title: '出库单号',
        dataIndex: 'latestOutboundNo',
        width: 160,
        render: (val: string | null) => val ?? '-',
      },
      {
        title: '错误',
        dataIndex: 'errorMessage',
        width: 180,
        ellipsis: true,
        render: (val: string | null) => val ? <Typography.Text type="danger">{val}</Typography.Text> : '-',
      },
      {
        title: '操作',
        key: 'action',
        fixed: 'right',
        width: 100,
        render: (_val: unknown, row) => (
          row.jobStatus === 'failed' ? (
            <Button size="small" type="link" onClick={() => void handleRunJob(row.id)}>重试</Button>
          ) : (
            <Button size="small" type="link" onClick={() => void handleRunJob(row.id)}>执行</Button>
          )
        ),
      },
    ],
    [handleRunJob],
  );

  // 低库存告警表
  const alertColumns = useMemo<TableProps<CardDeliveryDetailResponse['alerts'][number]>['columns']>(
    () => [
      { title: '卡种', dataIndex: 'cardTypeName', width: 150 },
      {
        title: '当前库存',
        dataIndex: 'currentStock',
        width: 100,
        render: (val: number) => <Tag color={val === 0 ? 'error' : 'warning'}>{formatNumber(val, ' 张')}</Tag>,
      },
      { title: '阈值', dataIndex: 'thresholdValue', width: 80 },
      { title: '详情', dataIndex: 'detail', ellipsis: true },
      { title: '时间', dataIndex: 'updatedAt', width: 160 },
    ],
    [],
  );

  const tabList = [
    { key: 'delivery', tab: `发货绑定 (${data?.detail.rows.length ?? 0})` },
    { key: 'jobs', tab: `发货任务 (${data?.detail.jobs.length ?? 0})` },
    { key: 'alerts', tab: `库存告警 (${data?.detail.alerts.length ?? 0})` },
  ];

  return (
    <PageContainer
      title="发货管理"
      subTitle="跟踪卡密发货任务、配置交付绑定规则、处理失败重试与低库存告警。"
      style={{ paddingInline: 0 }}
      extra={[
        <Button key="refresh" icon={<ReloadOutlined />} onClick={() => void reload()}>刷新</Button>,
      ]}
    >
      {contextHolder}
      <div className="page-grid">
        <Alert
          type="info"
          showIcon
          message="自动发货流程"
          description="当订单支付后，系统根据发货绑定配置自动匹配卡种并执行发货任务。失败的任务会自动重试，超过最大重试次数后转入人工处理。"
        />

        {error && <Alert type="error" showIcon message={error} />}

        {loading || !data ? (
          <Skeleton active paragraph={{ rows: 10 }} />
        ) : (
          <>
            {summary.length > 0 && <SummaryCards items={summary} />}

            <Card
              className="glass-panel"
              bordered={false}
              tabList={tabList}
              activeTabKey={activeTab}
              onTabChange={(key) => setActiveTab(key as 'delivery' | 'jobs' | 'alerts')}
            >
              {activeTab === 'delivery' && (
                <Table
                  rowKey="id"
                  dataSource={data.detail.rows}
                  columns={deliveryColumns}
                  pagination={{ pageSize: 12 }}
                  scroll={{ x: 1200 }}
                  size="middle"
                />
              )}
              {activeTab === 'jobs' && (
                <Table
                  rowKey="id"
                  dataSource={data.detail.jobs}
                  columns={jobColumns}
                  pagination={{ pageSize: 12 }}
                  scroll={{ x: 1200 }}
                  size="middle"
                />
              )}
              {activeTab === 'alerts' && (
                <Table
                  rowKey="id"
                  dataSource={data.detail.alerts}
                  columns={alertColumns}
                  pagination={{ pageSize: 12 }}
                  size="middle"
                />
              )}
            </Card>
          </>
        )}
      </div>
    </PageContainer>
  );
}
