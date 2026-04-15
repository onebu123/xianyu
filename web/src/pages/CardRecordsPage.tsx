import { ReloadOutlined } from '@ant-design/icons';
import { PageContainer } from '@ant-design/pro-components';
import { Alert, Button, Card, Skeleton, Table, Tag, Typography } from 'antd';
import type { TableProps } from 'antd';
import { useCallback, useMemo, useState } from 'react';

import { apiRequest } from '../api';
import type { CardRecordsDetailResponse, WorkspaceOverviewResponse } from '../api';
import { useRemoteData } from '../hooks/useRemoteData';
import { SummaryCards } from '../components/SummaryCards';

interface PageData {
  overview: WorkspaceOverviewResponse;
  detail: CardRecordsDetailResponse;
}

const outboundStatusMap: Record<string, { color: string; text: string }> = {
  sent: { color: 'success', text: '已发' },
  resent: { color: 'processing', text: '重发' },
  recycled: { color: 'warning', text: '已回收' },
  revoked: { color: 'error', text: '已撤销' },
};

export function CardRecordsPage() {
  const [activeTab, setActiveTab] = useState<string>('outbound');

  const loader = useCallback(async () => {
    const [overview, detail] = await Promise.all([
      apiRequest<WorkspaceOverviewResponse>('/api/workspaces/card-records', undefined),
      apiRequest<CardRecordsDetailResponse>('/api/workspaces/card-records/detail', undefined),
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

  const outboundColumns = useMemo<TableProps<CardRecordsDetailResponse['outboundRows'][number]>['columns']>(
    () => [
      { title: '出库单号', dataIndex: 'outboundNo', width: 160 },
      { title: '订单号', dataIndex: 'orderNo', width: 150 },
      { title: '卡种', dataIndex: 'cardTypeName', width: 120 },
      { title: '卡密(掩码)', dataIndex: 'cardMasked', width: 160 },
      { title: '状态', dataIndex: 'outboundStatus', width: 90, render: (v: string) => { const s = outboundStatusMap[v] ?? { color: 'default', text: v }; return <Tag color={s.color}>{s.text}</Tag>; } },
      { title: '模板', dataIndex: 'templateName', width: 120, render: (v: string | null) => v ?? '-' },
      { title: '尝试', dataIndex: 'attemptNo', width: 60 },
      { title: '时间', dataIndex: 'createdAt', width: 160 },
    ],
    [],
  );

  const recycleColumns = useMemo<TableProps<CardRecordsDetailResponse['recycleRows'][number]>['columns']>(
    () => [
      { title: '操作', dataIndex: 'recycleAction', width: 80, render: (v: string) => <Tag color={v === 'recycle' ? 'warning' : 'error'}>{v === 'recycle' ? '回收' : '撤销'}</Tag> },
      { title: '订单号', dataIndex: 'orderNo', width: 150 },
      { title: '出库单号', dataIndex: 'outboundNo', width: 160 },
      { title: '卡种', dataIndex: 'cardTypeName', width: 120 },
      { title: '卡密(掩码)', dataIndex: 'cardMasked', width: 160 },
      { title: '原因', dataIndex: 'reason', ellipsis: true },
      { title: '时间', dataIndex: 'createdAt', width: 160 },
    ],
    [],
  );

  const batchColumns = useMemo<TableProps<CardRecordsDetailResponse['batchRows'][number]>['columns']>(
    () => [
      { title: '批次号', dataIndex: 'batchNo', width: 160 },
      { title: '卡种', dataIndex: 'cardTypeName', width: 120 },
      { title: '来源', dataIndex: 'sourceLabel', width: 100 },
      { title: '导入', dataIndex: 'importedCount', width: 80 },
      { title: '重复', dataIndex: 'duplicateCount', width: 80, render: (v: number) => v > 0 ? <Typography.Text type="warning">{v}</Typography.Text> : v },
      { title: '无效', dataIndex: 'invalidCount', width: 80, render: (v: number) => v > 0 ? <Typography.Text type="danger">{v}</Typography.Text> : v },
      { title: '可用', dataIndex: 'availableCount', width: 80, render: (v: number) => <Tag color="success">{v}</Tag> },
      { title: '导入时间', dataIndex: 'importedAt', width: 160 },
    ],
    [],
  );

  const tabList = [
    { key: 'outbound', tab: `出库记录 (${data?.detail.outboundRows.length ?? 0})` },
    { key: 'recycle', tab: `回收记录 (${data?.detail.recycleRows.length ?? 0})` },
    { key: 'batch', tab: `导入批次 (${data?.detail.batchRows.length ?? 0})` },
  ];

  return (
    <PageContainer title="卡密记录" subTitle="查看卡密领取、发货和回收全链路记录。" style={{ paddingInline: 0 }}
      extra={[<Button key="refresh" icon={<ReloadOutlined />} onClick={() => void reload()}>刷新</Button>]}
    >
      <div className="page-grid">
        {error && <Alert type="error" showIcon message={error} />}
        {loading || !data ? <Skeleton active paragraph={{ rows: 10 }} /> : (
          <>
            {summary.length > 0 && <SummaryCards items={summary} />}
            <Card className="glass-panel" bordered={false} tabList={tabList} activeTabKey={activeTab} onTabChange={setActiveTab}>
              {activeTab === 'outbound' && <Table rowKey="id" dataSource={data.detail.outboundRows} columns={outboundColumns} pagination={{ pageSize: 12 }} scroll={{ x: 1100 }} size="middle" />}
              {activeTab === 'recycle' && <Table rowKey="id" dataSource={data.detail.recycleRows} columns={recycleColumns} pagination={{ pageSize: 12 }} scroll={{ x: 1000 }} size="middle" />}
              {activeTab === 'batch' && <Table rowKey="id" dataSource={data.detail.batchRows} columns={batchColumns} pagination={{ pageSize: 12 }} scroll={{ x: 900 }} size="middle" />}
            </Card>
          </>
        )}
      </div>
    </PageContainer>
  );
}
