import {
  Alert,
  Button,
  Card,
  Checkbox,
  Divider,
  Descriptions,
  Form,
  Input,
  Segmented,
  Space,
  Spin,
  Tag,
  Typography,
  message,
} from 'antd';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Navigate, useNavigate, useParams, useSearchParams } from 'react-router-dom';

import type {
  StoreAuthCompleteResponse,
  StoreAuthProfileSyncResponse,
  StoreAuthSessionDetailResponse,
  StoreAuthSessionLiveSnapshotResponse,
  StoreAuthSessionLiveStreamTokenResponse,
  StoreCredentialEventRecord,
  StoreQrLoginSessionResponse,
  StoreWebSessionProfileDetectResponse,
  StoreSessionCredentialEventsResponse,
} from '../api';
import { apiRequest } from '../api';
import { resolveApiPath } from '../config';

type LoginMode = 'sms' | 'password';
interface RealProfileSyncFormValues {
  providerUserId: string;
  providerShopId: string;
  providerShopName: string;
  mobile: string;
  nickname: string;
  scopeText: string;
  refreshToken: string;
}

interface WebSessionSyncFormValues extends RealProfileSyncFormValues {
  cookieText: string;
}

interface SessionCredentialTimelineItem {
  key: string;
  title: string;
  status: StoreCredentialEventRecord['status'];
  statusText: string;
  detail: string;
  createdAt: string;
  verificationUrl: string | null;
  meta: string | null;
}

