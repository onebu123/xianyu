import { ReloadOutlined, DollarOutlined } from '@ant-design/icons';
import { PageContainer } from '@ant-design/pro-components';
import { Alert, Button, Card, Col, Row, Skeleton, Switch, Table, Tag, Typography } from 'antd';
import type { TableProps } from 'antd';
import { useCallback, useMemo, useState } from 'react';

import { apiRequest } from '../api';
import type { AiBargainDetailResponse, WorkspaceOverviewResponse } from '../api';
import { useRemoteData } from '../hooks/useRemoteData';
import { SummaryCards } from '../components/SummaryCards';
import { formatCurrency } from '../utils';

interface PageData {
  overview: WorkspaceOverviewResponse;
  detail: AiBargainDetailResponse;
}

export function AiBargainPage() {
  const [activeTab, setActiveTab] = useState<string>('strategies');

  const loader = useCallback(async () => {
    const [overview, detail] = await Promise.all([
      apiRequest<WorkspaceOverviewResponse>('/api/workspaces/ai-bargain', undefined),
      apiRequest<AiBargainDetailResponse>('/api/workspaces/ai-bargain/detail', undefined),
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

  const strategyColumns = useMemo<TableProps<AiBargainDetailResponse['strategies'][number]>['columns']>(
    () => [
      { title: '策略名称', dataIndex: 'strategyName', width: 160 },
      { title: '商品', dataIndex: 'productName', width: 180, ellipsis: true },
      { title: '挂牌价', dataIndex: 'listedPrice', width: 90, render: (v: number) => formatCurrency(v) },
      { title: '底价', dataIndex: 'minPrice', width: 90, render: (v: number) => <Typography.Text type="danger">{formatCurrency(v)}</Typography.Text> },
      { title: '目标价', dataIndex: 'targetPrice', width: 90, render: (v: number) => formatCurrency(v) },
      { title: '步长', dataIndex: 'stepPrice', width: 80, render: (v: number) => formatCurrency(v) },
      { title: '最大轮数', dataIndex: 'maxRounds', width: 80 },
      { title: '启用', dataIndex: 'enabled', width: 70, render: (v: boolean) => <Tag color={v ? 'success' : 'default'}>{v ? '是' : '否'}</Tag> },
      { title: '风险', dataIndex: 'riskTagsText', width: 120, ellipsis: true },
    ],
    [],
  );

  const sessionColumns = useMemo<TableProps<AiBargainDetailResponse['sessions'][number]>['columns']>(
    () => [
      { title: '会话号', dataIndex: 'sessionNo', width: 140 },
      { title: '买家', dataIndex: 'customerName', width: 100 },
      { title: '商品', dataIndex: 'productName', width: 160, ellipsis: true },
      { title: '当前报价', dataIndex: 'latestBuyerOffer', width: 90, render: (v: number | null) => v != null ? formatCurrency(v) : '-' },
      { title: '还价', dataIndex: 'latestCounterPrice', width: 90, render: (v: number | null) => v != null ? formatCurrency(v) : '-' },
      { title: '轮次', dataIndex: 'currentRound', width: 60, render: (v: number, r) => `${v}/${r.maxRounds}` },
      { title: '状态', dataIndex: 'sessionStatusText', width: 90, render: (v: string) => <Tag>{v}</Tag> },
      { title: '风险', dataIndex: 'riskLevelText', width: 80, render: (v: string, r) => <Tag color={r.riskLevel === 'high' ? 'error' : r.riskLevel === 'medium' ? 'warning' : 'default'}>{v}</Tag> },
    ],
    [],
  );

  const logColumns = useMemo<TableProps<AiBargainDetailResponse['logs'][number]>['columns']>(
    () => [
      { title: '会话', dataIndex: 'sessionNo', width: 140 },
      { title: '买家', dataIndex: 'customerName', width: 100 },
      { title: '角色', dataIndex: 'actorTypeText', width: 80 },
      { title: '动作', dataIndex: 'actionTypeText', width: 80 },
      { title: '报价', dataIndex: 'offerPrice', width: 80, render: (v: number | null) => v != null ? formatCurrency(v) : '-' },
      { title: '消息', dataIndex: 'messageText', ellipsis: true },
      { title: '时间', dataIndex: 'createdAt', width: 160 },
    ],
    [],
  );

  const settings = data?.detail.settings;

  const tabList = [
    { key: 'strategies', tab: `议价策略 (${data?.detail.strategies.length ?? 0})` },
    { key: 'sessions', tab: `议价会话 (${data?.detail.sessions.length ?? 0})` },
    { key: 'logs', tab: `议价日志 (${data?.detail.logs.length ?? 0})` },
  ];

  return (
    <PageContainer title="AI 议价" subTitle="管理底价保护、议价策略、风险识别、人工接管和议价留痕。" style={{ paddingInline: 0 }}
      extra={[<Button key="refresh" icon={<ReloadOutlined />} onClick={() => void reload()}>刷新</Button>]}
    >
      <div className="page-grid">
        <Alert type="info" showIcon icon={<DollarOutlined />} message="AI 议价说明" description="系统根据商品底价和议价策略，自动与买家进行多轮议价，保护利润的同时提升成交率。" />
        {error && <Alert type="error" showIcon message={error} />}
        {loading || !data ? <Skeleton active paragraph={{ rows: 10 }} /> : (
          <>
            {summary.length > 0 && <SummaryCards items={summary} />}

            {settings && (
              <Card className="glass-panel" title="议价开关" bordered={false} size="small">
                <Row gutter={[24, 12]}>
                  <Col span={6}><Switch size="small" checked={settings.aiEnabled} disabled /> <Typography.Text style={{ marginLeft: 8 }}>AI 议价</Typography.Text></Col>
                  <Col span={6}><Switch size="small" checked={settings.autoBargainEnabled} disabled /> <Typography.Text style={{ marginLeft: 8 }}>自动议价</Typography.Text></Col>
                  <Col span={6}><Switch size="small" checked={settings.allowAutoAccept} disabled /> <Typography.Text style={{ marginLeft: 8 }}>自动接受</Typography.Text></Col>
                  <Col span={6}><Switch size="small" checked={settings.highRiskManualOnly} disabled /> <Typography.Text style={{ marginLeft: 8 }}>高风险人工</Typography.Text></Col>
                </Row>
              </Card>
            )}

            <Card className="glass-panel" bordered={false} tabList={tabList} activeTabKey={activeTab} onTabChange={setActiveTab}>
              {activeTab === 'strategies' && <Table rowKey="id" dataSource={data.detail.strategies} columns={strategyColumns} pagination={{ pageSize: 10 }} scroll={{ x: 1000 }} size="middle" />}
              {activeTab === 'sessions' && <Table rowKey="id" dataSource={data.detail.sessions} columns={sessionColumns} pagination={{ pageSize: 10 }} scroll={{ x: 1000 }} size="middle" />}
              {activeTab === 'logs' && <Table rowKey="id" dataSource={data.detail.logs} columns={logColumns} pagination={{ pageSize: 12 }} scroll={{ x: 900 }} size="middle" />}
            </Card>
          </>
        )}
      </div>
    </PageContainer>
  );
}
