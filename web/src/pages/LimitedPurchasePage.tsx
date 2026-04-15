import { ReloadOutlined, SafetyOutlined } from '@ant-design/icons';
import { PageContainer } from '@ant-design/pro-components';
import { Alert, Button, Card, Col, Row, Skeleton, Switch, Table, Tag, message } from 'antd';
import type { TableProps } from 'antd';
import { useCallback, useMemo } from 'react';

import { apiRequest } from '../api';
import type { WorkspaceOverviewResponse } from '../api';
import { useRemoteData } from '../hooks/useRemoteData';

// 限购功能：管理商品限购规则和触发记录

export function LimitedPurchasePage() {
  const [messageApi, contextHolder] = message.useMessage();

  const loader = useCallback(async () => {
    return apiRequest<WorkspaceOverviewResponse>(
      '/api/workspaces/limited-purchase',
      undefined,
    );
  }, []);

  const { data, loading, error, reload } = useRemoteData<WorkspaceOverviewResponse>(loader);

  const handleToggleRule = useCallback(
    async (ruleId: number, currentEnabled: boolean) => {
      try {
        await apiRequest(
          `/api/workspaces/limited-purchase/rules/${ruleId}/toggle`,
          { method: 'POST', body: JSON.stringify({ enabled: !currentEnabled }) },
        );
        messageApi.success(currentEnabled ? '规则已停用' : '规则已启用');
        await reload();
      } catch (err) {
        messageApi.error(err instanceof Error ? err.message : '操作失败');
      }
    },
    [messageApi, reload],
  );

  const ruleColumns = useMemo<TableProps<WorkspaceOverviewResponse['rules'][number]>['columns']>(
    () => [
      { title: '规则名称', dataIndex: 'name', width: 180 },
      { title: '规则描述', dataIndex: 'description', ellipsis: true },
      {
        title: '适用范围',
        dataIndex: 'scope',
        width: 140,
        render: (val: string) => <Tag color="blue">{val}</Tag>,
      },
      {
        title: '状态',
        dataIndex: 'enabled',
        width: 90,
        render: (val: boolean, row) => (
          <Switch
            size="small"
            checked={val}
            onChange={() => void handleToggleRule(row.id, val)}
          />
        ),
      },
      { title: '更新时间', dataIndex: 'updatedAt', width: 160 },
    ],
    [handleToggleRule],
  );

  const logColumns = useMemo<TableProps<WorkspaceOverviewResponse['logs'][number]>['columns']>(
    () => [
      {
        title: '类型',
        dataIndex: 'type',
        width: 100,
        render: (val: string) => <Tag>{val}</Tag>,
      },
      { title: '事件', dataIndex: 'title', width: 200 },
      { title: '详情', dataIndex: 'detail', ellipsis: true },
      { title: '时间', dataIndex: 'createdAt', width: 160 },
    ],
    [],
  );

  return (
    <PageContainer
      title="限购管理"
      subTitle="配置商品限购规则、限购周期和触发条件，保护店铺免受恶意刷单。"
      style={{ paddingInline: 0 }}
      extra={[
        <Button key="refresh" icon={<ReloadOutlined />} onClick={() => void reload()}>刷新</Button>,
      ]}
    >
      {contextHolder}
      <div className="page-grid">
        <Alert
          type="info"
          showIcon
          icon={<SafetyOutlined />}
          message="限购保护机制"
          description="限购规则生效后，系统将自动拦截超限订单并通知卖家。支持按买家、按商品、按时间段设置多维度限制。"
        />

        {error && <Alert type="error" showIcon message={error} />}

        {loading || !data ? (
          <Skeleton active paragraph={{ rows: 10 }} />
        ) : (
          <>
            {/* 概览卡片 */}
            <Row gutter={[16, 16]}>
              {data.summary.map((s) => (
                <Col xs={24} sm={8} key={s.label}>
                  <div className="module-summary-card">
                    <div className="module-summary-label">{s.label}</div>
                    <div className="module-summary-value">
                      {s.value}
                      <span className="module-summary-unit">{s.unit}</span>
                    </div>
                    <div className="module-summary-meta">{s.meta}</div>
                  </div>
                </Col>
              ))}
            </Row>

            {/* 规则表格 */}
            <Card className="glass-panel" title="限购规则配置" bordered={false}
              extra={<Tag color="gold">{data.rules.length} 条规则</Tag>}
            >
              <Table
                rowKey="id"
                dataSource={data.rules}
                columns={ruleColumns}
                pagination={false}
                size="middle"
              />
            </Card>

            {/* 触发日志 */}
            <Card className="glass-panel" title="最近触发日志" bordered={false}
              extra={<Tag>{data.logs.length} 条</Tag>}
            >
              <Table
                rowKey="id"
                dataSource={data.logs}
                columns={logColumns}
                pagination={{ pageSize: 10 }}
                size="middle"
              />
            </Card>
          </>
        )}
      </div>
    </PageContainer>
  );
}
