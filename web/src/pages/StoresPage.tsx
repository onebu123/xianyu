import {
  Alert,
  Button,
  Card,
  Col,
  Descriptions,
  Drawer,
  Form,
  Input,
  Modal,
  Row,
  Segmented,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
  message,
} from 'antd';
import type { TableProps } from 'antd';
import { PageContainer } from '@ant-design/pro-components';
import { useCallback, useEffect, useMemo, useState } from 'react';

import type {
  StoreBrowserRenewResponse,
  StoreAuthSessionRecord,
  StoreAuthSessionResponse,
  StoreConnectionStatus,
  StoreCredentialEventRecord,
  StoreCredentialEventsResponse,
  StoreCredentialRiskLevel,
  StoreCredentialVerifyResponse,
  StoreHealthCheckRecord,
  StoreManagementOverviewResponse,
  StoreManagementStore,
  StorePlatform,
} from '../api';
import { apiRequest } from '../api';
import { SummaryCards } from '../components/SummaryCards';
import { routerBasename } from '../config';
import { useRemoteData } from '../hooks/useRemoteData';

type PlatformFilter = 'all' | StorePlatform;
type StatusFilter = 'all' | StoreConnectionStatus;

interface StoreMetaFormValues {
  groupName: string;
  tagsText: string;
  remark: string;
}

function platformLabel(platform: StorePlatform) {
  return platform === 'taobao' ? '淘宝' : '闲鱼';
}

function platformColor(platform: StorePlatform) {
  return platform === 'taobao' ? 'blue' : 'gold';
}

function connectionColor(status: StoreConnectionStatus) {
  return (
    {
      pending_activation: 'warning',
      active: 'success',
      offline: 'default',
      abnormal: 'error',
    }[status] ?? 'default'
  );
}

function authColor(status: StoreManagementStore['authStatus'] | StoreAuthSessionRecord['status']) {
  return (
    {
      authorized: 'success',
      pending: 'processing',
      completed: 'success',
      expired: 'warning',
      invalidated: 'error',
    }[status] ?? 'default'
  );
}

function healthColor(status: StoreHealthCheckRecord['status'] | StoreManagementStore['healthStatus']) {
  return (
    {
      healthy: 'success',
      warning: 'warning',
      offline: 'default',
      abnormal: 'error',
      skipped: 'default',
    }[status] ?? 'default'
  );
}

function credentialRiskColor(status: StoreCredentialRiskLevel | null) {
  return (
    {
      pending: 'default',
      healthy: 'success',
      warning: 'warning',
      offline: 'default',
      abnormal: 'error',
    }[status ?? 'pending'] ?? 'default'
  );
}

