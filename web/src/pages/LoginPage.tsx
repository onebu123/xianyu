import { LockOutlined, UserOutlined } from '@ant-design/icons';
import { Alert, Button, Form, Input, Typography } from 'antd';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { useAuth } from '../auth';

export function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="login-wrapper">
      <div className="login-card">
        <div className="login-logo-row">
          <div className="app-brand-logo" style={{ width: 48, height: 48, fontSize: 24, borderRadius: 14 }}>
            鱼
          </div>
        </div>
        <div className="login-title">Sale Compass</div>
        <div className="login-subtitle">闲鱼卖家工作台 · 安全登录</div>

        {error ? (
          <Alert type="error" showIcon message={error} style={{ marginBottom: 20 }} />
        ) : null}

        <Form
          layout="vertical"
          onFinish={async (values) => {
            setSubmitting(true);
            setError(null);
            try {
              await login(values.username, values.password);
              navigate('/dashboard', { replace: true });
            } catch (err) {
              setError(err instanceof Error ? err.message : '登录失败');
            } finally {
              setSubmitting(false);
            }
          }}
        >
          <Form.Item
            label="用户名"
            name="username"
            rules={[{ required: true, message: '请输入用户名' }]}
          >
            <Input
              autoComplete="username"
              prefix={<UserOutlined style={{ color: 'rgba(255,255,255,0.25)' }} />}
              placeholder="请输入用户名"
              size="large"
            />
          </Form.Item>
          <Form.Item
            label="密码"
            name="password"
            rules={[{ required: true, message: '请输入密码' }]}
          >
            <Input.Password
              autoComplete="current-password"
              prefix={<LockOutlined style={{ color: 'rgba(255,255,255,0.25)' }} />}
              placeholder="请输入密码"
              size="large"
            />
          </Form.Item>
          <Button
            type="primary"
            htmlType="submit"
            size="large"
            block
            loading={submitting}
            style={{
              height: 48,
              borderRadius: 12,
              fontWeight: 600,
              fontSize: 15,
              marginTop: 8,
            }}
          >
            登录
          </Button>
        </Form>

        <Typography.Text
          type="secondary"
          style={{ display: 'block', textAlign: 'center', marginTop: 20, fontSize: 12 }}
        >
          首次登录请使用 .env 中配置的管理员账号
        </Typography.Text>
      </div>
    </div>
  );
}
