import { ReloadOutlined, WalletOutlined } from '@ant-design/icons';
import { PageContainer } from '@ant-design/pro-components';
import { Alert, Button, Card, Col, Row, Skeleton, Switch, Table, Tag, message } from 'antd';
import type { TableProps } from 'antd';
import { useCallback, useMemo } from 'react';

import { apiRequest } from '../api';
import type { WorkspaceOverviewResponse } from '../api';
import { useRemoteData } from '../hooks/useRemoteData';

// 闲鱼币功能：管理闲鱼币兑换规则和余额

export function FishCoinPage() {
  const [messageApi, contextHolder] = message.useMessage();

  const loader = useCallback(async () => {
    return apiRequest<WorkspaceOverviewResponse>(
      '/api/workspaces/fish-coin',
      undefined,
    );
  }, []);

  const { data, loading, error, reload } = useRemoteData<WorkspaceOverviewResponse>(loader);

  const handleToggleRule = useCallback(
    async (ruleId: number, currentEnabled: boolean) => {
      try {
        await apiRequest(
          `/api/workspaces/fish-coin/rules/${ruleId}/toggle`,
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

  const actionColumns = useMemo<TableProps<WorkspaceOverviewResponse['actions'][number]>['columns']>(
    () => [
      { title: '动作名称', dataIndex: 'title', width: 200 },
      { title: '说明', dataIndex: 'description', ellipsis: true },
      {
        title: '状态',
        dataIndex: 'status',
        width: 90,
        render: (val: string) => <Tag color="blue">{val}</Tag>,
      },
      { title: '执行次数', dataIndex: 'runCount', width: 100 },
      {
        title: '最近执行',
        dataIndex: 'lastRunAt',
        width: 160,
        render: (val: string | null) => val ?? '未执行',
      },
    ],
    [],
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
      title="闲鱼币管理"
      subTitle="管理闲鱼币兑换规则、余额监控和自动兑换策略。"
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
          icon={<WalletOutlined />}
          message="闲鱼币使用说明"
          description="闲鱼币可用于提升商品曝光度和搜索排名。系统自动追踪各店铺的闲鱼币余额变动和兑换记录。"
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

            <Row gutter={[16, 16]}>
              <Col xs={24} xl={14}>
                {/* 核心动作 */}
                <Card className="glass-panel" title="核心动作" bordered={false}>
                  <Table
                    rowKey="id"
                    dataSource={data.actions}
                    columns={actionColumns}
                    pagination={false}
                    size="middle"
                  />
                </Card>
              </Col>
              <Col xs={24} xl={10}>
                {/* 规则配置 */}
                <Card className="glass-panel" title="兑换规则" bordered={false}>
                  <Table
                    rowKey="id"
                    dataSource={data.rules}
                    columns={ruleColumns}
                    pagination={false}
                    size="middle"
                  />
                </Card>
              </Col>
            </Row>

            {/* 操作日志 */}
            <Card className="glass-panel" title="操作日志" bordered={false}>
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
