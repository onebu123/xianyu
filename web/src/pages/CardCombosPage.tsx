import { ReloadOutlined, PlusOutlined } from '@ant-design/icons';
import { PageContainer } from '@ant-design/pro-components';
import { Alert, Button, Skeleton, Table, Tag, Typography, message } from 'antd';
import type { TableProps } from 'antd';
import { useCallback, useMemo } from 'react';

import { apiRequest } from '../api';
import type { CardCombosDetailResponse, WorkspaceOverviewResponse } from '../api';
import { useRemoteData } from '../hooks/useRemoteData';
import { SummaryCards } from '../components/SummaryCards';

interface PageData {
  overview: WorkspaceOverviewResponse;
  detail: CardCombosDetailResponse;
}

export function CardCombosPage() {
  const [, contextHolder] = message.useMessage();

  const loader = useCallback(async () => {
    const [overview, detail] = await Promise.all([
      apiRequest<WorkspaceOverviewResponse>('/api/workspaces/card-combos', undefined),
      apiRequest<CardCombosDetailResponse>('/api/workspaces/card-combos/detail', undefined),
    ]);
    return { overview, detail } as PageData;
  }, []);

  const { data, loading, error, reload } = useRemoteData<PageData>(loader);

  const summary = useMemo(() => {
    if (!data?.detail?.metrics) return [];
    return data.detail.metrics.map((m, i) => ({
      key: `metric-${i}`,
      label: m.label,
      value: typeof m.value === 'string' ? parseFloat(m.value) || 0 : m.value,
      unit: m.unit,
    }));
  }, [data]);

  const columns = useMemo<TableProps<CardCombosDetailResponse['rows'][number]>['columns']>(
    () => [
      { title: '组合 ID', dataIndex: 'id', width: 90, render: (v: number) => <Typography.Text strong>#{v}</Typography.Text> },
      { title: '组合名称', dataIndex: 'comboName', width: 180 },
      { title: '组合内容', dataIndex: 'comboContent', ellipsis: true },
      { title: '类型', dataIndex: 'comboType', width: 100, render: (v: string) => <Tag color="blue">{v}</Tag> },
      { title: '状态', dataIndex: 'status', width: 90, render: (v: string) => <Tag color={v === '启用' ? 'success' : 'default'}>{v}</Tag> },
      { title: '创建时间', dataIndex: 'createdAt', width: 160 },
      { title: '更新时间', dataIndex: 'updatedAt', width: 160 },
    ],
    [],
  );

  return (
    <PageContainer title="组合管理" subTitle="设置卡密组合售卖规则与组合库存联动。" style={{ paddingInline: 0 }}
      extra={[
        <Button key="add" icon={<PlusOutlined />} type="primary">新增组合</Button>,
        <Button key="refresh" icon={<ReloadOutlined />} onClick={() => void reload()}>刷新</Button>,
      ]}
    >
      {contextHolder}
      <div className="page-grid">
        {error && <Alert type="error" showIcon message={error} />}
        {loading || !data ? <Skeleton active paragraph={{ rows: 8 }} /> : (
          <>
            {summary.length > 0 && <SummaryCards items={summary} />}
            <div className="glass-panel" style={{ padding: 24 }}>
              <Table rowKey="id" dataSource={data.detail.rows} columns={columns} pagination={{ pageSize: 15 }} size="middle" />
            </div>
          </>
        )}
      </div>
    </PageContainer>
  );
}
