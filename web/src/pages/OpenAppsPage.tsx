import { ApiOutlined, PlusOutlined, ReloadOutlined } from '@ant-design/icons';
import { PageContainer } from '@ant-design/pro-components';
import {
  Alert,
  Button,
  Form,
  Input,
  InputNumber,
  Modal,
  Select,
  Skeleton,
  Space,
  Table,
  Tag,
  Typography,
  message,
} from 'antd';
import type { TableProps } from 'antd';
import { useCallback, useMemo, useState } from 'react';

import { apiRequest } from '../api';
import type { OpenPlatformAppsDetailResponse } from '../api';
import { SummaryCards } from '../components/SummaryCards';
import { useRemoteData } from '../hooks/useRemoteData';

interface CreateAppFormValues {
  appName: string;
  ownerName: string;
  contactName?: string;
  callbackUrl?: string;
  rateLimitPerMinute?: number;
  scopes: string[];
}

function appStatusColor(status: OpenPlatformAppsDetailResponse['apps'][number]['status']) {
  return (
    {
      active: 'success',
      suspended: 'error',
      draft: 'default',
    }[status] ?? 'default'
  );
}

function appStatusLabel(status: OpenPlatformAppsDetailResponse['apps'][number]['status']) {
  return (
    {
      active: '启用中',
      suspended: '已停用',
      draft: '草稿',
    }[status] ?? status
  );
}

function callStatusColor(status: OpenPlatformAppsDetailResponse['recentCalls'][number]['callStatus']) {
  return (
    {
      success: 'success',
      blocked: 'warning',
      failure: 'error',
    }[status] ?? 'default'
  );
}

function callStatusLabel(status: OpenPlatformAppsDetailResponse['recentCalls'][number]['callStatus']) {
  return (
    {
      success: '成功',
      blocked: '拦截',
      failure: '失败',
    }[status] ?? status
  );
}

