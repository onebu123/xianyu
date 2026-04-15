import { ReloadOutlined, BookOutlined } from '@ant-design/icons';
import { PageContainer } from '@ant-design/pro-components';
import { Alert, Button, Skeleton, Table, Tag, Typography } from 'antd';
import type { TableProps } from 'antd';
import { useCallback, useMemo } from 'react';

import { apiRequest } from '../api';
import type { WorkspaceOverviewResponse } from '../api';
import { useRemoteData } from '../hooks/useRemoteData';
import { SummaryCards } from '../components/SummaryCards';

export function OpenDocsPage() {

  const loader = useCallback(async () => {
    return apiRequest<WorkspaceOverviewResponse>('/api/workspaces/open-docs', undefined);
  }, []);

  const { data, loading, error, reload } = useRemoteData<WorkspaceOverviewResponse>(loader);

  const summary = useMemo(() => {
    if (!data?.summary) return [];
    return data.summary.map((s, i) => ({
      key: `s-${i}`, label: s.label, value: typeof s.value === 'string' ? parseFloat(s.value) || 0 : s.value, unit: '',
    }));
  }, [data]);

  const tableData = useMemo(() => {
    if (!data?.tasks) return [];
    return data.tasks.map((t, i) => ({ key: i, ...t }));
  }, [data]);

  const columns = useMemo<TableProps['columns']>(
    () => [
      { title: '文档', dataIndex: 'title', width: 200 },
      { title: '状态', dataIndex: 'status', width: 90, render: (v: string) => <Tag color={v === 'done' ? 'success' : v === 'active' ? 'processing' : 'default'}>{v === 'done' ? '已发布' : v === 'active' ? '更新中' : '草稿'}</Tag> },
      { title: '说明', dataIndex: 'description', ellipsis: true },
    ],
    [],
  );

  return (
    <PageContainer title="接口文档" subTitle="维护接口文档、接入指南和字段说明。" style={{ paddingInline: 0 }}
      extra={[<Button key="refresh" icon={<ReloadOutlined />} onClick={() => void reload()}>刷新</Button>]}
    >
      <div className="page-grid">
        <Alert type="info" showIcon icon={<BookOutlined />} message="文档中心" description="统一管理所有开放接口的文档、密钥说明和接入示例。" />
        {error && <Alert type="error" showIcon message={error} />}
        {loading || !data ? <Skeleton active paragraph={{ rows: 6 }} /> : (
          <>
            {summary.length > 0 && <SummaryCards items={summary} />}
            <div className="glass-panel" style={{ padding: 24 }}>
              <Typography.Title level={4} style={{ marginBottom: 16 }}>文档列表</Typography.Title>
              <Table dataSource={tableData} columns={columns} pagination={false} size="middle" />
            </div>
          </>
        )}
      </div>
    </PageContainer>
  );
}
