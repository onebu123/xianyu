import { Alert, Button, Card, Descriptions, Result, Spin, Typography, message } from 'antd';
import { useEffect, useMemo, useState } from 'react';

import type { StoreAuthProviderCallbackResponse } from '../api';
import { apiRequest } from '../api';
import { routerBasename } from '../config';

function buildCallbackSnapshot() {
  const hash = window.location.hash.startsWith('#')
    ? window.location.hash.slice(1)
    : window.location.hash;
  const hashParams = new URLSearchParams(hash);
  const queryParams = new URLSearchParams(window.location.search);
  const state = hashParams.get('state') ?? queryParams.get('state') ?? '';
  const accessToken = hashParams.get('access_token') ?? queryParams.get('access_token') ?? '';
  const tokenType = hashParams.get('token_type') ?? queryParams.get('token_type');
  const expiresInText = hashParams.get('expires_in') ?? queryParams.get('expires_in');
  const error = hashParams.get('error') ?? queryParams.get('error');
  const errorDescription =
    hashParams.get('error_description') ?? queryParams.get('error_description');

  return {
    state,
    accessToken,
    tokenType,
    expiresInSeconds:
      expiresInText && /^\d+$/.test(expiresInText) ? Number(expiresInText) : undefined,
    error,
    errorDescription,
    rawCallback: JSON.stringify({
      hash,
      query: Object.fromEntries(queryParams.entries()),
      hashParams: Object.fromEntries(hashParams.entries()),
    }),
  };
}

function parseSessionIdFromState(state: string) {
  return state.split('.')[0]?.trim() || null;
}

export function StoreAuthorizeCallbackPage() {
  const [messageApi, contextHolder] = message.useMessage();
  const [loading, setLoading] = useState(true);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [result, setResult] = useState<StoreAuthProviderCallbackResponse | null>(null);

  const callbackSnapshot = useMemo(() => buildCallbackSnapshot(), []);
  const sessionId = useMemo(
    () => parseSessionIdFromState(callbackSnapshot.state),
    [callbackSnapshot.state],
  );

  useEffect(() => {
    if (!sessionId) {
      setLoading(false);
      setErrorMessage('回调缺少可识别的授权会话标识。');
      return;
    }

    if (callbackSnapshot.error) {
      setLoading(false);
      setErrorMessage(callbackSnapshot.errorDescription ?? callbackSnapshot.error);
      return;
    }

    if (!callbackSnapshot.accessToken) {
      setLoading(false);
      setErrorMessage('回调中未携带 access token。');
      return;
    }

    let disposed = false;
    const submitCallback = async () => {
      try {
        const payload = await apiRequest<StoreAuthProviderCallbackResponse>(
          `/api/public/stores/auth-sessions/${sessionId}/provider-callback`,
          {
            method: 'POST',
            body: JSON.stringify({
              accessToken: callbackSnapshot.accessToken,
              tokenType: callbackSnapshot.tokenType,
              expiresInSeconds: callbackSnapshot.expiresInSeconds,
              state: callbackSnapshot.state,
              rawCallback: callbackSnapshot.rawCallback,
            }),
          },
        );

        if (disposed) {
          return;
        }

        setResult(payload);
        window.opener?.postMessage(
          {
            type: 'store-auth-provider-callback',
            sessionId: payload.sessionId,
            nextStep: payload.nextStep,
            nextStepText: payload.nextStepText,
          },
          window.location.origin,
        );
      } catch (error) {
        if (disposed) {
          return;
        }

        const nextMessage = error instanceof Error ? error.message : '授权回调接收失败';
        setErrorMessage(nextMessage);
        messageApi.error(nextMessage);
      } finally {
        if (!disposed) {
          setLoading(false);
        }
      }
    };

    void submitCallback();
    return () => {
      disposed = true;
    };
  }, [callbackSnapshot, messageApi, sessionId]);

  return (
    <div className="store-auth-page">
      {contextHolder}
      <Card className="store-auth-card" bordered={false}>
        <div className="store-auth-header">
          <Typography.Title level={2} style={{ marginBottom: 8 }}>
            闲鱼授权回调
          </Typography.Title>
          <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
            当前页面只负责接收并入库官方授权回调，不会直接创建店铺。后续还需要补店铺资料换取与正式绑店。
          </Typography.Paragraph>
        </div>

        {loading ? (
          <div style={{ minHeight: 280, display: 'grid', placeItems: 'center' }}>
            <Spin size="large" />
          </div>
        ) : errorMessage ? (
          <Alert
            type="error"
            showIcon
            message="授权回调处理失败"
            description={errorMessage}
          />
        ) : result ? (
          <>
            <Result
              status="success"
              title="授权回调已接收"
              subTitle={result.message}
              extra={[
                <Button
                  key="continue"
                  type="primary"
                  onClick={() => {
                    const base = routerBasename === '/' ? '' : routerBasename;
                    window.location.assign(
                      `${window.location.origin}${base}/stores/connect/xianyu?sessionId=${result.sessionId}`,
                    );
                  }}
                >
                  继续绑定店铺
                </Button>,
                <Button key="reload" onClick={() => window.close()}>
                  关闭弹窗
                </Button>,
              ]}
            />
            <Descriptions size="small" bordered column={1}>
              <Descriptions.Item label="授权会话">{result.sessionId}</Descriptions.Item>
              <Descriptions.Item label="授权令牌">{result.accessTokenMasked}</Descriptions.Item>
              <Descriptions.Item label="接收时间">{result.accessTokenReceivedAt}</Descriptions.Item>
              <Descriptions.Item label="下一步">{result.nextStepText}</Descriptions.Item>
            </Descriptions>
          </>
        ) : null}
      </Card>
    </div>
  );
}
