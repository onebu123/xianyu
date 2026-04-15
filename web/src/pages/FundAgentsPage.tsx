import { ReloadOutlined, SolutionOutlined } from '@ant-design/icons';
import { PageContainer } from '@ant-design/pro-components';
import { Alert, Button, Card, Col, Row, Skeleton, Table, Tag, Typography } from 'antd';
import type { TableProps } from 'antd';
import { useCallback, useMemo } from 'react';

import { apiRequest } from '../api';
import type { FundAgentsDetailResponse, WorkspaceOverviewResponse } from '../api';
import { useRemoteData } from '../hooks/useRemoteData';
import { SummaryCards } from '../components/SummaryCards';
import { formatCurrency } from '../utils';

interface PageData {
  overview: WorkspaceOverviewResponse;
  detail: FundAgentsDetailResponse;
}

export function FundAgentsPage() {

  const loader = useCallback(async () => {
    const [overview, detail] = await Promise.all([
      apiRequest<WorkspaceOverviewResponse>('/api/workspaces/fund-agents', undefined),
      apiRequest<FundAgentsDetailResponse>('/api/workspaces/fund-agents/detail', undefined),
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

  const columns = useMemo<TableProps<FundAgentsDetailResponse['rows'][number]>['columns']>(
    () => [
      { title: '成员', dataIndex: 'memberName', width: 120 },
      { title: '版本', dataIndex: 'versionName', width: 100 },
      { title: '等级', dataIndex: 'agentLevel', width: 80, render: (v: string) => <Tag color="blue">{v}</Tag> },
      { title: '用户信息', dataIndex: 'userInfo', width: 140, ellipsis: true },
      { title: '订购信息', dataIndex: 'subscriptionInfo', width: 140, ellipsis: true },
      { title: '折扣', dataIndex: 'discountInfo', width: 100 },
      { title: '返佣', dataIndex: 'commissionText', width: 100, render: (v: string) => <Typography.Text type="success">{v}</Typography.Text> },
      { title: '返佣状态', dataIndex: 'commissionStatus', width: 90, render: (v: string) => <Tag>{v}</Tag> },
      { title: '提现', dataIndex: 'withdrawalAmount', width: 100, render: (v: number) => formatCurrency(v) },
      { title: '提现状态', dataIndex: 'withdrawalStatus', width: 90, render: (v: string) => <Tag>{v}</Tag> },
      { title: '加入时间', dataIndex: 'joinedAt', width: 160 },
    ],
    [],
  );

  return (
    <PageContainer title="代理商管理" subTitle="维护代理商层级、结算方式和返佣记录。" style={{ paddingInline: 0 }}
      extra={[<Button key="refresh" icon={<ReloadOutlined />} onClick={() => void reload()}>刷新</Button>]}
    >
      <div className="page-grid">
        <Alert type="info" showIcon icon={<SolutionOutlined />} message="代理商体系" description="系统支持多级代理商返佣，代理商可自助查看佣金和提现进度。" />
        {error && <Alert type="error" showIcon message={error} />}
        {loading || !data ? <Skeleton active paragraph={{ rows: 8 }} /> : (
          <>
            {summary.length > 0 && <SummaryCards items={summary} />}

            {data.detail.tiers && data.detail.tiers.length > 0 && (
              <Card className="glass-panel" title="代理等级" bordered={false} size="small">
                <Row gutter={[16, 12]}>
                  {data.detail.tiers.map((t, i) => (
                    <Col key={i} span={8}>
                      <Card size="small" bordered style={{ borderColor: t.unlocked ? 'var(--primary)' : undefined }}>
                        <Typography.Text strong>{t.name}</Typography.Text>
                        {t.unlocked && <Tag color="success" style={{ marginLeft: 8 }}>已解锁</Tag>}
                        <div><Typography.Text type="secondary" style={{ fontSize: 12 }}>{t.description}</Typography.Text></div>
                      </Card>
                    </Col>
                  ))}
                </Row>
              </Card>
            )}

            <div className="glass-panel" style={{ padding: 24 }}>
              <Table rowKey="id" dataSource={data.detail.rows} columns={columns} pagination={{ pageSize: 15 }} scroll={{ x: 1300 }} size="middle" />
            </div>
          </>
        )}
      </div>
    </PageContainer>
  );
}
