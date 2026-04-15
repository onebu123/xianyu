import { ReloadOutlined, DollarOutlined } from '@ant-design/icons';
import { PageContainer } from '@ant-design/pro-components';
import { Alert, Button, Skeleton, Table, Tag, Typography } from 'antd';
import type { TableProps } from 'antd';
import { useCallback, useMemo } from 'react';

import { apiRequest } from '../api';
import type { FundWithdrawalsDetailResponse, WorkspaceOverviewResponse } from '../api';
import { useRemoteData } from '../hooks/useRemoteData';
import { SummaryCards } from '../components/SummaryCards';
import { formatCurrency } from '../utils';

interface PageData {
  overview: WorkspaceOverviewResponse;
  detail: FundWithdrawalsDetailResponse;
}

const statusMap: Record<string, { color: string }> = {
  待审批: { color: 'processing' },
  已通过: { color: 'success' },
  已拒绝: { color: 'error' },
  已到账: { color: 'success' },
  处理中: { color: 'processing' },
};

export function FundWithdrawalsPage() {

  const loader = useCallback(async () => {
    const [overview, detail] = await Promise.all([
      apiRequest<WorkspaceOverviewResponse>('/api/workspaces/fund-withdrawals', undefined),
      apiRequest<FundWithdrawalsDetailResponse>('/api/workspaces/fund-withdrawals/detail', undefined),
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

  const columns = useMemo<TableProps<FundWithdrawalsDetailResponse['rows'][number]>['columns']>(
    () => [
      { title: '提现单号', dataIndex: 'withdrawalNo', width: 160 },
      { title: '金额', dataIndex: 'amount', width: 100, render: (v: number) => <Typography.Text strong>{formatCurrency(v)}</Typography.Text> },
      { title: '状态', dataIndex: 'status', width: 90, render: (v: string) => <Tag color={statusMap[v]?.color ?? 'default'}>{v}</Tag> },
      { title: '方式', dataIndex: 'method', width: 80 },
      { title: '收款账号', dataIndex: 'receivingAccount', width: 160, ellipsis: true },
      { title: '审核备注', dataIndex: 'reviewRemark', ellipsis: true, render: (v: string) => v || '-' },
      { title: '申请时间', dataIndex: 'createdAt', width: 160 },
      { title: '完成时间', dataIndex: 'finishedAt', width: 160, render: (v: string | null) => v ?? '-' },
    ],
    [],
  );

  return (
    <PageContainer title="提现管理" subTitle="处理提现申请、到账进度和审批记录。" style={{ paddingInline: 0 }}
      extra={[<Button key="refresh" icon={<ReloadOutlined />} onClick={() => void reload()}>刷新</Button>]}
    >
      <div className="page-grid">
        <Alert type="info" showIcon icon={<DollarOutlined />} message="提现流程" description="提交提现申请后，系统将进行审批流程，审批通过后自动转账至指定账户。" />
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
