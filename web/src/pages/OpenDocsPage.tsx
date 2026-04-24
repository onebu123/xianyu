import { BookOutlined, ReloadOutlined } from '@ant-design/icons';
import { PageContainer } from '@ant-design/pro-components';
import { Alert, Button, Skeleton, Table, Tag, Typography } from 'antd';
import type { TableProps } from 'antd';
import { useCallback, useMemo } from 'react';

import { apiRequest } from '../api';
import type { OpenPlatformDocsDetailResponse } from '../api';
import { SummaryCards } from '../components/SummaryCards';
import { useRemoteData } from '../hooks/useRemoteData';

function statusColor(status: OpenPlatformDocsDetailResponse['docs'][number]['status']) {
  return (
    {
      published: 'success',
      draft: 'warning',
    }[status] ?? 'default'
  );
}

function statusLabel(status: OpenPlatformDocsDetailResponse['docs'][number]['status']) {
  return (
    {
      published: '已发布',
      draft: '草稿',
    }[status] ?? status
  );
}

export function OpenDocsPage() {
  const loader = useCallback(
    async () => apiRequest<OpenPlatformDocsDetailResponse>('/api/open-platform/docs', undefined),
    [],
  );

  const { data, loading, error, reload } = useRemoteData(loader);

  const summaryItems = useMemo(
    () =>
      (data?.metrics ?? []).map((metric, index) => ({
        key: `metric-${index}`,
        label: metric.label,
        value: typeof metric.value === 'string' ? metric.value : Number(metric.value ?? 0),
        unit: metric.unit,
      })),
    [data],
  );

  const columns = useMemo<TableProps<OpenPlatformDocsDetailResponse['docs'][number]>['columns']>(
    () => [
      {
        title: '文档',
        dataIndex: 'title',
        width: 220,
        render: (_value, row) => (
          <div className="store-cell-stack">
            <Typography.Text strong>{row.title}</Typography.Text>
            <div className="store-cell-meta">{row.category} 路 {row.versionTag}</div>
          </div>
        ),
      },
      {
        title: '接口',
        dataIndex: 'routePath',
        width: 320,
        render: (_value, row) => (
          <div className="store-cell-stack">
            <Typography.Text code>
              {row.httpMethod} {row.routePath}
            </Typography.Text>
            <div className="store-cell-meta">Scope：{row.scopeText}</div>
          </div>
        ),
      },
      {
        title: '说明',
        dataIndex: 'description',
        ellipsis: true,
      },
      {
        title: '状态',
        dataIndex: 'status',
        width: 120,
        render: (value: OpenPlatformDocsDetailResponse['docs'][number]['status']) => (
          <Tag color={statusColor(value)}>{statusLabel(value)}</Tag>
        ),
      },
      {
        title: '示例',
        dataIndex: 'samplePayload',
        width: 240,
        render: (value: string | null) => (
          <Typography.Text code style={{ whiteSpace: 'pre-wrap' }}>
            {value || '-'}
          </Typography.Text>
        ),
      },
    ],
    [],
  );

  return (
    <PageContainer
      title="接口文档"
      subTitle="集中维护开放平台公开接口、范围权限、版本标签和联调示例。"
      style={{ paddingInline: 0 }}
      extra={[
        <Button key="refresh" icon={<ReloadOutlined />} onClick={() => void reload()}>
          刷新
        </Button>,
      ]}
    >
      <div className="page-grid">
        <Alert
          type="info"
          showIcon
          icon={<BookOutlined />}
          message="文档中心"
          description="当前阶段已提供经营看板摘要和订单概览两条公开读取接口，履约回调协议已预留为草稿文档。"
        />
        {error && <Alert type="error" showIcon message={error} />}
        {loading || !data ? (
          <Skeleton active paragraph={{ rows: 8 }} />
        ) : (
          <>
            {summaryItems.length > 0 && <SummaryCards items={summaryItems} />}
            <div className="glass-panel" style={{ padding: 24 }}>
              <Typography.Title level={4} style={{ marginBottom: 16 }}>
                文档目录
              </Typography.Title>
              <Table
                rowKey="id"
                dataSource={data.docs}
                columns={columns}
                pagination={{ pageSize: 8, showSizeChanger: false }}
                scroll={{ x: 1240 }}
              />
            </div>
          </>
        )}
      </div>
    </PageContainer>
  );
}
