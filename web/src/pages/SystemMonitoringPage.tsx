import { ReloadOutlined, CheckCircleOutlined, WarningOutlined } from '@ant-design/icons';
import { PageContainer } from '@ant-design/pro-components';
import { Alert, Button, Card, Col, Row, Skeleton, Table, Tag, Typography } from 'antd';
import type { TableProps } from 'antd';
import { useCallback, useMemo, useState } from 'react';

import { apiRequest } from '../api';
import type { SystemMonitoringDetailResponse, WorkspaceOverviewResponse } from '../api';
import { useRemoteData } from '../hooks/useRemoteData';
import { SummaryCards } from '../components/SummaryCards';

interface PageData {
  overview: WorkspaceOverviewResponse;
  detail: SystemMonitoringDetailResponse;
}

export function SystemMonitoringPage() {
  const [activeTab, setActiveTab] = useState<string>('alerts');

  const loader = useCallback(async () => {
    const [overview, detail] = await Promise.all([
      apiRequest<WorkspaceOverviewResponse>('/api/workspaces/system-monitoring', undefined),
      apiRequest<SystemMonitoringDetailResponse>('/api/workspaces/system-monitoring/detail', undefined),
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

  const alertColumns = useMemo<TableProps<SystemMonitoringDetailResponse['alerts'][number]>['columns']>(
    () => [
      { title: '类型', dataIndex: 'alertTypeText', width: 120 },
      { title: '严重度', dataIndex: 'severity', width: 80, render: (v: string) => <Tag color={v === 'critical' ? 'error' : 'warning'}>{v === 'critical' ? '严重' : '警告'}</Tag> },
      { title: '标题', dataIndex: 'title', width: 200, ellipsis: true },
      { title: '状态', dataIndex: 'status', width: 80, render: (v: string) => <Tag color={v === 'open' ? 'error' : v === 'acknowledged' ? 'warning' : 'success'}>{v === 'open' ? '待处理' : v === 'acknowledged' ? '已确认' : '已解决'}</Tag> },
      { title: '来源数', dataIndex: 'sourceCount', width: 70 },
      { title: '首次触发', dataIndex: 'firstTriggeredAt', width: 160 },
      { title: '最近触发', dataIndex: 'lastTriggeredAt', width: 160 },
    ],
    [],
  );

  const jobColumns = useMemo<TableProps<SystemMonitoringDetailResponse['jobMonitors'][number]>['columns']>(
    () => [
      { title: '模块', dataIndex: 'groupLabel', width: 120 },
      { title: '待处理', dataIndex: 'pendingCount', width: 80, render: (v: number) => v > 0 ? <Tag color="processing">{v}</Tag> : v },
      { title: '失败', dataIndex: 'failedCount', width: 80, render: (v: number) => v > 0 ? <Tag color="error">{v}</Tag> : v },
      { title: '人工', dataIndex: 'manualCount', width: 80, render: (v: number) => v > 0 ? <Tag color="warning">{v}</Tag> : v },
      { title: '备注', dataIndex: 'note', ellipsis: true },
      { title: '最近更新', dataIndex: 'latestUpdatedAt', width: 160, render: (v: string | null) => v ?? '-' },
    ],
    [],
  );

  const backupColumns = useMemo<TableProps<SystemMonitoringDetailResponse['backups'][number]>['columns']>(
    () => [
      { title: '备份号', dataIndex: 'backupNo', width: 140 },
      { title: '类型', dataIndex: 'backupType', width: 80, render: (v: string) => <Tag>{v === 'manual' ? '手动' : '定时'}</Tag> },
      { title: '状态', dataIndex: 'runStatus', width: 80, render: (v: string) => <Tag color={v === 'success' ? 'success' : 'error'}>{v === 'success' ? '成功' : '失败'}</Tag> },
      { title: '文件', dataIndex: 'fileName', width: 180, ellipsis: true },
      { title: '大小', dataIndex: 'fileSize', width: 100, render: (v: number) => `${(v / 1024 / 1024).toFixed(2)} MB` },
      { title: '开始时间', dataIndex: 'startedAt', width: 160 },
    ],
    [],
  );

  const health = data?.detail.health;

  const tabList = [
    { key: 'alerts', tab: `告警 (${data?.detail.alerts.length ?? 0})` },
    { key: 'jobs', tab: `任务监控 (${data?.detail.jobMonitors.length ?? 0})` },
    { key: 'backups', tab: `备份 (${data?.detail.backups.length ?? 0})` },
  ];

  return (
    <PageContainer title="系统监控" subTitle="查看告警、任务监控、备份归档和恢复演练。" style={{ paddingInline: 0 }}
      extra={[<Button key="refresh" icon={<ReloadOutlined />} onClick={() => void reload()}>刷新</Button>]}
    >
      <div className="page-grid">
        {error && <Alert type="error" showIcon message={error} />}
        {loading || !data ? <Skeleton active paragraph={{ rows: 10 }} /> : (
          <>
            {summary.length > 0 && <SummaryCards items={summary} />}

            {health && (
              <Card className="glass-panel" title="系统健康" bordered={false} size="small"
                extra={<Tag color={health.apiStatus === 'healthy' ? 'success' : 'warning'} icon={health.apiStatus === 'healthy' ? <CheckCircleOutlined /> : <WarningOutlined />}>{health.apiStatus === 'healthy' ? '正常' : '警告'}</Tag>}
              >
                <Row gutter={[24, 8]}>
                  <Col span={8}><Typography.Text type="secondary">数据库大小:</Typography.Text> <Typography.Text>{(health.databaseSizeBytes / 1024 / 1024).toFixed(2)} MB</Typography.Text></Col>
                  <Col span={8}><Typography.Text type="secondary">最近备份:</Typography.Text> <Typography.Text>{health.latestBackupAt ?? '无'}</Typography.Text></Col>
                  <Col span={8}><Typography.Text type="secondary">最近恢复演练:</Typography.Text> <Typography.Text>{health.latestRecoveryAt ?? '无'}</Typography.Text></Col>
                </Row>
              </Card>
            )}

            <Card className="glass-panel" bordered={false} tabList={tabList} activeTabKey={activeTab} onTabChange={setActiveTab}>
              {activeTab === 'alerts' && <Table rowKey="id" dataSource={data.detail.alerts} columns={alertColumns} pagination={{ pageSize: 10 }} scroll={{ x: 1000 }} size="middle" />}
              {activeTab === 'jobs' && <Table rowKey="groupKey" dataSource={data.detail.jobMonitors} columns={jobColumns} pagination={false} size="middle" />}
              {activeTab === 'backups' && <Table rowKey="id" dataSource={data.detail.backups} columns={backupColumns} pagination={{ pageSize: 10 }} scroll={{ x: 900 }} size="middle" />}
            </Card>
          </>
        )}
      </div>
    </PageContainer>
  );
}
