import { ReloadOutlined, PlusOutlined } from '@ant-design/icons';
import { PageContainer } from '@ant-design/pro-components';
import { Alert, Button, Skeleton, Table, Tag, Typography, message } from 'antd';
import type { TableProps } from 'antd';
import { useCallback, useMemo } from 'react';

import { apiRequest } from '../api';
import type { CardTypesDetailResponse, WorkspaceOverviewResponse } from '../api';
import { useRemoteData } from '../hooks/useRemoteData';
import { formatNumber, formatCurrency } from '../utils';
import { SummaryCards } from '../components/SummaryCards';

interface PageData {
  overview: WorkspaceOverviewResponse;
  detail: CardTypesDetailResponse;
}

export function CardTypesPage() {
  const [messageApi, contextHolder] = message.useMessage();

  const loader = useCallback(async () => {
    const [overview, detail] = await Promise.all([
      apiRequest<WorkspaceOverviewResponse>('/api/workspaces/card-types', undefined),
      apiRequest<CardTypesDetailResponse>('/api/workspaces/card-types/detail', undefined),
    ]);
    return { overview, detail } as PageData;
  }, []);

  const { data, loading, error, reload } = useRemoteData<PageData>(loader);

  const summary = useMemo(() => {
    if (!data?.detail?.metrics) return [];
    return data.detail.metrics.map((m, i) => ({
      key: `metric-${i}`,
      label: m.label,
      value: typeof m.value === 'string' ? parseFloat(m.value) || 0 : m.value,
      unit: m.unit,
    }));
  }, [data]);

  const handleImport = useCallback(
    async (cardTypeId: number) => {
      try {
        await apiRequest(
          `/api/workspaces/card-types/card-types/${cardTypeId}/import`,
          { method: 'POST', body: '{}' },
        );
        messageApi.success('卡密已导入');
        await reload();
      } catch (err) {
        messageApi.error(err instanceof Error ? err.message : '导入失败');
      }
    },
    [messageApi, reload],
  );

  const handleToggleInventory = useCallback(
    async (cardTypeId: number) => {
      try {
        await apiRequest(
          `/api/workspaces/card-types/card-types/${cardTypeId}/inventory-sample/toggle`,
          { method: 'POST', body: '{}' },
        );
        messageApi.success('样卡状态已更新');
        await reload();
      } catch (err) {
        messageApi.error(err instanceof Error ? err.message : '操作失败');
      }
    },
    [messageApi, reload],
  );

  const columns = useMemo<TableProps<CardTypesDetailResponse['rows'][number]>['columns']>(
    () => [
      {
        title: '卡种 ID',
        dataIndex: 'id',
        width: 90,
        render: (val: number) => <Typography.Text strong>#{val}</Typography.Text>,
      },
      {
        title: '卡种名称',
        dataIndex: 'typeName',
        width: 160,
      },
      {
        title: '可用库存',
        dataIndex: 'availableCount',
        width: 110,
        sorter: (a, b) => a.availableCount - b.availableCount,
        render: (val: number) => (
          <Tag color={val > 10 ? 'success' : val > 0 ? 'warning' : 'error'}>
            {formatNumber(val, ' 张')}
          </Tag>
        ),
      },
      {
        title: '已锁定',
        dataIndex: 'lockedCount',
        width: 90,
        render: (val: number) => formatNumber(val, ' 张'),
      },
      {
        title: '已售出',
        dataIndex: 'soldCount',
        width: 90,
        render: (val: number) => formatNumber(val, ' 张'),
      },
      {
        title: '已禁用',
        dataIndex: 'disabledCount',
        width: 90,
        render: (val: number) => formatNumber(val, ' 张'),
      },
      {
        title: '发货通道',
        dataIndex: 'deliveryChannel',
        width: 120,
        render: (val: string) => <Tag color="blue">{val}</Tag>,
      },
      {
        title: '库存成本',
        dataIndex: 'inventoryCost',
        width: 110,
        render: (val: number) => formatCurrency(val),
      },
      {
        title: '均价',
        dataIndex: 'averagePrice',
        width: 100,
        render: (val: number) => formatCurrency(val),
      },
      {
        title: '关联模板',
        dataIndex: 'templateCount',
        width: 100,
        render: (val: number) => formatNumber(val, ' 个'),
      },
      {
        title: '最近导入',
        dataIndex: 'lastImportedAt',
        width: 160,
      },
      {
        title: '操作',
        key: 'action',
        fixed: 'right',
        width: 140,
        render: (_val: unknown, row) => (
          <Button.Group size="small">
            <Button type="link" onClick={() => void handleImport(row.id)}>导入</Button>
            <Button type="link" onClick={() => void handleToggleInventory(row.id)}>样卡</Button>
          </Button.Group>
        ),
      },
    ],
    [handleImport, handleToggleInventory],
  );

  return (
    <PageContainer
      title="卡种管理"
      subTitle="维护虚拟商品卡种资料、规格配置与库存数量，支持批量导入与实时库存监控。"
      style={{ paddingInline: 0 }}
      extra={[
        <Button key="import" icon={<PlusOutlined />} type="primary">新增卡种</Button>,
        <Button key="refresh" icon={<ReloadOutlined />} onClick={() => void reload()}>刷新</Button>,
      ]}
    >
      {contextHolder}
      <div className="page-grid">
        <Alert
          type="info"
          showIcon
          message="卡种与库存联动说明"
          description="卡种创建后可关联发货模板和交付通道。库存数量实时同步至发货系统，当可用库存归零时将触发低库存告警。"
        />

        {error && <Alert type="error" showIcon message={error} />}

        {loading || !data ? (
          <Skeleton active paragraph={{ rows: 10 }} />
        ) : (
          <>
            {summary.length > 0 && <SummaryCards items={summary} />}

            <div className="glass-panel" style={{ padding: 24 }}>
              <Typography.Title level={4} style={{ marginBottom: 16 }}>卡种库存列表</Typography.Title>
              <Table
                rowKey="id"
                dataSource={data.detail.rows}
                columns={columns}
                pagination={{ pageSize: 15, showSizeChanger: true }}
                scroll={{ x: 1400 }}
                size="middle"
              />
            </div>
          </>
        )}
      </div>
    </PageContainer>
  );
}
