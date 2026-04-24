import { HistoryOutlined, ReloadOutlined, RetweetOutlined } from '@ant-design/icons';
import { PageContainer } from '@ant-design/pro-components';
import { Alert, Button, Select, Space, Table, Tag, Typography, message } from 'antd';
import type { TableProps } from 'antd';
import { useCallback, useMemo, useState } from 'react';

import { apiRequest } from '../api';
import type {
  PlatformProvisioningJob,
  PlatformProvisioningJobListResponse,
  PlatformTenantListResponse,
} from '../api';
import { useRemoteData } from '../hooks/useRemoteData';

interface PageData {
  tenants: PlatformTenantListResponse;
  jobs: PlatformProvisioningJobListResponse;
}

function jobStatusColor(status: PlatformProvisioningJob['status']) {
  return (
    {
      pending: 'default',
      running: 'processing',
      succeeded: 'success',
      failed: 'error',
    }[status] ?? 'default'
  );
}

function jobStatusLabel(status: PlatformProvisioningJob['status']) {
  return (
    {
      pending: '待处理',
      running: '执行中',
      succeeded: '已成功',
      failed: '已失败',
    }[status] ?? status
  );
}

export function PlatformProvisioningJobsPage() {
  const [messageApi, contextHolder] = message.useMessage();
  const [tenantId, setTenantId] = useState<number | undefined>(undefined);
  const [retryingJobId, setRetryingJobId] = useState<number | null>(null);

  const loader = useCallback(async () => {
    const query = tenantId ? `?tenantId=${tenantId}` : '';
    const [tenants, jobs] = await Promise.all([
      apiRequest<PlatformTenantListResponse>('/api/platform/tenants', undefined),
      apiRequest<PlatformProvisioningJobListResponse>(`/api/platform/provisioning-jobs${query}`, undefined),
    ]);
    return { tenants, jobs } as PageData;
  }, [tenantId]);

  const { data, loading, error, reload } = useRemoteData<PageData>(loader);
  const tenantNameMap = useMemo(
    () =>
      new Map((data?.tenants.list ?? []).map((tenant) => [tenant.id, tenant.displayName])),
    [data],
  );

  const columns = useMemo<TableProps<PlatformProvisioningJob>['columns']>(
    () => [
      {
        title: '任务编号',
        dataIndex: 'id',
        width: 100,
      },
      {
        title: '租户',
        dataIndex: 'tenantId',
        width: 180,
        render: (value: number) => tenantNameMap.get(value) ?? `租户 #${value}`,
      },
      {
        title: '状态',
        dataIndex: 'status',
        width: 120,
        render: (value: PlatformProvisioningJob['status']) => (
          <Tag color={jobStatusColor(value)}>{jobStatusLabel(value)}</Tag>
        ),
      },
      {
        title: '详情',
        dataIndex: 'detail',
        render: (value: string | null) => (
          <Typography.Text type={value ? 'secondary' : undefined}>{value ?? '-'}</Typography.Text>
        ),
      },
      {
        title: '更新时间',
        dataIndex: 'updatedAt',
        width: 180,
      },
      {
        title: '操作',
        key: 'actions',
        width: 140,
        render: (_, row) => (
          <Button
            size="small"
            icon={<RetweetOutlined />}
            loading={retryingJobId === row.id}
            disabled={row.status !== 'failed'}
            onClick={async () => {
              setRetryingJobId(row.id);
              try {
                await apiRequest(`/api/platform/provisioning-jobs/${row.id}/retry`, {
                  method: 'POST',
                  body: '{}',
                });
                messageApi.success('已重新执行租户开通任务');
                await reload();
              } catch (requestError) {
                messageApi.error(requestError instanceof Error ? requestError.message : '重试开通任务失败');
              } finally {
                setRetryingJobId(null);
              }
            }}
          >
            重试
          </Button>
        ),
      },
    ],
    [messageApi, reload, retryingJobId, tenantNameMap],
  );

  return (
    <PageContainer
      title="租户开通任务"
      subTitle="查看租户业务库初始化任务、失败原因和重试执行结果。"
      style={{ paddingInline: 0 }}
      extra={[
        <Button key="reload" icon={<ReloadOutlined />} onClick={() => void reload()}>
          刷新
        </Button>,
      ]}
    >
      {contextHolder}
      <div className="page-grid">
        <Alert
          type="info"
          showIcon
          icon={<HistoryOutlined />}
          message="任务说明"
          description="租户创建时会触发业务库初始化任务。失败任务可直接在这里重试，不需要离开控制面。"
        />
        {error ? <Alert type="error" showIcon message={error} /> : null}

        <div className="glass-panel" style={{ padding: 24 }}>
          <Space style={{ marginBottom: 16 }} wrap>
            <Typography.Text type="secondary">按租户筛选</Typography.Text>
            <Select
              allowClear
              style={{ minWidth: 240 }}
              placeholder="全部租户"
              value={tenantId}
              onChange={(value) => setTenantId(value)}
              options={(data?.tenants.list ?? []).map((tenant) => ({
                value: tenant.id,
                label: tenant.displayName,
              }))}
            />
          </Space>
          <Table
            rowKey="id"
            loading={loading}
            dataSource={data?.jobs.list ?? []}
            columns={columns}
            pagination={{ pageSize: 10 }}
          />
        </div>
      </div>
    </PageContainer>
  );
}
