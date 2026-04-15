import { ReloadOutlined, SafetyOutlined } from '@ant-design/icons';
import { PageContainer } from '@ant-design/pro-components';
import { Alert, Button, Card, Skeleton, Table, Tag, Typography } from 'antd';
import type { TableProps } from 'antd';
import { useCallback, useMemo } from 'react';

import { apiRequest } from '../api';
import type { FundDepositDetailResponse, WorkspaceOverviewResponse } from '../api';
import { useRemoteData } from '../hooks/useRemoteData';
import { SummaryCards } from '../components/SummaryCards';
import { formatCurrency } from '../utils';

interface PageData {
  overview: WorkspaceOverviewResponse;
  detail: FundDepositDetailResponse;
}

export function FundDepositPage() {

  const loader = useCallback(async () => {
    const [overview, detail] = await Promise.all([
      apiRequest<WorkspaceOverviewResponse>('/api/workspaces/fund-deposit', undefined),
      apiRequest<FundDepositDetailResponse>('/api/workspaces/fund-deposit/detail', undefined),
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

  /* 概览卡片 */
  const overviewCards = data?.detail.overview;

  const columns = useMemo<TableProps<FundDepositDetailResponse['rows'][number]>['columns']>(
    () => [
      { title: '保证金类型', dataIndex: 'depositType', width: 120 },
      { title: '店铺', dataIndex: 'storeName', width: 140, render: (v: string | null) => v ?? '全局' },
      { title: '行业', dataIndex: 'industry', width: 100 },
      { title: '金额', dataIndex: 'amount', width: 100, render: (v: number) => <Typography.Text strong>{formatCurrency(v)}</Typography.Text> },
      { title: '状态', dataIndex: 'status', width: 80, render: (v: string) => <Tag color={v === '已缴' ? 'success' : v === '待缴' ? 'warning' : 'default'}>{v}</Tag> },
      { title: '操作', dataIndex: 'actionLabel', width: 80, render: (v: string) => v ? <Button size="small" type="link">{v}</Button> : '-' },
      { title: '交易金额', dataIndex: 'tradeAmount', width: 100, render: (v: number) => formatCurrency(v) },
      { title: '交易类型', dataIndex: 'tradeType', width: 100 },
      { title: '操作时间', dataIndex: 'operateTime', width: 160 },
    ],
    [],
  );

  return (
    <PageContainer title="保证金管理" subTitle="查看保证金状态、变更记录和风险提示。" style={{ paddingInline: 0 }}
      extra={[<Button key="refresh" icon={<ReloadOutlined />} onClick={() => void reload()}>刷新</Button>]}
    >
      <div className="page-grid">
        <Alert type="info" showIcon icon={<SafetyOutlined />} message="保证金说明" description="保证金是平台对卖家的资质保障，不同行业和经营类目可能要求不同额度。" />
        {error && <Alert type="error" showIcon message={error} />}
        {loading || !data ? <Skeleton active paragraph={{ rows: 8 }} /> : (
          <>
            {summary.length > 0 && <SummaryCards items={summary} />}
            {overviewCards && overviewCards.length > 0 && (
              <Card className="glass-panel" title="保证金概览" bordered={false} size="small">
                <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
                  {overviewCards.map((o, i) => (
                    <div key={i} style={{ minWidth: 160 }}>
                      <Typography.Text type="secondary">{o.label}</Typography.Text>
                      <div><Typography.Text strong style={{ fontSize: 18 }}>{o.value}</Typography.Text></div>
                      {o.helper && <Typography.Text type="secondary" style={{ fontSize: 12 }}>{o.helper}</Typography.Text>}
                    </div>
                  ))}
                </div>
              </Card>
            )}
            <div className="glass-panel" style={{ padding: 24 }}>
              <Table rowKey="id" dataSource={data.detail.rows} columns={columns} pagination={{ pageSize: 15 }} scroll={{ x: 1100 }} size="middle" />
            </div>
          </>
        )}
      </div>
    </PageContainer>
  );
}
