import { ReloadOutlined, ApiOutlined } from '@ant-design/icons';
import { PageContainer } from '@ant-design/pro-components';
import { Alert, Button, Skeleton, Table, Tag, Typography } from 'antd';
import type { TableProps } from 'antd';
import { useCallback, useMemo } from 'react';

import { apiRequest } from '../api';
import type { WorkspaceOverviewResponse } from '../api';
import { useRemoteData } from '../hooks/useRemoteData';
import { SummaryCards } from '../components/SummaryCards';

export function OpenAppsPage() {

  const loader = useCallback(async () => {
    return apiRequest<WorkspaceOverviewResponse>('/api/workspaces/open-apps', undefined);
  }, []);

  const { data, loading, error, reload } = useRemoteData<WorkspaceOverviewResponse>(loader);

  const summary = useMemo(() => {
    if (!data?.summary) return [];
    return data.summary.map((s, i) => ({
      key: `s-${i}`, label: s.label, value: typeof s.value === 'string' ? parseFloat(s.value) || 0 : s.value, unit: '',
    }));
  }, [data]);

  // 从 overview 中提取任务列表作为表格数据
  const tableData = useMemo(() => {
    if (!data?.tasks) return [];
    return data.tasks.map((t, i) => ({ key: i, ...t }));
  }, [data]);

  const columns = useMemo<TableProps['columns']>(
    () => [
      { title: '任务', dataIndex: 'title', width: 200 },
      { title: '状态', dataIndex: 'status', width: 90, render: (v: string) => <Tag color={v === 'done' ? 'success' : v === 'active' ? 'processing' : 'default'}>{v === 'done' ? '完成' : v === 'active' ? '进行中' : '待处理'}</Tag> },
      { title: '说明', dataIndex: 'description', ellipsis: true },
    ],
    [],
  );

  return (
    <PageContainer title="应用管理" subTitle="查看应用清单、接入状态和授权信息。" style={{ paddingInline: 0 }}
      extra={[<Button key="refresh" icon={<ReloadOutlined />} onClick={() => void reload()}>刷新</Button>]}
    >
      <div className="page-grid">
        <Alert type="info" showIcon icon={<ApiOutlined />} message="应用说明" description="管理所有已接入的第三方应用，查看授权状态和 API 调用配额。" />
        {error && <Alert type="error" showIcon message={error} />}
        {loading || !data ? <Skeleton active paragraph={{ rows: 6 }} /> : (
          <>
            {summary.length > 0 && <SummaryCards items={summary} />}
            <div className="glass-panel" style={{ padding: 24 }}>
              <Typography.Title level={4} style={{ marginBottom: 16 }}>应用清单</Typography.Title>
              <Table dataSource={tableData} columns={columns} pagination={false} size="middle" />
            </div>
          </>
        )}
      </div>
    </PageContainer>
  );
}
