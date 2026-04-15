import { Alert, Button, Col, Empty, Row, Skeleton, Space, Switch, Tag, Typography, message } from 'antd';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Navigate, useNavigate, useParams } from 'react-router-dom';

import type {
  DashboardResponse,
  FilterQuery,
  FundWithdrawalsDetailResponse,
  WorkspaceBusinessDetailResponse,
  WorkspaceOverviewResponse,
} from '../api';
import { apiRequest, buildQuery } from '../api';
import {
  canApproveWithdrawals,
  canManageSecureSettings,
  canManageUsers,
  canManageWorkspace,
} from '../access';
import { useAuth } from '../auth';
import { FilterBar } from '../components/FilterBar';
import { WorkspaceBusinessSection } from '../components/WorkspaceBusinessSection';
import { useRemoteData } from '../hooks/useRemoteData';
import { navigationGroups, navigationItems } from '../navigation';

function taskStatusLabel(status: WorkspaceOverviewResponse['tasks'][number]['status']) {
  return (
    {
      todo: '待处理',
      in_progress: '进行中',
      done: '已完成',
    }[status] ?? status
  );
}

function taskStatusColor(status: WorkspaceOverviewResponse['tasks'][number]['status']) {
  return (
    {
      todo: 'default',
      in_progress: 'processing',
      done: 'success',
    }[status] ?? 'default'
  );
}

function priorityColor(priority: string) {
  return (
    {
      high: 'error',
      medium: 'warning',
      low: 'default',
    }[priority] ?? 'default'
  );
}

function priorityLabel(priority: string) {
  return (
    {
      high: '高优先级',
      medium: '中优先级',
      low: '低优先级',
    }[priority] ?? priority
  );
}

const securityFeatures = new Set(['system-accounts', 'open-logs', 'system-configs']);

