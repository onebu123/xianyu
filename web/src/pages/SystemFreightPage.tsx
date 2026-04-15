import { ReloadOutlined, CarOutlined } from '@ant-design/icons';
import { PageContainer } from '@ant-design/pro-components';
import { Alert, Button, Skeleton, Table, Tag, Typography } from 'antd';
import type { TableProps } from 'antd';
import { useCallback, useMemo } from 'react';

import { apiRequest } from '../api';
import type { WorkspaceOverviewResponse } from '../api';
import { useRemoteData } from '../hooks/useRemoteData';
import { SummaryCards } from '../components/SummaryCards';

export function SystemFreightPage() {

  const loader = useCallback(async () => {
    return apiRequest<WorkspaceOverviewResponse>('/api/workspaces/system-freight', undefined);
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
      { title: '模板', dataIndex: 'title', width: 200 },
      { title: '状态', dataIndex: 'status', width: 90, render: (v: string) => <Tag color={v === 'done' ? 'success' : v === 'active' ? 'processing' : 'default'}>{v === 'done' ? '已生效' : v === 'active' ? '配置中' : '待配置'}</Tag> },
      { title: '说明', dataIndex: 'description', ellipsis: true },
    ],
    [],
  );

  return (
    <PageContainer title="运费模板" subTitle="配置运费模板、包邮规则和地区差价。" style={{ paddingInline: 0 }}
      extra={[<Button key="refresh" icon={<ReloadOutlined />} onClick={() => void reload()}>刷新</Button>]}
    >
      <div className="page-grid">
        <Alert type="info" showIcon icon={<CarOutlined />} message="运费说明" description="配置不同地区的运费规则，支持按重量、件数、金额等维度设置包邮条件。" />
        {error && <Alert type="error" showIcon message={error} />}
        {loading || !data ? <Skeleton active paragraph={{ rows: 6 }} /> : (
          <>
            {summary.length > 0 && <SummaryCards items={summary} />}
            <div className="glass-panel" style={{ padding: 24 }}>
              <Typography.Title level={4} style={{ marginBottom: 16 }}>运费模板列表</Typography.Title>
              <Table dataSource={tableData} columns={columns} pagination={false} size="middle" />
            </div>
          </>
        )}
      </div>
    </PageContainer>
  );
}
