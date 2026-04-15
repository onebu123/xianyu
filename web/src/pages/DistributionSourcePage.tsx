import { ReloadOutlined, GlobalOutlined } from '@ant-design/icons';
import { PageContainer } from '@ant-design/pro-components';
import { Alert, Button, Card, Skeleton, Table, Tag, Typography } from 'antd';
import type { TableProps } from 'antd';
import { useCallback, useMemo, useState } from 'react';

import { apiRequest } from '../api';
import type { DistributionSourceDetailResponse, WorkspaceOverviewResponse } from '../api';
import { useRemoteData } from '../hooks/useRemoteData';
import { SummaryCards } from '../components/SummaryCards';
import { formatCurrency } from '../utils';

interface PageData {
  overview: WorkspaceOverviewResponse;
  detail: DistributionSourceDetailResponse;
}

const supplierStatusMap: Record<string, { color: string; text: string }> = {
  online: { color: 'success', text: '在线' },
  warning: { color: 'warning', text: '警告' },
  offline: { color: 'default', text: '离线' },
};

export function DistributionSourcePage() {
  const [activeTab, setActiveTab] = useState<string>('suppliers');

  const loader = useCallback(async () => {
    const [overview, detail] = await Promise.all([
      apiRequest<WorkspaceOverviewResponse>('/api/workspaces/distribution-source', undefined),
      apiRequest<DistributionSourceDetailResponse>('/api/workspaces/distribution-source/detail', undefined),
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

  const supplierColumns = useMemo<TableProps<DistributionSourceDetailResponse['suppliers'][number]>['columns']>(
    () => [
      { title: '供应商', dataIndex: 'supplierName', width: 150 },
      { title: '适配器', dataIndex: 'adapterKey', width: 100, render: (v: string) => <Tag color="blue">{v}</Tag> },
      { title: '状态', dataIndex: 'supplierStatus', width: 80, render: (v: string) => { const s = supplierStatusMap[v] ?? { color: 'default', text: v }; return <Tag color={s.color}>{s.text}</Tag>; } },
      { title: '余额', dataIndex: 'balance', width: 100, render: (v: number) => formatCurrency(v) },
      { title: '成功率', dataIndex: 'successRate', width: 90, render: (v: number) => `${(v * 100).toFixed(1)}%` },
      { title: '商品数', dataIndex: 'itemCount', width: 80 },
      { title: '处理中', dataIndex: 'processingCount', width: 80 },
      { title: '异常', dataIndex: 'anomalyCount', width: 70, render: (v: number) => v > 0 ? <Typography.Text type="danger">{v}</Typography.Text> : v },
      { title: '启用', dataIndex: 'enabled', width: 70, render: (v: boolean) => <Tag color={v ? 'success' : 'default'}>{v ? '是' : '否'}</Tag> },
    ],
    [],
  );

  const itemColumns = useMemo<TableProps<DistributionSourceDetailResponse['items'][number]>['columns']>(
    () => [
      { title: '商品', dataIndex: 'productTitle', width: 200, ellipsis: true },
      { title: '供应商', dataIndex: 'supplierName', width: 120 },
      { title: '分类', dataIndex: 'category', width: 100 },
      { title: '面值', dataIndex: 'faceValue', width: 90, render: (v: number) => formatCurrency(v) },
      { title: '目标', dataIndex: 'targetType', width: 80 },
      { title: '状态', dataIndex: 'status', width: 80, render: (v: string) => <Tag>{v}</Tag> },
      { title: '启用', dataIndex: 'enabled', width: 70, render: (v: boolean) => <Tag color={v ? 'success' : 'default'}>{v ? '是' : '否'}</Tag> },
    ],
    [],
  );

  const sourceSystemColumns = useMemo<TableProps<DistributionSourceDetailResponse['sourceSystems'][number]>['columns']>(
    () => [
      { title: '系统名称', dataIndex: 'systemName', width: 150 },
      { title: '适配器', dataIndex: 'adapterKey', width: 100 },
      { title: '状态', dataIndex: 'systemStatus', width: 80, render: (v: string) => { const s = supplierStatusMap[v] ?? { color: 'default', text: v }; return <Tag color={s.color}>{s.text}</Tag>; } },
      { title: '同步模式', dataIndex: 'syncMode', width: 90 },
      { title: '映射数', dataIndex: 'mappingCount', width: 80 },
      { title: '异常', dataIndex: 'anomalyCount', width: 70, render: (v: number) => v > 0 ? <Typography.Text type="danger">{v}</Typography.Text> : v },
      { title: '启用', dataIndex: 'enabled', width: 70, render: (v: boolean) => <Tag color={v ? 'success' : 'default'}>{v ? '是' : '否'}</Tag> },
    ],
    [],
  );

  const tabList = [
    { key: 'suppliers', tab: `供应商 (${data?.detail.suppliers.length ?? 0})` },
    { key: 'items', tab: `商品池 (${data?.detail.items.length ?? 0})` },
    { key: 'systems', tab: `货源系统 (${data?.detail.sourceSystems.length ?? 0})` },
  ];

  return (
    <PageContainer title="找货管理" subTitle="维护货源池、选品规则和分销候选商品。" style={{ paddingInline: 0 }}
      extra={[<Button key="refresh" icon={<ReloadOutlined />} onClick={() => void reload()}>刷新</Button>]}
    >
      <div className="page-grid">
        <Alert type="info" showIcon icon={<GlobalOutlined />} message="找货说明" description="通过对接多个供应商和货源系统，自动匹配最优货源并管理商品池。" />
        {error && <Alert type="error" showIcon message={error} />}
        {loading || !data ? <Skeleton active paragraph={{ rows: 10 }} /> : (
          <>
            {summary.length > 0 && <SummaryCards items={summary} />}
            <Card className="glass-panel" bordered={false} tabList={tabList} activeTabKey={activeTab} onTabChange={setActiveTab}>
              {activeTab === 'suppliers' && <Table rowKey="id" dataSource={data.detail.suppliers} columns={supplierColumns} pagination={{ pageSize: 10 }} scroll={{ x: 1000 }} size="middle" />}
              {activeTab === 'items' && <Table rowKey="id" dataSource={data.detail.items} columns={itemColumns} pagination={{ pageSize: 12 }} scroll={{ x: 800 }} size="middle" />}
              {activeTab === 'systems' && <Table rowKey="id" dataSource={data.detail.sourceSystems} columns={sourceSystemColumns} pagination={{ pageSize: 10 }} scroll={{ x: 800 }} size="middle" />}
            </Card>
          </>
        )}
      </div>
    </PageContainer>
  );
}