export function FeatureWorkspacePage() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { featureKey } = useParams();
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [filters, setFilters] = useState<FilterQuery>({ preset: 'last30Days' });
  const [messageApi, contextHolder] = message.useMessage();
  const workspaceFeatureKey = featureKey ?? '';

  const item = useMemo(
    () =>
      navigationItems.find(
        (current) => current.kind === 'workspace' && current.workspaceKey === workspaceFeatureKey,
      ),
    [workspaceFeatureKey],
  );
  const group = useMemo(
    () =>
      item
        ? navigationGroups.find((current) => current.items.some((entry) => entry.key === item.key))
        : undefined,
    [item],
  );

  const canManageCurrentWorkspace = canManageWorkspace(user?.role, workspaceFeatureKey);
  const canManageCurrentUsers = canManageUsers(user?.role);
  const canManageCurrentSecureSettings = canManageSecureSettings(user?.role);
  const canApproveCurrentWithdrawals = canApproveWithdrawals(user?.role);
  const isSecurityFeature = securityFeatures.has(workspaceFeatureKey);
  const isFundFeature = workspaceFeatureKey.startsWith('fund-');
  const isAiServiceFeature = workspaceFeatureKey === 'ai-service';

  const loader = useCallback(async () => {
    const queryString = isFundFeature ? buildQuery(filters) : '';
    const detailPath = queryString
      ? `/api/workspaces/${workspaceFeatureKey}/detail?${queryString}`
      : `/api/workspaces/${workspaceFeatureKey}/detail`;
    const requests = [
      apiRequest<WorkspaceOverviewResponse>(
        `/api/workspaces/${workspaceFeatureKey}`,
        undefined,
      ),
      apiRequest<WorkspaceBusinessDetailResponse>(
        detailPath,
        undefined,
      ),
    ] as const;
    const result = await Promise.all([
      ...requests,
      isFundFeature
        ? apiRequest<DashboardResponse['filters']>('/api/options', undefined)
        : Promise.resolve(undefined),
    ]);

    return {
      overview: result[0],
      detail: result[1],
      options: result[2],
    };
  }, [filters, isFundFeature, workspaceFeatureKey]);

  const { data, loading, error, reload } = useRemoteData<{
    overview: WorkspaceOverviewResponse;
    detail: WorkspaceBusinessDetailResponse;
    options?: DashboardResponse['filters'];
  }>(loader);

  useEffect(() => {
    if (!isAiServiceFeature) {
      return;
    }

    const timer = window.setInterval(() => {
      if (document.visibilityState === 'hidden') {
        return;
      }
      void reload({ silent: true });
    }, 15_000);

    return () => {
      window.clearInterval(timer);
    };
  }, [isAiServiceFeature, reload]);

  const relatedItems = useMemo(
    () => (group && item ? group.items.filter((current) => current.key !== item.key).slice(0, 3) : []),
    [group, item],
  );

  const wrapAction = useCallback(
    async (busy: string, successText: string, fn: () => Promise<void>) => {
      setBusyKey(busy);
      try {
        await fn();
        messageApi.success(successText);
        await reload();
      } catch (requestError) {
        messageApi.error(requestError instanceof Error ? requestError.message : '操作失败');
      } finally {
        setBusyKey(null);
      }
    },
    [messageApi, reload],
  );

  if (!workspaceFeatureKey || !item) {
    return <Navigate to="/dashboard" replace />;
  }

  if (!group) {
    return (
      <Empty
        description="功能配置不存在"
        image={Empty.PRESENTED_IMAGE_SIMPLE}
        style={{ marginTop: 80 }}
      />
    );
  }

  return (
    <div className={`module-page ${isAiServiceFeature ? 'module-page-chat' : ''}`}>
      {contextHolder}
      {!isAiServiceFeature ? (
        <>
          <div className="module-hero">
        <div>
          <Space wrap>
            <Tag color="gold">{group.label}</Tag>
            {data?.overview.statusTag ? <Tag color="processing">{data.overview.statusTag}</Tag> : null}
          </Space>
          <Typography.Title level={2} style={{ marginTop: 12, marginBottom: 8 }}>
            {item.label}
          </Typography.Title>
          <Typography.Paragraph style={{ marginBottom: 0 }}>{item.description}</Typography.Paragraph>
          {data?.overview.updatedAt ? (
            <Typography.Text type="secondary">最近更新：{data.overview.updatedAt}</Typography.Text>
          ) : null}
        </div>
        <Space wrap>
          <Button type="primary" onClick={() => navigate('/dashboard')}>
            返回统计
          </Button>
          <Button onClick={() => navigate('/reports')}>查看报表</Button>
        </Space>
      </div>

          <Alert
        type="info"
        showIcon
        message={isSecurityFeature ? '当前模块已切换为安全专用工作台' : '当前模块已接入统一工作台引擎'}
        description={
          isSecurityFeature
            ? '账号管理、审计日志和敏感配置已经接入真实后端权限控制，不再是演示占位页。'
            : '动作执行、规则开关、任务流转和日志沉淀继续由统一引擎承载，模块专有逻辑通过业务区扩展。'
        }
            className="module-alert"
          />
        </>
      ) : null}

      {error ? <Alert type="error" showIcon message={error} /> : null}

      {loading || !data ? (
        <Skeleton active paragraph={{ rows: 14 }} />
      ) : (
        <>
          {isFundFeature && data.options ? (
            <FilterBar
              filters={filters}
              onChange={setFilters}
              stores={data.options.stores}
              storeMode="multiple"
            />
          ) : null}

          {!isAiServiceFeature ? (
            <Row gutter={[16, 16]}>
              {data.overview.summary.map((summary) => (
                <Col xs={24} sm={12} xl={8} key={summary.label}>
                  <div className="module-summary-card">
                    <div className="module-summary-label">{summary.label}</div>
                    <div className="module-summary-value">
                      {summary.value}
                      <span className="module-summary-unit">{summary.unit}</span>
                    </div>
                    <div className="module-summary-meta">{summary.meta}</div>
                  </div>
                </Col>
              ))}
            </Row>
          ) : null}

          <WorkspaceBusinessSection
            detail={data.detail}
            busyKey={busyKey}
            canManageWorkspace={canManageCurrentWorkspace}
            canManageUsers={canManageCurrentUsers}
            canManageSecureSettings={canManageCurrentSecureSettings}
            canApproveWithdrawals={canApproveCurrentWithdrawals}
            storeOptions={data.options?.stores ?? []}
            onToggleDirectChargeSupplier={(supplierId) =>
              wrapAction(`supplier-${supplierId}`, '供应商状态已更新', async () => {
                await apiRequest(
                  `/api/workspaces/${workspaceFeatureKey}/suppliers/${supplierId}/toggle`,
                  { method: 'POST', body: '{}' },
                );
              })
            }
            onRotateDirectChargeSupplierToken={(supplierId) =>
              wrapAction(`supplier-token-${supplierId}`, '回调令牌已轮换', async () => {
                await apiRequest(
                  `/api/workspaces/${workspaceFeatureKey}/suppliers/${supplierId}/token/rotate`,
                  { method: 'POST', body: '{}' },
                );
              })
            }
            onDispatchDirectChargeJob={(jobId) =>
              wrapAction(`direct-dispatch-${jobId}`, '直充任务已下发', async () => {
                await apiRequest(
                  `/api/workspaces/${workspaceFeatureKey}/direct-charge-jobs/${jobId}/dispatch`,
                  { method: 'POST', body: '{}' },
                );
              })
            }
            onRetryDirectChargeJob={(jobId) =>
              wrapAction(`direct-retry-${jobId}`, '直充任务已重试', async () => {
                await apiRequest(
                  `/api/workspaces/${workspaceFeatureKey}/direct-charge-jobs/${jobId}/retry`,
                  { method: 'POST', body: '{}' },
                );
              })
            }
            onMarkDirectChargeJobManualReview={(jobId) =>
              wrapAction(`direct-manual-${jobId}`, '直充任务已转人工', async () => {
                await apiRequest(
                  `/api/workspaces/${workspaceFeatureKey}/direct-charge-jobs/${jobId}/manual-review`,
                  { method: 'POST', body: JSON.stringify({ reason: '工作台人工接管' }) },
                );
              })
            }
            onToggleSupplySourceSystem={(systemId) =>
              wrapAction(`source-system-${systemId}`, '货源系统状态已更新', async () => {
                await apiRequest(
                  `/api/workspaces/${workspaceFeatureKey}/source-systems/${systemId}/toggle`,
                  { method: 'POST', body: '{}' },
                );
              })
            }
            onRotateSupplySourceSystemToken={(systemId) =>
              wrapAction(`source-system-token-${systemId}`, '货源系统回调令牌已轮换', async () => {
                await apiRequest(
                  `/api/workspaces/${workspaceFeatureKey}/source-systems/${systemId}/token/rotate`,
                  { method: 'POST', body: '{}' },
                );
              })
            }
            onRunSupplySourceSync={(systemId, syncType) =>
              wrapAction(`source-sync-${systemId}-${syncType}`, '货源同步已执行', async () => {
                await apiRequest(
                  `/api/workspaces/${workspaceFeatureKey}/source-systems/${systemId}/sync`,
                  { method: 'POST', body: JSON.stringify({ syncType }) },
                );
              })
            }
            onRetrySupplySourceSyncRun={(runId) =>
              wrapAction(`source-sync-retry-${runId}`, '货源同步已重试', async () => {
                await apiRequest(
                  `/api/workspaces/${workspaceFeatureKey}/source-sync-runs/${runId}/retry`,
                  { method: 'POST', body: '{}' },
                );
              })
            }
            onDispatchSupplySourceOrder={(sourceOrderId) =>
              wrapAction(`source-order-dispatch-${sourceOrderId}`, '货源订单已推单', async () => {
                await apiRequest(
                  `/api/workspaces/${workspaceFeatureKey}/source-orders/${sourceOrderId}/dispatch`,
                  { method: 'POST', body: '{}' },
                );
              })
            }
            onRetrySupplySourceOrder={(sourceOrderId) =>
              wrapAction(`source-order-retry-${sourceOrderId}`, '货源订单已重试', async () => {
                await apiRequest(
                  `/api/workspaces/${workspaceFeatureKey}/source-orders/${sourceOrderId}/retry`,
                  { method: 'POST', body: '{}' },
                );
              })
            }
            onMarkSupplySourceOrderManualReview={(sourceOrderId) =>
              wrapAction(`source-order-manual-${sourceOrderId}`, '货源订单已转人工', async () => {
                await apiRequest(
                  `/api/workspaces/${workspaceFeatureKey}/source-orders/${sourceOrderId}/manual-review`,
                  { method: 'POST', body: JSON.stringify({ reason: '工作台人工接管货源异常订单' }) },
                );
              })
            }
            onToggleDeliveryItem={(id) =>
              wrapAction(`delivery-${id}`, '发货设置已更新', async () => {
                await apiRequest(
                  `/api/workspaces/${workspaceFeatureKey}/delivery-items/${id}/toggle`,
                  { method: 'POST', body: '{}' },
                );
              })
            }
            onImportCardBatch={(cardTypeId) =>
              wrapAction(`import-${cardTypeId}`, '卡密已导入', async () => {
                await apiRequest(
                  `/api/workspaces/${workspaceFeatureKey}/card-types/${cardTypeId}/import`,
                  { method: 'POST', body: '{}' },
                );
              })
            }
            onToggleCardInventorySample={(cardTypeId) =>
              wrapAction(`inventory-${cardTypeId}`, '样卡状态已更新', async () => {
                await apiRequest(
                  `/api/workspaces/${workspaceFeatureKey}/card-types/${cardTypeId}/inventory-sample/toggle`,
                  { method: 'POST', body: '{}' },
                );
              })
            }
            onRunCardDeliveryJob={(jobId) =>
              wrapAction(`job-${jobId}`, '发货任务已执行', async () => {
                await apiRequest(
                  `/api/workspaces/${workspaceFeatureKey}/jobs/${jobId}/run`,
                  { method: 'POST', body: '{}' },
                );
              })
            }
            onToggleComboStatus={(id) =>
              wrapAction(`combo-${id}`, '组合状态已更新', async () => {
                await apiRequest(
                  `/api/workspaces/${workspaceFeatureKey}/combos/${id}/toggle`,
                  { method: 'POST', body: '{}' },
                );
              })
            }
            onToggleTemplateRandom={(id) =>
              wrapAction(`template-${id}`, '模板随机状态已更新', async () => {
                await apiRequest(
                  `/api/workspaces/${workspaceFeatureKey}/templates/${id}/random-toggle`,
                  { method: 'POST', body: '{}' },
                );
              })
            }
            onResendCardOutbound={(outboundRecordId) =>
              wrapAction(`resend-${outboundRecordId}`, '卡密已补发', async () => {
                await apiRequest(
                  `/api/workspaces/${workspaceFeatureKey}/outbound-records/${outboundRecordId}/resend`,
                  { method: 'POST', body: '{}' },
                );
              })
            }
            onRecycleCardOutbound={(outboundRecordId, action) =>
              wrapAction(`${action}-${outboundRecordId}`, action === 'recycle' ? '卡密已回收返库' : '卡密已撤回禁用', async () => {
                await apiRequest(
                  `/api/workspaces/${workspaceFeatureKey}/outbound-records/${outboundRecordId}/recycle`,
                  { method: 'POST', body: JSON.stringify({ action }) },
                );
              })
            }
            onRestoreCardType={(id) =>
              wrapAction(`restore-${id}`, '卡种已恢复', async () => {
                await apiRequest(
                  `/api/workspaces/${workspaceFeatureKey}/card-types/${id}/restore`,
                  { method: 'POST', body: '{}' },
                );
              })
            }
            onUpdateWithdrawalStatus={(id, status: FundWithdrawalsDetailResponse['rows'][number]['status']) =>
              wrapAction(`withdrawal-${id}-${status}`, '提现状态已更新', async () => {
                await apiRequest(
                  `/api/workspaces/${workspaceFeatureKey}/withdrawals/${id}/status`,
                  { method: 'POST', body: JSON.stringify({ status }) },
                );
              })
            }
            onCreateWithdrawal={(input) =>
              wrapAction('create-withdrawal', '鎻愮幇鐢宠宸叉彁浜?', async () => {
                await apiRequest(
                  `/api/workspaces/${workspaceFeatureKey}/withdrawals`,
                  { method: 'POST', body: JSON.stringify(input) },
                );
              })
            }
            onUpdateReconciliationStatus={(id, status) =>
              wrapAction(`reconcile-${id}-${status}`, '瀵硅处鐘舵€佸凡鏇存柊', async () => {
                await apiRequest(
                  `/api/workspaces/${workspaceFeatureKey}/reconciliations/${id}/status`,
                  { method: 'POST', body: JSON.stringify({ status }) },
                );
              })
            }
            onGenerateAiServiceReply={(conversationId) =>
              wrapAction(`ai-reply-${conversationId}`, 'AI 处理结果已生成', async () => {
                await apiRequest(
                  `/api/workspaces/${workspaceFeatureKey}/conversations/${conversationId}/ai-reply`,
                  { method: 'POST', body: '{}' },
                );
              })
            }
            onUpdateAiServiceTakeover={(conversationId, action) =>
              wrapAction(
                `ai-takeover-${conversationId}`,
                action === 'takeover' ? '会话已转人工' : '会话已释放接管',
                async () => {
                  await apiRequest(
                    `/api/workspaces/${workspaceFeatureKey}/conversations/${conversationId}/takeover`,
                    { method: 'POST', body: JSON.stringify({ action }) },
                  );
                },
              )
            }
            onSendAiServiceManualReply={(conversationId, content, closeConversation) =>
              wrapAction(
                closeConversation ? `ai-manual-close-${conversationId}` : `ai-manual-${conversationId}`,
                closeConversation ? '人工回复已发送并结单' : '人工回复已发送',
                async () => {
                  await apiRequest(
                    `/api/workspaces/${workspaceFeatureKey}/conversations/${conversationId}/manual-reply`,
                    {
                      method: 'POST',
                      body: JSON.stringify({ content, closeConversation }),
                    },
                  );
                },
              )
            }
            onUpdateAiServiceSettings={(input) =>
              wrapAction('ai-settings', 'AI 客服策略已更新', async () => {
                await apiRequest(
                  `/api/workspaces/${workspaceFeatureKey}/settings`,
                  { method: 'POST', body: JSON.stringify(input) },
                );
              })
            }
            onToggleAiKnowledgeItem={(knowledgeItemId, enabled) =>
              wrapAction(
                `ai-knowledge-${knowledgeItemId}`,
                enabled ? '知识库条目已启用' : '知识库条目已停用',
                async () => {
                  await apiRequest(
                    `/api/workspaces/${workspaceFeatureKey}/knowledge-items/${knowledgeItemId}/enabled`,
                    { method: 'POST', body: JSON.stringify({ enabled }) },
                  );
                },
              )
            }
            onToggleAiReplyTemplate={(templateId, enabled) =>
              wrapAction(
                `ai-template-${templateId}`,
                enabled ? '话术模板已启用' : '话术模板已停用',
                async () => {
                  await apiRequest(
                    `/api/workspaces/${workspaceFeatureKey}/reply-templates/${templateId}/enabled`,
                    { method: 'POST', body: JSON.stringify({ enabled }) },
                  );
                },
              )
            }
            onSyncAiServiceConversations={() =>
              wrapAction('ai-service-sync', '真实客服会话已同步', async () => {
                await apiRequest(
                  `/api/workspaces/${workspaceFeatureKey}/service-sync`,
                  {
                    method: 'POST',
                    body: JSON.stringify({
                      maxSessionsPerStore: 50,
                      maxMessagesPerSession: 50,
                    }),
                  },
                );
              })
            }
            onSyncAiBargainSessions={() =>
              wrapAction('ai-bargain-sync', '真实议价会话已同步', async () => {
                await apiRequest(
                  `/api/workspaces/${workspaceFeatureKey}/bargain-sync`,
                  { method: 'POST', body: '{}' },
                );
              })
            }
            onEvaluateAiBargainSession={(sessionId) =>
              wrapAction(`ai-bargain-evaluate-${sessionId}`, 'AI 议价结果已生成', async () => {
                await apiRequest(
                  `/api/workspaces/${workspaceFeatureKey}/bargain-sessions/${sessionId}/evaluate`,
                  { method: 'POST', body: '{}' },
                );
              })
            }
            onUpdateAiBargainTakeover={(sessionId, action, note) =>
              wrapAction(
                `ai-bargain-takeover-${sessionId}`,
                action === 'takeover' ? '议价会话已转人工' : '议价会话已释放接管',
                async () => {
                  await apiRequest(
                    `/api/workspaces/${workspaceFeatureKey}/bargain-sessions/${sessionId}/takeover`,
                    { method: 'POST', body: JSON.stringify({ action, note }) },
                  );
                },
              )
            }
            onSendAiBargainManualDecision={(sessionId, input) =>
              wrapAction(
                `ai-bargain-manual-${sessionId}`,
                input.action === 'accept'
                  ? '人工成交已记录'
                  : input.action === 'reject'
                    ? '人工拒绝已记录'
                    : '人工报价已记录',
                async () => {
                  await apiRequest(
                    `/api/workspaces/${workspaceFeatureKey}/bargain-sessions/${sessionId}/manual-decision`,
                    { method: 'POST', body: JSON.stringify(input) },
                  );
                },
              )
            }
            onUpdateAiBargainSettings={(input) =>
              wrapAction('ai-bargain-settings', 'AI 议价策略已更新', async () => {
                await apiRequest(
                  `/api/workspaces/${workspaceFeatureKey}/bargain-settings`,
                  { method: 'POST', body: JSON.stringify(input) },
                );
              })
            }
            onUpdateAiBargainStrategy={(strategyId, input) =>
              wrapAction(`ai-bargain-strategy-${strategyId}`, '议价策略已更新', async () => {
                await apiRequest(
                  `/api/workspaces/${workspaceFeatureKey}/bargain-strategies/${strategyId}`,
                  { method: 'POST', body: JSON.stringify(input) },
                );
              })
            }
            onToggleAiBargainTemplate={(templateId, enabled) =>
              wrapAction(
                `ai-bargain-template-${templateId}`,
                enabled ? '议价模板已启用' : '议价模板已停用',
                async () => {
                  await apiRequest(
                    `/api/workspaces/${workspaceFeatureKey}/bargain-templates/${templateId}/enabled`,
                    { method: 'POST', body: JSON.stringify({ enabled }) },
                  );
                },
              )
            }
            onToggleAiBargainBlacklist={(blacklistId, enabled) =>
              wrapAction(
                `ai-bargain-blacklist-${blacklistId}`,
                enabled ? '议价黑名单已启用' : '议价黑名单已停用',
                async () => {
                  await apiRequest(
                    `/api/workspaces/${workspaceFeatureKey}/bargain-blacklist/${blacklistId}/enabled`,
                    { method: 'POST', body: JSON.stringify({ enabled }) },
                  );
                },
              )
            }
            onCreateSystemUser={(input) =>
              wrapAction('create-user', '账号已创建', async () => {
                await apiRequest(
                  '/api/system/users',
                  { method: 'POST', body: JSON.stringify(input) },
                );
              })
            }
            onUpdateSystemUserRole={(userId, role) =>
              wrapAction(`user-role-${userId}`, '账号角色已更新', async () => {
                await apiRequest(
                  `/api/system/users/${userId}/role`,
                  { method: 'POST', body: JSON.stringify({ role }) },
                );
              })
            }
            onUpdateSystemUserStatus={(userId, status) =>
              wrapAction(`user-status-${userId}`, '账号状态已更新', async () => {
                await apiRequest(
                  `/api/system/users/${userId}/status`,
                  { method: 'POST', body: JSON.stringify({ status }) },
                );
              })
            }
            onUpdateSecureSetting={(key, description, value) =>
              wrapAction(
                key ? `secure-setting-${key}` : 'create-secure-setting',
                '敏感配置已加密保存',
                async () => {
                  await apiRequest(
                    `/api/system/secure-settings/${key}`,
                    { method: 'POST', body: JSON.stringify({ description, value }) },
                  );
                },
              )
            }
            onUpdateSystemAlertStatus={(alertId, status) =>
              wrapAction(`system-alert-${alertId}-${status}`, '系统告警状态已更新', async () => {
                await apiRequest(
                  `/api/workspaces/${workspaceFeatureKey}/alerts/${alertId}/status`,
                  { method: 'POST', body: JSON.stringify({ status }) },
                );
              })
            }
            onRunSystemBackup={() =>
              wrapAction('system-backup', '数据库备份已执行', async () => {
                await apiRequest(
                  `/api/workspaces/${workspaceFeatureKey}/backups/run`,
                  { method: 'POST', body: '{}' },
                );
              })
            }
            onRunSystemLogArchive={() =>
              wrapAction('system-log-archive', '日志归档已生成', async () => {
                await apiRequest(
                  `/api/workspaces/${workspaceFeatureKey}/log-archives/run`,
                  { method: 'POST', body: '{}' },
                );
              })
            }
            onRunSystemRecoveryDrill={() =>
              wrapAction('system-recovery-drill', '恢复演练已完成', async () => {
                await apiRequest(
                  `/api/workspaces/${workspaceFeatureKey}/recovery-drills/run`,
                  { method: 'POST', body: '{}' },
                );
              })
            }
          />

          {!isSecurityFeature ? (
            <>
              <Row gutter={[16, 16]} className="module-content-grid">
                <Col xs={24} xl={10}>
                  <div className="module-panel">
                    <Typography.Title level={4}>核心动作</Typography.Title>
                    <div className="module-action-list">
                      {data.overview.actions.map((action) => (
                        <div key={action.id} className="module-action-card module-action-card-static">
                          <div className="module-action-main">
                            <div className="module-action-title">{action.title}</div>
                            <div className="module-action-desc">{action.description}</div>
                            <div className="module-action-meta">
                              <Tag color="blue">{action.status}</Tag>
                              <span>累计执行 {action.runCount} 次</span>
                              <span>最近执行：{action.lastRunAt ?? '未执行'}</span>
                            </div>
                          </div>
                          {canManageCurrentWorkspace ? (
                            <Button
                              type="primary"
                              loading={busyKey === `action-${action.id}`}
                              onClick={() =>
                                void wrapAction(`action-${action.id}`, '动作已执行', async () => {
                                  await apiRequest(
                                    `/api/workspaces/${workspaceFeatureKey}/actions/${action.id}/run`,
                                    { method: 'POST', body: '{}' },
                                  );
                                })
                              }
                            >
                              执行
                            </Button>
                          ) : (
                            <Tag>只读</Tag>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                </Col>
                <Col xs={24} xl={8}>
                  <div className="module-panel">
                    <Typography.Title level={4}>规则配置</Typography.Title>
                    <div className="module-rule-list">
                      {data.overview.rules.map((rule) => (
                        <div key={rule.id} className="module-rule-card">
                          <div>
                            <div className="module-rule-title">{rule.name}</div>
                            <div className="module-rule-desc">{rule.description}</div>
                            <div className="module-rule-meta">
                              <span>适用范围：{rule.scope}</span>
                              <span>更新时间：{rule.updatedAt}</span>
                            </div>
                          </div>
                          <Switch
                            checked={rule.enabled}
                            disabled={!canManageCurrentWorkspace}
                            loading={busyKey === `rule-${rule.id}`}
                            onChange={() =>
                              void wrapAction(`rule-${rule.id}`, '规则状态已更新', async () => {
                                await apiRequest(
                                  `/api/workspaces/${workspaceFeatureKey}/rules/${rule.id}/toggle`,
                                  { method: 'POST', body: '{}' },
                                );
                              })
                            }
                          />
                        </div>
                      ))}
                    </div>
                  </div>
                </Col>
                <Col xs={24} xl={6}>
                  <div className="module-panel">
                    <Typography.Title level={4}>模块洞察</Typography.Title>
                    <div className="module-insight-list">
                      {data.overview.insights.map((insight) => (
                        <div key={insight.title} className="module-insight-card">
                          <div className="module-insight-title">{insight.title}</div>
                          <div className="module-insight-content">{insight.content}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                </Col>
              </Row>

              <Row gutter={[16, 16]} className="module-content-grid">
                <Col xs={24} xl={14}>
                  <div className="module-panel">
                    <Typography.Title level={4}>任务清单</Typography.Title>
                    <div className="module-task-list">
                      {data.overview.tasks.map((task) => (
                        <div key={task.id} className="module-task-card">
                          <div className="module-task-head">
                            <div>
                              <div className="module-task-title">{task.title}</div>
                              <div className="module-task-desc">{task.description}</div>
                            </div>
                            <Space wrap>
                              <Tag color={priorityColor(task.priority)}>{priorityLabel(task.priority)}</Tag>
                              <Tag color={taskStatusColor(task.status)}>{taskStatusLabel(task.status)}</Tag>
                            </Space>
                          </div>
                          <div className="module-task-meta">
                            <span>负责人：{task.owner}</span>
                            <span>截止时间：{task.dueAt}</span>
                          </div>
                          {canManageCurrentWorkspace ? (
                            <Space wrap>
                              <Button
                                size="small"
                                disabled={task.status === 'todo'}
                                loading={busyKey === `task-${task.id}-todo`}
                                onClick={() =>
                                  void wrapAction(`task-${task.id}-todo`, '任务状态已更新', async () => {
                                    await apiRequest(
                                      `/api/workspaces/${workspaceFeatureKey}/tasks/${task.id}/status`,
                                      { method: 'POST', body: JSON.stringify({ status: 'todo' }) },
                                    );
                                  })
                                }
                              >
                                标记待处理
                              </Button>
                              <Button
                                size="small"
                                disabled={task.status === 'in_progress'}
                                loading={busyKey === `task-${task.id}-in_progress`}
                                onClick={() =>
                                  void wrapAction(
                                    `task-${task.id}-in_progress`,
                                    '任务状态已更新',
                                    async () => {
                                      await apiRequest(
                                        `/api/workspaces/${workspaceFeatureKey}/tasks/${task.id}/status`,
                                        {
                                          method: 'POST',
                                          body: JSON.stringify({ status: 'in_progress' }),
                                        },
                                      );
                                    },
                                  )
                                }
                              >
                                标记进行中
                              </Button>
                              <Button
                                size="small"
                                type="primary"
                                disabled={task.status === 'done'}
                                loading={busyKey === `task-${task.id}-done`}
                                onClick={() =>
                                  void wrapAction(`task-${task.id}-done`, '任务状态已更新', async () => {
                                    await apiRequest(
                                      `/api/workspaces/${workspaceFeatureKey}/tasks/${task.id}/status`,
                                      { method: 'POST', body: JSON.stringify({ status: 'done' }) },
                                    );
                                  })
                                }
                              >
                                标记完成
                              </Button>
                            </Space>
                          ) : (
                            <Tag>只读</Tag>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                </Col>
                <Col xs={24} xl={10}>
                  <div className="module-panel">
                    <Typography.Title level={4}>最新日志</Typography.Title>
                    <div className="module-log-list">
                      {data.overview.logs.map((log) => (
                        <div key={log.id} className="module-log-card">
                          <div className="module-log-top">
                            <Tag>{log.type}</Tag>
                            <span>{log.createdAt}</span>
                          </div>
                          <div className="module-log-title">{log.title}</div>
                          <div className="module-log-detail">{log.detail}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                </Col>
              </Row>
            </>
          ) : null}

          <div className="module-panel">
            <Typography.Title level={4}>相关模块</Typography.Title>
            <div className="module-related-list">
              {relatedItems.map((related) => (
                <button
                  key={related.key}
                  type="button"
                  className="module-related-card"
                  onClick={() => navigate(related.path)}
                >
                  <div className="module-related-title">{related.label}</div>
                  <div className="module-related-desc">{related.description}</div>
                </button>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