function credentialRiskText(status: StoreCredentialRiskLevel | null) {
  return (
    {
      pending: '待校验',
      healthy: '登录态正常',
      warning: '需要验证',
      offline: '已掉线',
      abnormal: '状态异常',
    }[status ?? 'pending'] ?? '待校验'
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

function sessionStepColor(nextStepKey: StoreAuthSessionRecord['nextStepKey']) {
  return (
    {
      manual_complete: 'processing',
      wait_provider_callback: 'warning',
      sync_profile: 'gold',
      done: 'success',
      expired: 'default',
      invalidated: 'error',
    }[nextStepKey] ?? 'default'
  );
}

function triggerModeLabel(triggerMode: StoreHealthCheckRecord['triggerMode']) {
  return triggerMode === 'batch' ? '批量任务' : '手动执行';
}

const learningCenterItems = [
  {
    key: 'manual',
    title: '学习中心',
    description: '按目标站结构保留新手接入、授权说明和常见操作指引入口。',
    items: ['新建店铺前检查授权环境', '掉线店铺重新授权流程', '多店铺批量体检说明'],
  },
  {
    key: 'faq',
    title: '常见问题',
    description: '聚焦掉线、授权过期、同步失败和分组管理等高频问题。',
    items: ['为什么店铺显示掉线', '授权成功后为什么仍待激活', '批量体检适合什么场景'],
  },
  {
    key: 'updates',
    title: '产品动态',
    description: '记录最近功能变更、运营注意事项和接入链路更新。',
    items: ['店铺页已支持批量启停和批量体检', '重新授权会单独保留会话记录', '健康检查结果已区分 warning 与 abnormal'],
  },
];

export function StoresPage() {
  const [messageApi, contextHolder] = message.useMessage();
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [platformFilter, setPlatformFilter] = useState<PlatformFilter>('all');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [keyword, setKeyword] = useState('');
  const [selectedRowKeys, setSelectedRowKeys] = useState<number[]>([]);
  const [editingStore, setEditingStore] = useState<StoreManagementStore | null>(null);
  const [credentialPanelStoreId, setCredentialPanelStoreId] = useState<number | null>(null);
  const [credentialEvents, setCredentialEvents] = useState<StoreCredentialEventRecord[]>([]);
  const [credentialEventsLoading, setCredentialEventsLoading] = useState(false);
  const [credentialEventsError, setCredentialEventsError] = useState<string | null>(null);
  const [metaForm] = Form.useForm<StoreMetaFormValues>();

  const loader = useCallback(
    async () =>
      apiRequest<StoreManagementOverviewResponse>('/api/stores/management', undefined),
    [],
  );

  const { data, loading, error, reload } = useRemoteData(loader);

  const loadCredentialEvents = useCallback(
    async (storeId: number, silent = false) => {
      setCredentialEventsLoading(true);
      if (!silent) {
        setCredentialEventsError(null);
      }

      try {
        const payload = await apiRequest<StoreCredentialEventsResponse>(
          `/api/stores/${storeId}/credential-events`,
          undefined,
        );
        setCredentialEvents(payload.events);
        setCredentialEventsError(null);
      } catch (requestError) {
        const nextError = requestError instanceof Error ? requestError.message : '加载凭据时间线失败';
        setCredentialEventsError(nextError);
        setCredentialEvents([]);
      } finally {
        setCredentialEventsLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) {
        return;
      }

      if (event.data?.type === 'store-auth-complete') {
        messageApi.success('店铺授权已完成，接入中心已刷新。');
        void reload();
        return;
      }

      if (event.data?.type === 'store-auth-provider-callback') {
        messageApi.success(event.data?.nextStepText ?? '已接收闲鱼官方回调，接入中心已刷新。');
        void reload();
      }
    };

    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [messageApi, reload]);

  useEffect(() => {
    if (!data) {
      return;
    }

    const validStoreIds = new Set(data.stores.map((store) => store.id));
    setSelectedRowKeys((current) => current.filter((storeId) => validStoreIds.has(storeId)));
  }, [data]);

  useEffect(() => {
    if (!credentialPanelStoreId) {
      setCredentialEvents([]);
      setCredentialEventsError(null);
      setCredentialEventsLoading(false);
      return;
    }

    void loadCredentialEvents(credentialPanelStoreId, true);
  }, [credentialPanelStoreId, loadCredentialEvents]);

  const runMutation = useCallback(
    async (key: string, successMessage: string, fn: () => Promise<void>) => {
      setBusyKey(key);
      try {
        await fn();
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

  const openAuthPopup = useCallback(
    async (platform: StorePlatform, store?: StoreManagementStore) => {
      const actionKey = store ? `reauthorize-${store.id}` : `create-${platform}`;
      setBusyKey(actionKey);
      try {
        const session = await apiRequest<StoreAuthSessionResponse>(
          '/api/stores/auth-sessions',
          {
            method: 'POST',
            body: JSON.stringify({
              platform,
              source: 'shop',
              authType: platform === 'xianyu' ? 11 : 21,
              ...(store ? { storeId: store.id } : {}),
            }),
          },
        );

        const base = routerBasename === '/' ? '' : routerBasename;
        const url = `${window.location.origin}${base}/stores/connect/${platform}?sessionId=${session.sessionId}`;
        const popup = window.open(
          url,
          `${platform}-store-auth-${session.sessionId}`,
          'popup=yes,width=920,height=760',
        );

        if (!popup) {
          throw new Error('浏览器阻止了授权弹窗，请允许弹窗后重试。');
        }

        messageApi.success(store ? '已发起重新授权会话。' : '已创建新的授权会话。');
      } catch (requestError) {
        messageApi.error(requestError instanceof Error ? requestError.message : '创建授权会话失败');
      } finally {
        setBusyKey(null);
      }
    },
    [messageApi],
  );

  const openExistingSessionPopup = useCallback(
    (session: Pick<StoreAuthSessionRecord, 'platform' | 'sessionId'>) => {
      const base = routerBasename === '/' ? '' : routerBasename;
      const url = `${window.location.origin}${base}/stores/connect/${session.platform}?sessionId=${session.sessionId}`;
      const popup = window.open(url, `${session.platform}-store-auth-${session.sessionId}`, 'popup=yes,width=920,height=760');
      if (!popup) {
        messageApi.error('浏览器阻止了授权弹窗，请允许弹窗后重试。');
      }
    },
    [messageApi],
  );

  const updateStoreEnabled = useCallback(
    async (store: StoreManagementStore, enabled: boolean) => {
      await runMutation(
        `enabled-${store.id}`,
        enabled ? `已启用店铺 ${store.shopName}` : `已停用店铺 ${store.shopName}`,
        async () => {
          await apiRequest(
            `/api/stores/${store.id}/enabled`,
            {
              method: 'POST',
              body: JSON.stringify({ enabled }),
            },
          );
        },
      );
    },
    [runMutation],
  );

  const activateStore = useCallback(
    async (store: StoreManagementStore) => {
      await runMutation(`activate-${store.id}`, `店铺 ${store.shopName} 已激活`, async () => {
        await apiRequest(
          `/api/stores/${store.id}/activate`,
          {
            method: 'POST',
            body: '{}',
          },
        );
      });
    },
    [runMutation],
  );

  const runHealthCheck = useCallback(
    async (store: StoreManagementStore) => {
      await runMutation(`health-${store.id}`, `已完成 ${store.shopName} 的健康检查`, async () => {
        await apiRequest(
          `/api/stores/${store.id}/health-check`,
          {
            method: 'POST',
            body: '{}',
          },
        );
      });
    },
    [runMutation],
  );

  const verifyCredential = useCallback(
    async (store: StoreManagementStore) => {
      const actionKey = `verify-${store.id}`;
      setBusyKey(actionKey);
      try {
        const payload = await apiRequest<StoreCredentialVerifyResponse>(
          `/api/stores/${store.id}/credential-verify`,
          {
            method: 'POST',
            body: '{}',
          },
        );
        setCredentialPanelStoreId(store.id);
        messageApi.success(payload.detail);
        await reload();
        await loadCredentialEvents(store.id, true);
      } catch (requestError) {
        messageApi.error(requestError instanceof Error ? requestError.message : '登录态校验失败');
      } finally {
        setBusyKey(null);
      }
    },
    [loadCredentialEvents, messageApi, reload],
  );

  const renewCredential = useCallback(
    async (store: StoreManagementStore) => {
      const actionKey = `renew-${store.id}`;
      setBusyKey(actionKey);
      try {
        const payload = await apiRequest<StoreBrowserRenewResponse>(
          `/api/stores/${store.id}/browser-renew`,
          {
            method: 'POST',
            body: JSON.stringify({ showBrowser: true }),
          },
        );
        setCredentialPanelStoreId(store.id);
        messageApi.success(payload.renewDetail);
        await reload();
        await loadCredentialEvents(store.id, true);
      } catch (requestError) {
        messageApi.error(requestError instanceof Error ? requestError.message : '浏览器续登失败');
      } finally {
        setBusyKey(null);
      }
    },
    [loadCredentialEvents, messageApi, reload],
  );

  const openCredentialPanel = useCallback((store: StoreManagementStore) => {
    setCredentialPanelStoreId(store.id);
    void loadCredentialEvents(store.id, true);
  }, [loadCredentialEvents]);

  const openMetaModal = useCallback(
    (store: StoreManagementStore) => {
      setEditingStore(store);
      metaForm.setFieldsValue({
        groupName: store.groupName,
        tagsText: store.tags.join('、'),
        remark: store.remark,
      });
    },
    [metaForm],
  );

  const submitMeta = useCallback(async () => {
    if (!editingStore) {
      return;
    }

    const values = await metaForm.validateFields();
    const tags = values.tagsText
      .split(/[、,，\s]+/)
      .map((tag) => tag.trim())
      .filter(Boolean);

    await runMutation(`meta-${editingStore.id}`, `已更新 ${editingStore.shopName} 的接入信息`, async () => {
      await apiRequest(
        `/api/stores/${editingStore.id}/meta`,
        {
          method: 'POST',
          body: JSON.stringify({
            groupName: values.groupName,
            tags,
            remark: values.remark,
          }),
        },
      );
      setEditingStore(null);
    });
  }, [editingStore, metaForm, runMutation]);

  const batchSetEnabled = useCallback(
    async (enabled: boolean) => {
      await runMutation(
        `batch-enabled-${enabled ? 'on' : 'off'}`,
        enabled ? '已批量启用选中店铺' : '已批量停用选中店铺',
        async () => {
          await apiRequest(
            '/api/stores/batch/enabled',
            {
              method: 'POST',
              body: JSON.stringify({
                storeIds: selectedRowKeys,
                enabled,
              }),
            },
          );
          setSelectedRowKeys([]);
        },
      );
    },
    [runMutation, selectedRowKeys],
  );

  const batchHealthCheck = useCallback(async () => {
    await runMutation('batch-health-check', '已批量执行健康检查', async () => {
      await apiRequest(
        '/api/stores/batch/health-check',
        {
          method: 'POST',
          body: JSON.stringify({
            storeIds: selectedRowKeys,
          }),
        },
      );
    });
  }, [runMutation, selectedRowKeys]);
  const warningStoreCount = useMemo(
    () => data?.stores.filter((store) => store.credentialRiskLevel === 'warning').length ?? 0,
    [data],
  );

  const summaryItems = useMemo(
    () =>
      data
        ? [
            { key: 'total', label: '接入店铺总数', value: data.summaries.totalStoreCount, unit: '家' },
            { key: 'xianyu', label: '闲鱼店铺', value: data.summaries.xianyuStoreCount, unit: '家' },
            { key: 'taobao', label: '淘宝店铺', value: data.summaries.taobaoStoreCount, unit: '家' },
            { key: 'active', label: '已激活', value: data.summaries.activeStoreCount, unit: '家' },
            { key: 'pending', label: '待激活', value: data.summaries.pendingActivationCount, unit: '家' },
            { key: 'warning', label: '待验证店铺', value: warningStoreCount, unit: '家' },
            { key: 'offline', label: '掉线店铺', value: data.summaries.offlineStoreCount, unit: '家' },
            { key: 'abnormal', label: '异常店铺', value: data.summaries.abnormalStoreCount, unit: '家' },
            { key: 'disabled', label: '已停用', value: data.summaries.disabledStoreCount, unit: '家' },
          ]
        : [],
    [data, warningStoreCount],
  );

  const storeShowcaseCards = useMemo(() => {
    if (!data) {
      return [];
    }

    return [
      {
        key: 'xianyu',
        title: '闲鱼店铺',
        eyebrow: `已接入 ${data.summaries.xianyuStoreCount} 家`,
        helper: '对应目标站里的闲鱼店铺卡片区，突出套餐、状态与店主信息。',
        rows: data.xianyuStores.slice(0, 3).map((store) => ({
          name: store.shopName,
          meta: `${store.nickname} · ${store.packageText}`,
          status: store.connectionStatusText,
        })),
      },
      {
        key: 'taobao',
        title: '淘宝店铺',
        eyebrow: `已接入 ${data.summaries.taobaoStoreCount} 家`,
        helper: '保留淘宝店铺视图，方便和闲鱼主店联动运营。',
        rows: data.taobaoStores.slice(0, 3).map((store) => ({
          name: store.shopName,
          meta: `${store.nickname} · ${store.publishLimitText}`,
          status: store.connectionStatusText,
        })),
      },
      {
        key: 'recycle',
        title: '回收店铺',
        eyebrow: '入口已保留',
        helper: '当前演示库还未接入回收店铺真实数据，但保留了目标站的工作台位置。',
        rows: [
          {
            name: '回收店铺工作区',
            meta: '可继续扩展回收商品、回收订单和回收配置链路',
            status: '待接入',
          },
        ],
      },
    ];
  }, [data]);

  const operationBoardCards = useMemo(() => {
    if (!data) {
      return [];
    }

    return [
      {
        key: 'groups',
        title: '分组作战面板',
        eyebrow: `高风险分组 ${data.groupInsights.filter((group) => group.riskCount > 0).length} 个`,
        helper: '按店铺分组汇总启用量、离线量和风险量，方便做多店铺批量治理。',
        rows: data.groupInsights.slice(0, 4).map((group) => ({
          name: group.name,
          meta: `总数 ${group.count} 路 启用 ${group.activeCount} 路 风险 ${group.riskCount}`,
          status: group.offlineCount > 0 ? `离线 ${group.offlineCount}` : '稳定',
        })),
      },
      {
        key: 'owners',
        title: '负责人负载',
        eyebrow: `负责人 ${data.ownerInsights.length} 人`,
        helper: '聚合负责人名下店铺和风险负载，便于安排续登、授权和同步回收。',
        rows: data.ownerInsights.slice(0, 4).map((owner) => ({
          name: owner.ownerName,
          meta: `店铺 ${owner.storeCount} 路 启用 ${owner.activeCount} 路 分组 ${owner.groups.join(' / ') || '未分组'}`,
          status: owner.riskCount > 0 ? `风险 ${owner.riskCount}` : '稳定',
        })),
      },
      {
        key: 'risks',
        title: '风险店铺队列',
        eyebrow: `待处理 ${data.riskStores.length} 家`,
        helper: '优先处理掉线、异常和登录态待验证店铺，避免同步链路中断。',
        rows: data.riskStores.slice(0, 4).map((store) => ({
          name: store.shopName,
          meta: `${store.groupName} 路 ${store.ownerAccountName ?? '未分配负责人'} 路 ${store.healthStatusText}`,
          status:
            store.connectionStatusText === '已激活'
              ? credentialRiskText(store.credentialRiskLevel)
              : store.connectionStatusText,
        })),
      },
    ];
  }, [data]);

  const filteredStores = useMemo(() => {
    if (!data) {
      return [];
    }

    const normalizedKeyword = keyword.trim().toLowerCase();

    return data.stores.filter((store) => {
      if (platformFilter !== 'all' && store.platform !== platformFilter) {
        return false;
      }

      if (statusFilter !== 'all' && store.connectionStatus !== statusFilter) {
        return false;
      }

      if (!normalizedKeyword) {
        return true;
      }

      const haystack = [
        store.shopName,
        store.sellerNo,
        store.ownerAccountName ?? '',
        store.ownerMobile ?? '',
        store.groupName,
        store.remark,
        store.tags.join(' '),
      ]
        .join(' ')
        .toLowerCase();

      return haystack.includes(normalizedKeyword);
    });
  }, [data, keyword, platformFilter, statusFilter]);

  const selectedStores = useMemo(
    () => filteredStores.filter((store) => selectedRowKeys.includes(store.id)),
    [filteredStores, selectedRowKeys],
  );

  const activeCredentialStore = useMemo(
    () => data?.stores.find((store) => store.id === credentialPanelStoreId) ?? null,
    [credentialPanelStoreId, data],
  );

  const storeColumns = useMemo<TableProps<StoreManagementStore>['columns']>(
    () => [
      {
        title: '店铺',
        dataIndex: 'shopName',
        width: 220,
        render: (_value, store) => (
          <div className="store-cell-stack">
            <Space wrap>
              <Typography.Text strong>{store.shopName}</Typography.Text>
              <Tag color={platformColor(store.platform)}>{platformLabel(store.platform)}</Tag>
            </Space>
            <div className="store-cell-meta">
              卖家号：{store.sellerNo} · 负责人：{store.ownerAccountName ?? '未绑定'}
            </div>
            <div className="store-cell-meta">{store.publishLimitText}</div>
          </div>
        ),
      },
      {
        title: '接入状态',
        dataIndex: 'connectionStatus',
        width: 180,
        render: (_value, store) => (
          <div className="store-cell-stack">
            <Space wrap>
              <Tag color={connectionColor(store.connectionStatus)}>{store.connectionStatusText}</Tag>
              {!store.enabled ? <Tag>已停用</Tag> : null}
            </Space>
            <div className="store-cell-meta">{store.statusText}</div>
            {store.activationHint ? <div className="store-cell-meta">{store.activationHint}</div> : null}
          </div>
        ),
      },
      {
        title: '授权与健康',
        dataIndex: 'authStatus',
        width: 220,
        render: (_value, store) => (
          <div className="store-cell-stack">
            <Space wrap>
              <Tag color={authColor(store.authStatus)}>{store.authStatusText}</Tag>
              <Tag color={healthColor(store.healthStatus)}>{store.healthStatusText}</Tag>
              {store.credentialType === 'web_session' ? (
                <Tag color={credentialRiskColor(store.credentialRiskLevel)}>
                  {credentialRiskText(store.credentialRiskLevel)}
                </Tag>
              ) : null}
            </Space>
            <div className="store-cell-meta">授权到期：{store.authExpiresAt ?? '未记录'}</div>
            <div className="store-cell-meta">
              最近体检：{store.lastHealthCheckAt ?? '未执行'} · {store.lastHealthCheckDetail ?? '暂无说明'}
            </div>
            <div className="store-cell-meta">
              资料同步：{store.profileSyncStatusText}
              {store.lastProfileSyncAt ? ` · ${store.lastProfileSyncAt}` : ''}
            </div>
            {store.credentialRiskReason ? (
              <div className="store-cell-meta">登录态说明：{store.credentialRiskReason}</div>
            ) : null}
            {store.credentialType === 'web_session' ? (
              <div className="store-cell-meta">
                最近续登：{store.lastCredentialRenewAt ?? '未执行'}
                {store.lastCredentialRenewStatus ? ` · ${store.lastCredentialRenewStatus}` : ''}
              </div>
            ) : null}
          </div>
        ),
      },
      {
        title: '分组与标签',
        dataIndex: 'groupName',
        width: 220,
        render: (_value, store) => (
          <div className="store-cell-stack">
            <Tag color="geekblue">{store.groupName}</Tag>
            <div className="store-tag-list">
              {store.tags.length > 0 ? store.tags.map((tag) => <Tag key={`${store.id}-${tag}`}>{tag}</Tag>) : '未设置标签'}
            </div>
            <div className="store-cell-meta">{store.remark || '暂无备注'}</div>
          </div>
        ),
      },
      {
        title: '同步与操作员',
        dataIndex: 'lastSyncAt',
        width: 200,
        render: (_value, store) => (
          <div className="store-cell-stack">
            <div className="store-cell-meta">最近同步：{store.lastSyncAt ?? '未同步'}</div>
            <div className="store-cell-meta">最近重授：{store.lastReauthorizeAt ?? '未执行'}</div>
            <div className="store-cell-meta">
              平台标识：{store.providerStoreId ?? '未绑定'} · {store.providerUserId ?? '未写入'}
            </div>
            <div className="store-cell-meta">创建人：{store.createdByName ?? '系统'}</div>
          </div>
        ),
      },
      {
        title: '启停',
        dataIndex: 'enabled',
        width: 100,
        render: (_value, store) => (
          <Switch
            checked={store.enabled}
            checkedChildren="启用"
            unCheckedChildren="停用"
            loading={busyKey === `enabled-${store.id}`}
            onChange={(enabled) => void updateStoreEnabled(store, enabled)}
          />
        ),
      },
      {
        title: '操作',
        key: 'actions',
        fixed: 'right',
        width: 510,
        render: (_value, store) => (
          <Space wrap>
            {store.connectionStatus === 'pending_activation' ? (
              <Button
                size="small"
                type="primary"
                loading={busyKey === `activate-${store.id}`}
                onClick={() => void activateStore(store)}
              >
                激活
              </Button>
            ) : null}
            <Button
              size="small"
              loading={busyKey === `reauthorize-${store.id}`}
              onClick={() => void openAuthPopup(store.platform, store)}
            >
              重新授权
            </Button>
            <Button
              size="small"
              loading={busyKey === `health-${store.id}`}
              onClick={() => void runHealthCheck(store)}
            >
              体检
            </Button>
            {store.platform === 'xianyu' && store.credentialType === 'web_session' ? (
              <Button
                size="small"
                loading={busyKey === `verify-${store.id}`}
                onClick={() => void verifyCredential(store)}
              >
                校验登录态
              </Button>
            ) : null}
            {store.platform === 'xianyu' && store.credentialType === 'web_session' ? (
              <Button
                size="small"
                loading={busyKey === `renew-${store.id}`}
                onClick={() => void renewCredential(store)}
              >
                浏览器续登
              </Button>
            ) : null}
            {store.platform === 'xianyu' && store.credentialType === 'web_session' ? (
              <Button size="small" onClick={() => openCredentialPanel(store)}>
                凭据详情
              </Button>
            ) : null}
            <Button size="small" onClick={() => openMetaModal(store)}>
              编辑
            </Button>
          </Space>
        ),
      },
    ],
    [
      activateStore,
      busyKey,
      openAuthPopup,
      openCredentialPanel,
      openMetaModal,
      renewCredential,
      runHealthCheck,
      updateStoreEnabled,
      verifyCredential,
    ],
  );

  const sessionColumns = useMemo<TableProps<StoreAuthSessionRecord>['columns']>(
    () => [
      {
        title: '会话',
        dataIndex: 'sessionId',
        render: (_value, session) => (
          <div className="store-cell-stack">
            <Space wrap>
              <Typography.Text strong>{session.storeName ?? '新店铺接入'}</Typography.Text>
              <Tag color={platformColor(session.platform)}>{platformLabel(session.platform)}</Tag>
            </Space>
            <div className="store-cell-meta">会话 ID：{session.sessionId}</div>
          </div>
        ),
      },
      {
        title: '接入链路',
        dataIndex: 'providerLabel',
        width: 220,
        render: (_value, session) => (
          <div className="store-cell-stack">
            <Space wrap>
              <Tag>{session.providerLabel ?? '站内模拟授权'}</Tag>
              {session.tokenReceived ? <Tag color="success">已收票</Tag> : null}
            </Space>
            <div className="store-cell-meta">{session.nextStepText}</div>
            <div className="store-cell-meta">
              回调时间：{session.providerAccessTokenReceivedAt ?? '尚未接收'}
            </div>
          </div>
        ),
      },
      {
        title: '状态',
        dataIndex: 'status',
        width: 190,
        render: (_value, session) => (
          <div className="store-cell-stack">
            <Space wrap>
              <Tag color={authColor(session.status)}>{session.statusText}</Tag>
              <Tag color={sessionStepColor(session.nextStepKey)}>{session.nextStepText}</Tag>
              {session.reauthorize ? <Tag color="purple">重新授权</Tag> : <Tag>新接入</Tag>}
            </Space>
            <div className="store-cell-meta">到期时间：{session.expiresAt ?? '未记录'}</div>
            <div className="store-cell-meta">
              完成时间：{session.completedAt ?? session.invalidReason ?? '等待回调'}
            </div>
          </div>
        ),
      },
      {
        title: '账号信息',
        dataIndex: 'ownerAccountName',
        render: (_value, session) => (
          <div className="store-cell-stack">
            <div className="store-cell-meta">店主账号：{session.ownerAccountName ?? session.nickname ?? '未绑定'}</div>
            <div className="store-cell-meta">手机号：{session.mobile ?? '未回传'}</div>
            <div className="store-cell-meta">创建人：{session.createdByName ?? '系统'}</div>
          </div>
        ),
      },
      {
        title: '操作',
        key: 'actions',
        width: 120,
        render: (_value, session) => (
          <Button size="small" onClick={() => openExistingSessionPopup(session)}>
            {session.nextStepKey === 'sync_profile' ? '继续绑店' : '查看会话'}
          </Button>
        ),
      },
    ],
    [openExistingSessionPopup],
  );

  const healthColumns = useMemo<TableProps<StoreHealthCheckRecord>['columns']>(
    () => [
      {
        title: '店铺',
        dataIndex: 'storeName',
        render: (_value, record) => (
          <div className="store-cell-stack">
            <Typography.Text strong>{record.storeName ?? '未知店铺'}</Typography.Text>
            <div className="store-cell-meta">
              {triggerModeLabel(record.triggerMode)} · {record.triggeredByName ?? '系统任务'}
            </div>
          </div>
        ),
      },
      {
        title: '结果',
        dataIndex: 'status',
        width: 120,
        render: (_value, record) => <Tag color={healthColor(record.status)}>{record.statusText}</Tag>,
      },
      {
        title: '说明',
        dataIndex: 'detail',
        render: (value: string, record) => (
          <div className="store-cell-stack">
            <div>{value}</div>
            <div className="store-cell-meta">执行时间：{record.checkedAt}</div>
          </div>
        ),
      },
    ],
    [],
  );

  const credentialHistoryColumns = useMemo<TableProps<StoreCredentialEventRecord>['columns']>(
    () => [
      {
        title: '时间',
        dataIndex: 'createdAt',
        width: 180,
        render: (value: string, record) => (
          <div className="store-cell-stack">
            <Typography.Text strong>{value}</Typography.Text>
            <div className="store-cell-meta">{record.operatorName ?? '系统任务'}</div>
          </div>
        ),
      },
      {
        title: '事件',
        dataIndex: 'eventTypeText',
        width: 150,
        render: (value: string, record) => (
          <div className="store-cell-stack">
            <Typography.Text>{value}</Typography.Text>
            <div className="store-cell-meta">
              <Tag color={credentialEventStatusColor(record.status)}>{record.statusText}</Tag>
            </div>
          </div>
        ),
      },
      {
        title: '说明',
        dataIndex: 'detail',
        render: (value: string, record) => (
          <div className="store-cell-stack">
            <div>{value}</div>
            {record.verificationUrl ? (
              <Typography.Link href={record.verificationUrl} target="_blank" rel="noreferrer">
                打开验证页
              </Typography.Link>
            ) : null}
          </div>
        ),
      },
    ],
    [],
  );

  const rowSelection: TableProps<StoreManagementStore>['rowSelection'] = {
    selectedRowKeys,
    onChange: (keys) => setSelectedRowKeys(keys.map((key) => Number(key))),
  };

  return (
    <PageContainer
      title="店铺工作台"
      subTitle="在真实接入中心之上补齐目标站的店铺工作台信息层，统一管理店铺、授权、健康和服务入口。"
      style={{ paddingInline: 0 }}
      extra={[
        <Button key="refresh" onClick={() => void reload()}>
          刷新
        </Button>,
        <Button
          key="taobao"
          loading={busyKey === 'create-taobao'}
          onClick={() => void openAuthPopup('taobao')}
        >
          新增淘宝店铺
        </Button>,
        <Button
          key="xianyu"
          type="primary"
          loading={busyKey === 'create-xianyu'}
          onClick={() => void openAuthPopup('xianyu')}
        >
          新增闲鱼店铺
        </Button>,
      ]}
    >
      {contextHolder}
      <div className="page-grid">
        {error ? <Alert type="error" showIcon message={error} /> : null}

        <Alert
          type="info"
          showIcon
          message="第 3 轮已切换到真实接入中心视图，支持多店铺接入、重新授权、启停、批量体检和状态区分。"
        />

        {data ? <SummaryCards items={summaryItems} /> : null}

        {data ? (
          <div className="glass-panel store-center-hero">
            <div className="store-center-hero-top">
              <div className="store-center-operator">
                <div className="store-center-eyebrow">当前操作员</div>
                <Typography.Title level={3} style={{ margin: '8px 0 4px' }}>
                  {data.profile.displayName}
                </Typography.Title>
                <div className="store-center-meta">联系方式：{data.profile.mobile}</div>
                <div className="store-center-meta">资料更新时间：{data.profile.updatedAt}</div>
                <div className="store-center-meta">
                  已启用 {data.summaries.enabledStoreCount} 家，待处理授权会话 {data.summaries.pendingSessionCount} 条
                </div>
              </div>

              <div className="store-center-action-grid">
                {data.actions.map((action) => (
                  <div key={action.key} className="store-center-action-card">
                    <div className="store-center-card-title">{action.label}</div>
                    <div className="store-center-card-desc">{action.description}</div>
                  </div>
                ))}
              </div>
            </div>

            <div className="store-center-insight-grid">
              <div className="store-center-panel-card">
                <div className="store-center-card-title">分组概览</div>
                <div className="store-tag-list" style={{ marginTop: 12 }}>
                  {data.groups.map((group) => (
                    <Tag key={group.name} color="geekblue">
                      {group.name} {group.count}
                    </Tag>
                  ))}
                </div>
              </div>

              {data.serviceCards.map((card) => (
                <div key={card.key} className="store-center-panel-card">
                  <div className="store-center-card-title">{card.title}</div>
                  <div className="store-center-card-desc">{card.description}</div>
                  <div className="store-center-card-helper">建议动作：{card.actionLabel}</div>
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {data ? (
          <div className="store-showcase-grid">
            {storeShowcaseCards.map((card) => (
              <div key={card.key} className="glass-panel store-showcase-card">
                <div className="store-showcase-eyebrow">{card.eyebrow}</div>
                <Typography.Title level={4} style={{ marginTop: 8, marginBottom: 8 }}>
                  {card.title}
                </Typography.Title>
                <Typography.Text type="secondary">{card.helper}</Typography.Text>
                <div className="store-showcase-list">
                  {card.rows.map((row) => (
                    <div key={`${card.key}-${row.name}`} className="store-showcase-row">
                      <div>
                        <div className="store-showcase-name">{row.name}</div>
                        <div className="store-cell-meta">{row.meta}</div>
                      </div>
                      <Tag color={row.status === '待接入' ? 'default' : 'processing'}>{row.status}</Tag>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : null}

        {data ? (
          <div className="store-showcase-grid">
            {operationBoardCards.map((card) => (
              <div key={card.key} className="glass-panel store-showcase-card">
                <div className="store-showcase-eyebrow">{card.eyebrow}</div>
                <Typography.Title level={4} style={{ marginTop: 8, marginBottom: 8 }}>
                  {card.title}
                </Typography.Title>
                <Typography.Text type="secondary">{card.helper}</Typography.Text>
                <div className="store-showcase-list">
                  {card.rows.map((row) => (
                    <div key={`${card.key}-${row.name}`} className="store-showcase-row">
                      <div>
                        <div className="store-showcase-name">{row.name}</div>
                        <div className="store-cell-meta">{row.meta}</div>
                      </div>
                      <Tag color={row.status.includes('风险') || row.status.includes('离线') ? 'warning' : 'processing'}>
                        {row.status}
                      </Tag>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        ) : null}

        <div className="store-learning-grid">
          {data?.serviceCards ? (
            <div className="glass-panel store-learning-card">
              <Typography.Title level={4}>特色服务</Typography.Title>
              <div className="store-learning-copy">保留目标站的服务区块，用现有真实能力承接入口。</div>
              <div className="store-learning-list">
                {data.serviceCards.map((card) => (
                  <div key={card.key} className="store-learning-item">
                    <div className="store-showcase-name">{card.title}</div>
                    <div className="store-cell-meta">{card.description}</div>
                    <Tag color="geekblue">{card.actionLabel}</Tag>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {learningCenterItems.map((section) => (
            <div key={section.key} className="glass-panel store-learning-card">
              <Typography.Title level={4}>{section.title}</Typography.Title>
              <div className="store-learning-copy">{section.description}</div>
              <div className="store-learning-list">
                {section.items.map((item) => (
                  <div key={item} className="store-learning-item">
                    <div className="store-showcase-name">{item}</div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>

        <div className="glass-panel store-center-table-shell">
          <div className="store-center-table-top">
            <div>
              <Typography.Title level={4} style={{ marginBottom: 8 }}>
                店铺管理列表
              </Typography.Title>
              <Typography.Text type="secondary">
                区分待激活、已激活、掉线、异常四类连接状态，并支持单店和批量管理。
              </Typography.Text>
            </div>
            <div className="store-center-filters">
              <Segmented
                value={platformFilter}
                onChange={(value) => setPlatformFilter(value as PlatformFilter)}
                options={[
                  { label: '全部平台', value: 'all' },
                  { label: '闲鱼', value: 'xianyu' },
                  { label: '淘宝', value: 'taobao' },
                ]}
              />
              <Segmented
                value={statusFilter}
                onChange={(value) => setStatusFilter(value as StatusFilter)}
                options={[
                  { label: '全部状态', value: 'all' },
                  { label: '待激活', value: 'pending_activation' },
                  { label: '已激活', value: 'active' },
                  { label: '掉线', value: 'offline' },
                  { label: '异常', value: 'abnormal' },
                ]}
              />
              <Input.Search
                allowClear
                placeholder="搜索店铺、卖家号、店主账号、分组或标签"
                onSearch={setKeyword}
                onChange={(event) => setKeyword(event.target.value)}
                style={{ width: 320 }}
                value={keyword}
              />
            </div>
          </div>

          <div className="store-center-batch-bar">
            <Typography.Text type="secondary">
              已选 {selectedRowKeys.length} 家店铺
              {selectedStores.length > 0
                ? `：${selectedStores
                    .slice(0, 3)
                    .map((store) => store.shopName)
                    .join('、')}${selectedStores.length > 3 ? ' 等' : ''}`
                : ''}
            </Typography.Text>
            <Space wrap>
              <Button disabled={selectedRowKeys.length === 0} onClick={() => void batchSetEnabled(true)}>
                批量启用
              </Button>
              <Button disabled={selectedRowKeys.length === 0} onClick={() => void batchSetEnabled(false)}>
                批量停用
              </Button>
              <Button
                type="primary"
                disabled={selectedRowKeys.length === 0}
                loading={busyKey === 'batch-health-check'}
                onClick={() => void batchHealthCheck()}
              >
                批量体检
              </Button>
            </Space>
          </div>

          <Table
            rowKey="id"
            loading={loading}
            rowSelection={rowSelection}
            columns={storeColumns}
            dataSource={filteredStores}
            pagination={{ pageSize: 8, showSizeChanger: false }}
            scroll={{ x: 1360 }}
          />
        </div>

        <Row gutter={[16, 16]}>
          <Col xs={24} xl={12}>
            <Card
              title="授权会话记录"
              className="glass-panel store-log-card"
              extra={<Typography.Text type="secondary">支持查看回调、收票与绑店下一步</Typography.Text>}
            >
              <Table
                rowKey="sessionId"
                columns={sessionColumns}
                dataSource={data?.authSessions ?? []}
                loading={loading}
                pagination={{ pageSize: 5, showSizeChanger: false }}
              />
            </Card>
          </Col>
          <Col xs={24} xl={12}>
            <Card
              title="健康检查日志"
              className="glass-panel store-log-card"
              extra={<Typography.Text type="secondary">支持单店执行与批量任务</Typography.Text>}
            >
              <Table
                rowKey="id"
                columns={healthColumns}
                dataSource={data?.healthChecks ?? []}
                loading={loading}
                pagination={{ pageSize: 5, showSizeChanger: false }}
              />
            </Card>
          </Col>
        </Row>
      </div>

      <Drawer
        title={activeCredentialStore ? `${activeCredentialStore.shopName} 的凭据详情` : '凭据详情'}
        placement="right"
        width={760}
        open={Boolean(credentialPanelStoreId)}
        onClose={() => setCredentialPanelStoreId(null)}
        extra={
          activeCredentialStore ? (
            <Space wrap>
              <Button
                size="small"
                loading={busyKey === `verify-${activeCredentialStore.id}`}
                onClick={() => void verifyCredential(activeCredentialStore)}
              >
                校验登录态
              </Button>
              <Button
                size="small"
                loading={busyKey === `renew-${activeCredentialStore.id}`}
                onClick={() => void renewCredential(activeCredentialStore)}
              >
                浏览器续登
              </Button>
            </Space>
          ) : null
        }
      >
        {activeCredentialStore ? (
          <Space direction="vertical" size={16} style={{ width: '100%' }}>
            {activeCredentialStore.credentialVerificationUrl ? (
              <Alert
                type="warning"
                showIcon
                message="当前凭据仍需人工处理风控或验证码"
                description={
                  <span>
                    请在已登录闲鱼的浏览器环境中继续完成验证：
                    <Typography.Link
                      href={activeCredentialStore.credentialVerificationUrl}
                      target="_blank"
                      rel="noreferrer"
                    >
                      打开验证页
                    </Typography.Link>
                  </span>
                }
              />
            ) : null}

            <Descriptions size="small" column={1} bordered>
              <Descriptions.Item label="平台与店铺">
                {platformLabel(activeCredentialStore.platform)} · {activeCredentialStore.shopName}
              </Descriptions.Item>
              <Descriptions.Item label="凭据类型">
                {activeCredentialStore.credentialType ?? '未绑定'} · {activeCredentialStore.credentialSource ?? '未知来源'}
              </Descriptions.Item>
              <Descriptions.Item label="当前风险">
                <Tag color={credentialRiskColor(activeCredentialStore.credentialRiskLevel)}>
                  {credentialRiskText(activeCredentialStore.credentialRiskLevel)}
                </Tag>
              </Descriptions.Item>
              <Descriptions.Item label="最近校验">
                {activeCredentialStore.lastVerifiedAt ?? '未执行'}
              </Descriptions.Item>
              <Descriptions.Item label="最近续登">
                {activeCredentialStore.lastCredentialRenewAt ?? '未执行'}
                {activeCredentialStore.lastCredentialRenewStatus
                  ? ` · ${activeCredentialStore.lastCredentialRenewStatus}`
                  : ''}
              </Descriptions.Item>
              <Descriptions.Item label="校验说明">
                {activeCredentialStore.credentialRiskReason ?? activeCredentialStore.lastHealthCheckDetail ?? '暂无说明'}
              </Descriptions.Item>
            </Descriptions>

            <Card
              size="small"
              title="人工接管建议"
              extra={<Typography.Text type="secondary">已切到专用凭据事件时间线</Typography.Text>}
            >
              <div className="store-cell-stack">
                <div>1. 先执行“校验登录态”，确认当前 Cookie 是否仍可用。</div>
                <div>2. 若命中验证码或风控，打开验证页在原浏览器中继续处理。</div>
                <div>3. 若状态已失效或反复触发风控，再执行“浏览器续登”收取新的 Cookie。</div>
                <div>4. 续登完成后回到本面板，查看最近一条校验记录是否恢复为正常。</div>
              </div>
            </Card>

            <Card size="small" title="校验与续登历史">
              {credentialEventsError ? (
                <Alert
                  style={{ marginBottom: 12 }}
                  type="error"
                  showIcon
                  message={credentialEventsError}
                />
              ) : null}
              <Table
                rowKey="id"
                columns={credentialHistoryColumns}
                dataSource={credentialEvents}
                loading={credentialEventsLoading}
                pagination={{ pageSize: 5, showSizeChanger: false }}
                locale={{ emptyText: '当前店铺还没有凭据事件记录。' }}
              />
            </Card>
          </Space>
        ) : null}
      </Drawer>

      <Modal
        title={editingStore ? `编辑店铺信息：${editingStore.shopName}` : '编辑店铺信息'}
        open={Boolean(editingStore)}
        onCancel={() => setEditingStore(null)}
        onOk={() => void submitMeta()}
        confirmLoading={busyKey === `meta-${editingStore?.id ?? 0}`}
        destroyOnClose
      >
        <Form form={metaForm} layout="vertical">
          <Form.Item
            label="店铺分组"
            name="groupName"
            rules={[{ required: true, message: '请输入店铺分组' }]}
          >
            <Input placeholder="例如：闲鱼主店 / 淘宝搬家 / 图书清仓" />
          </Form.Item>
          <Form.Item label="标签" name="tagsText">
            <Input placeholder="使用顿号、逗号或空格分隔，例如：闲鱼、主推、潮玩" />
          </Form.Item>
          <Form.Item label="备注" name="remark">
            <Input.TextArea rows={4} placeholder="记录授权风险、运营策略或故障处理结论" />
          </Form.Item>
        </Form>
      </Modal>
    </PageContainer>
  );
}