/*
function qrLoginStatusColor(status: StoreQrLoginSessionResponse['status']) {
  const renderEnhancedWebSessionFlow = (detail: StoreAuthSessionDetailResponse) => (
    <div className="store-auth-layout">
      <div className="store-auth-side">
        <Typography.Title level={4}>网页登录态接入</Typography.Title>
        <Typography.Paragraph type="secondary">
          当前会话不依赖官方 OAuth。你可以先用扫码登录收取 Cookie，也可以直接手动录入网页登录态；凭据会加密保存，随后再补齐卖家与店铺资料。
        </Typography.Paragraph>
        <Descriptions size="small" column={1} bordered>
          <Descriptions.Item label="接入模式">闲鱼网页登录态接入</Descriptions.Item>
          <Descriptions.Item label="当前状态">
            {detail.tokenReceived ? '已接收网页登录态' : '等待录入或扫码登录'}
          </Descriptions.Item>
          <Descriptions.Item label="资料同步">{detail.profileSyncStatusText}</Descriptions.Item>
          <Descriptions.Item label="下一步">{detail.nextStepText}</Descriptions.Item>
          <Descriptions.Item label="当前凭据">
            {detail.providerAccessTokenMasked ?? '尚未录入'}
          </Descriptions.Item>
        </Descriptions>
      </div>

      <div className="store-auth-form-shell">
        <Alert
          type={detail.tokenReceived ? 'success' : 'info'}
          showIcon
          message={detail.tokenReceived ? '网页登录态已就绪' : '当前模式适合无法走官方开放平台的场景'}
          description={
            detail.tokenReceived
              ? '下一步补齐卖家与店铺资料即可完成绑店。'
              : '建议优先使用扫码登录；如果已经拿到可用 Cookie，也可以直接手动录入。'
          }
          className="store-auth-alert"
        />

        <Typography.Title level={5} style={{ marginTop: 20 }}>
          会话说明
        </Typography.Title>
        <ul className="store-auth-permission-list">
          {detail.instructions.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>

        {detail.profileSyncError ? (
          <Alert
            style={{ marginTop: 16 }}
            type="error"
            showIcon
            message="上次接入失败"
            description={detail.profileSyncError}
          />
        ) : null}

        {!detail.tokenReceived ? (
          <>
            <Card size="small" title="扫码登录" style={{ marginTop: 20 }}>
              <Space direction="vertical" size={12} style={{ width: '100%' }}>
                <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
                  生成二维码后，用闲鱼已登录账号扫码并在手机端确认。系统会轮询登录状态，成功后可一键接收 Cookie。
                </Typography.Paragraph>

                {qrSession ? (
                  <>
                    <Space wrap>
                      <Tag color={qrLoginStatusColor(qrSession.status)}>{qrLoginStatusText(qrSession.status)}</Tag>
                      {qrSession.cookieMasked ? <Tag>{qrSession.cookieMasked}</Tag> : null}
                      <Typography.Text type="secondary">过期时间：{qrSession.expiresAt}</Typography.Text>
                    </Space>
                    <div
                      style={{
                        width: 220,
                        height: 220,
                        borderRadius: 12,
                        border: '1px solid #f0f0f0',
                        display: 'grid',
                        placeItems: 'center',
                        overflow: 'hidden',
                        background: '#fff',
                      }}
                    >
                      <img src={qrSession.qrCodeUrl} alt="闲鱼扫码登录二维码" style={{ width: '100%', height: '100%' }} />
                    </div>
                    {qrSession.failureReason ? (
                      <Alert type="warning" showIcon message={qrSession.failureReason} />
                    ) : null}
                    {qrSession.verificationUrl ? (
                      <Alert
                        type="warning"
                        showIcon
                        message="扫码后命中风控"
                        description={
                          <Typography.Link href={qrSession.verificationUrl} target="_blank" rel="noreferrer">
                            打开验证页继续处理
                          </Typography.Link>
                        }
                      />
                    ) : null}
                  </>
                ) : null}

                <Space wrap>
                  <Button
                    type="primary"
                    loading={qrSubmitting}
                    onClick={async () => {
                      setQrSubmitting(true);
                      try {
                        const payload = await apiRequest<StoreQrLoginSessionResponse>(
                          `/api/stores/auth-sessions/${sessionId}/qr-login/generate`,
                          { method: 'POST' },
                          token,
                        );
                        setQrSession(payload);
                        messageApi.success('扫码登录二维码已生成');
                      } catch (error) {
                        messageApi.error(error instanceof Error ? error.message : '生成二维码失败');
                      } finally {
                        setQrSubmitting(false);
                      }
                    }}
                  >
                    {qrSession ? '重新生成二维码' : '生成扫码二维码'}
                  </Button>
                  <Button onClick={() => void loadQrSession()}>刷新扫码状态</Button>
                  <Button
                    disabled={qrSession?.status !== 'success'}
                    loading={qrAccepting}
                    onClick={async () => {
                      setQrAccepting(true);
                      try {
                        const payload = await apiRequest<{ nextStepText?: string; verification?: { detail?: string } | null }>(
                          `/api/stores/auth-sessions/${sessionId}/qr-login/accept`,
                          { method: 'POST' },
                          token,
                        );
                        webSessionForm.setFieldsValue({ cookieText: '' });
                        messageApi.success(payload.nextStepText ?? '扫码登录态已接收');
                        if (payload.verification?.detail) {
                          messageApi.info(payload.verification.detail);
                        }
                        await loadSession();
                      } catch (error) {
                        messageApi.error(error instanceof Error ? error.message : '接收扫码登录态失败');
                      } finally {
                        setQrAccepting(false);
                      }
                    }}
                  >
                    接收扫码登录态
                  </Button>
                </Space>
              </Space>
            </Card>

            <Form<WebSessionSyncFormValues>
              form={webSessionForm}
              layout="vertical"
              style={{ marginTop: 20 }}
              onFinish={async (values) => {
                setProfileSyncSubmitting(true);
                try {
                  const payload = await apiRequest<StoreAuthProfileSyncResponse>(
                    `/api/stores/auth-sessions/${sessionId}/web-session-sync`,
                    {
                      method: 'POST',
                      body: JSON.stringify(buildWebSessionSyncPayload(values)),
                    },
                    token,
                  );

                  messageApi.success(
                    payload.reauthorized ? '网页登录态已更新，店铺接入已恢复。' : '网页登录态已录入，绑店完成。',
                  );
                  notifyAndClose({
                    storeId: payload.storeId,
                    platform: payload.platform,
                  });
                } catch (error) {
                  messageApi.error(error instanceof Error ? error.message : '网页登录态录入失败');
                  await loadSession();
                } finally {
                  setProfileSyncSubmitting(false);
                }
              }}
            >
              <Typography.Title level={5} style={{ marginBottom: 12 }}>
                手动录入网页登录态并直接绑店
              </Typography.Title>
              <Form.Item
                label="Cookie / 会话串"
                name="cookieText"
                rules={[{ validator: validateWebSessionCookieField }]}
                extra={
                  sessionDetail?.tokenReceived
                    ? '已通过扫码接收登录态，这里可以留空；只有在需要手动覆写时再粘贴 Cookie。'
                    : '建议直接粘贴完整 Cookie 串，系统会加密保存。'
                }
              >
                <Input.TextArea rows={5} placeholder="例如 cookie1=value1; cookie2=value2; ..." />
              </Form.Item>
              <Form.Item label="卖家 ID" name="providerUserId" rules={[{ required: true, message: '请输入卖家 ID' }]}>
                <Input placeholder="例如用户 UID / sellerId" />
              </Form.Item>
              <Form.Item label="店铺 ID" name="providerShopId" rules={[{ required: true, message: '请输入店铺 ID' }]}>
                <Input placeholder="用于绑定唯一店铺标识" />
              </Form.Item>
              <Form.Item
                label="店铺名称"
                name="providerShopName"
                rules={[{ required: true, message: '请输入店铺名称' }]}
              >
                <Input placeholder="店铺名称或卖家后台展示名" />
              </Form.Item>
              <Form.Item label="展示昵称" name="nickname" rules={[{ required: true, message: '请输入展示昵称' }]}>
                <Input placeholder="用于接入中心展示，可与店铺名称一致" />
              </Form.Item>
              <Form.Item
                label="手机号"
                name="mobile"
                extra="可填写脱敏手机号，例如 138****0000。"
                rules={[{ required: true, message: '请输入手机号或脱敏手机号' }]}
              >
                <Input placeholder="手机号或脱敏手机号" />
              </Form.Item>
              <Form.Item label="权限范围" name="scopeText">
                <Input placeholder="可选，记录本次登录态对应的能力范围" />
              </Form.Item>
              <Form.Item label="刷新令牌" name="refreshToken">
                <Input.Password placeholder="可选，后续拿到 refresh token 再补充" />
              </Form.Item>

              <Space wrap>
                <Button type="primary" htmlType="submit" loading={profileSyncSubmitting}>
                  保存网页登录态并完成绑店
                </Button>
                <Button onClick={() => void loadSession()}>刷新会话</Button>
                <Button onClick={() => window.close()}>关闭弹窗</Button>
              </Space>
            </Form>
          </>
        ) : detail.nextStepKey !== 'done' ? (
          <Form<RealProfileSyncFormValues>
            form={profileSyncForm}
            layout="vertical"
            style={{ marginTop: 20 }}
            onFinish={async (values) => {
              setProfileSyncSubmitting(true);
              try {
                const payload = await apiRequest<StoreAuthProfileSyncResponse>(
                  `/api/stores/auth-sessions/${sessionId}/profile-sync`,
                  {
                    method: 'POST',
                    body: JSON.stringify(values),
                  },
                  token,
                );

                messageApi.success(
                  payload.reauthorized ? '店铺资料已重新同步，绑定关系已更新。' : '店铺资料已同步，绑店完成。',
                );
                notifyAndClose({
                  storeId: payload.storeId,
                  platform: payload.platform,
                });
              } catch (error) {
                messageApi.error(error instanceof Error ? error.message : '资料同步失败');
                await loadSession();
              } finally {
                setProfileSyncSubmitting(false);
              }
            }}
          >
            <Typography.Title level={5} style={{ marginBottom: 12 }}>
              补齐卖家与店铺资料
            </Typography.Title>
            <Form.Item label="卖家 ID" name="providerUserId" rules={[{ required: true, message: '请输入卖家 ID' }]}>
              <Input placeholder="例如闲鱼 UID / sellerId" />
            </Form.Item>
            <Form.Item label="店铺 ID" name="providerShopId" rules={[{ required: true, message: '请输入店铺 ID' }]}>
              <Input placeholder="用于绑定唯一店铺标识" />
            </Form.Item>
            <Form.Item
              label="店铺名称"
              name="providerShopName"
              rules={[{ required: true, message: '请输入店铺名称' }]}
            >
              <Input placeholder="店铺名称或卖家后台展示名" />
            </Form.Item>
            <Form.Item label="展示昵称" name="nickname" rules={[{ required: true, message: '请输入展示昵称' }]}>
              <Input placeholder="用于接入中心展示，可与店铺名称一致" />
            </Form.Item>
            <Form.Item
              label="手机号"
              name="mobile"
              extra="可填写脱敏手机号，例如 138****0000。"
              rules={[{ required: true, message: '请输入手机号或脱敏手机号' }]}
            >
              <Input placeholder="手机号或脱敏手机号" />
            </Form.Item>
            <Form.Item label="权限范围" name="scopeText">
              <Input placeholder="可选，记录本次授权或登录态对应的 scope" />
            </Form.Item>
            <Form.Item label="刷新令牌" name="refreshToken">
              <Input.Password placeholder="可选，后续拿到 refresh token 再补充" />
            </Form.Item>

            <Space wrap>
              <Button type="primary" htmlType="submit" loading={profileSyncSubmitting}>
                同步资料并完成绑店
              </Button>
              <Button onClick={() => void loadSession()}>刷新会话</Button>
              <Button onClick={() => window.close()}>关闭弹窗</Button>
            </Space>
          </Form>
        ) : (
          <Space wrap style={{ marginTop: 20 }}>
            <Button onClick={() => void loadSession()}>刷新会话</Button>
            <Button type="primary" onClick={() => window.close()}>
              关闭弹窗
            </Button>
          </Space>
        )}
      </div>
    </div>
  );

  return (
    {
      waiting: 'processing',
      scanned: 'warning',
      success: 'success',
      expired: 'default',
      cancelled: 'default',
      verification_required: 'warning',
      failed: 'error',
    }[status] ?? 'default'
  );
}

*/

function qrLoginStatusColor(status: StoreQrLoginSessionResponse['status']) {
  return (
    {
      waiting: 'processing',
      scanned: 'warning',
      success: 'success',
      expired: 'default',
      cancelled: 'default',
      verification_required: 'warning',
      failed: 'error',
    }[status] ?? 'default'
  );
}

function qrLoginStatusText(status: StoreQrLoginSessionResponse['status']) {
  return (
    {
      waiting: '等待扫码',
      scanned: '已扫码待确认',
      success: '已登录待接收',
      expired: '二维码已过期',
      cancelled: '已取消',
      verification_required: '命中风控验证',
      failed: '登录失败',
    }[status] ?? status
  );
}

