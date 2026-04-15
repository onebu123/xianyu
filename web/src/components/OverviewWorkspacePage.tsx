import type { ReactNode } from 'react';
import { ReloadOutlined } from '@ant-design/icons';
import { PageContainer } from '@ant-design/pro-components';
import { Alert, Button, Skeleton, Table, Tag, Typography } from 'antd';
import type { TableProps } from 'antd';
import { useMemo } from 'react';

import type { WorkspaceOverviewResponse } from '../api';
import { useWorkspaceData, useOverviewSummary } from '../hooks/useWorkspaceData';
import { SummaryCards } from './SummaryCards';

export interface OverviewPageConfig {
  featureKey: string;
  title: string;
  subTitle: string;
  icon: ReactNode;
  alertMessage: string;
  alertDescription: string;
  alertType?: 'info' | 'warning';
  /** 表格列标题映射: title / status / description */
  columnLabels?: { title?: string; status?: string; description?: string };
  /** 状态值到标签的映射 */
  statusLabels?: Record<string, { color: string; text: string }>;
  /** 列表标题 */
  listTitle?: string;
}

const defaultStatusLabels: Record<string, { color: string; text: string }> = {
  done: { color: 'success', text: '完成' },
  active: { color: 'processing', text: '进行中' },
  pending: { color: 'default', text: '待处理' },
};

/**
 * Overview-only 工作台页面通用组件
 * 替代 8 个几乎完全相同的 62 行页面
 */
export function OverviewWorkspacePage({ config }: { config: OverviewPageConfig }) {
  const { overview, loading, error, reload } = useWorkspaceData(
    config.featureKey,
    false,
  );

  const summary = useOverviewSummary(overview);

  const tableData = useMemo(() => {
    if (!(overview as WorkspaceOverviewResponse)?.tasks) return [];
    return (overview as WorkspaceOverviewResponse).tasks.map((t, i) => ({ key: i, ...t }));
  }, [overview]);

  const statusMap = config.statusLabels ?? defaultStatusLabels;

  const columns = useMemo<TableProps['columns']>(
    () => [
      { title: config.columnLabels?.title ?? '项目', dataIndex: 'title', width: 200 },
      {
        title: config.columnLabels?.status ?? '状态',
        dataIndex: 'status',
        width: 90,
        render: (v: string) => {
          const s = statusMap[v] ?? { color: 'default', text: v };
          return <Tag color={s.color}>{s.text}</Tag>;
        },
      },
      { title: config.columnLabels?.description ?? '说明', dataIndex: 'description', ellipsis: true },
    ],
    [config.columnLabels, statusMap],
  );

  return (
    <PageContainer
      title={config.title}
      subTitle={config.subTitle}
      style={{ paddingInline: 0 }}
      extra={[<Button key="refresh" icon={<ReloadOutlined />} onClick={() => void reload()}>刷新</Button>]}
    >
      <div className="page-grid">
        <Alert type={config.alertType ?? 'info'} showIcon icon={config.icon} message={config.alertMessage} description={config.alertDescription} />
        {error && <Alert type="error" showIcon message={error} />}
        {loading || !overview ? <Skeleton active paragraph={{ rows: 6 }} /> : (
          <>
            {summary.length > 0 && <SummaryCards items={summary} />}
            <div className="glass-panel" style={{ padding: 24 }}>
              {config.listTitle && <Typography.Title level={4} style={{ marginBottom: 16 }}>{config.listTitle}</Typography.Title>}
              <Table dataSource={tableData} columns={columns} pagination={false} size="middle" />
            </div>
          </>
        )}
      </div>
    </PageContainer>
  );
}
