import { QrcodeOutlined, ReloadOutlined, SafetyCertificateOutlined } from '@ant-design/icons';
import { PageContainer } from '@ant-design/pro-components';
import {
  Alert,
  Button,
  Descriptions,
  Form,
  Image,
  Input,
  Modal,
  Space,
  Tag,
  Typography,
  message,
} from 'antd';
import { useCallback, useState } from 'react';

import { apiRequest } from '../api';
import type { PlatformMfaSetupResponse, PlatformMfaStatusResponse } from '../api';
import { useRemoteData } from '../hooks/useRemoteData';

export function PlatformSecurityPage() {
  const [messageApi, contextHolder] = message.useMessage();
  const [setupOpen, setSetupOpen] = useState(false);
  const [disableOpen, setDisableOpen] = useState(false);
  const [setupPayload, setSetupPayload] = useState<PlatformMfaSetupResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmForm] = Form.useForm<{ code: string }>();
  const [disableForm] = Form.useForm<{ code: string }>();

  const loader = useCallback(
    async () => apiRequest<PlatformMfaStatusResponse>('/api/platform/security/mfa', undefined),
    [],
  );

  const { data, error, reload } = useRemoteData(loader);

  const startSetup = useCallback(async () => {
    setBusy(true);
    try {
      const payload = await apiRequest<PlatformMfaSetupResponse>('/api/platform/security/mfa/setup', {
        method: 'POST',
        body: '{}',
      });
      setSetupPayload(payload);
      setSetupOpen(true);
      confirmForm.resetFields();
    } catch (requestError) {
      messageApi.error(requestError instanceof Error ? requestError.message : '生成 MFA 配置失败');
    } finally {
      setBusy(false);
    }
  }, [confirmForm, messageApi]);

  return (
    <PageContainer
      title="平台安全"
      subTitle="管理平台账号 MFA、二次验证和敏感操作保护。"
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
          icon={<SafetyCertificateOutlined />}
          message="安全基线"
          description="平台账号启用 MFA 后，登录必须先通过口令，再完成身份验证器动态码校验。"
        />
        {error ? <Alert type="error" showIcon message={error} /> : null}
        <div className="glass-panel" style={{ padding: 24 }}>
          <Descriptions
            title="MFA 状态"
            column={1}
            items={[
              {
                key: 'status',
                label: '当前状态',
                children: data?.enabled ? <Tag color="success">已启用</Tag> : <Tag>未启用</Tag>,
              },
              {
                key: 'user',
                label: '平台账号',
                children: data?.user.displayName ?? '-',
              },
              {
                key: 'updatedAt',
                label: '最近更新时间',
                children: data?.updatedAt ?? '未设置',
              },
            ]}
          />
          <Space style={{ marginTop: 16 }}>
            <Button type="primary" icon={<QrcodeOutlined />} loading={busy} onClick={() => void startSetup()}>
              {data?.enabled ? '重置 MFA' : '启用 MFA'}
            </Button>
            <Button
              danger
              disabled={!data?.enabled}
              onClick={() => {
                disableForm.resetFields();
                setDisableOpen(true);
              }}
            >
              关闭 MFA
            </Button>
          </Space>
        </div>
      </div>

      <Modal
        title="启用平台 MFA"
        open={setupOpen}
        onCancel={() => setSetupOpen(false)}
        onOk={() => void confirmForm.submit()}
        confirmLoading={busy}
        okText="完成绑定"
      >
        {setupPayload ? (
          <>
            <Alert
              type="info"
              showIcon
              message="请先在身份验证器里扫码或手动录入密钥"
              description="完成后输入当前 6 位动态验证码确认启用。"
              style={{ marginBottom: 16 }}
            />
            <div style={{ display: 'grid', placeItems: 'center', marginBottom: 16 }}>
              <Image
                preview={false}
                src={setupPayload.qrCodeDataUrl}
                alt="MFA QR Code"
                width={220}
              />
            </div>
            <Typography.Paragraph copyable={{ text: setupPayload.manualEntryKey }}>
              手动录入密钥：<Typography.Text code>{setupPayload.manualEntryKey}</Typography.Text>
            </Typography.Paragraph>
            <Form
              form={confirmForm}
              layout="vertical"
              onFinish={async (values) => {
                setBusy(true);
                try {
                  await apiRequest('/api/platform/security/mfa/confirm', {
                    method: 'POST',
                    body: JSON.stringify(values),
                  });
                  messageApi.success('MFA 已启用');
                  setSetupOpen(false);
                  setSetupPayload(null);
                  await reload();
                } catch (requestError) {
                  messageApi.error(requestError instanceof Error ? requestError.message : '启用 MFA 失败');
                } finally {
                  setBusy(false);
                }
              }}
            >
              <Form.Item
                label="动态验证码"
                name="code"
                rules={[{ required: true, message: '请输入 6 位动态验证码' }]}
              >
                <Input placeholder="6 位动态验证码" inputMode="numeric" />
              </Form.Item>
            </Form>
          </>
        ) : null}
      </Modal>

      <Modal
        title="关闭平台 MFA"
        open={disableOpen}
        onCancel={() => setDisableOpen(false)}
        onOk={() => void disableForm.submit()}
        confirmLoading={busy}
        okButtonProps={{ danger: true }}
        okText="确认关闭"
      >
        <Alert
          type="warning"
          showIcon
          message="关闭后平台登录将只校验口令"
          description="请输入当前身份验证器里的动态验证码确认关闭。"
          style={{ marginBottom: 16 }}
        />
        <Form
          form={disableForm}
          layout="vertical"
          onFinish={async (values) => {
            setBusy(true);
            try {
              await apiRequest('/api/platform/security/mfa/disable', {
                method: 'POST',
                body: JSON.stringify(values),
              });
              messageApi.success('MFA 已关闭');
              setDisableOpen(false);
              await reload();
            } catch (requestError) {
              messageApi.error(requestError instanceof Error ? requestError.message : '关闭 MFA 失败');
            } finally {
              setBusy(false);
            }
          }}
        >
          <Form.Item
            label="动态验证码"
            name="code"
            rules={[{ required: true, message: '请输入 6 位动态验证码' }]}
          >
            <Input placeholder="6 位动态验证码" inputMode="numeric" />
          </Form.Item>
        </Form>
      </Modal>
    </PageContainer>
  );
}
