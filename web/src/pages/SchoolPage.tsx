import { ReloadOutlined, BookOutlined, CheckCircleOutlined } from '@ant-design/icons';
import { PageContainer } from '@ant-design/pro-components';
import { Alert, Button, Card, Col, Row, Skeleton, Table, Tag, Typography } from 'antd';
import type { TableProps } from 'antd';
import { useCallback, useMemo } from 'react';

import { apiRequest } from '../api';
import type { WorkspaceOverviewResponse } from '../api';
import { useRemoteData } from '../hooks/useRemoteData';

// 学堂功能：卖家学堂资源、教程和运营经验

const statusConfig: Record<string, { color: string; text: string }> = {
  todo: { color: 'default', text: '未学习' },
  in_progress: { color: 'processing', text: '学习中' },
  done: { color: 'success', text: '已完成' },
};

const priorityConfig: Record<string, { color: string; text: string }> = {
  high: { color: 'error', text: '必修' },
  medium: { color: 'warning', text: '推荐' },
  low: { color: 'default', text: '选修' },
};

export function SchoolPage() {

  const loader = useCallback(async () => {
    return apiRequest<WorkspaceOverviewResponse>(
      '/api/workspaces/school',
      undefined,
    );
  }, []);

  const { data, loading, error, reload } = useRemoteData<WorkspaceOverviewResponse>(loader);

  // 用 tasks 展示课程列表
  const courseColumns = useMemo<TableProps<WorkspaceOverviewResponse['tasks'][number]>['columns']>(
    () => [
      {
        title: '课程',
        dataIndex: 'title',
        width: 220,
        render: (val: string) => (
          <Typography.Text strong>{val}</Typography.Text>
        ),
      },
      { title: '描述', dataIndex: 'description', ellipsis: true },
      {
        title: '难度',
        dataIndex: 'priority',
        width: 90,
        render: (val: string) => {
          const cfg = priorityConfig[val] ?? { color: 'default', text: val };
          return <Tag color={cfg.color}>{cfg.text}</Tag>;
        },
      },
      {
        title: '进度',
        dataIndex: 'status',
        width: 100,
        render: (val: string) => {
          const cfg = statusConfig[val] ?? { color: 'default', text: val };
          return <Tag color={cfg.color}>{cfg.text}</Tag>;
        },
      },
      { title: '讲师', dataIndex: 'owner', width: 100 },
      { title: '截止日期', dataIndex: 'dueAt', width: 120 },
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

  // 完成统计
  const stats = useMemo(() => {
    if (!data?.tasks.length) return { total: 0, done: 0, inProgress: 0 };
    return {
      total: data.tasks.length,
      done: data.tasks.filter(t => t.status === 'done').length,
      inProgress: data.tasks.filter(t => t.status === 'in_progress').length,
    };
  }, [data]);

  return (
    <PageContainer
      title="卖家学堂"
      subTitle="闲鱼运营教程、卡密发货指南和 AI 策略学习资源。"
      style={{ paddingInline: 0 }}
      extra={[
        <Button key="refresh" icon={<ReloadOutlined />} onClick={() => void reload()}>刷新</Button>,
      ]}
    >
      <div className="page-grid">
        <Alert
          type="info"
          showIcon
          icon={<BookOutlined />}
          message="学堂使用说明"
          description="系统内置多种运营教程，覆盖商品上架、卡密管理、自动发货、AI 客服和议价策略等核心功能。完成课程可解锁高级功能。"
        />

        {error && <Alert type="error" showIcon message={error} />}

        {loading || !data ? (
          <Skeleton active paragraph={{ rows: 10 }} />
        ) : (
          <>
            {/* 概览 */}
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
                {/* 课程列表 */}
                <Card className="glass-panel" title="课程列表" bordered={false}
                  extra={
                    <Typography.Text type="secondary">
                      <CheckCircleOutlined style={{ color: '#52c41a', marginRight: 4 }} />
                      已完成 {stats.done}/{stats.total}
                    </Typography.Text>
                  }
                >
                  <Table
                    rowKey="id"
                    dataSource={data.tasks}
                    columns={courseColumns}
                    pagination={false}
                    size="middle"
                  />
                </Card>
              </Col>
              <Col xs={24} xl={8}>
                {/* 运营洞察 */}
                <Card className="glass-panel" title="运营知识库" bordered={false}>
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
                    <Typography.Text type="secondary">暂无知识库内容</Typography.Text>
                  )}
                </Card>
              </Col>
            </Row>

            {/* 学习日志 */}
            <Card className="glass-panel" title="学习记录" bordered={false}>
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
