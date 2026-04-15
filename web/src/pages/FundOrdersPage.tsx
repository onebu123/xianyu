import { ReloadOutlined, AppstoreOutlined } from '@ant-design/icons';
import { PageContainer } from '@ant-design/pro-components';
import { Alert, Button, Skeleton, Table, Typography } from 'antd';
import type { TableProps } from 'antd';
import { useCallback, useMemo } from 'react';

import { apiRequest } from '../api';
import type { FundOrdersDetailResponse, WorkspaceOverviewResponse } from '../api';
import { useRemoteData } from '../hooks/useRemoteData';
import { SummaryCards } from '../components/SummaryCards';
import { formatCurrency } from '../utils';

interface PageData {
  overview: WorkspaceOverviewResponse;
  detail: FundOrdersDetailResponse;
}

export function FundOrdersPage() {

  const loader = useCallback(async () => {
    const [overview, detail] = await Promise.all([
      apiRequest<WorkspaceOverviewResponse>('/api/workspaces/fund-orders', undefined),
      apiRequest<FundOrdersDetailResponse>('/api/workspaces/fund-orders/detail', undefined),
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

  const columns = useMemo<TableProps<FundOrdersDetailResponse['rows'][number]>['columns']>(
    () => [
      { title: '订购项', dataIndex: 'orderItem', width: 160 },
      { title: '内容', dataIndex: 'orderContent', width: 180, ellipsis: true },
      { title: '周期', dataIndex: 'cycleText', width: 100 },
      { title: '金额', dataIndex: 'paidAmount', width: 100, render: (v: number) => <Typography.Text strong>{formatCurrency(v)}</Typography.Text> },
      { title: '店铺', dataIndex: 'storeName', width: 120, render: (v: string | null) => v ?? '全局' },
      { title: '商户单号', dataIndex: 'merchantOrderNo', width: 160, ellipsis: true },
      { title: '支付单号', dataIndex: 'paymentNo', width: 160, ellipsis: true },
      { title: '支付时间', dataIndex: 'paidAt', width: 160 },
    ],
    [],
  );

  return (
    <PageContainer title="订购管理" subTitle="管理套餐订购、续费计划和服务周期。" style={{ paddingInline: 0 }}
      extra={[<Button key="refresh" icon={<ReloadOutlined />} onClick={() => void reload()}>刷新</Button>]}
    >
      <div className="page-grid">
        <Alert type="info" showIcon icon={<AppstoreOutlined />} message="订购说明" description="在此查看已订购的增值服务、套餐续费记录和当前服务有效期。" />
        {error && <Alert type="error" showIcon message={error} />}
        {loading || !data ? <Skeleton active paragraph={{ rows: 8 }} /> : (
          <>
            {summary.length > 0 && <SummaryCards items={summary} />}
            <div className="glass-panel" style={{ padding: 24 }}>
              <Table rowKey="id" dataSource={data.detail.rows} columns={columns} pagination={{ pageSize: 15 }} scroll={{ x: 1100 }} size="middle" />
            </div>
          </>
        )}
      </div>
    </PageContainer>
  );
}
