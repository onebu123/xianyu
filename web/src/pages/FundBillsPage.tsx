import { ReloadOutlined, BankOutlined } from '@ant-design/icons';
import { PageContainer } from '@ant-design/pro-components';
import { Alert, Button, Skeleton, Table, Tag, Typography } from 'antd';
import type { TableProps } from 'antd';
import { useCallback, useMemo } from 'react';

import { apiRequest } from '../api';
import type { FundBillsDetailResponse, WorkspaceOverviewResponse } from '../api';
import { useRemoteData } from '../hooks/useRemoteData';
import { SummaryCards } from '../components/SummaryCards';
import { formatCurrency } from '../utils';

interface PageData {
  overview: WorkspaceOverviewResponse;
  detail: FundBillsDetailResponse;
}

export function FundBillsPage() {

  const loader = useCallback(async () => {
    const [overview, detail] = await Promise.all([
      apiRequest<WorkspaceOverviewResponse>('/api/workspaces/fund-bills', undefined),
      apiRequest<FundBillsDetailResponse>('/api/workspaces/fund-bills/detail', undefined),
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

  const columns = useMemo<TableProps<FundBillsDetailResponse['rows'][number]>['columns']>(
    () => [
      { title: '流水号', dataIndex: 'billNo', width: 160 },
      { title: '类型', dataIndex: 'billCategoryText', width: 100, render: (v: string) => <Tag color="blue">{v}</Tag> },
      { title: '交易方式', dataIndex: 'tradeType', width: 100 },
      { title: '金额', dataIndex: 'amount', width: 120, render: (v: number) => <Typography.Text type={v >= 0 ? 'success' : 'danger'}>{formatCurrency(v)}</Typography.Text> },
      { title: '余额', dataIndex: 'balanceAfter', width: 100, render: (v: number | null) => v != null ? formatCurrency(v) : '-' },
      { title: '商户单号', dataIndex: 'merchantOrderNo', width: 140, ellipsis: true },
      { title: '店铺', dataIndex: 'storeName', width: 120, render: (v: string | null) => v ?? '全局' },
      { title: '备注', dataIndex: 'remark', ellipsis: true },
      { title: '时间', dataIndex: 'tradeTime', width: 160 },
    ],
    [],
  );

  return (
    <PageContainer title="资金账单" subTitle="核对流水、对账单和账务异常。" style={{ paddingInline: 0 }}
      extra={[<Button key="refresh" icon={<ReloadOutlined />} onClick={() => void reload()}>刷新</Button>]}
    >
      <div className="page-grid">
        <Alert type="info" showIcon icon={<BankOutlined />} message="账单说明" description="系统自动记录每笔资金变动，支持按类型、方向、时间范围筛选对账。" />
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
