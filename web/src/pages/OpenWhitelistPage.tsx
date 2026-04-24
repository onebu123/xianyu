import { PlusOutlined, ReloadOutlined, SafetyOutlined } from '@ant-design/icons';
import { PageContainer } from '@ant-design/pro-components';
import { Alert, Button, Form, Input, Modal, Skeleton, Space, Switch, Table, Tag, Typography, message } from 'antd';
import type { TableProps } from 'antd';
import { useCallback, useMemo, useState } from 'react';

import { apiRequest } from '../api';
import type { OpenPlatformWhitelistDetailResponse } from '../api';
import { SummaryCards } from '../components/SummaryCards';
import { useRemoteData } from '../hooks/useRemoteData';

interface RuleFormValues {
  ruleValue: string;
  description?: string;
}

export function OpenWhitelistPage() {
  const [messageApi, contextHolder] = message.useMessage();
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [form] = Form.useForm<RuleFormValues>();

  const loader = useCallback(
    async () => apiRequest<OpenPlatformWhitelistDetailResponse>('/api/open-platform/whitelist', undefined),
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

  const toggleRule = useCallback(
    async (ruleId: number, enabled: boolean) => {
      setBusyKey(`rule-${ruleId}`);
      try {
        await apiRequest(`/api/open-platform/whitelist/${ruleId}/enabled`, {
          method: 'POST',
          body: JSON.stringify({ enabled }),
        });
        messageApi.success(enabled ? '白名单规则已启用' : '白名单规则已停用');
        await reload();
      } catch (requestError) {
        messageApi.error(requestError instanceof Error ? requestError.message : '更新白名单失败');
      } finally {
        setBusyKey(null);
      }
    },
    [messageApi, reload],
  );

  const submitCreate = useCallback(async () => {
    const values = await form.validateFields();
    setBusyKey('create-rule');
    try {
      await apiRequest('/api/open-platform/whitelist', {
        method: 'POST',
        body: JSON.stringify({
          ruleType: 'ip',
          ruleValue: values.ruleValue,
          description: values.description,
          enabled: true,
        }),
      });
      setCreateOpen(false);
      form.resetFields();
      messageApi.success('白名单规则已创建');
      await reload();
    } catch (requestError) {
      messageApi.error(requestError instanceof Error ? requestError.message : '创建白名单失败');
    } finally {
      setBusyKey(null);
    }
  }, [form, messageApi, reload]);

  const columns = useMemo<TableProps<OpenPlatformWhitelistDetailResponse['rules'][number]>['columns']>(
    () => [
      {
        title: '规则',
        dataIndex: 'ruleValue',
        width: 220,
        render: (_value, row) => (
          <div className="store-cell-stack">
            <Typography.Text strong>{row.ruleValue}</Typography.Text>
            <div className="store-cell-meta">类型：{row.ruleType.toUpperCase()}</div>
          </div>
        ),
      },
      {
        title: '说明',
        dataIndex: 'description',
        render: (value: string, row) => (
          <div className="store-cell-stack">
            <div>{value || '未填写说明'}</div>
            <div className="store-cell-meta">
              最近命中：{row.lastHitAt ?? '暂无'} 路 累计 {row.hitCount} 次
            </div>
          </div>
        ),
      },
      {
        title: '状态',
        dataIndex: 'enabled',
        width: 160,
        render: (_value, row) => (
          <Space wrap>
            <Tag color={row.enabled ? 'success' : 'default'}>{row.enabled ? '已启用' : '已停用'}</Tag>
            <Switch
              size="small"
              checked={row.enabled}
              loading={busyKey === `rule-${row.id}`}
              onChange={(checked) => void toggleRule(row.id, checked)}
            />
          </Space>
        ),
      },
      {
        title: '维护信息',
        dataIndex: 'updatedAt',
        width: 220,
        render: (_value, row) => (
          <div className="store-cell-stack">
            <div className="store-cell-meta">更新时间：{row.updatedAt}</div>
            <div className="store-cell-meta">更新人：{row.updatedByName ?? '系统'}</div>
          </div>
        ),
      },
    ],
    [busyKey, toggleRule],
  );

  return (
    <PageContainer
      title="白名单管理"
      subTitle="按来源 IP 控制开放平台公开接口的可访问范围，并保留命中留痕。"
      style={{ paddingInline: 0 }}
      extra={[
        <Button key="refresh" icon={<ReloadOutlined />} onClick={() => void reload()}>
          刷新
        </Button>,
        <Button key="create" type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
          新增规则
        </Button>,
      ]}
    >
      {contextHolder}
      <div className="page-grid">
        <Alert
          type="info"
          showIcon
          icon={<SafetyOutlined />}
          message="白名单说明"
          description="当前阶段按来源 IP 做基础访问控制，支持精确地址和 * 通配规则，例如 10.0.*。"
        />
        {error && <Alert type="error" showIcon message={error} />}
        {loading || !data ? (
          <Skeleton active paragraph={{ rows: 8 }} />
        ) : (
          <>
            {summaryItems.length > 0 && <SummaryCards items={summaryItems} />}
            <div className="glass-panel" style={{ padding: 24 }}>
              <Typography.Title level={4} style={{ marginBottom: 16 }}>
                白名单规则
              </Typography.Title>
              <Table
                rowKey="id"
                dataSource={data.rules}
                columns={columns}
                pagination={{ pageSize: 8, showSizeChanger: false }}
              />
            </div>
          </>
        )}
      </div>

      <Modal
        title="新增白名单规则"
        open={createOpen}
        onCancel={() => setCreateOpen(false)}
        onOk={() => void submitCreate()}
        confirmLoading={busyKey === 'create-rule'}
        destroyOnClose
      >
        <Form form={form} layout="vertical">
          <Form.Item label="来源 IP / 通配规则" name="ruleValue" rules={[{ required: true, message: '请输入规则值' }]}>
            <Input placeholder="例如：127.0.0.1 或 10.0.*" />
          </Form.Item>
          <Form.Item label="说明" name="description">
            <Input placeholder="例如：本机联调地址" />
          </Form.Item>
        </Form>
      </Modal>
    </PageContainer>
  );
}