export function OpenAppsPage() {
  const [messageApi, contextHolder] = message.useMessage();
  const [createOpen, setCreateOpen] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [form] = Form.useForm<CreateAppFormValues>();

  const loader = useCallback(
    async () => apiRequest<OpenPlatformAppsDetailResponse>('/api/open-platform/apps', undefined),
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

  const runAction = useCallback(
    async (key: string, action: () => Promise<void>, successMessage: string) => {
      setBusyKey(key);
      try {
        await action();
        messageApi.success(successMessage);
        await reload();
      } catch (requestError) {
        messageApi.error(requestError instanceof Error ? requestError.message : '操作失败');
      } finally {
        setBusyKey(null);
      }
    },
    [messageApi, reload],
  );

  const submitCreate = useCallback(async () => {
    const values = await form.validateFields();
    setBusyKey('create-app');
    try {
      const created = await apiRequest<OpenPlatformAppsDetailResponse['apps'][number] & { secretPlainText: string }>(
        '/api/open-platform/apps',
        {
          method: 'POST',
          body: JSON.stringify(values),
        },
      );
      setCreateOpen(false);
      form.resetFields();
      Modal.success({
        title: '应用已创建',
        content: (
          <Space direction="vertical" style={{ width: '100%' }}>
            <Typography.Text>应用密钥：{created.appKey}</Typography.Text>
            <Typography.Text copyable={{ text: created.secretPlainText }}>
              签名密钥：{created.secretPlainText}
            </Typography.Text>
            <Typography.Text type="secondary">
              密钥只会在创建或轮换时展示一次，请立即保存到对接系统。
            </Typography.Text>
          </Space>
        ),
      });
      await reload();
    } catch (requestError) {
      messageApi.error(requestError instanceof Error ? requestError.message : '创建应用失败');
    } finally {
      setBusyKey(null);
    }
  }, [form, messageApi, reload]);

  const columns = useMemo<TableProps<OpenPlatformAppsDetailResponse['apps'][number]>['columns']>(
    () => [
      {
        title: '应用',
        dataIndex: 'appName',
        width: 220,
        render: (_value, row) => (
          <div className="store-cell-stack">
            <Typography.Text strong>{row.appName}</Typography.Text>
            <div className="store-cell-meta">App Key：{row.appKey}</div>
            <div className="store-cell-meta">负责人：{row.ownerName}</div>
          </div>
        ),
      },
      {
        title: '权限与回调',
        dataIndex: 'scopes',
        width: 260,
        render: (_value, row) => (
          <div className="store-cell-stack">
            <div className="store-tag-list">
              {row.scopes.map((scope) => (
                <Tag key={`${row.id}-${scope}`} color="geekblue">
                  {scope}
                </Tag>
              ))}
            </div>
            <div className="store-cell-meta">{row.callbackUrl || '未配置回调地址'}</div>
            <div className="store-cell-meta">{row.contactName || '未配置联系人'}</div>
          </div>
        ),
      },
      {
        title: '状态',
        dataIndex: 'status',
        width: 160,
        render: (_value, row) => (
          <div className="store-cell-stack">
            <Space wrap>
              <Tag color={appStatusColor(row.status)}>{appStatusLabel(row.status)}</Tag>
              <Tag>{row.rateLimitPerMinute} 次/分钟</Tag>
            </Space>
            <div className="store-cell-meta">最近调用：{row.lastCalledAt ?? '暂无'}</div>
          </div>
        ),
      },
      {
        title: '近 7 天调用',
        dataIndex: 'totalCallCount',
        width: 180,
        render: (_value, row) => (
          <div className="store-cell-stack">
            <div className="store-cell-meta">总调用：{row.totalCallCount}</div>
            <div className="store-cell-meta">成功：{row.successCount}</div>
            <div className="store-cell-meta">拦截/失败：{row.blockedCount + row.failureCount}</div>
          </div>
        ),
      },
      {
        title: '签名密钥',
        dataIndex: 'secretMasked',
        width: 190,
        render: (value: string) => (
          <div className="store-cell-stack">
            <Typography.Text code>{value}</Typography.Text>
            <div className="store-cell-meta">密钥已脱敏存储</div>
          </div>
        ),
      },
      {
        title: '操作',
        key: 'actions',
        width: 220,
        fixed: 'right',
        render: (_value, row) => (
          <Space wrap>
            <Button
              size="small"
              loading={busyKey === `toggle-${row.id}`}
              onClick={() =>
                void runAction(
                  `toggle-${row.id}`,
                  async () => {
                    await apiRequest(`/api/open-platform/apps/${row.id}/status`, {
                      method: 'POST',
                      body: JSON.stringify({
                        status: row.status === 'active' ? 'suspended' : 'active',
                      }),
                    });
                  },
                  row.status === 'active' ? `已停用 ${row.appName}` : `已启用 ${row.appName}`,
                )
              }
            >
              {row.status === 'active' ? '停用' : '启用'}
            </Button>
            <Button
              size="small"
              loading={busyKey === `rotate-${row.id}`}
              onClick={() =>
                void runAction(
                  `rotate-${row.id}`,
                  async () => {
                    const payload = await apiRequest<{
                      appKey: string;
                      secretPlainText: string;
                      secretMasked: string;
                    }>(`/api/open-platform/apps/${row.id}/secret/rotate`, {
                      method: 'POST',
                      body: '{}',
                    });
                    Modal.success({
                      title: '签名密钥已轮换',
                      content: (
                        <Space direction="vertical" style={{ width: '100%' }}>
                          <Typography.Text>应用：{payload.appKey}</Typography.Text>
                          <Typography.Text copyable={{ text: payload.secretPlainText }}>
                            新密钥：{payload.secretPlainText}
                          </Typography.Text>
                          <Typography.Text type="secondary">
                            请同步更新调用方的签名配置。
                          </Typography.Text>
                        </Space>
                      ),
                    });
                  },
                  `已轮换 ${row.appName} 的签名密钥`,
                )
              }
            >
              轮换密钥
            </Button>
          </Space>
        ),
      },
    ],
    [busyKey, runAction],
  );

  const callColumns = useMemo<
    TableProps<OpenPlatformAppsDetailResponse['recentCalls'][number]>['columns']
  >(
    () => [
      {
        title: '时间',
        dataIndex: 'createdAt',
        width: 180,
      },
      {
        title: '应用',
        dataIndex: 'appKey',
        width: 140,
        render: (value: string) => <Tag color="blue">{value}</Tag>,
      },
      {
        title: '请求',
        dataIndex: 'routePath',
        render: (_value, row) => (
          <div className="store-cell-stack">
            <Typography.Text>{row.httpMethod} {row.routePath}</Typography.Text>
            <div className="store-cell-meta">来源：{row.requestIp ?? '未知'} 路 Trace：{row.traceId}</div>
          </div>
        ),
      },
      {
        title: '结果',
        dataIndex: 'callStatus',
        width: 140,
        render: (_value, row) => (
          <Space wrap>
            <Tag color={callStatusColor(row.callStatus)}>{callStatusLabel(row.callStatus)}</Tag>
            <Tag>{row.statusCode}</Tag>
          </Space>
        ),
      },
      {
        title: '详情',
        dataIndex: 'detail',
        width: 220,
        ellipsis: true,
      },
    ],
    [],
  );

  return (
    <PageContainer
      title="开放应用"
      subTitle="管理租户开放平台应用、签名密钥、回调地址和近 7 天调用情况。"
      style={{ paddingInline: 0 }}
      extra={[
        <Button key="refresh" icon={<ReloadOutlined />} onClick={() => void reload()}>
          刷新
        </Button>,
        <Button key="create" type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
          新建应用
        </Button>,
      ]}
    >
      {contextHolder}
      <div className="page-grid">
        <Alert
          type="info"
          showIcon
          icon={<ApiOutlined />}
          message="开放平台说明"
          description="应用密钥采用脱敏存储，创建或轮换后只展示一次明文；公开接口调用会写入调用留痕，可与白名单和签名策略联动。"
        />
        {error && <Alert type="error" showIcon message={error} />}
        {loading || !data ? (
          <Skeleton active paragraph={{ rows: 10 }} />
        ) : (
          <>
            {summaryItems.length > 0 && <SummaryCards items={summaryItems} />}
            <div className="glass-panel" style={{ padding: 24 }}>
              <Typography.Title level={4} style={{ marginBottom: 16 }}>
                应用清单
              </Typography.Title>
              <Table
                rowKey="id"
                dataSource={data.apps}
                columns={columns}
                pagination={{ pageSize: 8, showSizeChanger: false }}
                scroll={{ x: 1280 }}
              />
            </div>
            <div className="glass-panel" style={{ padding: 24 }}>
              <Typography.Title level={4} style={{ marginBottom: 16 }}>
                最近调用留痕
              </Typography.Title>
              <Table
                rowKey="id"
                dataSource={data.recentCalls}
                columns={callColumns}
                pagination={{ pageSize: 6, showSizeChanger: false }}
                scroll={{ x: 1100 }}
              />
            </div>
          </>
        )}
      </div>

      <Modal
        title="新建开放应用"
        open={createOpen}
        onCancel={() => setCreateOpen(false)}
        onOk={() => void submitCreate()}
        confirmLoading={busyKey === 'create-app'}
        destroyOnClose
      >
        <Form
          form={form}
          layout="vertical"
          initialValues={{
            scopes: ['dashboard.read'],
            rateLimitPerMinute: 120,
          }}
        >
          <Form.Item label="应用名称" name="appName" rules={[{ required: true, message: '请输入应用名称' }]}>
            <Input placeholder="例如：ERP 同步中心" />
          </Form.Item>
          <Form.Item label="负责人" name="ownerName" rules={[{ required: true, message: '请输入负责人' }]}>
            <Input placeholder="例如：运营中台" />
          </Form.Item>
          <Form.Item label="联系人" name="contactName">
            <Input placeholder="例如：ops@example.com" />
          </Form.Item>
          <Form.Item label="回调地址" name="callbackUrl">
            <Input placeholder="例如：https://erp.example.com/webhooks/fulfillment" />
          </Form.Item>
          <Form.Item label="接口范围" name="scopes" rules={[{ required: true, message: '请选择接口范围' }]}>
            <Select
              mode="multiple"
              options={[
                { label: '经营看板读取', value: 'dashboard.read' },
                { label: '订单概览读取', value: 'orders.read' },
                { label: '预留回调接收', value: 'webhook.receive' },
              ]}
            />
          </Form.Item>
          <Form.Item label="速率限制" name="rateLimitPerMinute">
            <InputNumber min={30} max={5000} addonAfter="次/分钟" style={{ width: '100%' }} />
          </Form.Item>
        </Form>
      </Modal>
    </PageContainer>
  );
}