function credentialEventStatusColor(status: StoreCredentialEventRecord['status']) {
  return (
    {
      info: 'default',
      success: 'success',
      warning: 'warning',
      error: 'error',
    }[status] ?? 'default'
  );
}

function qrSessionTimelineStatus(
  status: StoreQrLoginSessionResponse['status'],
): StoreCredentialEventRecord['status'] {
  const statusMap: Record<
    StoreQrLoginSessionResponse['status'],
    StoreCredentialEventRecord['status']
  > = {
    waiting: 'info',
    scanned: 'warning',
    success: 'success',
    expired: 'warning',
    cancelled: 'warning',
    verification_required: 'warning',
    failed: 'error',
  };
  return statusMap[status];
}

function qrSessionTimelineDetail(qrSession: StoreQrLoginSessionResponse) {
  switch (qrSession.status) {
    case 'waiting':
      return '二维码已生成，等待闲鱼已登录账号扫码。';
    case 'scanned':
      return '二维码已被扫码，等待手机端确认授权。';
    case 'success':
      return qrSession.hasCookies
        ? '扫码登录成功，已拿到 Cookie，点击“接收扫码登录态”即可回填表单。'
        : '扫码登录成功，等待接收 Cookie。';
    case 'expired':
      return '当前二维码已过期，请重新生成新的扫码二维码。';
    case 'cancelled':
      return '扫码登录已取消，可重新发起扫码。';
    case 'verification_required':
      return qrSession.failureReason ?? '扫码流程命中风控，需要先完成人工验证。';
    case 'failed':
      return qrSession.failureReason ?? '扫码登录失败，请稍后重试。';
    default:
      return '扫码状态已更新。';
  }
}

