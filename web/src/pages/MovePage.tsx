import { ReloadOutlined, SwapOutlined } from '@ant-design/icons';
import { PageContainer } from '@ant-design/pro-components';
import { Alert, Button, Card, Col, Progress, Row, Skeleton, Table, Tag, Typography } from 'antd';
import type { TableProps } from 'antd';
import { useCallback, useMemo } from 'react';

import { apiRequest } from '../api';
import type { WorkspaceOverviewResponse } from '../api';
import { useRemoteData } from '../hooks/useRemoteData';

// 搬家功能：跨店商品搬家和批量迁移任务管理

const priorityConfig: Record<string, { color: string; text: string }> = {
  high: { color: 'error', text: '高' },
  medium: { color: 'warning', text: '中' },
  low: { color: 'default', text: '低' },
};

const statusConfig: Record<string, { color: string; text: string }> = {
  todo: { color: 'default', text: '待处理' },
  in_progress: { color: 'processing', text: '进行中' },
  done: { color: 'success', text: '已完成' },
};

export function MovePage() {

  const loader = useCallback(async () => {
    return apiRequest<WorkspaceOverviewResponse>(
      '/api/workspaces/move',
      undefined,
    );
  }, []);

  const { data, loading, error, reload } = useRemoteData<WorkspaceOverviewResponse>(loader);

  const taskColumns = useMemo<TableProps<WorkspaceOverviewResponse['tasks'][number]>['columns']>(
    () => [
      { title: '任务', dataIndex: 'title', width: 200 },
      { title: '说明', dataIndex: 'description', ellipsis: true },
      { title: '负责人', dataIndex: 'owner', width: 100 },
      {
        title: '优先级',
        dataIndex: 'priority',
        width: 80,
        render: (val: string) => {
          const cfg = priorityConfig[val] ?? { color: 'default', text: val };
          return <Tag color={cfg.color}>{cfg.text}</Tag>;
        },
      },
      {
        title: '状态',
        dataIndex: 'status',
        width: 100,
        render: (val: string) => {
          const cfg = statusConfig[val] ?? { color: 'default', text: val };
          return <Tag color={cfg.color}>{cfg.text}</Tag>;
        },
      },
      { title: '截止时间', dataIndex: 'dueAt', width: 130 },
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

  // 计算任务进度
  const taskProgress = useMemo(() => {
    if (!data?.tasks.length) return { total: 0, done: 0, percent: 0 };
    const total = data.tasks.length;
    const done = data.tasks.filter(t => t.status === 'done').length;
    return { total, done, percent: Math.round((done / total) * 100) };
  }, [data]);

  return (
    <PageContainer
      title="搬家管理"
      subTitle="管理跨店商品搬家任务、批量迁移进度和搬家规则配置。"
      style={{ paddingInline: 0 }}
      extra={[
        <Button key="refresh" icon={<ReloadOutlined />} onClick={() => void reload()}>刷新</Button>,
      ]}
    >
      <div className="page-grid">
        <Alert
          type="info"
          showIcon
          icon={<SwapOutlined />}
          message="商品搬家说明"
          description="支持将商品从一个店铺批量搬家到另一个店铺，自动同步标题、价格、图片和自定义属性。"
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
              <Col xs={24} xl={16}>
                {/* 搬家任务列表 */}
                <Card className="glass-panel" title="搬家任务" bordered={false}
                  extra={
                    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                      <Typography.Text type="secondary">
                        {taskProgress.done}/{taskProgress.total} 完成
                      </Typography.Text>
                      <Progress
                        type="circle"
                        percent={taskProgress.percent}
                        size={32}
                        strokeColor="#6c5ce7"
                      />
                    </div>
                  }
                >
                  <Table
                    rowKey="id"
                    dataSource={data.tasks}
                    columns={taskColumns}
                    pagination={false}
                    size="middle"
                  />
                </Card>
              </Col>
              <Col xs={24} xl={8}>
                {/* 模块洞察 */}
                <Card className="glass-panel" title="模块洞察" bordered={false}>
                  {data.insights.length > 0 ? (
                    data.insights.map((insight, i) => (
                      <div key={i} style={{ marginBottom: 16 }}>
                        <Typography.Text strong>{insight.title}</Typography.Text>
                        <Typography.Paragraph type="secondary" style={{ marginTop: 4, marginBottom: 0 }}>
                          {insight.content}
                        </Typography.Paragraph>
                      </div>
                    ))
                  ) : (
                    <Typography.Text type="secondary">暂无洞察数据</Typography.Text>
                  )}
                </Card>
              </Col>
            </Row>

            {/* 操作日志 */}
            <Card className="glass-panel" title="搬家日志" bordered={false}>
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
