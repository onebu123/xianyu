import { ReloadOutlined, FileSearchOutlined } from '@ant-design/icons';
import { PageContainer } from '@ant-design/pro-components';
import { Alert, Button, Skeleton, Table, Tag } from 'antd';
import type { TableProps } from 'antd';
import { useCallback, useMemo } from 'react';

import { apiRequest } from '../api';
import type { OpenLogsDetailResponse, WorkspaceOverviewResponse } from '../api';
import { useRemoteData } from '../hooks/useRemoteData';
import { SummaryCards } from '../components/SummaryCards';

interface PageData {
  overview: WorkspaceOverviewResponse;
  detail: OpenLogsDetailResponse;
}

export function OpenLogsPage() {

  const loader = useCallback(async () => {
    const [overview, detail] = await Promise.all([
      apiRequest<WorkspaceOverviewResponse>('/api/workspaces/open-logs', undefined),
      apiRequest<OpenLogsDetailResponse>('/api/workspaces/open-logs/detail', undefined),
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

  const columns = useMemo<TableProps<OpenLogsDetailResponse['rows'][number]>['columns']>(
    () => [
      { title: '操作', dataIndex: 'action', width: 120, render: (v: string) => <Tag color="blue">{v}</Tag> },
      { title: '目标类型', dataIndex: 'targetType', width: 100 },
      { title: '目标 ID', dataIndex: 'targetId', width: 120, render: (v: string | null) => v ?? '-' },
      { title: '结果', dataIndex: 'result', width: 80, render: (v: string) => <Tag color={v === '成功' ? 'success' : v === '失败' ? 'error' : 'default'}>{v}</Tag> },
      { title: '详情', dataIndex: 'detail', ellipsis: true },
      { title: '操作人', dataIndex: 'operatorDisplayName', width: 100, render: (v: string | null) => v ?? '-' },
      { title: 'IP', dataIndex: 'ipAddress', width: 120, render: (v: string | null) => v ?? '-' },
      { title: '时间', dataIndex: 'createdAt', width: 160 },
    ],
    [],
  );

  return (
    <PageContainer title="操作日志" subTitle="查看接口调用日志、错误码与重试记录。" style={{ paddingInline: 0 }}
      extra={[<Button key="refresh" icon={<ReloadOutlined />} onClick={() => void reload()}>刷新</Button>]}
    >
      <div className="page-grid">
        <Alert type="info" showIcon icon={<FileSearchOutlined />} message="日志说明" description="系统自动记录所有关键操作日志，便于安全审计和问题排查。" />
        {error && <Alert type="error" showIcon message={error} />}
        {loading || !data ? <Skeleton active paragraph={{ rows: 8 }} /> : (
          <>
            {summary.length > 0 && <SummaryCards items={summary} />}
            <div className="glass-panel" style={{ padding: 24 }}>
              <Table rowKey="id" dataSource={data.detail.rows} columns={columns} pagination={{ pageSize: 15 }} scroll={{ x: 1000 }} size="middle" />
            </div>
          </>
        )}
      </div>
    </PageContainer>
  );
}
