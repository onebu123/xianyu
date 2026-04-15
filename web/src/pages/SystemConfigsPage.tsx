import { ReloadOutlined, SettingOutlined } from '@ant-design/icons';
import { PageContainer } from '@ant-design/pro-components';
import { Alert, Button, Skeleton, Table, Typography } from 'antd';
import type { TableProps } from 'antd';
import { useCallback, useMemo } from 'react';

import { apiRequest } from '../api';
import type { SystemConfigsDetailResponse, WorkspaceOverviewResponse } from '../api';
import { useRemoteData } from '../hooks/useRemoteData';
import { SummaryCards } from '../components/SummaryCards';

interface PageData {
  overview: WorkspaceOverviewResponse;
  detail: SystemConfigsDetailResponse;
}

export function SystemConfigsPage() {

  const loader = useCallback(async () => {
    const [overview, detail] = await Promise.all([
      apiRequest<WorkspaceOverviewResponse>('/api/workspaces/system-configs', undefined),
      apiRequest<SystemConfigsDetailResponse>('/api/workspaces/system-configs/detail', undefined),
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

  const columns = useMemo<TableProps<SystemConfigsDetailResponse['rows'][number]>['columns']>(
    () => [
      { title: '配置键', dataIndex: 'key', width: 200 },
      { title: '说明', dataIndex: 'description', width: 200 },
      { title: '值(掩码)', dataIndex: 'maskedValue', width: 200, render: (v: string) => <Typography.Text code>{v}</Typography.Text> },
      { title: '修改人', dataIndex: 'updatedByName', width: 100, render: (v: string | null) => v ?? '-' },
      { title: '更新时间', dataIndex: 'updatedAt', width: 160 },
    ],
    [],
  );

  return (
    <PageContainer title="系统配置" subTitle="维护系统配置、参数开关和环境状态。" style={{ paddingInline: 0 }}
      extra={[<Button key="refresh" icon={<ReloadOutlined />} onClick={() => void reload()}>刷新</Button>]}
    >
      <div className="page-grid">
        <Alert type="warning" showIcon icon={<SettingOutlined />} message="配置安全提示" description="系统配置包含敏感信息，修改前请确认影响范围。所有变更将记录在操作日志中。" />
        {error && <Alert type="error" showIcon message={error} />}
        {loading || !data ? <Skeleton active paragraph={{ rows: 8 }} /> : (
          <>
            {summary.length > 0 && <SummaryCards items={summary} />}
            <div className="glass-panel" style={{ padding: 24 }}>
              <Table rowKey="key" dataSource={data.detail.rows} columns={columns} pagination={{ pageSize: 20 }} size="middle" />
            </div>
          </>
        )}
      </div>
    </PageContainer>
  );
}
