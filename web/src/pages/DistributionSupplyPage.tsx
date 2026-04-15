import { ReloadOutlined, DeploymentUnitOutlined } from '@ant-design/icons';
import { PageContainer } from '@ant-design/pro-components';
import { Alert, Button, Card, Skeleton, Table, Tag, Typography } from 'antd';
import type { TableProps } from 'antd';
import { useCallback, useMemo, useState } from 'react';

import { apiRequest } from '../api';
import type { DistributionSupplyDetailResponse, WorkspaceOverviewResponse } from '../api';
import { useRemoteData } from '../hooks/useRemoteData';
import { SummaryCards } from '../components/SummaryCards';
import { formatCurrency } from '../utils';

interface PageData {
  overview: WorkspaceOverviewResponse;
  detail: DistributionSupplyDetailResponse;
}

const taskStatusMap: Record<string, { color: string; text: string }> = {
  pending_dispatch: { color: 'default', text: '待分发' },
  processing: { color: 'processing', text: '处理中' },
  success: { color: 'success', text: '成功' },
  failed: { color: 'error', text: '失败' },
  manual_review: { color: 'warning', text: '人工审核' },
};

export function DistributionSupplyPage() {
  const [activeTab, setActiveTab] = useState<string>('jobs');

  const loader = useCallback(async () => {
    const [overview, detail] = await Promise.all([
      apiRequest<WorkspaceOverviewResponse>('/api/workspaces/distribution-supply', undefined),
      apiRequest<DistributionSupplyDetailResponse>('/api/workspaces/distribution-supply/detail', undefined),
    ]);
    return { overview, detail } as PageData;
  }, []);

  const { data, loading, error, reload } = useRemoteData<PageData>(loader);

  const summary = useMemo(() => {
    if (!data?.detail?.metrics) return [];
    return data.detail.metrics.map((m, i) => ({
      key: `metric-${i}`, label: m.label,
      value: typeof m.value === 'string' ? parseFloat(m.value) || 0 : m.value, unit: m.unit,
    }));
  }, [data]);

  const jobColumns = useMemo<TableProps<DistributionSupplyDetailResponse['jobs'][number]>['columns']>(
    () => [
      { title: '任务号', dataIndex: 'taskNo', width: 140 },
      { title: '订单号', dataIndex: 'orderNo', width: 140 },
      { title: '商品', dataIndex: 'productTitle', width: 180, ellipsis: true },
      { title: '供应商', dataIndex: 'supplierName', width: 120 },
      { title: '面值', dataIndex: 'faceValue', width: 80, render: (v: number) => formatCurrency(v) },
      { title: '目标账号', dataIndex: 'targetAccount', width: 140 },
      { title: '状态', dataIndex: 'taskStatus', width: 90, render: (v: string) => { const s = taskStatusMap[v] ?? { color: 'default', text: v }; return <Tag color={s.color}>{s.text}</Tag>; } },
      { title: '重试', dataIndex: 'retryCount', width: 60 },
      { title: '错误', dataIndex: 'errorMessage', width: 160, ellipsis: true, render: (v: string | null) => v ? <Typography.Text type="danger">{v}</Typography.Text> : '-' },
    ],
    [],
  );

  const callbackColumns = useMemo<TableProps<DistributionSupplyDetailResponse['callbacks'][number]>['columns']>(
    () => [
      { title: '回调号', dataIndex: 'callbackNo', width: 140 },
      { title: '供应商', dataIndex: 'supplierName', width: 120 },
      { title: '任务号', dataIndex: 'taskNo', width: 140 },
      { title: '供应商状态', dataIndex: 'supplierStatus', width: 100 },
      { title: '校验', dataIndex: 'verificationStatus', width: 80, render: (v: string) => <Tag color={v === 'passed' ? 'success' : v === 'failed' ? 'error' : 'default'}>{v}</Tag> },
      { title: '详情', dataIndex: 'detail', ellipsis: true },
      { title: '接收时间', dataIndex: 'receivedAt', width: 160 },
    ],
    [],
  );

  const reconcileColumns = useMemo<TableProps<DistributionSupplyDetailResponse['reconciliations'][number]>['columns']>(
    () => [
      { title: '订单号', dataIndex: 'orderNo', width: 140 },
      { title: '供应商', dataIndex: 'supplierName', width: 120 },
      { title: '对账状态', dataIndex: 'reconcileStatus', width: 100, render: (v: string) => <Tag color={v === 'matched' ? 'success' : v === 'anomaly' ? 'error' : 'default'}>{v}</Tag> },
      { title: '详情', dataIndex: 'detail', ellipsis: true },
      { title: '更新时间', dataIndex: 'updatedAt', width: 160 },
    ],
    [],
  );

  const tabList = [
    { key: 'jobs', tab: `供货任务 (${data?.detail.jobs.length ?? 0})` },
    { key: 'callbacks', tab: `回调记录 (${data?.detail.callbacks.length ?? 0})` },
    { key: 'reconcile', tab: `对账 (${data?.detail.reconciliations.length ?? 0})` },
  ];

  return (
    <PageContainer title="供货管理" subTitle="管理供货商品、供货价格和对账进度。" style={{ paddingInline: 0 }}
      extra={[<Button key="refresh" icon={<ReloadOutlined />} onClick={() => void reload()}>刷新</Button>]}
    >
      <div className="page-grid">
        <Alert type="info" showIcon icon={<DeploymentUnitOutlined />} message="供货流程说明" description="订单自动分发至供应商处理，系统通过回调和对账机制确保交付闭环。" />
        {error && <Alert type="error" showIcon message={error} />}
        {loading || !data ? <Skeleton active paragraph={{ rows: 10 }} /> : (
          <>
            {summary.length > 0 && <SummaryCards items={summary} />}
            <Card className="glass-panel" bordered={false} tabList={tabList} activeTabKey={activeTab} onTabChange={setActiveTab}>
              {activeTab === 'jobs' && <Table rowKey="id" dataSource={data.detail.jobs} columns={jobColumns} pagination={{ pageSize: 12 }} scroll={{ x: 1200 }} size="middle" />}
              {activeTab === 'callbacks' && <Table rowKey="id" dataSource={data.detail.callbacks} columns={callbackColumns} pagination={{ pageSize: 12 }} scroll={{ x: 900 }} size="middle" />}
              {activeTab === 'reconcile' && <Table rowKey="id" dataSource={data.detail.reconciliations} columns={reconcileColumns} pagination={{ pageSize: 12 }} size="middle" />}
            </Card>
          </>
        )}
      </div>
    </PageContainer>
  );
}
