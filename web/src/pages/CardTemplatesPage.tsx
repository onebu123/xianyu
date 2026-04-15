import { ReloadOutlined, PlusOutlined } from '@ant-design/icons';
import { PageContainer } from '@ant-design/pro-components';
import { Alert, Button, Skeleton, Switch, Table, Tag, Typography, message } from 'antd';
import type { TableProps } from 'antd';
import { useCallback, useMemo } from 'react';

import { apiRequest } from '../api';
import type { CardTemplatesDetailResponse, WorkspaceOverviewResponse } from '../api';
import { useRemoteData } from '../hooks/useRemoteData';
import { SummaryCards } from '../components/SummaryCards';

interface PageData {
  overview: WorkspaceOverviewResponse;
  detail: CardTemplatesDetailResponse;
}

export function CardTemplatesPage() {
  const [, contextHolder] = message.useMessage();

  const loader = useCallback(async () => {
    const [overview, detail] = await Promise.all([
      apiRequest<WorkspaceOverviewResponse>('/api/workspaces/card-templates', undefined),
      apiRequest<CardTemplatesDetailResponse>('/api/workspaces/card-templates/detail', undefined),
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

  const columns = useMemo<TableProps<CardTemplatesDetailResponse['rows'][number]>['columns']>(
    () => [
      { title: '模板 ID', dataIndex: 'id', width: 90, render: (v: number) => <Typography.Text strong>#{v}</Typography.Text> },
      { title: '模板名称', dataIndex: 'templateName', width: 180 },
      { title: '模板内容', dataIndex: 'templateContent', ellipsis: true },
      { title: '状态', dataIndex: 'templateStatus', width: 90, render: (v: string) => <Tag color={v === '启用' ? 'success' : 'default'}>{v}</Tag> },
      { title: '随机', dataIndex: 'randomEnabled', width: 80, render: (v: boolean) => <Switch size="small" checked={v} disabled /> },
      { title: '创建时间', dataIndex: 'createdAt', width: 160 },
      { title: '更新时间', dataIndex: 'updatedAt', width: 160 },
    ],
    [],
  );

  return (
    <PageContainer title="模板管理" subTitle="管理交付模板、消息模板和展示格式。" style={{ paddingInline: 0 }}
      extra={[
        <Button key="add" icon={<PlusOutlined />} type="primary">新增模板</Button>,
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
