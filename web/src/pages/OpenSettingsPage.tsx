import { ReloadOutlined, SettingOutlined } from '@ant-design/icons';
import { PageContainer } from '@ant-design/pro-components';
import { Alert, Button, Form, Input, InputNumber, Skeleton, Switch, Typography, message } from 'antd';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { apiRequest } from '../api';
import type { OpenPlatformSettingsDetailResponse } from '../api';
import { SummaryCards } from '../components/SummaryCards';
import { useRemoteData } from '../hooks/useRemoteData';

interface SettingsFormValues {
  webhookBaseUrl?: string;
  notifyEmail?: string;
  publishedVersion?: string;
  defaultRateLimitPerMinute?: number;
  signatureTtlSeconds?: number;
  whitelistEnforced?: boolean;
}

export function OpenSettingsPage() {
  const [messageApi, contextHolder] = message.useMessage();
  const [saving, setSaving] = useState(false);
  const [form] = Form.useForm<SettingsFormValues>();

  const loader = useCallback(
    async () => apiRequest<OpenPlatformSettingsDetailResponse>('/api/open-platform/settings', undefined),
    [],
  );

  const { data, loading, error, reload } = useRemoteData(loader);

  useEffect(() => {
    if (!data?.settings) {
      return;
    }
    form.setFieldsValue({
      webhookBaseUrl: data.settings.webhookBaseUrl,
      notifyEmail: data.settings.notifyEmail,
      publishedVersion: data.settings.publishedVersion,
      defaultRateLimitPerMinute: data.settings.defaultRateLimitPerMinute,
      signatureTtlSeconds: data.settings.signatureTtlSeconds,
      whitelistEnforced: data.settings.whitelistEnforced,
    });
  }, [data, form]);

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

  const submit = useCallback(async () => {
    const values = await form.validateFields();
    setSaving(true);
    try {
      await apiRequest('/api/open-platform/settings', {
        method: 'POST',
        body: JSON.stringify(values),
      });
      messageApi.success('开放平台设置已更新');
      await reload();
    } catch (requestError) {
      messageApi.error(requestError instanceof Error ? requestError.message : '保存设置失败');
    } finally {
      setSaving(false);
    }
  }, [form, messageApi, reload]);

  return (
    <PageContainer
      title="开放平台设置"
      subTitle="维护回调基地址、默认限流、签名有效期和白名单总开关。"
      style={{ paddingInline: 0 }}
      extra={[
        <Button key="refresh" icon={<ReloadOutlined />} onClick={() => void reload()}>
          刷新
        </Button>,
        <Button key="save" type="primary" loading={saving} onClick={() => void submit()}>
          保存设置
        </Button>,
      ]}
    >
      {contextHolder}
      <div className="page-grid">
        <Alert
          type="info"
          showIcon
          icon={<SettingOutlined />}
          message="设置说明"
          description="这里配置的是租户级开放平台默认策略。应用签名密钥仍然按应用单独管理，并以脱敏形式保存。"
        />
        {error && <Alert type="error" showIcon message={error} />}
        {loading || !data ? (
          <Skeleton active paragraph={{ rows: 10 }} />
        ) : (
          <>
            {summaryItems.length > 0 && <SummaryCards items={summaryItems} />}
            <div className="glass-panel" style={{ padding: 24 }}>
              <Typography.Title level={4} style={{ marginBottom: 16 }}>
                基础策略
              </Typography.Title>
              <Form form={form} layout="vertical">
                <Form.Item label="默认回调基地址" name="webhookBaseUrl">
                  <Input placeholder="例如：https://open.example.com" />
                </Form.Item>
                <Form.Item label="告警通知邮箱" name="notifyEmail">
                  <Input placeholder="例如：ops@example.com" />
                </Form.Item>
                <Form.Item label="对外文档版本" name="publishedVersion">
                  <Input placeholder="例如：v1" />
                </Form.Item>
                <Form.Item label="默认限流" name="defaultRateLimitPerMinute">
                  <InputNumber min={30} max={5000} addonAfter="次/分钟" style={{ width: '100%' }} />
                </Form.Item>
                <Form.Item label="签名有效期" name="signatureTtlSeconds">
                  <InputNumber min={60} max={3600} addonAfter="秒" style={{ width: '100%' }} />
                </Form.Item>
                <Form.Item label="启用白名单总开关" name="whitelistEnforced" valuePropName="checked">
                  <Switch checkedChildren="已启用" unCheckedChildren="已关闭" />
                </Form.Item>
              </Form>
              {data.settings ? (
                <Typography.Text type="secondary">
                  最近更新：{data.settings.updatedAt} {data.settings.updatedByName ? `路 ${data.settings.updatedByName}` : ''}
                </Typography.Text>
              ) : null}
            </div>
          </>
        )}
      </div>
    </PageContainer>
  );
}
