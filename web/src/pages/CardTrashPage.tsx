import { ReloadOutlined, DeleteOutlined } from '@ant-design/icons';
import { PageContainer } from '@ant-design/pro-components';
import { Alert, Button, Skeleton, Table, Tag, Typography, message } from 'antd';
import type { TableProps } from 'antd';
import { useCallback, useMemo } from 'react';

import { apiRequest } from '../api';
import type { CardTrashDetailResponse, WorkspaceOverviewResponse } from '../api';
import { useRemoteData } from '../hooks/useRemoteData';
import { SummaryCards } from '../components/SummaryCards';
import { formatNumber } from '../utils';

interface PageData {
  overview: WorkspaceOverviewResponse;
  detail: CardTrashDetailResponse;
}

export function CardTrashPage() {
  const [messageApi, contextHolder] = message.useMessage();

  const loader = useCallback(async () => {
    const [overview, detail] = await Promise.all([
      apiRequest<WorkspaceOverviewResponse>('/api/workspaces/card-trash', undefined),
      apiRequest<CardTrashDetailResponse>('/api/workspaces/card-trash/detail', undefined),
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

  const handleRestore = useCallback(async (id: number) => {
    try {
      await apiRequest(`/api/workspaces/card-trash/items/${id}/restore`, { method: 'POST', body: '{}' });
      messageApi.success('卡种已恢复');
      await reload();
    } catch (err) { messageApi.error(err instanceof Error ? err.message : '恢复失败'); }
  }, [messageApi, reload]);

  const columns = useMemo<TableProps<CardTrashDetailResponse['rows'][number]>['columns']>(
    () => [
      { title: 'ID', dataIndex: 'id', width: 70 },
      { title: '卡种名称', dataIndex: 'typeName', width: 180 },
      { title: '未售库存', dataIndex: 'unsoldCount', width: 100, render: (v: number) => <Tag color={v > 0 ? 'warning' : 'default'}>{formatNumber(v, ' 张')}</Tag> },
      { title: '已售数量', dataIndex: 'soldCount', width: 100, render: (v: number) => formatNumber(v, ' 张') },
      { title: '总库存', dataIndex: 'totalStock', width: 100, render: (v: number) => formatNumber(v, ' 张') },
      { title: '删除时间', dataIndex: 'deletedAt', width: 160 },
      { title: '删除人', dataIndex: 'deletedBy', width: 100 },
      { title: '操作', key: 'action', fixed: 'right', width: 100, render: (_: unknown, row) => (
        <Button size="small" type="link" onClick={() => void handleRestore(row.id)}>恢复</Button>
      )},
    ],
    [handleRestore],
  );

  return (
    <PageContainer title="卡密回收站" subTitle="处理误删卡密、回收记录与二次恢复。" style={{ paddingInline: 0 }}
      extra={[<Button key="refresh" icon={<ReloadOutlined />} onClick={() => void reload()}>刷新</Button>]}
    >
      {contextHolder}
      <div className="page-grid">
        <Alert type="warning" showIcon icon={<DeleteOutlined />} message="回收站说明" description="已删除的卡种及其库存可在此恢复。恢复后将重新出现在卡种管理中，但不会自动重新关联发货绑定。" />
        {error && <Alert type="error" showIcon message={error} />}
        {loading || !data ? <Skeleton active paragraph={{ rows: 8 }} /> : (
          <>
            {summary.length > 0 && <SummaryCards items={summary} />}
            <div className="glass-panel" style={{ padding: 24 }}>
              <Typography.Title level={4} style={{ marginBottom: 16 }}>已删除卡种</Typography.Title>
              <Table rowKey="id" dataSource={data.detail.rows} columns={columns} pagination={{ pageSize: 15 }} scroll={{ x: 1000 }} size="middle" />
            </div>
          </>
        )}
      </div>
    </PageContainer>
  );
}
