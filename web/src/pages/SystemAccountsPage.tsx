import { ReloadOutlined, SolutionOutlined } from '@ant-design/icons';
import { PageContainer } from '@ant-design/pro-components';
import { Alert, Button, Skeleton, Table, Tag } from 'antd';
import type { TableProps } from 'antd';
import { useCallback, useMemo } from 'react';

import { apiRequest } from '../api';
import type { SystemAccountsDetailResponse, WorkspaceOverviewResponse } from '../api';
import { useRemoteData } from '../hooks/useRemoteData';
import { SummaryCards } from '../components/SummaryCards';

interface PageData {
  overview: WorkspaceOverviewResponse;
  detail: SystemAccountsDetailResponse;
}

export function SystemAccountsPage() {

  const loader = useCallback(async () => {
    const [overview, detail] = await Promise.all([
      apiRequest<WorkspaceOverviewResponse>('/api/workspaces/system-accounts', undefined),
      apiRequest<SystemAccountsDetailResponse>('/api/workspaces/system-accounts/detail', undefined),
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

  const columns = useMemo<TableProps<SystemAccountsDetailResponse['rows'][number]>['columns']>(
    () => [
      { title: '用户名', dataIndex: 'username', width: 120 },
      { title: '显示名', dataIndex: 'displayName', width: 120 },
      { title: '角色', dataIndex: 'role', width: 90, render: (v: string) => <Tag color={v === 'admin' ? 'error' : v === 'operator' ? 'blue' : 'default'}>{v === 'admin' ? '管理员' : v === 'operator' ? '操作员' : v}</Tag> },
      { title: '状态', dataIndex: 'enabled', width: 80, render: (v: boolean) => <Tag color={v ? 'success' : 'default'}>{v ? '启用' : '禁用'}</Tag> },
      { title: '最近登录', dataIndex: 'lastLoginAt', width: 160, render: (v: string | null) => v ?? '-' },
      { title: '创建时间', dataIndex: 'createdAt', width: 160 },
    ],
    [],
  );

  return (
    <PageContainer title="账号管理" subTitle="管理账号权限、角色分配和登录安全。" style={{ paddingInline: 0 }}
      extra={[<Button key="refresh" icon={<ReloadOutlined />} onClick={() => void reload()}>刷新</Button>]}
    >
      <div className="page-grid">
        <Alert type="info" showIcon icon={<SolutionOutlined />} message="账号说明" description="管理系统用户账号，分配角色权限，监控登录安全。" />
        {error && <Alert type="error" showIcon message={error} />}
        {loading || !data ? <Skeleton active paragraph={{ rows: 6 }} /> : (
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
