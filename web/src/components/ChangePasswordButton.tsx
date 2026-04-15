import { useState } from 'react';
import { Modal, Form, Input, Button, App } from 'antd';
import { LockOutlined } from '@ant-design/icons';
import { apiRequest } from '../api/client';

interface ChangePasswordFormValues {
  currentPassword: string;
  newPassword: string;
  confirmPassword: string;
}

export function ChangePasswordButton() {
  const { message: messageApi } = App.useApp();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [form] = Form.useForm<ChangePasswordFormValues>();

  const handleSubmit = async () => {
    const values = await form.validateFields();
    if (values.newPassword !== values.confirmPassword) {
      messageApi.error('两次输入的新密码不一致');
      return;
    }

    setLoading(true);
    try {
      const result = await apiRequest<{ success: boolean; message: string }>(
        '/api/auth/change-password',
        {
          method: 'POST',
          body: JSON.stringify({
            currentPassword: values.currentPassword,
            newPassword: values.newPassword,
          }),
        },
      );
      messageApi.success(result.message || '密码修改成功');
      setOpen(false);
      form.resetFields();
    } catch (error) {
      messageApi.error(error instanceof Error ? error.message : '修改密码失败');
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <Button
        icon={<LockOutlined />}
        className="shell-ghost-button"
        onClick={() => setOpen(true)}
      >
        改密
      </Button>
      <Modal
        title="修改密码"
        open={open}
        onCancel={() => { setOpen(false); form.resetFields(); }}
        footer={null}
        destroyOnClose
        width={420}
      >
        <Form
          form={form}
          layout="vertical"
          onFinish={handleSubmit}
          style={{ marginTop: 16 }}
        >
          <Form.Item
            name="currentPassword"
            label="当前密码"
            rules={[{ required: true, message: '请输入当前密码' }]}
          >
            <Input.Password placeholder="请输入当前密码" />
          </Form.Item>
          <Form.Item
            name="newPassword"
            label="新密码"
            rules={[
              { required: true, message: '请输入新密码' },
              { min: 12, message: '密码至少 12 位' },
              { pattern: /[a-z]/, message: '至少包含 1 个小写字母' },
              { pattern: /[A-Z]/, message: '至少包含 1 个大写字母' },
              { pattern: /\d/, message: '至少包含 1 个数字' },
              { pattern: /[^A-Za-z0-9]/, message: '至少包含 1 个特殊字符' },
            ]}
          >
            <Input.Password placeholder="至少 12 位，含大小写+数字+特殊字符" />
          </Form.Item>
          <Form.Item
            name="confirmPassword"
            label="确认新密码"
            dependencies={['newPassword']}
            rules={[
              { required: true, message: '请再次输入新密码' },
              ({ getFieldValue }) => ({
                validator(_, value) {
                  if (!value || getFieldValue('newPassword') === value) {
                    return Promise.resolve();
                  }
                  return Promise.reject(new Error('两次输入的密码不一致'));
                },
              }),
            ]}
          >
            <Input.Password placeholder="请再次输入新密码" />
          </Form.Item>
          <Form.Item style={{ marginBottom: 0, textAlign: 'right' }}>
            <Button onClick={() => { setOpen(false); form.resetFields(); }} style={{ marginRight: 8 }}>
              取消
            </Button>
            <Button type="primary" htmlType="submit" loading={loading}>
              确认修改
            </Button>
          </Form.Item>
        </Form>
      </Modal>
    </>
  );
}
