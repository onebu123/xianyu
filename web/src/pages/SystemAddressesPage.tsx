import { ReloadOutlined, EnvironmentOutlined } from '@ant-design/icons';
import { PageContainer } from '@ant-design/pro-components';
import { Alert, Button, Skeleton, Table, Tag, Typography } from 'antd';
import type { TableProps } from 'antd';
import { useCallback, useMemo } from 'react';

import { apiRequest } from '../api';
import type { WorkspaceOverviewResponse } from '../api';
import { useRemoteData } from '../hooks/useRemoteData';
import { SummaryCards } from '../components/SummaryCards';

export function SystemAddressesPage() {

  const loader = useCallback(async () => {
    return apiRequest<WorkspaceOverviewResponse>('/api/workspaces/system-addresses', undefined);
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
      { title: '地址', dataIndex: 'title', width: 200 },
      { title: '状态', dataIndex: 'status', width: 90, render: (v: string) => <Tag color={v === 'done' ? 'success' : 'default'}>{v === 'done' ? '默认' : '备选'}</Tag> },
      { title: '说明', dataIndex: 'description', ellipsis: true },
    ],
    [],
  );

  return (
    <PageContainer title="地址管理" subTitle="维护收发货地址、默认地址与地址模板。" style={{ paddingInline: 0 }}
      extra={[<Button key="refresh" icon={<ReloadOutlined />} onClick={() => void reload()}>刷新</Button>]}
    >
      <div className="page-grid">
        <Alert type="info" showIcon icon={<EnvironmentOutlined />} message="地址说明" description="管理所有收发货地址，支持设置默认地址和按店铺分配。" />
        {error && <Alert type="error" showIcon message={error} />}
        {loading || !data ? <Skeleton active paragraph={{ rows: 6 }} /> : (
          <>
            {summary.length > 0 && <SummaryCards items={summary} />}
            <div className="glass-panel" style={{ padding: 24 }}>
              <Typography.Title level={4} style={{ marginBottom: 16 }}>地址列表</Typography.Title>
              <Table dataSource={tableData} columns={columns} pagination={false} size="middle" />
            </div>
          </>
        )}
      </div>
    </PageContainer>
  );
}
