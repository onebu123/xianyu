import { LockOutlined, SafetyCertificateOutlined, UserOutlined } from '@ant-design/icons';
import { Alert, Button, Form, Input, Typography } from 'antd';
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { apiRequest } from '../api';
import type { LoginResponse, PlatformMfaChallengeResponse, PlatformSessionResponse } from '../api';
import { getFirstAccessiblePath } from '../access';
import { useAuth } from '../auth';
import { routerBasename } from '../config';

function isPlatformSession(payload: LoginResponse): payload is PlatformSessionResponse {
  return payload.scope === 'platform';
}

function isPlatformMfaChallenge(payload: LoginResponse): payload is PlatformMfaChallengeResponse {
  return payload.scope === 'platform_mfa';
}

export function LoginPage() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [mfaChallenge, setMfaChallenge] = useState<PlatformMfaChallengeResponse | null>(null);

  return (
    <div className="login-wrapper">
      <div className="login-card">
        <div className="login-logo-row">
          <div className="app-brand-logo" style={{ width: 48, height: 48, fontSize: 24, borderRadius: 14 }}>
            楸?
          </div>
        </div>
        <div className="login-title">Sale Compass</div>
        <div className="login-subtitle">
          {mfaChallenge ? '平台控制面二次验证' : '闲鱼卖家工作台 · 安全登录'}
        </div>

        {error ? (
          <Alert type="error" showIcon message={error} style={{ marginBottom: 20 }} />
        ) : null}

        {mfaChallenge ? (
          <Form
            layout="vertical"
            onFinish={async (values) => {
              setSubmitting(true);
              setError(null);
              try {
                const session = await apiRequest<PlatformSessionResponse>('/api/auth/verify-mfa', {
                  method: 'POST',
                  body: JSON.stringify({
                    challengeToken: mfaChallenge.challengeToken,
                    code: values.code,
                  }),
                });
                const nextPath = session.memberships.length > 0 ? '/auth/select-tenant' : '/platform/tenants';
                localStorage.setItem('goofish-statistics-session-hint', '1');
                window.location.assign(`${routerBasename === '/' ? '' : routerBasename}${nextPath}`);
                return;
              } catch (err) {
                setError(err instanceof Error ? err.message : '动态验证码校验失败');
              } finally {
                setSubmitting(false);
              }
            }}
          >
            <Alert
              type="info"
              showIcon
              icon={<SafetyCertificateOutlined />}
              message={`平台账号 ${mfaChallenge.user.displayName} 需要完成 MFA 验证`}
              description="请输入身份验证器里的 6 位动态验证码后继续。"
              style={{ marginBottom: 16 }}
            />
            <Form.Item
              label="动态验证码"
              name="code"
              rules={[{ required: true, message: '请输入 6 位动态验证码' }]}
            >
              <Input
                autoFocus
                inputMode="numeric"
                placeholder="6 位动态验证码"
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
              完成验证
            </Button>
            <Button
              block
              style={{ marginTop: 12 }}
              onClick={() => {
                setMfaChallenge(null);
                setError(null);
              }}
            >
              返回账号密码登录
            </Button>
          </Form>
        ) : (
          <Form
            layout="vertical"
            onFinish={async (values) => {
              setSubmitting(true);
              setError(null);
              try {
                const session = await login(values.username, values.password);
                if (isPlatformMfaChallenge(session)) {
                  setMfaChallenge(session);
                  return;
                }
                if (isPlatformSession(session)) {
                  navigate(session.memberships.length > 0 ? '/auth/select-tenant' : '/platform/tenants', {
                    replace: true,
                  });
                  return;
                }
                navigate(getFirstAccessiblePath(session.user.role), { replace: true });
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
        )}

        <Typography.Text
          type="secondary"
          style={{ display: 'block', textAlign: 'center', marginTop: 20, fontSize: 12 }}
        >
          首次登录请使用 `.env` 中配置的管理员账号
        </Typography.Text>
      </div>
    </div>
  );
}
