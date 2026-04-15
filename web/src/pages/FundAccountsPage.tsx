import { ReloadOutlined, WalletOutlined } from '@ant-design/icons';
import { PageContainer } from '@ant-design/pro-components';
import { Alert, Button, Skeleton, Table, Tag, Typography } from 'antd';
import type { TableProps } from 'antd';
import { useCallback, useMemo } from 'react';

import { apiRequest } from '../api';
import type { FundAccountsDetailResponse, WorkspaceOverviewResponse } from '../api';
import { useRemoteData } from '../hooks/useRemoteData';
import { SummaryCards } from '../components/SummaryCards';
import { formatCurrency } from '../utils';

interface PageData {
  overview: WorkspaceOverviewResponse;
  detail: FundAccountsDetailResponse;
}

export function FundAccountsPage() {

  const loader = useCallback(async () => {
    const [overview, detail] = await Promise.all([
      apiRequest<WorkspaceOverviewResponse>('/api/workspaces/fund-accounts', undefined),
      apiRequest<FundAccountsDetailResponse>('/api/workspaces/fund-accounts/detail', undefined),
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

  const columns = useMemo<TableProps<FundAccountsDetailResponse['settlements'][number]>['columns']>(
    () => [
      { title: '结算单号', dataIndex: 'settlementNo', width: 160 },
      { title: '订单号', dataIndex: 'orderNo', width: 140 },
      { title: '店铺', dataIndex: 'storeName', width: 120, render: (v: string) => v ?? '全局' },
      { title: '到账金额', dataIndex: 'receivedAmount', width: 120, render: (v: number) => <Typography.Text strong>{formatCurrency(v)}</Typography.Text> },
      { title: '手续费', dataIndex: 'feeAmount', width: 100, render: (v: number) => formatCurrency(v) },
      { title: '结算金额', dataIndex: 'settledAmount', width: 120, render: (v: number) => <Typography.Text type="success">{formatCurrency(v)}</Typography.Text> },
      { title: '状态', dataIndex: 'settlementStatusText', width: 90, render: (v: string) => <Tag color={v === '已结算' ? 'success' : 'warning'}>{v}</Tag> },
      { title: '结算时间', dataIndex: 'settledAt', width: 160 },
    ],
    [],
  );

  return (
    <PageContainer title="资金账户" subTitle="查看可用余额、冻结资金和账户状态。" style={{ paddingInline: 0 }}
      extra={[<Button key="refresh" icon={<ReloadOutlined />} onClick={() => void reload()}>刷新</Button>]}
    >
      <div className="page-grid">
        <Alert type="info" showIcon icon={<WalletOutlined />} message="账户说明" description="资金账户展示各店铺的余额快照和资金流向，数据每小时自动同步。" />
        {error && <Alert type="error" showIcon message={error} />}
        {loading || !data ? <Skeleton active paragraph={{ rows: 8 }} /> : (
          <>
            {summary.length > 0 && <SummaryCards items={summary} />}
            <div className="glass-panel" style={{ padding: 24 }}>
              <Table rowKey="id" dataSource={data.detail.settlements} columns={columns} pagination={{ pageSize: 15 }} size="middle" />
            </div>
          </>
        )}
      </div>
    </PageContainer>
  );
}