export function StoreAuthorizePage() {
  const navigate = useNavigate();
  const { platform } = useParams();
  const [searchParams] = useSearchParams();
  const [loginMode, setLoginMode] = useState<LoginMode>('sms');
  const [submitting, setSubmitting] = useState(false);
  const [profileSyncSubmitting, setProfileSyncSubmitting] = useState(false);
  const [profileDetectSubmitting, setProfileDetectSubmitting] = useState(false);
  const [qrSubmitting, setQrSubmitting] = useState(false);
  const [qrAccepting, setQrAccepting] = useState(false);

  // ---- Browser QR login state ----
  const [browserQrState, setBrowserQrState] = useState<{
    status: string;
    qrPngBase64: string | null;
    expiresAt: string;
    failureReason: string | null;
  }>({ status: 'idle', qrPngBase64: null, expiresAt: '', failureReason: null });
  const [browserQrLoading, setBrowserQrLoading] = useState(false);
  const [browserQrAccepting, setBrowserQrAccepting] = useState(false);
  const browserQrTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(true);
  const [sessionDetail, setSessionDetail] = useState<StoreAuthSessionDetailResponse | null>(null);
  const [qrSession, setQrSession] = useState<StoreQrLoginSessionResponse | null>(null);
  const [sessionCredentialEvents, setSessionCredentialEvents] = useState<StoreCredentialEventRecord[]>([]);
  const [sessionCredentialEventsLoading, setSessionCredentialEventsLoading] = useState(false);
  const [sessionCredentialEventsError, setSessionCredentialEventsError] = useState<string | null>(null);
  const [sessionStreamState, setSessionStreamState] = useState<
    'idle' | 'connecting' | 'live' | 'reconnecting' | 'error'
  >('idle');
  const [sessionStreamError, setSessionStreamError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [messageApi, contextHolder] = message.useMessage();
  const [profileSyncForm] = Form.useForm<RealProfileSyncFormValues>();
  const [webSessionForm] = Form.useForm<WebSessionSyncFormValues>();
  const sessionId = searchParams.get('sessionId');
  const platformLabel = useMemo(
    () => (platform === 'taobao' ? '淘宝店铺授权' : '闲鱼店铺授权'),
    [platform],
  );

  const notifyAndClose = useCallback(
    (payload: { storeId: number; platform: 'xianyu' | 'taobao' }) => {
      window.opener?.postMessage(
        {
          type: 'store-auth-complete',
          storeId: payload.storeId,
          platform: payload.platform,
        },
        window.location.origin,
      );

      window.setTimeout(() => {
        window.close();
        navigate('/stores', { replace: true });
      }, 600);
    },
    [navigate],
  );

  const loadSession = useCallback(async () => {
    if (!sessionId) {
      return;
    }

    setLoadingDetail(true);
    setLoadError(null);
    try {
      const payload = await apiRequest<StoreAuthSessionDetailResponse>(
        `/api/stores/auth-sessions/${sessionId}`,
      );
      setSessionDetail(payload);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : '授权会话加载失败');
    } finally {
      setLoadingDetail(false);
    }
  }, [sessionId]);

  const loadQrSession = useCallback(
    async (silent = false) => {
      if (!sessionId) {
        return;
      }

      try {
        const payload = await apiRequest<StoreQrLoginSessionResponse>(
          `/api/stores/auth-sessions/${sessionId}/qr-login`,
        );
        setQrSession(payload);
      } catch (error) {
        if (!silent) {
          messageApi.error(error instanceof Error ? error.message : '扫码登录状态加载失败');
        }
      }
    },
    [messageApi, sessionId],
  );

  const loadSessionCredentialEvents = useCallback(
    async (silent = false) => {
      if (!sessionId) {
        return;
      }

      setSessionCredentialEventsLoading(true);
      if (!silent) {
        setSessionCredentialEventsError(null);
      }

      try {
        const payload = await apiRequest<StoreSessionCredentialEventsResponse>(
          `/api/stores/auth-sessions/${sessionId}/credential-events`,
        );
        setSessionCredentialEvents(payload.events);
        setSessionCredentialEventsError(null);
      } catch (error) {
        const nextError = error instanceof Error ? error.message : '接入时间线加载失败';
        if (!silent) {
          setSessionCredentialEventsError(nextError);
        }
      } finally {
        setSessionCredentialEventsLoading(false);
      }
    },
    [sessionId],
  );

  const applyLiveSnapshot = useCallback((payload: StoreAuthSessionLiveSnapshotResponse) => {
    setSessionDetail(payload.sessionDetail);
    setQrSession(payload.qrSession);
    setSessionCredentialEvents(payload.credentialEvents);
    setSessionCredentialEventsLoading(false);
    setSessionCredentialEventsError(null);
  }, []);

  useEffect(() => {
    if (!sessionId) {
      return;
    }

    void loadSession().catch(() => undefined);
  }, [loadSession, sessionId]);

  useEffect(() => {
    if (!sessionId || sessionDetail?.integrationMode !== 'xianyu_web_session') {
      setSessionStreamState('idle');
      setSessionStreamError(null);
      return;
    }

    let cancelled = false;
    let eventSource: EventSource | null = null;

    const connectLiveStream = async () => {
      setSessionStreamState('connecting');
      setSessionStreamError(null);

      try {
        const payload = await apiRequest<StoreAuthSessionLiveStreamTokenResponse>(
          `/api/stores/auth-sessions/${sessionId}/live-stream-token`,
          {
            method: 'POST',
            body: '{}',
          },
        );
        if (cancelled) {
          return;
        }

        const streamUrl = `${resolveApiPath(
          `/api/stores/auth-sessions/${sessionId}/live-stream`,
        )}?streamToken=${encodeURIComponent(payload.streamToken)}`;
        eventSource = new EventSource(streamUrl);
        eventSource.onopen = () => {
          if (!cancelled) {
            setSessionStreamState('live');
            setSessionStreamError(null);
          }
        };
        eventSource.addEventListener('snapshot', (event) => {
          if (cancelled) {
            return;
          }

          try {
            const livePayload = JSON.parse((event as MessageEvent<string>).data) as StoreAuthSessionLiveSnapshotResponse;
            applyLiveSnapshot(livePayload);
            setSessionStreamState('live');
            setSessionStreamError(null);
          } catch {
            setSessionStreamState('error');
            setSessionStreamError('实时推送返回了无法解析的数据，请先手动刷新当前会话。');
          }
        });
        eventSource.onerror = () => {
          if (cancelled) {
            return;
          }

          setSessionStreamState(
            eventSource?.readyState === EventSource.CONNECTING ? 'reconnecting' : 'error',
          );
          setSessionStreamError('实时推送已断开，正在尝试重连；如持续失败，可手动刷新扫码状态。');
        };
      } catch (error) {
        if (cancelled) {
          return;
        }

        setSessionStreamState('error');
        setSessionStreamError(error instanceof Error ? error.message : '实时推送连接失败');
      }
    };

    void connectLiveStream();

    return () => {
      cancelled = true;
      eventSource?.close();
    };
  }, [applyLiveSnapshot, sessionDetail?.integrationMode, sessionId]);

  useEffect(() => {
    if (!sessionDetail || sessionDetail.integrationMode !== 'xianyu_web_session') {
      setSessionCredentialEvents([]);
      setSessionCredentialEventsError(null);
      setSessionCredentialEventsLoading(false);
      return;
    }

    void loadSessionCredentialEvents(true);
  }, [loadSessionCredentialEvents, sessionDetail]);

  useEffect(() => {
    if (
      !sessionDetail ||
      (sessionDetail.integrationMode !== 'xianyu_browser_oauth' &&
        sessionDetail.integrationMode !== 'xianyu_web_session')
    ) {
      return;
    }

    const nextValues = {
      providerUserId: sessionDetail.providerUserId ?? '',
      providerShopId: sessionDetail.providerShopId ?? '',
      providerShopName: sessionDetail.providerShopName ?? sessionDetail.nickname ?? '',
      mobile: sessionDetail.mobile ?? '',
      nickname: sessionDetail.nickname ?? sessionDetail.providerShopName ?? '',
      scopeText: sessionDetail.scopeText ?? '',
      refreshToken: '',
    };

    profileSyncForm.setFieldsValue(nextValues);
    const currentCookieText = webSessionForm.getFieldValue('cookieText');
    webSessionForm.setFieldsValue({
      cookieText: currentCookieText ?? '',
      ...nextValues,
    });
  }, [profileSyncForm, sessionDetail, webSessionForm]);

  useEffect(() => {
    if (!sessionDetail || sessionDetail.integrationMode !== 'xianyu_web_session' || sessionDetail.tokenReceived) {
      return;
    }

    void loadQrSession(true);
  }, [loadQrSession, sessionDetail]);

  const buildWebSessionSyncPayload = (values: WebSessionSyncFormValues) => {
    const trimmedCookieText = values.cookieText?.trim() ?? '';
    return {
      ...values,
      cookieText: trimmedCookieText || undefined,
    };
  };

  const validateWebSessionCookieField = async (_: unknown, value: string | undefined) => {
    const trimmedCookieText = value?.trim() ?? '';
    if (!trimmedCookieText) {
      if (sessionDetail?.integrationMode === 'xianyu_web_session' && sessionDetail.tokenReceived) {
        return Promise.resolve();
      }
      return Promise.reject(new Error('请先粘贴完整 Cookie，或先完成扫码接收登录态。'));
    }

    if (trimmedCookieText.length < 10) {
      return Promise.reject(new Error('请输入完整的网页登录态或 Cookie 串。'));
    }

    return Promise.resolve();
  };

  const detectWebSessionProfile = useCallback(async () => {
    if (!sessionId) {
      return;
    }

    setProfileDetectSubmitting(true);
    try {
      const payload = await apiRequest<StoreWebSessionProfileDetectResponse>(
        `/api/stores/auth-sessions/${sessionId}/web-session-detect-profile`,
        {
          method: 'POST',
          body: '{}',
        },
      );

      const currentValues = webSessionForm.getFieldsValue();
      const nextValues = {
        providerUserId: payload.providerUserId ?? currentValues.providerUserId ?? '',
        providerShopId: payload.providerShopId ?? currentValues.providerShopId ?? '',
        providerShopName: payload.providerShopName ?? currentValues.providerShopName ?? '',
        mobile: payload.mobile ?? currentValues.mobile ?? '',
        nickname: payload.nickname ?? currentValues.nickname ?? '',
        scopeText: currentValues.scopeText ?? '',
        refreshToken: currentValues.refreshToken ?? '',
      };

      profileSyncForm.setFieldsValue(nextValues);
      webSessionForm.setFieldsValue({
        ...currentValues,
        ...nextValues,
      });

      if (payload.detected) {
        messageApi.success(payload.detail);
      } else {
        messageApi.warning(payload.detail);
      }

      await Promise.all([loadSession(), loadSessionCredentialEvents(true)]);
    } catch (error) {
      messageApi.error(error instanceof Error ? error.message : '自动探测网页登录态资料失败');
    } finally {
      setProfileDetectSubmitting(false);
    }
  }, [loadSession, loadSessionCredentialEvents, messageApi, profileSyncForm, sessionId, webSessionForm]);

  const sessionCredentialTimelineItems = useMemo<SessionCredentialTimelineItem[]>(() => {
    const persistedItems = sessionCredentialEvents.map((event) => ({
      key: `event-${event.id}`,
      title: event.eventTypeText,
      status: event.status,
      statusText: event.statusText,
      detail: event.detail,
      createdAt: event.createdAt,
      verificationUrl: event.verificationUrl,
      meta: [event.operatorName ?? '系统任务', event.source ? `来源：${event.source}` : null]
        .filter(Boolean)
        .join(' · '),
    }));

    if (!qrSession) {
      return persistedItems;
    }

    const qrMetaParts = [
      qrSession.cookieMasked ? `Cookie：${qrSession.cookieMasked}` : null,
      qrSession.status === 'waiting' ? `过期：${qrSession.expiresAt}` : null,
    ].filter(Boolean);

    return [
      {
        key: `qr-live-${qrSession.qrLoginId}`,
        title: '扫码进度',
        status: qrSessionTimelineStatus(qrSession.status),
        statusText: qrLoginStatusText(qrSession.status),
        detail: qrSessionTimelineDetail(qrSession),
        createdAt: qrSession.lastPolledAt ?? qrSession.createdAt,
        verificationUrl: qrSession.verificationUrl,
        meta: qrMetaParts.length > 0 ? qrMetaParts.join(' · ') : '实时状态',
      },
      ...persistedItems,
    ];
  }, [qrSession, sessionCredentialEvents]);

  const renderSessionCredentialTimelineCard = () => {
    if (!sessionDetail || sessionDetail.integrationMode !== 'xianyu_web_session') {
      return null;
    }

    const streamStatusText =
      sessionStreamState === 'live'
        ? '实时推送已连接'
        : sessionStreamState === 'connecting'
          ? '正在建立实时推送'
          : sessionStreamState === 'reconnecting'
            ? '实时推送重连中'
            : sessionStreamState === 'error'
              ? '实时推送不可用'
              : '未连接实时推送';

    return (
      <Card
        size="small"
        title="接入时间线"
        style={{ marginTop: 20 }}
        extra={<Typography.Text type="secondary">{streamStatusText}</Typography.Text>}
      >
        {sessionStreamError ? (
          <Alert
            style={{ marginBottom: 12 }}
            type={sessionStreamState === 'error' ? 'warning' : 'info'}
            showIcon
            message={sessionStreamError}
          />
        ) : null}

        {sessionCredentialEventsError ? (
          <Alert
            style={{ marginBottom: 12 }}
            type="error"
            showIcon
            message={sessionCredentialEventsError}
          />
        ) : null}

        {sessionCredentialTimelineItems.length === 0 ? (
          <div style={{ minHeight: 108, display: 'grid', placeItems: 'center' }}>
            {sessionCredentialEventsLoading ? (
              <Spin size="small" />
            ) : (
              <Typography.Text type="secondary">当前会话还没有接入事件记录。</Typography.Text>
            )}
          </div>
        ) : (
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            {sessionCredentialTimelineItems.map((item) => (
              <div
                key={item.key}
                style={{
                  border: '1px solid #f0f0f0',
                  borderRadius: 12,
                  padding: 12,
                  background: '#fff',
                }}
              >
                <Space direction="vertical" size={8} style={{ width: '100%' }}>
                  <Space wrap style={{ justifyContent: 'space-between', width: '100%' }}>
                    <Space wrap>
                      <Typography.Text strong>{item.title}</Typography.Text>
                      <Tag color={credentialEventStatusColor(item.status)}>{item.statusText}</Tag>
                    </Space>
                    <Typography.Text type="secondary">{item.createdAt}</Typography.Text>
                  </Space>
                  <Typography.Paragraph style={{ marginBottom: 0 }}>{item.detail}</Typography.Paragraph>
                  {item.verificationUrl ? (
                    <Typography.Link href={item.verificationUrl} target="_blank" rel="noreferrer">
                      打开验证页
                    </Typography.Link>
                  ) : null}
                  {item.meta ? <Typography.Text type="secondary">{item.meta}</Typography.Text> : null}
                </Space>
              </div>
            ))}

            {sessionCredentialEventsLoading ? (
              <div style={{ display: 'grid', placeItems: 'center' }}>
                <Spin size="small" />
              </div>
            ) : null}
          </Space>
        )}
      </Card>
    );
  };

  if (!sessionId || (platform !== 'xianyu' && platform !== 'taobao')) {
    return <Navigate to="/stores" replace />;
  }

  const renderSimulatedFlow = () => (
    <div className="store-auth-layout">
      <div className="store-auth-side">
        <Typography.Title level={4}>授权并登录协议</Typography.Title>
        <ul className="store-auth-permission-list">
          <li>获取您的登录及用户信息</li>
          <li>读取或更新您店铺的商品数据</li>
          <li>读取商品所参与活动的限制规则信息</li>
        </ul>
        <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
          点击“授权并登录”表示您已同意平台协议，并允许当前工作台创建对应店铺记录。
        </Typography.Paragraph>
      </div>

      <div className="store-auth-form-shell">
        <Segmented
          block
          value={loginMode}
          onChange={(value) => setLoginMode(value as LoginMode)}
          options={[
            { label: '短信验证码登录', value: 'sms' },
            { label: '账号密码登录', value: 'password' },
          ]}
        />

        <Form
          layout="vertical"
          style={{ marginTop: 20 }}
          initialValues={{
            mobile: '',
            verifyCode: '',
            password: '',
            nickname: platform === 'xianyu' ? '新的闲鱼店铺' : '新的淘宝店铺',
            agree: true,
          }}
          onFinish={async (values) => {
            setSubmitting(true);
            try {
              const payload = await apiRequest<StoreAuthCompleteResponse>(
                `/api/stores/auth-sessions/${sessionId}/complete`,
                {
                  method: 'POST',
                  body: JSON.stringify({
                    mobile: values.mobile,
                    nickname: values.nickname,
                    loginMode,
                  }),
                },
              );

              messageApi.success(
                payload.reauthorized ? '重新授权完成，店铺连接已恢复。' : '授权完成，店铺已创建。',
              );
              notifyAndClose({
                storeId: payload.storeId,
                platform: payload.platform,
              });
            } catch (error) {
              messageApi.error(error instanceof Error ? error.message : '授权失败');
            } finally {
              setSubmitting(false);
            }
          }}
        >
          <Form.Item label="手机号" name="mobile" rules={[{ required: true, message: '请输入手机号' }]}>
            <Input placeholder="请输入手机号" />
          </Form.Item>

          {loginMode === 'sms' ? (
            <Form.Item
              label="短信验证码"
              name="verifyCode"
              rules={[{ required: true, message: '请输入短信验证码' }]}
            >
              <Input placeholder="短信验证码" />
            </Form.Item>
          ) : (
            <Form.Item
              label="账号密码"
              name="password"
              rules={[{ required: true, message: '请输入账号密码' }]}
            >
              <Input.Password placeholder="请输入账号密码" />
            </Form.Item>
          )}

          <Form.Item
            label={platform === 'xianyu' ? '闲鱼昵称' : '店铺昵称'}
            name="nickname"
            rules={[{ required: true, message: '请输入昵称' }]}
          >
            <Input placeholder="授权后用于生成店铺名称" />
          </Form.Item>

          <Form.Item
            name="agree"
            valuePropName="checked"
            rules={[
              {
                validator: (_, value) =>
                  value ? Promise.resolve() : Promise.reject(new Error('请先同意协议')),
              },
            ]}
          >
            <Checkbox>我已阅读并同意相关授权协议与隐私说明</Checkbox>
          </Form.Item>

          <Space>
            <Button onClick={() => window.close()}>取消</Button>
            <Button type="primary" htmlType="submit" loading={submitting}>
              授权并登录
            </Button>
          </Space>
        </Form>
      </div>
    </div>
  );

  const renderRealXianyuFlow = (detail: StoreAuthSessionDetailResponse) => (
    <div className="store-auth-layout">
      <div className="store-auth-side">
        <Typography.Title level={4}>真实授权接入</Typography.Title>
        <Typography.Paragraph type="secondary">
          当前会话已经切换到闲鱼真实授权模式。先完成闲鱼官方授权，再把卖家与店铺资料补齐到当前系统；后续拿到平台接口文档后，这一步可以直接替换为自动拉取。
        </Typography.Paragraph>
        <Descriptions size="small" column={1} bordered>
          <Descriptions.Item label="授权模式">闲鱼浏览器授权</Descriptions.Item>
          <Descriptions.Item label="回调地址">{detail.callbackUrl ?? '未配置'}</Descriptions.Item>
          <Descriptions.Item label="当前状态">
            {detail.tokenReceived ? '已接收官方回调' : '等待跳转到官方授权页'}
          </Descriptions.Item>
          <Descriptions.Item label="资料同步">
            {detail.profileSyncStatusText}
          </Descriptions.Item>
          <Descriptions.Item label="下一步">{detail.nextStepText}</Descriptions.Item>
          <Descriptions.Item label="授权令牌">
            {detail.providerAccessTokenMasked ?? '尚未接收'}
          </Descriptions.Item>
        </Descriptions>
      </div>

      <div className="store-auth-form-shell">
        <Alert
          type={detail.tokenReceived ? 'success' : 'warning'}
          showIcon
          message={
            detail.tokenReceived
              ? detail.nextStepKey === 'done'
                ? '店铺资料已同步完成'
                : '授权回调已接收'
              : '当前仅完成真实授权骨架，回调后还需要继续补齐卖家与店铺资料。'
          }
          description={
            detail.tokenReceived
              ? `已于 ${detail.providerAccessTokenReceivedAt ?? '刚刚'} 安全保存 access token，${detail.nextStepText}`
              : '请确认闲鱼开放平台资质、APP Key、APP Secret、回调域名和聚石塔约束均已完成。'
          }
          className="store-auth-alert"
        />

        <Typography.Title level={5} style={{ marginTop: 20 }}>
          会话说明
        </Typography.Title>
        <ul className="store-auth-permission-list">
          {detail.instructions.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>

        {detail.profileSyncError ? (
          <Alert
            style={{ marginTop: 16 }}
            type="error"
            showIcon
            message="上次资料同步失败"
            description={detail.profileSyncError}
          />
        ) : null}

        {detail.tokenReceived && detail.nextStepKey !== 'done' ? (
          <Form<RealProfileSyncFormValues>
            form={profileSyncForm}
            layout="vertical"
            style={{ marginTop: 20 }}
            onFinish={async (values) => {
              setProfileSyncSubmitting(true);
              try {
                const payload = await apiRequest<StoreAuthProfileSyncResponse>(
                  `/api/stores/auth-sessions/${sessionId}/profile-sync`,
                  {
                    method: 'POST',
                    body: JSON.stringify(values),
                  },
                );

                messageApi.success(
                  payload.reauthorized ? '店铺资料已重新同步，绑定关系已更新。' : '店铺资料已同步，绑店完成。',
                );
                notifyAndClose({
                  storeId: payload.storeId,
                  platform: payload.platform,
                });
              } catch (error) {
                messageApi.error(error instanceof Error ? error.message : '资料同步失败');
                await loadSession();
              } finally {
                setProfileSyncSubmitting(false);
              }
            }}
          >
            <Typography.Title level={5} style={{ marginBottom: 12 }}>
              手动补齐卖家资料
            </Typography.Title>
            <Form.Item
              label="卖家 ID"
              name="providerUserId"
              rules={[{ required: true, message: '请输入卖家 ID' }]}
            >
              <Input placeholder="例如闲鱼返回的 userId / sellerId" />
            </Form.Item>
            <Form.Item
              label="店铺 ID"
              name="providerShopId"
              rules={[{ required: true, message: '请输入店铺 ID' }]}
            >
              <Input placeholder="用于绑定唯一店铺标识" />
            </Form.Item>
            <Form.Item
              label="店铺名称"
              name="providerShopName"
              rules={[{ required: true, message: '请输入店铺名称' }]}
            >
              <Input placeholder="店铺名称或官方返回的 shopName" />
            </Form.Item>
            <Form.Item
              label="展示昵称"
              name="nickname"
              rules={[{ required: true, message: '请输入展示昵称' }]}
            >
              <Input placeholder="用于接入中心展示，可与店铺名称一致" />
            </Form.Item>
            <Form.Item
              label="手机号"
              extra="可填写脱敏手机号，例如 138****0000。"
              name="mobile"
              rules={[{ required: true, message: '请输入手机号或脱敏手机号' }]}
            >
              <Input placeholder="手机号或脱敏手机号" />
            </Form.Item>
            <Form.Item label="权限范围" name="scopeText">
              <Input placeholder="可选，记录本次授权返回的 scope" />
            </Form.Item>
            <Form.Item label="刷新令牌" name="refreshToken">
              <Input.Password placeholder="可选，后续拿到 refresh token 再补入" />
            </Form.Item>

            <Space wrap>
              <Button type="primary" htmlType="submit" loading={profileSyncSubmitting}>
                同步资料并完成绑店
              </Button>
              <Button onClick={() => void loadSession()}>刷新会话</Button>
              <Button onClick={() => window.close()}>关闭弹窗</Button>
            </Space>
          </Form>
        ) : (
          <Space wrap style={{ marginTop: 12 }}>
            <Button
              type="primary"
              disabled={!detail.authorizeUrl}
              onClick={() => {
                if (!detail.authorizeUrl) {
                  messageApi.error('当前未生成可用的官方授权地址，请先检查服务端配置。');
                  return;
                }

                window.location.assign(detail.authorizeUrl);
              }}
            >
              {detail.tokenReceived ? '重新打开闲鱼官方授权页' : '前往闲鱼官方授权'}
            </Button>
            <Button onClick={() => void loadSession()}>刷新回调状态</Button>
            <Button onClick={() => window.close()}>关闭弹窗</Button>
          </Space>
        )}
      </div>
    </div>
  );

  const renderQrManualHandoffCard = () => {
    if (
      !qrSession ||
      (!qrSession.verificationUrl &&
        !qrSession.failureReason &&
        qrSession.status !== 'verification_required')
    ) {
      return null;
    }

    return (
      <Card size="small" title="验证码人工接管" style={{ marginTop: 20 }}>
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Alert
            type="warning"
            showIcon
            message="扫码流程命中平台风控，需要人工补做验证"
            description="请在已登录闲鱼的浏览器或手机端完成验证，再回到当前窗口刷新扫码状态；若验证后仍无法收取 Cookie，可改为浏览器续登。"
          />
          <Descriptions size="small" column={1} bordered>
            <Descriptions.Item label="当前状态">
              <Tag color={qrLoginStatusColor(qrSession.status)}>{qrLoginStatusText(qrSession.status)}</Tag>
            </Descriptions.Item>
            <Descriptions.Item label="验证地址">
              {qrSession.verificationUrl ? (
                <Typography.Link href={qrSession.verificationUrl} target="_blank" rel="noreferrer">
                  打开验证页
                </Typography.Link>
              ) : (
                '平台未返回验证地址，请先在原扫码环境中继续操作'
              )}
            </Descriptions.Item>
            <Descriptions.Item label="补充说明">
              {qrSession.failureReason ?? '完成验证后点击“刷新扫码状态”，直到状态变为“已登录待接收”。'}
            </Descriptions.Item>
          </Descriptions>
          <div>
            <Typography.Text strong>处理步骤</Typography.Text>
            <ol style={{ margin: '8px 0 0', paddingInlineStart: 20 }}>
              <li>打开上方验证页，或回到原扫码浏览器/手机端继续完成验证码、确认弹窗等操作。</li>
              <li>完成后回到当前窗口，点击“刷新扫码状态”检查是否已拿到登录态。</li>
              <li>状态变为“已登录待接收”后，点击“接收扫码登录态”把 Cookie 回填到表单。</li>
              <li>若反复验证仍失败，请改用浏览器续登或手动复制 Cookie 导入。</li>
            </ol>
          </div>
          <Space wrap>
            {qrSession.verificationUrl ? (
              <Button
                type="primary"
                onClick={() => {
                  window.open(qrSession.verificationUrl!, '_blank', 'noopener,noreferrer');
                }}
              >
                打开验证页
              </Button>
            ) : null}
            <Button onClick={() => void loadQrSession()}>刷新扫码状态</Button>
          </Space>
        </Space>
      </Card>
    );
  };

  const renderWebSessionFlow = (detail: StoreAuthSessionDetailResponse) => (
    <div className="store-auth-layout">
      <div className="store-auth-side">
        <Typography.Title level={4}>网页登录态接入</Typography.Title>
        <Typography.Paragraph type="secondary">
          当前会话不再依赖闲鱼开放平台 OAuth。请录入可用的网页登录态或 Cookie，再补齐卖家与店铺资料；系统会把凭据加密保存并直接完成绑店。
        </Typography.Paragraph>
        <Descriptions size="small" column={1} bordered>
          <Descriptions.Item label="接入模式">闲鱼网页登录态接入</Descriptions.Item>
          <Descriptions.Item label="当前状态">
            {detail.tokenReceived ? '已录入网页登录态' : '等待录入网页登录态'}
          </Descriptions.Item>
          <Descriptions.Item label="资料同步">{detail.profileSyncStatusText}</Descriptions.Item>
          <Descriptions.Item label="下一步">{detail.nextStepText}</Descriptions.Item>
          <Descriptions.Item label="当前凭据">
            {detail.providerAccessTokenMasked ?? '尚未录入'}
          </Descriptions.Item>
        </Descriptions>
      </div>

      <div className="store-auth-form-shell">
        <Alert
          type="info"
          showIcon
          message="当前模式适合无法使用官方开放平台的场景"
          description="建议先从浏览器开发者工具复制完整 Cookie Header，确认账号当前能正常打开闲鱼卖家页面后再录入。"
          className="store-auth-alert"
        />

        <Typography.Title level={5} style={{ marginTop: 20 }}>
          会话说明
        </Typography.Title>
        <ul className="store-auth-permission-list">
          {detail.instructions.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>

        {detail.profileSyncError ? (
          <Alert
            style={{ marginTop: 16 }}
            type="error"
            showIcon
            message="上次接入失败"
            description={detail.profileSyncError}
          />
        ) : null}

        <Card size="small" title="扫码登录" style={{ marginTop: 20 }}>
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
              生成二维码后，用闲鱼已登录账号扫码并在手机端确认。登录成功后点击“接收扫码登录态”，系统会自动把 Cookie 回填到下方表单。
            </Typography.Paragraph>

            {qrSession ? (
              <>
                <Space wrap>
                  <Tag color={qrLoginStatusColor(qrSession.status)}>{qrLoginStatusText(qrSession.status)}</Tag>
                  {qrSession.cookieMasked ? <Tag>{qrSession.cookieMasked}</Tag> : null}
                  <Typography.Text type="secondary">过期时间：{qrSession.expiresAt}</Typography.Text>
                </Space>
                <div
                  style={{
                    width: 220,
                    height: 220,
                    borderRadius: 12,
                    border: '1px solid #f0f0f0',
                    display: 'grid',
                    placeItems: 'center',
                    overflow: 'hidden',
                    background: '#fff',
                  }}
                >
                  <img src={qrSession.qrCodeUrl} alt="闲鱼扫码登录二维码" style={{ width: '100%', height: '100%' }} />
                </div>
                {qrSession.failureReason ? <Alert type="warning" showIcon message={qrSession.failureReason} /> : null}
                {qrSession.verificationUrl ? (
                  <Alert
                    type="warning"
                    showIcon
                    message="扫码后命中风控"
                    description={
                      <Typography.Link href={qrSession.verificationUrl} target="_blank" rel="noreferrer">
                        打开验证页继续处理
                      </Typography.Link>
                    }
                  />
                ) : null}
              </>
            ) : null}

            <Space wrap>
              <Button
                type="primary"
                loading={qrSubmitting}
                onClick={async () => {
                  setQrSubmitting(true);
                  try {
                    const payload = await apiRequest<StoreQrLoginSessionResponse>(
                      `/api/stores/auth-sessions/${sessionId}/qr-login/generate`,
                      { method: 'POST' },
                    );
                    setQrSession(payload);
                    messageApi.success('扫码登录二维码已生成');
                    void loadSessionCredentialEvents(true);
                  } catch (error) {
                    messageApi.error(error instanceof Error ? error.message : '生成二维码失败');
                  } finally {
                    setQrSubmitting(false);
                  }
                }}
              >
                {qrSession ? '重新生成二维码' : '生成扫码二维码'}
              </Button>
              <Button onClick={() => void loadQrSession()}>刷新扫码状态</Button>
              <Button
                disabled={qrSession?.status !== 'success'}
                loading={qrAccepting}
                onClick={async () => {
                  setQrAccepting(true);
                  try {
                    const payload = await apiRequest<{ nextStepText?: string; verification?: { detail?: string } | null }>(
                      `/api/stores/auth-sessions/${sessionId}/qr-login/accept`,
                      { method: 'POST' },
                    );
                    webSessionForm.setFieldsValue({ cookieText: '' });
                    messageApi.success(payload.nextStepText ?? '扫码登录态已接收');
                    if (payload.verification?.detail) {
                      messageApi.info(payload.verification.detail);
                    }
                    await Promise.all([loadSession(), loadSessionCredentialEvents(true)]);
                  } catch (error) {
                    messageApi.error(error instanceof Error ? error.message : '接收扫码登录态失败');
                  } finally {
                    setQrAccepting(false);
                  }
                }}
              >
                接收扫码登录态
              </Button>
            </Space>

            <Divider style={{ margin: '12px 0' }}>or</Divider>

            {/* Browser QR Login via Playwright */}
            <Typography.Text strong>Browser QR Login (Recommended)</Typography.Text>
            <Typography.Paragraph type="secondary" style={{ marginBottom: 8, marginTop: 4 }}>
              Uses a real browser to open Xianyu pages for QR login, automatically obtaining complete cookies including _m_h5_tk.
            </Typography.Paragraph>

            {browserQrState.qrPngBase64 ? (
              <>
                <Tag color={
                  browserQrState.status === 'waiting' ? 'processing' :
                  browserQrState.status === 'success' ? 'success' :
                  browserQrState.status === 'expired' ? 'default' : 'error'
                }>
                  {browserQrState.status === 'waiting' ? 'Waiting for scan' :
                   browserQrState.status === 'success' ? 'Login success' :
                   browserQrState.status === 'expired' ? 'Expired' :
                   browserQrState.status === 'blocked' ? 'Blocked' :
                   browserQrState.status === 'failed' ? 'Failed' : browserQrState.status}
                </Tag>
                <span style={{ marginLeft: 8, fontSize: 12, opacity: 0.6 }}>
                  Expires: {browserQrState.expiresAt}
                </span>
                <div style={{ width: 300, marginTop: 8, border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8, overflow: 'hidden', background: '#fff' }}>
                  <img src={`data:image/png;base64,${browserQrState.qrPngBase64}`} alt="Browser QR" style={{ width: '100%', display: 'block' }} />
                </div>
                {browserQrState.failureReason ? <Alert type="warning" showIcon message={browserQrState.failureReason} style={{ marginTop: 8 }} /> : null}
              </>
            ) : null}

            <Space wrap style={{ marginTop: 8 }}>
              <Button type="primary" ghost loading={browserQrLoading} onClick={async () => {
                setBrowserQrLoading(true);
                try {
                  const result = await apiRequest<{ status: string; qrPngBase64: string | null; expiresAt: string; failureReason: string | null }>(
                    `/api/stores/auth-sessions/${sessionId}/qr-login/browser-start`, { method: 'POST' },
                  );
                  setBrowserQrState(result);
                  if (result.status === 'waiting') {
                    messageApi.success('Browser QR started');
                    if (browserQrTimerRef.current) clearInterval(browserQrTimerRef.current);
                    browserQrTimerRef.current = setInterval(async () => {
                      try {
                        const s = await apiRequest<{ status: string; qrPngBase64: string | null; expiresAt: string; failureReason: string | null; cookieText: string | null; unb: string | null }>(
                          `/api/stores/auth-sessions/${sessionId}/qr-login/browser-status`,
                        );
                        setBrowserQrState(s);
                        if (s.status === 'success') { messageApi.success('Browser QR login success!'); clearInterval(browserQrTimerRef.current!); }
                        else if (['expired','failed','blocked'].includes(s.status)) { clearInterval(browserQrTimerRef.current!); if (s.failureReason) messageApi.warning(s.failureReason); }
                      } catch {
                        // 轮询阶段忽略瞬时异常，等待下一轮状态刷新。
                      }
                    }, 3000);
                  } else { messageApi.error(result.failureReason || 'Browser QR failed'); }
                } catch (error) { messageApi.error(error instanceof Error ? error.message : 'Browser QR failed'); }
                finally { setBrowserQrLoading(false); }
              }}>
                {browserQrState.qrPngBase64 ? 'Restart Browser QR' : 'Browser QR Login'}
              </Button>
              {browserQrState.status === 'success' ? (
                <Button type="primary" loading={browserQrAccepting} onClick={async () => {
                  setBrowserQrAccepting(true);
                  try {
                    const payload = await apiRequest<{ nextStepText?: string; verification?: { detail?: string } | null }>(
                      `/api/stores/auth-sessions/${sessionId}/qr-login/browser-accept`, { method: 'POST' },
                    );
                    webSessionForm.setFieldsValue({ cookieText: '' });
                    messageApi.success(payload.nextStepText ?? 'Browser QR cookies accepted');
                    if (payload.verification?.detail) messageApi.info(payload.verification.detail);
                    await Promise.all([loadSession(), loadSessionCredentialEvents(true)]);
                  } catch (error) { messageApi.error(error instanceof Error ? error.message : 'Accept failed'); }
                  finally { setBrowserQrAccepting(false); }
                }}>
                  Accept Browser QR Cookies
                </Button>
              ) : null}
            </Space>
          </Space>
        </Card>

        {renderSessionCredentialTimelineCard()}

        {renderQrManualHandoffCard()}

        <Form<WebSessionSyncFormValues>
          form={webSessionForm}
          layout="vertical"
          style={{ marginTop: 20 }}
          onFinish={async (values) => {
            setProfileSyncSubmitting(true);
            try {
              const payload = await apiRequest<StoreAuthProfileSyncResponse>(
                `/api/stores/auth-sessions/${sessionId}/web-session-sync`,
                {
                  method: 'POST',
                  body: JSON.stringify(buildWebSessionSyncPayload(values)),
                },
              );

              messageApi.success(
                payload.reauthorized ? '网页登录态已更新，店铺接入已恢复。' : '网页登录态已录入，绑店完成。',
              );
              notifyAndClose({
                storeId: payload.storeId,
                platform: payload.platform,
              });
            } catch (error) {
              messageApi.error(error instanceof Error ? error.message : '网页登录态录入失败');
              await loadSession();
            } finally {
              setProfileSyncSubmitting(false);
            }
          }}
        >
          <Typography.Title level={5} style={{ marginBottom: 12 }}>
            录入网页登录态与店铺资料
          </Typography.Title>
          <Space wrap style={{ marginBottom: 12 }}>
            <Button
              onClick={() => void detectWebSessionProfile()}
              loading={profileDetectSubmitting}
              disabled={!detail.tokenReceived}
            >
              自动探测账号资料
            </Button>
            <Typography.Text type="secondary">
              不知道卖家 ID 或店铺标识时，可基于当前已收登录态自动回填。
            </Typography.Text>
          </Space>
          <Form.Item
            label="Cookie / 会话串"
            name="cookieText"
            rules={[{ validator: validateWebSessionCookieField }]}
            extra={
              sessionDetail?.tokenReceived
                ? '已通过扫码接收登录态，这里可以留空；只有在需要手动覆写时再粘贴 Cookie。'
                : '建议直接粘贴完整 Cookie 串，系统会加密保存。'
            }
          >
            <Input.TextArea rows={5} placeholder="例如 cookie1=value1; cookie2=value2; ..." />
          </Form.Item>
          <Form.Item
            label="卖家 ID"
            name="providerUserId"
            rules={[{ required: true, message: '请输入卖家 ID' }]}
          >
            <Input placeholder="例如用户 UID / sellerId" />
          </Form.Item>
          <Form.Item
            label="店铺 ID"
            name="providerShopId"
            rules={[{ required: true, message: '请输入店铺 ID' }]}
          >
            <Input placeholder="用于绑定唯一店铺标识" />
          </Form.Item>
          <Form.Item
            label="店铺名称"
            name="providerShopName"
            rules={[{ required: true, message: '请输入店铺名称' }]}
          >
            <Input placeholder="店铺名称或卖家后台展示名" />
          </Form.Item>
          <Form.Item
            label="展示昵称"
            name="nickname"
            rules={[{ required: true, message: '请输入展示昵称' }]}
          >
            <Input placeholder="用于接入中心展示，可与店铺名称一致" />
          </Form.Item>
          <Form.Item
            label="手机号"
            extra="可填写脱敏手机号，例如 138****0000。"
            name="mobile"
            rules={[{ required: true, message: '请输入手机号或脱敏手机号' }]}
          >
            <Input placeholder="手机号或脱敏手机号" />
          </Form.Item>
          <Form.Item label="权限范围" name="scopeText">
            <Input placeholder="可选，记录本次登录态对应的能力范围" />
          </Form.Item>
          <Form.Item label="刷新令牌" name="refreshToken">
            <Input.Password placeholder="可选，若后续拿到平台 refresh token 再补入" />
          </Form.Item>

          <Space wrap>
            <Button type="primary" htmlType="submit" loading={profileSyncSubmitting}>
              保存网页登录态并完成绑店
            </Button>
            <Button onClick={() => void loadSession()}>刷新会话</Button>
            <Button onClick={() => window.close()}>关闭弹窗</Button>
          </Space>
        </Form>
      </div>
    </div>
  );

  return (
    <div className="store-auth-page">
      {contextHolder}
      <Card className="store-auth-card" bordered={false}>
        <div className="store-auth-header">
          <Typography.Title level={2} style={{ marginBottom: 8 }}>
            {platformLabel}
          </Typography.Title>
          <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
            店铺接入弹窗会根据授权会话自动切换为模拟模式、官方授权模式或网页登录态模式，避免把不同接入路线混在一起。
          </Typography.Paragraph>
        </div>

        {loadingDetail ? (
          <div style={{ minHeight: 280, display: 'grid', placeItems: 'center' }}>
            <Spin size="large" />
          </div>
        ) : loadError || !sessionDetail ? (
          <Alert
            type="error"
            showIcon
            message="授权会话加载失败"
            description={loadError ?? '未找到对应的授权会话。'}
          />
        ) : sessionDetail.integrationMode === 'xianyu_browser_oauth' ? (
          renderRealXianyuFlow(sessionDetail)
        ) : sessionDetail.integrationMode === 'xianyu_web_session' ? (
          renderWebSessionFlow(sessionDetail)
        ) : (
          <>
            <Alert
              type="info"
              showIcon
              message="授权后会创建店铺记录，闲鱼店铺创建完成后仍需单独激活。"
              className="store-auth-alert"
            />
            {renderSimulatedFlow()}
          </>
        )}
      </Card>
    </div>
  );
}
